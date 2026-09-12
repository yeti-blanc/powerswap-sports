/**
 * PowerSwap Live Scores - Highlightly (tertiary source) client
 * ===============================================================
 *
 * STATUS AS OF 2026-09-12 (updated same day once a real key was added -
 * see admin/BUILD_LOG.md): PARTIALLY LIVE-VERIFIED. A real
 * HIGHLIGHTLY_API_KEY now exists as a `powerswap-live-scores` Worker
 * secret (it didn't when this file was first written - see BUILD_LOG for
 * that history) and a real call has been made and inspected. One real
 * bug was caught and fixed this way: the docs originally pulled for this
 * file said the NCAA filter param was `leagueName=NCAA` - a REAL call
 * rejected that with `{"message":"property leagueName should not exist"}`
 * (400). The correct param, confirmed with a real 200, is `league=NCAA`.
 *
 * CONFIRMED against a real response (2026-09-12, ~06:00 UTC, NCAA slate
 * for 2026-09-12 - all games still pregame at that hour, see the one
 * still-open item below):
 *   - Base URL + endpoint + auth header all correct as documented:
 *     `GET https://american-football.highlightly.net/matches?league=NCAA&date=YYYY-MM-DD`,
 *     `x-rapidapi-key: <key>` header, no RapidAPI-marketplace host header
 *     needed for direct calls.
 *   - Real rate-limit headers came back exactly as documented:
 *     `x-ratelimit-requests-limit: 100`, `x-ratelimit-requests-remaining`
 *     decrementing per call (confirmed 96 -> 95 across two real calls).
 *   - `homeTeam`/`awayTeam.displayName` for NCAA IS "School Mascot" format
 *     - confirmed real examples: "Auburn Tigers", "Southern Miss Golden
 *     Eagles", "Ole Miss Rebels", "Charlotte 49ers", "LSU Tigers",
 *     "Louisiana Tech Bulldogs". Same convention as BBS -
 *     resolveBbsTeamName()/norm() work completely unchanged (the "Ole
 *     Miss" -> "Mississippi" NORM entry already covers the one variant
 *     seen).
 *   - `state.description` for a pregame game is the string `"Scheduled"`
 *     (capital S) - matches normalizeHighlightlyStatus()'s existing
 *     "scheduled" entry (lowercased before comparison, so this already
 *     worked without a code change).
 *   - `date` (top-level, real kickoff time e.g.
 *     "2026-09-12T23:45:00.000Z" = 7:45 PM EDT) is populated and
 *     cross-checks against real broadcast-window expectations - no
 *     BBS-style midnight-UTC placeholder seen here.
 *   - `state.score.current` real shape confirmed: `"0 - 0"` pregame,
 *     confirming it IS the documented combined-string format (not
 *     separate integers) - see the still-open item below for the part
 *     that matters more than the shape.
 *
 * STILL UNVERIFIED - genuinely open, not for lack of trying: no game in
 * the real pull was anything but pregame (0-0, "Scheduled") at check
 * time (~2 AM ET, before that Saturday's slate kicked off):
 *   - THE BIG ONE: which side of `score.current`'s `"N - M"` string is
 *     home and which is away. "0 - 0" can't distinguish this either way.
 *     parseHighlightlyScore() below still GUESSES "home - away" - this
 *     is the one guess that fails SILENTLY (a confidently-wrong score)
 *     rather than loudly if backwards. Re-check the first time this path
 *     actually serves a live or finished score with unequal numbers,
 *     ideally a blowout where a flipped order is obvious by eye - the
 *     debug endpoint this was checked with is still deployed (see
 *     worker.js's TEMPORARY DIAGNOSTIC comment) for exactly this.
 *   - The in-progress/finished status vocabulary - only "Scheduled" has
 *     been seen for real. HL_LIVE/HL_FINISHED below are still guesses.
 *   - Whether this endpoint has the same duplicate-row problem as BBS's
 *     two endpoints - not seen in the one pull done, but that pull was
 *     small. mergeGames()'s identity/priority logic in worker.js applies
 *     regardless of source either way, so this isn't a blocker.
 *
 * Rate limit reset window (calendar day vs. rolling 24h) is still not
 * stated anywhere in Highlightly's docs and wasn't resolved by the one
 * real call made (not enough calls/time elapsed to observe a reset).
 * worker.js's throttle is built to be correct under EITHER
 * interpretation (see HIGHLIGHTLY_MAX_PER_ROLLING_DAY in worker.js)
 * rather than guessing - it tracks a rolling 24h count in KV (always <=
 * either a calendar or rolling cap) and additionally backs off early if
 * a real response's x-ratelimit-requests-remaining header ever comes
 * back low, regardless of what our own counter thinks.
 */

export const HIGHLIGHTLY_BASE_URL = "https://american-football.highlightly.net";

function dateString(daysOffset = 0) {
  return new Date(Date.now() + daysOffset * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

// Returns { matches, rateLimitRemaining } - rateLimitRemaining is null if
// the header wasn't present (e.g. header name is also UNVERIFIED against
// a real response - see file header).
export async function fetchHighlightlyMatches(apiKey, dateOverride) {
  const date = dateOverride ?? dateString(0);
  const url = `${HIGHLIGHTLY_BASE_URL}/matches?league=NCAA&date=${date}`;
  const resp = await fetch(url, {
    headers: { "x-rapidapi-key": apiKey },
  });
  if (!resp.ok) {
    const err = new Error(`Highlightly /matches (date=${date}) returned ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  const remainingHeader = resp.headers.get("x-ratelimit-requests-remaining");
  const rateLimitRemaining = remainingHeader !== null ? parseInt(remainingHeader, 10) : null;
  const body = await resp.json();
  const matches = Array.isArray(body) ? body : body.data ?? [];
  return { matches, rateLimitRemaining };
}

const HL_FINISHED = new Set(["finished", "final", "full time", "ft"]);
const HL_SCHEDULED = new Set(["not started", "scheduled", "pre"]);
// UNVERIFIED - see file header. Deliberately broad rather than narrow: a
// guess that's too narrow silently falls through to "unknown" (safe,
// visible via raw_status) - one that's too broad risks misreading a
// pregame/postgame state as live, which is worse. Kept to values that
// clearly imply an active game.
const HL_LIVE = new Set([
  "in progress", "live", "first quarter", "second quarter",
  "third quarter", "fourth quarter", "half time", "overtime",
]);

function normalizeHighlightlyStatus(description) {
  const s = (description ?? "").toLowerCase().trim();
  if (HL_FINISHED.has(s)) return "finished";
  if (HL_SCHEDULED.has(s)) return "scheduled";
  if (HL_LIVE.has(s)) return "in_progress";
  return "unknown";
}

// UNVERIFIED score-order guess - see the "THE BIG ONE" note in the file
// header. Returns { home, away } or { home: null, away: null } if the
// string can't be parsed at all (fails loud via null rather than 0-0).
function parseHighlightlyScore(current) {
  if (typeof current !== "string") return { home: null, away: null };
  const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(current);
  if (!m) return { home: null, away: null };
  // GUESS: "home - away" order. Flip this if a real call shows otherwise.
  return { home: parseInt(m[1], 10), away: parseInt(m[2], 10) };
}

// Normalizes into the SAME shape parseBbsMatch() produces in
// bbs_client.js, so worker.js's dedup/merge/naming pipeline runs
// identically regardless of which of the three sources a game came from.
export function parseHighlightlyMatch(raw) {
  const status = normalizeHighlightlyStatus(raw.state?.description);
  const score = parseHighlightlyScore(raw.state?.score?.current);
  return {
    id: raw.id != null ? `highlightly:${raw.id}` : null,
    home_name_raw: raw.homeTeam?.displayName ?? raw.homeTeam?.name ?? null,
    away_name_raw: raw.awayTeam?.displayName ?? raw.awayTeam?.name ?? null,
    kickoff_utc: raw.date ?? raw.kickoff_utc ?? null,
    status,
    raw_status: raw.state?.description ?? null,
    home_score: score.home,
    away_score: score.away,
    period: raw.state?.period ?? null,
    clock: raw.state?.clock ?? null,
    possession: null, // not documented as present on this endpoint at all
  };
}
