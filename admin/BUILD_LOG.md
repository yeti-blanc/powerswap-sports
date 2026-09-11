# Admin Portal — Build Log

## Current status (2026-09-04, session in progress)

**Built, deployed, and fully verified - including the one flow that
needed the user.** Login, session persistence across a real refresh,
the Havoc digest, Recompute through the real GitHub Actions dispatch
with the Worker's own token, versioned snapshots, logout/revocation,
and now the real reset-password email link end-to-end - all confirmed
with real evidence, in a real browser where applicable. See the log
below for exactly what was checked and how.

Temp password was set at the user's request (`Delta-Falcon-4987!`, now
superseded). The user has since used the real emailed reset link
themselves and confirmed their real password is in place -
`password_hash_override` existing in KV corroborates this independently
(this session did not choose or see the new password). `ADMIN_EMAIL`
ended up needing to be `yeti@yetiblanc.com`, not the address originally
defaulted to - Resend's free tier can only send to the account's own
verified address without a verified sending domain, which a real 403
response made concrete rather than theoretical.

A username field was added to the login form after the fact, at the
user's request, purely so browsers reliably offer to save/autofill the
credentials - see the log below.

Architecture reference: PFPI's single-admin-portal playbook (pasted into
chat 2026-09-04), simplified for one login instead of PFPI's two-tier
admin/commissioner split. Key decisions carried over verbatim:
- PBKDF2 (100k iterations, SHA-256) via Web Crypto, password hash stored
  as a Cloudflare Secret, never committed.
- HMAC-signed session token, session record centrally revocable in KV.
- Per-IP progressive-delay rate limiting on login (not a hard lockout).
- Signed, single-use, 30-min password reset link via email (Resend).
- Digest snapshots are versioned, never overwritten - Recompute adds a
  new version, original stays intact.

One deliberate deviation from a literal reading of the task, decided with
the user in chat rather than guessed: "Recompute re-runs the existing
havoc_rating.py pipeline" is taken literally - the Worker CANNOT execute
Python directly, so Recompute dispatches a GitHub Actions workflow that
runs the real `fetch_lines.py` + `havoc_rating.py` and commits the result,
rather than reimplementing the scoring math in JS. This keeps the scoring
logic in exactly one place. Tradeoff: Recompute takes ~30-60s (a real
CI run), not instant.

## Log

- 2026-09-04: Started build. Wrote this log, `admin/` scaffold planned:
  `worker.js`, `wrangler.toml`, `tools/hash_password.mjs` (local-only
  helper, never deployed), `.github/workflows/recompute-havoc.yml`,
  `site/admin.html`.
- 2026-09-04: Wrote `havoc_rating.py`'s enrichment (raw ranks +
  weighted_contributions), needed for real digest bullets. Regenerated
  and committed real 2026 week 1 output against it (`4f3c749`).
- 2026-09-04: Wrote `admin/worker.js`. Caught two real bugs before
  deploy: a stray `#` instead of `//` in a comment (syntax error), and
  `moneyline_closeness`'s bullet function destructuring the wrong field
  names (`home`/`away` instead of `avg_home_implied_prob`/
  `avg_away_implied_prob`) - the latter found by actually running
  `buildBullets()` against the real committed JSON and noticing SMU vs
  Florida State only produced 2 bullets instead of 3. Fixed both,
  re-verified against real data.
- 2026-09-04: Unit-tested the crypto primitives standalone in Node
  (PBKDF2 hash/verify round-trip, HMAC sign/verify, tamper rejection,
  wrong-key rejection) - all correct. Same `crypto.subtle` calls the
  deployed Worker uses.
- 2026-09-04: Created `ADMIN_KV` namespace, generated and set
  `SESSION_HMAC_KEY` (a random internal signing key - not an external
  credential, nothing to invent), added `CFBD_API_KEY` as a GitHub
  Actions repo secret (propagating a credential this session already
  had access to into a new authorized location, not inventing one).
  Deployed `admin/worker.js` as `powerswap-admin`
  (https://powerswap-admin.yeti-f3c.workers.dev).
- 2026-09-04: Real evidence collected:
  - `POST /api/login` with a wrong password: real 401, no crash, even
    with `ADMIN_PASSWORD_HASH` unset (falls through cleanly).
  - Progressive rate-limit delay is real, not simulated: 3 consecutive
    failed attempts measured at ~2.4s, ~4.3s, ~6.3s - confirmed by
    reading the actual `ratelimit:{ip}` KV record afterward
    (`{"fail_count":4}`, real IP, real TTL).
  - Triggered `.github/workflows/recompute-havoc.yml` for real (`gh
    workflow run`, own credentials, independent of the Worker's own
    dispatch code) for season=2026 week=1. Ran clean end-to-end in 16s:
    fetched real CFBD lines, computed ratings, wrote the marker, and
    pushed a real commit (`ac78bf9`) - confirmed by reading it back from
    `origin/main` and fetching the marker file's real timestamp from
    raw.githubusercontent.com. This proves the recompute PIPELINE works;
    it does not yet prove the Worker's OWN dispatch code path works,
    since that needs `GITHUB_TOKEN` (not set yet - see below).
- 2026-09-04: User set a temp password (generated here, matching format),
  provided their existing Resend API key, and had already set
  `GITHUB_TOKEN` themselves. Set `ADMIN_PASSWORD_HASH`, `RESEND_API_KEY`,
  `ADMIN_EMAIL` (defaulted to the user's general email - wrong, see
  below).
- 2026-09-04: Real login via curl succeeded on the first try with the
  temp password. Verified the session both via `GET /api/session` and by
  reading the actual `session:{token}` KV record directly.
- 2026-09-04: `/api/forgot-password` initially failed silently from the
  caller's point of view (deliberately vague response) - `wrangler tail`
  caught the real reason: Resend returned a 403, because its free tier
  without a verified sending domain can only deliver to the account's
  own verified address, which is `yeti@yetiblanc.com` - not the address
  `ADMIN_EMAIL` had defaulted to. Fixed `ADMIN_EMAIL`, retried, no error
  in the tail this time. Could not complete the actual link-click ->
  reset flow - no access to that inbox - so this specific step needs the
  user.
- 2026-09-04: Found and fixed a cosmetic bug via real output, not
  inspection: `Over/under set at 61.166666666666664` (unrounded float)
  in a real digest bullet. Fixed in `worker.js`, redeployed, cleared the
  buggy v1 KV snapshot (created during testing, nothing downstream
  depended on it yet) so it regenerated clean rather than shipping a
  "fix" that needed its own recompute-version bump.
- 2026-09-04: Full real-browser pass on the deployed page
  (yetiblanc.com/powerswap-sports/site/admin.html):
  - Logged in for real with the temp password - dashboard rendered with
    real digest data (25 games, correctly sorted, real bullets).
  - Reloaded the page (real navigation, not a SPA route change) -
    stayed logged in, no re-prompt. This is the exact bug the playbook
    flagged from PFPI's own history (session only in a JS variable) -
    confirmed NOT present here.
  - Clicked Recompute in the actual UI (not my earlier `gh workflow run`
    test) - confirmed via `gh run list` that this dispatched a real,
    separate GitHub Actions run at the exact time of the click, using
    the Worker's own `GITHUB_TOKEN`. Watched it complete, watched the
    page's own polling pick it up and show "Done - v2" with a changed
    rating (Washington State @ Washington: 32.9 -> 33, real line
    movement). Confirmed v1 was untouched in KV afterward - the
    versioning/audit-trail requirement is real, not asserted.
  - "Copy Digest as HTML": the actual `navigator.clipboard` interaction
    hung under browser automation (a permission-prompt-related stall,
    not a page freeze - other clicks worked fine afterward) - didn't
    force it per the "don't fight automation dialogs" guidance. Verified
    the generation logic directly instead, against the real v2 digest:
    genuinely self-contained HTML (inline `style=`, real `<br>` tags, no
    `<style>`/`<link>` dependency) - the actual requirement from the
    playbook's own PFPI bug story. The one thing NOT independently
    confirmed is the literal OS clipboard write succeeding in a real,
    non-automated browser session.
  - Logged out - confirmed the browser's own session KV record was
    deleted (real server-side revocation, not just a client-side
    redirect), while my unrelated earlier curl-test session token was
    correctly left untouched.
  - Negative tests: a fabricated reset token was correctly rejected
    (`"Reset link is invalid, expired, or already used"`); the
    `ratelimit:{ip}` KV record was confirmed gone after a successful
    login (failure count resets on success, per design).
- 2026-09-04: Cleaned up test KV entries (stale session token) created
  during this testing pass.
- 2026-09-04: Added a username field to the login form
  (`site/admin.html`), at the user's request, so their browser reliably
  offers to save/autofill the login. Restructured the login markup into
  a real `<form>` with a `submit` event handler - browsers key off actual
  form submission (not a bare button-click JS handler) to decide whether
  to offer credential saving. The username value is cosmetic only: not
  sent to or checked by the API, since there's exactly one password and
  no multi-user concept here. Tested locally first (Enter-to-submit
  fires correctly, error handling intact), then pushed and confirmed
  live.
- 2026-09-04: While testing the username field with the (by-then-stale)
  temp password, got a real "Incorrect password" - checked
  `password_hash_override` in KV and found it now populated, meaning the
  user had already clicked the real emailed reset link and set a real
  password on their own. **User then explicitly confirmed in chat**
  ("it works... i already updated the PW") that login with their own
  password succeeds. This closes the one flow this session couldn't
  complete itself (no access to the inbox the reset link was sent to) -
  the full self-service password-reset path (request -> real email ->
  real link -> new password -> real login) is now confirmed working
  end-to-end, by the user, for real, not inferred.

## Open items

None outstanding. Everything in the original task list has been built,
deployed, and verified with real evidence (the user's own confirmation,
in the reset-password case).

---

## 2026-09-05: live-scores Worker — BBS quota incident (subpoll false-triggering on placeholder kickoff times)

Unrelated to the admin portal above - logged here since it's the repo's
active build log. `live/worker.js` (the `powerswap-live-scores` Worker,
see `live/README.md`) triggered a real BBS usage warning this morning:
1,602 of 2,000 daily requests used by 6:45 AM, well before any real Week 1
game had kicked off.

**Diagnosis, from real telemetry, not code inspection:**
- Pulled `powerswap-live-scores`'s own subrequest counts from Cloudflare's
  GraphQL Analytics API (`workersInvocationsAdaptive`, real account data,
  not simulated): 2,421 total subrequests today through ~15:00 UTC. Each
  `pollAndCache()` call makes 3 (1 GitHub ranked-teams fetch + 2 BBS
  `/v1/stored/matches` calls, today + yesterday UTC date). BBS-specific
  share: 2,421 x 2/3 ~= 1,614 - within ~1% of BBS's own reported 1,602.
- Hour 03:00 UTC alone hit 468 subrequests - the mathematical maximum for
  that hour (12 cron ticks x the full 13-iteration subpoll budget x 3
  requests each). `wallTimeP50` that hour was ~244s, meaning the *median*
  tick ran the entire 4-minute subpoll budget, not just outliers.
- Root cause found directly in the live KV payload (`live_payload`, real
  production data, not a guess): ~14 Week 1 games carried a
  `kickoff_utc: "2026-09-05T00:00:00.000Z"` placeholder from BBS's
  `/v1/stored/matches` before BBS had the real scheduled time - e.g.
  Washington vs Washington State showed that midnight placeholder while
  CFBD's real kickoff for that game is `2026-09-06T20:00:00Z`, almost a
  full day off. `POST_KICKOFF_WINDOW_MS` (4h15m) meant every game with
  that placeholder looked "in progress" from 00:00-04:15 UTC regardless
  of its real kickoff, driving the subpoll loop to its full budget on
  every tick in that window. ~86% of the day's volume through 15:00 UTC
  landed in that single 00:00-04:00 UTC span.
- Confirmed the cron itself has no time-of-day gating (`wrangler.toml`:
  `*/5 * * * *`, all 24 hours) - the only game-awareness is the in-worker
  subpoll gate that the placeholder data was defeating.

**Fix:** `live/worker.js`'s subpoll/window decision (`pollAndCache()`) now
uses CFBD's real kickoff time - `data/cfb/seasons/2026/week1_matchups.json`,
produced by `sports/cfb/fetch_week1_matchups.py`, the same file the public
site's rank cards already trust (`site/app.js`) - via a new
`getRealKickoffTimes()` helper, instead of BBS's own `kickoff_utc`. No
CFBD entry, or `start_time_tbd: true`, now defaults to *not in window*
(safe default: skip subpoll rather than guess). BBS's `kickoff_utc` is
untouched everywhere else - still published in the live payload, still
the source for score/status once a game is genuinely in-window.

**Tested against real data before deploying:** replayed today's actual 34
recorded games (pulled fresh from production KV, BBS `kickoff_utc` and
all) through both the old and new window formulas at 2026-09-05T03:00Z -
the real observed 468-subrequest hour:
- OLD logic (BBS `kickoff_utc`): 13 games false-triggered in-window.
- NEW logic (CFBD `kickoff_utc`): 0 games triggered.
All 13 false triggers were exactly the placeholder-carrying games listed
above. Cross-checked against the current real time (15:51 UTC) to confirm
the fix doesn't suppress real triggers: both old and new logic correctly
flagged Indiana/Alabama/Houston as in-window (real kickoff 16:00 UTC,
inside the 15-min pre-kickoff window) - the fix narrows false positives,
it doesn't blind the Worker to real ones. `node --check live/worker.js`
passed.

**Deployed:** `wrangler deploy` from `live/`, version ID
`0e731870-de0f-4470-8cb5-0631cc049869`. `/health` returned `{"ok":true}`
and `/live` served fresh data immediately after.

**Post-deploy confirmation, real telemetry (not simulated):** pulled
Cloudflare's GraphQL Analytics API again for the 15:00-16:00 UTC hour,
which straddles the deploy and the real 16:00 UTC kickoff of
Indiana/Alabama/Houston's games:
- `requests: 12, subrequests: 96` for the hour - `wallTimeP50` ~815ms
  (most ticks in this hour stayed fast/baseline, correctly, since no real
  game was in-window for most of it) but `wallTimeP99` ~245s (full
  subpoll budget), consistent with only the last tick(s) approaching
  15:45-16:00 UTC correctly entering the real pre-kickoff window as those
  three games' actual kickoff approached.
- This is the intended shape: subpoll ramps up right at a real kickoff,
  not for hours beforehand on placeholder data. Confirmed via a
  background poll against the live KV record that a fresh tick (34 games,
  `updated_at: 2026-09-05T15:58:49.343Z`) landed cleanly post-deploy with
  no errors (`errors: 0` in the same telemetry).

Net result: the fix is live and its first real-world exercise (an actual
noon-ET kickoff window) shows exactly the pattern the replayed-data test
predicted - no false all-night subpolling, correct subpolling right at a
real kickoff.

Committed (`f8a9d16`) and pushed to `origin/main` on request shortly
after this entry was written.

---

## 2026-09-05 (afternoon/evening): BBS backup-key stopgap - primary account hit its cap

**Why:** the primary `BBS_API_KEY` account (2,000/day, GitHub-linked) hit
its daily cap again this afternoon. User created a second BBS account
(1,000/day, NOT GitHub-linked - free tier without the GitHub-link bonus)
as a same-day-only fallback and then went unreachable for the rest of the
day ("I'm about to leave for the day and need this to run fully
unattended, no check-ins possible"). Everything below was built, tested,
and deployed without further user input, per that instruction - the user
said to ask immediately if the new API key was needed (it was, and was
provided in-chat) and otherwise to leave nothing unresolved.

**What "stopgap" means here, precisely:** only the *which BBS key is
active* switch is temporary/same-day. The 429/quota safety net built
alongside it is NOT stopgap - it's a permanent addition worth keeping
regardless of which key is active, because today's placeholder-kickoff
incident (previous log entry) already proved a single bad signal can burn
a day's quota fast, and that class of failure isn't specific to which key
is in use.

**Built (`live/worker.js`, `live/bbs_client.js`, `live/wrangler.toml`):**

1. **Key-mode switch, driven by KV, not code:** `BBS_KEY_MODE_KV_KEY`
   ("bbs_key_mode") in `LIVE_KV` selects `env.BBS_API_KEY` (primary,
   default when unset) vs `env.BBS_API_KEY_BACKUP` (backup). Switching
   keys needs no redeploy - just a KV write. `BBS_API_KEY_BACKUP` was set
   via `wrangler secret put` from the key the user pasted in chat;
   confirmed via `wrangler secret list` that both `BBS_API_KEY` (primary,
   untouched) and `BBS_API_KEY_BACKUP` exist as separate secrets.

2. **429/quota safety net (`checkBbsBackoff`, `recordBbsUsage`,
   `pauseBbsForToday` in `worker.js`):** before every BBS call, checks (a)
   an explicit pause already in effect, or (b) today's tracked request
   count within `BBS_SAFE_MARGIN` (50) of the *active* key's real cap
   (`BBS_DAILY_CAP`: primary 2000, backup 1000 - the two keys are tracked
   against their own correct caps, not a single hardcoded number). Either
   condition silently skips the BBS call for the rest of the day (no
   console output beyond a `console.warn` - nothing external, per the
   "no human needs to notice" requirement) rather than continuing to hit
   a capped or rate-limited key. A real 429 response (checked via
   `err.status`/`.hitRateLimit`, not string-matching) triggers the same
   pause immediately, regardless of the tracked count. "Today" for this
   tracking is UTC-day, matching this codebase's existing convention
   (`bbs_client.js`'s `utcDateString()`) - BBS's own quota-reset boundary
   is unverified, flagged as such in the code comment, same honesty
   standard as the rest of this Worker's UNVERIFIED-tagging convention.

3. **Automatic revert to primary, two independent mechanisms, neither
   needing a human:**
   - The `bbs_key_mode=backup` KV entry was written with a TTL timed to
     expire exactly at 3 AM ET (`getBbsKeyMode()` defaults to "primary"
     when the key is absent, so expiry alone reverts it).
   - A second Cloudflare Cron Trigger, `"0 7 * * *"` (07:00 UTC = 3 AM
     EDT), added to `wrangler.toml`'s `[triggers]` block alongside the
     existing `*/5 * * * *`. `worker.js`'s `scheduled()` handler now
     branches on `event.cron`, dispatching this one to
     `revertToPrimaryBbsKey()` (deletes both the key-mode flag and any
     pause flag) instead of the normal poll loop. Recurring, not
     one-shot, since Cloudflare Cron Triggers don't support one-shot -
     harmless since the revert is idempotent.

**Tested before deploying, real code not a reimplementation:** added
test-only named exports to `worker.js`'s new helper functions (Cloudflare
still only uses `export default`, this changes no runtime behavior), then
ran verbatim copies of `worker.js`/`bbs_client.js` (copied into a scratch
dir with a local `package.json` so Node would load them as ESM - this
repo has no `package.json` of its own) through 17 checks against a mocked
KV and mocked `fetch`, all passing:
- Key-mode defaults to primary when unset; explicit backup mode reads
  back correctly; revert deletes both the mode and pause flags.
- Usage counter accumulates correctly and resets when the stored date
  isn't today.
- 940/1000 (below the 50-request margin) does not pause; 951/1000 (within
  margin) does pause AND writes a real pause record to the mock KV.
- The primary key's 2,000 cap is not mistakenly applied when checking the
  backup key's usage (960 requests, correctly not paused under the 2,000
  cap check).
- An explicit pause blocks polling even with usage=0 (covers the 429
  case, which sets a pause independent of the counter).
- `bbs_client.js`'s real `fetchBbsMatches()` against mocked HTTP: both
  dates returning 429 throws with `.status===429` and
  `.hitRateLimit===true`; one date 429 + one date succeeding does NOT
  throw (partial success still returns real data) but still surfaces
  `.hitRateLimit===true` so the caller backs off anyway.

**Deployed and independently confirmed live (not just deploy output):**
- `wrangler deploy` succeeded; version ID
  `34e217fb-d108-4b6a-920f-0763a82225a5`.
- Queried Cloudflare's own API directly
  (`GET .../scripts/powerswap-live-scores/schedules`) - confirmed both
  cron schedules are really registered:
  `[{"cron":"0 7 * * *", ...}, {"cron":"*/5 * * * *", ...}]`.
- `wrangler secret list` confirmed `BBS_API_KEY`, `BBS_API_KEY_BACKUP`,
  `CFBD_API_KEY` all present as separate secrets.
- Set `bbs_key_mode=backup` via `wrangler kv key put ... --ttl 49743`.
  Read the key back via the raw Cloudflare KV REST API (not just
  `wrangler kv key get`) to confirm the real stored expiration timestamp:
  `1788678009` epoch seconds = `2026-09-06T07:00:09Z` - matches 3 AM EDT,
  confirming the TTL-based revert is real, not just requested.
- Waited for a real post-switch cron tick (backgrounded poll against the
  live KV record) rather than trust the deploy alone. Confirmed: a fresh
  tick landed at `2026-09-05T17:16:07.037Z` with 34 real games and no
  `"note"` field (i.e. not the empty/no-ranked-teams fallback path) -
  proves `BBS_API_KEY_BACKUP` actually authenticates against BBS
  end-to-end, not just that the secret was accepted by `wrangler`.
  `bbs_usage_count` read `{"date":"2026-09-05","count":4}` - two real
  polls already recorded, consistent with the subpoll loop genuinely
  running (Indiana/Alabama/Houston kicked off at 16:00 UTC and are still
  inside their real active window at 17:16 UTC, so ongoing subpolling
  there is correct behavior, not a bug). Queried the raw Cloudflare KV
  list API directly (not `wrangler kv key get`, which errors - not fails
  the way that sounds; it exits non-zero when a key is simply absent -
  on a missing key) for every `bbs_*` key: only `bbs_key_mode` and
  `bbs_usage_count` exist, `bbs_paused_until` is absent - confirms no
  429 or margin-triggered pause has fired, correctly, this far below both
  the 950-request margin and any real rate limit.

**Status as of this entry: fully deployed, tested, and independently
confirmed live.** Nothing outstanding that needs the user before the 3 AM
ET revert. If the backup key's usage does approach 1,000 later today
(realistic on a full Saturday of games, per the earlier incident's own
math), the safety net above is what's expected to catch it - silently,
without paging anyone - and `/live` will keep serving its last-known
payload rather than erroring, until either usage counting confirms room
again tomorrow or the 3 AM ET revert switches back to the primary key's
full 2,000/day budget. Session set an internal one-shot reminder for
4:30 PM ET (2026-09-05) to check back in on this in case the user's own
usage ran out mid-task; if everything above still holds by then, no
further action is needed at that checkpoint either.

**4:30 PM ET checkpoint (2026-09-05T20:29 UTC) - re-verified all 5 items
with fresh evidence, not recalled from earlier in the session:**
1. `BBS_API_KEY_BACKUP` still present (`wrangler secret list`).
2. Stopgap code confirmed the currently-*active* deployment, not just
   deployed at some point: `wrangler deployments list` shows version
   `34e217fb-d108-4b6a-920f-0763a82225a5` at 100% traffic, most recent.
3. `0 7 * * *` still live per Cloudflare's schedules API (unchanged from
   this morning's check) and still present in `wrangler.toml`.
4. This section confirmed present via a fresh `grep`, not assumed.
5. `git fetch` + `git log` confirms local `main` and `origin/main` both
   at `920f142`, no drift.

New real data point from this checkpoint, not previously known: today's
usage count is `852/1000` on the backup key (`bbs_key_mode` still
`"backup"`, `live_payload.updated_at` fresh as of the check, confirming
active polling, no `bbs_paused_until` key present - no pause triggered
yet). This is closer to the 950-request safety margin than this morning,
because Saturday afternoon's games have kept subpolling genuinely active
for hours - expected given the real math from the original incident.
Tonight's later kickoffs (23:00+ UTC) could plausibly push past 950
before the 3 AM ET revert. If that happens, the safety net documented
above is expected to engage exactly as designed: polling backs off
silently, `/live` keeps serving its last-known payload (not an error
state), and the primary key's full 2,000/day budget returns automatically
at 3 AM ET. This is the intended degraded-but-safe outcome of a 1,000/day
stopgap key on a full game day, not a bug - flagging it here so it isn't
mistaken for one if `/live` looks stale later tonight.

---

## 2026-09-05 (evening): full redesign - flat polling replaces the kickoff-window/safety-net architecture entirely

**Why this happened:** the user asked directly why usage had already hit
852/1,000 by mid-afternoon despite this morning's kickoff-time fix. Real
answer (confirmed by checking what was actually in-window): it wasn't a
recurrence of the placeholder bug - 6 distinct real ranked-team games
were genuinely overlapping in their real CFBD-verified windows that
afternoon, so the "poll every 20s while any game looks live" subpoll loop
had been legitimately active for ~5 straight hours. The user then made
the key observation that reframed the whole design: BBS's
`/v1/stored/matches` returns the WHOLE day's slate in one call regardless
of how many teams are playing (confirmed - a single call returns 30+
games at once), so **request volume never needed to depend on game count
or kickoff timing at all** - only on how often we poll, which we control
directly. The kickoff-window/subpoll architecture was solving a problem
(freshness during live games) in a way that made total daily volume
unpredictable, when a fixed interval makes it exact and provable instead.

**What changed - `live/worker.js`, `live/bbs_client.js`, `live/wrangler.toml`:**
Deleted entirely: the in-Worker subpoll loop (`runPollLoop`,
`SUBPOLL_INTERVAL_MS`/`SUBPOLL_BUDGET_MS`), all kickoff-window logic
(`PRE_KICKOFF_WINDOW_MS`/`POST_KICKOFF_WINDOW_MS`, `getRealKickoffTimes()`,
the CFBD `week1_matchups.json` fetch - this data is unaffected and still
used separately by `site/app.js` for the site's own "vs Team" rank-card
display, just no longer fetched by this Worker), the KV-based key-mode
switch and the entire proactive usage-counter/margin safety net
(`checkBbsBackoff`, `recordBbsUsage`, `getBbsUsageToday`,
`pauseBbsForToday`, `BBS_DAILY_CAP`, `BBS_SAFE_MARGIN`, the `bbs_key_mode`/
`bbs_usage_count`/`bbs_paused_until` KV keys - all deleted from KV after
deploy, confirmed via the KV list API), and `bbs_client.js`'s
`hitRateLimit` tracking (nothing consumes it anymore). `scheduled()` now
does exactly one thing: `pollAndCache(env)`, no loop, no branching on
`event.cron`.

**Why the safety net was removed, not just left as a backstop:** the user
was explicit that a design shouldn't need safeguards against a class of
failure (unpredictable extra pulls) if the design itself can't produce
that failure. Walked through, precisely, what could actually cause
"extra pulls" under the OLD design (overlapping invocations from a
multi-minute subpoll loop; a stray duplicate cron trigger left registered;
a code bug adding retries) versus the flat design (none of those apply -
a single `pollAndCache()` call finishes in a fraction of a second, there's
exactly one registered cron trigger, and there's no retry logic). An
earlier claim about "timezone edge cases" causing extra pulls was
incorrect and retracted in-conversation - the UTC date math in
`bbs_client.js` has no timezone dependency at all; DST only affects the
*separate* question of whether an absolute-hour trigger like "3 AM ET"
fires at the intended wall-clock moment, not how many pulls happen.

**The math, exact and provable, not estimated:** `fetchBbsMatches()`
always makes exactly 2 requests per call (today's UTC date + yesterday's),
confirmed unconditional on game count or ranked-team count.
- Temp (today, `BBS_API_KEY_BACKUP`, 1,000/day cap): `*/3 * * * *` = 480
  ticks/day x 2 = 960 requests/day (96% of cap, 40 headroom).
- Permanent (from tonight, `BBS_API_KEY`, 2,000/day cap): `*/2 * * * *` =
  720 ticks/day x 2 = 1,440 requests/day (72% of cap, 560 headroom, 28%).
"Every 1.5 minutes" (the user's original aspirational number for the
permanent key) isn't valid cron syntax - Cloudflare Cron Triggers, like
standard crontab, only support whole-minute granularity - so 2 minutes is
the nearest clean equivalent without adding an in-Worker double-pull
pattern back in.

**Deployed and independently confirmed (temp version, live now):**
- `wrangler deploy` succeeded, version `56e1fd1a-d7b0-46a9-86eb-efe672c45e1e`.
- Queried Cloudflare's schedules API directly: exactly one cron trigger
  registered, `"*/3 * * * *"` - confirms the old `*/5` and `0 7 * * *`
  entries were genuinely replaced, not left running alongside the new one
  (the single most concrete way today's "extra pulls" question could
  actually happen again).
- Deleted the three now-orphaned KV keys (`bbs_key_mode`,
  `bbs_usage_count`, `bbs_paused_until`) and confirmed via the KV list API
  that all three are gone.
- Waited for a real post-deploy tick: `live_payload` updated at
  `2026-09-05T21:36:26.891Z` with 34 real games, no `note` field - the
  simplified single-call `pollAndCache()` is fetching and filtering real
  BBS data correctly under the new architecture.

**The 3 AM ET swap - real constraint, real mechanism, not glossed over:**
a Cloudflare Worker cannot redeploy itself; swapping the actual cron
schedule (not a KV flag this time, a literal config change) needs an
external actor with Cloudflare deploy credentials to run `wrangler deploy`
at that moment. Two real options were on the table:
1. GitHub Actions (matches this repo's existing `recompute-havoc.yml`
   pattern, fully session-independent) - blocked on needing a Cloudflare
   API token scoped to Workers-edit as a new GitHub secret. This session's
   own Cloudflare access is a `wrangler login` OAuth grant, confirmed via
   a real API call (`GET /user/tokens/permission_groups` returned "Invalid
   access token") to NOT have permission to mint new API tokens - would
   need the user to create one via the Cloudflare dashboard.
2. This session's own scheduled continuation (`CronCreate`), using the
   Cloudflare credentials already authenticated here, to run the actual
   `wrangler deploy` at 3 AM ET directly.
**User chose option 2 explicitly** ("Do it through your own session. I'm
keeping this open.") - the tradeoff (this only fires if the session/
terminal stays open) was stated plainly before that choice was made.

**How the swap is set up to actually work, robustly:** rather than rely
on this conversation's context still holding the exact file contents at
3 AM (context can get summarized over a long session), the PERMANENT
version's real, deploy-ready files are committed to the repo right now:
`live/worker.permanent.js` (uses `BBS_API_KEY`, otherwise identical
architecture) and `live/wrangler.permanent.toml` (`crons =
["*/2 * * * *"]`). The 3 AM ET job just needs to copy these over the
active `worker.js`/`wrangler.toml`, run `wrangler deploy`, verify via the
Cloudflare schedules API, delete the `.permanent.*` files (no longer
needed once they're the live version), and commit/push - it does not need
to reconstruct anything from memory. A `CronCreate` one-shot job is
scheduled in this session for 3 AM ET (2026-09-06) to do exactly this;
an earlier one from before this redesign (written for the old KV-flag
revert mechanism, now obsolete) was replaced.

**Status:** temp version live and confirmed working. Permanent version
committed and ready but not yet deployed - deploys automatically via this
session at 3 AM ET, contingent on this terminal staying open per the
user's explicit choice above. If it doesn't fire for any reason, the temp
version (`*/3 * * * *` on the backup key) keeps running safely under its
own 1,000/day cap indefinitely - nothing breaks by the swap being late,
it just means the backup key stays in use longer than intended and the
primary key's un-hit 2,000/day capacity goes unused until someone runs
the swap manually (copy the `.permanent.*` files over the active ones in
`live/`, `wrangler deploy` from `live/`).

Committed and pushed to `origin/main` as `0e28bf9`. The scheduled 3 AM ET
session job will append its own dated entry directly below this one once
the swap runs - real deploy version ID, real Cloudflare schedules-API
confirmation, and real post-swap tick evidence (or a plain incident note
if any step fails) - not a status flip on this same entry.

---

## 2026-09-06, 3 AM ET: permanent-config swap executed - real evidence, no failures

The scheduled session job fired as planned and ran the full swap, not
just a check-in. Session/terminal stayed open per the user's explicit
choice the night before, so the swap had a real actor to execute it.

**What happened, in order:**
1. Read `live/worker.permanent.js` and `live/wrangler.permanent.toml`
   before touching anything - confirmed `ACTIVE_BBS_KEY_ENV_VAR =
   "BBS_API_KEY"` (not the backup) and `crons = ["*/2 * * * *"]`, exactly
   as committed the evening before.
2. Copied both over the active `worker.js`/`wrangler.toml` and ran
   `wrangler deploy` from `live/` at `2026-09-06T06:59:51Z`. Deploy
   output reported `schedule: */2 * * * *` and version ID
   `e5bb66e7-37cc-4bc2-b074-ffb2313a14d2`.
3. Did not trust the deploy output alone - queried Cloudflare's
   schedules API directly (`GET .../scripts/powerswap-live-scores/
   schedules`). Result: exactly one schedule, `"*/2 * * * *"`, created
   `06:59:58Z` - confirms the old `*/3 * * * *` was genuinely replaced,
   not left running alongside it (the specific failure mode this step
   exists to catch).
4. Waited for a real post-swap cron tick rather than assume the primary
   key would work - polled `live_payload` in KV until its `updated_at`
   moved past the deploy timestamp. A real tick landed at
   `2026-09-06T07:00:33.858Z` with **37 real games** and no `note`
   field (i.e. not the empty/fallback path) - proves `BBS_API_KEY`
   (primary) authenticates and fetches real data end-to-end under the
   new flat, no-loop architecture, not just that the deploy succeeded.
5. Deleted `live/worker.permanent.js` and `live/wrangler.permanent.toml`
   - confirmed gone (`ls` on both returned "No such file or directory")
   - they're the live version now, no reason to keep separate copies.

**No incident to report.** Every verification step passed on the first
attempt: the deploy, the schedules-API check, and the real post-swap
tick all confirm the primary key and the `*/2 * * * *` cadence
(1,440 requests/day, 28% headroom under the 2,000/day cap) are genuinely
live in production as of 2026-09-06, ~3 AM ET. The `BBS_API_KEY_BACKUP`
secret remains set (untouched, not deleted) in case a future same-day
stopgap needs it again, but nothing in the deployed Worker references it
anymore.

**One real hiccup worth recording (fixed immediately, no data at risk):**
`git commit` succeeded but the first `git push` failed with a 403 -
`gh auth status` showed the machine's active GitHub CLI account had
switched to a second logged-in account (`The-Greg-Cote-Show`, no write
access to this repo) at some point overnight, displacing `yeti-blanc` as
active. This is a local `gh`/git-credential-helper state change, not
anything about the Cloudflare deploy or the Worker itself (which was
already live and verified by this point) - and not something this
session changed deliberately. Fixed with `gh auth switch --user
yeti-blanc`, then the push succeeded cleanly on retry
(`be38793..dcce470`). Flagging it here rather than silently retrying,
since an unexplained account switch on a machine that's about to sit
unattended is worth the user knowing about, even though the fix was
immediate and nothing was lost.

Committed and pushed as the changes below this entry.

---

## 2026-09-06: display bugs - cross-season live-badge leak, mascot names, missing Thursday games, historical opponent/score backfill

User checked BBS usage directly (784/2,000 on the primary account by this
point - confirms yesterday's redesign is holding) and reported four real
issues from actually using the site. All four investigated with real
evidence before touching code, all four fixed and verified live - not
inspected-and-assumed-fixed.

**1. Live scores overlaying the wrong season/week (priority: opponents
off historical data).** Reported: browsing 2022's Alabama (rated #1, real
2022 opponent was Utah State) showed "vs East Carolina" - 2026's actual
week-1 opponent - and this followed Alabama (and other teams) onto any
week of any season, not just week 1.

Root cause, confirmed by reading `site/app.js`: `renderLiveBadges()`
matched `liveGamesByTeam` purely by TEAM NAME, with no season or week
attached at all. Team names repeat across seasons (Alabama exists in
every year's rankings), so the CURRENT real 2026 live/final game for a
team got overlaid onto that same team's card in ANY season/week being
browsed. Separately, `renderRankings()`'s pre-game "vs. Team" line read
`currentWeek1Matchups` unconditionally on every week's cards, not just
week 1's - a second, independent bug with the same symptom shape.

Fixed both: `isViewingLiveWeek()` gates live badges to
`currentSeasonData.season === getCurrentSeasonYear()` AND the latest week
snapshot; the pre-game opponent line is now gated to
`snapshot.week === "week1" || "preseason"`. Verified in a real Chrome tab
(local static server, `python -m http.server`) via `javascript_tool`:
2022 week 1 Alabama shows neither a live badge nor an opponent line
before the historical backfill (item 4) landed real data; 2026 shows both
correctly, gated to only the live week.

**2. Mascot names in opponent display.** Root cause: `resolveBbsTeamName`
already returns a clean canonical name for a RANKED opponent, but an
UNRANKED opponent (most of them) fell through to BBS's raw "School
Mascot" name (e.g. "East Carolina Pirates"). Checked BBS's own
`short_name` field as a possible fix via a real API call first - reject
ed it: for "Utah Tech Trailblazers" it returned "UTU" (an abbreviation
code), not a clean name, so it's not a safe general substitute. Instead,
since the OTHER side of any such game is always a ranked team, reused
`week1_matchups.json`'s already-clean, already-CFBD-sourced `opponent`
field as the fallback name in `live/worker.js`. Only covers week 1 (that
file's scope) - noted as a limitation, not silently assumed to generalize.

**Bug found and fixed while deploying #2:** the merge/retention logic
added for item 3 (below) keyed retained games by the raw home/away name
pair. The instant the mascot fix changed how an unranked opponent's name
was computed, old ("BYU Cougars" era) and new ("BYU"/"Utah Tech")
records no longer matched as the same game, so the "merge" kept BOTH -
confirmed live: total games jumped from 37 to 72, with duplicate BYU
entries (one clean, one still mascot-laden). Root-caused by comparing a
local reproduction of the exact logic (all green) against real
production data (still broken) and finding the two didn't match up in
time - the first fix I deployed for item 2 alone hadn't actually
introduced this; the SECOND fix (merge identity) just hadn't gone live
yet when I checked. Real fix: `gameIdentityKey()` now keys on whichever
side is a CURRENTLY-RANKED team (stable across any naming-scheme change),
not the raw name pair. This has a second benefit: it also collapses BBS's
own long-known duplicate/near-duplicate records (e.g. two different ids
for "Missouri vs Arkansas-Pine Bluff Golde/n Lions") into one entry,
fixing a display quirk that had been visible since the very first
diagnosis two days ago. Tested with 4 assertions against the real
exported `gameIdentityKey`/`mergeGames` functions (old-vs-new-name
collapse, correct-name-wins, Thursday-style retention, retention expiry)
before redeploying - all passed. Confirmed live: games dropped back from
72 to 22, zero mascot-looking names remained, single BYU entry with the
clean name.

**3. Thursday's games not showing (priority).** Root cause: BBS's
`/v1/stored/matches` only ever returns today's and yesterday's UTC dates
(existing, deliberate design from the original quota-fix work - widening
it would cost more requests per poll, the exact thing that redesign
eliminated). By Sunday, Thursday's games (Missouri 54-14 over
Arkansas-Pine Bluff, Utah 66-14 over Idaho - confirmed via a direct real
BBS call for date=2026-09-04) had aged past that window and simply
stopped appearing in every fresh fetch, even though they'd finished
normally - confirmed missing from the live production payload before any
fix. Fixed going forward: `mergeGames()` now merges each fresh fetch on
top of the previous KV payload rather than overwriting it - a game that
ages out of BBS's 2-day window stays published (frozen at its last known
score) for `GAME_RETENTION_MS` (7 days, one full CFB week) before being
dropped. Costs zero extra BBS requests - pure KV read+merge.

This only prevents FUTURE loss, though - it can't retroactively recover
Thursday's data that had already been dropped before the fix deployed
(BBS's 2-day window had already moved past that date too, so a fresh
poll couldn't get it back either). Backfilled it as a one-time manual
step: fetched BBS's real `date=2026-09-04` data directly, confirmed the
real scores, and merged those two games into the live KV payload by
hand (same shape the Worker itself produces). Verified they survived the
NEXT real automated poll (retention logic keeping them, not a one-off
KV write that the next tick would silently erase again).

**Also cleaned up while in there:** a stale phantom BBS record
("Sacramento State Hornets vs Mississippi" - never happened; Mississippi's
real week-1 opponent is Louisville, confirmed via `week1_matchups.json`)
was being kept alive by the new retention logic instead of naturally
aging out the way it used to under the old overwrite-only design. Removed
it manually from KV. Flagging the general risk: retention is a real
tradeoff - it fixes genuine data loss (Thursday's real games) but can
also preserve a genuinely-bogus one-off BBS record for up to 7 days if it
only ever appeared once. Not fully solved (would need cross-checking
against `week1_matchups.json`'s known real opponent, which only covers
week 1), noted here rather than silently left as a surprise.

**Week 1 persistence, checked (no fix needed).** Read `scripts/
backtest.py` in full: each run rebuilds a season's ENTIRE snapshot list
from scratch - preseason, then week 1, week 2, ... up to `--weeks N` -
deterministically, from each week's own untouched raw game file
(`week_XX_games.json`). There's no code path where computing week 2
could overwrite or corrupt week 1's snapshot; running with a higher
`--weeks` value re-derives the same week-1 result from the same
unchanged input and simply appends more snapshots after it. Nothing to
fix here - confirmed by reading the actual loop, not assumed.

**4. Historical opponent/score data (explicitly "if able").** Confirmed
feasible with a real CFBD call: their `/games` endpoint returns complete
historical data - `completed: true`, real `homePoints`/`awayPoints` - for
any past season, not just the current one. Extended
`sports/cfb/fetch_week1_matchups.py` to capture `completed`/`team_score`/
`opponent_score` (from the ranked team's own perspective, so "team_score"
is always THEIR points regardless of home/away) alongside the existing
opponent/kickoff fields. Ran it for every past season (2021-2025),
generating each one's own real `week1_matchups.json` for the first time -
previously only 2026 had one, which is exactly why 2022's Alabama had
nothing of its own to show and (per bug #1) inherited 2026's instead.
Also regenerated 2026's for schema consistency now that most of its week
1 games have finished.

`site/app.js` now shows the real result (`W 55-0`) for a completed
matchup instead of a kickoff time, EXCEPT while viewing the current live
season/week, where the separate live badge already shows the final score
- showing it twice would be redundant. Verified live in Chrome: 2022
week 1 Alabama now shows "vs. Utah State · W 55-0" (the user's own exact
example, now correct); 2026 still shows "vs. East Carolina · Sat, 12:00
PM EDT" for the pre-game line plus "FINAL 48-10 vs East Carolina" (now
mascot-free) on the live badge, not a duplicated result.

**Known limitation, stated plainly:** this only covers WEEK 1 of each
past season (the file's own scope, unchanged) - weeks 2+ of any season
have no opponent-line data source and correctly show nothing, which is
the same pre-existing scope limit as before, not a new gap. Also,
`get_ranked_teams()` reads a season's LAST snapshot to decide which teams
to fetch week-1 opponents for - a team ranked in week 1 but out of the
rankings by season's end wouldn't get a week1_matchups.json entry. Not
hit in the one example checked (Alabama, 2022 - stayed ranked all
season) but worth knowing if a similar team's week-1 card ever shows
nothing unexpectedly for a past year.

**Everything verified with real evidence, not code-reading alone:**
Node-level unit tests against the real exported functions (mascot-fix
identity-key collapse, retention window behavior), real direct BBS API
calls (Thursday's actual scores, `short_name`'s real unhelpful value),
a real CFBD call confirming historical data availability, real production
KV reads before/after every deploy, and a real Chrome browser session
(local static server + `javascript_tool`) exercising the actual site UI
for both the bug repro and the fix confirmation, for both the current and
a historical season.

Committed and pushed to `origin/main` as the changes directly below this
entry.

---

## 2026-09-06 (follow-up): retention made permanent, not time-boxed

User's follow-up, precise: wants a completed game's score to stay
forever, never disappear - the earlier `GAME_RETENTION_MS` (7-day) expiry
was the wrong mental model, since "the score is old" isn't a reason to
drop it if nothing newer for that team exists yet.

Removed time-based expiry from `mergeGames()` entirely. A retained game
now persists indefinitely until - and only until - that same ranked
team's NEXT real game appears in a fresh BBS fetch and supersedes it via
`gameIdentityKey()`. This can't leak a future week's result early: BBS
simply won't return week 2's game for a team until it's actually within
its 2-day fetch window (i.e. genuinely about to happen or already
happened), so "permanent until superseded" and "week 2 shows nothing
until it's real" are the same guarantee, not two separate rules to keep
in sync. No per-game TTL, no age check - one property (has a fresher
entry replaced this team's slot yet?) covers both requirements the user
asked for at once.

Tested against the real exported `mergeGames`/`gameIdentityKey` (not a
reimplementation): a 200-day-old finished game is retained with no
expiry; that same team's next real game correctly supersedes it; no
phantom entries get fabricated for teams with nothing on record - 3/3
passed. Deployed (version `22150bb8-c75f-4897-8039-4ec98c880aa3`) and
confirmed live: Thursday's backfilled Missouri and Utah games are still
present in the payload after a real post-deploy poll.

Committed and pushed as the changes directly below this entry.

---

## 2026-09-07: Live Games section (middle column, above HAVOC) - trial

User asked to try replacing/prefacing the HAVOC section with live-game
cards: same visual style as the rankings cards, one per game currently
in progress, auto-removed once that game finishes, status/score/opponent
on a slow flash, and the font turning red if the lower-ranked or
unranked side is currently leading (a real upset in progress). HAVOC
moves directly underneath.

**Also answered:** week 2 populates via the same manual pipeline that
must have produced week 1 - `sports/cfb/fetch_results.py --week 2` then
`scripts/backtest.py --season 2026 --weeks 2`, once week 2's games are
done. Confirmed no scheduled automation exists for this (only the Havoc
recompute workflow exists, and that's `workflow_dispatch`-only) - it's a
manual step, not something that happens on its own overnight.

**Built (`site/index.html`, `site/app.js`, `site/style.css`):**
- New `<section id="live-games-section">` inside the middle column,
  before the HAVOC section, `hidden` by default.
- `renderLiveGamesSection()`: filters the live payload to
  `status === "in_progress"` only (a finished game still shows via its
  normal FINAL badge on the rankings card - it just leaves this
  dedicated section, matching "as games conclude, they're removed").
  Gated by the same `isViewingLiveWeek()` used for the belt-live badges
  - live game cards only ever render for the current season's latest
  week, never a historical one.
- Cards reuse `.belt-card`'s background/border/blur (same visual family
  as the rankings cards) with their own two-team-row inner layout (rank +
  name + score per side, plus a status line) - a single-team `.belt-card`
  couldn't represent a two-team game as-is, so this is a new inner layout
  on the same card shell, not a literal reuse of `.belt-row`.
- `isUnderdogLeading()`: compares both sides' current rank (via the
  existing `findCurrentRank()`) - the leader is "the underdog" if
  they're unranked while the other side is ranked, or if they're ranked
  worse (higher rank number) than the other side. Drives the `.upset`
  class, which turns the score and status text red via CSS.
- Slow flash: a 2.5s `ease-in-out infinite` opacity pulse
  (`@keyframes live-game-flash`) on the card's live-info wrapper (both
  team rows + status line together, not isolated per field).

**Tested live in Chrome** (local static server, `javascript_tool`), not
just read back: confirmed the section starts correctly hidden with zero
live games right now (real production data - nothing in progress at
check time); injected two simulated in-progress games (a #1-ranked team
trailing an unranked opponent, and a #3-ranked team leading an unranked
opponent) and confirmed the first correctly got the red `.upset` styling
and the second didn't; confirmed the flash animation is genuinely applied
via computed style (`animationName: "live-game-flash"`, 2.5s, infinite);
confirmed a card disappears the moment its game's status flips to
`"finished"`, and the whole section re-hides once none remain in
progress; confirmed the section stays hidden when browsing a past season
(2022) even with simulated in-progress data present, same season/week
gating as the existing live badges.

Not yet observed against a REAL in-progress game (none was live at
check time, Monday) - the injected-data test above exercises the same
`renderLiveGamesSection()` code path a real poll would, but the first
real live game is the actual end-to-end confirmation still pending.

---

## Session summary (2026-09-05 to 2026-09-07): live-scores Worker, start to finish

A lot happened across this stretch - condensed here as a map back to the
detailed dated entries above, not a replacement for them.

**1. BBS quota incident diagnosed with real evidence, not guesswork
(2026-09-05).** 1,602 of 2,000 daily requests burned by 6:45 AM, before
any real Week 1 game had kicked off. Pulled real Cloudflare subrequest
telemetry and the actual production KV payload to find the mechanism:
~14 games carried a `2026-09-05T00:00:00.000Z` placeholder `kickoff_utc`
from BBS before it had the real scheduled time, which the Worker's
subpoll-window logic misread as "kicking off right now" for hours
overnight - hour 03:00 UTC alone hit the mathematical maximum possible
subrequest volume for that hour.

**2. Kickoff-window fix (2026-09-05).** Subpoll decisions switched from
BBS's own (sometimes-wrong) `kickoff_utc` to CFBD's real kickoff time via
`week1_matchups.json` (same data the site's rank cards already trusted).
Validated by replaying real recorded data through old vs. new logic at
the actual observed spike hour: 13 false triggers -> 0.

**3. Same-day BBS backup-key stopgap, with a 429/quota safety net
(2026-09-05 afternoon).** Primary key hit its cap again mid-day on a real
Saturday of games. Stood up `BBS_API_KEY_BACKUP`, a KV-flag key-mode
switch with a self-expiring TTL, a 3 AM ET revert Cloudflare Cron
Trigger, and a proactive usage-counter/429 backoff net - all tested (17
checks against the real code) and confirmed live before the user went
unreachable for the evening.

**4. Full architectural redesign - flat, provable polling replaces all
of the above (2026-09-05 evening).** User's own insight: BBS's
`/v1/stored/matches` returns the WHOLE day's slate in one call regardless
of game count, so request volume never needed to depend on kickoff times
or how many games were live - only on how often the Worker polls, which
is fully controllable. Deleted the entire subpoll-loop/kickoff-window/
usage-counter-safety-net architecture (steps 2-3 above, superseded, not
layered on top of) and replaced it with exactly one flat poll per cron
tick: `*/3 min` on the backup key (960 req/day, temp), `*/2 min` on the
primary key (1,440 req/day, permanent) once reverted. The math is now
exact and provable - true regardless of game count - not tracked or
guessed at runtime.

**5. 3 AM ET permanent-key swap, executed for real (2026-09-06).** A
Worker can't redeploy itself, so this ran through the session's own
scheduled continuation (user's explicit choice, terminal kept open
overnight) rather than a session-independent mechanism - the tradeoff
was stated plainly before that choice was made. Copied the pre-committed
`worker.permanent.js`/`wrangler.permanent.toml` into place, deployed,
independently verified via Cloudflare's schedules API (not just deploy
output), and confirmed a real post-swap tick worked under the primary
key. One real hiccup along the way (a `git push` 403 from an unexpected
GitHub CLI account switch, unrelated to the Cloudflare side) - fixed and
logged, nothing lost.

**6. Display bugs found and fixed from real usage (2026-09-06).** User
reported: 2022's Alabama showing 2026's live game; mascot names in
opponent text; Thursday's games missing entirely. Root-caused and fixed
each: live badges and the opponent line were keyed by team name/
unconditional on week with no season or week check at all (now gated to
the live week only); unranked opponents fell through to BBS's raw
"School Mascot" names (now backed by `week1_matchups.json`'s clean CFBD
name); BBS's 2-day fetch window meant a finished game aging out simply
vanished (fixed via a KV merge instead of overwrite). Found and fixed a
real bug INTRODUCED by the mascot fix along the way - a naming-scheme
change silently doubled the payload by breaking the merge's identity key
- caught via real production data disagreeing with a local test, not
missed. Manually backfilled Thursday's two already-lost games from a
direct BBS call once the mechanism was fixed. Also confirmed (by actually
reading `scripts/backtest.py`, not assuming) that week 1's results can't
be corrupted by a later week's backtest run - it rebuilds deterministically
from each week's own untouched raw file every time.

**7. Retention made permanent, not time-boxed (2026-09-06 follow-up).**
User's explicit correction: a completed score should never disappear, and
a future week shouldn't show anything until it's real. Removed the
7-day expiry entirely - a game now persists until, and only until,
that same ranked team's next real game supersedes it, which by
definition can't happen before it's actually real.

**8. Historical opponent/score backfill, 2021-2025 (2026-09-06).**
Confirmed feasible with a real CFBD call (full historical data, any past
season), extended `fetch_week1_matchups.py` to capture final scores, and
generated real week-1 opponent+score data for every past season for the
first time - previously only 2026 had this file, which is exactly why a
past season's cards had nothing of their own and inherited today's data
instead (item 6). Verified live: 2022's Alabama now correctly shows
"vs. Utah State · W 55-0."

**9. Live Games section, above HAVOC (2026-09-07).** New middle-column
section: one card per game currently in progress, styled like the
rankings cards, auto-removed the moment a game finishes, a slow flash on
the live info, and red text when the lower-ranked/unranked side is
currently leading (a real upset in progress). Whole section - header
included - hides completely when nothing's live, confirmed as the
intended behavior. Tested live in Chrome with injected data (no real
live game was in progress at check time); first real in-progress game is
still the pending real-world confirmation.

**Open, by the user's own choice, not forgotten:** week 2 (and beyond)
still populates via a manual two-command pipeline
(`fetch_results.py` + `backtest.py`) - user has said this should become
automatic and is thinking through the right command/trigger for that
before it's built.

---

## Season progression automated for weeks 3-13 + championship week (2026-09-08)

**Schedule audit first, real data not media previews.** Before picking a
trigger time, pulled every 2026 regular-season week (1-15) directly from
CFBD's `/games` endpoint and flagged every game NOT on Thu/Fri/Sat.
Found week 1 actually has 4 such FBS games, not the 2 the user already
knew about (Washington State @ Washington and Wisconsin @ Notre Dame at
Lambeau Field, both Sunday, in addition to Louisville/Ole Miss Sunday
and SMU/Florida State Monday). Weeks 2-13 are otherwise clean of
Sunday/Monday FBS games - weeks 6-13 do have recurring Tuesday/Wednesday
MACtion and Conference USA games, but those land early in each CFBD
week, well before the following Sunday, so they don't threaten a
Sunday-morning trigger. Also discovered CFBD's `division=fbs` filter on
`/games` does NOT actually restrict to FBS opponents (450+ rows/week
including FCS/D-II/D-III games) - harmless today since those teams never
match a ranked team, but the claim to the contrary in `sports/cfb/
config.py`'s comment is wrong and worth fixing eventually.

**Conference championship week needed real historical data, since 2026's
matchups aren't set yet.** CFBD had zero games populated for week 14 (too
far out - participants aren't determined). Checked 2022-2025 instead:
all four years, the Big Ten and ACC championship games were played on
**Sunday**, not Saturday (Big 12/SEC/MAC/etc. all stayed Saturday) - a
consistent 4-year broadcast-window pattern, not a fluke. Based on that,
championship week gets its own later trigger.

**Result, per the user's explicit choices:**
- Weeks 1-2 populated by hand this session (`fetch_results.py` +
  `backtest.py` for both) - turned out neither had actually been run
  through the real pipeline yet (only the separate Havoc-ratings side
  pipeline had touched week 1). Zero rank-changing events in either
  week - preseason poll order holds through week 2, confirming the
  user's read that SMU (ranked) beating unranked Florida State is chalk,
  not an upset.
- New `.github/workflows/season-progression.yml`: weeks 3-13 populate
  Sunday 6 AM ET (one cron entry per real calendar date this season,
  since GitHub Actions cron has no year field and this schedule is
  2026-specific); week 14 populates Monday 6 AM ET instead, for the
  Sunday-championship-game reason above. Supports a manual
  `workflow_dispatch` week override for backfills/testing. Bowl
  season/CFP deliberately NOT covered - user's explicit call, to be
  tackled separately.

**Same account-switch hiccup as before, same fix - now explained, not a
mystery.** `git push` 403'd - `gh auth status` again showed the active
account had switched to `The-Greg-Cote-Show` (no write access),
displacing `yeti-blanc`. Fixed with `gh auth switch --user yeti-blanc`,
push succeeded clean on retry (`a81ebed..50a748c`). User confirmed after
this session: they're the one flipping it, switching `gh`'s active
account back and forth between two different projects/accounts on this
machine, and is already aware it drifts. Not a bug, not worth
investigating further - just check `gh auth status` and switch back to
`yeti-blanc` before pushing if a push to this repo 403s.

---

## Preseason dropdown removed; week 2 stopped showing week 1's leftovers (2026-09-08)

**User caught two real bugs from actually using the site:** a "Preseason"
option in the week dropdown that shouldn't exist ("there's no preseason
in college football"), and Week 2's cards showing Week 1's final scores
instead of Week 2's own upcoming slate.

**Root cause of #2 turned out to be upstream of the display layer.**
Week 2 had genuinely been backtested with ZERO games - its real slate
hadn't been played yet as of today (2026-09-08; week 2 kicks off
Thursday). That produced a phantom snapshot identical to week 1
(0 events, same rankings), stored and displayed as if "Week 2" were a
real, finished week. Fixed by reverting it (deleted the empty
`raw/week_02_games.json`, re-ran `backtest.py` through week 1 only) -
not by patching the display around bad data.

**The actual generalized fix, matching what the user asked for
("so on for each week as it populates"):** the opponent-line feature
that already existed for week 1 only (`week1_matchups.json`, fetched
2026-09-02) is now a real per-week system. New
`sports/cfb/fetch_week_matchups.py` generalizes that script's logic
(unchanged itself - `live/worker.js` reads its exact file by URL, and
5 past seasons already have one) to any week, writing
`raw/week_{NN}_matchups.json`. `site/app.js`'s `loadSeason()` now:
- Drops the "preseason" snapshot from the browsable list entirely the
  moment a real week1 snapshot exists to replace it
  (`computeVisibleSnapshots()`) - before that, the single preseason
  snapshot still stands in as "Week 1," same placeholder behavior as
  before, just no longer mislabeled "Preseason" once it's obsolete.
- Builds a synthetic "upcoming preview" entry for whatever week comes
  right after the latest real one, IF that week's schedule has been
  fetched but it hasn't been backtested yet - same rankings as the
  latest real week (nothing's changed), but that week's own schedule
  (opponent, kickoff time) instead of the previous week's now-stale
  opponent lines. Labeled "Week N (Upcoming)" in the dropdown.
- Looks up `weekMatchups[snapshot.week]` generically in
  `renderRankings()` instead of the old `isWeek1View` special case, so
  the same schedule-before/score-after behavior now applies to every
  week uniformly, not just week 1.

**One bug surfaced while building this, caught before it shipped:**
extending `isViewingLiveWeek()` naively to cover the new preview week
caused stale RETAINED week-1 final scores (see the 2026-09-06
permanent-retention entry above) to bleed onto week 2's preview cards -
confirmed live in Chrome (`FINAL 56-3 vs Ball State` showing under Ohio
State's real Week 2 schedule line). Fixed two ways: (1) the "live" week
is now whichever week has an upcoming preview, not just "the latest
snapshot," so a solidified week no longer competes with the live badge
for the same team: and (2) `renderLiveBadges()` now cross-checks the
live feed's reported opponent against that week's own expected opponent
before trusting it, so a retained-but-superseded result can't
masquerade as this week's game. Verified in Chrome after the fix: badges
correctly hidden on the Week 2 preview, and Week 1 shows its real final
scores directly in the opponent line instead (no badge needed once a
week is no longer "live").

**Also caught and fixed along the way:** `week1_matchups.json` had gone
stale - Notre Dame vs Wisconsin was still marked incomplete even though
that game finished days ago, because the file was never re-fetched after
the games concluded. Re-ran the existing (unmodified)
`fetch_week1_matchups.py` to refresh it; all 25 ranked teams now show
`completed: true` with real scores.

**Automation updated to keep this current going forward**
(`.github/workflows/season-progression.yml`): each week's run now also
re-fetches that week's own matchup file (baking in the final score) and
seeds the following week's schedule preview, so a week's cards always
show real, current data without needing another manual fix like this
one.

Tested live in Chrome (local static server) before calling this done -
confirmed the dropdown has no "Preseason" entry, Week 2 shows its own
real schedule, and Week 1's results are solidified and stay that way.

---

## 2026-09-11: live worker naming bug - Miami's badge showed Week 1's opponent during a real Week 2 game

**Real bug, reported while Miami was actually playing Florida A&M
tonight:** the live card showed the correct, updating score but the
WRONG opponent - Miami's Week 1 opponent (Stanford), not tonight's real
one (Florida A&M).

**Root cause, confirmed by reading `live/worker.js`, not guessed:** the
2026-09-06 "MASCOT-FREE NAMING" fix (see that entry above) gives an
unranked opponent a clean name by looking up the ranked team's opponent
in a matchups file - but the URL was a hardcoded constant,
`WEEK1_MATCHUPS_URL`, always. That was invisible while Week 1 was the
only week with games. The instant Week 2 started, any ranked team
playing a new unranked opponent (Miami vs. Florida A&M - Stanford was
Week 1's game) got its **Week 1** opponent's name substituted instead,
with the real live score still attached correctly (scores come from
BBS's own parsed fields, untouched by this bug). Confirmed directly
against the live production endpoint before touching code:
`GET /live` returned `{"home_team":"Miami","away_team":"Stanford",
"home_score":63,"away_score":0,"status":"in_progress"}` while the real
game was Miami 63 - Florida A&M 0.

**Not a timing/staleness bug, checked and ruled out:** the per-week
matchup system built 2026-09-08 was already working correctly -
`data/cfb/seasons/2026/raw/week_02_matchups.json` had the real, current
`Miami -> Florida A&M` entry the whole time (season-progression's
schedule-preview seeding ran fine). `live/worker.js` just never looked
at that file - it was hardcoded to Week 1's file regardless of which
week was actually live, so refreshing the matchup file sooner
wouldn't have changed anything.

**Two display paths, one root cause, only one of them band-aided
before now:** the 2026-09-08 fix added a client-side cross-check to
`renderLiveBadges()` (compare the live feed's opponent against this
week's expected opponent, hide the badge on mismatch) - that's WHY the
rank-card's own live badge was silently hidden rather than showing the
wrong name; it correctly distrusted the bad data. But
`renderLiveGamesSection()` (the middle-column "Live Games" cards, added
2026-09-07, one week before that cross-check existed) reads
`game.home_team`/`away_team` straight from the payload with no
cross-check at all - so the wrong name reached the screen there
uncontested. Fixing the real root cause (bad data at the source, in the
Worker) fixes both paths at once, and also means the rank-card's own
live badge can now correctly SHOW instead of being suppressed.

**Fix (`live/worker.js`):** replaced the hardcoded `WEEK1_MATCHUPS_URL`
lookup with `getCurrentWeekNumber()` (mirrors `site/app.js`'s own
"latest real snapshot + 1" live-week logic, computed from the same
`season_history.json` this Worker already fetches for the ranked-teams
list) and `getCurrentWeekMatchupsUrl()` (Week 1 keeps the legacy
top-level file; Week 2+ reads `fetch_week_matchups.py`'s generalized
`raw/week_{NN}_matchups.json`). `pollAndCache()` now fetches
`season_history.json` once (`getSeasonData()`) and shares it between
the ranked-teams lookup and the current-week lookup, instead of two
separate assumptions that could drift apart.

**Tested before deploying, real code not a reimplementation:** added
test-only named exports (`getCurrentWeekNumber`,
`getCurrentWeekMatchupsUrl`, alongside the existing `gameIdentityKey`/
`mergeGames`), ran verbatim copies through Node in a scratch dir - 5
checks on week-number/URL logic (mid-season, preseason-only, multi-week,
null-seasonData default, URL routing) plus a regression check that
`gameIdentityKey`/`mergeGames` still collapse and supersede correctly
regardless of opponent-name changes, all passing. A further end-to-end
check reproduced tonight's exact real shape (Miami's real week1
snapshot + real `week_02_matchups.json` content) through the new lookup
path and confirmed it resolves to "Florida A&M", not "Stanford".
`node --check live/worker.js` passed.

**Deployed and verified against the real live game, not just
inspected:** `wrangler deploy` from `live/`, version
`96ad148a-b110-4c3e-995f-9fc169ad6127`. Polled `/live` for a real
post-deploy cron tick (landed `2026-09-11T05:06:33.081Z`) and confirmed
the payload directly: `{"home_team":"Miami","away_team":"Florida A&M",
"home_score":63,"away_score":0,"status":"in_progress"}` - correct name,
same real live score. Then loaded the actual production site
(yetiblanc.com) in a real Chrome tab while the game was still in
progress: the Live Games card now reads "MIAMI 63 - FLORIDA A&M 0 -
LIVE", and Miami's rank card now shows its own live badge too ("- LIVE
63-0 vs Florida A&M"), correctly un-suppressed now that the underlying
data matches this week's expected opponent.

**Not yet touched, flagged rather than silently left:**
`renderLiveGamesSection()` in `site/app.js` still has no cross-check of
its own - it happened to become correct here because the fix was at the
data source, but if a future bug reintroduces bad naming/stale-retention
data upstream, this section would show it uncontested the same way it
did tonight. Worth deciding later whether it should get the same
this-week-opponent guard `renderLiveBadges()` has, or whether "fix the
data, not every consumer of it" is the intended permanent design here.
