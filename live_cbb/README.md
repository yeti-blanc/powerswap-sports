# Basketball live scores - `powerswap-cbb-live`

A standalone Cloudflare Worker, in its **own Cloudflare account**, separate
from football's `live/` Worker. Why, how it paces itself, and what it reads
are all in `worker.js`'s header; PROJECT_BIBLE.md §14 has the summary.

Until it's deployed, `site/app.js`'s `CBB_LIVE_URL` stays `null` and the
basketball view runs on the repo's 15-minute data alone (finals, swaps,
schedule - no in-game scores).

## One-time setup (the account owner does steps 1-2)

1. Create the new Cloudflare account (free plan) at dash.cloudflare.com.
2. In that account: **My Profile → API Tokens → Create Token →
   "Edit Cloudflare Workers" template**, scoped to the new account. Put it
   in `live_cbb/.env` (gitignored - never commit it):

       CLOUDFLARE_API_TOKEN=<token>
       CLOUDFLARE_ACCOUNT_ID=<new account id, from the dashboard URL/sidebar>

   Using a token in this folder (instead of `wrangler login`) keeps
   football's `live/` and `admin/` deploys on their existing login -
   the two accounts never get mixed up.
3. Create the KV namespace and deploy, from `live_cbb/`, loading that
   `.env` into the shell explicitly (don't rely on wrangler auto-loading
   it - if it silently didn't, the command would hit football's account):

       set -a; . ./.env; set +a
       npx wrangler whoami        # must show the BASKETBALL account
       npx wrangler kv namespace create LIVE_KV
       # paste the printed id into wrangler.toml, set account_id there too
       npx wrangler deploy
       curl https://powerswap-cbb-live.<subdomain>.workers.dev/health

4. Set `CBB_LIVE_URL` in `site/app.js` to `https://powerswap-cbb-live.<subdomain>.workers.dev/live`,
   commit, push.

## Verify (real evidence, not "it deployed")

- `npx wrangler tail` from `live_cbb/` during a ranked game: ticks log no
  errors; between games they return without calling ESPN.
- `curl .../live` during a game shows it `in_progress` with a score.
- Dashboard → Workers → powerswap-cbb-live → Metrics: CPU per invocation
  stays under the free tier's 10 ms (local measurement: 4.3 ms to parse a
  full Saturday slate).

## Tests

`node tests/test_cbb_live_worker.mjs` - real ESPN data, mocked fetch/KV.
