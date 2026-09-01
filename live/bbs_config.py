"""
PowerSwap Live Scores - Big Balls Sports Data (BBS) config.

This is the Python-side mirror of live/bbs_client.js, used only by the
diagnose script (fetch_live_scores.py) for local testing. The Worker
itself runs in Cloudflare's JS runtime and does not import this file.

Base URL, endpoint, and auth style confirmed with a real authenticated
call on 2026-09-01. Docs: https://bigballsdata.com/docs/introduction,
https://bigballsdata.com/ncaaf-api. Free tier: 1,000 req/day, 2,000/day
on a GitHub-linked account (this account is GitHub-linked).
"""

BASE_URL = "https://api.bigballsdata.com"
SPORT = "american_football"
LEAGUE = "ncaaf"  # FBS only - AP Top 25 never has an FCS team

MATCHES_PATH = "/v1/matches"
STANDINGS_PATH = "/v1/standings"

# See live/bbs_client.js's parseBbsMatch() docstring for the full
# confirmed/UNVERIFIED field breakdown - kept in one place there since
# that's what the deployed Worker actually runs. This file only needs
# enough to drive the diagnose script.
CONFIRMED_TOP_LEVEL_FIELDS = [
    "id", "sport", "league", "home", "away", "kickoff_utc",
    "status", "score", "linescore", "attendance", "broadcast",
    "round", "has_odds",
]

# UNVERIFIED as of 2026-09-01 - no live/in-progress example observed yet.
UNVERIFIED_LIVE_FIELD_GUESSES = ["period", "current_period", "quarter",
                                  "clock", "current_clock", "time_remaining",
                                  "possession", "current_possession"]
