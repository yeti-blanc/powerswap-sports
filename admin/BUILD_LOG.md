# Admin Portal — Build Log

## Current status (2026-09-04, session in progress)

**Built, deployed, and verified live for everything except the actual
reset-password link itself** (sent for real via Resend; I don't have
access to the inbox it went to, so completing that one flow needs the
user). Everything else - login, session persistence across a real
refresh, the Havoc digest, Recompute through the real GitHub Actions
dispatch with the Worker's own token, versioned snapshots, logout/
revocation - confirmed with real evidence, in a real browser where
applicable. See the log below for exactly what was checked and how.

Temp password was set at the user's request (`Delta-Falcon-4987!` -
they'll change it via the forgot-password flow they specifically asked
to have built for this). `ADMIN_EMAIL` ended up needing to be
`yeti@yetiblanc.com`, not the address I'd defaulted to - Resend's free
tier can only send to the account's own verified address without a
verified sending domain, which the 403 response made concrete rather
than theoretical.

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

## Open item

The reset-password link itself (click the emailed link -> set a new
password -> log in with it) needs the user to actually check
yeti@yetiblanc.com and either complete it themselves or hand back the
token from the URL so this session can finish that one test.
