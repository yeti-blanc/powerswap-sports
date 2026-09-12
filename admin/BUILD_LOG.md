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

---

## 2026-09-11 (same night, follow-up): closed the renderLiveGamesSection() gap + fixed the "(Upcoming)" label lingering after kickoff

Two fixes to `site/app.js`, requested directly off the flagged item above
and a separate real observation, both tested and verified live while
Miami's game was still in progress.

**1. `renderLiveGamesSection()` now has the same opponent cross-check
`renderLiveBadges()` got on 2026-09-08.** Pulled the mismatch check out
of `renderLiveBadges()` into a shared `gameMatchesExpectedWeek(game,
liveWeekKey)` - checks BOTH sides of the game against
`weekMatchups[liveWeekKey]` (not just the side `renderLiveBadges()`
happens to be iterating), since `renderLiveGamesSection()` renders whole
games, not one team's badge at a time. Both render functions now call
it independently rather than one trusting the other to have already
filtered anything - closes exactly the gap tonight's earlier bug slipped
through (worker-side naming bug hit both display paths, but only one had
a guard).

Verified live (local static server, `javascript_tool`) against the real
in-progress Miami/Florida A&M game: confirmed baseline (badge showing,
Live Games card showing, both correct) - then injected a fake stale
game (`Miami vs Stanford`, home_score/away_score set, status
`in_progress`) directly into `liveGamesByTeam`/`liveGamesRaw` and
re-rendered: both the belt badge AND the Live Games section correctly
suppressed it (`badgeHidden: true`, `liveGamesSectionHidden: true`,
0 cards) - before this fix the Live Games section would have shown it
uncontested, exactly like tonight's real bug. Re-ran `fetchLiveScores()`
against the real feed afterward and confirmed both paths correctly
show the real game again ("Florida A&M", 63-0) - the guard doesn't
false-positive against genuinely correct data.

**2. "Week N (Upcoming)" was still showing after that week's games had
actually started.** `previewWeekKey`'s week counts as "upcoming" purely
because it hasn't been backtested yet (see the 2026-09-08 entry) - true
before kickoff, false and misleading once real games from that week are
underway or finished, which can be true for hours/days before the
season-progression automation backtests it (Sunday morning). Added
`weekHasStarted(weekKey)`: checks `weekMatchups[weekKey]`'s own
CFBD-sourced `kickoff_utc`/`completed` fields (the same source of truth
the 2026-09-05 live-worker fix established for "has this actually
started" - not BBS's live-feed status, so it reads correctly even before
BBS's feed has picked a game up) for any entry whose kickoff has passed
or that's already finished. `formatWeekLabel()` now suppresses the
"(Upcoming)" suffix once that's true. Also added `refreshWeekLabel()`,
called every live-score poll tick (45s, piggybacked on the existing
interval rather than a new one) so a tab left open across a real kickoff
has its dropdown/heading/nav label flip off "(Upcoming)" on its own,
without needing a reload - it runs regardless of whether that tick's BBS
fetch succeeds, since it only depends on wall-clock time vs. kickoff.

Verified live (same local static server session): before any fix, Week 2
(Miami's game already ~1 hour in) showed "Week 2 (Upcoming)" in the
dropdown, nav bar, and heading. After the fix, all three read plain
"Week 2" on load, with no reload needed. Regression-checked
`weekHasStarted()` directly against three synthetic cases: a future
kickoff (correctly `false`), a past kickoff (correctly `true`), and a
`start_time_tbd: true` entry with no real kickoff time (correctly
`false` - TBD never counts as started). Also confirmed `formatWeekLabel`
still returns plain "Week 1"/"Week 2" for already-backtested,
non-preview weeks and "Week 1" for the legacy "preseason" key,
unaffected by this change.

`node --check site/app.js` passed both times. Committed and pushed to
`origin/main` as the changes directly below this entry - `gh auth
status` was already on `yeti-blanc` this time, no account-switch hiccup
to fix before pushing.

---

## 2026-09-11 (unattended session): stale live-data root cause found and fixed - real evidence per angle checked; plus Saturday BBS-capacity confirmation

User reported a real symptom from this morning: a game that had genuinely
finished over an hour earlier was still showing as live (badge + Live
Games section) with a stale score. Asked to investigate before fixing,
checking four specific angles with real evidence - all four checked.

**1. Was the cron actually firing every 2 minutes? Confirmed yes.**
Queried Cloudflare's schedules API directly
(`GET .../scripts/powerswap-live-scores/schedules`): exactly one
schedule, `"*/2 * * * *"`, unchanged since the 2026-09-06 permanent
deploy. Queried the GraphQL Analytics API
(`workersInvocationsAdaptive`) for every hour from 2026-09-10T18:00Z
through now: zero-error `status: success` at every hour, quiet-hour
baseline (no site traffic) landing at ~25-30 requests/hour - consistent
with 30 cron ticks/hour, exactly as designed. Hours 04:00-08:00 UTC
spiked to 88-177 requests/hour, but that's real site-visitor `/live`
polling overlapping the live Miami game overnight, not extra cron
activity (the schedule itself never changed). Cron is exonerated by real
telemetry, not assumed innocent.

**2. Did BBS itself report `finished` promptly? Root cause is here -
BBS's own known duplicate-record quirk, combined with a real bug in how
this Worker resolves duplicates.** A real BBS call today
(`/v1/stored/matches?date=2026-09-11`) confirms BBS is *still* returning
TWO separate records for the one real Miami/Florida A&M game - different
ids (`0e6f5e13...` "Miami Hurricanes" vs `387b9de7...` "Miami (FL)
Hurricanes"), both agreeing now (`finished`, 77-7). This exact
duplicate-record behavior was already flagged as a known BBS quirk in
`worker.js`'s own 2026-09-06 comments (also reproduced independently
today across a much wider set: matching tomorrow's real Saturday slate
against currently-ranked teams turned up the *same* team/game showing
twice under different ids for at least 6 different matchups - this is a
routine, pervasive BBS behavior, not a one-off).

`worker.js`'s `freshByKey` dedup logic (used to collapse BBS's duplicate
records into one entry per real game) picks whichever duplicate has the
higher `STATUS_PRIORITY`. That constant was `{ in_progress: 3,
finished: 2, scheduled: 1, unknown: 0 }` - backwards from the comment's
own stated intent ("keeping whichever status is most advanced"): a real
game cannot un-finish, so `finished` should always outrank `in_progress`,
not the reverse. With the old ordering, if BBS's two duplicate rows for
one real game briefly disagreed - one already synced to `finished`, its
sibling still serving a stale `in_progress` snapshot (BBS's own refresh
cadence behind this DB-backed endpoint has been flagged UNVERIFIED since
`bbs_client.js` was first written) - the STALE `in_progress` duplicate
won, deterministically, on every single poll, for as long as BBS's own
two rows kept disagreeing. This isn't a one-time race: `pollAndCache()`
rebuilds `freshByKey` from scratch every tick by re-running this same
comparison against BBS's *current* raw duplicates, so a perfectly-firing
2-minute cron would just keep re-confirming the wrong state, poll after
poll, for exactly as long as BBS's backend took to fully sync both
duplicate rows - an externally-controlled interval this repo has no
visibility into and no control over. That maps precisely onto "over an
hour of staleness despite everything upstream working correctly."

**Reproduced against the real code, not a reimplementation, using the
real recorded numbers from this game:** copied `worker.js`/`bbs_client.js`/
`team_norm.js` verbatim into a scratch dir, extracted the exact
`freshByKey` loop as a test-only export, and fed it two synthetic BBS
records shaped exactly like today's real duplicate pair - one
`status: "finished"` with the real final score (77-7), one
`status: "in_progress"` with the real in-progress score this repo's own
build log recorded for this exact game at 2026-09-11T05:06 UTC (63-0).
Regardless of which record BBS lists first, the old code selected the
stale `in_progress` 63-0 record every time. Confirms the mechanism is
real and deterministic, not a guess.

**3. Caching/propagation delay elsewhere in the chain? Checked, ruled
out as the explanation.** `wrangler kv key get` without `--remote`
returned 10-day-old local-dev-persisted test data (`updated_at:
2026-09-01T05:40:00Z`, synthetic `test-1`/`test-2` games) - flagged
immediately as a false lead and ruled out by re-reading the same key with
`--remote`, which matched the real production `/live` HTTP response
exactly (`updated_at: 2026-09-11T14:42:22.970Z`, real games). The genuine
KV/edge path is fast: the real `/live` response was 1-2 minutes fresh at
every check, consistent with the 2-minute cron cadence and no meaningful
propagation lag. Worth flagging as a real trap for next time: `wrangler
kv key get` defaults to `--local` and will silently hand back stale
local-dev-persisted data that looks exactly like a real stale-KV bug
unless `--remote` (or `--namespace-id` isn't enough alone) is passed
explicitly.

**4. Client-side 45s poll stalled? Checked, ruled out, but found a
second, currently-latent copy of the same bug.** `site/app.js`'s
`fetchLiveScores()`/`setInterval(..., 45000)` has no visibility/tab-state
gating that could stall it, and isn't relevant here anyway since the root
cause is upstream: the KV payload itself was wrong, so a working 45s poll
would just faithfully keep redisplaying whatever wrong data the Worker
published. However, `site/app.js`'s own `LIVE_STATUS_PRIORITY` constant
(used to dedup a team appearing more than once in `payload.games`, a real
scenario per its own 2026-09-04 comment) had the *identical* backwards
ordering (`in_progress: 3, finished: 2, scheduled: 1`). Not the cause of
last night's incident (the server-side worker.js fix already collapses
to one entry per team before publishing), but the same class of bug,
latent, in the one place that would matter if a future payload shape
ever carried duplicate team entries again.

**Fix (`live/worker.js`, `site/app.js`):** `STATUS_PRIORITY` /
`LIVE_STATUS_PRIORITY` reordered so `finished` is the highest-priority
status in both files (`{ finished: 3, in_progress: 2, scheduled: 1,
unknown: 0 }` server-side; client mirror without `unknown`, matching its
existing shape). Re-ran the same reproduction against the fixed code:
both record orderings now correctly resolve to `finished`, 77-7.
`node --check` passed on both files.

**Deploy status: NOT yet shipped.** The Worker-side fix
(`live/worker.js`) needs a real `wrangler deploy` from `live/` to take
effect in production - this session's own production-deploy action was
blocked by the harness's own auto-mode safety gate (a live Cloudflare
Worker push is treated as a real production action needing explicit
approval, same category as any other hard-to-reverse, shared-system
change). The fix is written, tested against the real code, and verified
to resolve the reproduction - it just needs `wrangler deploy` run (from
`live/`) and the usual post-deploy check (poll `/live` for a fresh tick,
confirm via the schedules API nothing else changed) by the user or in a
session where that action is approved. `site/app.js`'s matching fix is
a static-site file change with no deploy step of its own (GitHub Pages
serves it directly from `main` once committed/pushed) - not yet
committed either, held back so both halves of the fix ship together.

**Saturday capacity check (part 2 of this session's task) - real CFBD +
BBS data, not synthetic:**

- Pulled CFBD's real week 2 schedule (`year=2026&week=2`): 71 real FBS
  games on Saturday 2026-09-12 alone (86 across the full Thu-Sun week 2
  window).
- Called BBS's real `/v1/stored/matches?date=2026-09-12` directly (BBS
  pre-populates scheduled games ahead of the date, confirmed by this
  call succeeding today, a day ahead): `pagination: {"total":109,
  "limit":200}` - the real Saturday slate is 109 games in BBS's own
  count, comfortably under the 200-row page limit (54.5% of it) with no
  truncation risk, and above the previously-largest-observed 95 games
  from 2026-09-05 - worth knowing the margin isn't unlimited if the
  slate keeps growing, though not close to a problem yet.
- Matched the real current 25-team ranked list (`season_history.json`,
  still week1's snapshot) against Saturday's real BBS slate using the
  actual `resolveBbsTeamName()` matcher: **23 of 25 currently-ranked
  teams play Saturday** (near-worst-case concurrency for this season),
  including 2 ranked-vs-ranked games (Ohio State @ Texas, Oklahoma @
  Michigan). BBS's own known duplicate-record behavior showed up here
  too, independently confirming point 2 above isn't a one-game fluke -
  at least 6 distinct Saturday matchups came back as two separate BBS
  records apiece.
- **The flat-cadence math is architecturally invariant to all of the
  above, not just probabilistically likely to hold:** `bbs_client.js`'s
  `fetchBbsMatches()` makes exactly 2 requests per call (today's UTC
  date + yesterday's) with no loop over ranked teams or games of any
  kind - confirmed by reading the function, and independently confirmed
  by the real Saturday call itself returning all 109 games, ranked-team
  or not, in that same single per-date call. 720 cron ticks/day
  (`*/2 * * * *`) x 2 requests = exactly 1,440 requests/day = 72% of the
  primary key's 2,000/day cap, regardless of whether 0 or 23 of 25
  ranked teams are playing, and regardless of how many of those overlap
  in kickoff time - there is no code path in the current (post-2026-09-05
  redesign) architecture where game count or concurrency changes request
  volume at all. Saturday's real data corroborates this rather than
  needing to prove it from scratch: the numbers behave exactly as the
  architecture predicts.

**Not done: a live dry-run against tomorrow's real early games**, per the
user's own fallback instruction ("otherwise model it against Saturday's
real schedule data now") - the architectural invariance above doesn't
depend on tomorrow's actual kickout times to be true, so today's modeled
check against real CFBD/BBS data is the authoritative answer already;
flagged to the user as available to double-check against tomorrow's
telemetry after the fact if wanted.

Not committed/pushed yet - held pending the user's go-ahead on the
production Worker deploy, so both the KV-side data fix and the display
code ship together rather than in two mismatched steps.

## 2026-09-11 (evening): two live games missing scores/badges - traced to a real BBS-side outage, not our code

User reported two real in-progress games not showing scores, live badges,
or Live Games cards. `/live` was returning `{"updated_at":null,"games":[]}`
- completely empty, not stale.

**Root cause, confirmed with real evidence, not guessed:**
`wrangler tail powerswap-live-scores` showed every single cron tick
failing identically for several consecutive ticks:
```
BBS /v1/stored/matches (date=2026-09-12) returned 500
BBS /v1/stored/matches (date=2026-09-11) returned 500
BBS fetch failed: BBS /v1/stored/matches (date=2026-09-11) returned 500
```
Ruled out our own request being at fault: a call with no `Authorization`
header and a call with a deliberately bad key both got clean, well-formed
`401 invalid API key` responses from BBS in the same window - so BBS's
auth layer is fine and reachable, only the real authenticated query
errors out.

**Backup-key test (ruled out account-specific cause):** temporarily
pointed `ACTIVE_BBS_KEY_ENV_VAR` at `BBS_API_KEY_BACKUP` (already present
as a Worker secret from the 2026-09-05 stopgap) and redeployed. Got the
IDENTICAL 500 on the next two ticks. Two different keys/accounts failing
the same way rules out "our primary account specifically is broken" and
points to BBS's `/v1/stored/matches` endpoint itself being down for real
authenticated traffic - reverted back to the primary key immediately
after (no benefit to burning backup-key quota on a broken endpoint) and
redeployed again.

**Checked BBS's own status page** (`bigballsdata.com/status` ->
`stats.uptimerobot.com/0eeM4GZQiv`, loaded in a real browser since it's
JS-rendered): shows "All systems Operational" throughout, monitoring only
`api.bigballsdata.com/health`. It would never catch this - `/health`
being up doesn't mean `/v1/stored/matches` is.

**Conclusion: this is a genuine third-party outage, not a bug in this
repo.** No code change fixes it - `worker.js`'s existing design already
handles it correctly on its own: a failed poll just leaves `/live`
serving its last-known KV payload (or the empty default if KV had
nothing cached) and retries automatically every 2 minutes with no
intervention needed once BBS's endpoint recovers. Nothing to do here but
wait for BBS and keep an eye on the next few polls.

Net diff: `live/worker.js`'s `ACTIVE_BBS_KEY_ENV_VAR` comment updated to
record this incident (constant itself unchanged - back on the primary
key). Two real `wrangler deploy`s happened during diagnosis (backup key,
then revert) - both confirmed via `wrangler tail` logs, not assumed.

## 2026-09-11 (night, follow-up): outage confirmed STILL ONGOING at check
time - broader test suite, all pointing at BBS, none at our code

User reported live scores still missing and asked for more tests to rule
out our own code before a big Saturday slate. Re-ran the full diagnostic
with fresh evidence rather than assuming the earlier finding still held:

1. **Real key vs no-auth vs bad-key against `/v1/stored/matches`,
   right now:** identical pattern to the original incident - real key
   -> 500 `internal server error` (request_id
   `7cd7f41e-5aa7-4cec-9f86-309d116ad650`), no `Authorization` header ->
   clean 401 `missing API key`, deliberately bad key -> clean 401
   `invalid API key`. Auth layer still fine; only the real authenticated
   query still errors.
2. **`wrangler tail powerswap-live-scores` live for ~2 minutes**, caught
   a real cron tick at 9/11 10:14:19 PM ET failing both dates with 500 -
   confirms the DEPLOYED Worker's own request (not just a manual curl)
   hits the identical failure, closing the "maybe our code sends a
   subtly different request" gap.
3. **Ranked-teams data isn't the blocker:** `season_history.json` has a
   real `week1` snapshot with 25 ranked teams, so `pollAndCache()` never
   even takes the "no ranked teams yet" early-return path - it's really
   reaching `fetchBbsMatches()` and failing there.
4. **Both queried dates (today AND yesterday UTC) still 500** -
   consistent with the original finding, not a one-date fluke.
5. **NEW: tested endpoint scope.** BBS's own gateway `/health` -> 200
   `{"status":"ok","redis":true,"adapters":20}` (their infra is up).
   `/v1/stored/matches` fails identically for a DIFFERENT league too
   (`sport=basketball&league=ncaab` -> same 500), so it's not an
   NCAAF-specific data problem - the whole `/v1/stored/matches` endpoint
   is down across sports. Meanwhile `/v1/matches` (the OLD endpoint this
   client stopped using back on 2026-09-04) returned a clean 200 with a
   full 50-game slate, using the SAME real key - so the account/key is
   fully functional, and BBS's live-feed path still works while their
   stored/DB-backed path is the one that's broken.

**Notable side finding, not acted on:** `/v1/matches`'s response just
observed has home/away as full `{id, name, short_name, logo_url}`
objects plus `kickoff_utc`/`score`/`linescore` - NOT the terse
"plain integers, no team names" shape `bbs_client.js`'s header comment
says was confirmed on 2026-09-04. Either BBS changed that endpoint's
shape since, or the original characterization was wrong. Worth a real
side-by-side check (does `score`/`status` actually populate correctly
for an in-progress game on THIS endpoint?) before ever treating it as a
fallback - not verified here, and swapping the Worker's primary data
source hours before a big slate on an unverified shape would trade one
outage for a different, less-understood failure mode. Flagging for a
deliberate look, not doing it as a reflex fix.

**Conclusion unchanged, now with more independent angles confirming it:**
this is BBS's `/v1/stored/matches` endpoint down, not our request shape,
our key, our ranked-teams data, or our Worker's deployed code. Nothing
to fix on our side; the Worker keeps retrying every 2 minutes
automatically. Re-check with the same test list if scores are still
missing once tomorrow's games kick off - if `/v1/stored/matches` is
still 500ing during real live play, that's the point to seriously
consider the `/v1/matches` fallback (verified first) or reaching out to
BBS support (discord.gg/H2WJBQurbq / support@bigballsdata.com) directly.

## 2026-09-12: built real redundancy (secondary + tertiary) while the outage was still live - deployed, verified against real production traffic

Overnight handoff, done autonomously per explicit approval: the
2026-09-11/12 outage above left the site with zero live-score updates
for hours because this Worker had exactly one data source. This session
built and shipped real redundancy - not a retry, an actual second and
third independent path - and, unusually, got to verify the fallback
against the SAME outage, live, in production, rather than a simulated
one.

### Phase 1: BBS `/v1/matches` as candidate secondary - CHECKS OUT, shipped

Confirmed live (03:44-03:55 UTC 2026-09-12, real key, real games, while
`/v1/stored/matches` was still returning 500 on every call in parallel):

- **Response shape is identical** to `/v1/stored/matches` for every field
  `parseBbsMatch()` reads - same `id`/`home.name`/`away.name`/
  `kickoff_utc`/`status`/`score.{home,away}`/`linescore.{home,away}`.
  No new parsing code needed; reused as-is.
- **Status transitions correctly and promptly:** watched a real live game
  (Kansas @ Missouri, `b5cb50b8-cfb2-4d14-83de-7e3b79574e90`) flip
  `"live"` -> `"finished"` between two polls 60s apart (03:53:38 ->
  03:54:38 UTC), same score both times (21-38) - a real status
  transition, not a guess, and well inside this Worker's 2-minute cron
  interval.
- **Team naming is the same "School Mascot" convention** as
  `/v1/stored/matches` (confirmed: "Kansas Jayhawks", "Missouri Tigers",
  "UCF Knights", "East Carolina Pirates" vs. both "Appalachian State
  Mountaineers" and "App State Mountaineers" spellings for the same
  team). `resolveBbsTeamName()`/`norm()` work completely unchanged - the
  existing `App State -> Appalachian State` NORM entry already covers
  the variant seen. No new norm() entries needed.
- **Has the same duplicate-row-under-different-IDs problem:** found 8
  distinct real matchups on 2026-09-12 each appearing twice under
  different ids (Purdue/Wake Forest, Georgia/Western Kentucky,
  Penn State/Temple, Michigan/Oklahoma, Arizona State/Texas A&M,
  Old Dominion/Virginia Tech, Oklahoma State/Oregon, Kansas State/
  Washington State) - one copy of each pair carrying a midnight-UTC
  placeholder `kickoff_utc`, the other a real one. Same class of bug as
  the Miami/Florida A&M incident (`f7efe84`) - `worker.js`'s existing
  `gameIdentityKey()`/`STATUS_PRIORITY` dedup is source-agnostic (runs on
  whatever raw matches get fed to it), so it resolves this without any
  new code.
- Does **not** need a `date` param at all (unlike `/v1/stored/matches`) -
  one call returned a slate spanning yesterday's late kickoffs through
  tomorrow's, so `fetchLegacyMatches()` is a single request, cheaper than
  the primary's 2-request-per-tick shape.

**Honestly flagged, not glossed over:** no actual mid-game SCORE CHANGE
was observed - the one live game available during the test window
(21-38, Q4) didn't score again before finishing, and no close/
back-and-forth game was live at all during the window (only blowouts and
pre-kickoff games). Score-field trust rests on the field being identical
to the already-proven `/v1/stored/matches` shape, not on a fresh direct
observation of a score changing on this specific endpoint.

**Verdict: shipped as secondary**, activating only when the primary
fails on the same tick.

### Phase 2: CFBD live scoreboard - real endpoints found, both blocked by tier, NOT usable today

Third-party docs (correctly not trusted at face value per the handoff
brief) named a plausible-sounding endpoint; the real one, pulled from
CFBD's own live OpenAPI spec (`api.collegefootballdata.com/api-docs.json`),
is different:

- `GET /scoreboard` (`classification`, `conference` params) - "Returns
  current scoreboard data."
- `GET /live/plays?gameId=<int>` (required) - "Returns live play-by-play
  data and advanced metrics for a game."

Both use the same `Authorization: Bearer <key>` scheme this project
already uses for CFBD elsewhere. Tested both for real against our
existing `CFBD_API_KEY` (the one used for ranked-teams/results data):

```
GET /scoreboard?classification=fbs
-> 401 {"message":"Unauthorized. This endpoint requires a Patreon
subscription at Tier 1 or higher."}

GET /live/plays?gameId=401856678   (real gameId, Kansas @ Missouri,
                                     pulled from /games?year=2026&week=2)
-> 401 {"message":"Unauthorized. This endpoint requires a Patreon
subscription at Tier 2 or higher."}
```

**Verdict: real, documented, genuinely independent endpoints - blocked
by subscription tier, not rate limit or wrong request shape.** Our
current CFBD key is free-tier; both live endpoints require a paid
Patreon subscription (Tier 1 for `/scoreboard`, Tier 2 for
`/live/plays`). Rate-limit behavior is moot until that's resolved - we
have zero access, not throttled access. Not purchasing a subscription
autonomously (real recurring cost, the user's decision) - flagging this
as the one lever that would make CFBD a genuinely BBS-independent
secondary if picked up later. `CFBD_API_KEY` stays wired as a Worker
secret but unused by this file for now, same as before.

### Secondary decision

BBS `/v1/matches` ships as secondary. CFBD would have been preferred on
independence grounds alone (a BBS-platform-wide outage takes down both
BBS endpoints together - this exact outage already proves that pattern
for `/v1/stored/matches`, and there is no reason `/v1/matches` is
immune to a future BBS-wide incident), but it's not currently reachable
on our tier, and "not reachable" beats "true redundancy" as a ranking
input, obviously. Revisit if a Patreon Tier 1+ CFBD key is ever added.

### Phase 3: Highlightly as tertiary - built, deployed, NOT live-verified (real blocker, not a shortcut)

**No `HIGHLIGHTLY_API_KEY` exists anywhere for this project** - checked
`.env`, both Workers' `wrangler secret list` (`powerswap-live-scores`
and the admin worker), and OS environment variables; none has it. This
contradicts the handoff brief's assumption that a working key already
existed. `sports/cfb/havoc_rating.py` independently corroborates this
from an earlier, unrelated session ("Highlightly's docs show no
injuries endpoint on any plan, not independently verified live - no key
available"). Per the "verify with real evidence" rule, this session did
**not** fabricate a "confirmed working" result for a source it could
never actually call - built the integration from Highlightly's own real
docs, wired it in behind the missing secret so it's completely inert
until a real key exists, and documented every remaining guess loudly
rather than quietly.

Confirmed from Highlightly's own documentation (`highlightly.net/nfl-api/
documentation/`, `/sport-api/documentation/` - not third-party marketing
copy, though see the caveat below about which sport's example was
actually shown):

- Base URL `https://american-football.highlightly.net`, endpoint
  `GET /matches` filtered by `leagueName=NCAA` and `date=`.
- Auth header `x-rapidapi-key` - their own docs state this is used even
  for direct (non-RapidAPI-marketplace) calls.
- Response carries `x-ratelimit-requests-limit` /
  `x-ratelimit-requests-remaining` headers.

**Real gap found mid-research, worth flagging on its own:** the first
doc pull for the match-object shape returned a SOCCER-shaped example
(`"state.score.current": "3 - 1"`, `"First half"`/`"Extra time"`/
`"penalties"`) even though it claimed to be describing the American
football object - exactly the "don't trust a generic-looking example"
risk the handoff brief called out for third-party docs, except here it
showed up inside Highlightly's OWN docs page via an AI summarization
pass. Re-pulling with an explicit "this is American football, not
soccer" instruction got a corrected, sport-appropriate example. Lesson
for next time: always sanity-check a fetched doc's example against the
sport actually being integrated, even when the source is the vendor's
own site.

**UNVERIFIED - flagged loudly in `highlightly_client.js`'s file header,
not glossed over:**

- **The score field is a combined string** (`"score.current": "21 - 7"`),
  not separate home/away integers like BBS. Which side of the `" - "` is
  home vs. away is not stated anywhere in the docs pulled - the parser
  guesses "home - away" but this is exactly the kind of guess that fails
  SILENTLY (a confidently-wrong score) rather than loudly. **This is the
  single most important thing to check the moment a real key exists**,
  ideally against a lopsided score where a flipped order is obvious by
  eye.
- Whether `leagueName=NCAA` is really the right filter param (vs.
  `league=`, used for NFL in the same docs).
- The full status/description vocabulary for American football
  specifically (the corrected pull showed `"In progress"` and `"Final"`
  but not a complete enum).
- Whether NCAA team names come back as "School Mascot" (matches BBS,
  `resolveBbsTeamName()` already handles it) or school-only (also fine,
  takes the exact-match branch) - genuinely unverified either way.
- Whether the 100/day cap resets on a fixed calendar day or a rolling
  24h window - not stated in the docs pulled.

Because that last point was unresolvable from docs alone, the poll
throttle (`maybeFetchHighlightly()` in `worker.js`) was built to be
correct under EITHER interpretation instead of guessing: it tracks a
ROLLING 24-hour count in KV (`highlightly_poll_log`), which is always
<= what either a calendar-day or rolling-day cap would actually allow,
and separately backs off for an hour if a real response's
`x-ratelimit-requests-remaining` header ever comes back <= 5, regardless
of what our own counter thinks. Poll interval: every 10 minutes inside a
12:00 PM - 2:00 AM ET active window (checked via `Intl` against
`America/New_York` so it stays correct across the EDT/EST boundary,
verified with synthetic boundary timestamps - 11:59 AM ET false, 12:00
PM ET true, 1:59 AM ET true, 2:00 AM ET false). 14h window / 10min =
84 polls, under the 85-of-100 target with the same margin the handoff
asked for - no adjustment needed regardless of which reset model turns
out to be real, since the rolling-window cap enforces the ceiling either
way.

**Activation logic:** tertiary only - `maybeFetchHighlightly()` is only
even called after BOTH the BBS primary and secondary fail on the same
tick, and even then returns `null` immediately if `HIGHLIGHTLY_API_KEY`
isn't set (true today), so this ships completely harmlessly. **Next
step for a future session or the user directly: get a real Highlightly
key, `wrangler secret put HIGHLIGHTLY_API_KEY` in `live/`, then run one
real call against an in-progress game and fix the score-order guess
first** before trusting this path under real fire.

### Code changes

- `live/bbs_client.js`: added `fetchLegacyMatches()` (secondary, single
  request, no date loop).
- `live/highlightly_client.js`: new file, tertiary client + parser,
  fully inert without a key.
- `live/worker.js`: `pollAndCache()` now tries primary -> secondary ->
  throttled tertiary in order per tick instead of failing outright on
  the primary; the per-game loop now calls a source-specific parser
  first and resolves team names off the parsed, source-agnostic
  `home_name_raw`/`away_name_raw` fields instead of reading BBS's raw
  shape directly, so `gameIdentityKey()`/`STATUS_PRIORITY`/`mergeGames()`
  keep working unchanged no matter which of the three sources answered.
  Each published game now also carries `data_source`
  (`bbs_stored`/`bbs_legacy`/`highlightly`) for operational visibility.

### Verified in production, against the real still-live outage - not simulated

Local sanity checks first (Node script against real captured BBS
fixtures + a synthetic Highlightly-shaped object, both parsers, both
`resolveBbsTeamName()` paths, `norm()` variant handling, and the ET
active-window boundary math - all correct). Then a real
`wrangler deploy` (`powerswap-live-scores`, version
`a62bb791-60fe-4e93-b67a-b9bab5408888`), then `wrangler tail` caught a
REAL cron tick at 12:02:19 AM ET 2026-09-12 hitting the still-ongoing
primary 500 outage and falling through to the secondary automatically:

```
"*/2 * * * *" @ 9/12/2026, 12:02:19 AM - Ok
  (error) BBS /v1/stored/matches (date=2026-09-12) returned 500
  (error) BBS /v1/stored/matches (date=2026-09-11) returned 500
  (error) BBS primary (stored/matches) fetch failed: ... returned 500
  (warn) BBS primary down this tick - used /v1/matches secondary instead
```

Confirmed `GET /live` immediately after: **19 real games, all tagged
`"data_source":"bbs_legacy"`**, including
`Louisville 59-13 Villanova (finished)` and the rest of that day's
ranked-team slate - not the empty `{"updated_at":null,"games":[]}` the
site was showing before this session, and not a simulated test - this
is the actual production outage this whole build was meant to survive,
resolving itself live during the fix.

### What's left

Only Highlightly's real-key verification (flagged above) is outstanding
- everything else in this session is deployed and confirmed against
real production traffic. Once BBS's `/v1/stored/matches` recovers,
`data_source` should flip back to `"bbs_stored"` on its own with no
redeploy needed - worth a quick look at `/live` next session to confirm
that transition happens cleanly too.

## 2026-09-12 (later same day): real Highlightly key added - live-verified, one real bug caught and fixed

User found they'd used their Highlightly key on a different project and
got a fresh one for this one, and set it as `HIGHLIGHTLY_API_KEY` via
`wrangler secret put` in `live/`. Worth recording how that went, since
it wasn't clean:

- **First attempt stored an empty string.** `wrangler secret list`
  showed the key as present, but a temporary diagnostic route (added
  and removed same session, see below) reported `keyLen: 0` - the
  interactive prompt hadn't actually captured the pasted value. Root
  cause: `wrangler secret put`'s interactive prompt needs a real
  terminal (TTY); running it through this session's command relay
  doesn't reliably provide one.
- **Second attempt via the same relay didn't even show a prompt** before
  reporting success - same underlying TTY problem, worse symptom.
- **Fixed by having the user run it directly in their own terminal**,
  piping the value in instead of using the interactive prompt
  (`echo "key" | npx wrangler secret put HIGHLIGHTLY_API_KEY`, run from
  `live/` specifically - this repo has two separate `wrangler.toml`s,
  one per Worker, and the secret attaches to whichever one is nearest
  the current directory). Confirmed via the same length-only diagnostic
  (`keyLen` > 0, never the actual value) before spending any real quota
  on it.

**Real verification, once the key was actually in place** (~06:00 UTC,
temporary `/debug-highlightly` route added to `worker.js` for this,
calling the real `fetchHighlightlyMatches`/`parseHighlightlyMatch`
production code directly - not a separate ad-hoc check - then removed
before this entry was written):

- **Caught a real bug**: the docs pulled earlier said the NCAA filter
  param was `leagueName=NCAA`. A real call rejected that -
  `{"message":"property leagueName should not exist","statusCode":400}`.
  The correct param, confirmed with a real 200, is `league=NCAA`. Fixed
  in `highlightly_client.js`.
- **Auth and rate-limit headers confirmed real**:
  `x-ratelimit-requests-limit: 100`, `x-ratelimit-requests-remaining`
  decrementing normally across calls (100 -> 93 over this session's
  testing - each call, including the failed 400 ones, cost real quota,
  worth remembering next time this needs live debugging).
  `HIGHLIGHTLY_MAX_PER_ROLLING_DAY` (85) already gives 15 of slack for
  exactly this kind of debugging cost.
- **Team names confirmed "School Mascot" for NCAA too** - real examples:
  "Auburn Tigers", "Southern Miss Golden Eagles", "Ole Miss Rebels",
  "Charlotte 49ers", "LSU Tigers", "Louisiana Tech Bulldogs".
  `resolveBbsTeamName()`/`norm()` need no changes - confirmed, not just
  assumed from the shared convention with BBS.
  Real, populated kickoff times too (e.g. `2026-09-12T23:45:00.000Z` =
  7:45 PM EDT, matches the real broadcast window) - no BBS-style
  midnight-UTC placeholder seen here.
- **No duplicate-row problem seen** in a real 100-game pull (grouped by
  team pair, zero pairs appeared twice) - a real, different result from
  both BBS endpoints (which do have this problem). Sample size is one
  pull, so "assume it could still happen" stays the safer working
  assumption, but this is a genuinely better data point than a guess.
- `state.description` confirmed as `"Scheduled"` (capital S) for a
  pregame game - already handled correctly by the existing normalizer
  (lowercased before comparison).

**Still genuinely open** - every game in the real pull was pregame
(0-0, "Scheduled") at ~2 AM ET, before that Saturday's slate had
kicked off, so nothing observed could resolve this:
- **The score-string home/away order** (`"score.current": "N - M"`) -
  "0 - 0" can't distinguish it either way. This is still the single
  biggest real risk in this integration - see `highlightly_client.js`'s
  updated file header for exactly what to check the next time this path
  sees a live or finished score with unequal numbers.
- The in-progress/finished status vocabulary - only "Scheduled" seen for
  real so far.

Net result: Highlightly is now a real, working tertiary with one
confirmed bug fixed before it could ever bite in production (the
`leagueName` param would have made every real tertiary activation fail
with a 400, silently, exactly when the primary and secondary were
already down - the worst possible time to discover it). The one
remaining open item (score order) needs a live or finished game to
resolve - worth a deliberate re-check once Saturday's slate is
underway, using a real score with clearly distinguishable home/away
numbers.

## 2026-09-12 (later same day): BBS primary outage resolved; live quarter/OT shipped; sitewide font/card styling pass

**BBS `/v1/stored/matches` primary outage confirmed resolved.** User's
support ticket came back same-day saying it was on BBS's end and fixed;
independently verified here before trusting that: `live_payload` KV read
showed 21/22 games tagged `data_source: "bbs_stored"` (the lone
`bbs_legacy` entry was a finished game retained from before recovery,
not new), and a `wrangler tail` catch of a real cron tick showed
`outcome: "ok"`, `exceptions: []`, `logs: []` - the Worker only emits
`console.warn`/`console.error` on a fallback or failure, so an empty log
array on a real tick means primary answered cleanly. PROJECT_BIBLE.md
§9 updated to close this out; keeping an eye out since BBS outages have
recurred before.

**Live quarter/overtime now real, not guessed.** `parseBbsMatch()` had
carried an "UNVERIFIED - no in-progress example observed yet" comment
since day one because nothing was ever actually live during testing.
With real live games finally on (Texas A&M/Arizona State, Georgia/
Western Kentucky, etc.), added a temporary diagnostic
(`console.log("RAW BBS LIVE MATCH:", JSON.stringify(liveRaw))` in
`worker.js`, deployed, caught via `wrangler tail --format json`, then
reverted) and got two real raw records: James Madison/Wagner and
Virginia Tech/Old Dominion. Confirmed:
- `status` really does come back as `"live"`.
- No clock/time-remaining field exists anywhere on the raw object - full
  real key set is `id, sport, league, home, away, kickoff_utc, status,
  score, linescore, attendance, broadcast, round, has_odds`. Not
  unpopulated - genuinely absent. Not available from BBS, period.
- `linescore.home`/`linescore.away` are per-quarter score arrays whose
  LENGTH is the current quarter - verified by summing each array against
  `score` (matched exactly both times: JMU 66 = 21+21+24, Wagner 3 =
  3+0+0; VT 37 = 17+17+3+0, ODU 13 = 3+3+7+0 with Q4 just underway, 0
  points in it yet) - so a new array entry appears the INSTANT a quarter
  starts, not once it's scored in. Reliable, not a lagging indicator.

Shipped as `period = linescore length` in `bbs_client.js`, rendered by a
new shared `formatPeriodLabel()` in `site/app.js` (Q1-Q4, OT/2OT/etc.
past 4) used in both the rank-card badge and the Live Games section.

**Halftime deliberately NOT detected** - user's explicit call after
being told BBS's documented status enum is only
`scheduled|live|finished|cancelled` (no halftime value) and linescore
length can't tell "still Q2" from "halftime after Q2" (both length 2).
A live game just keeps showing `Q2` through the break rather than ship
a heuristic that could mislabel a stalled game as halftime.

Verified end-to-end in a real browser: local `http-server` preview
first, then confirmed again on the real production site
(`yetiblanc.com/powerswap-sports/site/`) after push, real quarters
showing on real live games.

**Sitewide font/card styling pass, done in two rounds per user
feedback:**
- `--font-mono` (`'Courier New', monospace`) disliked on sight -
  repointed the custom property itself to `var(--font-display)` rather
  than hunting down each of the 8 selectors using it (opponent/kickoff
  subtext, LINEAGE toggle, live badges, HAVOC/podcast labels, etc.) -
  one change point, sitewide, matches the ranked-team-name font
  everywhere at once.
- `.belt-team` (ranked team name on rank cards) 12px -> 14px, per user's
  request to see it slightly larger. Explicitly left open for further
  adjustment - user said this was a first look, not a final size.
- Round 1: `.belt-opponent` (kickoff/opponent subtext) hidden once a
  team's game is `in_progress`, via `renderLiveBadges()` (which already
  runs on its own poll cycle, separate from the full `renderRankings()`
  rebuild) - the belt-live badge right next to it already carries the
  opponent name, kickoff time is stale once the game has started. Had
  to add `.belt-opponent[hidden] { display: none; }` since the class
  already sets `display: block` unconditionally, which silently
  defeats the bare `hidden` attribute (unlike `.belt-live`, which has no
  competing `display` declaration and didn't need this).
- Round 2 (same feedback loop, next message): extended the same hiding
  to `"finished"` status too - the FINAL badge shows the same redundant
  info, so the once-live-only scope was really "once the belt-live badge
  has anything to say."
- `.live-game-status` (the "* LIVE * Q4" line in the Live Games column)
  bumped 10px -> 12px, user's call after seeing the font swap alone
  wasn't enough of a size bump for their taste.
- `live-game-flash` keyframes restructured: old version was `0%,100%:
  opacity 1, 50%: opacity 0.55` on a sine easing - technically only ever
  AT full opacity for an instant per cycle. Rebuilt as a 4s cycle with
  an explicit hold: `0%,50%: opacity 1` (flat 2s hold, two equal
  keyframe values = no interpolation happens between them), `75%:
  opacity 0.55`, `100%: opacity 1`. Verified for real in a live tab by
  sampling `getComputedStyle(el).opacity` every 0.5s - got three
  consecutive `1` readings before it dipped, confirming the hold
  actually holds rather than just touching 1 momentarily.

User said more style changes are likely in a future session - nothing
left open right now, just noting this area is actively being iterated
on, not a one-and-done pass.

## 2026-09-12 (later still): Miami/Florida A&M final missing - root-caused and fixed with real evidence, not guessed

User reported Miami's real Thursday final (77-7 over Florida A&M) wasn't
showing anywhere on the site. Investigated rather than assumed:

**Confirmed the game data was gone entirely, not just mis-rendered:** a
real `curl` of the production `/live` endpoint had no Miami/Florida A&M
entry at all - `kv_has_miami: false` via a temporary diagnostic (see
below).

**Root cause, traced through real evidence at every step, not
speculation:**
1. Re-read the earlier 2026-09-11 outage entry above with fresh eyes:
   it explicitly recorded `/live` returning a completely empty
   `{"updated_at":null,"games":[]}` that night - not stale data, an
   actually-empty KV key. That's the `expirationTtl` (600s =
   `KV_TTL_SECONDS`) lapsing because every tick during the primary-only
   failure window just `console.error`'d and `return`'d without ever
   calling `env.LIVE_KV.put()` - nothing was refreshing the TTL. That
   wipe took EVERYTHING retained down with it, including Miami's real
   77-7 final, which had been correctly captured earlier that same day
   (after that day's status-priority fix).
2. Added a temporary `/debug/miami` route to `worker.js` (deployed,
   queried, then removed) that called the real `fetchBbsMatches()` /
   `fetchLegacyMatches()` functions directly and filtered for Miami/
   Florida A&M. Confirmed BBS's `/v1/stored/matches` STILL has the real
   finished 77-7 record right now (twice, under two different ids - the
   same known duplicate-row pattern, both finished 77-7) - so the data
   was never actually gone from BBS, only from this Worker's own KV.
3. So why hadn't a normal poll re-discovered it since? This morning's
   "decouple today/yesterday" commit (see its own build-log entry)
   gates the primary's yesterday-date query on seeing a NOT-YET-FINISHED
   yesterday game already in the current KV payload. After the wipe,
   Miami's record wasn't in KV to trigger that - so the gate had no
   reason to ever query yesterday's date again, even though yesterday's
   bucket (BBS's 2-day window) still genuinely held the answer. A gate
   built on "do we have evidence we need this" can't recover once the
   evidence itself is the thing that got lost.

**Fix:** added a `yesterday_sweep_date` KV marker recording the last UTC
date on which a yesterday-INCLUSIVE primary fetch actually succeeded.
`includeYesterday` in `pollAndCache()` is now
`needsYesterdayQuery(previous.games) || lastSweepDate !== today` - forces
one guaranteed yesterday-inclusive primary query per UTC day regardless
of what the original gate sees, closing this exact blind spot, while
still avoiding the unconditional-every-tick cost the decoupling commit
was built to remove. The marker is only set when the PRIMARY succeeds
with yesterday included (the secondary/`fetchLegacyMatches()` doesn't
respect date-scoping at all, so its success can't confirm yesterday was
really covered - leaving the marker stale in that case means the next
successful PRIMARY tick will try the sweep again).

**Verified end-to-end through the real pipeline, not a manual KV
patch:** deployed, caught the very next real cron tick via
`wrangler tail --format json` (clean - `outcome: "ok"`, empty
`exceptions`/`logs`, meaning primary succeeded with no fallback),
confirmed `yesterday_sweep_date` was written (`2026-09-12`), confirmed
`curl`ing `/live` now returns Miami 77-7 Florida A&M finished, and
confirmed it renders correctly on the real production site after a hard
refresh (`FINAL 77-7 vs Florida A&M` on Miami's rank card, opponent
subtext correctly hidden per this session's earlier styling change).
Removed the temporary `/debug/miami` route and redeployed; confirmed
Miami's record survived that redeploy (it's real KV state now, not
dependent on the diagnostic).

**Broader lesson, added to PROJECT_BIBLE.md §7/§8:** any
"only do the expensive thing if we see evidence we need it" gate is
blind to the case where the evidence itself got lost - needs a periodic
unconditional fallback alongside the evidence-triggered one, not instead
of it.

## 2026-09-12 (still later): unified rank-card result format across all weeks - "Final: W/L Score" to the right, opponent always underneath

Follow-up to the Miami investigation above: user (correctly) flagged
that Week 1 and the current week rendered a finished game two different
ways - Week 1 baked the result into the opponent subtext ("VS. BALL
STATE · W 56-3"), while the current live week hid the opponent subtext
entirely and put "FINAL 77-7 vs Florida A&M" in the live badge instead.
Asked for one consistent look: opponent name always underneath, "Final:
W 41-13" / "Final: L 13-41" to the right of the team name, in black.

Implementation, `site/app.js`:
- New shared `formatFinalResult(teamScore, oppScore)` -> `"Final: W/L
  Score"`, used by both `formatLiveBadge()` (current-week live path) and
  a new block in `renderRankings()` (past-week static path).
- `renderRankings()`'s opponent line no longer embeds the result at all
  - just `"{vs./@} {opponent}"` - and separately, for a past week's
    `matchup.completed` entry, sets `.belt-live` directly to the Final
    text (since `renderLiveBadges()` never touches non-live weeks).
- Kickoff-time detail moved into its own inner `.belt-kickoff` span so
  it can be hidden independently of the opponent name - needed because
  the CURRENT week's static matchup file doesn't get `completed`
  backfilled until Monday, so without this split, a live/finished
  current-week game would keep showing its stale pregame kickoff time
  underneath even after the opponent name itself stayed correctly
  visible.
- `renderLiveBadges()` now returns immediately when not viewing the live
  week, instead of looping through every card and blanking `.belt-live`
  - that used to be harmless (past weeks never populated `.belt-live` at
  all), but now that `renderRankings()` sets real Final badges for past
  weeks, the old unconditional-hide behavior would have stomped them
  right back to blank on every poll tick.
- Removed the now-dead `.belt-opponent[hidden]` CSS override from this
  morning's earlier change (nothing hides the whole opponent span
  anymore, only `.belt-kickoff`, which needs no override).

Verified in a real browser (local static server, then production after
GitHub Pages' ~1 minute rebuild + edge-cache propagation caught up -
first post-push check still showed the old cached `app.js`, confirmed
real via `curl`, then re-checked and confirmed updated) against both
Week 1 (Ohio State "Final: W 56-3", Miami "Final: W 45-6" @ Stanford)
and Week 2's live mix (Georgia/Miami/Texas A&M "Final: W ..." with
opponent underneath; Oregon/Notre Dame still show the unchanged live
badge with opponent inline and no stale kickoff underneath).

---

## 2026-09-12 (even later): HAVOC now shows live-detected upsets as games go final

User noticed the season's first real upset didn't show up anywhere in
HAVOC and asked why.

**Root cause, confirmed by reading the actual pipeline, not assumed:**
HAVOC's `events-list` is driven entirely by `season_history.json`'s
backtested `events`, which only exist once `fetch_results.py` +
`backtest.py` run for a week. `season_history.json`'s `snapshots`
topped out at `week1` (0 events — week 1 was chalk, already known).
`data/cfb/seasons/2026/raw/week_02_games.json` didn't exist yet.
`.github/workflows/season-progression.yml`'s cron automation only
starts at Week 3 (first trigger 2026-09-20) — weeks 1-2 were called out
in that workflow's own comments as one-off manual backfills done
2026-09-08, before week 2's games were even played. So there is
currently no mechanism, automated or otherwise, that will pick up week
2's results on its own. Checked the real clock (`date -u`: Sat
2026-09-12 21:27 UTC = 5:27pm ET) against week 2's kickoff spread in
`week_02_matchups.json` and confirmed the slate wasn't even fully over
yet — running the real backtest right now would reproduce the exact
"phantom/partial week" bug reverted on 2026-09-08 (`38f5f56`), where
teams with unfinished games would incorrectly freeze as byes.

**User's call:** don't touch rankings until the real week-3-and-on
automation (or a manual run once week 2 is genuinely over) actually
processes them — but show a game as it goes final in HAVOC anyway if it
was an upset, sourced from the live feed rather than waiting days for
backtest.

**Built (`site/app.js`, `site/style.css`), display-only, no ranking-engine
changes:**
- `computeLiveUpsets()`: reuses the existing `isUnderdogLeading()` (it
  already only compares scores, no idea what `status` even is) filtered
  to `status === "finished"` instead of `renderLiveGamesSection()`'s
  `"in_progress"`. Gated to `isViewingLiveWeek()` only, same as every
  other live-feed consumer in this file.
- `liveUpsetCardHtml()` / `refreshHavocPanel()`: renders a red
  `event-card.live-upset` card (`Upset · Final` tag, same red as the
  existing in-progress `.upset` styling) and re-draws the HAVOC panel on
  both week navigation and every live-score poll tick (45s) via
  `fetchLiveScores()`, so a finished upset appears within one poll, no
  reload needed.
- Explicitly does NOT touch `currentSeasonData`/rankings/
  `season_history.json` — only the real swap engine is allowed to move a
  rank slot. Naturally self-retires per week: once that week's real
  backtest runs, `getLiveWeekKey()` rolls forward to the next week and
  the now-past week's tab shows its real `season_history.json` events
  instead — no manual cleanup path needed.
- Original version included a "Not yet official - rankings update once
  Week N is backtested" disclaimer line under each card; user asked to
  drop it same day (the HAVOC section context plus the red styling read
  as sufficiently provisional on their own). Removed.

**Verified live in Chrome against the real production live-scores
endpoint** (local static server serving the repo, `LIVE_WORKER_URL`
still pointed at the real deployed Worker — not a mock): first injected
a simulated finished upset to confirm rendering/class names, then the
real 45s poll tick overwrote it with genuine production data and
surfaced two REAL week-2 upsets on its own — unranked Oklahoma State
over #2 Oregon (39-31) and Michigan (#16) over #10 Oklahoma (17-10) —
both correctly styled, while both teams' actual rank-card slots stayed
completely unchanged (`#2 Oregon`, `#10 Oklahoma`, both showing their
real "Final: L" scores, no rank movement). Committed and pushed
(`cf0a68b`, then a follow-up commit for the disclaimer removal).

**Open item added:** week 2's real backtest is still pending as of this
entry — someone needs to run the manual pipeline (or dispatch
`season-progression.yml` with `week: 2`) once week 2's slate is fully
over, or rankings never move past week 1. Logged in PROJECT_BIBLE.md §9.
