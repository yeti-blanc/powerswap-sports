"""
PowerSwap CFB - Betting Provider Name Normalization

Same failure class team_norm.py was built for, one level over: CFBD's
/lines endpoint doesn't consistently spell the same real-world sportsbook
the same way. CONFIRMED REAL, not a guess - a real pull for year=2026,
week=1, seasonType=regular returned 159 lines tagged provider="DraftKings"
and 66 tagged provider="Draft Kings" in the SAME response. A naive
group-by on the raw provider string would silently treat these as two
different books, splitting one book's real line data in half and
under-weighting it in anything that averages or counts by provider.

Rule, same as team_norm.py: when CFBD returns a provider spelling you
don't recognize as matching an existing one, add it here.
"""

# Maps a known variant -> the canonical provider name to use everywhere.
NORM = {
    "Draft Kings": "DraftKings",
}


def norm(provider_name: str) -> str:
    """
    Returns the canonical name for a betting provider. If the name isn't
    a known variant, it's returned unchanged (assumed already canonical).
    """
    return NORM.get(provider_name, provider_name)


def normalize_lines(lines: list[dict]) -> list[dict]:
    return [{**line, "provider": norm(line["provider"])} for line in lines]
