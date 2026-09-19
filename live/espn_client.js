/**
 * PowerSwap Live Scores - ESPN (unofficial) client
 * =============================================================================
 *
 * NOT CURRENTLY USED BY worker.js. Tried as primary for about 15 minutes
 * on 2026-09-19 (explicit user call, as an immediate stopgap after BBS's
 * real dashboard turned out to cap the account at 500 req/day, not the
 * 2,000/day its own docs/account page had documented - see PROJECT_BIBLE.md
 * §6 and admin/BUILD_LOG.md for the full incident), then REVERTED the same
 * day: confirmed via `wrangler tail` against real production traffic that
 * this endpoint returns a deterministic 403 on EVERY tick when called from
 * a Cloudflare Worker specifically - not intermittent, and not a header
 * issue (a full browser User-Agent + Referer made no difference, still
 * 403 on every subsequent tick). The identical request succeeds fine from
 * a plain dev machine (all the "CONFIRMED" evidence below is real and
 * still accurate) - near-certain cause is ESPN's WAF blocking Cloudflare's
 * own egress IP range outright, which no client-side header change can
 * work around. worker.js currently calls BBS as primary again (its real
 * cadence corrected to the actual 500/day cap - see wrangler.toml).
 *
 * This file is kept, unmodified in its actual behavior, for a future
 * poller that runs from a non-Cloudflare origin (e.g. a GitHub Actions
 * workflow) - everything below is real, verified-working code, just not
 * reachable from this project's current Worker-based architecture.
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
 *   - `?dates=YYYYMMDD` (no dashes) confirmed real and working - used the
 *     same way as BBS's date param, including the identical late-kickoff
 *     UTC-crossover case needsYesterdayQuery() exists for: a real call for
 *     "yesterday" (2026-09-18) returned 3 games, one of which had its own
 *     `date` field already reading 2026-09-19 - confirming the same
 *     crossover BBS has, handled here the same way (reuses worker.js's
 *     existing includeYesterday gate, source-agnostic).
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

function espnDateString(daysOffset = 0) {
  return new Date(Date.now() + daysOffset * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
}

async function fetchScoreboardForDate(date) {
  const url = `${ESPN_BASE_URL}/scoreboard?dates=${date}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      Accept: "application/json",
      Referer: "https://www.espn.com/",
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
