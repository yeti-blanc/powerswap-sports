"""
PowerSwap CFB - sport configuration.

Football's CFBD API is organized around discrete week numbers - "give me
week 7's games" is a first-class query. That's the cleanest possible
shape for this project's weekly-snapshot model, and it's the reason
football is the sport to prove the architecture on first.
"""

SPORT_KEY = "cfb"
DISPLAY_NAME = "College Football"

API_BASE_URL = "https://api.collegefootballdata.com"
POLL_NAME = "AP Top 25"

# CFBD's /games endpoint takes a division filter; "fbs" is the right scope
# for a 25-team AP poll context (FCS teams essentially never appear).
DIVISION_FILTER = "fbs"

# Typical CFB regular season length, INCLUDING conference championship
# weekend. Confirmed against real 2024 data: CFBD classifies championship
# games (e.g. Georgia vs Texas in the SEC title game) under seasonType
# "regular", as the final week of the regular slate - NOT under
# "postseason" as an earlier version of this comment incorrectly assumed.
# No special-casing needed: a currently-ranked team in a championship game
# is on the table to swap/be dethroned exactly like any other game. A
# ranked team whose conference has no championship game simply has no
# game that week and is frozen, same as any other bye.
REGULAR_SEASON_WEEKS = 15

# Bowl games and the College Football Playoff. Same rule as championship
# weekend, applied one level further: a currently-ranked team playing in
# a bowl or playoff game is on the table; a ranked team not in any
# postseason game simply has no game and stays frozen, same as a bye.
# UNVERIFIED: "postseason" is the expected CFBD seasonType value for this
# based on the standard CFBD schema, but hasn't been confirmed against a
# real call yet - check this on first real postseason fetch.
POSTSEASON_SEASON_TYPE = "postseason"