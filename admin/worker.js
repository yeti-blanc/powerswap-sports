/**
 * PowerSwap Admin Portal - Worker backend
 * =========================================
 *
 * Single-admin portal, modeled on the PFPI admin-portal playbook (pasted
 * into chat 2026-09-04) with PFPI's two-tier admin/commissioner split
 * dropped - there's only one login here.
 *
 * Serves the API behind site/admin.html (a static page on the existing
 * GitHub Pages site, same "static frontend + Worker API" split as
 * live/worker.js). This Worker deploys separately (`powerswap-admin`)
 * and does not touch live/'s KV namespace, cron, or code.
 *
 * Endpoints:
 *   POST /api/login              { password } -> { token, expires_at }
 *   GET  /api/session            Authorization: Bearer <token> -> { valid, expires_at }
 *   POST /api/logout             Authorization: Bearer <token> -> revokes the session in KV
 *   POST /api/forgot-password    {} -> emails a reset link to ADMIN_EMAIL via Resend
 *   POST /api/reset-password     { token, new_password } -> sets a new password hash
 *   GET  /api/digest?season=&week=          Authorization required -> latest versioned snapshot
 *   POST /api/recompute          { season, week } Authorization required -> dispatches GitHub Actions
 *   GET  /api/recompute-status?season=&week=  Authorization required -> { status: idle|running|done|failed }
 *
 * Secrets (wrangler secret put, never committed):
 *   ADMIN_PASSWORD_HASH  - pbkdf2$sha256$<iterations>$<salt_b64>$<hash_b64>
 *                           (see admin/tools/hash_password.mjs)
 *   SESSION_HMAC_KEY     - random signing key for session/reset tokens
 *   RESEND_API_KEY       - resend.com API key (free tier)
 *   ADMIN_EMAIL          - where password-reset links are sent
 *   GITHUB_TOKEN         - fine-grained PAT, this repo only, Contents:
 *                          Read&Write + Actions: Read&Write (dispatches
 *                          the recompute workflow and reads commit SHAs)
 *
 * KV binding: ADMIN_KV (see wrangler.toml).
 *
 * A password reset OVERRIDES the ADMIN_PASSWORD_HASH secret: if
 * `password_hash_override` exists in KV, it takes precedence. This is
 * the PFPI pattern verbatim - a Secret can't be changed at runtime from
 * inside a Worker, so self-service reset has to live in KV instead.
 */

import { GITHUB_OWNER, GITHUB_REPO, WORKFLOW_FILE } from "./config.js";

const SESSION_TTL_SECONDS = 3 * 60 * 60; // "a few hours" per the playbook
const RESET_TOKEN_TTL_SECONDS = 30 * 60; // 30 min per the playbook
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60; // fail-count resets after an hour of quiet
const RATE_LIMIT_MAX_DELAY_SECONDS = 30; // progressive delay caps here - never a hard lockout
const FORGOT_PASSWORD_COOLDOWN_SECONDS = 5 * 60; // don't let /forgot-password burn the Resend quota
const RECOMPUTE_PENDING_TTL_SECONDS = 10 * 60; // safety net if GitHub Actions never finishes

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function badRequest(message) {
  return json({ error: message }, 400);
}

function unauthorized(message = "Unauthorized") {
  return json({ error: message }, 401);
}

// ---------------------------------------------------------------------
// Crypto helpers - all Web Crypto (crypto.subtle), no external library,
// same API surface admin/tools/hash_password.mjs uses locally so the
// hash format is guaranteed to match.
// ---------------------------------------------------------------------

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToB64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function randomToken(byteLength = 32) {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(byteLength))).replace(/[+/=]/g, "");
}

async function verifyPassword(password, encodedHash) {
  const [scheme, algo, iterationsStr, saltB64, hashB64] = encodedHash.split("$");
  if (scheme !== "pbkdf2" || algo !== "sha256") {
    throw new Error(`Unrecognized password hash format: ${scheme}$${algo}`);
  }
  const iterations = parseInt(iterationsStr, 10);
  const salt = b64ToBytes(saltB64);
  const expected = b64ToBytes(hashB64);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    expected.length * 8
  );
  const actual = new Uint8Array(bits);

  // Constant-time compare - a single admin password is exactly the case
  // timing side-channels matter for (few guesses needed if leaked).
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

async function hashPasswordForReset(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100_000;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return `pbkdf2$sha256$${iterations}$${bytesToB64(salt)}$${bytesToB64(new Uint8Array(bits))}`;
}

async function hmacKey(rawKey) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(rawKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function sign(rawKey, value) {
  const key = await hmacKey(rawKey);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToB64(sig);
}

async function verifySignature(rawKey, value, signatureB64) {
  const key = await hmacKey(rawKey);
  try {
    return await crypto.subtle.verify("HMAC", key, b64ToBytes(signatureB64), new TextEncoder().encode(value));
  } catch {
    return false; // malformed base64, etc. - just means "not valid"
  }
}

// ---------------------------------------------------------------------
// Auth: password verification (checks KV override first)
// ---------------------------------------------------------------------

async function getCurrentPasswordHash(env) {
  const override = await env.ADMIN_KV.get("password_hash_override");
  return override ?? env.ADMIN_PASSWORD_HASH;
}

// ---------------------------------------------------------------------
// Rate limiting: per-IP progressive delay, not a hard lockout. Delay is
// applied BEFORE checking the password, so a scripted attacker pays the
// same cost whether or not brute-forcing is their actual goal.
// ---------------------------------------------------------------------

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function applyLoginDelay(env, ip) {
  const key = `ratelimit:${ip}`;
  const record = await env.ADMIN_KV.get(key, "json");
  const failCount = record?.fail_count ?? 0;
  if (failCount > 0) {
    const delaySeconds = Math.min(failCount * 2, RATE_LIMIT_MAX_DELAY_SECONDS);
    await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
  }
  return failCount;
}

async function recordLoginFailure(env, ip, failCount) {
  await env.ADMIN_KV.put(
    `ratelimit:${ip}`,
    JSON.stringify({ fail_count: failCount + 1 }),
    { expirationTtl: RATE_LIMIT_WINDOW_SECONDS }
  );
}

async function clearLoginFailures(env, ip) {
  await env.ADMIN_KV.delete(`ratelimit:${ip}`);
}

// ---------------------------------------------------------------------
// Sessions: random token, looked up directly in KV (the KV record IS
// the source of truth for validity - "centrally checked/expired" per
// the playbook). No HMAC needed on the session token itself since
// possession of the token IS the credential once issued, same as any
// bearer token / cookie session; HMAC is used for the reset-link token
// instead, which travels over email and needs to be self-verifying.
// ---------------------------------------------------------------------

async function createSession(env) {
  const token = randomToken();
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  await env.ADMIN_KV.put(`session:${token}`, JSON.stringify({ expires_at: expiresAt }), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return { token, expiresAt };
}

async function validateSession(env, request) {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const record = await env.ADMIN_KV.get(`session:${token}`, "json");
  if (!record) return null;
  if (record.expires_at < Date.now()) {
    await env.ADMIN_KV.delete(`session:${token}`);
    return null;
  }
  return { token, expiresAt: record.expires_at };
}

// ---------------------------------------------------------------------
// Password reset: signed, single-use, 30-min link. The token is
// HMAC-signed so a leaked KV dump alone (not the signing key) can't be
// used to forge new reset tokens; KV is still what makes it single-use
// (deleted on success) and centrally revocable.
// ---------------------------------------------------------------------

async function createResetToken(env) {
  const raw = randomToken();
  const signature = await sign(env.SESSION_HMAC_KEY, raw);
  await env.ADMIN_KV.put(`reset_token:${raw}`, JSON.stringify({ created_at: Date.now() }), {
    expirationTtl: RESET_TOKEN_TTL_SECONDS,
  });
  return `${raw}.${signature}`;
}

async function consumeResetToken(env, token) {
  const [raw, signature] = String(token).split(".");
  if (!raw || !signature) return false;
  if (!(await verifySignature(env.SESSION_HMAC_KEY, raw, signature))) return false;
  const record = await env.ADMIN_KV.get(`reset_token:${raw}`);
  if (!record) return false; // expired (KV TTL) or already used
  await env.ADMIN_KV.delete(`reset_token:${raw}`); // single-use, deleted immediately
  return true;
}

// ---------------------------------------------------------------------
// Resend (transactional email) - https://resend.com, free tier.
// ---------------------------------------------------------------------

async function sendResetEmail(env, resetUrl) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM ?? "PowerSwap Admin <onboarding@resend.dev>",
      to: [env.ADMIN_EMAIL],
      subject: "PowerSwap Admin - Password Reset",
      html: `
        <p>A password reset was requested for the PowerSwap admin portal.</p>
        <p><a href="${resetUrl}">Reset your password</a> (expires in 30 minutes, single use).</p>
        <p>If you didn't request this, you can ignore this email - nothing changes until the link above is used.</p>
      `,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Resend API returned ${resp.status}: ${body}`);
  }
}

// ---------------------------------------------------------------------
// GitHub Actions dispatch (Recompute) - keeps sports/cfb/havoc_rating.py
// as the one real implementation of the scoring math; this Worker never
// reimplements it. See admin/BUILD_LOG.md for why this was chosen over
// a JS reimplementation.
// ---------------------------------------------------------------------

function havocRatingsPath(season, week) {
  return `data/cfb/seasons/${season}/raw/week_${String(week).padStart(2, "0")}_havoc_ratings.json`;
}

function recomputeMarkerPath(season, week) {
  // Always changes on every workflow run, even if the recomputed data
  // itself is byte-identical to last time - see recompute-havoc.yml's
  // "Write recompute marker" step for why this, not the ratings file
  // itself, is what completion is detected from.
  return `data/cfb/seasons/${season}/raw/week_${String(week).padStart(2, "0")}_recompute_marker.json`;
}

async function githubApi(env, path, options = {}) {
  const resp = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "powerswap-admin-worker",
      ...(options.headers ?? {}),
    },
  });
  return resp;
}

async function getFileSha(env, path) {
  const resp = await githubApi(env, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`);
  if (resp.status === 404) return null; // file doesn't exist yet - not an error
  if (!resp.ok) throw new Error(`GitHub contents API returned ${resp.status}`);
  const data = await resp.json();
  return data.sha;
}

async function getFileContent(env, path) {
  const resp = await githubApi(env, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`);
  if (!resp.ok) throw new Error(`GitHub contents API returned ${resp.status}`);
  const data = await resp.json();
  const bytes = b64ToBytes(data.content.replace(/\n/g, ""));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function dispatchRecomputeWorkflow(env, season, week) {
  const resp = await githubApi(
    env,
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { season: String(season), week: String(week) } }),
    }
  );
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub workflow dispatch returned ${resp.status}: ${body}`);
  }
}

// ---------------------------------------------------------------------
// Digest snapshots: versioned in KV, never overwritten. Recompute adds
// a new version and repoints "latest" - the original stays readable by
// version number, per the playbook's audit-trail requirement.
// ---------------------------------------------------------------------

const BULLET_LABELS = {
  vegas_closeness: (g) => {
    const spread = g.raw_averages.avg_abs_spread;
    if (spread === null || spread === undefined) return null;
    return `Vegas spread: ${spread.toFixed(1)} points (${spread < 7 ? "close game" : "clearer favorite"})`;
  },
  moneyline_closeness: (g) => {
    const { avg_home_implied_prob: home, avg_away_implied_prob: away } = g.raw_averages;
    if (home === null || home === undefined) return null;
    const favorite = home >= away ? g.home_team : g.away_team;
    const prob = Math.max(home, away);
    return `Moneyline implies ${favorite} favored ~${Math.round(prob * 100)}%`;
  },
  over_under: (g) => {
    const ou = g.raw_averages.avg_over_under;
    if (ou === null || ou === undefined) return null;
    return `Over/under set at ${ou}`;
  },
  powerswap_rank_gap: (g) => {
    const { home, away } = g.ranks.powerswap;
    if (home && away) return `PowerSwap: #${home} ${g.home_team} vs #${away} ${g.away_team} (gap of ${Math.abs(home - away)})`;
    const rankedSide = home ? { rank: home, team: g.home_team, other: g.away_team } : { rank: away, team: g.away_team, other: g.home_team };
    return `PowerSwap #${rankedSide.rank} ${rankedSide.team} facing unranked ${rankedSide.other}`;
  },
  ap_rank_gap: (g) => {
    const { home, away } = g.ranks.ap;
    if (home && away) return `AP Top 25: #${home} ${g.home_team} vs #${away} ${g.away_team} (gap of ${Math.abs(home - away)})`;
    const rankedSide = home ? { rank: home, team: g.home_team, other: g.away_team } : { rank: away, team: g.away_team, other: g.home_team };
    return `AP #${rankedSide.rank} ${rankedSide.team} facing unranked ${rankedSide.other}`;
  },
};

function buildBullets(game) {
  // Rank components by their actual weighted contribution to the score
  // (not a fixed priority order) so the 3 shown are always whichever
  // genuinely moved this specific game's rating the most.
  const ranked = Object.entries(game.weighted_contributions ?? {})
    .sort(([, a], [, b]) => b - a)
    .map(([key]) => key);

  const bullets = [];
  for (const key of ranked) {
    const label = BULLET_LABELS[key]?.(game);
    if (label) bullets.push(label);
    if (bullets.length === 3) break;
  }
  return bullets;
}

async function buildDigestSnapshot(env, season, week, sourceLabel) {
  const raw = await getFileContent(env, havocRatingsPath(season, week));
  const eligible = raw.games.filter((g) => !g.not_swap_eligible && g.havoc_rating !== null);
  eligible.sort((a, b) => b.havoc_rating - a.havoc_rating);

  return {
    season,
    week,
    generated_at: new Date().toISOString(),
    source: sourceLabel,
    injury_note: "Injury reports are not yet a factor in these ratings - pending a real data source.",
    games: eligible.map((g) => ({
      home_team: g.home_team,
      away_team: g.away_team,
      havoc_rating: g.havoc_rating,
      bullets: buildBullets(g),
    })),
  };
}

async function getOrCreateDigest(env, season, week) {
  const latestKey = `digest:${season}:${week}:latest`;
  const latestVersion = await env.ADMIN_KV.get(latestKey, "json");
  if (latestVersion) {
    return env.ADMIN_KV.get(`digest:${season}:${week}:v${latestVersion.version}`, "json");
  }
  // First view of this week - freeze v1 from whatever's currently committed.
  const snapshot = await buildDigestSnapshot(env, season, week, "initial");
  snapshot.version = 1;
  await env.ADMIN_KV.put(`digest:${season}:${week}:v1`, JSON.stringify(snapshot));
  await env.ADMIN_KV.put(latestKey, JSON.stringify({ version: 1 }));
  return snapshot;
}

async function addDigestVersion(env, season, week) {
  const latestKey = `digest:${season}:${week}:latest`;
  const latestVersion = await env.ADMIN_KV.get(latestKey, "json");
  const nextVersion = (latestVersion?.version ?? 0) + 1;
  const snapshot = await buildDigestSnapshot(env, season, week, "recompute");
  snapshot.version = nextVersion;
  await env.ADMIN_KV.put(`digest:${season}:${week}:v${nextVersion}`, JSON.stringify(snapshot));
  await env.ADMIN_KV.put(latestKey, JSON.stringify({ version: nextVersion }));
  return snapshot;
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

async function handleLogin(request, env) {
  const ip = clientIp(request);
  const { password } = await request.json().catch(() => ({}));
  if (!password) return badRequest("Missing password");

  const failCount = await applyLoginDelay(env, ip);

  const hash = await getCurrentPasswordHash(env);
  if (!hash || !(await verifyPassword(password, hash))) {
    await recordLoginFailure(env, ip, failCount);
    return unauthorized("Incorrect password");
  }

  await clearLoginFailures(env, ip);
  const { token, expiresAt } = await createSession(env);
  return json({ token, expires_at: expiresAt });
}

async function handleSession(request, env) {
  const session = await validateSession(env, request);
  if (!session) return unauthorized();
  return json({ valid: true, expires_at: session.expiresAt });
}

async function handleLogout(request, env) {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (token) await env.ADMIN_KV.delete(`session:${token}`);
  return json({ ok: true });
}

async function handleForgotPassword(request, env) {
  const ip = clientIp(request);
  const cooldownKey = `forgot_cooldown:${ip}`;
  if (await env.ADMIN_KV.get(cooldownKey)) {
    // Deliberately vague response either way - don't reveal rate-limit
    // state to an unauthenticated caller.
    return json({ ok: true });
  }
  await env.ADMIN_KV.put(cooldownKey, "1", { expirationTtl: FORGOT_PASSWORD_COOLDOWN_SECONDS });

  const token = await createResetToken(env);
  const url = new URL(request.url);
  const resetUrl = `${env.ADMIN_PAGE_URL}?reset_token=${encodeURIComponent(token)}`;
  try {
    await sendResetEmail(env, resetUrl);
  } catch (err) {
    console.error("Failed to send reset email:", err.message);
    // Still return ok - don't leak whether email sending succeeded to
    // an unauthenticated caller. The failure is visible in Worker logs.
  }
  return json({ ok: true });
}

async function handleResetPassword(request, env) {
  const { token, new_password } = await request.json().catch(() => ({}));
  if (!token || !new_password) return badRequest("Missing token or new_password");
  if (new_password.length < 12) return badRequest("Password must be at least 12 characters");

  if (!(await consumeResetToken(env, token))) {
    return unauthorized("Reset link is invalid, expired, or already used");
  }

  const newHash = await hashPasswordForReset(new_password);
  await env.ADMIN_KV.put("password_hash_override", newHash);
  return json({ ok: true });
}

async function handleDigest(request, env) {
  if (!(await validateSession(env, request))) return unauthorized();
  const url = new URL(request.url);
  const season = url.searchParams.get("season");
  const week = url.searchParams.get("week");
  if (!season || !week) return badRequest("Missing season or week");

  try {
    const snapshot = await getOrCreateDigest(env, season, week);
    return json(snapshot);
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

async function handleRecompute(request, env) {
  if (!(await validateSession(env, request))) return unauthorized();
  const { season, week } = await request.json().catch(() => ({}));
  if (!season || !week) return badRequest("Missing season or week");

  const pendingKey = `recompute_pending:${season}:${week}`;
  if (await env.ADMIN_KV.get(pendingKey)) {
    return json({ status: "already_running" });
  }

  let beforeSha;
  try {
    beforeSha = await getFileSha(env, recomputeMarkerPath(season, week));
    await dispatchRecomputeWorkflow(env, season, week);
  } catch (err) {
    return json({ error: err.message }, 502);
  }

  await env.ADMIN_KV.put(
    pendingKey,
    JSON.stringify({ before_sha: beforeSha, dispatched_at: Date.now() }),
    { expirationTtl: RECOMPUTE_PENDING_TTL_SECONDS }
  );
  return json({ status: "triggered" });
}

async function handleRecomputeStatus(request, env) {
  if (!(await validateSession(env, request))) return unauthorized();
  const url = new URL(request.url);
  const season = url.searchParams.get("season");
  const week = url.searchParams.get("week");
  if (!season || !week) return badRequest("Missing season or week");

  const pendingKey = `recompute_pending:${season}:${week}`;
  const pending = await env.ADMIN_KV.get(pendingKey, "json");
  if (!pending) return json({ status: "idle" });

  let currentSha;
  try {
    currentSha = await getFileSha(env, recomputeMarkerPath(season, week));
  } catch (err) {
    return json({ error: err.message }, 502);
  }

  if (currentSha === pending.before_sha) {
    const elapsedMs = Date.now() - pending.dispatched_at;
    if (elapsedMs > RECOMPUTE_PENDING_TTL_SECONDS * 1000 * 0.8) {
      // Not confirmed failed - GitHub Actions can genuinely be slow -
      // but past this point "still running" would be misleading.
      return json({ status: "slow_or_failed", elapsed_seconds: Math.round(elapsedMs / 1000) });
    }
    return json({ status: "running" });
  }

  await env.ADMIN_KV.delete(pendingKey);
  const snapshot = await addDigestVersion(env, season, week);
  return json({ status: "done", snapshot });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    try {
      if (url.pathname === "/api/login" && request.method === "POST") return handleLogin(request, env);
      if (url.pathname === "/api/session" && request.method === "GET") return handleSession(request, env);
      if (url.pathname === "/api/logout" && request.method === "POST") return handleLogout(request, env);
      if (url.pathname === "/api/forgot-password" && request.method === "POST") return handleForgotPassword(request, env);
      if (url.pathname === "/api/reset-password" && request.method === "POST") return handleResetPassword(request, env);
      if (url.pathname === "/api/digest" && request.method === "GET") return handleDigest(request, env);
      if (url.pathname === "/api/recompute" && request.method === "POST") return handleRecompute(request, env);
      if (url.pathname === "/api/recompute-status" && request.method === "GET") return handleRecomputeStatus(request, env);
    } catch (err) {
      console.error("Unhandled error:", err.stack ?? err.message);
      return json({ error: "Internal error" }, 500);
    }

    return json({ error: "Not found" }, 404);
  },
};
