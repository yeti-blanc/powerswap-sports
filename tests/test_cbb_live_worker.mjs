// Basketball live Worker (live_cbb/worker.js) regression tests - runs the
// REAL tick() and /live handler in Node against captured real data:
//   - tests/fixtures/espn_cbb_scoreboard_20261114.json: ESPN's real
//     2026-11-14 D-I scoreboard, trimmed to the ranked teams' games
//     (LSU 81 @ #15 Gonzaga 80 - the dethrone) plus a few others
//   - tests/fixtures/cbb_schedule_20261115.json: the real published schedule (frozen copy),
//     with that game reset to "scheduled" (as it was at tip time)
// fetch and KV are mocked; nothing here touches the network.
//
// Run: node tests/test_cbb_live_worker.mjs

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import worker, { tick, KV_KEY, DAILY_WRITE_BUDGET, isWatched, rankedGames } from "../live_cbb/worker.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const espn = read("tests/fixtures/espn_cbb_scoreboard_20261114.json");
const schedule = JSON.parse(read("tests/fixtures/cbb_schedule_20261115.json"));

const GONZAGA = "2250";
const LSU = "99";
const GAME_ID = schedule.teams[GONZAGA].games.find((g) => g.opponent_id === LSU).id;
// At tip time the published schedule still said "scheduled", and LSU wasn't ranked yet.
for (const team of Object.values(schedule.teams)) {
  for (const g of team.games) if (g.id === GAME_ID) { g.status = "scheduled"; delete g.score; delete g.opponent_score; }
}
schedule.ranked_ids = schedule.ranked_ids.map((id) => (id === LSU ? GONZAGA : id));
const scheduleText = JSON.stringify(schedule);

let failures = 0;
function check(cond, label) {
  console.log(`  ${cond ? "PASS" : "FAIL"} - ${label}`);
  if (!cond) failures++;
}

function makeEnv(initial) {
  const store = new Map(initial ? [[KV_KEY, JSON.stringify(initial)]] : []);
  let writes = 0;
  return {
    LIVE_KV: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => { writes++; store.set(k, v); },
    },
    store, get writes() { return writes; },
  };
}

let espnCalls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("schedule.json")) return new Response(scheduleText, { status: 200 });
  if (u.includes("site.api.espn.com")) {
    espnCalls.push(u);
    return new Response(espn, { status: 200 });
  }
  return new Response("not found", { status: 404 });
};

console.log("TEST: a ranked game in its window is fetched, matched by id, and written");
{
  espnCalls = [];
  const env = makeEnv();
  const r = await tick(env, new Date("2026-11-14T22:15:00Z"));
  const payload = JSON.parse(env.store.get(KV_KEY));
  const g = payload.games.find((x) => x.id === GAME_ID);
  check(r.action === "wrote", `tick wrote (got ${r.action})`);
  check(espnCalls.length === 1 && espnCalls[0].includes("dates=20261114"), "one ESPN call, for the game's Eastern date");
  check(g && g.status === "finished", "LSU-Gonzaga marked finished");
  check(g && g.home_id === GONZAGA && g.away_id === LSU, "home/away ids from the schedule (Gonzaga home, LSU away)");
  check(g && g.home_score === 80 && g.away_score === 81, "real final score 81-80 LSU");
  check(g && g.home_team === "Gonzaga" && g.away_team === "LSU", "registry names, not ESPN display names");
  check(payload.budget.writes === 1, "write counted in the payload's own budget");
}

console.log("TEST: no ranked game in its window -> no ESPN call, no write");
{
  espnCalls = [];
  const env = makeEnv();
  const r = await tick(env, new Date("2026-11-14T08:00:00Z"));
  check(r.action === "idle" && espnCalls.length === 0 && env.writes === 0, `idle at 3am ET (got ${r.action})`);
}

console.log("TEST: a game already final is no longer polled or rewritten");
{
  const env = makeEnv();
  await tick(env, new Date("2026-11-14T22:15:00Z"));
  const before = env.writes;
  espnCalls = [];
  const r = await tick(env, new Date("2026-11-14T22:17:00Z"));
  check(r.action === "idle" && env.writes === before && espnCalls.length === 0,
    `finished game stops being polled (got ${r.action})`);
}

console.log("TEST: pacing - never faster than once a minute");
{
  const env = makeEnv();
  await tick(env, new Date("2026-11-14T21:00:00Z"));
  // Pretend the game is still live in KV so it stays watched.
  const p = JSON.parse(env.store.get(KV_KEY));
  p.games.forEach((g) => { g.status = "in_progress"; });
  env.store.set(KV_KEY, JSON.stringify(p));
  const r = await tick(env, new Date("2026-11-14T21:00:30Z"));
  check(r.action === "paced", `second tick 30s later is paced (got ${r.action})`);
}

console.log("TEST: daily budget is a hard stop");
{
  const env = makeEnv({ updated_at: "2026-11-14T20:00:00Z", games: [], budget: { day: "2026-11-14", writes: DAILY_WRITE_BUDGET } });
  espnCalls = [];
  const r = await tick(env, new Date("2026-11-14T21:30:00Z"));
  check(r.action === "paced" && espnCalls.length === 0 && env.writes === 1 - 1, `budget exhausted -> no fetch, no write (got ${r.action})`);
  const fresh = makeEnv({ updated_at: "2026-11-13T23:00:00Z", games: [], budget: { day: "2026-11-13", writes: DAILY_WRITE_BUDGET } });
  const r2 = await tick(fresh, new Date("2026-11-14T21:30:00Z"));
  check(r2.action === "wrote", `budget resets on a new UTC day (got ${r2.action})`);
}

console.log("TEST: watch window edges");
{
  const g = rankedGames(schedule).find((x) => x.id === GAME_ID);
  const tip = new Date(g.start).getTime();
  check(!isWatched(g, new Date(tip - 11 * 60000)), "not watched 11 min before tip");
  check(isWatched(g, new Date(tip - 9 * 60000)), "watched 9 min before tip");
  check(!isWatched(g, new Date(tip + 4.1 * 3600000)), "not watched 4h+ after tip");
  check(!isWatched(g, new Date(tip + 3600000), "finished"), "not watched once KV says finished");
}

console.log("TEST: public /live strips internal bookkeeping");
{
  const env = makeEnv();
  await tick(env, new Date("2026-11-14T22:15:00Z"));
  const resp = await worker.fetch(new Request("https://x/live"), env);
  const body = await resp.json();
  check(!("budget" in body) && Array.isArray(body.games) && body.games.length > 0, "/live has games, no budget");
  check(resp.headers.get("Access-Control-Allow-Origin") === "*", "CORS open for the site");
}

console.log("TEST: CPU - parsing a full real D-I slate stays well under 10ms");
{
  const full = process.env.CBB_FULL_SLATE;
  if (full) {
    const text = readFileSync(full, "utf8");
    const t = process.hrtime.bigint();
    for (let i = 0; i < 10; i++) JSON.parse(text);
    const ms = Number(process.hrtime.bigint() - t) / 10 / 1e6;
    console.log(`    (${(text.length / 1e6).toFixed(2)} MB parsed in ${ms.toFixed(2)} ms)`);
    check(ms < 8, "full-slate parse under 8ms locally");
  } else {
    console.log("    (skipped - set CBB_FULL_SLATE to a full scoreboard file to measure)");
  }
}

console.log("=".repeat(50));
console.log(failures ? `${failures} FAILURE(S)` : "ALL CBB LIVE WORKER TESTS PASSED");
process.exit(failures ? 1 : 0);
