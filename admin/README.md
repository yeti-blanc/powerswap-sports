# PowerSwap Admin Portal

Single-admin portal modeled on PFPI's admin-portal playbook, with PFPI's
two-tier admin/commissioner split dropped - there's exactly one login.
See `admin/BUILD_LOG.md` for the full build history and design decisions.

## What's here

- `worker.js` - the Cloudflare Worker backend. Deployed as
  `powerswap-admin` at `https://powerswap-admin.yeti-f3c.workers.dev`.
  Separate Worker, separate KV namespace from `live/` - does not touch
  the live-scores Worker in any way.
- `config.js` - non-secret config the Worker imports (GitHub repo owner/
  name, the recompute workflow's filename).
- `wrangler.toml` - Worker config. KV binding + two non-secret vars
  (`ADMIN_PAGE_URL`, `RESEND_FROM`).
- `tools/hash_password.mjs` - **run this locally, never deployed.**
  Generates the value you paste into `wrangler secret put
  ADMIN_PASSWORD_HASH`. Your real password is typed at a masked prompt
  in your own terminal and never leaves it.
- The gated page itself is `site/admin.html`, on the existing static
  site (GitHub Pages) - same "static frontend + Worker API" split as
  `live/worker.js` + `site/app.js`.
- `.github/workflows/recompute-havoc.yml` - what the "Recompute" button
  actually triggers: a real run of `sports/cfb/fetch_lines.py` +
  `sports/cfb/havoc_rating.py` (the same code the CLI uses - no
  duplicate implementation), committed back to the repo.

## One-time setup

### 1. Set your admin password

```bash
node admin/tools/hash_password.mjs
cd admin && npx wrangler secret put ADMIN_PASSWORD_HASH
# paste the printed value when prompted
```

### 2. Session signing key

Already set (`SESSION_HMAC_KEY`, generated and stored during the build -
a random internal signing key, not tied to any external account, so
there was nothing to invent here).

### 3. Resend (password-reset email) - resend.com, free tier, no card

1. Sign up at resend.com.
2. Get an API key from the dashboard.
3. `cd admin && npx wrangler secret put RESEND_API_KEY`
4. `npx wrangler secret put ADMIN_EMAIL` - the address reset links get
   sent to.

Resend's free tier sends from `onboarding@resend.dev` without any domain
verification, as long as the recipient is the account's own verified
email - which is exactly this use case (single admin, resetting their
own password). If you want to send from your own domain instead, verify
it in the Resend dashboard and update `RESEND_FROM` in `wrangler.toml`.

### 4. GitHub token (for the Recompute button)

The Worker needs a token that can dispatch the recompute workflow and
read file contents/SHAs from this repo. **Deliberately not something I
generated for you** - a token with write access to your repo is a real
credential, and "never invent credentials" is a standing rule from the
PFPI playbook itself. Create a fine-grained PAT:

1. github.com/settings/personal-access-tokens/new
2. Resource owner: `yeti-blanc`. Repository access: **only**
   `powerswap-sports`.
3. Permissions: **Contents: Read and write**, **Actions: Read and
   write**. Nothing else.
4. `cd admin && npx wrangler secret put GITHUB_TOKEN`

### 5. CFBD_API_KEY as a GitHub Actions secret

Already set - this is the same key already used everywhere else in this
project, just added as a repo secret so the recompute workflow can use
it too (`gh secret set CFBD_API_KEY`, done during the build). No new
credential, just an existing one made available in a new authorized
place for this feature.

## Testing the Recompute pipeline directly (bypassing the admin UI)

```bash
gh workflow run recompute-havoc.yml --repo yeti-blanc/powerswap-sports -f season=2026 -f week=1
gh run watch --repo yeti-blanc/powerswap-sports
```

## KV schema (ADMIN_KV)

- `password_hash_override` - set by a successful password reset; takes
  precedence over the `ADMIN_PASSWORD_HASH` secret.
- `session:{token}` → `{expires_at}` - TTL'd, source of truth for
  session validity (not just the token's existence).
- `ratelimit:{ip}` → `{fail_count}` - TTL'd (1hr rolling window).
- `forgot_cooldown:{ip}` → `"1"` - TTL'd (5 min), throttles
  `/forgot-password` so it can't burn the Resend free-tier quota.
- `reset_token:{token}` → `{created_at}` - TTL'd (30 min), deleted on
  use (single-use).
- `recompute_pending:{season}:{week}` → `{before_sha, dispatched_at}` -
  TTL'd (10 min safety net), deleted once the recompute is detected done.
- `digest:{season}:{week}:v{N}` - a versioned digest snapshot. Never
  overwritten - Recompute always writes a new version.
- `digest:{season}:{week}:latest` → `{version}` - pointer to the current
  version.
