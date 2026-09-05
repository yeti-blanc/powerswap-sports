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
 *   BBS_API_KEY         - required (primary, 2,000/day, GitHub-linked)
 *   BBS_API_KEY_BACKUP  - unused by this (permanent) version; kept as a
 *                         Worker secret only in case a future same-day
 *                         stopgap needs it again
 *   CFBD_API_KEY        - optional, unused by this file
 *
 * KV binding: LIVE_KV (see wrangler.toml). Single key: "live_payload".
 *
 * ARCHITECTURE (rewritten 2026-09-05, see admin/BUILD_LOG.md for the full
 * history): every cron tick does exactly ONE poll - fetch the
 * ranked-teams list, fetch BBS's full day's slate (2 requests - see
 * bbs_client.js), filter to ranked teams, write to KV. No in-Worker loop,
 * no "poll faster during a live game" logic, no per-game kickoff-time
 * awareness.
 *
 * Why: BBS's /v1/stored/matches is a flat "whole day's slate" call - one
 * request returns every game for that date/league regardless of how many
 * ranked teams are playing (confirmed: a single call returned 34 games at
 * once on 2026-09-05). So request volume is a pure function of HOW OFTEN
 * we poll, never of how many games are live. An earlier same-day design
 * instead tried to poll faster (every 20s, via an in-Worker sleep loop)
 * whenever ANY ranked team's game was judged "in progress" - which (a)
 * required knowing real kickoff times to judge that correctly (BBS's own
 * kickoff_utc turned out to sometimes be a placeholder), and (b) even
 * once fixed, made total daily volume depend on how many hours of the
 * day had an overlapping ranked-team game - unpredictable, and large on
 * a real Saturday.
 *
 * The fix is architectural, not a tighter safeguard: a fixed poll
 * interval low enough that requests/day is comfortably under the daily
 * cap, for ANY possible number of concurrent games (0 or 30, doesn't
 * matter - it's still exactly 2 requests per tick):
 *   - every 2 minutes = 720 pulls/day x 2 = 1,440 requests/day, under the
 *     primary key's 2,000/day cap with real headroom (560/day, 28%).
 * That makes the daily total exact and provable, not a runtime guess
 * needing a usage-counter safety net.
 */

import { norm, resolveBbsTeamName } from "./team_norm.js";
import { fetchBbsMatches, parseBbsMatch } from "./bbs_client.js";

const RANKED_TEAMS_URL =
  "https://raw.githubusercontent.com/yeti-blanc/powerswap-sports/main/data/cfb/seasons/2026/season_history.json";

const LIVE_KV_KEY = "live_payload";
// Must comfortably exceed the cron interval or the key expires between
// ticks and /live falls back to its empty default even though polling is
// working fine - confirmed happening in production with a too-short TTL
// during overnight testing on 2026-09-01.
const KV_TTL_SECONDS = 600;

// Permanent key: primary BBS_API_KEY account (2,000/day, GitHub-linked).
const ACTIVE_BBS_KEY_ENV_VAR = "BBS_API_KEY";

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
    ctx.waitUntil(pollAndCache(env));
  },
};

async function pollAndCache(env) {
  const rankedTeams = await getCurrentRankedTeams(env);
  if (rankedTeams.length === 0) {
    await env.LIVE_KV.put(
      LIVE_KV_KEY,
      JSON.stringify({ updated_at: new Date().toISOString(), games: [], note: "no ranked teams yet" }),
      { expirationTtl: KV_TTL_SECONDS }
    );
    return;
  }

  let rawMatches;
  try {
    rawMatches = await fetchBbsMatches(env[ACTIVE_BBS_KEY_ENV_VAR]);
  } catch (err) {
    // No special 429 handling: a fixed poll interval is already sized to
    // stay well under the daily cap regardless of game count, so a
    // transient failure (429 or otherwise) just means this tick's poll
    // didn't refresh - /live keeps serving its last-known payload from
    // KV (see the fetch handler above) and the next tick, a couple of
    // minutes later, tries again. No pause state to track or get wrong.
    console.error("BBS fetch failed:", err.message);
    return;
  }

  const relevantGames = [];
  for (const raw of rawMatches) {
    const homeCanonical = resolveBbsTeamName(raw.home?.name, rankedTeams);
    const awayCanonical = resolveBbsTeamName(raw.away?.name, rankedTeams);
    if (!homeCanonical && !awayCanonical) continue;

    const parsed = parseBbsMatch(raw);
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
