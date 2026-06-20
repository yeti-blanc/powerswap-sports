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
const LIVE_SCORES_ENABLED = false;   // see live/README.md before flipping this
const BASKETBALL_ENABLED = false;    // football gets sorted out first

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
// LIVE TICKER (DORMANT - LIVE_SCORES_ENABLED is false above)
// ============================================================
// This is a SCAFFOLD, not a working feature. It's wired up structurally
// so the design is captured, but initLiveTicker() is never called while
// the flag above is false, and every function here is a no-op shell
// until the live/worker.js Cloudflare Worker actually exists and is
// deployed. See live/README.md before touching any of this.
//
// Distinct from the "ticker" element above, which is the FREE weekly
// recap ticker (already active, no cost, no live data). This live
// ticker is a separate concept: in-progress game scores + clock, with
// computed "if this holds" PowerSwap stakes, requiring the paid CFBD
// Patreon tier discussed in README.md's "Live Scores" section.

function initLiveTicker() {
  // UNBUILT: would poll live/worker.js's /live endpoint every 30-60s
  // and render a scrolling ticker of in-progress games + stakes.
  // Also UNBUILT: the client-side clock interpolation between polls
  // (count down locally in JS, resync on each poll) discussed as the
  // way to get a convincing "live" feel without aggressive backend
  // polling.
  console.log("Live ticker is dormant. Set LIVE_SCORES_ENABLED = true and " +
              "build out live/worker.js first - see live/README.md.");
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
