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
 * fetchBbsMatches() below fetches both today's and yesterday's UTC date
 * (kickoff_utc's date is a UTC calendar date, and POST_KICKOFF_WINDOW_MS
 * in worker.js is only 4h15m, so a game can never be in-window more than
 * one UTC day back) and merges them, deduped by id.
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

function utcDateString(daysOffset) {
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
    throw new Error(`BBS /v1/stored/matches (date=${date}) returned ${resp.status}`);
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

export async function fetchBbsMatches(apiKey) {
  const dates = [utcDateString(0), utcDateString(-1)];
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
// UNVERIFIED - no in-progress example observed yet (still true after the
// 2026-09-04 endpoint fix - nothing was actually live at check time):
//   - whether "live" (this endpoint's documented in-progress value, per
//     its OpenAPI enum) is really what comes back, vs some other string
//   - whether/where clock and period/quarter live on the object - not
//     present on any finished/scheduled example seen so far
//   - the real refresh cadence behind this DB-backed endpoint ("stored
//     matches... read directly from Postgres" per its own docs) - i.e.
//     whether polling faster than that cadence buys any actual freshness
//
// This function is intentionally permissive: it never assumes a field is
// present, and passes through whatever raw status/clock/period-shaped
// values it can find so the next session can correct field names here
// without touching anything else in the Worker.
export function parseBbsMatch(raw) {
  const status = normalizeStatus(raw.status);
  return {
    id: raw.id,
    home_name_raw: raw.home?.name ?? null,
    away_name_raw: raw.away?.name ?? null,
    kickoff_utc: raw.kickoff_utc ?? null,
    status,
    raw_status: raw.status ?? null,
    home_score: raw.score?.home ?? null,
    away_score: raw.score?.away ?? null,
    // UNVERIFIED: guessed key names, tried in rough order of likelihood.
    // None of these have been seen populated in any real response yet.
    period: raw.period ?? raw.current_period ?? raw.quarter ?? null,
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
