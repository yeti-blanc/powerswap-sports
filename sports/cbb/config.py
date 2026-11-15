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

Field names and filters below were verified against real CBBD responses
on 2026-11-15 (season=2027, 863 games Oct 20 - Nov 16 2026).
"""

SPORT_KEY = "cbb"
DISPLAY_NAME = "College Basketball"

API_BASE_URL = "https://api.collegebasketballdata.com"
POLL_NAME = "AP Top 25"  # verified 2026-10-19: CBBD /rankings rows carry pollType "AP Top 25"

# Verified 2026-11-15: CBBD /games has no division param and needs none -
# every one of 863 real games had a D-I team on at least one side. A
# ranked team losing to a non-D-I opponent is still a real loss under the
# rules (same as an FCS team beating a ranked FBS team in football).
CLASSIFICATION_FILTER = None

# Regular college basketball season: roughly the Monday closest to Nov 1
# through the eve of conference tournaments in early March. This number is
# a rough estimate, not pulled from any verified schedule - confirm against
# the actual season calendar each year, since exact start dates shift.
REGULAR_SEASON_WEEKS = 18

# --- Season naming (verified 2026-11-15 against real CBBD data) ---------
# PowerSwap stores a basketball season under the year it STARTS in
# (data/cbb/seasons/2026 = the 2026-27 season), matching football's
# directory naming and the site's season selector. CBBD names a season by
# the year it ENDS: CBBD season=2027 is 2026-27 (preseason AP poll dated
# 2026-10-19, Florida #1), and CBBD season=2026 is LAST year's 2025-26
# (preseason poll dated 2025-10-13, Purdue #1). Always go through
# cbbd_season() - never pass a PowerSwap year to CBBD directly.
def cbbd_season(year: int) -> int:
    return year + 1


# --- Week boundaries ------------------------------------------------------
# A PowerSwap basketball week is Monday-Sunday by US Eastern calendar date,
# matching the AP poll's real cadence (released Mondays, covering games
# through Sunday - verified: the 2026-27 AP polls are dated Mon 2026-10-19
# (preseason) and Mon 2026-11-09 (first in-season)). CBBD's startDate is
# UTC, so a Sunday-night West Coast tip (Monday 03:00Z) is bucketed by its
# Eastern date, never its UTC date.
#
# WEEK1_MONDAY is the Monday that starts week 1. Any regular-season game
# dated BEFORE it (a lone opener on the preceding weekend) folds into week
# 1 rather than becoming a one-game "week 0" - exactly how the AP treats it
# (its first in-season poll covers everything from the opener through
# week 1's Sunday). Pinned per season from real data, not derived:
#   2026: the only game before Mon 11-02 is Sun 11-01 Notre Dame 74,
#         Villanova 72 (Eternal City Tip-Off, Rome); the full slate opened
#         Mon 11-02 (30 games) / Tue 11-03 (154). Week 1 = Nov 1-8.
WEEK1_MONDAY = {
    2026: "2026-11-02",
}

# First day with a real regular-season game (week 1 starts here when it's
# before WEEK1_MONDAY). ESPN day files are fetched from this date on.
SEASON_FIRST_DAY = {
    2026: "2026-11-01",
}


# Field names verified 2026-11-15 against a real season=2027 /games
# response (also carries homeTeamId/awayTeamId, status "final"/
# "scheduled"/"postponed", gameType "STD"/"TRNMNT").
FIELD_START_DATE = "startDate"
FIELD_HOME_TEAM = "homeTeam"
FIELD_AWAY_TEAM = "awayTeam"
FIELD_HOME_POINTS = "homePoints"
FIELD_AWAY_POINTS = "awayPoints"
