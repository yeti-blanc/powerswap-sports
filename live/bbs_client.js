/**
 * PowerSwap Live Scores - Big Balls Sports Data (BBS) client
 * ============================================================
 *
 * Base URL, endpoint, and auth style confirmed with a real authenticated
 * call on 2026-09-01 (see live/fetch_live_scores.py --diagnose, and the
 * saved sample responses in live/README.md). Docs: bigballsdata.com/docs,
 * bigballsdata.com/ncaaf-api. Free tier: 1,000 req/day, 2,000/day on a
 * GitHub-linked account (this account is GitHub-linked).
 */

export const BBS_BASE_URL = "https://api.bigballsdata.com";
export const BBS_SPORT = "american_football";
export const BBS_LEAGUE = "ncaaf"; // FBS only - AP Top 25 never has an FCS team (see sports/cfb/config.py DIVISION_FILTER)

export async function fetchBbsMatches(apiKey) {
  const url = `${BBS_BASE_URL}/v1/matches?sport=${BBS_SPORT}&league=${BBS_LEAGUE}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    throw new Error(`BBS /v1/matches returned ${resp.status}`);
  }
  const body = await resp.json();
  return body.data ?? [];
}

// ============================================================
// EVERYTHING IN THIS FUNCTION IS THE "ISOLATE THE UNVERIFIED PARTS" ZONE.
// ============================================================
//
// CONFIRMED against real responses on 2026-09-01 (scheduled NCAAF games,
// plus finished MLB/EPL games used as a same-schema proxy since no NCAAF
// or other game was actually live at check time):
//   - id, sport, league: strings
//   - home / away: { name, short_name, logo_url }, name is "School Mascot"
//   - kickoff_utc: ISO timestamp
//   - status: "scheduled" | "finished" seen so far
//   - score: null while scheduled, else { home: number, away: number }
//   - linescore: null while scheduled, else { home: number[], away: number[] }
//
// UNVERIFIED - no example observed yet, first real chance is when 2026
// week 1 games kick off ~2026-09-03:
//   - the in-progress status string itself (guessing "in_progress" or
//     "live" below - either is a guess, not a confirmed value)
//   - whether/where clock and period/quarter live on the object
//   - every /v1/matches call so far has returned
//     meta.note = "Upcoming matches served from the stored table (no live
//     adapter covers this sport/league; refreshed by ingest)" for EVERY
//     sport/league tried (NCAAF, NCAAF-FCS, MLB, EPL) - not NCAAF-specific.
//     That suggests the free tier may not have a true low-latency live
//     feed at all (WebSocket live push is advertised as a paid-plan
//     feature). Poll cadence below is deliberately more conservative than
//     the original "~15s" target until this is confirmed against a real
//     in-progress game - see live/README.md.
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
