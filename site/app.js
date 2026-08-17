// PowerSwap Sports - site/app.js

const LIVE_SCORES_ENABLED = false;
const BASKETBALL_ENABLED = false;

const SPORTS = [
  { key: "cfb", label: "College Football", enabled: true },
  { key: "cbb", label: "College Basketball", enabled: BASKETBALL_ENABLED },
];

const AVAILABLE_SEASONS = [2021, 2022, 2023, 2024, 2025];

const sportSelect = document.getElementById("sport-select");
const seasonSelect = document.getElementById("season-select");
const weekSelect = document.getElementById("week-select");
const weekHeading = document.getElementById("week-heading");
const rankingsList = document.getElementById("rankings-list");
const eventsList = document.getElementById("events-list");
const ticker = document.getElementById("ticker");
const tickerText = document.getElementById("ticker-text");
const weekNavDisplay = document.getElementById("week-nav-display");
const weekPrev = document.getElementById("week-prev");
const weekNext = document.getElementById("week-next");

let currentSeasonData = null;
let currentWeekIndex = 0;

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
  weekHeading.innerHTML = `${sportLabel} ${currentSeasonData.season}:<br>${formatWeekLabel(weekKey)}`;

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

    const row = document.createElement("div");
    row.className = "belt-row";
    row.innerHTML = `
      <span class="belt-rank">#${slot.rank}</span>
      <span class="belt-team">${slot.team}</span>
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

// ── Live ticker scaffold (dormant) ──
function initLiveTicker() {
  console.log("Live ticker is dormant. See live/README.md.");
}
if (LIVE_SCORES_ENABLED) {
  initLiveTicker();
}

populateSportSelect();
populateSeasonSelect();
loadSeason(sportSelect.value, seasonSelect.value);
