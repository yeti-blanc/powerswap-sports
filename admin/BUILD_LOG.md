# Admin Portal — Build Log

## Current status (2026-09-04, session in progress)

Built and deployed. `powerswap-admin` Worker is live, GitHub Actions
recompute pipeline verified end-to-end for real (see log below).
**Blocked on further testing** until the user sets three secrets that
require their own credentials (never invented here, per the playbook's
own standing rule): `ADMIN_PASSWORD_HASH`, `RESEND_API_KEY` +
`ADMIN_EMAIL`, `GITHUB_TOKEN`. Login, session, digest rendering, and the
Recompute button's Worker-side dispatch all sit behind auth, so none of
them are testable until at least `ADMIN_PASSWORD_HASH` exists. See
admin/README.md for exact setup steps.

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
- 2026-09-04: Stopped here - login, session persistence, digest
  rendering, and the Worker-triggered Recompute flow all require
  `ADMIN_PASSWORD_HASH` (and the latter also needs `GITHUB_TOKEN`) before
  any of them are reachable to test. Waiting on the user for these three
  secrets rather than skipping the verification the task asked for.
