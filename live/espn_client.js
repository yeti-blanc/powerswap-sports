/**
 * PowerSwap Live Scores - ESPN (unofficial) client
 * =============================================================================
 *
 * PRIMARY as of 2026-09-19 (worker.js's REDUNDANCY BUILD comment has the
 * current full hierarchy). First tried as primary for about 15 minutes
 * that same day (explicit user call, as an immediate stopgap after BBS's
 * real dashboard turned out to cap the account at 500 req/day, not the
 * 2,000/day its own docs/account page had documented - see PROJECT_BIBLE.md
 * §6 and admin/BUILD_LOG.md for the full incident), then REVERTED after
 * `wrangler tail` showed a deterministic 403 on every tick from a
 * Cloudflare Worker. At the time this was read as an IP-range block
 * (Cloudflare's egress specifically), since the only header combo tried
 * was a full Chrome User-Agent + Referer and it still 403'd.
 *
 * CORRECTED later the same day: it's a User-Agent WAF rule, not IP-based.
 * Isolated via `wrangler dev --remote` (real Cloudflare edge, not a
 * simulation) hitting this exact endpoint with different UAs and nothing
 * else changed - `curl/8.14.1` and `python-requests/2.31.0` both return a
 * real 200 with full scoreboard data from Cloudflare's network; a Chrome-
 * style UA (what this file was using) returns 403 from that same network.
 * The earlier "CONFIRMED...still accurate" 403 was this file's own
 * browser-UA header choice being one of the blocked strings, not evidence
 * of an IP block - fetchScoreboardForDate()'s UA below is now curl/8.14.1
 * accordingly, re-verified working, and wired back into worker.js as
 * primary the same day. (For reference: the same UA fix did NOT clear a
 * 403 from Google Apps Script's UrlFetchApp, tested the same day - that
 * origin's block is unresolved and unrelated to this one.)
 *
 * THIS IS UNOFFICIAL/UNDOCUMENTED. ESPN does not publish this as a public
 * API: no ToS, no published rate limit, no SLA, no support channel, and it
 * could change shape or start blocking requests with zero notice.
 *
 * CONFIRMED with real calls, 2026-09-19, live NCAAF Saturday (7 ranked-team
 * games in progress at check time - Rutgers/USC, Louisville/SMU, Utah/Utah
 * State, Michigan/UTEP, Texas A&M/Kentucky, Indiana/Western Kentucky,
 * Iowa/Northern Iowa):
 *   - No auth needed at all - a plain unauthenticated GET returns a real
 *     200 with real live data.
 *   - `GET {ESPN_BASE_URL}/scoreboard` (no params) returns today's whole
 *     slate in one call - 22 real games seen, all conferences mixed,
 *     regardless of how many are ranked-team games. Same "flat, request-
 *     count-independent-of-game-count" shape as BBS's /v1/stored/matches,
 *     so this Worker's existing flat-poll-per-tick architecture drops in
 *     with no redesign.
 *   - `?dates=YYYYMMDD` (no dashes) confirmed real and working. A real
 *     call for 2026-09-18 returned a game whose `date` read 2026-09-19 -
 *     originally misread as the same UTC crossover BBS has. CORRECTED
 *     2026-09-25: it's because ESPN buckets by US EASTERN date, not UTC
 *     (that game kicked off Friday evening ET). Querying by UTC date
 *     dropped every 8pm-ET-or-later game from "today" - see
 *     easternDateOf() below for the real incident and the fix.
 *   - `status.type.state` confirmed real values: "pre" (scheduled), "in"
 *     (live), "post" (finished). Any other value (postponed/canceled -
 *     not observed live) surfaces as "unknown" via raw_status rather than
 *     being guessed at, same convention as bbs_client.js/highlightly_client.js.
 *   - `status.displayClock` (e.g. "13:55") is REAL and POPULATED, plus a
 *     human-readable `status.type.detail` (e.g. "13:55 - 2nd Quarter") -
 *     BBS never had a clock field at all (confirmed absent, see
 *     bbs_client.js). `status.period` is a plain integer - no
 *     linescore-length inference needed like BBS required.
 *   - Team names (`team.displayName`) are already "School Mascot" format
 *     confirmed identical to BBS/Highlightly's convention (e.g. "Rutgers
 *     Scarlet Knights", "Arkansas Razorbacks", "Georgia Bulldogs") -
 *     resolveBbsTeamName()/norm() work completely unchanged, zero new
 *     NORM entries needed.
 *   - `situation.possession` (a team id string, e.g. "2567") is real and
 *     present on live games - more than BBS ever exposed - but not
 *     resolved to home/away here since nothing downstream consumes it yet
 *     (passed through raw, no-cost bonus in case that changes).
 *   - Per-quarter `linescores` (array of `{value, displayValue, period}`)
 *     are present but NOT used below - `status.period`/`displayClock`
 *     already give everything site/app.js's formatPeriodLabel()/live-badge
 *     rendering needs, so this parser doesn't bother re-deriving period
 *     from linescore length the way parseBbsMatch() has to.
 *
 * UNVERIFIED - flagging rather than guessing, per this repo's standing rule:
 *   - No published rate limit exists to design a "provable daily budget"
 *     around, unlike every other source in this file - deliberately NOT
 *     polled more aggressively just because it's free (see wrangler.toml);
 *     being a considerate, low-volume consumer of an unofficial endpoint
 *     matters more here than for a metered/paid API.
 *   - Behavior for a postponed/canceled/suspended game - not observed in
 *     the real pull (only pre/in/post seen).
 */

export const ESPN_BASE_URL =
  "https://site.api.espn.com/apis/site/v2/sports/football/college-football";

// Bug fixed 2026-09-25 (real incident): ESPN's `?dates=` buckets games by
// US EASTERN calendar date, NOT UTC - confirmed via real calls: Friday
// 2026-09-25's Northwestern @ Indiana (kickoff 2026-09-26T00:00Z, 8pm ET)
// is returned ONLY by dates=20260925, never by dates=20260926. This file
// used to build the date from UTC (the BBS convention), so from 8pm ET
// onward every night "today" already meant tomorrow's slate, and every
// 8pm-ET-or-later kickoff silently froze at whatever state the once-a-day
// yesterday sweep last caught it in (Indiana sat at "scheduled, 0-0" in
// /live while ESPN had it live at 12-0). Every ESPN-side date - the query
// param and worker.js's yesterday gate - must use these helpers, never
// utcDateString(). Pacific-vs-Eastern couldn't be distinguished
// empirically yet (no 2026 game has kicked off 04:00-07:00Z so far) -
// Eastern is ESPN's standard convention and matches every boundary seen.
const ESPN_TIME_ZONE = "America/New_York";
const easternFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: ESPN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// YYYY-MM-DD in Eastern time for an ISO timestamp (e.g. a game's kickoff_utc).
export function easternDateOf(iso) {
  return easternFormatter.format(new Date(iso));
}

// YYYY-MM-DD in Eastern time, offset by whole CALENDAR days. Offsets from
// Eastern's own date rather than subtracting 24h from now, so a DST
// transition day (23 or 25 hours long) can't make "yesterday" equal today.
export function easternDateString(daysOffset = 0) {
  const today = new Date(`${easternDateOf(Date.now())}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() + daysOffset);
  return today.toISOString().slice(0, 10);
}

function espnDateString(daysOffset = 0) {
  return easternDateString(daysOffset).replace(/-/g, "");
}

async function fetchScoreboardForDate(date) {
  const url = `${ESPN_BASE_URL}/scoreboard?dates=${date}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "curl/8.14.1",
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const err = new Error(`ESPN /scoreboard (dates=${date}) returned ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  const body = await resp.json();
  return body.events ?? [];
}

// Same "loop dates, dedupe by id, only throw if every date failed" shape
// as bbs_client.js's fetchBbsMatches() - see that file for why (a single
// bad date shouldn't sink an otherwise-good fetch of the other date).
export async function fetchEspnMatches(includeYesterday = true) {
  const dates = includeYesterday
    ? [espnDateString(0), espnDateString(-1)]
    : [espnDateString(0)];
  const byId = new Map();
  let lastError = null;

  for (const date of dates) {
    try {
      for (const e of await fetchScoreboardForDate(date)) {
        byId.set(e.id, e);
      }
    } catch (err) {
      console.error(err.message);
      lastError = err;
    }
  }

  if (byId.size === 0 && lastError) throw lastError;
  return [...byId.values()];
}

function normalizeEspnStatus(state) {
  const s = (state ?? "").toLowerCase();
  if (s === "post") return "finished";
  if (s === "pre") return "scheduled";
  if (s === "in") return "in_progress";
  return "unknown"; // deliberately not guessed further - surfaces via raw_status
}

// Normalizes into the SAME shape parseBbsMatch()/parseHighlightlyMatch()
// produce, so worker.js's dedup/merge/naming pipeline runs identically
// regardless of which of the four sources answered this tick.
export function parseEspnMatch(event) {
  const comp = event.competitions?.[0];
  const competitors = comp?.competitors ?? [];
  const home = competitors.find((c) => c.homeAway === "home");
  const away = competitors.find((c) => c.homeAway === "away");
  const statusType = comp?.status?.type;
  const status = normalizeEspnStatus(statusType?.state);

  return {
    id: event.id != null ? `espn:${event.id}` : null,
    home_name_raw: home?.team?.displayName ?? null,
    away_name_raw: away?.team?.displayName ?? null,
    kickoff_utc: comp?.date ?? event.date ?? null,
    status,
    raw_status: statusType?.description ?? statusType?.name ?? null,
    home_score: home?.score != null ? parseInt(home.score, 10) : null,
    away_score: away?.score != null ? parseInt(away.score, 10) : null,
    period: comp?.status?.period ?? null,
    clock: comp?.status?.displayClock ?? null,
    possession: comp?.situation?.possession ?? null,
  };
}
