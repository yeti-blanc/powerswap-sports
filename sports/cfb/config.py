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

# Typical CFB regular season length. Conference championship games are
# postseason in CFBD's classification and are deliberately excluded for now.
REGULAR_SEASON_WEEKS = 15
