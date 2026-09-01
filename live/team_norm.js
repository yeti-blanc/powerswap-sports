/**
 * PowerSwap Live Scores - team name resolution
 * =============================================
 *
 * Cloudflare Workers can't import sports/cfb/team_norm.py directly (that's
 * Python, this runs in the Workers JS runtime), so this is a hand-ported
 * mirror of its NORM table and norm() function. Keep this in sync if the
 * Python source gains new variant entries.
 *
 * BBS adds a second, separate problem on top of the one team_norm.py was
 * built for: it names teams "School Mascot" (e.g. "Rutgers Scarlet
 * Knights", "UCF Knights"), while CFBD - and therefore season_history.json
 * and this NORM table - use school name only ("Rutgers", "Central
 * Florida"). Confirmed against a real /v1/matches response on 2026-09-01:
 * every observed BBS team name is "<school><space><mascot>", with the
 * school name (or one of its known variants below) always a leading
 * prefix. resolveBbsTeamName() below relies on that, checked against only
 * the small set of currently-ranked teams (<=25), not a general-purpose
 * mascot stripper.
 */

// Mirrors sports/cfb/team_norm.py's NORM dict. Maps a known variant -> the
// canonical name used in season_history.json.
export const NORM = {
  "Hawai'i": "Hawaii",
  "App State": "Appalachian State",
  "Sam Houston": "Sam Houston State",
  "UMass": "Massachusetts",
  "UConn": "Connecticut",
  "Ole Miss": "Mississippi",
  "Pitt": "Pittsburgh",
  "USF": "South Florida",
  "UCF": "Central Florida",
  "FIU": "Florida International",
  "FAU": "Florida Atlantic",
  "UTSA": "UT San Antonio",
  "UNLV": "Nevada-Las Vegas",
  "San Jose State": "San José State",
  "Miami (FL)": "Miami",
  "Miami (OH)": "Miami (Ohio)",
};

export function norm(teamName) {
  return NORM[teamName] ?? teamName;
}

// canonical -> [canonical, ...known variants that map to it]
const REVERSE = {};
for (const [variant, canonical] of Object.entries(NORM)) {
  (REVERSE[canonical] ??= new Set()).add(canonical);
  REVERSE[canonical].add(variant);
}

function foldDiacritics(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Given a BBS full team name (e.g. "Rutgers Scarlet Knights") and the list
 * of currently-ranked canonical team names (from season_history.json),
 * return the matching canonical name, or null if none of the ranked teams
 * appear to be this team.
 *
 * UNVERIFIED beyond the handful of real examples pulled on 2026-09-01
 * (Rutgers, Massachusetts, Wake Forest, Akron, Kennesaw State, West
 * Georgia, Buffalo, UAlbany, UCF, Bethune-Cookman). Revisit if a ranked
 * team stops matching once real games are live.
 */
export function resolveBbsTeamName(bbsName, rankedCanonicalNames) {
  if (!bbsName) return null;
  const folded = foldDiacritics(bbsName).toLowerCase();

  for (const canonical of rankedCanonicalNames) {
    const candidates = REVERSE[canonical] ? [...REVERSE[canonical]] : [canonical];
    for (const candidate of candidates) {
      const foldedCandidate = foldDiacritics(candidate).toLowerCase();
      if (folded === foldedCandidate || folded.startsWith(foldedCandidate + " ")) {
        return canonical;
      }
    }
  }
  return null;
}
