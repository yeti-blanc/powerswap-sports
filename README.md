# PowerSwap Sports

An alternate-universe ranking system. Real Week 1 results set the path;
every week after that lives entirely inside its own universe. Currently
covers College Football (CFB) and College Basketball (CBB) as two
branches of the same brand, sharing one engine.

## Current Status (read this first)

**Active focus: football backtesting against real 2021-2025 seasons,
plus 2026 underway.** 2026's preseason AP Top 25 is seeded (real data,
`data/cfb/seasons/2026/`) - week 1 itself hasn't been played yet (starts
~2026-09-03), so there's no `week1` snapshot for 2026 until that's
fetched and backtested after the games finish. Everything else below is
built and present in the repo, but deliberately dormant until football
is sorted out:

- **Basketball (`sports/cbb/`)** - fully scaffolded, untouched by real
  data yet. `BASKETBALL_ENABLED = false` in `site/app.js` keeps it out of
  the site's sport selector (shown as "Coming Soon," not selectable) so
  it doesn't get tested or shown before football is solid. All the
  backend code still runs fine via CLI if you want to poke at it - the
  flag only affects the site.
- **Live scores (`live/`)** - deployed and active as of 2026-09-01.
  `LIVE_SCORES_ENABLED = true` in `site/app.js`. A Cloudflare Worker
  polls Big Balls Sports Data (BBS, a separate vendor from CFBD - free
  tier, no recurring cost) for games involving currently-ranked teams
  and publishes to KV for the site to read. CFBD is untouched - still
  final-results-only via the existing pipeline. See the "Live Scores"
  section further down and `live/README.md` for the full verified vs.
  still-UNVERIFIED breakdown (real in-progress game field names haven't
  been observed yet - no game was live when this was built).
- **Week 1 opponent preview (2026-09-02)** - each ranked team's rank
  card shows its Week 1 opponent and home/away (`vs. Team` / `@ Team`),
  from real CFBD schedule data. See "Week 1 Matchups" further down.
- **The current season's baseline displays as "Week 1," not
  "Preseason,"** until that season's real `week1` snapshot exists (see
  "Week 1 Matchups" below) - otherwise a "Preseason" label next to live
  in-game scores reads as stale.

Both flags live at the top of `site/app.js`. Flipping either to `true`
is the entire activation step on the site side - everything else needed
(actually building out `live/worker.js`, actually backtesting basketball
against real CBBD data) is separate, real work that hasn't happened yet.

## The Rules (identical across every sport)

1. **Baseline.** The preseason AP Top 25 sets the starting 25 rank slots.
   Week 1's real results get run through the swap logic against that
   baseline to produce the first PowerSwap rankings. After that, the AP
   poll is irrelevant — only PowerSwap results matter.

2. **Ranked vs. ranked.** If the winning team was ranked worse (a higher
   number) than the team it beat, they swap ranks outright. If the
   better-ranked team wins, nothing happens — chalk, no movement.

3. **Ranked vs. unranked.** If the unranked team wins, it takes the ranked
   team's slot completely. The beaten team has zero residual status. The
   only way back in is to beat a team that is *currently* in the PowerSwap
   top 25, whenever that happens.

4. **Unranked vs. unranked.** No effect, not tracked.

5. **Bye week / no game.** That rank slot is frozen exactly where it was.

Every rank slot carries a full lineage — every team that's ever held it —
so "who does #1 trace back to" is always answerable.

## Why One Engine Works for Both Sports

The swap engine (`core/swap_engine.py`) only ever sees a list of
`{"winner": ..., "loser": ...}` games and a week label. It has no idea
whether it's processing football or basketball, and it doesn't need to —
that's the whole point of keeping it in `core/`. Every sport-specific
detail (which API, what the games look like, how a "week" is even
defined) lives in `sports/<sport>/` and gets resolved into that same
plain shape before the engine ever sees it.

## The Real Fork: Football vs. Basketball

This isn't just "basketball has more games." The two sports' data APIs
are shaped differently in a way that actually matters:

- **CFBD (football)** organizes games by week number. "Give me week 7" is
  a real query. One game per team per week is the norm.
- **CBBD (basketball)** has no week concept for games — you query by
  `startDateRange`/`endDateRange` instead. A ranked team can easily play
  2-3 times in what we'd casually call "one week."

PowerSwap's answer: we define our own Monday-Sunday calendar week for
basketball, fetch whatever games fall inside it by date range, and —
critically — **sort those games chronologically before handing them to
the engine.** The engine processes games in list order and looks up each
team's current rank fresh for every game, so if Team A plays twice in one
week, the second lookup correctly sees the result of the first game. But
only if the games arrive in the order they actually happened. Out of
order, the engine produces a different, wrong season — silently, with no
error. `tests/test_multigame_week.py` proves both the correct behavior
and exactly how it breaks if the sort step is skipped. This is the single
most important thing to keep right if you ever touch `sports/cbb/fetch_results.py`.

Both sports use the **same CFBD_API_KEY** — basketball's API is run by the
same company (Rad Sports Analytics LLC) and explicitly supports using the
football key, just against a different base URL.

## Project Structure

```
powerswap-sports/
  core/
    swap_engine.py          Sport-agnostic. Shared by every sport, unchanged.
  sports/
    cfb/
      config.py              CFBD base URL, poll name, division filter
      team_norm.py            CFB-specific name normalization
      fetch_results.py        Week-number based fetching
      fetch_week1_matchups.py Week 1 opponent/home-away, display-only (see below)
    cbb/
      config.py               CBBD base URL, poll name (some fields UNVERIFIED - see below)
      team_norm.py             CBB-specific name normalization (separate team universe)
      fetch_results.py         Date-range based fetching, with chronological sorting
  scripts/
    backtest.py               Sport-agnostic. Takes --sport cfb|cbb.
  tests/
    test_swap_engine.py             Validates engine logic against known scenarios
    test_multigame_week.py          Proves multi-game-per-week ordering is correct
    generate_fake_season.py         Synthetic data for both sports, --sport flag
  data/
    cfb/seasons/<year>/...
    cbb/seasons/<year>/...
  site/                      Static site, sport + season + week selectors
  live/                      Live-scores Cloudflare Worker (deployed) - see live/README.md
  index.html                 Redirects GitHub Pages' root to site/index.html
  .nojekyll                  Stops GitHub Pages from Jekyll-processing this repo
```

**Season selector auto-rolls forward.** `site/app.js`'s `AVAILABLE_SEASONS`
is computed as a range (2021 through the current season, June 1 cutover)
rather than a hardcoded list, so the site defaults to the current season
every year with no code change needed - a season with no backtested data
yet just falls through to the existing "No backtested data for this
sport/season yet" state.

## Setup

```bash
pip install -r requirements.txt
```

Get a free key at https://collegefootballdata.com/key — it works for both
the football and basketball APIs.

```bash
export CFBD_API_KEY="your_key_here"
```

## Running a Football Backtest

```bash
python sports/cfb/fetch_results.py --season 2024 --preseason-poll
for week in $(seq 1 15); do
  python sports/cfb/fetch_results.py --season 2024 --week $week
done
python scripts/backtest.py --sport cfb --season 2024 --weeks 15
```

## Running a Basketball Backtest

Basketball needs one extra piece of information football doesn't: the
Monday on or before the season's actual first games, since "week 1" is
defined relative to that date, not by CBBD.

```bash
python sports/cbb/fetch_results.py --season 2024 --preseason-poll

# Replace with the real season-start Monday for that year - verify against
# an actual schedule, don't guess.
START=2023-11-06

for week in $(seq 1 18); do
  python sports/cbb/fetch_results.py --season 2024 --week $week --season-start-date $START
done

python scripts/backtest.py --sport cbb --season 2024 --weeks 18
```

## Testing the Engine and Pipeline (No API Key Needed)

```bash
python tests/test_swap_engine.py
python tests/test_multigame_week.py

# Full synthetic pipeline test for either sport:
python tests/generate_fake_season.py --sport cfb
python scripts/backtest.py --sport cfb --season 9999 --weeks 5

python tests/generate_fake_season.py --sport cbb
python scripts/backtest.py --sport cbb --season 9999 --weeks 5
```

## Conference Championships, Bowls, and the CFP

No special-casing, by design: a currently-ranked team playing in a
conference championship game, a bowl game, or the CFP is on the table to
swap or be dethroned exactly like any other game. A ranked team whose
conference has no championship game, or that isn't in a bowl/the
playoff, simply has no game that week and freezes - the same bye-week
rule that already applies everywhere else. Confirmed against real 2024
data: Georgia beating Texas in the SEC Championship is what makes Georgia
the correct final #1, not an edge case to filter out.

Conference championships need no special fetch step - CFBD already
returns them as the final week of the regular season (`seasonType:
"regular"`), so they come through the normal `--week 15` (or whatever the
final week number is) fetch automatically.

Bowls and the CFP DO need a separate fetch step, since they're a
different `seasonType` ("postseason") with no week-numbered structure:

```bash
python3 sports/cfb/fetch_results.py --season 2024 --postseason
python3 scripts/backtest.py --sport cfb --season 2024 --weeks 15 --include-postseason
```

A team can legitimately play multiple postseason games (advancing through
CFP rounds), so `fetch_postseason_games()` sorts everything chronologically
by date before saving - same reasoning, and same risk if skipped, as
basketball's multi-game weeks. `tests/test_multigame_week.py` has a
dedicated test for this exact scenario.

## Known Unverified Assumptions — Check These on First Real Use

Several details couldn't be confirmed against the live APIs from this
build environment (no network access to either CFBD or CBBD here). These
aren't guesses presented as fact — they're flagged explicitly so the
first real run catches them instead of trusting them blindly:

- **CFBD preseason poll tagging** can shift year to year. Spot-check the
  output against the real AP preseason poll before trusting it as the
  baseline.
- **CBBD poll name** — assumed to be `"AP Top 25"`, same as football.
  Unverified.
- **CBBD classification/division filter** — unclear whether `/games`
  needs an explicit D-I filter or returns it by default. Check the first
  real response for non-D-I teams showing up.
- **CBBD field names** (`homeTeam`, `awayTeam`, `homePoints`, `awayPoints`,
  `startDate`) — assumed to match CFBD's convention since it's the same
  vendor. Reasonable guess, not confirmed.
- **CBBD disambiguation names** like "St. John's (NY)" or "Saint Mary's
  (CA)" in `sports/cbb/team_norm.py` are guesses at how CBBD might
  disambiguate similarly-named schools. Verify against real data.

## Live Scores (Deployed 2026-09-01)

Live in-game scores and a status/score badge inline with the rankings,
for any currently-ranked team's game. Built, deployed, and smoke-tested
against real API data. Full detail (confirmed vs. still-UNVERIFIED
fields, what to check once a real game is live, next steps) lives in
`live/README.md` - this section is the short version.

**Vendor split:** CFBD stays exactly as before - final results only, via
the existing `fetch_results.py` → `backtest.py` pipeline, free tier, no
new cost. Live scores come from a separate vendor, **Big Balls Sports
Data (BBS)** (`bigballsdata.com`), also free tier (1,000 req/day, 2,000
on this GitHub-linked account) - no recurring cost for this layer either.

**Architecture:**

- Everything already built (engine, weekly backtest, GitHub Actions,
  GitHub Pages) stays exactly as-is. This is a separate, additive layer.
- A Cloudflare Worker (`live/worker.js`, deployed as
  `powerswap-live-scores`) polls BBS on a cron trigger (schedule lives in
  `live/wrangler.toml`, deliberately not the dashboard) for games
  involving currently-ranked teams only, filtered by reading the latest
  snapshot from `data/cfb/seasons/<year>/season_history.json` and
  matching BBS's team names against it via `live/team_norm.js` (a JS port
  of `sports/cfb/team_norm.py`'s normalization). Publishes one
  consolidated payload to Cloudflare KV.
- The site (`site/app.js`) polls that Worker's `/live` endpoint every 45s
  and renders an inline `● LIVE score vs opponent` / `FINAL score`
  badge on any ranked team's row. It never calls BBS directly - same
  "Bird Feeder" principle as everywhere else in this project.

**Still open:** BBS's real in-progress status string and where
clock/period/possession actually live on its response are UNVERIFIED -
no live game existed to check against when this was built (2026 season
week 1 starts ~2026-09-03). `live/bbs_client.js`'s `parseBbsMatch()` is
the one function to correct once a real game is observed.

## Week 1 Matchups (Added 2026-09-02)

Purely additive display data sitting alongside the rankings - never
touches `core/swap_engine.py` or the rankings pipeline. For each
currently-ranked team, shows their Week 1 opponent and whether they're
home or away, right on their rank card, in smaller text under the team
name (`.belt-opponent` in `site/style.css`). A team with no scheduled
game (bye) just shows its name, no broken/blank line.

```bash
export CFBD_API_KEY="your_key_here"
python sports/cfb/fetch_week1_matchups.py --season 2026
```

Follows the same pattern as `fetch_results.py` (same `cfbd_get` helper,
same `config.py`), reading ranked teams from the latest snapshot in
`data/cfb/seasons/<season>/season_history.json` and writing
`data/cfb/seasons/<season>/week1_matchups.json` for `site/app.js` to
fetch alongside `season_history.json` (best-effort - a missing file,
e.g. for basketball, just means no opponent line).

**Team-name normalization is load-bearing here, confirmed with a real
case, not just defensive boilerplate:** CFBD's `/games` schedule spells
it "Ole Miss," not the canonical "Mississippi." Without running it
through `team_norm.norm()` first, "Ole Miss vs Louisville" - an actual
ranked-vs-ranked game - would have silently looked like two byes
instead. Each team's card reflects its own home/away perspective
independently (Mississippi's card: `vs. Louisville`; Louisville's card:
`@ Mississippi`), computed straight from CFBD's real `homeTeam`/
`awayTeam` fields, not inferred.

Also confirmed against a real call: CFBD's `/games` `division=fbs`
query param does **not** actually filter the response (FCS/D-II/D-III
games came back mixed in with FBS). Didn't matter here - a ranked team
is always FBS regardless of what else is in the list - but don't assume
that param filters anything if you reuse this pattern elsewhere.

## Watch & Listen (Embeds Section)

`site/index.html` now has a "Watch & Listen" section with a YouTube embed
and a Spotify podcast embed, styled to match the rest of the site. Both
are placeholders right now (`VIDEO_ID` and `EPISODE_OR_SHOW_ID`) - swap
in the real IDs once the show exists. No backend, no API key, no cost -
this works the moment real IDs go in.

## Lessons Carried Over From the Cote Cup Project

**Team name normalization is non-negotiable.** football-data.org returned
inconsistent country name variants for the Cote Cup World Cup tracker, and
the fix was a `norm()` layer applied before any name touches the core data
structures. The exact same risk exists here, twice over — once per sport,
since each has its own team-name quirks. The failure mode is silent: a
real result just disappears, no error thrown. `sports/cfb/team_norm.py`
and `sports/cbb/team_norm.py` implement this, wired in at fetch time.

**The "Bird Feeder Model" is already the architecture here.** Visitors
never trigger a live API call — `fetch_results.py` and `backtest.py` do
all the CFBD/CBBD calls and write `season_history.json`; the static site
only ever reads that file. Same principle as the Cote Cup tracker, GitHub
Actions + static JSON instead of a Cloudflare Worker + KV.

**Secrets never go in the repo.** `CFBD_API_KEY` stays a local environment
variable for now, and a GitHub Actions repo secret once this moves to
automated weekly runs. `.gitignore` and `.env.example` are set up to make
committing a real key by accident harder.

## Lesson From 2026-09-01: Isolate Your Own Edits From Pending Local WIP

Real incident, not a hypothetical: a commit meant to add ~15 lines of
live-score CSS/JS instead swept in ~450 unrelated, uncommitted local
lines already sitting in `site/style.css`/`site/app.js` (a whole
color/typography redesign and a removed nav feature) - because the edit
was made directly on top of files that already had pending local
changes, then the whole file got committed. Got worse a few hours later:
a manual `git merge` combining that same local work with a separate
push kept one side's `app.js` entirely, silently dropping the live-score
JS and auto-season-range logic that had just been re-committed - and
separately exposed a pre-existing gap (a team-card feature whose JS and
CSS were both committed, but whose HTML markup never was), which broke
the site outright (empty dropdowns, one uncaught exception halting the
rest of `app.js`).

Two things to always confirm on it are worth it:
1. Before editing a file for one specific change, check
   `git diff origin/main -- <file>` - if it's already dirty with
   something unrelated, isolate your edit (e.g. reset to the last
   commit, make the edit, commit, then reapply the pending work) rather
   than committing the combined state.
2. After any merge - manual or automated - that touches `site/app.js`
   or `site/index.html`, actually load the site in a browser and check
   the console before trusting it. A clean `git merge` with no conflict
   markers is not the same as a working site: it just means git found
   no *textual* overlap, not that the result still runs.