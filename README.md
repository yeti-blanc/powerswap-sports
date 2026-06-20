# PowerSwap Sports

An alternate-universe ranking system. Real Week 1 results set the path;
every week after that lives entirely inside its own universe. Currently
covers College Football (CFB) and College Basketball (CBB) as two
branches of the same brand, sharing one engine.

## Current Status (read this first)

**Active focus: football backtesting against real 2021-2025 seasons.**
Everything else below is built and present in the repo, but deliberately
dormant until football is sorted out:

- **Basketball (`sports/cbb/`)** - fully scaffolded, untouched by real
  data yet. `BASKETBALL_ENABLED = false` in `site/app.js` keeps it out of
  the site's sport selector (shown as "Coming Soon," not selectable) so
  it doesn't get tested or shown before football is solid. All the
  backend code still runs fine via CLI if you want to poke at it - the
  flag only affects the site.
- **Live scores / ticker (`live/`)** - a scaffold, not a running service.
  `LIVE_SCORES_ENABLED = false` in `site/app.js` keeps the (otherwise
  inert) live-ticker code from doing anything. Has a real recurring cost
  attached ($1-5/month CFBD Patreon tier) that hasn't been decided on -
  see the "Live Scores" section further down before touching this.

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
```

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

## Live Scores (Not Built Yet — Research Done, Cost Confirmed)

Live in-game scores and a ticking clock are wanted for the eventual public
site, alongside a "Watch & Listen" section for the companion show. Neither
is built yet. Here's what's confirmed so far:

**Live scores are NOT free.** CFBD's free tier (1,000 calls/month) doesn't
include the `/scoreboard` endpoint at all - live game data requires a paid
Patreon tier:
- **Tier 1, $1/month, 5,000 calls/month** - unlocks the Live Scoreboard
  (real-time scores and updates). This is almost certainly enough for a
  score-and-clock ticker.
- **Tier 2, $5/month, 30,000 calls/month** - adds Live Play-by-Play, only
  needed if the ticker should show individual plays, not just score/clock.

This is a real recurring cost, however small - confirm comfort with an
ongoing $1-5/month subscription before building this layer, since it's a
different cost shape than everything else in this project (which is
either free or one-time).

**Whether the $1 tier's REST response includes clock/period fields
specifically is unconfirmed.** The GraphQL schema (Tier 3+) clearly has
`currentClock`, `currentPeriod`, `currentPossession` - very likely the
same underlying data is in the cheaper REST tier's response too, since
it's the same data model, but this needs to be checked against a real
response once a Patreon key exists.

**Planned architecture for this layer, once the above is confirmed:**

- Everything already built (engine, weekly backtest, GitHub Actions,
  GitHub Pages) stays exactly as-is. This is a separate, additive layer.
- A small Cloudflare Worker - the one piece of this whole project that
  would actually use Cloudflare - holds the Patreon-tier `CFBD_API_KEY`
  and polls `/scoreboard` roughly once a minute for games involving
  currently-ranked teams only (not the whole slate), caching one
  consolidated payload. This should comfortably fit Cloudflare's free
  Workers tier given the low write volume.
- The client polls that Worker every 30-60 seconds and locally
  interpolates the game clock between syncs (count down in JS, correct on
  the next sync) for a convincingly "live" feel without needing
  aggressive backend polling.
- The same Worker computes the "PowerSwap stakes" for each live game -
  what rank-swap would happen if the current score held - since it
  already has both the live score and the current rankings in hand. This
  is the actual differentiator for the ticker: not just "Bama is up 14,"
  but "if this holds, Bama swaps places with Oklahoma."

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
