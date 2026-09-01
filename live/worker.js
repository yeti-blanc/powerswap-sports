/**
 * PowerSwap Sports - Live Scores Worker
 * ======================================
 *
 * Additive, display-only layer. Does NOT touch rankings: a game reaching
 * "finished" in BBS's feed never triggers a rank swap on its own - that
 * only ever happens through the existing, separate CFBD weekly pipeline
 * (core/swap_engine.py / scripts/backtest.py), which this Worker never
 * calls or imports.
 *
 * Shape (same pattern as the PFPI project): one Worker polls the upstream
 * API on a cron trigger, filters to games involving currently-ranked
 * teams, and writes one consolidated JSON payload to KV. The static site
 * (GitHub Pages) reads that payload from this Worker's /live endpoint -
 * visitor traffic never touches BBS's rate limit, only this Worker's own
 * polling does ("Bird Feeder" principle, same as the rest of this repo).
 *
 * Cron schedule lives in wrangler.toml's [triggers] block (see that file
 * for why - it's set there deliberately, not in the dashboard).
 *
 * Secrets (wrangler secret put, never committed):
 *   BBS_API_KEY  - required
 *   CFBD_API_KEY - optional, only used for the finality cross-check below
 *
 * KV binding: LIVE_KV (see wrangler.toml). Single key: "live_payload".
 */

import { norm, resolveBbsTeamName } from "./team_norm.js";
import { fetchBbsMatches, parseBbsMatch } from "./bbs_client.js";

const RANKED_TEAMS_URL =
  "https://raw.githubusercontent.com/yeti-blanc/powerswap-sports/main/data/cfb/seasons/2026/season_history.json";

const LIVE_KV_KEY = "live_payload";
// Must comfortably exceed the outer cron interval (5 min) or the key
// expires between ticks and /live falls back to its empty default even
// though polling is working fine - confirmed happening in production
// with the previous 180s value (shorter than the 300s cron gap) during
// overnight testing on 2026-09-01.
const KV_TTL_SECONDS = 600;

// How long a game window is considered "active" around a ranked team's
// kickoff: from 15 min before kickoff to 4 hours after (typical CFB game
// length, generously padded - real duration is unverified per-game).
const PRE_KICKOFF_WINDOW_MS = 15 * 60 * 1000;
const POST_KICKOFF_WINDOW_MS = 4 * 60 * 60 * 1000;

// Sub-minute polling approximation: Cloudflare Cron Triggers can't fire
// more often than once a minute, so the cron below fires every 5 minutes
// and this Worker internally re-polls every SUBPOLL_INTERVAL_MS while a
// game window is active, for up to SUBPOLL_BUDGET_MS of wall-clock time
// (kept under the 5-minute cron period so ticks never overlap).
//
// Deliberately more conservative than the originally-requested "~15s":
// every real /v1/matches response observed so far (across NCAAF, NCAAF-FCS,
// MLB, and EPL) carries meta.note = "... no live adapter covers this
// sport/league; refreshed by ingest", suggesting the free tier serves
// this from a periodically-refreshed stored table rather than a true
// live feed - sub-minute polling may not buy any real freshness. Once a
// real in-progress game is observed (first chance ~2026-09-03), check
// how often the score/status actually changes between polls and tighten
// or loosen this accordingly.
const SUBPOLL_INTERVAL_MS = 20 * 1000;
const SUBPOLL_BUDGET_MS = 4 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };

    if (url.pathname === "/live") {
      const cached = await env.LIVE_KV.get(LIVE_KV_KEY);
      return new Response(cached || JSON.stringify({ updated_at: null, games: [] }), {
        headers: corsHeaders,
      });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPollLoop(env));
  },
};

async function runPollLoop(env) {
  const deadline = Date.now() + SUBPOLL_BUDGET_MS;
  let firstPass = true;

  while (firstPass || Date.now() < deadline) {
    firstPass = false;
    const activeWindow = await pollAndCache(env);
    if (!activeWindow) break; // nothing worth re-polling this tick
    await sleep(SUBPOLL_INTERVAL_MS);
  }
}

async function pollAndCache(env) {
  const rankedTeams = await getCurrentRankedTeams(env);
  if (rankedTeams.length === 0) {
    await env.LIVE_KV.put(
      LIVE_KV_KEY,
      JSON.stringify({ updated_at: new Date().toISOString(), games: [], note: "no ranked teams yet" }),
      { expirationTtl: KV_TTL_SECONDS }
    );
    return false;
  }

  let rawMatches;
  try {
    rawMatches = await fetchBbsMatches(env.BBS_API_KEY);
  } catch (err) {
    console.error("BBS fetch failed:", err.message);
    return false;
  }

  const now = Date.now();
  const relevantGames = [];
  let anyActiveWindow = false;

  for (const raw of rawMatches) {
    const homeCanonical = resolveBbsTeamName(raw.home?.name, rankedTeams);
    const awayCanonical = resolveBbsTeamName(raw.away?.name, rankedTeams);
    if (!homeCanonical && !awayCanonical) continue;

    const parsed = parseBbsMatch(raw);
    const kickoffMs = parsed.kickoff_utc ? Date.parse(parsed.kickoff_utc) : null;
    const inWindow =
      kickoffMs !== null &&
      now >= kickoffMs - PRE_KICKOFF_WINDOW_MS &&
      now <= kickoffMs + POST_KICKOFF_WINDOW_MS;

    if (inWindow && parsed.status !== "finished") anyActiveWindow = true;

    relevantGames.push({
      id: parsed.id,
      home_team: homeCanonical ?? norm(raw.home?.name ?? ""),
      away_team: awayCanonical ?? norm(raw.away?.name ?? ""),
      home_score: parsed.home_score,
      away_score: parsed.away_score,
      status: parsed.status,
      raw_status: parsed.raw_status,
      period: parsed.period,
      clock: parsed.clock,
      possession: parsed.possession,
      kickoff_utc: parsed.kickoff_utc,
    });
  }

  await env.LIVE_KV.put(
    LIVE_KV_KEY,
    JSON.stringify({ updated_at: new Date().toISOString(), games: relevantGames }),
    { expirationTtl: KV_TTL_SECONDS }
  );

  return anyActiveWindow;
}

async function getCurrentRankedTeams(env) {
  let resp;
  try {
    resp = await fetch(RANKED_TEAMS_URL, { cf: { cacheTtl: 60 } });
  } catch (err) {
    console.error("Ranked-teams fetch failed:", err.message);
    return [];
  }
  if (!resp.ok) {
    // Expected for now: data/cfb/seasons/2026/season_history.json doesn't
    // exist yet (2026 backtest pipeline hasn't produced its first
    // snapshot). Not an error - just means nothing is ranked yet.
    return [];
  }
  const data = await resp.json();
  const snapshots = data.snapshots ?? [];
  if (snapshots.length === 0) return [];
  const latest = snapshots[snapshots.length - 1];
  return (latest.rankings ?? []).map((slot) => slot.team);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
