/**
 * PowerSwap Live Scores - Highlightly (tertiary source) client
 * ===============================================================
 *
 * STATUS AS OF 2026-09-12: implemented but NOT LIVE-VERIFIED. There is no
 * HIGHLIGHTLY_API_KEY anywhere in this repo, in either Worker's Cloudflare
 * secrets (`wrangler secret list` checked for both `powerswap-live-scores`
 * and the admin worker), in `.env`, or in any OS environment variable -
 * despite the handoff brief for this build asserting one already existed.
 * `sports/cfb/havoc_rating.py` independently corroborates this from an
 * earlier session ("Highlightly's docs show no injuries endpoint on any
 * plan, not independently verified live - no key available").
 *
 * Because of that, this file is built from Highlightly's own real
 * documentation (https://highlightly.net/nfl-api/documentation/ and
 * /sport-api/documentation/ - NOT the third-party/marketing summaries the
 * handoff brief warned against), but the "real test call" half of
 * verification could not be done - no live request has ever actually
 * been sent. Treat every UNVERIFIED note below as a real risk, not
 * boilerplate caution: worker.js only calls this file when BOTH the BBS
 * primary and secondary have failed, i.e. exactly the moment a wrong
 * answer here is most likely to be trusted at face value. Before this
 * path is allowed to publish a score to real users, get a real key
 * (`wrangler secret put HIGHLIGHTLY_API_KEY` in live/), then run this
 * against at least one real in-progress NCAA FBS game and fix whatever
 * this file guessed wrong - starting with the score-string order below,
 * which is the one guess that fails silently (wrong-looking-plausible)
 * rather than loudly if it's backwards.
 *
 * CONFIRMED from Highlightly's own docs (not a real call):
 *   - Base URL: https://american-football.highlightly.net
 *   - Auth header: `x-rapidapi-key: <key>` - their own docs state this is
 *     the header to use even calling the API directly (not just via the
 *     RapidAPI marketplace). UNVERIFIED against a real response: it would
 *     not be the first vendor whose docs are stale about this.
 *   - Endpoint: GET /matches, filtered by `leagueName=NCAA` and
 *     `date=YYYY-MM-DD`.
 *   - Response carries `x-ratelimit-requests-limit` and
 *     `x-ratelimit-requests-remaining` headers - see worker.js's
 *     Highlightly throttle, which reads these defensively alongside its
 *     own KV-tracked rolling count rather than trusting either alone.
 *
 * UNVERIFIED (no real response ever seen):
 *   - Whether `leagueName=NCAA` is really the right param (vs `league=`,
 *     seen used for NFL in the same docs) for filtering to NCAA FBS.
 *   - `homeTeam`/`awayTeam.displayName` naming convention for NCAA teams
 *     specifically - the one real example pulled was NFL ("New Orleans
 *     Saints", city+mascot). If NCAA's displayName is "School Mascot"
 *     like BBS's, resolveBbsTeamName() below works unchanged; if it's
 *     school-only (already matching season_history.json), it works too
 *     but takes the exact-match branch instead of the prefix branch.
 *     Either way should resolve correctly - NOT verified live.
 *   - THE BIG ONE: `score.current` is documented as a combined string
 *     ("21 - 7"), not separate home/away integers like BBS. Which side
 *     of the " - " is home and which is away is NOT stated anywhere in
 *     the docs pulled for this file - parseHighlightlyMatch() below
 *     guesses "home - away" (matching the away-then-home JSON key order
 *     seen in the one real example) but this is exactly the kind of
 *     guess that produces a confidently-wrong score instead of an
 *     obviously-broken one. VERIFY THIS FIRST against a real response,
 *     ideally a real blowout where the two numbers are easy to tell
 *     apart by eye.
 *   - The exact status/description vocabulary for American football
 *     specifically (docs examples mixed a soccer-shaped example with an
 *     American-football one; "In progress" and "Final" both appeared in
 *     the football-specific pull, but the full enum wasn't).
 *   - Whether this endpoint has the same duplicate-row problem as BBS's
 *     two endpoints. Assume yes until proven otherwise - mergeGames()'s
 *     identity/priority logic in worker.js applies regardless of source,
 *     so this isn't a blocker, just an open question.
 *
 * Rate limit: Basic/free tier is documented as 100 requests/day, but the
 * docs pulled for this file do NOT state whether that resets on a fixed
 * calendar day or a rolling 24h window. worker.js's throttle is built to
 * be correct under EITHER interpretation (see HIGHLIGHTLY_MAX_PER_DAY in
 * worker.js) rather than guessing - it tracks a rolling 24h count in KV
 * (always <= either a calendar or rolling cap) and additionally backs
 * off early if the live x-ratelimit-requests-remaining header ever comes
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
  const url = `${HIGHLIGHTLY_BASE_URL}/matches?leagueName=NCAA&date=${date}`;
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
