"""
PowerSwap CFB - CFBD Data Fetcher

Pulls from the College Football Data API (collegefootballdata.com):
  - Preseason AP Top 25 poll, used ONLY as the baseline for week 1 of a season
  - Weekly game results (FBS games only), used to feed the swap engine

This script needs network access and a CFBD API key - it will NOT run
inside Claude's sandboxed environment. Run it locally with CFBD_API_KEY set,
or inside a GitHub Action with CFBD_API_KEY as a repo secret.

Get a free key at: https://collegefootballdata.com/key
(The same key works for the basketball sister API - see sports/cbb/.)

Usage:
    export CFBD_API_KEY="your_key_here"
    python sports/cfb/fetch_results.py --season 2024 --week 1
    python sports/cfb/fetch_results.py --season 2024 --preseason-poll
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
from team_norm import normalize_team_list, normalize_games
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


def fetch_preseason_poll(season: int) -> list[str]:
    """Ordered list of the preseason AP Top 25, index 0 = #1."""
    data = cfbd_get("/rankings", {"year": season, "seasonType": "regular", "week": 1})

    for week_block in data:
        for poll in week_block.get("polls", []):
            if poll.get("poll") == cfb_config.POLL_NAME:
                ranks = sorted(poll["ranks"], key=lambda r: r["rank"])
                teams = [r["school"] for r in ranks[:25]]
                if len(teams) < 25:
                    print(f"WARNING: only found {len(teams)} ranked teams, expected 25")
                return normalize_team_list(teams)

    raise RuntimeError(
        f"Could not find an AP Top 25 preseason poll for {season}. "
        f"CFBD's preseason poll tagging shifts year to year - inspect the "
        f"raw response and adjust the lookup if needed."
    )


def fetch_week_games(season: int, week: int) -> list[dict]:
    """list of {"winner": str, "loser": str} for every completed FBS game."""
    games = cfbd_get("/games", {
        "year": season, "week": week, "seasonType": "regular",
        "division": cfb_config.DIVISION_FILTER,
    })

    results = []
    for g in games:
        home_team, away_team = g.get("homeTeam"), g.get("awayTeam")
        home_pts, away_pts = g.get("homePoints"), g.get("awayPoints")

        if home_pts is None or away_pts is None:
            continue  # not yet played

        if home_pts > away_pts:
            results.append({"winner": home_team, "loser": away_team})
        elif away_pts > home_pts:
            results.append({"winner": away_team, "loser": home_team})

    return normalize_games(results)


def save_json(data: dict, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Wrote {path}")


def main():
    parser = argparse.ArgumentParser(description="Fetch CFBD data for PowerSwap CFB")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, help="Week number to fetch game results for")
    parser.add_argument("--preseason-poll", action="store_true")
    args = parser.parse_args()

    season_dir = DATA_DIR / str(args.season)

    if args.preseason_poll:
        teams = fetch_preseason_poll(args.season)
        save_json(
            {"season": args.season, "poll": cfb_config.POLL_NAME, "type": "preseason", "teams": teams},
            season_dir / "preseason_poll.json",
        )
    elif args.week:
        games = fetch_week_games(args.season, args.week)
        save_json(
            {"season": args.season, "week": args.week, "games": games},
            season_dir / "raw" / f"week_{args.week:02d}_games.json",
        )
    else:
        parser.error("Specify either --preseason-poll or --week N")


if __name__ == "__main__":
    main()
