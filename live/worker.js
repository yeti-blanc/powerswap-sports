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
//
// Bug fixed 2026-09-11: this used to be a single hardcoded
// WEEK1_MATCHUPS_URL, always. That was correct only while week 1 was the
// only week with games - the instant week 2 started (Miami vs Florida
// A&M, an unranked opponent), the fallback kept reaching for week 1's
// file and returned Miami's WEEK 1 opponent ("Stanford") instead, with
// the real live score attached to the wrong name. getCurrentWeekUrl()
// below picks whichever week's matchups file actually matches the week
// that's live right now, the same "latest real snapshot + 1" logic
// site/app.js already uses for its own preview-week display.
const WEEK1_MATCHUPS_URL =
  "https://raw.githubusercontent.com/yeti-blanc/powerswap-sports/main/data/cfb/seasons/2026/week1_matchups.json";
const RAW_DATA_BASE_URL =
  "https://raw.githubusercontent.com/yeti-blanc/powerswap-sports/main/data/cfb/seasons/2026/raw";

// season_history.json's snapshots are the completed/backtested weeks -
// the week that's actually being PLAYED right now (where live games and
// unranked opponents show up) is always one past the latest of those
// (falls back to week 1 if the season has no real snapshot yet, e.g.
// preseason). Mirrors site/app.js's getLiveWeekKey()/loadSeason() logic.
export function getCurrentWeekNumber(seasonData) {
  const snapshots = seasonData?.snapshots ?? [];
  const realWeekNums = snapshots
    .map((s) => /^week(\d+)$/.exec(s.week || ""))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10));
  const latestRealWeek = realWeekNums.length ? Math.max(...realWeekNums) : null;
  return latestRealWeek !== null ? latestRealWeek + 1 : 1;
}

// Week 1 keeps using the legacy top-level file (fetch_week1_matchups.py's
// output, unchanged - live games already relied on this exact URL). Week
// 2 onward uses fetch_week_matchups.py's generalized per-week file (see
// admin/BUILD_LOG.md's 2026-09-08 entry) - this Worker just never looked
// at it until now.
export function getCurrentWeekMatchupsUrl(weekNum) {
  if (weekNum <= 1) return WEEK1_MATCHUPS_URL;
  return `${RAW_DATA_BASE_URL}/week_${String(weekNum).padStart(2, "0")}_matchups.json`;
}

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
  const seasonData = await getSeasonData(env);
  const rankedTeams = getCurrentRankedTeams(seasonData);
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

  const currentWeekNumber = getCurrentWeekNumber(seasonData);
  const currentWeekOpponents = await getCurrentWeekOpponents(env, currentWeekNumber);
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
      // MASCOT-FREE NAMING (2026-09-06, fixed 2026-09-08 to use the
      // actually-live week's file instead of always week 1's): a ranked
      // opponent already comes out clean via resolveBbsTeamName (matches
      // season_history.json's school-only names). An UNRANKED opponent
      // has no such match, so it used to fall straight through to BBS's
      // raw "School Mascot" name (e.g. "East Carolina Pirates") -
      // confirmed live. BBS's own `short_name` field is NOT a safe
      // substitute (confirmed via a real call: it's sometimes an
      // abbreviation like "UTU" for Utah Tech, not a clean full name).
      // Instead, since the OTHER side of this game is always a ranked
      // team once we're in this loop, we already know that ranked team's
      // real CURRENT-WEEK opponent from CFBD (clean, no mascot) via
      // getCurrentWeekOpponents() - use that name instead of guessing at
      // BBS's raw one. Falls back to the raw BBS name if that week has no
      // matchups file yet.
      home_team: homeCanonical ?? currentWeekOpponents.get(awayCanonical) ?? norm(raw.home?.name ?? ""),
      away_team: awayCanonical ?? currentWeekOpponents.get(homeCanonical) ?? norm(raw.away?.name ?? ""),
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

// Bug fixed 2026-09-11 (real incident, see admin/BUILD_LOG.md): this used
// to rank in_progress (3) above finished (2), backwards from the "keeping
// whichever status is most advanced" intent stated in the comment above
// freshByKey. BBS confirmed (repeatedly, including live right now for
// Miami/Florida A&M) to return two separate duplicate records for the same
// real game under different ids - their own per-record sync isn't
// guaranteed simultaneous, so one duplicate can still say "in_progress"
// with a stale score for a while after its sibling record has already
// flipped to "finished". With the old ordering, that stale in_progress
// duplicate won on every single poll for as long as BBS's own two rows
// disagreed - reproduced directly against real data (Miami's actual
// observed in-progress score, 63-0, beating its own already-final 77-7
// record) - which is what kept the site showing a genuinely-ended game as
// still live for over an hour, independent of the Worker/cron/client poll
// all working correctly. finished is now the highest-priority status: a
// real game can't un-finish, so once ANY duplicate record reports
// finished, that's authoritative regardless of what a lagging sibling
// record still says.
const STATUS_PRIORITY = { finished: 3, in_progress: 2, scheduled: 1, unknown: 0 };

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

// Canonical ranked-team name -> their real CURRENT-WEEK opponent's clean
// name (CFBD-sourced, no mascot - see fetch_week1_matchups.py /
// fetch_week_matchups.py). Used only for display naming, never for
// polling decisions. weekNum picks the file (see getCurrentWeekNumber()/
// getCurrentWeekMatchupsUrl() above) - fixed 2026-09-11, this used to
// always read week 1's file regardless of which week was actually live.
async function getCurrentWeekOpponents(env, weekNum) {
  let resp;
  try {
    resp = await fetch(getCurrentWeekMatchupsUrl(weekNum), { cf: { cacheTtl: 60 } });
  } catch (err) {
    console.error("Current-week matchups fetch failed:", err.message);
    return new Map();
  }
  if (!resp.ok) return new Map();
  const data = await resp.json();
  const matchups = data.matchups ?? {};
  return new Map(Object.entries(matchups).map(([team, info]) => [team, info.opponent]));
}

// Fetches season_history.json once per poll - shared by
// getCurrentRankedTeams() (which teams to filter BBS's slate to) and
// getCurrentWeekNumber() (which week is actually live right now), so both
// read the exact same snapshot instead of two separate fetches that could
// disagree if the file changed between them.
async function getSeasonData(env) {
  let resp;
  try {
    resp = await fetch(RANKED_TEAMS_URL, { cf: { cacheTtl: 60 } });
  } catch (err) {
    console.error("Season-history fetch failed:", err.message);
    return null;
  }
  if (!resp.ok) {
    // Expected for now: data/cfb/seasons/2026/season_history.json doesn't
    // exist yet (2026 backtest pipeline hasn't produced its first
    // snapshot). Not an error - just means nothing is ranked yet.
    return null;
  }
  return resp.json();
}

function getCurrentRankedTeams(seasonData) {
  const snapshots = seasonData?.snapshots ?? [];
  if (snapshots.length === 0) return [];
  const latest = snapshots[snapshots.length - 1];
  return (latest.rankings ?? []).map((slot) => slot.team);
}
