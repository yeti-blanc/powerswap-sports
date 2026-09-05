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

// CFBD-sourced real kickoff times (already fetched/verified by
// sports/cfb/fetch_week1_matchups.py, already used on the public site's
// rank cards - see site/app.js). Used ONLY to decide whether a game is in
// its subpoll window; BBS's own kickoff_utc on /v1/stored/matches is NOT
// used for that decision (see SUBPOLL_* comment below for why).
const WEEK1_MATCHUPS_URL =
  "https://raw.githubusercontent.com/yeti-blanc/powerswap-sports/main/data/cfb/seasons/2026/week1_matchups.json";

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
// IMPORTANT as of the 2026-09-04 bbs_client.js fix: before that fix,
// fetchBbsMatches() called /v1/matches, whose response never carried a
// kickoff_utc field - so `kickoffMs` below was always null, `inWindow`
// was always false, and this subpoll loop never actually fired in
// production (it always broke after one pollAndCache() call per cron
// tick, regardless of these constants). Now that fetchBbsMatches() calls
// /v1/stored/matches and kickoff_utc is real, this loop will genuinely
// activate during a ranked team's game window for the first time. Two
// consequences worth watching, not yet observed in production:
//   - Each pollAndCache() call now costs 2 BBS requests (today + yesterday
//     UTC dates), not 1, since /v1/stored/matches needs an explicit date.
//   - A full Saturday with back-to-back ranked-team games could plausibly
//     approach the 2,000/day account cap once subpolling is genuinely
//     active for several hours - rough math: ~6hrs of active window *
//     12 subpolls/tick * 2 requests, plus baseline ticks, lands close to
//     the cap. Not yet load-tested against a real game day - watch
//     /v1/usage-equivalent (BBS doesn't expose one; watch for 429s in
//     Worker logs) on the first real Saturday after this fix.
// Deliberately still conservative vs. the originally-requested "~15s":
// /v1/stored/matches is explicitly documented as DB-backed ("read
// directly from Postgres"), so the real refresh cadence behind it is
// still unverified - sub-minute polling may not buy any real freshness
// even now. Check how often score/status actually changes between polls
// once a real in-progress game is observed and tighten or loosen this
// accordingly.
const SUBPOLL_INTERVAL_MS = 20 * 1000;
const SUBPOLL_BUDGET_MS = 4 * 60 * 1000;

// FIX (2026-09-05): the window check above used to key off BBS's own
// kickoff_utc from /v1/stored/matches. Confirmed in production that BBS
// sometimes populates that field with a 2026-09-05T00:00:00.000Z
// placeholder before it has the real scheduled time (~14 Week 1 games hit
// this, e.g. Washington vs Washington State showed kickoff_utc=midnight
// UTC Sept 5 while CFBD's real kickoff for that game is Sept 6 20:00
// UTC - almost a full day off). Because POST_KICKOFF_WINDOW_MS is 4h15m,
// every game carrying that placeholder looked "in progress" from
// 00:00-04:15 UTC regardless of when it actually kicked off, driving the
// subpoll loop to its full SUBPOLL_BUDGET_MS on every single cron tick
// that whole window - confirmed via Cloudflare's own subrequest telemetry
// (hour 03:00 UTC hit 468 subrequests, the mathematical max for 12 ticks
// times the full subpoll budget) and ~86% of the day's BBS call volume
// landed in that 00:00-04:00 UTC span alone.
//
// Fix: the subpoll window decision now uses CFBD's real kickoff time from
// WEEK1_MATCHUPS_URL (same data already trusted for the site's rank
// cards) instead of BBS's kickoff_utc. BBS's kickoff_utc is still stored
// in the published payload and still drives score/status once a game is
// confirmed in-window - only the window decision itself changed.

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

  const realKickoffs = await getRealKickoffTimes(env);

  const now = Date.now();
  const relevantGames = [];
  let anyActiveWindow = false;

  for (const raw of rawMatches) {
    const homeCanonical = resolveBbsTeamName(raw.home?.name, rankedTeams);
    const awayCanonical = resolveBbsTeamName(raw.away?.name, rankedTeams);
    if (!homeCanonical && !awayCanonical) continue;

    const parsed = parseBbsMatch(raw);

    // Window decision uses CFBD's real kickoff (via WEEK1_MATCHUPS_URL),
    // never BBS's own kickoff_utc - see the SUBPOLL_* comment above for
    // why. No CFBD entry, or start_time_tbd, means "unknown" -> treated
    // as not-in-window (safe default: no subpoll rather than a guess).
    const realKickoff = realKickoffs.get(homeCanonical) ?? realKickoffs.get(awayCanonical);
    const kickoffMs =
      realKickoff && !realKickoff.start_time_tbd && realKickoff.kickoff_utc
        ? Date.parse(realKickoff.kickoff_utc)
        : null;
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

// Returns a Map of canonical team name -> { kickoff_utc, start_time_tbd },
// sourced from CFBD via sports/cfb/fetch_week1_matchups.py's output (same
// file the public site's rank cards already read). Used only to decide
// subpoll eligibility - see the SUBPOLL_* comment near the top of this
// file for why BBS's own kickoff_utc isn't used for that decision.
async function getRealKickoffTimes(env) {
  let resp;
  try {
    resp = await fetch(WEEK1_MATCHUPS_URL, { cf: { cacheTtl: 60 } });
  } catch (err) {
    console.error("Week1 matchups fetch failed:", err.message);
    return new Map();
  }
  if (!resp.ok) {
    console.error(`Week1 matchups fetch returned ${resp.status}`);
    return new Map();
  }
  const data = await resp.json();
  const matchups = data.matchups ?? {};
  const byTeam = new Map();
  for (const [team, info] of Object.entries(matchups)) {
    byTeam.set(team, {
      kickoff_utc: info.kickoff_utc ?? null,
      start_time_tbd: info.start_time_tbd === true,
    });
  }
  return byTeam;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
