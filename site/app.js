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
let currentWeekIndex = 0;
let currentWeek1Matchups = null;

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
  // Default to the last week
  currentWeekIndex = currentSeasonData
    ? currentSeasonData.snapshots.length - 1
    : 0;

  // Optional, display-only - a season/sport with no Week 1 matchup data
  // yet (or none at all, e.g. basketball) just shows no opponent line.
  // Never affects rankings/backtest loading either way.
  currentWeek1Matchups = null;
  try {
    const resp = await fetch(`../data/${sport}/seasons/${year}/week1_matchups.json`);
    if (resp.ok) currentWeek1Matchups = await resp.json();
  } catch (err) {
    // ignored - purely decorative data
  }

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
  for (const snapshot of currentSeasonData.snapshots) {
    const opt = document.createElement("option");
    opt.value = snapshot.week;
    opt.textContent = formatWeekLabel(snapshot.week);
    weekSelect.appendChild(opt);
  }
  weekSelect.value = currentSeasonData.snapshots[currentWeekIndex].week;
}

function formatWeekLabel(weekKey) {
  if (weekKey === "preseason") return "Preseason";
  if (weekKey === "postseason") return "Bowls & Playoff";
  const num = weekKey.replace("week", "");
  return `Week ${num}`;
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

  const snapshot = currentSeasonData.snapshots[currentWeekIndex];
  const weekKey = snapshot.week;
  const weekEvents = currentSeasonData.events.filter(e => e.week === weekKey);

  // Sync the dropdown
  weekSelect.value = weekKey;

  // Update nav display and arrow states
  weekNavDisplay.textContent = formatWeekLabel(weekKey);
  weekPrev.disabled = currentWeekIndex <= 0;
  weekNext.disabled = currentWeekIndex >= currentSeasonData.snapshots.length - 1;

  const sportLabel = SPORTS.find(s => s.key === currentSeasonData.sport)?.label || currentSeasonData.sport;
  sportBanner.textContent = sportLabel;
  weekHeading.textContent = `${currentSeasonData.season}: ${formatWeekLabel(weekKey)}`;

  renderRankings(snapshot, weekEvents);
  renderEvents(weekEvents);
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

    const matchup = currentWeek1Matchups?.matchups?.[slot.team];
    const opponentLine = matchup
      ? `<span class="belt-opponent">${matchup.home_away === "home" ? "vs." : "@"} ${matchup.opponent}</span>`
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

  if (LIVE_SCORES_ENABLED) renderLiveBadges();
}

function renderEvents(weekEvents) {
  eventsList.innerHTML = "";
  if (weekEvents.length === 0) {
    eventsList.innerHTML = `<li class="no-events">No rank changes this week. Chalk held.</li>`;
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

  const viewedWeekLabel = formatWeekLabel(currentSeasonData.snapshots[currentWeekIndex].week);
  const currentRank = findCurrentRank(teamName);
  teamCardCurrent.textContent = currentRank
    ? `${viewedWeekLabel}: #${currentRank}`
    : `${viewedWeekLabel}: Unranked`;

  // Only show events up through the week currently being viewed, so a
  // team's card reflects what was actually known at that point in the
  // season, not the full-season future the person hasn't "reached" yet
  // if they're browsing an earlier week.
  const viewedWeekKey = currentSeasonData.snapshots[currentWeekIndex].week;
  const viewedWeekIndex = currentSeasonData.snapshots.findIndex(s => s.week === viewedWeekKey);
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
  const snapshot = currentSeasonData.snapshots[currentWeekIndex];
  const slot = snapshot.rankings.find(s => s.team === teamName);
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
  if (currentSeasonData && currentWeekIndex < currentSeasonData.snapshots.length - 1) {
    currentWeekIndex++;
    renderWeek();
  }
});

// ── Dropdown changes ──
sportSelect.addEventListener("change", () => loadSeason(sportSelect.value, seasonSelect.value));
seasonSelect.addEventListener("change", () => loadSeason(sportSelect.value, seasonSelect.value));
weekSelect.addEventListener("change", () => {
  const idx = currentSeasonData?.snapshots.findIndex(s => s.week === weekSelect.value);
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

function renderLiveBadges() {
  for (const li of rankingsList.children) {
    const badge = li.querySelector(".belt-live");
    if (!badge) continue;
    const game = liveGamesByTeam[li.dataset.team];
    const text = game ? formatLiveBadge(game, game.home_team === li.dataset.team) : null;
    if (text) {
      badge.textContent = text;
      badge.hidden = false;
      badge.className = "belt-live" + (game.status === "in_progress" ? " is-live" : " is-final");
    } else {
      badge.hidden = true;
    }
  }
}

async function fetchLiveScores() {
  try {
    const resp = await fetch(LIVE_WORKER_URL);
    if (!resp.ok) return;
    const payload = await resp.json();
    const byTeam = {};
    for (const game of payload.games ?? []) {
      byTeam[game.home_team] = game;
      byTeam[game.away_team] = game;
    }
    liveGamesByTeam = byTeam;
    renderLiveBadges();
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