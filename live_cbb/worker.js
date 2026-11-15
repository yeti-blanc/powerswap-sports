/**
 * PowerSwap Live Scores - BASKETBALL (Cloudflare Worker "powerswap-cbb-live")
 * =============================================================================
 *
 * Built 2026-11-15. Deliberately a SEPARATE Worker, in a SEPARATE Cloudflare
 * account from football's live/worker.js (user's call: "I don't want the
 * football product to suffer"). Workers KV's free tier allows 1,000
 * writes/day PER ACCOUNT and football's Saturday cadence already uses
 * nearly all of it (live/wrangler.toml) - sharing an account would mean
 * one sport's live scores starving the other's. Nothing here touches
 * football's account, KV or code.
 *
 * Bird Feeder (PROJECT_BIBLE §4.4): the cron polls ESPN and writes ONE KV
 * key; visitors only ever read that key via /live.
 *
 * WHAT IT WATCHES: the repo's data/cbb/seasons/<year>/schedule.json
 * (written every ~15 min by .github/workflows/cbb-season-progression.yml)
 * lists who holds a slot right now (`ranked_ids`) and every one of their
 * games with ESPN game ids and tip times. A tick only calls ESPN when one
 * of those games is inside its window (10 min before tip to final, capped
 * at 4h after tip) - no ranked game on, no ESPN call, no KV write. Games
 * are matched by ESPN game id, never by team name.
 *
 * CPU: ESPN's D-I scoreboard is ~1.3-2 MB of JSON on a busy day (~4-7 ms to
 * parse, measured 2026-11-15) against the free tier's 10 ms per-invocation
 * CPU cap - so ONE poll per invocation, never two (football's 30s
 * "two polls per tick" trick would blow the cap here). Hence ~1 minute is
 * the fastest cadence on the free tier.
 *
 * KV WRITE BUDGET (free tier: 1,000/day, resets 00:00 UTC): writes are
 * counted inside the payload itself (zero extra writes). A tick writes
 * only if (a) the games actually changed (halftime/timeouts cost nothing)
 * and (b) the pacing check passes: the remaining budget is spread over the
 * remaining watched window for this UTC day, never faster than once a
 * minute. A full 11am-1am Saturday slate fits at ~1/min; the guard only
 * slows things on a day that would otherwise run out, it never lets the
 * day run dry.
 */

const SEASON_YEAR_CUTOVER_MONTH = 5; // June (0-indexed) - same rule as site/app.js
const REPO_RAW = "https://raw.githubusercontent.com/yeti-blanc/powerswap-sports/main";
const SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard";

export const KV_KEY = "cbb_live_payload";
export const DAILY_WRITE_BUDGET = 950; // of 1,000 - slack for manual/debug writes
const PRE_TIP_MS = 10 * 60 * 1000;
const MAX_GAME_MS = 4 * 3600 * 1000;
const EXPECTED_GAME_MS = 2.5 * 3600 * 1000; // pacing estimate of a game's length
const RETAIN_MS = 36 * 3600 * 1000;
const TERMINAL = new Set(["finished", "postponed", "canceled"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    if (url.pathname === "/live") {
      const payload = await readPayload(env);
      // budget is internal bookkeeping - public responses carry only games
      // (PROJECT_BIBLE §4.5: anything in /live is public).
      return new Response(JSON.stringify({ updated_at: payload.updated_at ?? null, games: payload.games ?? [] }), {
        headers,
      });
    }
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), { headers });
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, new Date(event.scheduledTime)));
  },
};

export function seasonYear(now) {
  return now.getUTCMonth() >= SEASON_YEAR_CUTOVER_MONTH ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

export function easternDate(isoOrDate) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(isoOrDate));
}

async function readPayload(env) {
  const raw = await env.LIVE_KV.get(KV_KEY);
  if (!raw) return { games: [] };
  try {
    return JSON.parse(raw);
  } catch {
    return { games: [] };
  }
}

async function fetchSchedule(year) {
  const resp = await fetch(`${REPO_RAW}/data/cbb/seasons/${year}/schedule.json`, { cf: { cacheTtl: 120 } });
  if (!resp.ok) return null;
  return resp.json();
}

// Every game of a currently-ranked team, deduped by ESPN game id, with
// registry names for both sides.
export function rankedGames(schedule) {
  const ranked = new Set(schedule.ranked_ids ?? []);
  const byId = new Map();
  for (const [teamId, team] of Object.entries(schedule.teams ?? {})) {
    if (!ranked.has(teamId)) continue;
    for (const g of team.games) {
      if (byId.has(g.id)) continue;
      const me = { id: teamId, name: team.name };
      const opp = { id: g.opponent_id, name: g.opponent };
      const [home, away] = g.home_away === "away" ? [opp, me] : [me, opp];
      byId.set(g.id, { id: g.id, start: g.start, time_valid: g.time_valid, status: g.status, home, away });
    }
  }
  return [...byId.values()];
}

// A game is "watched" from 10 min before tip until it's final (or 4h
// after tip). A TBD tip time watches the whole ET day from 11am.
export function isWatched(game, now, lastKnownStatus) {
  if (TERMINAL.has(lastKnownStatus) || game.status === "final" || game.status === "postponed" || game.status === "canceled") {
    return false;
  }
  const start = game.time_valid
    ? new Date(game.start).getTime()
    : new Date(`${easternDate(game.start)}T11:00:00-05:00`).getTime();
  const end = game.time_valid ? start + MAX_GAME_MS : start + 15 * 3600 * 1000;
  return now.getTime() >= start - PRE_TIP_MS && now.getTime() <= end;
}

// Pacing: may we spend a write now? Spread what's left of today's UTC
// budget over what's left of today's watched window.
export function writeAllowed(payload, games, now) {
  const today = now.toISOString().slice(0, 10);
  const used = payload.budget?.day === today ? payload.budget.writes : 0;
  const remaining = DAILY_WRITE_BUDGET - used;
  if (remaining <= 0) return false;
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const windowEnd = Math.min(
    utcMidnight,
    Math.max(now.getTime(), ...games.map((g) => new Date(g.start).getTime() + EXPECTED_GAME_MS))
  );
  const minutesLeft = Math.max(1, (windowEnd - now.getTime()) / 60000);
  const intervalMin = Math.max(1, minutesLeft / remaining);
  const lastWrite = payload.updated_at ? new Date(payload.updated_at).getTime() : 0;
  // 5s slack: cron ticks aren't exactly 60s apart.
  return now.getTime() - lastWrite >= intervalMin * 60000 - 5000;
}

function normalizeStatus(st) {
  const name = st?.type?.name ?? "";
  if (st?.type?.completed && st?.type?.state === "post") return "finished";
  if (name.includes("POSTPONED") || name.includes("SUSPENDED")) return "postponed";
  if (name.includes("CANCELED") || name.includes("CANCELLED")) return "canceled";
  if (st?.type?.state === "in") return "in_progress";
  return "scheduled";
}

export function parseEspnEvent(ev, known) {
  const comp = ev.competitions[0];
  const side = (ha) => comp.competitors.find((c) => c.homeAway === ha);
  const home = side("home");
  const away = side("away");
  const status = normalizeStatus(comp.status ?? ev.status);
  const score = (c) => (status === "scheduled" ? null : Number(c.score));
  return {
    id: String(ev.id),
    status,
    home_id: known.home.id ?? home.team.id,
    away_id: known.away.id ?? away.team.id,
    home_team: known.home.name ?? home.team.location,
    away_team: known.away.name ?? away.team.location,
    home_score: score(home),
    away_score: score(away),
    period: Number((comp.status ?? ev.status)?.period) || null,
    clock: status === "in_progress" ? (comp.status ?? ev.status)?.displayClock ?? null : null,
    halftime: ((comp.status ?? ev.status)?.type?.name ?? "") === "STATUS_HALFTIME",
    start: ev.date,
  };
}

async function fetchEspnDay(etDate) {
  const resp = await fetch(`${SCOREBOARD}?dates=${etDate.replaceAll("-", "")}&groups=50&limit=500`, {
    // ESPN's WAF rejects browser/Node UAs; curl's passes (PROJECT_BIBLE §6).
    headers: { "User-Agent": "curl/8.14.1" },
  });
  if (!resp.ok) throw new Error(`ESPN ${etDate}: HTTP ${resp.status}`);
  return (await resp.json()).events ?? [];
}

export async function tick(env, now = new Date()) {
  const schedule = await fetchSchedule(seasonYear(now));
  if (!schedule) return { action: "no-schedule" };
  const previous = await readPayload(env);
  const lastStatus = new Map((previous.games ?? []).map((g) => [g.id, g.status]));
  const games = rankedGames(schedule);
  const watched = games.filter((g) => isWatched(g, now, lastStatus.get(g.id)));
  if (watched.length === 0) return { action: "idle" };

  const todayWatched = games.filter(
    (g) => !TERMINAL.has(lastStatus.get(g.id)) && g.status !== "final" && easternDate(g.start) === easternDate(now)
  );
  if (!writeAllowed(previous, todayWatched.length ? todayWatched : watched, now)) return { action: "paced" };

  const wanted = new Map(watched.map((g) => [g.id, g]));
  const fresh = [];
  for (const day of [...new Set(watched.map((g) => easternDate(g.start)))]) {
    let events;
    try {
      events = await fetchEspnDay(day);
    } catch (err) {
      console.error(err.message);
      return { action: "espn-failed" };
    }
    for (const ev of events) {
      const known = wanted.get(String(ev.id));
      if (known) fresh.push(parseEspnEvent(ev, known));
    }
  }

  const freshIds = new Set(fresh.map((g) => g.id));
  const retained = (previous.games ?? []).filter(
    (g) => !freshIds.has(g.id) && now.getTime() - new Date(g.start).getTime() < RETAIN_MS
  );
  const merged = [...fresh, ...retained].sort((a, b) => a.start.localeCompare(b.start));

  if (JSON.stringify(merged) === JSON.stringify(previous.games ?? [])) return { action: "unchanged" };

  const today = now.toISOString().slice(0, 10);
  const used = previous.budget?.day === today ? previous.budget.writes : 0;
  await env.LIVE_KV.put(
    KV_KEY,
    JSON.stringify({ updated_at: now.toISOString(), games: merged, budget: { day: today, writes: used + 1 } })
  );
  return { action: "wrote", games: merged.length };
}
