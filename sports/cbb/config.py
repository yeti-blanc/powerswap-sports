"""
PowerSwap CBB - sport configuration.

Basketball's CBBD API does NOT have a "week" parameter for games the way
CFBD does - games are queried by startDateRange/endDateRange instead.
Rankings DO still have a week parameter (the AP poll is still released
weekly), so the baseline-poll fetch looks almost identical to football's,
but the game-results fetch is a genuinely different shape.

PowerSwap's response: define our OWN "week" as a Monday-Sunday calendar
window, independent of how CBBD organizes anything. We pick the boundary,
fetch whatever games fall inside it by date range, sort them chronologically,
and feed them to the same swap engine football uses. The engine doesn't
care that a team might play 2-3 times in what we're calling "one week" -
it processes games in list order and looks up each team's rank fresh every
time, so as long as the list is chronologically sorted, multi-game weeks
resolve correctly in sequence.

Several details below are UNVERIFIED against a real CBBD API response,
since fetching from this sandbox isn't possible. Flagged inline - check
these against the actual /games response on the first real pull.
"""

SPORT_KEY = "cbb"
DISPLAY_NAME = "College Basketball"

API_BASE_URL = "https://api.collegebasketballdata.com"
POLL_NAME = "AP Top 25"  # UNVERIFIED - confirm this is the exact poll name CBBD uses

# UNVERIFIED: CFBD has a "division=fbs" filter on /games. It's not confirmed
# whether CBBD's /games endpoint needs (or even has) an equivalent D-I filter,
# or whether it returns D-I games by default. Check the first real response -
# if non-D-I teams show up, this is where a filter needs to be added.
CLASSIFICATION_FILTER = None

# Regular college basketball season: roughly the Monday closest to Nov 1
# through the eve of conference tournaments in early March. This number is
# a rough estimate, not pulled from any verified schedule - confirm against
# the actual season calendar each year, since exact start dates shift.
REGULAR_SEASON_WEEKS = 18

# UNVERIFIED field names. CFBD uses startDate/homeTeam/awayTeam/homePoints/
# awayPoints on its /games response. CBBD is the same vendor (Rad Sports
# Analytics LLC) so these are a reasonable guess, but confirm against a
# real response before trusting fully.
FIELD_START_DATE = "startDate"
FIELD_HOME_TEAM = "homeTeam"
FIELD_AWAY_TEAM = "awayTeam"
FIELD_HOME_POINTS = "homePoints"
FIELD_AWAY_POINTS = "awayPoints"
