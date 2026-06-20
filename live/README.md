# Live Scores - Dormant Scaffold

Nothing in this folder is deployed or running. It's a placeholder for the
live-scores/ticker work discussed and scoped out, kept here so it doesn't
need to be redesigned from scratch later.

**Status: not active. No cost is being incurred by anything in this folder.**

## Before activating this

1. Decide whether the $1-5/month CFBD Patreon cost is worth it (see the
   "Live Scores" section in the main README for the full breakdown).
2. Confirm the actual `/scoreboard` response shape against a real call -
   `worker.js` has several `UNBUILT`/`UNVERIFIED` placeholders that
   can't be filled in correctly without one.
3. Get a Cloudflare account set up (free tier should comfortably cover
   this given the low, consolidated write volume).

## What's here

- `worker.js` - scaffold for the Cloudflare Worker that would poll CFBD's
  live scoreboard and serve cached results + computed "PowerSwap stakes"
  to the site. Several pieces are explicitly marked `UNBUILT` - this is
  a starting point, not a finished service.

## Priority

Football backtesting comes first. This folder, and basketball's live
data, both wait until the core football pipeline is proven against real
season data.
