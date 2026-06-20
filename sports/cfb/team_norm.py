"""
PowerSwap CFB - Team Name Normalization

Direct lesson from the Cote Cup project: never trust an API to return the
same name for the same entity every time. football-data.org did this to
the World Cup tracker with country names (Cape Verde / Cabo Verde / Cape
Verde Islands all meaning the same team). CFBD will almost certainly do
the same thing with school names across its /rankings and /games
endpoints, or even between different seasons.

The danger is silent, not loud: if "Hawaii" in the preseason poll and
"Hawai'i" in a games payload are treated as two different teams, the
swap engine won't error out - it will just quietly conclude Hawaii never
played a single game all season. No exception, no crash, just a wrong
answer that looks plausible.

Rule, same as the Cote Cup project: when CFBD returns a name you don't
recognize as matching an existing one, add it here. Don't patch individual
data points downstream.

This seed list below is a starting point based on commonly known CFB
naming quirks - it has NOT been validated against actual CFBD API output,
since fetching real data requires network access this environment doesn't
have. Treat it as a first draft to test against the real API responses,
not a verified list.
"""

# Maps a known variant -> the canonical name to use everywhere.
# Canonical names chosen to match how CFBD's own /teams endpoint typically
# lists schools - verify this against a real /teams pull before trusting it.
NORM = {
    # Common abbreviation / full-name mismatches
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

    # Disambiguation cases - CFBD sometimes appends location to avoid
    # collisions (Miami FL vs Miami OH, etc.)
    "Miami (FL)": "Miami",
    "Miami (OH)": "Miami (Ohio)",

    # Known mid-window rebrands / renames worth double-checking for the
    # 2021-2025 window specifically:
    # - none confirmed without checking the live API; add here as found.
}


def norm(team_name: str) -> str:
    """
    Returns the canonical name for a team. If the name isn't a known
    variant, it's returned unchanged (assumed already canonical).
    """
    return NORM.get(team_name, team_name)


def normalize_team_list(teams: list[str]) -> list[str]:
    return [norm(t) for t in teams]


def normalize_games(games: list[dict]) -> list[dict]:
    # **g preserves any extra fields (like "date") - needed for postseason
    # games, which can have a team playing multiple rounds and therefore
    # need chronological sorting, same reasoning as basketball's multi-game
    # weeks. Existing regular-season weekly fetches only ever build
    # winner/loser dicts with no extra fields, so this is a no-op for them.
    return [{**g, "winner": norm(g["winner"]), "loser": norm(g["loser"])} for g in games]