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

// Used ONLY for clean opponent naming (see MASCOT-FREE NAMING below) - a
// free GitHub-raw fetch, doesn't touch BBS's quota. Not used for polling
// decisions of any kind (that architecture was deliberately removed - see
// the file header above).
const WEEK1_MATCHUPS_URL =
  "https://raw.githubusercontent.com/yeti-blanc/powerswap-sports/main/data/cfb/seasons/2026/week1_matchups.json";

const LIVE_KV_KEY = "live_payload";
// Must comfortably exceed the cron interval or the key expires between
// ticks and /live falls back to its empty default even though polling is
// working fine - confirmed happening in production with a too-short TTL
// during overnight testing on 2026-09-01.
const KV_TTL_SECONDS = 600;

// GAME RETENTION (2026-09-06, made permanent-until-superseded per explicit
// request): BBS's /v1/stored/matches only ever returns today's and
// yesterday's UTC-date games (see bbs_client.js) - a game older than that
// silently stops appearing in each fresh fetch, even though it finished
// normally. Confirmed in production: Thursday's games had aged out of the
// payload by Sunday. Rather than widen the BBS date range (which would
// cost more requests per poll - the exact thing this morning's redesign
// was built to avoid), pollAndCache() merges each fresh fetch on top of
// the PREVIOUS payload already in KV: a finished game that ages out of
// BBS's 2-day window stays in the published payload (frozen at its last
// known score) INDEFINITELY - no time-based expiry - until that same
// ranked team's NEXT real game appears in a fresh fetch and supersedes it
// (see gameIdentityKey()). A team's next real game can't appear in BBS's
// fetch window before it actually happens, so this can't leak a future
// week's score early - it only ever replaces a finished entry with a
// newer finished (or in-progress) one for the same team. No extra BBS
// requests either way - this is pure KV read+merge, no per-game TTL.

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

  const week1Opponents = await getWeek1Opponents(env);
  const rankedSet = new Set(rankedTeams);

  // Keyed by gameIdentityKey(), not pushed to a flat array: BBS's own
  // stored data carries real duplicate/near-duplicate records for the
  // same matchup under different ids (confirmed repeatedly - e.g.
  // "Arkansas-Pine Bluff Golde Lions" vs "...Golden Lions" as two
  // separate records for the one real Missouri game). Deduping here by
  // identity, keeping whichever status is most advanced, means the
  // published payload only ever has one entry per real game.
  const freshByKey = new Map();
  for (const raw of rawMatches) {
    const homeCanonical = resolveBbsTeamName(raw.home?.name, rankedTeams);
    const awayCanonical = resolveBbsTeamName(raw.away?.name, rankedTeams);
    if (!homeCanonical && !awayCanonical) continue;

    const parsed = parseBbsMatch(raw);
    const game = {
      id: parsed.id,
      // MASCOT-FREE NAMING (2026-09-06): a ranked opponent already comes
      // out clean via resolveBbsTeamName (matches season_history.json's
      // school-only names). An UNRANKED opponent has no such match, so it
      // used to fall straight through to BBS's raw "School Mascot" name
      // (e.g. "East Carolina Pirates") - confirmed live. BBS's own
      // `short_name` field is NOT a safe substitute (confirmed via a real
      // call: it's sometimes an abbreviation like "UTU" for Utah Tech,
      // not a clean full name). Instead, since the OTHER side of this
      // game is always a ranked team once we're in this loop, we already
      // know that ranked team's real week-1 opponent from CFBD (clean,
      // no mascot) via week1_matchups.json - use that name instead of
      // guessing at BBS's raw one. Only covers week 1 (that file's own
      // scope); falls back to the raw BBS name otherwise.
      home_team: homeCanonical ?? week1Opponents.get(awayCanonical) ?? norm(raw.home?.name ?? ""),
      away_team: awayCanonical ?? week1Opponents.get(homeCanonical) ?? norm(raw.away?.name ?? ""),
      home_score: parsed.home_score,
      away_score: parsed.away_score,
      status: parsed.status,
      raw_status: parsed.raw_status,
      period: parsed.period,
      clock: parsed.clock,
      possession: parsed.possession,
      kickoff_utc: parsed.kickoff_utc,
    };

    const key = gameIdentityKey(game, rankedSet);
    const existing = freshByKey.get(key);
    if (!existing || (STATUS_PRIORITY[game.status] ?? 0) >= (STATUS_PRIORITY[existing.status] ?? 0)) {
      freshByKey.set(key, game);
    }
  }
  const freshGames = [...freshByKey.values()];

  const previous = await getPreviousPayload(env);
  const mergedGames = mergeGames(freshGames, previous.games, rankedSet);

  await env.LIVE_KV.put(
    LIVE_KV_KEY,
    JSON.stringify({ updated_at: new Date().toISOString(), games: mergedGames }),
    { expirationTtl: KV_TTL_SECONDS }
  );
}

async function getPreviousPayload(env) {
  const raw = await env.LIVE_KV.get(LIVE_KV_KEY);
  if (!raw) return { games: [] };
  try {
    return JSON.parse(raw);
  } catch {
    return { games: [] };
  }
}

const STATUS_PRIORITY = { in_progress: 3, finished: 2, scheduled: 1, unknown: 0 };

// Identity is anchored to whichever side is a CURRENTLY-ranked team, not
// the raw team-name pair. Bug found and fixed same-day: keying by the raw
// pair broke the instant an unranked opponent's displayed name changed
// (e.g. the mascot-stripping fix below) - the old ("BYU Cougars" era)
// and new ("BYU"/"Utah Tech") records no longer matched, so the "merge"
// treated them as two different games and kept both, doubling the
// payload. A ranked team's own canonical name never changes between
// polls, so keying on it (both sides, sorted, for the rare ranked-vs-
// ranked case) is stable regardless of how the OTHER side's name is
// computed.
export function gameIdentityKey(game, rankedSet) {
  const rankedSides = [game.home_team, game.away_team].filter((t) => rankedSet.has(t)).sort();
  return (rankedSides.length > 0 ? rankedSides : [game.home_team, game.away_team].sort()).join("|");
}

// Fresh fetch results always win (they're the latest known state for
// anything still inside BBS's queried date range). Games from the
// previous payload are kept PERMANENTLY - no time-based expiry - as long
// as the fresh fetch doesn't already have a newer entry for the same
// ranked team (see gameIdentityKey()). A team's next real game can only
// enter the fresh fetch once it's actually within BBS's 2-day window,
// i.e. once it's genuinely about to happen or has happened, so this can
// never show a future week's result early - it only ever replaces one
// finished/in-progress entry with a newer one for the same team.
export function mergeGames(freshGames, previousGames, rankedSet) {
  const freshKeys = new Set(freshGames.map((g) => gameIdentityKey(g, rankedSet)));
  const retained = (previousGames ?? []).filter((g) => !freshKeys.has(gameIdentityKey(g, rankedSet)));
  return [...freshGames, ...retained];
}

// Canonical ranked-team name -> their real week-1 opponent's clean name
// (CFBD-sourced, no mascot - see sports/cfb/fetch_week1_matchups.py).
// Used only for display naming, never for polling decisions.
async function getWeek1Opponents(env) {
  let resp;
  try {
    resp = await fetch(WEEK1_MATCHUPS_URL, { cf: { cacheTtl: 60 } });
  } catch (err) {
    console.error("Week1 matchups fetch failed:", err.message);
    return new Map();
  }
  if (!resp.ok) return new Map();
  const data = await resp.json();
  const matchups = data.matchups ?? {};
  return new Map(Object.entries(matchups).map(([team, info]) => [team, info.opponent]));
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
