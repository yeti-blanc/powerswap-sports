"""
PowerSwap CBB - Team Name Normalization

Same principle as sports/cfb/team_norm.py: normalize at ingestion, before
any name touches the rankings state, so a real result never silently
disappears because of a spelling mismatch.

Kept as a SEPARATE dict from the CFB one, not because the underlying bug
is different, but because the team universe is different. CBB Division I
includes ~360+ programs, well over double the FBS football count, and a
meaningful chunk of them (Gonzaga, Saint Mary's, Davidson, Loyola Chicago,
etc.) don't field FBS football teams at all, so there's no reason to
assume the same normalization entries apply.

This seed list is a starting guess based on common CBB naming quirks, NOT
verified against actual CBBD output. Expand it as real mismatches surface.
"""

NORM = {
    "Hawai'i": "Hawaii",
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
    "St. John's": "St. John's (NY)",  # CBB-specific disambiguation guess - verify
    "Saint Mary's": "Saint Mary's (CA)",  # same - verify against real data
}


def norm(team_name: str) -> str:
    return NORM.get(team_name, team_name)


def normalize_team_list(teams: list[str]) -> list[str]:
    return [norm(t) for t in teams]


def normalize_games(games: list[dict]) -> list[dict]:
    return [{**g, "winner": norm(g["winner"]), "loser": norm(g["loser"])} for g in games]
