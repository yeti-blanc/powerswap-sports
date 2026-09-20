# PowerSwap Sports — Project Bible

**Read this first, before `README.md`, before `admin/BUILD_LOG.md`, before
touching any code.** This is a synthesized handoff doc, not a chronological
log — it exists so a new chat session can get fully oriented without
re-reading (or re-learning the hard way) everything below. It was written
2026-09-12 by summarizing the project's actual history, so treat "today"
references relative to that date.

This file is a *summary*. It does not replace the detailed logs — when you
need the full evidence behind a claim here, `admin/BUILD_LOG.md` has it,
dated and with real request/response evidence. Update THIS file when a
standing rule changes or a major new subsystem ships; keep dated blow-by-blow
detail in `BUILD_LOG.md`.

---

## 1. What this is

An alternate-universe college sports ranking system. Real Week 1 results set
the starting path; every week after that lives entirely inside its own
universe of swap rules (see §2). Two sports share one engine: College
Football (CFB, **active**) and College Basketball (CBB, **built but
dormant** — `BASKETBALL_ENABLED = false` in `site/app.js`, shown as "Coming
Soon" until football is fully solid).

Live site: GitHub Pages, static. Two separate Cloudflare Workers run
alongside it (live scores, admin portal) — see §5.

## 2. The Rules (identical across every sport, never touched without the user's explicit sign-off)

1. **Baseline.** Preseason AP Top 25 sets the starting 25 slots. Week 1's
   real results run through the swap logic against that baseline to produce
   the first PowerSwap rankings. After that, the AP poll is irrelevant.
2. **Ranked vs. ranked.** Lower-ranked (higher number) team wins → they swap
   ranks outright. Better-ranked team wins → chalk, no movement.
3. **Ranked vs. unranked.** Unranked team wins → takes the ranked team's slot
   completely; the beaten team has zero residual status. Only way back in:
   beat a team currently in the PowerSwap top 25.
4. **Unranked vs. unranked.** No effect, not tracked.
5. **Bye week / no game.** Slot freezes exactly where it was.
6. **Week-label convention (fixed 2026-09-13, real AP-poll convention):**
   the ranking shown on "Week N"'s tab is the ranking that GOVERNED week
   N's games — i.e. produced by week N-1's real results — never the
   ranking week N's own games just produced. Week 1 IS the baseline (the
   untouched preseason poll); a change from week N's games first becomes
   visible on week N+1's tab, with week N+1's own (upcoming) schedule
   underneath it. `scripts/backtest.py` implements this by labeling the
   snapshot/events produced by applying real week W's games `"week{W+1}"`,
   not `"week{W}"`. See §12's 2026-09-13 entry for the full before/after
   and every file this touches (`backtest.py`, `site/app.js`,
   `live/worker.js`'s `getCurrentWeekNumber()`).

Every rank slot carries full lineage (every team that's ever held it).
Conference championships and CFP/bowls are NOT special-cased — a ranked team
in a championship/bowl/playoff game is on the table to swap exactly like any
other game (confirmed real: Georgia beating Texas in the 2024 SEC
Championship is what makes Georgia the correct final #1).

## 3. Why one engine works for both sports

`core/swap_engine.py` only ever sees `{"winner": ..., "loser": ...}` plus a
week label — no sport awareness at all. Every sport-specific detail lives in
`sports/<sport>/` and gets resolved into that shape before the engine sees
it.

**The one thing that will silently corrupt a season if you get it wrong:**
the engine processes games **in list order** and looks up each team's
current rank fresh per game. If a team plays twice in a "week" (routine for
basketball, possible for CFP/bowls), the games MUST be sorted chronologically
before being handed to the engine, or the second lookup sees the wrong
pre-game rank — wrong, but with no error thrown. `tests/test_multigame_week.py`
proves both correct behavior and exactly how it breaks without the sort.
Both `sports/cbb/fetch_results.py` and CFB's postseason fetcher already do
this sort; preserve it in anything new that can produce multiple games per
team per week.

## 4. Non-negotiable standing rules

These came from real incidents, not caution for its own sake. Each has a
"why" so you can judge edge cases, not just follow blindly.

1. **Team name normalization happens at ingestion, before any data touches
   core structures.** `sports/cfb/team_norm.py`, `sports/cbb/team_norm.py`
   (Python, engine-facing) and `live/team_norm.js` (JS port for the
   Cloudflare Worker, which can't import Python) all implement this. *Why:*
   the Cote Cup World Cup tracker lost real results silently because
   inconsistent name variants meant a match never got matched — no error,
   the result just vanished. Same class of risk here, doubled (once per
   sport, and again for whichever live-score vendor's own naming quirks).
   Every new data source (BBS, Highlightly, CFBD) needs its raw team names
   run through `norm()`/`resolveBbsTeamName()` before the swap engine or the
   live-score dedup logic ever sees them.
2. **No secrets in the repo, ever.** Cloudflare Worker secrets
   (`wrangler secret put`), GitHub Actions repo secrets, or local `.env`
   (gitignored) only. Never invent a credential on the user's behalf — if a
   token/key is needed, ask for it or have the user generate it themselves.
3. **`finished` always outranks `in_progress` when deduping or merging any
   two records that might disagree about a game's status** — across BBS's
   own duplicate records, across primary/secondary/tertiary sources, and in
   the site's own client-side dedup. *Why:* a real incident (2026-09-11) had
   this backwards for weeks and caused an already-finished game (77-7) to
   keep showing as live with a stale score (63-0) for over an hour, because
   BBS itself serves two duplicate records per game under different IDs that
   don't always sync at the same time, and the stale `in_progress` one won
   every poll. A game can never un-finish, so `finished` must always win.
   Current priority order everywhere this matters:
   `{finished: 3, in_progress: 2, scheduled: 1, unknown: 0}`. This exists in
   THREE places that must all stay in sync: `live/worker.js`'s
   `STATUS_PRIORITY`, `live/highlightly_client.js`'s status normalizer, and
   `site/app.js`'s `LIVE_STATUS_PRIORITY`.
4. **Bird Feeder Model, everywhere.** Visitors never trigger a third-party
   API call, directly or indirectly. A Worker or GitHub Action polls on its
   own schedule and writes to KV/a committed JSON file; the static site (or
   a visitor's browser) only ever reads that already-fetched data. This
   applies to CFBD (via `fetch_results.py`/`backtest.py` → committed JSON),
   BBS/Highlightly (via `live/worker.js` → KV), and everything else. Never
   add a code path where a page load causes a live third-party API call.
5. **Anything a public Worker endpoint returns is public, full stop — "not
   rendered in the UI" is not the same as "not exposed."** `/live` is the
   exact URL the site's own JS fetches directly (no backend proxy), so any
   field in that JSON is visible to anyone who opens devtools' Network tab
   or just curls the URL. (Real incident, fixed 2026-09-12: `data_source`
   was in that payload — harmless data, but the principle generalizes to
   anything sensitive.) If something needs to be visible only to the admin,
   it needs to go through the separate, authenticated `admin` Worker/KV, not
   the public live-scores payload.
6. **Verify with real evidence before calling anything "confirmed" or
   "working."** A real HTTP request/response, a real `wrangler tail` catch,
   a real browser session — never "this looks right" or a doc summary taken
   at face value. This project's entire build log is full of cases where the
   plausible-looking answer was wrong (see §8's "AI-summarized docs" entry).
   If something can't be verified (e.g., no API key exists yet), say so
   explicitly rather than reporting it as confirmed.
7. **Don't spend real money or create new external accounts/subscriptions on
   the user's behalf autonomously**, even under a broad "make any judgment
   call" grant — e.g., CFBD's live endpoints need a paid Patreon tier; that
   decision was left to the user, not made unilaterally.

## 5. Architecture map

```
powerswap-sports/
  core/swap_engine.py          Sport-agnostic ranking engine. Rarely touched.
  sports/
    cfb/   config.py, team_norm.py, fetch_results.py,
           fetch_week1_matchups.py, fetch_week_matchups.py (generalized,
           per-week, added 2026-09-08), fetch_lines.py, havoc_rating.py
    cbb/   config.py, team_norm.py, fetch_results.py (date-range + sort)
  scripts/backtest.py           Sport-agnostic, --sport cfb|cbb
  tests/                        test_swap_engine.py, test_multigame_week.py,
                                 generate_fake_season.py
  data/cfb/seasons/<year>/...   season_history.json (the site's data source),
                                 week1_matchups.json, raw/week_NN_matchups.json,
                                 raw/week_NN_games.json
  site/                         Static site (GitHub Pages). app.js, index.html,
                                 admin.html (gated admin UI), style.css
  live/                         Cloudflare Worker "powerswap-live-scores" —
                                 live in-game scores. See §6.
  admin/                        Cloudflare Worker "powerswap-admin" — single-
                                 login admin portal + Havoc-rating "Recompute"
                                 button (dispatches a real GitHub Actions run,
                                 doesn't reimplement the scoring in JS).
                                 See admin/README.md + admin/BUILD_LOG.md.
  .github/workflows/
    season-progression.yml      Auto-populates weeks 3-13 + championship week
                                 (Sun/Mon 6 AM ET). Bowls/CFP NOT covered —
                                 deliberate, still manual.
    recompute-havoc.yml         workflow_dispatch only, triggered by the
                                 admin portal's Recompute button or gh CLI.
```

**Two separate Cloudflare Workers, two separate `wrangler.toml`s** (`live/`
and `admin/`) — a `wrangler secret put`/`wrangler deploy` must be run from
the correct directory or it attaches to (or fails against) the wrong Worker.
They share nothing except both reading from this same GitHub repo's raw
files for some data.

**Season selector auto-rolls forward** — `AVAILABLE_SEASONS` in `site/app.js`
is a computed range, not a hardcoded list, so no code change is needed each
new year.

## 6. Live scores: redundancy architecture (built 2026-09-12, ESPN corrected and wired as primary + DUAL-CADENCE polling added 2026-09-19/20 - see the dated updates at the end of this section)

Built after a real BBS outage (`/v1/stored/matches` returning 500 on every
call, still ongoing as of this writing) left the site with zero live-score
updates for hours — one data source was the actual root cause, not a bug in
how that source was handled.

**Tried in this order, every poll (`live/wrangler.toml`'s cron fires every
1 minute as of 2026-09-20, but that's a DUAL-CADENCE floor, not the actual
poll cadence — see this section's 2026-09-20 update below):**

1. **Primary: ESPN's unofficial scoreboard** (`live/espn_client.js`
   `fetchEspnMatches()`). No key, no signup, no published rate limit — see
   this section's 2026-09-19 (later) update for the full story: an initial
   403-from-Cloudflare-only reading was WRONG (assumed an IP block); the
   real cause was a User-Agent WAF rule, fixed by sending `curl/8.14.1`
   instead of a browser UA, and re-verified working from real Cloudflare
   edge traffic before being wired back in here.
2. **Secondary: BBS `/v1/stored/matches`** (`live/bbs_client.js`
   `fetchBbsMatches()`). 2 requests/tick (today + yesterday UTC date).
   `BBS_API_KEY` secret. Real confirmed cap: 500/day (not the 2,000/day its
   own docs claimed — see this section's 2026-09-19 update). Only hit on
   ticks where ESPN fails, so real daily volume against this account is now
   well under that cap.
3. **Tertiary: BBS `/v1/matches`** (`fetchLegacyMatches()`, added
   2026-09-12) — the OLD endpoint this client moved off of back on
   2026-09-04. Same account/key as #2 (not independent of a platform-wide
   BBS outage, but real and verified working: status transitions promptly,
   identical schema/naming convention, same duplicate-row issue as #2 —
   handled by the same dedup logic since it's source-agnostic). 1
   request/tick, no date param needed, tagged `data_source: "bbs_legacy"`
   internally (KV only — see rule 5 above, this is stripped from the public
   response).
4. **Quaternary: Highlightly** (`live/highlightly_client.js`, added
   2026-09-12) — only tried when ESPN and both BBS endpoints fail on the
   same tick. Genuinely independent vendor. Throttled separately from the
   outer cron: rolling 24h count in KV (`highlightly_poll_log`), capped at
   85 of the free tier's 100/day, ~1 poll/10min, active only 12pm–2am ET.
   Backs off an hour early if a real response's rate-limit-remaining header
   ever drops ≤5. `HIGHLIGHTLY_API_KEY` secret (real key added 2026-09-12).
   **Endpoint**: `GET https://american-football.highlightly.net/matches?league=NCAA&date=YYYY-MM-DD`,
   header `x-rapidapi-key`. Real bug already caught and fixed: the param is
   `league=NCAA`, NOT `leagueName=NCAA` as the vendor's own docs page said
   (see §8's "AI-summarized docs" lesson — this was caught by making one
   real test call, not by re-reading docs harder).

**CFBD was investigated as a secondary/tertiary candidate and parked, not
adopted:** real endpoints exist (`GET /scoreboard`, `GET /live/plays`,
confirmed via CFBD's actual OpenAPI spec, NOT the third-party doc that named
a different, wrong endpoint), but both return real 401s against the
project's existing free-tier `CFBD_API_KEY` — `/scoreboard` needs Patreon
Tier 1+, `/live/plays` needs Tier 2+. Would be the better pick on
independence grounds (truly separate vendor from BBS) if the user ever adds
a paid CFBD key — revisit then.

**Still genuinely unverified (flagged loudly in `highlightly_client.js`'s
file header, not glossed over):**
- Highlightly's `score.current` field is a combined string (`"21 - 7"`), not
  separate home/away integers. Which side is home vs. away is UNCONFIRMED —
  every game checked so far was still 0-0/pregame. The code guesses
  "home - away." **This is the single biggest live risk in the whole
  redundancy build** — a wrong order fails silently (a confidently-wrong
  score), not loudly. Verify the next time this path serves a live/finished
  game with an unequal score, ideally a lopsided one.
- Highlightly's in-progress/finished status vocabulary — only `"Scheduled"`
  confirmed real so far.
- Highlightly's reset window (calendar-day vs. rolling 24h) — not stated in
  their docs, not resolved by testing (not enough time/calls elapsed). The
  throttle is built to be safe under either interpretation, so this doesn't
  block anything, just isn't definitively known.

**Every published game carries `data_source`** (`bbs_stored`/`bbs_legacy`/
`highlightly`) in the KV-stored payload for internal debugging (`wrangler
tail`, direct KV read) — **deliberately stripped from the public `/live`
HTTP response** (see rule 5). There is currently no admin-side UI for this;
it's "captured" only via KV/tail, which the user has explicitly said is
sufficient for now.

**Live quarter/OT display (added 2026-09-12, confirmed against real games):**
`game.period` is derived in `parseBbsMatch()` (`live/bbs_client.js`) from
BBS's `linescore.home`/`linescore.away` arrays — their LENGTH is the current
quarter. Verified against two real in-progress games caught via a temporary
diagnostic log during the first live tick after the primary outage recovered
(James Madison/Wagner, Virginia Tech/Old Dominion): each array's sum matched
`score` exactly, and a new (initially 0) entry appears the instant that
quarter starts, not only once it's scored in — so the length is reliable,
not a lagging indicator. `site/app.js`'s `formatPeriodLabel()` renders 1-4 as
`Q1`-`Q4` and anything higher as `OT`/`2OT`/etc. **`game.clock` (time
remaining) is confirmed ABSENT from BBS entirely** — the raw record's full
field set is `id/sport/league/home/away/kickoff_utc/status/score/linescore/
attendance/broadcast/round/has_odds`, nothing clock-shaped exists on it, on
either `/v1/stored/matches` or `/v1/matches` (same schema). **Halftime is
deliberately NOT detected** — BBS's documented status enum is only
`scheduled|live|finished|cancelled` (no halftime value), and linescore
length can't distinguish "still Q2" from "halftime after Q2" (both length
2) — a live game just keeps showing `Q2` through its halftime break rather
than risk a heuristic-based mislabel. User's explicit call: skip it rather
than guess.

**UPDATE 2026-09-19 — BBS's real cap is 500/day, not 2,000. ESPN tried as
a free replacement and reverted the same day after a real production
test; BBS stays primary with a corrected cadence.** Trigger: the user
checked BBS's real account dashboard and found it capping requests at
500/day, not the 2,000/day its own docs (`live/README.md`, `bbs_client.js`,
`bbs_config.py` — all written 2026-09-01 from BBS's docs, never verified
against a real request-volume test) claimed for a GitHub-linked account —
the user's own words: "I can't support a bait and switch." Full evidence
trail is in `admin/BUILD_LOG.md`'s 2026-09-19 entry; summary:

- **BallDontLie evaluated and ruled out** as a free-tier BBS replacement —
  not a rate-limit problem (5 req/min would've been fine), a plan-tier
  lockout: a real authenticated call confirmed `Games` returns 401 on the
  free tier while `Teams` returns 200 with the same key, matching their
  docs' tier-access table exactly. Games is the only endpoint with
  anything score/status-related, so free tier can't do what BBS does at
  any price point below their $9.99/mo ALL-STAR tier.
- **ESPN's unofficial scoreboard endpoint**
  (`https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard`)
  tested instead — no key, no signup. From a plain dev machine, real 200s
  with real live data, confirmed to return MORE than BBS ever did (a real
  populated clock, plain-integer period, team names already in BBS's
  "School Mascot" convention). Wired in as primary (`live/espn_client.js`,
  new file) and deployed.
- **REVERTED ~15 minutes after deploying**, once real production traffic
  was checked with `wrangler tail`: every single tick got a real,
  deterministic 403 from ESPN — not intermittent, and NOT a header issue
  (added a full browser User-Agent + Referer, redeployed, still 403 on
  every tick). The identical request succeeds from a plain dev machine.
  ~~Near-certain cause: ESPN's WAF blocking Cloudflare's own egress IP
  range outright.~~ **CORRECTED later the same day (2026-09-19) — this
  conclusion was WRONG.** The real cause is a User-Agent WAF rule, not an
  IP block: the only thing this test varied was network (Cloudflare vs.
  dev machine) while holding the UA constant at "looks like a browser,"
  which can only ever prove "this combination is blocked," never isolate
  which half of it matters. See this section's 2026-09-19 (later) update
  below for the real isolating test (same network, different UAs) and the
  fix. **This is still the load-bearing lesson, just corrected**: testing
  `parseEspnMatch()` and even the full `pollAndCache()` pipeline locally
  (real network calls, correct output) was NOT sufficient verification,
  because "correct output" and "reachable from the actual production
  network" are two different claims — the local test only checked the
  first. The site was never actually down during this window: the
  fallback chain caught the 403 immediately and BBS covered every tick
  silently, exactly as designed — but "primary" was non-functional in
  name only for those ~15 minutes, and BBS was still absorbing 100% of
  the real load against the very cap this was meant to relieve.
- `espn_client.js` was kept in the repo at this point (real, verified-
  working code against a non-Cloudflare origin) for a future poller that
  doesn't run inside a Cloudflare Worker — **superseded the same day, see
  the 2026-09-19 (later) update below: it's back in `worker.js`, fixed,
  as PRIMARY.**
- **State as of this entry (BBS restored as primary, corrected cadence) —
  superseded later the same day, see below**: `live/worker.js`'s fallback
  chain was restored byte-identical to the pre-2026-09-19 verified-working
  version (confirmed via `git diff` before redeploying — only comments
  changed). Cadence corrected: `live/wrangler.toml`'s cron moved from
  `*/2 * * * *` (720 ticks/day) to `*/6 * * * *` (240 ticks/day) — the
  most frequent interval that keeps the documented worst case (both dates
  queried every tick) under the real 500/day cap: 480/day worst case (96%
  utilization, ~4% headroom), 240/day floor (the common case). This is
  deliberately thinner headroom than the old 2,000-cap design's ~28% — the
  user's explicit instruction was the most frequent cadence the real cap
  allows, not preserved caution.

**UPDATE 2026-09-19 (later same day) — the IP-block conclusion above was
wrong; real cause is a User-Agent WAF rule; ESPN fixed and wired back in
as PRIMARY.** Full evidence trail: `admin/BUILD_LOG.md`'s
"ESPN's 403 root-caused to a User-Agent WAF rule" entry. Summary:

- Diagnostic testing ESPN from Google Cloud (Cloud Functions, then Apps
  Script after a billing-account blocker) got 403 too — briefly looked
  like it confirmed cloud IPs in general are blocked.
- Testing User-Agent as its own isolated variable broke the case open:
  real `curl` calls from a residential machine, same endpoint — `curl`'s
  own default UA and `python-requests`'s own default UA both got real
  200s with real data; a Chrome UA, PowerShell's default UA, Node's
  default UA, Firefox's UA, and no UA at all all got 403 — **from the same
  residential IP**. Not IP-based at all.
- Confirmed directly on real Cloudflare infrastructure via
  `wrangler dev --remote` (real edge execution): `curl`/`python-requests`
  UAs → real 200 with 321KB of live data; the Chrome UA `espn_client.js`
  had been using → 403, identical network and code path otherwise. This
  directly falsifies the earlier IP-block read.
- Google Apps Script's `UrlFetchApp` re-tested with an explicit
  `curl/8.14.1` header for completeness — still 403 either way. Left
  unresolved and flagged as unrelated to the Cloudflare fix (Apps Script
  isn't part of this project's real architecture).
- **Fixed**: `espn_client.js`'s UA changed to `curl/8.14.1` (Referer header
  dropped too — never load-bearing). **Wired back in as PRIMARY** in
  `worker.js`'s fallback chain, BBS `/v1/stored/matches` pushed to
  secondary, BBS `/v1/matches` to tertiary, Highlightly to quaternary.
  Deployed and confirmed live via a real KV read after the next cron tick:
  `data_source: "espn"` on every game, `id` fields prefixed `espn:`,
  populated `clock`/`possession` fields BBS never had.
- Cron cadence itself left UNCHANGED at this point (`*/6 * * * *`) —
  ESPN publishes no rate limit, but deliberately not polled faster just
  because it's free; see the 2026-09-20 DUAL-CADENCE update below for
  where that changed.

**UPDATE 2026-09-20 — DUAL-CADENCE: live games now poll every ~30s
instead of every 6 minutes, idle cadence unchanged.** Explicit user
request for near-real-time updates during live games (an initial ask for
literal 10s was corrected down to ~30s by real platform constraints,
surfaced before building anything — full math in
`admin/BUILD_LOG.md`'s 2026-09-20 entry and in `live/wrangler.toml`'s
own comment block). Summary:

- Two hard constraints ruled out literal 10s on the free tier: Cloudflare
  Cron Triggers can't fire faster than once/minute (no seconds field
  exists), and Workers KV's free tier caps at 1,000 writes/day, where
  `pollAndCache()` does exactly one write per poll.
- The UTC day-boundary reset (00:00 UTC = 8pm ET in-season) lands in the
  MIDDLE of a real Saturday slate, splitting one long live window into two
  shorter ones that each get a fresh 1,000-write budget — this is real and
  meaningfully improves the achievable cadence, not a rounding footnote.
  Worked out to a ~34.3s ceiling for the tighter of the two segments;
  landed on 30s with margin.
- **Mechanism** (`live/worker.js`, `live/wrangler.toml`): cron now fires
  every 1 minute (the new floor, not the cadence itself).
  `runScheduledTick()` checks whether any ranked-team game's LAST OBSERVED
  status (from KV, never a predicted kickoff time) is `in_progress`: if
  not, only 1 in 6 ticks actually polls (preserves the exact pre-change
  ~240-poll/day idle volume); if so, polls twice per tick ~30s apart via a
  plain in-Worker sleep. Cold start defaults to IDLE (not live) — the
  off-season's permanently-empty KV state would otherwise run the fast
  path 24/7 for weeks before week 1.
- Deployed and confirmed running (`/health`, cron registered as
  `* * * * *` in deploy output, a real post-tick KV read showing a fresh
  timestamp). **Not yet observed firing under a real live game** — built
  and verified during a quiet window with no `in_progress` ranked game;
  the live/idle branch and real ~30s cadence still need a real live-game
  observation, ideally via `wrangler tail`. See §9.
- **Verified before AND after deploying, not just unit-tested:**
  `parseEspnMatch()` tested against real live data (74 events, 0 missing
  team names) before wiring in; full `pollAndCache()` run locally against
  a mock KV with real network calls (22 real ranked-team games correctly
  resolved) before the first deploy; `wrangler tail` against real
  production traffic caught the 403 within minutes of that deploy: the
  header-fix attempt was ALSO verified live via `wrangler tail` before
  being judged a dead end. After reverting, `git diff` confirmed the
  restored chain matches the last known-good commit exactly, and a final
  ~8-minute `wrangler tail` sample confirmed two real ticks 6 minutes
  apart, both succeeding cleanly on BBS with no errors, while `/live`
  kept serving real visitor traffic uninterrupted throughout the entire
  episode.

## 7. Known BBS data quirks (apply to BOTH `/v1/stored/matches` and `/v1/matches`)

- **Duplicate records under different IDs for the same real game.** Routine
  and pervasive, not a one-off (6-8+ matchups per Saturday observed). The
  fix is `gameIdentityKey()`, keyed on whichever side is a CURRENTLY-RANKED
  team (stable across naming changes), plus the `finished`-wins priority
  rule (§4.3) — never key dedup on the raw name pair, and never assume the
  first/only record for a game is authoritative.
- **Team names are "School Mascot"** (e.g. "Rutgers Scarlet Knights"), not
  the school-only form CFBD/`season_history.json` use. `resolveBbsTeamName()`
  in `live/team_norm.js` strips this via prefix-matching against currently-
  ranked canonical names, with an explicit "different school" qualifier list
  (Tech/State/A&M/etc.) to avoid "Georgia Tech" false-matching ranked
  "Georgia." An unranked opponent's name has no ranked-team match to key
  off — it's resolved via that week's CFBD-sourced opponent name instead
  (see `getCurrentWeekOpponents()`), NOT via BBS's own `short_name` field
  (confirmed unreliable — sometimes an abbreviation code like "UTU").
- **`kickoff_utc` is sometimes a real BBS placeholder** (midnight UTC on the
  query date), not a real scheduled time. Caused a real quota incident once
  (see §8) when timing logic trusted it. Any timing-sensitive logic should
  prefer CFBD's real kickoff time (`week1_matchups.json`/
  `week_NN_matchups.json`) over BBS's own `kickoff_utc`.
- **`/v1/stored/matches` only returns today's + yesterday's UTC date** — a
  finished game ages out of a fresh fetch after ~2 days even though it
  really happened. Handled by `mergeGames()`: a fresh fetch's results always
  win, but anything from the previous KV payload not superseded by a fresh
  entry for that same ranked team is retained **permanently** (not
  time-boxed — an earlier 7-day-TTL version was explicitly wrong per the
  user: a completed score should never disappear, and a future week can't
  leak early since BBS won't return it before it's real either way).
  **This permanent retention is exactly what caused the 2026-09-20
  client-side staleness bug below** — a team can now carry two
  `"finished"` entries in the same payload (last week's real final and
  tonight's), which the client wasn't prepared to disambiguate. See §8's
  "stale live-score badges" entry for the fix.
- **The whole `live_payload` KV entry can be silently wiped, not just
  individual games, if EVERY source fails for longer than
  `KV_TTL_SECONDS` (600s = 5 cron ticks).** A failed tick just `return`s
  without writing to KV, so nothing refreshes the TTL — confirmed real
  during the 2026-09-11 outage (before the secondary existed): `/live`
  was observed returning a completely empty `{games:[]}`, not stale
  data. Real incident, 2026-09-12: Miami's real 77-7 final over Florida
  A&M was wiped this way, and then never re-discovered, because
  `needsYesterdayQuery()`'s gate only re-queries yesterday when it
  already sees an unfinished-yesterday game in KV — it can't tell
  "yesterday's fully accounted for" apart from "we have zero memory of
  yesterday." Fixed by a `yesterday_sweep_date` KV marker
  (`live/worker.js`) that forces yesterday's date back into the primary
  query at least once per UTC day regardless of what the gate sees —
  the permanent-retention promise above only holds for a game that
  actually made it into KV at least once since the last wipe; this
  sweep is what gives a wiped-and-still-BBS-recoverable game a daily
  second chance.

## 8. Mistake log — real incidents, condensed (full evidence in `admin/BUILD_LOG.md`)

Read this before touching `live/` or `site/app.js`'s live-score code —
several of these are easy to reintroduce by "fixing" one code path without
realizing there's a sibling path with the same bug.

- **Backwards status priority** (`in_progress` beat `finished`) caused an
  already-finished 77-7 game to show as live 63-0 for over an hour. Existed
  in BOTH `live/worker.js` and `site/app.js` as separate constants that had
  to be fixed together. → Rule in §4.3.
- **Dedup keyed on raw team-name pairs** broke the instant a display-name
  fix changed how an unranked opponent's name was computed — old and new
  spellings no longer matched as "the same game," doubling the payload
  (37→72 games in one real incident). → Key on the ranked team's stable
  canonical identity instead, never the raw pair.
- **Hardcoded `WEEK1_MATCHUPS_URL`** was used for opponent-name lookup
  regardless of which week was actually live. Invisible while week 1 was the
  only week with games; broke the instant week 2 started (Miami's badge
  showed Stanford — its week-1 opponent — during a real week-2 game against
  Florida A&M, with the live score attached correctly but the wrong name).
  → Always compute the current week dynamically (`getCurrentWeekNumber()`),
  and share one `season_history.json` fetch between the ranked-teams lookup
  and the current-week lookup rather than two assumptions that can drift.
- **A worker-side data fix doesn't automatically fix every UI consumer of
  that data.** The Miami bug above was masked on the rank-card badge (which
  already had an opponent cross-check from an earlier fix) but shown
  uncontested on the separate "Live Games" section (which didn't have that
  same guard yet). → When adding a live-data guard/cross-check, check every
  place that reads the live payload directly, not just the one you're
  actively fixing. (`gameMatchesExpectedWeek()` is now shared between both
  render paths for exactly this reason.)
- **Poll-faster-when-a-game-looks-live subpoll architecture made daily
  request volume unpredictable** and once burned 1,602/2,000 of a daily
  quota by 6:45 AM because ~14 games carried a placeholder `kickoff_utc`
  that made the subpoll logic think they were live all night. → Realized
  BBS's `/v1/stored/matches` returns the WHOLE day's slate in one call
  regardless of query specificity, so request volume only needs to depend on
  poll FREQUENCY, never on game count or timing. Replaced with one flat poll
  per fixed-interval cron tick — the math becomes exact and provable
  (`ticks/day × requests/tick`), not a runtime guess needing a safety net.
  Apply this same principle to any future rate-limited polling design.
- **`wrangler kv key get` defaults to `--local`** and will silently return
  stale local-dev-persisted data that looks exactly like a real production
  bug. Always pass `--remote` when debugging what's actually live.
- **`gh` CLI's active account drifts** between two logged-in accounts on
  this machine (the user switches between projects), causing `git push` to
  403 with "permission denied to The-Greg-Cote-Show" — not a real
  permissions problem. Fix: `gh auth switch --user yeti-blanc`, then retry
  the push. Happens periodically; not a bug, don't over-investigate it,
  just fix and retry.
- **`wrangler secret put`'s interactive prompt needs a real terminal (TTY)**
  — running it through an AI session's command relay (e.g., Claude Code's
  `!` prefix) can silently accept empty input and report success anyway.
  Confirmed twice on the Highlightly key (stored empty, then didn't even
  prompt). Fix: have the user run it in their own terminal directly, piping
  the value in (`echo "key" | npx wrangler secret put NAME`) rather than
  using the interactive prompt through any relay. Verify by checking length
  only (never the value) via a temporary diagnostic if unsure.
- **A clean `git merge` is not proof of a working site.** No textual
  conflict just means git found no line-level overlap — it doesn't mean the
  result still runs. A real merge once silently dropped all the live-score
  JS from `site/app.js` while merging cleanly. → Always load the real site
  in a browser and check the console after any merge touching `site/app.js`
  or `index.html`.
- **Editing a file that already has unrelated uncommitted changes risks
  sweeping them into your commit.** A ~15-line intended change once became a
  ~450-line commit that included someone else's in-progress redesign,
  because the edit was made on top of already-dirty files. → Check
  `git diff origin/main -- <file>` before editing; isolate if it's already
  dirty with something unrelated.
- **CFBD's `division=fbs` query param on `/games` does NOT actually filter**
  — confirmed real (FCS/D-II/D-III rows come back mixed in). Harmless for
  ranked-team matching (a ranked team is always FBS regardless), but don't
  assume that param filters anything if reused elsewhere.
- **AI-summarized vendor documentation can be wrong even when pulled from
  the vendor's own real docs page**, not just from third-party marketing
  copy. Two real examples in one session: (1) a doc-summary tool returned a
  plausible-but-wrong CFBD endpoint name (`/live/games` instead of the real
  `/live/plays`) even when reading CFBD's own OpenAPI spec — caught by
  fetching the raw JSON directly instead of trusting the summary. (2) A
  Highlightly docs page returned a SOCCER-shaped example object
  (`"First half"`/`"penalties"`) while claiming to describe the American
  football API. → Never trust a summarized doc pull as the final word before
  shipping — make one real test call against the actual API before treating
  a param name, header, or field shape as confirmed.
- **Rate-limited/metered third-party APIs charge quota even for failed
  (400/401) requests**, not just successful ones — confirmed on Highlightly
  (100/93 remaining after a handful of debugging calls, several of which
  were 400s from a wrong param name). Be economical when live-debugging
  against any metered API; don't loop trial-and-error calls carelessly.
- **The public `/live` endpoint is exactly what visitor browsers fetch
  directly** — a field not rendered in the UI is still fully exposed via
  devtools/curl. `data_source` was in that payload until caught and fixed
  2026-09-12. → See rule §4.5.
- **A self-limiting gate built on "have we already seen evidence we need
  this?" can't recover from having lost the evidence.** The
  today/yesterday query decoupling (2026-09-12 morning) gated yesterday's
  BBS query on seeing an unfinished-yesterday game already in KV — safe
  in general, but blind to a game whose record was already wiped (by the
  KV-TTL issue above) before the gate could ever see it. Real result:
  Miami's true 77-7 final over Florida A&M silently stayed missing for
  a full day even though BBS still had it. → See §7's KV-wipe entry for
  the fix (a daily forced sweep, independent of what the gate observes).
  General lesson: a "only do the expensive thing if we have evidence we
  need it" optimization needs a periodic unconditional fallback too, not
  just an evidence-triggered one — evidence itself can go missing.
- **Stale live-score badges hid tonight's real finals behind an old
  retained game, fixed 2026-09-20.** Real symptom the user caught: ~10
  ranked teams' cards (Texas, Ohio State, Michigan, Oklahoma, Mississippi,
  LSU, Texas Tech, Houston, SMU, Louisville) stayed stuck showing a
  pregame kickoff time hours after their real week-3 game had gone final,
  while ~15 other ranked teams updated correctly. Root cause:
  `site/app.js`'s `fetchLiveScores()` collapses `payload.games` to one
  entry per team, tie-breaking equal-`LIVE_STATUS_PRIORITY` entries by
  array position ("later index wins") — a rule written back when the only
  way a team could have two entries was same-vendor same-game duplicates
  (see the "Backwards status priority" entry above). §7's permanent-
  retention design (added later) made that assumption stale: a team can
  now carry TWO real, distinct `"finished"` games at once — last week's
  and tonight's — and the retained old one happened to sit later in the
  array than the fresh fetch, so it won the tie and overwrote tonight's
  result. `gameMatchesExpectedWeek()` (§4.1-adjacent guard, unrelated fix)
  correctly caught the resulting mismatch and hid the badge rather than
  show the wrong score — which is why the symptom was a stuck kickoff
  time, not a visibly wrong number, and why it looked like a subset of
  cards simply "hadn't updated." Fixed by adding `isNewerLiveGame()`: ties
  now break on `kickoff_utc` recency instead of array order. Verified live
  in-browser against the real production `/live` payload (not just read)
  by patching the tie-break in a live console session before committing:
  all 10 affected teams resolved to their real tonight's final once fixed,
  confirmed again after redeploy. → General lesson, same shape as the
  self-limiting-gate entry above: a dedup/collapse rule's tie-break needs
  to be re-examined every time an assumption it was built on changes —
  here, "a team only ever has one finished game in the feed at a time"
  quietly stopped being true the day permanent retention shipped, and
  nothing forced a re-check of the code that assumed it.

## 9. Current open items (as of 2026-09-13, plus dated additions below)

- **DUAL-CADENCE live-game polling (~30s during live games) — DEPLOYED
  2026-09-20, NOT YET OBSERVED UNDER A REAL LIVE GAME.** See §6's
  2026-09-20 update and `admin/BUILD_LOG.md` for the full mechanism and
  write-budget math. Built and verified during a quiet window (no
  ranked-team game `in_progress` at deploy time) — the `runScheduledTick()`
  live/idle branch, the real ~30s effective cadence, and actual KV write
  volume during a live window all still need a real observation, ideally
  via `wrangler tail` open during a live ranked-team game.
- **`live/worker.js`'s `getCurrentWeekNumber()` fix — DEPLOYED
  2026-09-13.** `wrangler deploy` run from `live/` after explicit user
  confirmation; version `df22ed40-c5d0-43e2-83db-06616e76697a`. `/live`
  confirmed still serving real traffic post-deploy. The week-number
  logic itself can't be exercised by real traffic until a live game
  exists to trigger opponent-name resolution - genuinely unverified
  until Week 3's Thursday/Friday games start, not just unconfirmed out
  of caution.
- **`sports/cfb/fetch_week_matchups.py`'s `get_ranked_teams()` had its
  own real bug, found 2026-09-13 the same day** — see §12's dated entry.
  Fixed and the real `week_02_matchups.json` regenerated; confirmed live
  in production via a direct curl of the deployed JSON (not just the
  scratch-copy browser check) - Oregon's opponent/final-score line now
  shows correctly.
- **BBS `/v1/stored/matches` primary outage — RESOLVED 2026-09-12.**
  Confirmed via BBS support directly (their side, not a code bug) and via
  real evidence here: KV payload and a caught cron tick both show
  `data_source: "bbs_stored"` with clean `outcome: "ok"` / no fallback
  warnings. No action needed; keep an eye out since BBS outages have
  recurred before.
- **Highlightly score-string home/away order — unverified.** See §6. Needs a
  real live/finished unequal score to confirm; check this before fully
  trusting the tertiary path under real fire.
- **CFBD live endpoints — blocked by Patreon tier, parked.** Revisit only if
  the user decides to pay for a Tier 1+ (scoreboard) or Tier 2+ (live plays)
  subscription.
- **Bowls/CFP season progression is still manual** — `season-progression.yml`
  deliberately does not cover it (user's explicit call, to be tackled
  separately later).
- **Basketball (`sports/cbb/`) is fully built but untouched by real data** —
  several CBBD field-name/poll-name/filter assumptions in `README.md`'s
  "Known Unverified Assumptions" section need checking on first real use.
- **No admin-side UI for `data_source` or other live-scores internals** —
  intentionally not built (user's explicit call — KV/`wrangler tail`
  visibility is sufficient for now). Revisit only if asked.
- **Week 2's first-ever scheduled fire (2026-09-13, 6 AM ET) never ran —
  confirmed real via the GitHub API (zero runs, ever, for this workflow),
  everything else about the trigger checked out as correctly configured.
  Cron minute shifted from `:00` to `:05` sitewide as a permanent hedge
  (GitHub's own docs name top-of-hour as the highest-congestion window
  for scheduled-workflow delays) — not a confirmed root cause, just the
  most likely one left standing. Manually backfilling week 2 via
  `workflow_dispatch` is still pending the user's explicit go-ahead
  (writes real season data + pushes to `main` — Claude Code's auto-mode
  blocked doing this unprompted). See `admin/BUILD_LOG.md`'s 2026-09-13
  entry for the full elimination process.**
- **Week 2's real backtest is now automated too (fixed 2026-09-12,
  same day as the item above was first written).** User caught that
  `season-progression.yml`'s cron list started at Week 3
  (2026-09-20) with no trigger at all for the Sunday right after week
  2's own games (2026-09-13) — week 2 had only ever been left manual
  because it hadn't been played yet when the workflow was built
  2026-09-08, not for any date-safety reason (the schedule audit from
  that same build already covered week 2 and found it clean of Sunday/
  Monday games). Added `cron: "0 10 13 9 *"` (Sun 2026-09-13, 6:00 AM
  EDT) plus the matching `09-13) WEEK=2` case — same mechanics as every
  other week's trigger. Once it fires, week 2's real results (including
  today's upsets - unranked Oklahoma State over #2 Oregon, Michigan
  over #10 Oklahoma) become official `season_history.json` events, and
  the site's Week 3 preview shows the resulting new rankings. §12's
  HAVOC live-upset cards still exist for the pre-backtest window (a live
  upset the moment it goes final, evenings before Sunday) but are no
  longer covering for a missing automation - they're a genuine "faster
  than the weekly cadence" preview now, not a stopgap.

## 10. Where to look for what

- **"Why does the live-score code do X?"** → `live/worker.js`,
  `live/bbs_client.js`, `live/highlightly_client.js` inline comments are
  extremely detailed and dated — read them before assuming something's a bug.
- **"Has this exact thing happened before?"** → `admin/BUILD_LOG.md`,
  full chronological history with real evidence for every incident summarized
  in §8 above.
- **"What are the swap rules / project fundamentals?"** → `README.md`.
- **"How does the admin portal work / what's its KV schema?"** →
  `admin/README.md` + `admin/BUILD_LOG.md`.
- **"What's deployed where?"** → §5/§6 above; `live/wrangler.toml` and
  `admin/wrangler.toml` are the sources of truth for cron schedules (kept
  there deliberately, not the Cloudflare dashboard, so `wrangler deploy`
  can't silently drift from what's documented).

## 11. Collaboration notes for whoever picks this up next

- The user (yeti-blanc / yetiblancmusic@gmail.com) expects real verification,
  not plausible-sounding claims — see rule §4.6. This has been the single
  most consistent thread across the entire build history.
- Full autonomous permission is sometimes explicitly granted for a scoped
  task (e.g., an overnight build) — respect the stated scope exactly, don't
  expand it, and still don't take hard-to-reverse or costly actions (new
  paid subscriptions, external account creation) without asking first even
  under a broad grant.
- `gh auth switch --user yeti-blanc` before any push that 403s — this is
  user-driven account switching on their machine, not a bug to chase.
- When in doubt about scope (build vs. just report; commit vs. leave staged;
  fix vs. flag), the user has consistently preferred being told clearly what
  is and isn't verified over being told a rosier-sounding summary.

## 12. Site styling conventions (`site/style.css`/`site/app.js`, started 2026-09-12)

The user is actively iterating on the rank cards / Live Games look —
treat this as ongoing, not finished, and expect more requests like these:

- **One font, not three.** `--font-mono` (used to be `'Courier New',
  monospace`) is now just `var(--font-display)` — the user disliked
  Courier New on sight and wanted it gone sitewide. If a new element
  needs a distinct font again, don't silently reintroduce a third
  family; ask, since the user has explicitly gone the other direction
  once already. `--font-body` (Arial) is still separate, used for
  regular text.
- **A `hidden`-attribute toggle needs a matching `[hidden]` override if
  the element has its own `display` declaration.** `.belt-opponent`
  sets `display: block` unconditionally, which would silently defeat
  the bare `hidden` attribute — relevant again if `.belt-opponent`
  itself is ever hidden in the future (it isn't currently — see next
  bullet). `.belt-live` and `.belt-kickoff` don't need an override since
  neither has a competing `display` rule. Check for this whenever
  toggling `.hidden` on a new element that already has its own
  `display`.
- **SUPERSEDED 2026-09-12 (same day, later request): rank-card opponent
  name now ALWAYS shows underneath, every status, every week** — the
  earlier "hide `.belt-opponent` once live/finished" behavior was
  reversed. Only the KICKOFF-TIME portion hides now, and it's split into
  its own inner `<span class="belt-kickoff">` for exactly that reason
  (`renderRankings()` builds `.belt-opponent` as `"{vs./@} {opponent}<span
  class="belt-kickoff">...</span>"`). The result (once known) shows
  separately, to the right of the team name in `.belt-live`, as `"Final:
  W 41-13"` / `"Final: L 13-41"` (`formatFinalResult()`) — never
  repeating the opponent name there anymore. `renderLiveBadges()` now
  returns immediately for a non-live week instead of looping through and
  blanking every card's `.belt-live` — a past week's Final badge is set
  once, directly in `renderRankings()` from the static
  `matchup.completed`/`team_score`/`opponent_score` fields, and must be
  left alone by the live-poll code. This is why the static matchup
  file's own `completed` flag not updating mid-week (it's only backfilled
  by Monday's batch run) matters: `.belt-kickoff` is what
  `renderLiveBadges()` hides once the LIVE feed (not the static file)
  says a current-week game has gone `in_progress`/`finished`, so the
  kickoff clock doesn't stay stuck showing a stale pregame time once the
  game has actually started.
- **`live-game-flash` (the slow pulse on Live Games cards) holds at full
  opacity for the first half of its cycle, not just an instant.**
  Current: 4s cycle, `0%,50%: opacity 1` (flat 2s hold — two equal
  keyframe values produce no interpolation between them), `75%: opacity
  0.55`, `100%: opacity 1`. If the hold duration or dip depth ever needs
  to change again, keep the "two equal consecutive keyframes = a real
  flat hold" trick rather than going back to a pure sine wave.
- **Rank-change arrows (added 2026-09-13)** — green ▲ / red ▼ to the
  right of the team name on a rank card, shown when that team's rank
  differs from the previous week's. No arrow for a brand-new entry or for
  week1 itself (nothing before the baseline). `getPreviousRankings()`
  (`site/app.js`) just looks at the prior entry in `snapshots` - trivial
  once §2 rule 6's week-label convention shipped the same day, since
  every snapshot is real and in order with no placeholder/preview weeks
  to special-case.
- **Week-label convention fixed; "(Upcoming)" removed entirely
  (2026-09-13)** — see §2 rule 6 for the what/why. Concretely: the user
  caught that Week 2's tab was showing the RESULT of week 2's own games
  (Texas already at #1 after beating Ohio State, on the same tab as that
  game) instead of the ranking that governed week 2's games in the first
  place - a real, correct AP-poll-convention bug, not a preference.
  `scripts/backtest.py` now labels the snapshot/events produced by real
  week W's games `"week{W+1}"` (the tab where that change is first
  visible), and seeds the baseline directly as `"week1"` (no more
  separate `"preseason"` key at all - Week 1 IS the baseline, full stop).
  This made the entire "preview week" mechanism in `site/app.js`
  unnecessary and it was deleted: `previewWeekKey`, the
  `weekHasStarted()`/"(Upcoming)" suffix, and `loadSeason()`'s
  synthesized-next-week-snapshot block are all gone, since backtest.py's
  own output already includes the "current/live" week as a real,
  already-correct snapshot the moment it runs - no client-side synthesis
  needed. `getLiveWeekKey()` simplified to just the latest snapshot.
  `live/worker.js`'s `getCurrentWeekNumber()` (an independent
  reimplementation of the same "which week is live" logic, used for live-
  score opponent-name resolution) had the exact same `+1` and needed the
  identical fix - caught by grepping for every place that reimplements
  this convention, per §8's standing lesson about a data-model fix not
  automatically propagating to every consumer. **`live/worker.js`'s fix
  is written but NOT YET DEPLOYED** - it only takes effect after a real
  `wrangler deploy` from the `live/` directory; see §9 for the pending
  action. Verified end-to-end in a real browser against a scratch copy of
  the regenerated real 2026 season data (not just eyeballed): Week 1
  shows the untouched baseline with no arrows and its own final scores;
  Week 2 shows that SAME baseline (Ohio State still #1) alongside week
  2's own final scores (Ohio State's real loss to Texas) and "No rank
  changes this week. Chalk held."; Week 3 (now the live/current tab, no
  "(Upcoming)" suffix) shows the resulting new ranking (Texas #1 ▲, Ohio
  State #5 ▼) alongside week 3's own not-yet-played schedule. Also
  reran `tests/test_swap_engine.py` and `tests/test_multigame_week.py`
  (untouched by this fix, since `core/swap_engine.py` is label-agnostic)
  to confirm no regression, and validated the new labeling against a
  freshly-generated synthetic season (`tests/generate_fake_season.py`,
  throwaway `data/cfb/seasons/9999/`) before touching real production
  data.
- **`fetch_week_matchups.py`'s `get_ranked_teams()` real bug, caught
  the same day by the user reading Week 2's cards** — every team except
  Oregon showed its opponent/final score. Root cause:
  `get_ranked_teams()` always read `snapshots[-1]` (whatever's latest)
  to decide who needs a matchup entry, but this script is called for two
  purposes needing two DIFFERENT rankings - seeding an upcoming week's
  preview (latest/current standings is correct) vs. re-fetching an
  ALREADY-PLAYED week's own matchups to bake in final scores (by then
  "latest" already includes that same week's results, so a team fully
  dethroned that week - Oregon, by Oklahoma State - has already dropped
  out of "latest," even though it needs a final-score entry for the very
  game that dethroned it). Fixed: `get_ranked_teams(season, week)` now
  looks up the snapshot literally labeled `"week{week}"` instead of the
  latest one - under the week-label convention above, that's exactly
  "who was ranked when week `week` was played," correct for both call
  sites with no special-casing. Verified with a real re-fetch against
  the real CFBD API: Oregon's entry now shows `@ Oklahoma State,
  completed: true, 31-39`, confirmed in a real browser.
- **Current sizes, all explicitly first-pass / open to revision per the
  user**: `.belt-team` (ranked team name) 14px (was 12px),
  `.live-game-status` (the "● LIVE · Q4" line) 12px (was 10px). HAVOC
  card font sizes have NOT been touched yet — user wants to see the font
  swap alone first before deciding on sizing there.
- **HAVOC shows live-detected upsets the instant a game goes final
  (added 2026-09-12), separate from and ahead of the weekly backtest.**
  Built because the site had no way to surface an in-week upset (e.g. a
  real week-2 unranked/lower-ranked team beating a ranked one) until
  days later, once that week's manual `fetch_results.py`/`backtest.py`
  pipeline finally ran — HAVOC's `events-list` is normally driven
  entirely by `season_history.json`'s backtested `events`, which only
  update per §9's manual/weekly cadence. `computeLiveUpsets()`
  (`site/app.js`) reuses `isUnderdogLeading()` — already status-agnostic,
  it just compares scores — filtered to `status === "finished"` instead
  of `"in_progress"`, and only ever runs while `isViewingLiveWeek()` is
  true. `refreshHavocPanel()` redraws the panel both on week navigation
  and on every live-score poll tick (45s), so a card appears within one
  poll of a game finishing, no reload needed. **Deliberately does not
  touch `currentSeasonData`, rankings, or `season_history.json`** — only
  the real swap engine/backtest is allowed to move a rank slot (§2); this
  is a read-only preview layer on top of the live feed, styled as a red
  `.event-card.live-upset` card (same red as the existing in-progress
  `.upset` styling, for one consistent "upset" color sitewide). No
  disclaimer text on the card (removed same day, per explicit user
  request) — the HAVOC section context and the red styling are
  considered sufficient to convey "not yet official" without spelling it
  out. Naturally stops showing a given week's cards the moment that
  week's real backtest runs — `getLiveWeekKey()` rolls forward to the
  next week at that point, and the now-past week's tab shows its real
  `season_history.json` events instead. Verified live against real
  production data (not just simulated): correctly surfaced 2026-09-12's
  real upsets (unranked Oklahoma State over #2 Oregon 39-31; Michigan
  over #10 Oklahoma 17-10) while both teams' rank slots stayed exactly
  where they were.
- **"Last Week's Power Swaps" section (added 2026-09-12)** — fills the
  dead air right after a week's real backtest runs, when the newly-live
  week has no games yet and HAVOC is empty. Same card look as HAVOC
  (shares `eventCardHtml()`), sourced from `previousRealWeekKey()`'s
  week (e.g. viewing week3, shows week2's real events) instead of the
  current one. Gated to `isViewingLiveWeek()` like Live Games — a
  historical week's own tab already has its own real events, no dead air
  to fill. Unlike Live Games, it never hides once the live week has one;
  it only changes PRIORITY (DOM position, via
  `updateEventsColumnOrder()`, called from `renderLiveGamesSection()`
  every render and every live-poll tick): default order (no games live
  right now this week) is Last Week / HAVOC; the moment Live Games
  itself is showing (real in-progress games), it drops to Live Games /
  HAVOC / Last Week. index.html's own source order (Live Games, HAVOC,
  Last Week) already matches the "live" case, so only the "not live"
  case needs an actual `insertBefore` — the "live" case is just
  `appendChild` back to the end. Shows "No previous week yet." for
  week1 (nothing before it) and "No rank changes last week. Chalk held."
  when the previous week was itself chalk - same empty-state convention
  HAVOC uses.
- **HAVOC / Last Week's Power Swaps label-offset bug, fixed 2026-09-19.**
  Both panels were filtering `currentSeasonData.events` by the VIEWED
  week's own label (`e.week === snapshot.week`), which was correct back
  when this code was written (2026-09-12) but silently broke the next
  day when §2 rule 6's week-label convention shipped (events produced by
  week N's own games are labeled `"week{N+1}"`, not `"week{N}"` - see
  that rule for the full why). Real symptom the user caught: viewing the
  live week (week3) showed HAVOC full of week2's already-official swaps
  (Michigan over Oklahoma, Oklahoma State dethroning Oregon, Texas over
  Ohio State) with Last Week's Power Swaps empty - exactly backwards.
  Root cause: `refreshHavocPanel()`'s `e.week === snapshot.week` was
  actually matching the PREVIOUS week's games (since those are the ones
  labeled with the current tab's key), while `renderLastWeekPanel()`'s
  `e.week === prevKey` (one label further back) landed on nothing since
  week1 was chalk. Fixed by adding a `nextWeekKey()` helper (mirrors the
  existing `previousRealWeekKey()`) so HAVOC now looks one week AHEAD of
  the viewed tab for that week's own games, and Last Week's Power Swaps
  now filters on the viewed week's own label directly (`prevKey` is only
  used to detect whether a previous week exists at all, not to filter
  events by anymore) - this makes Last Week's Power Swaps the same event
  set `renderRankings()` already uses for its just-changed highlight/rank
  arrows, just recapped in its own panel. Verified in a real browser
  against the real 2026 season data (not just read): week2's tab shows
  HAVOC with all three swaps and Last Week hidden (not the live week -
  **SUPERSEDED same day, see next entry**); week3's tab shows empty
  HAVOC ("hasn't been played yet") and Last Week's Power Swaps with
  those same three swaps. `site/app.js` only (`refreshHavocPanel()`,
  `renderLastWeekPanel()`, new `nextWeekKey()`).
- **Last Week's Power Swaps made permanently visible + order fixed,
  2026-09-19 (same day, later request).** User's explicit call:
  the panel should never hide, on any week's tab (not just the live
  week as it had been since it was built 2026-09-12), always showing
  that week's own previous-week recap - `"No rank changes last week.
  Chalk held."` when that previous week was chalk, `"No previous week
  yet."` for week1. `renderLastWeekPanel()`'s `isViewingLiveWeek()`
  gate on `lastWeekSection.hidden` was removed (now unconditionally
  `false`); the event-filtering logic underneath (viewed week's own
  label, from the fix above) didn't need to change since it already
  works correctly for every week, not just the live one. Also removed
  `updateEventsColumnOrder()` entirely (and its call in
  `renderLiveGamesSection()`) - it used to swap HAVOC/Last Week's
  physical DOM order depending on whether Live Games was showing;
  now Last Week always sits directly beneath HAVOC in index.html's
  static source order (Live Games, HAVOC, Last Week), and Live Games
  hiding/showing via its own `hidden` attribute is what naturally
  bumps everything else down/up - no JS reordering needed or wanted
  anymore. Verified in a real browser against real 2026 season data:
  week1/2/3 all show Last Week's Power Swaps beneath HAVOC with the
  right content per week, and a simulated in-progress game confirmed
  Live Games bumps to the top with HAVOC/Last Week's relative order
  undisturbed beneath it.
- **"This Week" ticker fixed, 2026-09-19 (same label-offset bug class as
  the HAVOC/Last Week fix above, missed as a sibling consumer at the
  time).** User caught the top-of-page ticker showing a headline from
  last week instead of this week's own news. Root cause: `renderTicker()`
  was called with `weekEvents` (`e.week === snapshot.week`), which per
  the week-label convention holds the PREVIOUS week's already-official
  swaps - confirmed live in-browser: on Week 3's tab, the old code would
  have shown "Unranked Oklahoma State just dethroned #2 Oregon" (Week 2's
  news, already sitting in Last Week's Power Swaps). Fixed via a new
  `refreshTicker()` (mirrors `refreshHavocPanel()`): sources from
  `nextWeekKey(snapshot.week)`'s events (this week's own official games)
  and folds in live-detected upsets via `computeLiveUpsets()` so the
  headline updates same-day instead of waiting for the weekly backtest.
  `renderTicker()` now takes a `liveUpsets` param and shows those ahead of
  any official swap/dethrone headline. Also wired into `fetchLiveScores()`
  (the 45s live-poll tick), not just `renderWeek()`, so a live upset
  appears in the ticker within one poll interval. Verified in a real
  browser against real 2026 season data: confirmed the exact before/after
  text via console (`oldBuggyEvents` vs `newCorrectEvents`), and confirmed
  both the live-upset and official-swap render paths produce correct text
  before restoring real state (real state currently renders hidden,
  correctly - Week 3's own games haven't been backtested yet and no
  in-progress game is currently an upset).
