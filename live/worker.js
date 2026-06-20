/**
 * PowerSwap Sports - Live Scores Worker (DORMANT - NOT DEPLOYED)
 * =================================================================
 *
 * This file is a SCAFFOLD, not a running service. Nothing in this repo
 * deploys it, references it, or depends on it. It exists so the design
 * discussed is captured and ready to activate later, instead of having
 * to rebuild it from scratch.
 *
 * DO NOT DEPLOY THIS until:
 *   1. A CFBD Patreon tier is purchased (Tier 1, $1/mo, unlocks the
 *      /scoreboard endpoint - see README.md "Live Scores" section for
 *      the full cost breakdown).
 *   2. The exact response shape of /scoreboard at that tier has been
 *      confirmed against a real API call (clock/period fields are a
 *      reasonable guess right now, not a verified fact).
 *
 * What this is meant to do, once activated:
 *   - Poll CFBD's /scoreboard endpoint roughly once a minute, but ONLY
 *     for games involving teams currently in the PowerSwap top 25 (pull
 *     that list from the current season_history.json, not all games).
 *   - Cache the result in ONE consolidated KV key (mirrors the Cote Cup
 *     "payload" key pattern - one write per poll, not one per game).
 *   - For each live game, compute the "PowerSwap stakes": what swap or
 *     dethrone would happen if the current score held. This is the
 *     actual differentiator for the ticker - not just the score, but
 *     what it means for the rankings.
 *   - Serve all of this from a single /live endpoint that the site polls
 *     every 30-60 seconds. The site is expected to interpolate the game
 *     clock locally between polls rather than needing sub-minute backend
 *     polling - see site/app.js's (also dormant) liveTicker code.
 *   - Hold CFBD_API_KEY as a Cloudflare secret, never expose it to the
 *     client - same non-negotiable rule as everywhere else in this
 *     project that touches a key.
 *
 * KV key used: "live_payload" (single key, consolidated, low write volume)
 */

// ============================================================
// EVERYTHING BELOW IS SCAFFOLD CODE - NOT WIRED UP, NOT TESTED
// AGAINST A REAL CFBD RESPONSE. TREAT AS A STARTING POINT ONLY.
// ============================================================

const CFBD_SCOREBOARD_URL = "https://api.collegefootballdata.com/scoreboard";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/live") {
      const cached = await env.LIVE_KV.get("live_payload");
      return new Response(cached || JSON.stringify({ games: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, status: "dormant - not actively polling" }));
    }

    return new Response("Not found", { status: 404 });
  },

  // Cron trigger - NOT configured in any wrangler.toml right now, since
  // this Worker isn't deployed. When activated, set this in the
  // Cloudflare dashboard Triggers tab, not in code (same lesson as Cote
  // Cup: cron schedule comments in code drift and mislead).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollAndCache(env));
  },
};

async function pollAndCache(env) {
  // 1. Get the current PowerSwap top 25 for the active sport/season.
  //    UNBUILT: this would need to read from wherever season_history.json
  //    ends up being reachable from a Worker - likely a fetch to the
  //    raw GitHub Pages URL for the current week's snapshot, since
  //    Workers can't read the repo filesystem directly.
  const rankedTeams = await getCurrentRankedTeams(env);

  // 2. Poll CFBD's live scoreboard - UNVERIFIED query shape and response
  //    fields, confirm against a real call before trusting this.
  const resp = await fetch(CFBD_SCOREBOARD_URL, {
    headers: { Authorization: `Bearer ${env.CFBD_API_KEY}` },
  });
  const allLiveGames = await resp.json();

  // 3. Filter to only games involving a currently-ranked team.
  const relevantGames = allLiveGames.filter(
    (g) => rankedTeams.has(g.homeTeam) || rankedTeams.has(g.awayTeam)
  );

  // 4. Compute PowerSwap stakes for each relevant game - the actual
  //    differentiator. UNBUILT: needs the swap engine's logic available
  //    in JS, or a call out to a small endpoint that runs the Python
  //    engine's logic. Worth deciding which approach when this gets built.
  const withStakes = relevantGames.map((g) => ({
    ...g,
    powerswap_stakes: computeStakes(g, rankedTeams), // UNBUILT
  }));

  // 5. One consolidated write, not one per game.
  await env.LIVE_KV.put("live_payload", JSON.stringify({ games: withStakes }), {
    expirationTtl: 120, // stale after 2 minutes if polling stops
  });
}

async function getCurrentRankedTeams(env) {
  // UNBUILT placeholder
  return new Set();
}

function computeStakes(game, rankedTeams) {
  // UNBUILT placeholder - this is where "if this holds, #4 swaps with
  // #15" gets calculated, using the same rank-comparison logic as
  // core/swap_engine.py, just re-expressed for a live/in-progress score
  // rather than a final result.
  return null;
}
