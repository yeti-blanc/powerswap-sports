/**
 * PowerSwap Live Scores - Big Balls Sports Data (BBS) client
 * ============================================================
 *
 * CORRECTED 2026-09-04: this used to call /v1/matches, which BBS's own
 * OpenAPI spec (https://api.bigballsdata.com/openapi.json) and a live
 * call confirm returns a terse live-feed-only shape - home/away as plain
 * integers, no team names, no kickoff time, ever. That endpoint was never
 * going to carry what parseBbsMatch() needs; the "Confirmed" shape
 * originally documented in live/README.md (home/away as {name,...},
 * kickoff_utc, score, linescore) is real, but belongs to a DIFFERENT
 * endpoint - /v1/stored/matches - not the one this file was calling.
 *
 * /v1/stored/matches confirmed live for real NCAAF games on 2026-09-04
 * (e.g. Missouri 54-14 over Arkansas-Pine Bluff; Kansas vs Long Island
 * scheduled with a real kickoff_utc). Two things it does differently from
 * /v1/matches:
 *   - `date` must be an explicit YYYY-MM-DD. The "today" literal that
 *     works on /v1/matches is REJECTED here with a 400.
 *   - Response envelope is `{ data, pagination }`, not the `{ data, meta,
 *     error }` Envelope /v1/matches uses.
 * fetchBbsMatches() below can fetch either just today's UTC date or both
 * today's + yesterday's, merged and deduped by id. DECOUPLED 2026-09-12
 * (same fix as PFPI's schedule/live-score split, see admin/BUILD_LOG.md):
 * yesterday's date only ever matters for the brief window right after UTC
 * midnight while a late-kickoff game from "yesterday" hasn't finished yet -
 * every other tick of the day it was a wasted second request, unconditionally
 * doubling this endpoint's cost 24/7 for a need that's real maybe 4-5 hours
 * a day. worker.js now decides includeYesterday per tick from actual KV
 * state (does a not-yet-finished game with a yesterday kickoff exist?),
 * the same "self-limiting on real state, not a fixed clock" idea PFPI used.
 *
 * Base URL/auth style confirmed 2026-09-01. Docs: bigballsdata.com/docs,
 * bigballsdata.com/ncaaf-api. Free tier: 1,000 req/day, 2,000/day on a
 * GitHub-linked account (this account is GitHub-linked) - note this fetch
 * now costs 2 BBS requests per poll instead of 1, see worker.js's SUBPOLL
 * comment for the fuller quota implication.
 */

export const BBS_BASE_URL = "https://api.bigballsdata.com";
export const BBS_SPORT = "american_football";
export const BBS_LEAGUE = "ncaaf"; // FBS only - AP Top 25 never has an FCS team (see sports/cfb/config.py DIVISION_FILTER)

export function utcDateString(daysOffset) {
  return new Date(Date.now() + daysOffset * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

async function fetchStoredMatchesForDate(apiKey, date) {
  const url = `${BBS_BASE_URL}/v1/stored/matches?sport=${BBS_SPORT}&league=${BBS_LEAGUE}&date=${date}&limit=200`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    const err = new Error(`BBS /v1/stored/matches (date=${date}) returned ${resp.status}`);
    err.status = resp.status; // let callers detect 429 without string-matching the message
    throw err;
  }
  const body = await resp.json();
  const matches = body.data ?? [];
  if (body.pagination && body.pagination.total > matches.length) {
    // limit=200 comfortably covers a full NCAAF Saturday (~95 games seen
    // on 2026-09-05) - this only fires if that assumption ever breaks.
    console.warn(
      `BBS /v1/stored/matches date=${date}: pagination.total=${body.pagination.total} exceeds fetched ${matches.length} (limit too low)`
    );
  }
  return matches;
}

export async function fetchBbsMatches(apiKey, includeYesterday = true) {
  const dates = includeYesterday ? [utcDateString(0), utcDateString(-1)] : [utcDateString(0)];
  const byId = new Map();
  let lastError = null;

  for (const date of dates) {
    try {
      for (const m of await fetchStoredMatchesForDate(apiKey, date)) {
        byId.set(m.id, m);
      }
    } catch (err) {
      console.error(err.message);
      lastError = err;
    }
  }

  if (byId.size === 0 && lastError) throw lastError;
  return [...byId.values()];
}

// ============================================================
// SECONDARY SOURCE: /v1/matches (the "old" live-feed endpoint this client
// stopped using on 2026-09-04 - see the file header above). Verified live
// 2026-09-12 during the /v1/stored/matches outage documented in
// admin/BUILD_LOG.md, specifically as a candidate for real redundancy
// (not just "it returns 200"):
//
//   - Real response shape is IDENTICAL to /v1/stored/matches for every
//     field parseBbsMatch() reads: id, home/away.name ("School Mascot",
//     same convention - confirmed against real games incl. "Kansas
//     Jayhawks", "UCF Knights", "East Carolina Pirates" vs "App State
//     Mountaineers"/"Appalachian State Mountaineers" both spellings, both
//     already covered by team_norm.js's existing NORM table), kickoff_utc,
//     status, score.{home,away}, linescore.{home,away}. No new norm()
//     entries needed; resolveBbsTeamName() works unchanged.
//   - status TRANSITIONS correctly and promptly: watched a real live game
//     (Kansas @ Missouri, id b5cb50b8-cfb2-4d14-83de-7e3b79574e90) flip
//     "live" -> "finished" between two 60s-apart polls (03:53:38 ->
//     03:54:38 UTC 2026-09-12) - well inside this Worker's 2-minute cron
//     interval, so no meaningfully-stale "still live" badge risk from
//     this endpoint's own update cadence.
//   - Does NOT need a `date` param at all (unlike /v1/stored/matches) -
//     one real call returned a slate spanning yesterday's late kickoffs
//     through tomorrow's, so fetchLegacyMatches() below is a single
//     request, not a 2-date loop.
//   - Has the SAME duplicate-row-under-different-IDs problem as
//     /v1/stored/matches: confirmed 8 distinct real matchups each
//     appearing twice under different ids on 2026-09-12 (e.g. Purdue vs
//     Wake Forest, Michigan vs Oklahoma), one copy carrying a
//     midnight-UTC placeholder kickoff_utc and the other a real one -
//     same class of bug as the Miami/Florida A&M incident, needs the
//     same gameIdentityKey()/STATUS_PRIORITY dedup worker.js already
//     applies (that logic is source-agnostic - it runs on whatever raw
//     matches get fed into it, so no new dedup code was needed here).
//
// NOT independently confirmed (flagging rather than glossing over, per
// the "verify with real evidence" rule): no actual in-game SCORE change
// was observed mid-play - the one live game available during testing
// (21-38, Q4) didn't score again before finishing, so "does score update
// near-real-time during a live play" rests on this endpoint sharing the
// exact same score/linescore fields as /v1/stored/matches (which HAS
// shown real mid-game score changes historically) rather than on a fresh
// direct observation. Similarly, no close/back-and-forth game was live
// during the test window - only blowouts and pre-kickoff games were
// available. Re-verify against a genuinely close live game before fully
// trusting this path under real fire.
export async function fetchLegacyMatches(apiKey) {
  const url = `${BBS_BASE_URL}/v1/matches?sport=${BBS_SPORT}&league=${BBS_LEAGUE}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    const err = new Error(`BBS /v1/matches returned ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  const body = await resp.json();
  return body.data ?? [];
}

// ============================================================
// EVERYTHING IN THIS FUNCTION IS THE "ISOLATE THE UNVERIFIED PARTS" ZONE.
// ============================================================
//
// CONFIRMED against real /v1/stored/matches responses on 2026-09-04
// (real 2026 week 1 NCAAF games, both finished and scheduled):
//   - id: string (this is the field named "id" here - NOT "match_id",
//     which is what /v1/matches uses for the same concept)
//   - home / away: { id, name, short_name, logo_url }, name is "School Mascot"
//   - kickoff_utc: ISO timestamp - real, populated
//   - status: "scheduled" | "finished" seen live; BBS's OpenAPI spec
//     documents this endpoint's full enum as scheduled|live|finished|cancelled
//   - score: null while scheduled, else { home: number, away: number }
//   - linescore: null while scheduled, else { home: number[], away: number[] }
//   - bonus fields also present: attendance, broadcast, round, has_odds
//
// CONFIRMED against two real in-progress games on 2026-09-12 (James
// Madison/Wagner, Virginia Tech/Old Dominion, caught via a temporary
// console.log during the primary's first post-outage live tick):
//   - status really does come back as "live" (not some other string)
//   - linescore.home / linescore.away are per-quarter score arrays whose
//     LENGTH is the current quarter - a new (initially 0) entry appears
//     the moment that quarter starts, not only once it's scored in.
//     Verified by summing each array against `score`: they matched
//     exactly in both examples (JMU 66 = 21+21+24, Wagner 3 = 3+0+0;
//     VT 37 = 17+17+3+0, ODU 13 = 3+3+7+0 with Q4 just underway).
//     -> period = linescore length; >4 means overtime.
//
// STILL UNVERIFIED / genuinely absent from both real examples above:
//   - clock / time-remaining: no such field exists anywhere on the raw
//     object (full real key set: id, sport, league, home, away,
//     kickoff_utc, status, score, linescore, attendance, broadcast,
//     round, has_odds). Not just unpopulated - not present at all. Kept
//     as a guessed-name passthrough below in case a future response ever
//     adds it, but don't expect it from this endpoint.
//   - possession: same - not present on either real example.
//   - halftime as a distinct state: BBS's own documented status enum is
//     only scheduled|live|finished|cancelled, and linescore length can't
//     tell "still Q2" apart from "halftime after Q2" (both are length 2).
//     Deliberately not guessed at - see PROJECT_BIBLE.md §6 discussion.
//   - the real refresh cadence behind this DB-backed endpoint ("stored
//     matches... read directly from Postgres" per its own docs) - i.e.
//     whether polling faster than that cadence buys any actual freshness
export function parseBbsMatch(raw) {
  const status = normalizeStatus(raw.status);
  const homeLinescore = raw.linescore?.home;
  const awayLinescore = raw.linescore?.away;
  return {
    id: raw.id,
    home_name_raw: raw.home?.name ?? null,
    away_name_raw: raw.away?.name ?? null,
    kickoff_utc: raw.kickoff_utc ?? null,
    status,
    raw_status: raw.status ?? null,
    home_score: raw.score?.home ?? null,
    away_score: raw.score?.away ?? null,
    period: homeLinescore?.length ?? awayLinescore?.length ?? raw.period ?? raw.current_period ?? raw.quarter ?? null,
    // UNVERIFIED, confirmed absent from every real example seen so far -
    // see comment above. Guessed-name passthrough kept only as a no-cost
    // safety net if BBS ever adds this.
    clock: raw.clock ?? raw.current_clock ?? raw.time_remaining ?? null,
    possession: raw.possession ?? raw.current_possession ?? null,
  };
}

const FINISHED_STATUSES = new Set(["finished", "final", "completed"]);
const SCHEDULED_STATUSES = new Set(["scheduled", "pre", "not_started"]);
// UNVERIFIED guesses - correct once a real in-progress game is observed.
const LIVE_STATUSES = new Set(["live", "in_progress", "in progress", "playing"]);

function normalizeStatus(raw) {
  const s = (raw ?? "").toLowerCase();
  if (FINISHED_STATUSES.has(s)) return "finished";
  if (SCHEDULED_STATUSES.has(s)) return "scheduled";
  if (LIVE_STATUSES.has(s)) return "in_progress";
  return "unknown"; // deliberately not guessed further - surface as-is via raw_status
}
