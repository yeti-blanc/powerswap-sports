// PowerSwap Sports - site/app.js
//
// Loads /data/<sport>/seasons/<season>/season_history.json and renders:
//   - the rankings as expandable "belt cards" with lineage history
//   - the selected week's swap/dethrone events as a "fight card" list
//
// Update SPORTS and AVAILABLE_SEASONS below as backtested data is added.

// ============================================================
// FEATURE FLAGS - both start OFF. Flip to true to activate.
// Nothing below these flags runs or makes a network call while off.
// ============================================================
const LIVE_SCORES_ENABLED = true;    // see live/README.md before flipping this
const BASKETBALL_ENABLED = false;    // football gets sorted out first

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
const rankingsList = document.getElementById("rankings-list");
const eventsList = document.getElementById("events-list");
const ticker = document.getElementById("ticker");
const tickerText = document.getElementById("ticker-text");

let currentSeasonData = null;

function populateSportSelect() {
  sportSelect.innerHTML = "";
  for (const sport of SPORTS) {
    const opt = document.createElement("option");
    opt.value = sport.key;
    opt.textContent = sport.enabled ? sport.label : `${sport.label} (Coming Soon)`;
    opt.disabled = !sport.enabled;
    sportSelect.appendChild(opt);
  }
  // default to the first ENABLED sport, not necessarily the first in the list
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
  weekSelect.value = currentSeasonData.snapshots[currentSeasonData.snapshots.length - 1].week;
}

function formatWeekLabel(weekKey) {
  if (weekKey === "preseason") return "Preseason";
  const num = weekKey.replace("week", "");
  return `Week ${num}`;
}

function renderWeek() {
  if (!currentSeasonData) {
    rankingsList.innerHTML = `<li class="no-events">No backtested data for this sport/season yet.</li>`;
    eventsList.innerHTML = "";
    ticker.hidden = true;
    weekHeading.textContent = "Rankings";
    return;
  }

  const weekKey = weekSelect.value;
  const snapshot = currentSeasonData.snapshots.find(s => s.week === weekKey);
  const weekEvents = currentSeasonData.events.filter(e => e.week === weekKey);

  const sportLabel = SPORTS.find(s => s.key === currentSeasonData.sport)?.label || currentSeasonData.sport;
  weekHeading.textContent = `${sportLabel} ${currentSeasonData.season} — ${formatWeekLabel(weekKey)}`;

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

    const row = document.createElement("div");
    row.className = "belt-row";
    row.innerHTML = `
      <span class="belt-rank">#${slot.rank}</span>
      <span class="belt-team">${slot.team}</span>
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
        <span class="event-tag">SWAP</span>
        <strong>${e.winner}</strong> (#${e.winner_old_rank}) beat <strong>${e.loser}</strong> (#${e.loser_old_rank})
        <div class="event-detail">${e.winner} → #${e.winner_new_rank} · ${e.loser} → #${e.loser_new_rank}</div>
      `;
    } else {
      li.innerHTML = `
        <span class="event-tag">DETHRONE</span>
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

// ============================================================
// LIVE SCORES (reads live/worker.js's /live endpoint - see live/README.md)
// ============================================================
// Distinct from the "ticker" element above, which is the FREE weekly
// recap ticker (unrelated, no live data). This renders an inline badge
// on any currently-ranked team's belt-card when BBS has a game for them
// in progress or just finished. Rankings themselves are never touched
// here - this is purely a display layer on top of whatever renderWeek()
// already drew.

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

sportSelect.addEventListener("change", () => loadSeason(sportSelect.value, seasonSelect.value));
seasonSelect.addEventListener("change", () => loadSeason(sportSelect.value, seasonSelect.value));
weekSelect.addEventListener("change", renderWeek);

populateSportSelect();
populateSeasonSelect();
loadSeason(sportSelect.value, seasonSelect.value);
