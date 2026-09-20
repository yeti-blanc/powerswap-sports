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
 *   BBS_API_KEY         - required (primary AND secondary - both
 *                         /v1/stored/matches and /v1/matches are the same
 *                         vendor/account, see REDUNDANCY BUILD below)
 *   BBS_API_KEY_BACKUP  - unused by this (permanent) version; kept as a
 *                         Worker secret only in case a future same-day
 *                         stopgap needs it again
 *   CFBD_API_KEY        - optional, unused by this file (checked as a
 *                         candidate independent secondary 2026-09-12 -
 *                         see REDUNDANCY BUILD below - our tier doesn't
 *                         have access, so this stays unused for now)
 *   HIGHLIGHTLY_API_KEY - optional, tertiary. Not currently set (no key
 *                         exists for this project yet) - the tertiary
 *                         fallback is fully inert without it. See
 *                         highlightly_client.js before adding one.
 *
 * KV binding: LIVE_KV (see wrangler.toml). Single key: "live_payload".
 *
 * ARCHITECTURE (rewritten 2026-09-05, DUAL-CADENCE added 2026-09-20 - see
 * admin/BUILD_LOG.md for the full history): every cron tick fetches the
 * ranked-teams list, polls the source waterfall (REDUNDANCY BUILD below),
 * filters to ranked teams, writes to KV. Still no per-game kickoff-time-
 * driven polling FREQUENCY (that class of bug is explained below and is
 * specifically why DUAL-CADENCE's live/idle switch is keyed on OBSERVED
 * game status, not predicted kickoff times).
 *
 * Why request volume is a pure function of how often we poll, never of how
 * many games are live: every source's primary call (ESPN's /scoreboard,
 * BBS's /v1/stored/matches) is a flat "whole day's slate" request - one
 * call returns every game for that date/league regardless of how many
 * ranked teams are playing (confirmed: a single BBS call returned 34 games
 * at once on 2026-09-05).
 *
 * DUAL-CADENCE (2026-09-20, explicit user request for near-real-time
 * updates during live games): cron now fires every 1 minute (Cloudflare's
 * own minimum granularity - it cannot go below this), and
 * runScheduledTick() below decides EACH tick whether to run the cheap idle
 * path or the fast live path:
 *   - IDLE (no ranked-team game currently in_progress per the last known
 *     KV payload): only actually poll on every IDLE_TICK_INTERVAL_MINUTES-
 *     th tick, preserving the same ~6-minute-equivalent cadence and daily
 *     volume this Worker already used before this change.
 *   - LIVE: poll TWICE per 1-minute tick (LIVE_POLL_SUB_INTERVAL_MS apart,
 *     via a plain in-Worker sleep - Cron Triggers can't fire faster than
 *     1/minute, so hitting sub-minute cadence means stitching multiple
 *     polls inside one invocation) for an effective ~30s refresh.
 *   - An earlier 2026-09-05 same-day design also tried polling faster
 *     during live games, and was reverted - but for reasons DUAL-CADENCE
 *     doesn't share: that version judged "live" from BBS's own kickoff_utc
 *     field (sometimes a placeholder - unreliable), and even once fixed,
 *     made total daily volume depend on unpredictable how-many-hours-had-
 *     an-overlapping-game math. DUAL-CADENCE instead judges "live" from
 *     OBSERVED status on the last real poll (no kickoff-time prediction at
 *     all), and its volume is a deliberately bounded, precomputed budget
 *     (see wrangler.toml) sized against Workers KV's free-tier 1,000
 *     writes/day cap - not an open-ended function of the day's schedule.
 *   - Cold start (KV wiped/expired, previous.games empty) defaults to
 *     IDLE, not live - the opposite default from needsYesterdayQuery()
 *     below, deliberately: an unknown/empty state there is rare and
 *     resolves within one tick either way, but here it also covers the
 *     entire off-season (no rankings snapshot yet = permanently empty
 *     games array) - defaulting that to "assume live" would run the fast
 *     path 24/7 for the weeks before week 1, not just after a rare mid-game
 *     KV wipe. The rare real case (KV wiped mid-live-game) briefly
 *     degrades to idle cadence for at most one idle-interval's worth of
 *     ticks before self-correcting on the next successful poll.
 *
 * TODAY vs. YESTERDAY DECOUPLED (2026-09-12, same lesson as PFPI's
 * schedule/live-score split): "today"'s date is the real live-score need
 * and is fetched every poll. "yesterday"'s date only exists to catch a
 * late-kickoff game that's still not-finished after UTC midnight rolls
 * over - real maybe 4-5 hours a day, not 24. It used to be fetched
 * unconditionally every tick anyway, permanently doubling this endpoint's
 * cost for a need that's actually rare. needsYesterdayQuery() below gates
 * it on real KV state (any not-finished game with a yesterday kickoff?),
 * the same "self-limiting on state, not a fixed clock" idea PFPI used for
 * enrichLiveScores() - no interval to tune, and it naturally re-includes
 * yesterday on cold start (empty/expired KV) rather than risk missing one.
 * Worst case (a stuck "scheduled" game that never resolves) degrades to
 * the old always-both-dates behavior for at most that one calendar day,
 * never worse.
 *
 * See wrangler.toml for the full DUAL-CADENCE write-budget math, including
 * why the UTC day boundary (00:00 UTC = 8pm ET in-season) falling in the
 * middle of a real Saturday slate matters to the achievable live cadence.
 */

import { norm, resolveBbsTeamName } from "./team_norm.js";
import { fetchBbsMatches, fetchLegacyMatches, parseBbsMatch, utcDateString } from "./bbs_client.js";
import { fetchHighlightlyMatches, parseHighlightlyMatch } from "./highlightly_client.js";
import { fetchEspnMatches, parseEspnMatch } from "./espn_client.js";

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

// season_history.json's snapshots are keyed by the week each ranking
// GOVERNS, not the week whose games produced it (backtest.py labels the
// ranking produced by week N's results "week{N+1}" - see PROJECT_BIBLE.md
// §12) - so the latest snapshot's own week number IS the week that's
// actually being PLAYED right now (where live games and unranked
// opponents show up), no "+1" needed. Falls back to week 1 if the season
// has no real snapshot yet. Mirrors site/app.js's getLiveWeekKey().
export function getCurrentWeekNumber(seasonData) {
  const snapshots = seasonData?.snapshots ?? [];
  const realWeekNums = snapshots
    .map((s) => /^week(\d+)$/.exec(s.week || ""))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10));
  const latestRealWeek = realWeekNums.length ? Math.max(...realWeekNums) : null;
  return latestRealWeek !== null ? latestRealWeek : 1;
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
// Real incident 2026-09-12: needsYesterdayQuery() only queries yesterday
// when a not-yet-finished yesterday game is ALREADY visible in KV - it
// can't tell "yesterday's fully accounted for" apart from "we have zero
// memory of yesterday" (e.g. after a KV wipe - see this file's 2026-09-11
// outage comment: `/live` was observed returning completely empty
// `{games:[]}`, not stale, meaning the whole payload's TTL had lapsed).
// Real case: Miami's real 77-7 final over Florida A&M was captured
// correctly on 9/11, then lost in that wipe, then never re-fetched since
// - the gate had no unfinished-yesterday game to notice was missing, so
// it just kept skipping yesterday's date forever. Confirmed via a real
// call that BBS still had the finished record days later (still within
// its 2-day window). Fix: track the UTC date of the last successful
// yesterday-INCLUSIVE primary fetch here, and force yesterday back in at
// least once per UTC day regardless of what the gate above sees - closes
// the gap while still avoiding the old unconditional-every-tick cost.
const YESTERDAY_SWEEP_KEY = "yesterday_sweep_date";
// Must comfortably exceed the cron interval or the key expires between
// ticks and /live falls back to its empty default even though polling is
// working fine - confirmed happening in production with a too-short TTL
// during overnight testing on 2026-09-01. Still comfortably covers the
// IDLE path's effective ~6-minute gap between real polls after
// DUAL-CADENCE (2026-09-20, see ARCHITECTURE above) - LIVE-path polls are
// far more frequent than this TTL needs.
const KV_TTL_SECONDS = 600;

// DUAL-CADENCE tuning (2026-09-20, see ARCHITECTURE above and
// wrangler.toml for the write-budget math these two numbers are derived
// from - change them together, not independently, or the derived budget
// no longer holds):
//   - LIVE: cron fires every 1 minute; runScheduledTick() polls twice per
//     tick, this many ms apart, for an effective ~30s cadence.
//   - IDLE: only 1 in this many 1-minute ticks actually polls, preserving
//     the same ~6-minute-equivalent cadence/volume this Worker used before
//     DUAL-CADENCE.
const LIVE_POLL_SUB_INTERVAL_MS = 30 * 1000;
const IDLE_TICK_INTERVAL_MINUTES = 6;

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

// INCIDENT 2026-09-11 (see admin/BUILD_LOG.md): /v1/stored/matches started
// returning a consistent 500 for BOTH queried dates, on every cron tick,
// while an unauthenticated call and a call with a deliberately bad key
// both got clean 401s from BBS in the same window - so it's not our
// request shape. Briefly tried BBS_API_KEY_BACKUP as a stopgap; it got the
// IDENTICAL 500, which rules out an account-specific problem and points to
// a broader BBS-side outage on this endpoint - one their own status page
// (monitors only /health, showed "All systems Operational" throughout)
// doesn't catch. Reverted to the permanent primary key since the backup
// bought nothing; no code-side fix exists for this - the Worker's
// architecture already retries every 2 minutes with no manual
// intervention needed once BBS recovers.
const ACTIVE_BBS_KEY_ENV_VAR = "BBS_API_KEY";

// REDUNDANCY BUILD (2026-09-12, extended 2026-09-19 - see admin/BUILD_LOG.md
// for the full diagnostic history): the 2026-09-11/12 BBS /v1/stored/matches
// outage above exposed that this Worker had exactly one data source - a
// failure there meant zero live updates for hours, with no fallback. Four
// sources now exist, tried in order each tick until one succeeds:
//   1. PRIMARY:   ESPN unofficial scoreboard (fetchEspnMatches,
//      espn_client.js). Was tried as primary for ~15 minutes on 2026-09-19,
//      reverted the same day after a deterministic 403 on every tick from
//      this Worker's network - initially read as ESPN's WAF blocking
//      Cloudflare's egress IP range outright. CORRECTED later the same
//      day: it's a User-Agent WAF rule, not IP-based - isolated via
//      `wrangler dev --remote` (real Cloudflare edge) hitting the same
//      endpoint with different UAs and nothing else changed (curl/
//      python-requests UAs = real 200 with full data; the Chrome-style UA
//      this file was sending = 403, from the identical network). Fixed in
//      espn_client.js (UA now curl/8.14.1) and re-verified before being
//      wired back in here as primary - see espn_client.js's file header
//      for the full evidence trail. No published rate limit exists for
//      this endpoint, so it's deliberately NOT polled more aggressively
//      just because it's free - same fixed cron cadence as before (see
//      wrangler.toml).
//   2. SECONDARY: BBS /v1/stored/matches (fetchBbsMatches). Real account
//      cap confirmed 500/day 2026-09-19 (NOT the 2,000/day its own docs
//      claimed for a GitHub-linked account - see PROJECT_BIBLE.md §6 and
//      admin/BUILD_LOG.md's 2026-09-19 entry). Only hit when ESPN fails on
//      a tick, so its real daily volume is now well under that cap's old
//      worst-case math (see wrangler.toml, still sized to the standalone
//      worst case as a conservative floor).
//   3. TERTIARY:  BBS /v1/matches (fetchLegacyMatches) - verified live
//      2026-09-12 against a real in-progress game (see bbs_client.js's
//      SECONDARY SOURCE comment for the evidence). Same vendor/account as
//      #2 - CFBD's live scoreboard (/scoreboard, Tier 1+) and live
//      play-by-play (/live/plays, Tier 2+) were checked as a genuinely
//      independent alternative first, but both returned a real 401
//      "requires a Patreon subscription" against our existing (free-tier)
//      CFBD_API_KEY - confirmed via a direct call to CFBD's actual
//      OpenAPI-documented endpoints, not assumed from third-party docs.
//   4. QUATERNARY: Highlightly (fetchHighlightlyMatches) - only tried once
//      all three above fail on the SAME tick, and even then only inside
//      its own throttle (see maybeFetchHighlightly() below) so its 100
//      req/day free-tier cap can't be blown through by a long outage.
//      NOT LIVE-VERIFIED - see highlightly_client.js's file header for
//      why (no API key exists anywhere for this project as of this
//      build) and exactly what to check first once one is added. Stays
//      completely inert (this whole branch is skipped) until
//      HIGHLIGHTLY_API_KEY is set as a Worker secret.
//
// Team-name resolution and the gameIdentityKey()/STATUS_PRIORITY dedup
// below run identically regardless of which source produced this tick's
// rawMatches - each source's parser (parseEspnMatch / parseBbsMatch /
// parseHighlightlyMatch) normalizes into the same shape first, so nothing
// downstream needs to know or care which of the four actually answered.
const HIGHLIGHTLY_MIN_INTERVAL_MS = 10 * 60 * 1000; // ~1 poll/10min
const HIGHLIGHTLY_MAX_PER_ROLLING_DAY = 85; // of the free tier's 100/day - 15 held back as slack, see admin/BUILD_LOG.md
const HIGHLIGHTLY_LOG_KEY = "highlightly_poll_log";
const HIGHLIGHTLY_BACKOFF_KEY = "highlightly_backoff_until";

// Active window: 12:00 PM - 2:00 AM Eastern (wraps past midnight), per
// the handoff's poll-schedule instruction. Uses Intl against
// America/New_York so this stays correct across the EDT/EST transition
// without a manual offset table.
export function isHighlightlyActiveWindow(now) {
  const etHour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }).format(now),
    10
  );
  return etHour >= 12 || etHour < 2;
}

// Highlightly's own docs (pulled for this build) don't state whether the
// 100/day cap resets on a fixed calendar day or a rolling 24h window -
// unverified, no key to test against. Rather than guess, this tracks a
// ROLLING 24h count in KV, which is <= either interpretation's real cap
// (a calendar-day resetter would allow MORE bursts near midnight, never
// fewer) - safe under both. Also backs off early and independently if a
// real response's x-ratelimit-requests-remaining header ever comes back
// low, in case our own count and Highlightly's disagree for any reason.
async function maybeFetchHighlightly(env) {
  const apiKey = env.HIGHLIGHTLY_API_KEY;
  if (!apiKey) return null;

  const now = new Date();
  if (!isHighlightlyActiveWindow(now)) return null;

  const backoffRaw = await env.LIVE_KV.get(HIGHLIGHTLY_BACKOFF_KEY);
  if (backoffRaw && new Date(backoffRaw).getTime() > now.getTime()) return null;

  let log = [];
  try {
    const logRaw = await env.LIVE_KV.get(HIGHLIGHTLY_LOG_KEY);
    log = logRaw ? JSON.parse(logRaw) : [];
  } catch {
    log = [];
  }
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  log = log.filter((iso) => new Date(iso).getTime() > cutoff);

  if (log.length > 0) {
    const lastPollMs = new Date(log[log.length - 1]).getTime();
    if (now.getTime() - lastPollMs < HIGHLIGHTLY_MIN_INTERVAL_MS) return null;
  }
  if (log.length >= HIGHLIGHTLY_MAX_PER_ROLLING_DAY) return null;

  let result;
  try {
    result = await fetchHighlightlyMatches(apiKey);
  } catch (err) {
    console.error("Highlightly fetch failed:", err.message);
    log.push(now.toISOString());
    await env.LIVE_KV.put(HIGHLIGHTLY_LOG_KEY, JSON.stringify(log), { expirationTtl: 90000 });
    return null;
  }

  log.push(now.toISOString());
  await env.LIVE_KV.put(HIGHLIGHTLY_LOG_KEY, JSON.stringify(log), { expirationTtl: 90000 });

  if (result.rateLimitRemaining !== null && result.rateLimitRemaining <= 5) {
    await env.LIVE_KV.put(
      HIGHLIGHTLY_BACKOFF_KEY,
      new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      { expirationTtl: 3600 }
    );
  }

  return result.matches;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };

    if (url.pathname === "/live") {
      // `data_source` (bbs_stored/bbs_legacy/highlightly) stays in the KV
      // payload for internal debugging (visible via `wrangler tail` /
      // direct KV inspection) but is stripped here - this is the exact
      // URL the public site's own JS fetches directly (Bird Feeder: no
      // backend proxy), so anything left in this response is visible to
      // any visitor via devtools or a plain curl, not just "not rendered
      // on the page." See admin/BUILD_LOG.md for why this was added.
      const cached = await env.LIVE_KV.get(LIVE_KV_KEY);
      const payload = cached ? JSON.parse(cached) : { updated_at: null, games: [] };
      const publicPayload = {
        ...payload,
        games: payload.games.map(({ data_source, ...rest }) => rest),
      };
      return new Response(JSON.stringify(publicPayload), { headers: corsHeaders });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledTick(event, env));
  },
};

// DUAL-CADENCE entry point (2026-09-20, see file-header ARCHITECTURE
// comment for the full reasoning) - decides once per 1-minute cron tick
// whether this tick runs the cheap IDLE path or the fast LIVE path, then
// drives pollAndCache() accordingly. This is the ONLY place that decides
// cadence; pollAndCache() itself has no knowledge of live/idle mode.
async function runScheduledTick(event, env) {
  const live = await isLiveWindow(env);

  if (!live) {
    // Only 1 in IDLE_TICK_INTERVAL_MINUTES ticks actually polls - see that
    // constant's comment for why this preserves the pre-DUAL-CADENCE
    // volume even though cron now fires every 1 minute instead of every 6.
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    if (minute % IDLE_TICK_INTERVAL_MINUTES !== 0) return;
    await pollAndCache(env);
    return;
  }

  // LIVE: two polls stitched into this one 1-minute invocation - see
  // LIVE_POLL_SUB_INTERVAL_MS's comment. Each call independently runs the
  // full source waterfall and handles its own failure (leaves KV
  // untouched) - a failure on the first poll doesn't skip the second.
  await pollAndCache(env);
  await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_SUB_INTERVAL_MS));
  await pollAndCache(env);
}

// Judges "live" from the LAST REAL POLL's observed status only - never
// from a predicted/kickoff-time schedule (see ARCHITECTURE above for why
// that distinction is deliberate). Cold start (KV wiped/expired, or the
// entire off-season before any rankings snapshot exists) defaults to
// false/IDLE - the opposite default from needsYesterdayQuery() below,
// deliberately: see ARCHITECTURE's DUAL-CADENCE section for why erring
// toward idle is correct here even though that other function errs
// toward inclusion for a similarly "unknown" state.
async function isLiveWindow(env) {
  const previous = await getPreviousPayload(env);
  if (!previous.games || previous.games.length === 0) return false;
  return previous.games.some((g) => g.status === "in_progress");
}

async function pollAndCache(env) {
  const seasonData = await getSeasonData(env);
  const rankedTeams = getCurrentRankedTeams(seasonData);
  if (rankedTeams.length === 0) {
    // Bug fixed 2026-09-20: this used to unconditionally overwrite
    // LIVE_KV_KEY with an empty `games: []`, bypassing mergeGames()
    // entirely - the ONLY write in this file that didn't go through the
    // permanent-retention merge (§7 of PROJECT_BIBLE.md). getSeasonData()
    // returns null/[] not just for the genuine off-season (no
    // season_history.json published yet) but for ANY transient failure
    // fetching it from GitHub's raw CDN - a real blip there was enough to
    // instantly wipe every permanently-retained finished game (confirmed
    // real: Thursday/Friday's Miami-Wake Forest and Texas Tech-Houston
    // finals both vanished this way, along with older retained history,
    // between two consecutive polls with nothing else explaining it).
    // Fixed to match every other failure path in this file (see "All
    // live-score sources failed" below): just leave the last-known KV
    // payload alone. /live's own handler already returns a safe empty
    // default when no KV entry exists at all, so this write was never
    // actually needed for a genuine cold start either.
    console.error("No ranked teams this tick (season_history.json fetch failed or off-season) - keeping last-known KV payload");
    return;
  }

  // Fetched once, up front, so both the includeYesterday decision below and
  // the final mergeGames() call read the exact same snapshot (previously
  // this was fetched a second time later, purely for the merge).
  const previous = await getPreviousPayload(env);
  const today = utcDateString(0);
  const lastSweepDate = await env.LIVE_KV.get(YESTERDAY_SWEEP_KEY);
  // See YESTERDAY_SWEEP_KEY's comment above: force yesterday in at least
  // once per UTC day even if the gate above sees no reason to, so a game
  // lost to a past KV wipe (or any other gap) gets one guaranteed chance
  // per day to be rediscovered from BBS's still-live 2-day window.
  const includeYesterday = needsYesterdayQuery(previous.games) || lastSweepDate !== today;

  // Tried in order until one succeeds - see the REDUNDANCY BUILD comment
  // above for why each exists and what's confirmed vs. not about each.
  let rawMatches = null;
  let parseMatch = null;
  let dataSource = null;
  // Only ESPN and BBS-stored actually query by date (includeYesterday) -
  // the legacy/Highlightly fallbacks don't respect date-scoping, so a
  // sweep marked done off one of those wouldn't really mean yesterday was
  // covered. Tracked here instead of duplicated per-branch below.
  let respectsDateScoping = false;

  try {
    rawMatches = await fetchEspnMatches(includeYesterday);
    parseMatch = parseEspnMatch;
    dataSource = "espn";
    respectsDateScoping = true;
  } catch (err) {
    console.error("ESPN primary fetch failed:", err.message);
  }

  if (!rawMatches) {
    try {
      rawMatches = await fetchBbsMatches(env[ACTIVE_BBS_KEY_ENV_VAR], includeYesterday);
      parseMatch = parseBbsMatch;
      dataSource = "bbs_stored";
      respectsDateScoping = true;
      console.warn("ESPN primary down this tick - used BBS stored/matches secondary instead");
    } catch (err) {
      console.error("BBS secondary (stored/matches) fetch failed:", err.message);
    }
  }

  if (!rawMatches) {
    try {
      rawMatches = await fetchLegacyMatches(env[ACTIVE_BBS_KEY_ENV_VAR]);
      parseMatch = parseBbsMatch; // same response shape, see bbs_client.js
      dataSource = "bbs_legacy";
      console.warn("ESPN and BBS stored both down this tick - used BBS /v1/matches tertiary instead");
    } catch (err) {
      console.error("BBS tertiary (v1/matches) fetch also failed:", err.message);
    }
  }

  if (!rawMatches) {
    const hlMatches = await maybeFetchHighlightly(env);
    if (hlMatches) {
      rawMatches = hlMatches;
      parseMatch = parseHighlightlyMatch;
      dataSource = "highlightly";
      console.warn("ESPN and both BBS sources down this tick - used Highlightly quaternary instead");
    }
  }

  if (!rawMatches) {
    // No special 429/outage handling beyond the fallback chain above: a
    // fixed poll interval is already sized to stay well under any single
    // source's daily cap regardless of game count, so a failure across
    // all four just means this tick's poll didn't refresh - /live keeps
    // serving its last-known payload from KV (see the fetch handler
    // above) and the next tick, a couple of minutes later, tries again.
    console.error("All live-score sources failed this tick; keeping last-known KV payload");
    return;
  }

  // Only mark the sweep done when yesterday was ACTUALLY included and a
  // date-scoped source succeeded - if a non-date-scoped fallback saved
  // this tick instead, we don't know yesterday was really covered; leave
  // the marker stale so the next successful date-scoped tick retries it.
  if (respectsDateScoping && includeYesterday) {
    await env.LIVE_KV.put(YESTERDAY_SWEEP_KEY, today);
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
    // parseMatch() normalizes whichever source answered this tick into a
    // common {home_name_raw, away_name_raw, ...} shape first (see
    // bbs_client.js / highlightly_client.js), so team-name resolution
    // below is source-agnostic - it never reads BBS's raw.home?.name
    // shape directly.
    const parsed = parseMatch(raw);
    const homeCanonical = resolveBbsTeamName(parsed.home_name_raw, rankedTeams);
    const awayCanonical = resolveBbsTeamName(parsed.away_name_raw, rankedTeams);
    if (!homeCanonical && !awayCanonical) continue;

    const game = {
      id: parsed.id,
      data_source: dataSource,
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
      home_team: homeCanonical ?? currentWeekOpponents.get(awayCanonical) ?? norm(parsed.home_name_raw ?? ""),
      away_team: awayCanonical ?? currentWeekOpponents.get(homeCanonical) ?? norm(parsed.away_name_raw ?? ""),
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

  const mergedGames = mergeGames(freshGames, previous.games, rankedSet);

  await env.LIVE_KV.put(
    LIVE_KV_KEY,
    JSON.stringify({ updated_at: new Date().toISOString(), games: mergedGames }),
    { expirationTtl: KV_TTL_SECONDS }
  );
}

// Self-limiting gate for fetchBbsMatches()'s "yesterday" query - see the
// TODAY vs. YESTERDAY DECOUPLED comment above. Empty/missing previous
// payload (cold start, or KV expired past KV_TTL_SECONDS) errs toward
// including yesterday rather than risk silently dropping a real
// still-in-progress crossover game. `kickoff_utc` here is only ever used
// to pick a date RANGE to query, never to judge live/imminent status for
// polling frequency (that's the exact class of bug the 2026-09-05
// rewrite removed - see this file's header) - a wrong placeholder value
// at worst costs one wasted request, never a missed live game.
export function needsYesterdayQuery(previousGames) {
  if (!previousGames || previousGames.length === 0) return true;
  const yesterday = utcDateString(-1);
  return previousGames.some(
    (g) => g.status !== "finished" && g.kickoff_utc && g.kickoff_utc.slice(0, 10) === yesterday
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
