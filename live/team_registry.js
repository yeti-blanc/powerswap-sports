/**
 * PowerSwap Live Scores - Team Registry (JS twin of core/teams.py)
 * ================================================================
 *
 * Reads the SAME generated file the Python pipeline uses,
 * data/teams/<sport>_teams.json (bundled into the Worker at deploy time
 * by wrangler's JSON import - no runtime fetch, no CPU spent building an
 * index per request: the alias/ID indexes are precomputed by
 * scripts/build_team_registry.py). See core/teams.py's header for the
 * full resolution order and why each step exists.
 *
 * foldTeamName() and nameVariants() MUST stay equivalent to core/teams.py's
 * fold() and name_variants(): tests/test_team_registry.py runs every alias
 * in both registries through both implementations and fails on any
 * difference.
 */

const APOSTROPHES_AND_DOTS = /[’‘ʻʼ`´'.]/g;
const AMPERSAND = /\s*&\s*/g;
const NON_ALNUM = /[^a-z0-9&()]+/g;
const DIVISION_I = new Set(["fbs", "fcs", "d1"]);
const GENERIC_SUFFIXES = [" university", " college", " univ"];
const STATE_CODE_SUFFIX = /^(.+) ([a-z]{2})$/;

export function foldTeamName(name) {
  if (!name) return "";
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(APOSTROPHES_AND_DOTS, "")
    .replace(AMPERSAND, "&")
    .replace(NON_ALNUM, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function editDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function mascotMatches(remainder, mascot) {
  if (!remainder || !mascot) return false;
  if (remainder === mascot) return true;
  if (mascot.length >= 4 && remainder.length >= 4 && (remainder.startsWith(mascot) || mascot.startsWith(remainder))) {
    return true;
  }
  return mascot.length >= 5 && editDistance(remainder, mascot, 2) <= 2;
}

function stripGenericSuffixes(s) {
  for (const suffix of GENERIC_SUFFIXES) {
    if (s.endsWith(suffix)) s = s.slice(0, -suffix.length);
  }
  return s;
}

export function nameVariants(key) {
  const out = [];
  let base = key.startsWith("university of ") ? key.slice("university of ".length) : key;
  base = stripGenericSuffixes(base);
  if (base !== key) out.push(base);
  const m = STATE_CODE_SUFFIX.exec(base);
  if (m && m[2] !== "st" && m[2] !== "of") {
    out.push(`${stripGenericSuffixes(m[1])} (${m[2]})`);
  }
  if (base.endsWith(" st")) out.push(base.slice(0, -3) + " state");
  return out;
}

export function createTeamRegistry(data) {
  const teams = data.teams;
  const aliasIndex = data.alias_index;
  const idIndex = data.id_index;
  const byName = new Map(Object.entries(teams).map(([id, t]) => [t.name, id]));

  function resolve(rawName) {
    const key = foldTeamName(rawName);
    if (!key) return null;
    const hit = aliasIndex[key];
    if (hit) return hit;
    const words = key.split(" ");
    for (let cut = words.length - 1; cut > 0; cut--) {
      const prefixId = aliasIndex[words.slice(0, cut).join(" ")];
      if (!prefixId) continue;
      const remainder = words.slice(cut).join(" ");
      if (teams[prefixId].mascots.some((m) => mascotMatches(remainder, m))) return prefixId;
    }
    for (const variant of nameVariants(key)) {
      const v = aliasIndex[variant];
      if (v && !DIVISION_I.has(teams[v].classification)) return v;
    }
    return null;
  }

  function resolveId(source, sourceId) {
    if (sourceId == null || sourceId === "") return null;
    return idIndex[`${source}:${sourceId}`] ?? null;
  }

  return {
    sport: data.sport,
    resolve,
    resolveId,
    team: (id) => teams[id] ?? null,
    name: (id) => teams[id]?.name ?? null,
    idForName: (canonicalName) => byName.get(canonicalName) ?? null,
  };
}
