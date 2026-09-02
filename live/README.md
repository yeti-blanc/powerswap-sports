# Live Scores

**Status: deployed and active.** `LIVE_SCORES_ENABLED` is `true` in `site/app.js`.

## What's here

- `worker.js` - the Cloudflare Worker. Polls BBS (Big Balls Sports Data) on
  a cron trigger, filters to games involving currently-ranked teams, and
  publishes one consolidated payload to KV. Deployed as
  `powerswap-live-scores` at
  `https://powerswap-live-scores.yeti-f3c.workers.dev`.
- `bbs_client.js` - BBS API client + response parsing, isolated per the
  "confirmed vs. UNVERIFIED" split described in its own comments.
- `team_norm.js` - JS mirror of `sports/cfb/team_norm.py`'s `NORM`/`norm()`,
  plus `resolveBbsTeamName()` for matching BBS's "School Mascot" naming
  against season_history.json's school-only names.
- `wrangler.toml` - Worker config. Cron schedule (`*/5 * * * *`) lives here
  deliberately, not in the Cloudflare dashboard - see the comment in that
  file for why.
- `fetch_live_scores.py` / `bbs_config.py` - local Python dev/diagnose
  tools (`--diagnose`, `--ranked-check`). Not used by the deployed Worker.

## Vendor split (as decided 2026-09-01)

- **CFBD** stays exactly as before: final results only, via the existing
  `sports/cfb/fetch_results.py` → `scripts/backtest.py` pipeline. No new
  subscription, no Patreon tier - this task didn't touch any of that.
- **BBS (Big Balls Sports Data)** is the live-score vendor. Free tier:
  1,000 req/day, 2,000/day on this GitHub-linked account.
  `https://bigballsdata.com` / `https://bigballsdata.com/docs/introduction`
  / `https://bigballsdata.com/ncaaf-api`.

An earlier draft of this file (and `worker.js`) described a different,
CFBD-Patreon-based live-score plan. That's superseded - CFBD is not used
for live data at all now.

## Confirmed vs. UNVERIFIED (as of 2026-09-01)

Confirmed with a real authenticated call to `GET /v1/matches?sport=american_football&league=ncaaf`:

- `home`/`away` shape: `{ name, short_name, logo_url }`, `name` is always
  `"<School> <Mascot>"` (e.g. "Rutgers Scarlet Knights").
- `status: "scheduled"` with `score: null`, `linescore: null`.
- `status: "finished"` (confirmed via MLB/EPL games as a same-schema proxy
  - no NCAAF or other game was actually live at check time) with
  `score: { home, away }` and `linescore: { home: [...], away: [...] }`.
- Every response so far, for every sport/league tried (NCAAF, NCAAF-FCS,
  MLB, EPL), carries `meta.note: "Upcoming matches served from the stored
  table (no live adapter covers this sport/league; refreshed by ingest)"`.
  That's not NCAAF-specific boilerplate - it showed up identically across
  every sport tested. It suggests the **free tier may not have a true
  low-latency live feed at all** (BBS's own marketing describes WebSocket
  push as a paid-plan feature). This is why the Worker polls more
  conservatively (every 5 min + in-worker sub-polls every 20s during a
  game window) than the originally-targeted "~15s", and why `worker.js`'s
  `SUBPOLL_*` comment flags this as worth re-checking.
- Team-name matching (`resolveBbsTeamName`): verified against 10 real team
  names from the diagnose call, including the tricky abbreviation case -
  BBS's "UCF Knights" correctly resolves to CFBD's canonical "Central
  Florida" via `team_norm.js`'s existing `UCF -> Central Florida` entry.

**Still UNVERIFIED - no real example seen yet, first real chance is when
2026 week 1 kicks off (~2026-09-03):**

- The actual in-progress status string (`bbs_client.js` guesses `"live"` /
  `"in_progress"` / `"in progress"` / `"playing"` - none confirmed).
- Whether/where `period`/`clock`/`possession` actually live on the match
  object, or under different key names entirely.
- The real refresh cadence behind "refreshed by ingest" - i.e. whether
  polling faster than that cadence buys any actual freshness.

`parseBbsMatch()` in `bbs_client.js` is deliberately permissive: it never
assumes a field is present, and passes through `raw_status` untouched so
a wrong guess is visible in the published payload rather than silently
dropped. When a real in-progress game is observed, correct the guessed
key names there - that's the only function that should need to change.

## Testing done tonight (2026-09-01)

- Deployed via `wrangler deploy`; `/health` and `/live` respond correctly.
- Confirmed the cron trigger fires on schedule and correctly does nothing
  (zero BBS calls) because `data/cfb/seasons/2026/season_history.json`
  doesn't exist yet - no 2026 backtest has been run. This is expected,
  not a bug: nothing is ranked yet, so nothing should be polled.
- Verified `resolveBbsTeamName()` and `parseBbsMatch()` against the real
  diagnose response (10 real BBS games, incl. the UCF case above) with a
  local Node script.
- Verified the full site rendering path (inline `● LIVE` / `FINAL` badge
  on a ranked team's row) by temporarily seeding the real production KV
  with a synthetic in-progress/finished pair and loading the actual site
  JS/CSS against it in a browser. Confirmed visually, then let the next
  cron tick overwrite the test data with the real (empty) state.
- Caught and fixed a real bug during overnight unattended running: the
  KV entry's TTL (180s) was shorter than the cron interval (5 min), so
  `/live` briefly fell back to an empty default between ticks even though
  polling was working correctly. Fixed by raising `KV_TTL_SECONDS` to 600
  and confirmed the fix in production - watched a real KV write survive
  past the point (~3 min in) where the old TTL would have expired it.
- **Not yet possible:** end-to-end verification against a real live game,
  since the 2026 season hasn't started. Re-run
  `python live/fetch_live_scores.py --diagnose` once games are live
  Thursday and fix any UNVERIFIED field names in `bbs_client.js` based on
  what comes back.

## Secrets

`BBS_API_KEY` and `CFBD_API_KEY` are set as Worker secrets via
`wrangler secret put` (account: yeti@yetiblanc.com). Neither is in any
committed file. `CFBD_API_KEY` is currently unused by the Worker (no
finality cross-check wired up yet - see "Next steps").

## Update (2026-09-02): 2026 season_history.json now exists

`data/cfb/seasons/2026/season_history.json` was seeded the same day
this was written (real preseason AP Top 25, no `week1` snapshot yet -
games haven't been played). The Worker's cron should now actually be
polling BBS for these 25 teams instead of skipping (it was skipping
entirely before, correctly, since nothing was ranked). Not yet
re-verified against a real BBS response for these specific teams -
next session should check `/live` reflects something once games start
Wednesday/Thursday.

Also worth knowing: a manual `git merge` the same night briefly dropped
`site/app.js`'s live-score JS entirely (kept the other branch's version
wholesale). It was re-added on top of the current `app.js` and re-
verified in a real browser, but if `LIVE_SCORES_ENABLED`/`fetchLiveScores`/
`renderLiveBadges` ever look missing from `site/app.js` again, check
recent merge commits first before assuming the Worker side broke - see
the main `README.md`'s "Lesson From 2026-09-01" section.

## Next steps for the next session

1. Watch `/live` during a real ranked-team game (starts ~2026-09-03) and
   fix `bbs_client.js`'s UNVERIFIED guesses (in-progress status string,
   clock/period/possession field names) based on what actually comes back.
2. Consider whether the CFBD finality cross-check (README/handoff
   mentioned this as an optional extra safety check before treating a
   game as truly final) is worth adding - `CFBD_API_KEY` is already set
   as a Worker secret (rotated 2026-09-02), just unused.
3. Re-evaluate `SUBPOLL_INTERVAL_MS`/`SUBPOLL_BUDGET_MS` in `worker.js`
   once real in-progress-game refresh behavior is observed - they're
   currently a conservative guess (see "Confirmed vs. UNVERIFIED" above).
