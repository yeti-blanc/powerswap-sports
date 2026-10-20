// Live-scores Worker regression tests - runs live/worker.js's REAL
// pollAndCache() and /live handler in Node against captured real data:
//   - tests/fixtures/espn_scoreboard_2026101{7,8}.json: last Saturday's
//     real ESPN slate (week 7 finals)
//   - tests/fixtures/live_payload_corrupted_2026-10-19.json: the actual
//     corrupted KV payload behind the 2026-10-19 incident (week 7 finals
//     relabeled with week 8 opponents - "Utah beat #2 Houston")
//   - data/cfb/seasons/2026/season_history.json: real week 8 rankings
// External calls are mocked (fetch + KV); nothing here touches the network.
//
// Run: node tests/test_live_worker.mjs

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const seasonHistory = read("data/cfb/seasons/2026/season_history.json");
const scoreboards = {
  "20261017": read("tests/fixtures/espn_scoreboard_20261017.json"),
  "20261018": read("tests/fixtures/espn_scoreboard_20261018.json"),
};
const corrupted = JSON.parse(read("tests/fixtures/live_payload_corrupted_2026-10-19.json"));

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? "PASS" : "FAIL"} - ${msg}`);
  if (!cond) failures++;
}

function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
  };
}

// Every scoreboard date resolves to last Saturday's slate (plus the real,
// empty Sunday) regardless of the wall clock this test runs at.
let extraEvents = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("season_history.json")) return new Response(seasonHistory, { status: 200 });
  if (u.includes("site.api.espn.com")) {
    const d = new URL(u).searchParams.get("dates");
    const body = JSON.parse(scoreboards[d] ?? scoreboards["20261017"]);
    body.events.push(...extraEvents);
    return new Response(JSON.stringify(body), { status: 200 });
  }
  return new Response("mocked: not reachable in tests", { status: 503 });
};

const worker = await import(new URL("../live/worker.js", import.meta.url).href);

async function poll(previousPayload) {
  const kv = makeKv(previousPayload ? { live_payload: JSON.stringify(previousPayload) } : {});
  await worker.pollAndCache({ LIVE_KV: kv });
  return { kv, payload: JSON.parse(kv.store.get("live_payload")) };
}

const find = (games, a, b) =>
  games.filter((g) => [g.home_team, g.away_team].includes(a) && (!b || [g.home_team, g.away_team].includes(b)));

console.log("TEST: real week 7 finals, week 8 rankings - every opponent is the REAL one");
{
  const { payload } = await poll(null);
  const g = payload.games;
  check(find(g, "Utah", "Colorado").length === 1, "Utah's game is vs Colorado");
  check(find(g, "Utah", "Houston").length === 0, "no fake Utah-Houston final");
  check(find(g, "Michigan", "Penn State").length === 1, "Michigan's game is vs Penn State");
  check(find(g, "Michigan", "Indiana").length === 0, "no fake Michigan-Indiana final");
  check(find(g, "Miami", "Florida State").length === 1, "Miami's game is vs Florida State");
  check(find(g, "Miami", "Pittsburgh").length === 0, "no fake Miami-Pittsburgh final");
  check(find(g, "Mississippi", "Missouri").length === 1, "Ole Miss resolves to 'Mississippi', vs Missouri");
  check(find(g, "Texas", "Florida").length === 1, "Texas-Florida uses clean school names (no 'Longhorns')");
  check(g.every((x) => x.home_id && x.away_id), "every published side carries a registry id");
  const utah = find(g, "Utah", "Colorado")[0];
  check(utah && utah.away_id === "254" && utah.home_id === "38", "Utah/Colorado ids are 254/38 (CFBD == ESPN)");
  const ids = g.map((x) => x.id);
  check(new Set(ids).size === ids.length, "no vendor game id appears twice");
}

console.log("TEST: starting from the real corrupted KV payload, one poll heals it");
{
  const { payload } = await poll(corrupted);
  const g = payload.games;
  for (const [a, b] of [["Utah", "Houston"], ["Michigan", "Indiana"], ["Miami", "Pittsburgh"],
                        ["Mississippi", "Texas"], ["Texas Tech", "Cincinnati"], ["SMU", "California"], ["LSU", "Auburn"]]) {
    check(find(g, a, b).length === 0, `corrupted ${a}-${b} record is gone`);
  }
  const ids = g.map((x) => x.id);
  check(new Set(ids).size === ids.length, "no vendor game id appears twice after merge");
}

console.log("TEST: public /live strips admin-only fields");
{
  extraEvents = [{
    id: "test-unknown", date: "2026-10-17T19:00Z",
    competitions: [{ date: "2026-10-17T19:00Z",
      status: { period: 4, displayClock: "0:00", type: { state: "post", name: "STATUS_FINAL", description: "Final" } },
      competitors: [
        { homeAway: "home", score: "30", team: { id: "251", location: "Texas", displayName: "Texas Longhorns" } },
        { homeAway: "away", score: "3", team: { id: "999999999", location: "Nowhere Tech", displayName: "Nowhere Tech Phantoms" } },
      ] }],
  }];
  // Texas isn't ranked in week 8, so pair the unknown with a ranked team.
  extraEvents[0].competitions[0].competitors[0].team = { id: "96", location: "Kentucky", displayName: "Kentucky Wildcats" };
  const { kv, payload } = await poll(null);
  check(payload.unresolved_names && payload.unresolved_names["Nowhere Tech Phantoms"], "unknown team recorded in unresolved_names (KV)");
  const unknownGame = payload.games.find((x) => x.id === "espn:test-unknown");
  check(unknownGame && unknownGame.away_team === "Nowhere Tech" && unknownGame.away_id === null,
        "unknown team shows by ESPN school name with a null id (can't match anything by accident)");
  const resp = await worker.default.fetch(new Request("https://x/live"), { LIVE_KV: kv }, {});
  const pub = await resp.json();
  check(!("unresolved_names" in pub), "/live response has no unresolved_names");
  check(pub.games.every((x) => !("data_source" in x)), "/live response has no data_source");
  extraEvents = [];
}

console.log("TEST: BBS-style 'School Mascot' names (no ESPN id) resolve the same way");
{
  const { resolveSide } = worker;
  const cases = [
    ["Arkansas-Pine Bluff Golde Lions", "Arkansas-Pine Bluff"],
    ["Ole Miss Rebels", "Mississippi"],
    ["Miami (OH) RedHawks", "Miami (Ohio)"],
    ["UCF Knights", "Central Florida"],
    ["Texas A&M Aggies", "Texas A&M"],
  ];
  for (const [raw, want] of cases) {
    const side = resolveSide(null, raw, null);
    check(side.name === want && side.id, `${raw} -> ${want}`);
  }
  check(resolveSide("3253", "anything", null).name === "Charlotte", "ESPN's stale Charlotte id 3253 still resolves");
}

console.log("=".repeat(50));
if (failures) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("ALL LIVE WORKER TESTS PASSED");
