// PowerSwap Sports - site/app.js

const LIVE_SCORES_ENABLED = true;
const BASKETBALL_ENABLED = false;

// live/worker.js's own /live endpoint - the site never calls BBS directly.
const LIVE_WORKER_URL = "https://powerswap-live-scores.yeti-f3c.workers.dev/live";
const LIVE_POLL_MS = 45000; // within the 30-60s range noted in README.md

const SPORTS = [
  { key: "cfb", label: "College Football", enabled: true },
  { key: "cbb", label: "College Basketball", enabled: BASKETBALL_ENABLED },
];

// First season this project has real backtested data for. Never changes.
const FIRST_SEASON = 2021;

// CFB's season "year" turns over well before the calendar year does -
// preseason polls and week 1 typically land in August. Using June 1 as
// the cutover (rather than Jan 1) means the site starts defaulting to a
// new season's (initially empty, until that season's backtest is run)
// view as soon as that season is realistically underway, not five-plus
// months early on New Year's Day.
function getCurrentSeasonYear(now = new Date()) {
  const CUTOVER_MONTH_INDEX = 5; // June (0-indexed)
  return now.getMonth() >= CUTOVER_MONTH_INDEX ? now.getFullYear() : now.getFullYear() - 1;
}

// FIRST_SEASON..currentSeasonYear, e.g. [2021, 2022, ..., 2026]. Computed
// as a range (not a hardcoded list) so next June 1st's rollover to 2027
// needs no app.js edit - the dropdown and its default just follow the
// calendar. If a season's data isn't backtested yet, renderWeek()'s
// existing "No backtested data for this sport/season yet" state handles it.
const AVAILABLE_SEASONS = Array.from(
  { length: getCurrentSeasonYear() - FIRST_SEASON + 1 },
  (_, i) => FIRST_SEASON + i
);

const sportSelect = document.getElementById("sport-select");
const seasonSelect = document.getElementById("season-select");
const weekSelect = document.getElementById("week-select");
const weekHeading = document.getElementById("week-heading");
const sportBanner = document.getElementById("sport-banner");
const rankingsList = document.getElementById("rankings-list");
const eventsList = document.getElementById("events-list");
const liveGamesSection = document.getElementById("live-games-section");
const liveGamesList = document.getElementById("live-games-list");
const ticker = document.getElementById("ticker");
const tickerText = document.getElementById("ticker-text");
const weekNavDisplay = document.getElementById("week-nav-display");
const weekPrev = document.getElementById("week-prev");
const weekNext = document.getElementById("week-next");

const teamCardOverlay = document.getElementById("team-card-overlay");
const teamCardClose = document.getElementById("team-card-close");
const teamCardName = document.getElementById("team-card-name");
const teamCardCurrent = document.getElementById("team-card-current");
const teamCardTimeline = document.getElementById("team-card-timeline");

let currentSeasonData = null;
let visibleSnapshots = [];
let currentWeekIndex = 0;
let weekMatchups = {};
let previewWeekKey = null;

function populateSportSelect() {
  sportSelect.innerHTML = "";
  for (const sport of SPORTS) {
    const opt = document.createElement("option");
    opt.value = sport.key;
    opt.textContent = sport.enabled ? sport.label : `${sport.label} (Coming Soon)`;
    opt.disabled = !sport.enabled;
    sportSelect.appendChild(opt);
  }
  sportSelect.value = SPORTS.find(s => s.enabled)?.key || SPORTS[0].key;
}

function populateSeasonSelect() {
  seasonSelect.innerHTML = "";
  for (const year of AVAILABLE_SEASONS) {
    const opt = document.createElement("option");
    opt.value = year;
    opt.textContent = year;
    seasonSelect.appendChild(opt);
  }
  seasonSelect.value = AVAILABLE_SEASONS[AVAILABLE_SEASONS.length - 1];
}

// The preseason AP poll is the swap engine's required baseline, not a
// real week of games - there's no such thing as a "preseason" game to
// browse. computeVisibleSnapshots() drops that snapshot from the
// browsable list the moment a real week1 snapshot exists to replace it;
// until then, the single preseason snapshot stands in for "Week 1" (see
// formatWeekLabel) so there's still something to view before week 1's
// results are backtested in.
function computeVisibleSnapshots(seasonData) {
  if (!seasonData) return [];
  const hasRealWeek1 = seasonData.snapshots.some(s => s.week === "week1");
  return hasRealWeek1
    ? seasonData.snapshots.filter(s => s.week !== "preseason")
    : seasonData.snapshots;
}

function weekNumber(weekKey) {
  const match = /^week(\d+)$/.exec(weekKey || "");
  return match ? parseInt(match[1], 10) : null;
}

async function loadSeason(sport, year) {
  const path = `../data/${sport}/seasons/${year}/season_history.json`;
  try {
    const resp = await fetch(path);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    currentSeasonData = await resp.json();
  } catch (err) {
    currentSeasonData = null;
    console.error(`Could not load ${sport} season data for ${year}:`, err);
  }

  visibleSnapshots = computeVisibleSnapshots(currentSeasonData);
  previewWeekKey = null;
  weekMatchups = {};

  // Week 1's matchup/schedule data lives in its own legacy file
  // (live/worker.js reads it directly by URL, and every past season
  // already has one) - keyed under both "week1" and "preseason" so the
  // pre-week1 placeholder view above still shows Week 1's schedule
  // before real week1 results exist. Optional, display-only either way.
  try {
    const resp = await fetch(`../data/${sport}/seasons/${year}/week1_matchups.json`);
    if (resp.ok) {
      const data = await resp.json();
      weekMatchups.week1 = data.matchups;
      weekMatchups.preseason = data.matchups;
    }
  } catch (err) {
    // ignored - purely decorative data
  }

  // Weeks 2+ generalize the same idea via
  // sports/cfb/fetch_week_matchups.py: one file per week, refreshed with
  // a final score once that week solidifies, and pre-seeded with just
  // the schedule for whichever week comes right after the latest real
  // one - so there's always something concrete to show for "what's
  // next" instead of the previous week's results lingering on screen.
  // Only meaningful for the live current season; past seasons never
  // collected this per-week data, so these fetches just fail silently.
  if (currentSeasonData && Number(year) === getCurrentSeasonYear()) {
    const realWeekNums = visibleSnapshots.map(s => weekNumber(s.week)).filter(n => n !== null);
    const latestRealWeek = realWeekNums.length ? Math.max(...realWeekNums) : null;

    if (latestRealWeek !== null) {
      for (let w = 2; w <= latestRealWeek + 1; w++) {
        try {
          const resp = await fetch(`../data/${sport}/seasons/${year}/raw/week_${String(w).padStart(2, "0")}_matchups.json`);
          if (resp.ok) {
            const data = await resp.json();
            weekMatchups[`week${w}`] = data.matchups;
          }
        } catch (err) {
          // ignored - purely decorative data
        }
      }

      // The week right after the latest real one: if its schedule is
      // available but it hasn't been backtested yet, show it as an
      // upcoming preview - same rankings as the latest real week
      // (nothing's changed yet, no games played), but that week's own
      // schedule instead of the last week's now-stale opponent lines.
      const nextWeekKey = `week${latestRealWeek + 1}`;
      const alreadyReal = visibleSnapshots.some(s => s.week === nextWeekKey);
      if (!alreadyReal && weekMatchups[nextWeekKey]) {
        const latestSnapshot = visibleSnapshots[visibleSnapshots.length - 1];
        visibleSnapshots = [...visibleSnapshots, { week: nextWeekKey, rankings: latestSnapshot.rankings }];
        previewWeekKey = nextWeekKey;
      }
    }
  }

  // Default to the last (most current) week
  currentWeekIndex = visibleSnapshots.length - 1;

  populateWeekSelect();
  renderWeek();
}

function populateWeekSelect() {
  weekSelect.innerHTML = "";
  if (!currentSeasonData) {
    const opt = document.createElement("option");
    opt.textContent = "No data";
    weekSelect.appendChild(opt);
    return;
  }
  for (const snapshot of visibleSnapshots) {
    const opt = document.createElement("option");
    opt.value = snapshot.week;
    opt.textContent = formatWeekLabel(snapshot.week);
    weekSelect.appendChild(opt);
  }
  weekSelect.value = visibleSnapshots[currentWeekIndex].week;
}

// A preview week (see loadSeason) stays "upcoming" only until its games
// actually start - once a real kickoff has passed (or a game's already
// completed), it's inaccurate to keep calling it upcoming even though
// it's still just a preview snapshot (same rankings as last week) until
// backtested. Uses weekMatchups' own CFBD-sourced kickoff times, same
// source of truth the 2026-09-05 live-worker fix established for "has
// this actually started" questions - not BBS's live-feed status, so this
// reads correctly even before BBS's feed has picked the game up.
function weekHasStarted(weekKey) {
  const matchups = weekMatchups[weekKey];
  if (!matchups) return false;
  const now = Date.now();
  return Object.values(matchups).some(m => {
    if (m.completed) return true;
    if (m.start_time_tbd || !m.kickoff_utc) return false;
    return new Date(m.kickoff_utc).getTime() <= now;
  });
}

function formatWeekLabel(weekKey) {
  // Only reachable before a real week1 snapshot exists (see
  // computeVisibleSnapshots) - "preseason" itself is never a user-facing
  // week.
  if (weekKey === "preseason") return "Week 1";
  if (weekKey === "postseason") return "Bowls & Playoff";
  const num = weekKey.replace("week", "");
  const suffix = weekKey === previewWeekKey && !weekHasStarted(weekKey) ? " (Upcoming)" : "";
  return `Week ${num}${suffix}`;
}

function renderWeek() {
  if (!currentSeasonData) {
    rankingsList.innerHTML = `<li class="no-events">No backtested data for this sport/season yet.</li>`;
    eventsList.innerHTML = "";
    ticker.hidden = true;
    tickerText.textContent = "";
    weekHeading.textContent = "Rankings";
    weekNavDisplay.textContent = "—";
    weekPrev.disabled = true;
    weekNext.disabled = true;
    return;
  }

  const snapshot = visibleSnapshots[currentWeekIndex];
  const weekKey = snapshot.week;
  const weekEvents = currentSeasonData.events.filter(e => e.week === weekKey);

  // Sync the dropdown
  weekSelect.value = weekKey;

  // Update nav display and arrow states
  weekNavDisplay.textContent = formatWeekLabel(weekKey);
  weekPrev.disabled = currentWeekIndex <= 0;
  weekNext.disabled = currentWeekIndex >= visibleSnapshots.length - 1;

  const sportLabel = SPORTS.find(s => s.key === currentSeasonData.sport)?.label || currentSeasonData.sport;
  sportBanner.textContent = sportLabel;
  weekHeading.textContent = `${currentSeasonData.season}: ${formatWeekLabel(weekKey)}`;

  renderRankings(snapshot, weekEvents);
  renderEvents(weekEvents, weekKey === previewWeekKey);
  renderTicker(weekEvents);
}

function renderRankings(snapshot, weekEvents) {
  rankingsList.innerHTML = "";
  if (!snapshot) return;

  const changedTeams = new Set();
  for (const e of weekEvents) {
    changedTeams.add(e.winner);
    changedTeams.add(e.loser);
  }

  for (const slot of snapshot.rankings) {
    const li = document.createElement("li");
    li.className = "belt-card" + (changedTeams.has(slot.team) ? " just-changed" : "");
    li.dataset.team = slot.team;

    // weekMatchups is keyed per-week (see loadSeason) - week 1 from the
    // legacy week1_matchups.json, weeks 2+ from fetch_week_matchups.py's
    // per-week files, looked up by whichever week is actually being
    // viewed. Bug fixed 2026-09-06 (when this only ever held week 1's
    // data): browsing week 5, or a past season, used to still show
    // week 1's opponent stuck on every card regardless of which week was
    // actually being viewed - generalizing the lookup by week key fixes
    // that at the source instead of special-casing week 1.
    const matchup = weekMatchups[snapshot.week]?.[slot.team] ?? null;
    // For a past, completed game, show the real result (W/L + score) - see
    // sports/cfb/fetch_week1_matchups.py's completed/team_score/
    // opponent_score fields, backfilled 2026-09-06 for every past season.
    // Skipped for the CURRENT live season, where the separate live-badge
    // (renderLiveBadges) already shows FINAL score - showing it twice
    // would be redundant.
    const showResult = matchup?.completed && !isViewingLiveWeek();
    const detailText = showResult ? formatMatchupResult(matchup) : matchup ? formatKickoff(matchup) : "";
    const opponentLine = matchup
      ? `<span class="belt-opponent">${matchup.home_away === "home" ? "vs." : "@"} ${matchup.opponent}${detailText ? " · " + detailText : ""}</span>`
      : "";

    const row = document.createElement("div");
    row.className = "belt-row";
    row.innerHTML = `
      <span class="belt-rank">#${slot.rank}</span>
      <span class="belt-team" data-team="${slot.team}">${slot.team}${opponentLine}</span>
      <span class="belt-live" hidden></span>
      <span class="belt-toggle">LINEAGE ▾</span>
    `;

    const lineageDiv = document.createElement("div");
    lineageDiv.className = "lineage";
    lineageDiv.innerHTML = slot.lineage
      .map((entry, i) => {
        const isCurrent = entry.held_until === null;
        const chip = `<span class="lineage-chip${isCurrent ? " current" : ""}">${entry.team}</span>`;
        return i === 0 ? chip : `<span class="lineage-arrow">→</span>${chip}`;
      })
      .join("");

    // Clicking the team NAME specifically opens the "how we got here" card.
    // Clicking anywhere else on the row still opens the rank-slot lineage,
    // same as before - the two interactions are kept separate so they
    // don't compete for the same click.
    const teamNameSpan = row.querySelector(".belt-team");
    teamNameSpan.addEventListener("click", (e) => {
      e.stopPropagation();
      openTeamCard(slot.team);
    });

    row.addEventListener("click", () => {
      lineageDiv.classList.toggle("open");
    });

    li.appendChild(row);
    li.appendChild(lineageDiv);
    rankingsList.appendChild(li);
  }

  if (LIVE_SCORES_ENABLED) {
    renderLiveBadges();
    renderLiveGamesSection();
  }
}

function renderEvents(weekEvents, isPreview = false) {
  eventsList.innerHTML = "";
  if (weekEvents.length === 0) {
    eventsList.innerHTML = isPreview
      ? `<li class="no-events">This week hasn't been played yet - check back once its games wrap up.</li>`
      : `<li class="no-events">No rank changes this week. Chalk held.</li>`;
    return;
  }

  for (const e of weekEvents) {
    const li = document.createElement("li");
    li.className = "event-card" + (e.kind === "dethrone" ? " dethrone" : "");

    if (e.kind === "swap") {
      li.innerHTML = `
        <span class="event-tag">Swap</span>
        <strong>${e.winner}</strong> (#${e.winner_old_rank}) beat <strong>${e.loser}</strong> (#${e.loser_old_rank})
        <div class="event-detail">${e.winner} → #${e.winner_new_rank} · ${e.loser} → #${e.loser_new_rank}</div>
      `;
    } else {
      li.innerHTML = `
        <span class="event-tag">Dethrone</span>
        Unranked <strong>${e.winner}</strong> beat #${e.loser_old_rank} <strong>${e.loser}</strong>
        <div class="event-detail">${e.winner} → #${e.winner_new_rank} · ${e.loser} is OUT</div>
      `;
    }
    eventsList.appendChild(li);
  }
}

function renderTicker(weekEvents) {
  if (weekEvents.length === 0) {
    ticker.hidden = true;
    tickerText.textContent = "";
    return;
  }
  let headline = weekEvents.find(e => e.kind === "dethrone");
  if (!headline) {
    headline = weekEvents.reduce((biggest, e) => {
      const jump = Math.abs(e.winner_old_rank - e.winner_new_rank);
      const biggestJump = Math.abs(biggest.winner_old_rank - biggest.winner_new_rank);
      return jump > biggestJump ? e : biggest;
    }, weekEvents[0]);
  }

  if (headline.kind === "dethrone") {
    tickerText.textContent = `Unranked ${headline.winner} just dethroned #${headline.loser_old_rank} ${headline.loser}. ${headline.loser} is OUT.`;
  } else {
    tickerText.textContent = `${headline.winner} (#${headline.winner_old_rank}) swapped places with ${headline.loser} (#${headline.loser_old_rank}).`;
  }
  ticker.hidden = false;
}

// ── Team card ("How We Got Here") ──
//
// Reads a team's path across the whole season from
// currentSeasonData.team_histories[teamName], which is a flat list of
// every swap/dethrone event that team was involved in, in chronological
// order, whether they won or lost. Distinct from the small inline
// "LINEAGE" toggle on each rank card, which only shows who has held that
// one specific numbered slot.
//
// Renders each event as one line in a timeline: what happened, who was
// involved, and what rank resulted. If a team has no events at all
// (they held one rank the entire season with zero movement either way),
// team_histories won't have an entry for them, so we show a simple
// message instead of an empty timeline.

function openTeamCard(teamName) {
  teamCardName.textContent = teamName;

  const viewedWeekKey = visibleSnapshots[currentWeekIndex].week;
  const viewedWeekLabel = formatWeekLabel(viewedWeekKey);
  const currentRank = findCurrentRank(teamName);
  teamCardCurrent.textContent = currentRank
    ? `${viewedWeekLabel}: #${currentRank}`
    : `${viewedWeekLabel}: Unranked`;

  // Only show events up through the week currently being viewed, so a
  // team's card reflects what was actually known at that point in the
  // season, not the full-season future the person hasn't "reached" yet
  // if they're browsing an earlier week. A preview week (see loadSeason)
  // isn't a real backtested snapshot, so it won't be found here - treat
  // that as "after everything real so far," since a preview week can't
  // have produced any events of its own yet.
  let viewedWeekIndex = currentSeasonData.snapshots.findIndex(s => s.week === viewedWeekKey);
  if (viewedWeekIndex === -1) viewedWeekIndex = currentSeasonData.snapshots.length;
  const fullHistory = currentSeasonData?.team_histories?.[teamName] || [];
  const history = fullHistory.filter(event => {
    const eventWeekIndex = currentSeasonData.snapshots.findIndex(s => s.week === event.week);
    return eventWeekIndex <= viewedWeekIndex;
  });

  teamCardTimeline.innerHTML = "";

  if (history.length === 0) {
    teamCardTimeline.innerHTML = `
      <li class="team-card-event no-events">
        No rank changes recorded for ${teamName} this season.
      </li>
    `;
  } else {
    for (const event of history) {
      const wasWinner = event.winner === teamName;
      const li = document.createElement("li");
      li.className = "team-card-event" + (wasWinner ? " win" : " loss");

      const weekLabel = formatWeekLabel(event.week);

      if (wasWinner) {
        const resultText = event.kind === "dethrone"
          ? `Unranked, beat #${event.loser_old_rank} ${event.loser} → entered at #${event.winner_new_rank}`
          : `#${event.winner_old_rank}, beat #${event.loser_old_rank} ${event.loser} → moved to #${event.winner_new_rank}`;
        li.innerHTML = `
          <span class="team-card-week">${weekLabel}</span>
          <span class="team-card-result win-text">WON</span>
          <span class="team-card-detail">${resultText}</span>
        `;
      } else {
        const resultText = event.kind === "dethrone"
          ? `#${event.loser_old_rank}, lost to unranked ${event.winner} → OUT of the rankings`
          : `#${event.loser_old_rank}, lost to #${event.winner_old_rank} ${event.winner} → dropped to #${event.loser_new_rank}`;
        li.innerHTML = `
          <span class="team-card-week">${weekLabel}</span>
          <span class="team-card-result loss-text">LOST</span>
          <span class="team-card-detail">${resultText}</span>
        `;
      }

      teamCardTimeline.appendChild(li);
    }
  }

  teamCardOverlay.hidden = false;
}

function findCurrentRank(teamName) {
  if (!currentSeasonData) return null;
  const snapshot = visibleSnapshots[currentWeekIndex];
  const slot = snapshot?.rankings.find(s => s.team === teamName);
  return slot ? slot.rank : null;
}

function closeTeamCard() {
  teamCardOverlay.hidden = true;
}

teamCardClose.addEventListener("click", closeTeamCard);
teamCardOverlay.addEventListener("click", (e) => {
  // Only close if the click landed on the overlay itself, not inside the card
  if (e.target === teamCardOverlay) closeTeamCard();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !teamCardOverlay.hidden) closeTeamCard();
});

// ── Week navigation arrows ──
weekPrev.addEventListener("click", () => {
  if (currentWeekIndex > 0) {
    currentWeekIndex--;
    renderWeek();
  }
});

weekNext.addEventListener("click", () => {
  if (currentSeasonData && currentWeekIndex < visibleSnapshots.length - 1) {
    currentWeekIndex++;
    renderWeek();
  }
});

// ── Dropdown changes ──
sportSelect.addEventListener("change", () => loadSeason(sportSelect.value, seasonSelect.value));
seasonSelect.addEventListener("change", () => loadSeason(sportSelect.value, seasonSelect.value));
weekSelect.addEventListener("change", () => {
  const idx = visibleSnapshots.findIndex(s => s.week === weekSelect.value);
  if (idx !== undefined && idx >= 0) {
    currentWeekIndex = idx;
    renderWeek();
  }
});

// ── Live scores (reads live/worker.js's /live endpoint - see live/README.md) ──
// Renders an inline badge on any currently-ranked team's belt-card when
// BBS has a game for them in progress or just finished. Rankings
// themselves are never touched here - this is purely a display layer on
// top of whatever renderRankings() already drew.

// team name -> live game info, keyed from both sides of each game.
let liveGamesByTeam = {};
// Raw games list from the last successful /live fetch, deduped by id -
// separate from liveGamesByTeam (which is keyed/collapsed per team) since
// renderLiveGamesSection() needs one card per GAME, not per team.
let liveGamesRaw = [];

function formatKickoff(matchup) {
  if (matchup.start_time_tbd) return "TBD";
  if (!matchup.kickoff_utc) return "";
  const d = new Date(matchup.kickoff_utc);
  if (isNaN(d)) return "";
  return d.toLocaleString(undefined, {
    weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

function formatMatchupResult(matchup) {
  if (matchup.team_score == null || matchup.opponent_score == null) return "";
  const result = matchup.team_score > matchup.opponent_score ? "W" : "L";
  return `${result} ${matchup.team_score}-${matchup.opponent_score}`;
}

function formatLiveBadge(game, isHome) {
  const teamScore = isHome ? game.home_score : game.away_score;
  const oppScore = isHome ? game.away_score : game.home_score;
  const opponent = isHome ? game.away_team : game.home_team;
  const scoreText = teamScore !== null && oppScore !== null ? `${teamScore}-${oppScore}` : "";

  if (game.status === "in_progress") {
    // period/clock are UNVERIFIED against a real in-progress BBS game as
    // of 2026-09-01 (see live/bbs_client.js) - shown only if present.
    const clockPart = [game.period ? `Q${game.period}` : null, game.clock]
      .filter(Boolean)
      .join(" ");
    return `● LIVE ${scoreText} vs ${opponent}${clockPart ? " · " + clockPart : ""}`;
  }
  if (game.status === "finished") {
    return `FINAL ${scoreText} vs ${opponent}`;
  }
  return null;
}

// Bug fixed 2026-09-06: liveGamesByTeam is keyed purely by team NAME,
// with no season/week attached, and team names repeat across every
// season (Alabama exists in 2022's rankings just as much as 2026's). This
// used to overlay TODAY's real live/final score onto ANY season/week's
// card for a team currently playing - confirmed live: browsing 2022's
// Alabama (who actually played Utah State that year) showed today's real
// 2026 East Carolina score instead. Live badges only mean anything on the
// season/week that's actually happening right now, so they're gated to
// that here rather than matched by name alone.
// The "live" week is whichever week's games are actually being played
// right now in the real world - that's the upcoming preview week once
// one exists (see loadSeason), since by the time a week is a real
// backtested snapshot its games are already over. Falls back to the
// latest real snapshot when there's no preview (e.g. no schedule data
// yet, or the season's genuinely finished) - the old behavior, from
// before preview weeks existed.
function getLiveWeekKey() {
  if (previewWeekKey) return previewWeekKey;
  return visibleSnapshots.length ? visibleSnapshots[visibleSnapshots.length - 1].week : null;
}

function isViewingLiveWeek() {
  if (!currentSeasonData) return false;
  if (currentSeasonData.season !== getCurrentSeasonYear()) return false;
  const liveWeekKey = getLiveWeekKey();
  return liveWeekKey !== null && visibleSnapshots[currentWeekIndex]?.week === liveWeekKey;
}

// The live feed retains a team's last known result until their NEXT real
// game supersedes it (see live/worker.js) - accurate about the real
// world, but stale relative to whichever week is being viewed if that
// next game hasn't started yet. A game is only trusted if its reported
// opponent actually matches what this week's own schedule expects for
// whichever side is a currently-ranked team; otherwise it's a previous
// week's leftover result bleeding onto this week, not this week's game.
// Shared by renderLiveBadges() and renderLiveGamesSection() (bug fixed
// 2026-09-11: only the former had this guard, so a naming bug upstream in
// live/worker.js slipped through on the Live Games section untouched
// while the belt-badge correctly distrusted the same bad data) so both
// display paths independently protect themselves rather than one relying
// on the other having already filtered anything.
function gameMatchesExpectedWeek(game, liveWeekKey) {
  if (!liveWeekKey) return true;
  for (const [team, reportedOpponent] of [
    [game.home_team, game.away_team],
    [game.away_team, game.home_team],
  ]) {
    const expectedOpponent = weekMatchups[liveWeekKey]?.[team]?.opponent;
    if (expectedOpponent && reportedOpponent !== expectedOpponent) return false;
  }
  return true;
}

function renderLiveBadges() {
  const showBadges = isViewingLiveWeek();
  const liveWeekKey = getLiveWeekKey();
  for (const li of rankingsList.children) {
    const badge = li.querySelector(".belt-live");
    if (!badge) continue;
    const team = li.dataset.team;
    let game = showBadges ? liveGamesByTeam[team] : null;
    if (game && !gameMatchesExpectedWeek(game, liveWeekKey)) game = null;
    const text = game ? formatLiveBadge(game, game.home_team === team) : null;
    if (text) {
      badge.textContent = text;
      badge.hidden = false;
      badge.className = "belt-live" + (game.status === "in_progress" ? " is-live" : " is-final");
    } else {
      badge.hidden = true;
    }
  }
}

// ── Live Games section (middle column, above HAVOC) ──
// One card per game currently in_progress - removed automatically once a
// game finishes (a finished game still shows via its normal belt-live
// FINAL badge on the rankings card; it just leaves this dedicated
// "what's happening right now" section). Gated to isViewingLiveWeek()
// same as the belt-live badges - live game data only ever means anything
// for the season/week that's actually happening right now.

function rankLabel(rank) {
  return rank ? `#${rank}` : "—";
}

// The lower-ranked (higher rank number) or unranked side of a game is
// "the underdog." Returns true if the underdog currently has more points
// - used to flag a real upset-in-progress in red.
function isUnderdogLeading(game) {
  if (typeof game.home_score !== "number" || typeof game.away_score !== "number") return false;
  if (game.home_score === game.away_score) return false;

  const homeRank = findCurrentRank(game.home_team);
  const awayRank = findCurrentRank(game.away_team);
  const leaderIsHome = game.home_score > game.away_score;
  const leaderRank = leaderIsHome ? homeRank : awayRank;
  const otherRank = leaderIsHome ? awayRank : homeRank;

  if (leaderRank == null && otherRank != null) return true; // unranked leader beating a ranked team
  if (leaderRank != null && otherRank != null && leaderRank > otherRank) return true; // worse rank leading
  return false;
}

function renderLiveGamesSection() {
  const show = isViewingLiveWeek();
  const liveWeekKey = getLiveWeekKey();
  const inProgress = show
    ? liveGamesRaw.filter((g) => g.status === "in_progress" && gameMatchesExpectedWeek(g, liveWeekKey))
    : [];

  liveGamesSection.hidden = inProgress.length === 0;
  liveGamesList.innerHTML = "";

  for (const game of inProgress) {
    const clockPart = [game.period ? `Q${game.period}` : null, game.clock].filter(Boolean).join(" ");
    const statusText = ["● LIVE", clockPart].filter(Boolean).join(" · ");
    const upset = isUnderdogLeading(game);

    const li = document.createElement("li");
    li.className = "belt-card live-game-card" + (upset ? " upset" : "");
    li.innerHTML = `
      <div class="live-game-flash">
        <div class="live-game-team-row">
          <span class="live-game-rank">${rankLabel(findCurrentRank(game.home_team))}</span>
          <span class="live-game-name">${game.home_team}</span>
          <span class="live-game-score">${game.home_score ?? ""}</span>
        </div>
        <div class="live-game-team-row">
          <span class="live-game-rank">${rankLabel(findCurrentRank(game.away_team))}</span>
          <span class="live-game-name">${game.away_team}</span>
          <span class="live-game-score">${game.away_score ?? ""}</span>
        </div>
        <div class="live-game-status">${statusText}</div>
      </div>
    `;
    liveGamesList.appendChild(li);
  }
}

// BBS's stored data has real duplicate/near-duplicate records for the
// same matchup (confirmed 2026-09-04: e.g. three separate "Georgia vs
// Colorado" entries with different ids/kickoff times alongside Georgia's
// actual in-progress game vs North Carolina A&T). A team can therefore
// appear in more than one entry in payload.games - without a priority
// order, whichever happened to be last in the array silently won, which
// was observed live hiding Georgia's real in_progress badge behind a
// "scheduled" duplicate for an unrelated placeholder game.
//
// Ordering fixed 2026-09-11 to match the real root-cause fix in
// live/worker.js's own STATUS_PRIORITY (see that file's comment for the
// full incident): finished must outrank in_progress, not the reverse - a
// real game can't un-finish, so a lagging duplicate that still says
// in_progress should never beat a sibling record that's already finished.
// The server-side dedup in worker.js now applies this same corrected
// order before the payload is even published, so this client-side copy is
// defense-in-depth, but it needs the identical ordering or it could
// reintroduce the same staleness bug for any payload shape that still
// carries more than one entry for a team.
const LIVE_STATUS_PRIORITY = { finished: 3, in_progress: 2, scheduled: 1 };

// The "(Upcoming)" suffix (see formatWeekLabel/weekHasStarted) depends
// only on wall-clock time vs. kickoff, not on the live feed itself - but
// nothing else re-renders the dropdown/heading between page loads, so a
// tab left open across a real kickoff would keep reading "(Upcoming)"
// indefinitely without this. Piggybacks on the existing live-score poll
// interval rather than a separate timer; runs even if that poll's fetch
// fails, since it doesn't depend on it.
function refreshWeekLabel() {
  if (!currentSeasonData || !visibleSnapshots.length) return;
  const weekKey = visibleSnapshots[currentWeekIndex]?.week;
  if (!weekKey) return;
  const label = formatWeekLabel(weekKey);
  weekNavDisplay.textContent = label;
  weekHeading.textContent = `${currentSeasonData.season}: ${label}`;
  for (const opt of weekSelect.options) {
    opt.textContent = formatWeekLabel(opt.value);
  }
}

async function fetchLiveScores() {
  refreshWeekLabel();
  try {
    const resp = await fetch(LIVE_WORKER_URL);
    if (!resp.ok) return;
    const payload = await resp.json();
    const byTeam = {};
    for (const game of payload.games ?? []) {
      for (const team of [game.home_team, game.away_team]) {
        const existing = byTeam[team];
        if (!existing || (LIVE_STATUS_PRIORITY[game.status] ?? 0) >= (LIVE_STATUS_PRIORITY[existing.status] ?? 0)) {
          byTeam[team] = game;
        }
      }
    }
    liveGamesByTeam = byTeam;
    liveGamesRaw = payload.games ?? [];
    renderLiveBadges();
    renderLiveGamesSection();
  } catch (err) {
    console.error("Live score fetch failed:", err.message);
  }
}

function initLiveTicker() {
  fetchLiveScores();
  setInterval(fetchLiveScores, LIVE_POLL_MS);
}
if (LIVE_SCORES_ENABLED) {
  initLiveTicker();
}

populateSportSelect();
populateSeasonSelect();
loadSeason(sportSelect.value, seasonSelect.value);