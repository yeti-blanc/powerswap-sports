"""
PowerSwap CFB - per-week matchup/schedule display data

Generalizes fetch_week1_matchups.py to any week of the CURRENT season.
That script stays exactly as it is - live/worker.js reads its output
(week1_matchups.json) by a hardcoded URL for mascot-free opponent naming,
and 5 past seasons already have committed week1_matchups.json files -
this is a separate script for week 2 onward, not a replacement.

Purely a display addition, same as week 1's version: for each
currently-ranked team, find their opponent for the given week and
whether they're home or away, plus a final score once that game is
actually played. Does NOT touch the swap engine or the ranking pipeline
- core/swap_engine.py is never imported here. See
fetch_week1_matchups.py's header for the CFBD API quirks this also
relies on (division=fbs doesn't actually filter to FBS-only, and team
names need team_norm normalizing before matching).

Run twice per week by the season-progression automation
(.github/workflows/season-progression.yml):
  1. For the week that was JUST backtested, to bake in the final score
     (completed=true) now that it's known.
  2. For the following week, to seed a schedule preview (completed=false,
     kickoff time only) - so the site can show "what's coming" the
     moment the current week solidifies, instead of nothing or stale
     data from the week before.

Usage:
    export CFBD_API_KEY="your_key_here"
    python sports/cfb/fetch_week_matchups.py --season 2026 --week 2
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


def fetch_week_matchups(season: int, week: int) -> dict[str, dict]:
    games = cfbd_get("/games", {
        "year": season, "week": week, "seasonType": "regular",
        "division": cfb_config.DIVISION_FILTER,
    })

    ranked_teams = set(get_ranked_teams(season))
    matchups = {}

    for g in games:
        home = norm(g.get("homeTeam", ""))
        away = norm(g.get("awayTeam", ""))
        kickoff = {
            "kickoff_utc": g.get("startDate"),
            "start_time_tbd": g.get("startTimeTBD", False),
        }
        completed = bool(g.get("completed"))
        home_points = g.get("homePoints")
        away_points = g.get("awayPoints")

        if home in ranked_teams:
            matchups[home] = {
                "opponent": away, "home_away": "home", **kickoff,
                "completed": completed,
                "team_score": home_points if completed else None,
                "opponent_score": away_points if completed else None,
            }
        if away in ranked_teams:
            matchups[away] = {
                "opponent": home, "home_away": "away", **kickoff,
                "completed": completed,
                "team_score": away_points if completed else None,
                "opponent_score": home_points if completed else None,
            }

    missing = ranked_teams - matchups.keys()
    if missing:
        print(f"  No Week {week} game found for: {sorted(missing)} "
              f"(bye week, or a team-name mismatch - check team_norm.py if unexpected)")

    return matchups


def save_json(data: dict, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Wrote {path}")


def main():
    parser = argparse.ArgumentParser(description="Fetch a week's matchups for currently-ranked CFB teams")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, required=True)
    args = parser.parse_args()

    matchups = fetch_week_matchups(args.season, args.week)
    save_json(
        {"season": args.season, "week": args.week, "matchups": matchups},
        DATA_DIR / str(args.season) / "raw" / f"week_{args.week:02d}_matchups.json",
    )


if __name__ == "__main__":
    main()
