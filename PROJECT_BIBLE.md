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

## 6. Live scores: current three-tier redundancy architecture (built 2026-09-12)

Built after a real BBS outage (`/v1/stored/matches` returning 500 on every
call, still ongoing as of this writing) left the site with zero live-score
updates for hours — one data source was the actual root cause, not a bug in
how that source was handled.

**Tried in this order, every cron tick (`live/wrangler.toml`, `*/2 * * * *`):**

1. **Primary: BBS `/v1/stored/matches`** (`live/bbs_client.js`
   `fetchBbsMatches()`). 2 requests/tick (today + yesterday UTC date).
   `BBS_API_KEY` secret. **Currently down** (real outage, confirmed via
   direct calls and `wrangler tail` against production, not a code bug —
   BBS's own status page doesn't catch it since it only monitors `/health`).
2. **Secondary: BBS `/v1/matches`** (`fetchLegacyMatches()`, added
   2026-09-12) — the OLD endpoint this client moved off of back on
   2026-09-04. Same account/key as primary (not independent of a
   platform-wide BBS outage, but real and verified working: status
   transitions promptly, identical schema/naming convention, same
   duplicate-row issue as primary — handled by the same dedup logic since
   it's source-agnostic). 1 request/tick, no date param needed. **This is
   what's currently serving `/live`**, tagged `data_source: "bbs_legacy"`
   internally (KV only — see rule 5 above, this is stripped from the public
   response).
3. **Tertiary: Highlightly** (`live/highlightly_client.js`, added
   2026-09-12) — only tried when BOTH BBS endpoints fail on the same tick.
   Genuinely independent vendor. Throttled separately from the outer 2-min
   cron: rolling 24h count in KV (`highlightly_poll_log`), capped at 85 of
   the free tier's 100/day, ~1 poll/10min, active only 12pm–2am ET. Backs
   off an hour early if a real response's rate-limit-remaining header ever
   drops ≤5. `HIGHLIGHTLY_API_KEY` secret (real key added 2026-09-12).
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

## 9. Current open items (as of 2026-09-12)

- **BBS `/v1/stored/matches` primary outage — still ongoing, no ETA.** No
  code fix exists; the Worker retries automatically every 2 minutes and the
  secondary (`/v1/matches`) is currently serving `/live` in its place.
  Watch for it to recover on its own (`data_source` should flip back to
  `bbs_stored` with no redeploy needed) — worth a spot-check next session.
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
