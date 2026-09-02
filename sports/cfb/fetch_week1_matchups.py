"""
PowerSwap CFB - Week 1 matchup display data

Purely a display addition: for each currently-ranked team, find their
Week 1 opponent and whether they're home or away, for the "vs. Team" /
"@ Team" line on each rank card. Does NOT touch the swap engine or the
ranking pipeline in any way - this is schedule data sitting alongside
the rankings, not part of them. core/swap_engine.py is never imported
or called here.

Confirmed against a real call on 2026-09-01 (season=2026, week=1):
  - CFBD's /games endpoint returns homeTeam/awayTeam/week/completed for
    scheduled-but-not-yet-played games exactly like it does for completed
    ones - homePoints/awayPoints are just null until the game is played.
  - The `division=fbs` query param does NOT actually filter the response
    to FBS-only games (FCS/II/III games came back mixed in). Doesn't
    matter for this script - a ranked team is always FBS, so whichever
    game contains them is the right one regardless of what else is in
    the list - but don't assume this param filters anything.
  - Team names need normalizing before matching: CFBD's schedule spells
    it "Ole Miss", not the canonical "Mississippi" used in the rankings
    (and in season_history.json). Confirmed a real case this exposed:
    "Ole Miss vs Louisville" is actually a ranked-vs-ranked game that
    would have silently looked like two byes without team_norm.norm().

Usage:
    export CFBD_API_KEY="your_key_here"
    python sports/cfb/fetch_week1_matchups.py --season 2026
"""

import argparse
import json
import os
import sys
from pathlib import Path

try:
    import requests
except ImportError:
    print("This script requires the 'requests' library. Install with:")
    print("  pip install requests")
    sys.exit(1)

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent.parent))  # repo root, for core/
from team_norm import norm
import config as cfb_config

DATA_DIR = Path(__file__).parent.parent.parent / "data" / "cfb" / "seasons"
WEEK = 1


def get_api_key() -> str:
    key = os.environ.get("CFBD_API_KEY")
    if not key:
        print("ERROR: CFBD_API_KEY environment variable is not set.")
        print("Get a free key at https://collegefootballdata.com/key")
        print('Then: export CFBD_API_KEY="your_key_here"')
        sys.exit(1)
    return key


def cfbd_get(endpoint: str, params: dict) -> list | dict:
    headers = {"Authorization": f"Bearer {get_api_key()}"}
    resp = requests.get(f"{cfb_config.API_BASE_URL}{endpoint}", headers=headers, params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()


def get_ranked_teams(season: int) -> list[str]:
    """Latest snapshot's ranked team names, from season_history.json."""
    path = DATA_DIR / str(season) / "season_history.json"
    if not path.exists():
        raise FileNotFoundError(
            f"Missing {path}. Run fetch_results.py --preseason-poll and "
            f"backtest.py for this season first."
        )
    with open(path) as f:
        data = json.load(f)
    latest = data["snapshots"][-1]
    return [slot["team"] for slot in latest["rankings"]]


def fetch_week1_matchups(season: int) -> dict[str, dict]:
    games = cfbd_get("/games", {
        "year": season, "week": WEEK, "seasonType": "regular",
        "division": cfb_config.DIVISION_FILTER,
    })

    ranked_teams = set(get_ranked_teams(season))
    matchups = {}

    for g in games:
        home = norm(g.get("homeTeam", ""))
        away = norm(g.get("awayTeam", ""))

        if home in ranked_teams:
            matchups[home] = {"opponent": away, "home_away": "home"}
        if away in ranked_teams:
            matchups[away] = {"opponent": home, "home_away": "away"}

    missing = ranked_teams - matchups.keys()
    if missing:
        print(f"  No Week {WEEK} game found for: {sorted(missing)} "
              f"(bye week, or a team-name mismatch - check team_norm.py if unexpected)")

    return matchups


def save_json(data: dict, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Wrote {path}")


def main():
    parser = argparse.ArgumentParser(description="Fetch Week 1 matchups for currently-ranked CFB teams")
    parser.add_argument("--season", type=int, required=True)
    args = parser.parse_args()

    matchups = fetch_week1_matchups(args.season)
    save_json(
        {"season": args.season, "week": WEEK, "matchups": matchups},
        DATA_DIR / str(args.season) / "week1_matchups.json",
    )


if __name__ == "__main__":
    main()
