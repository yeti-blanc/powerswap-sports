"""
PowerSwap CBB - CBBD Data Fetcher

Pulls from the College Basketball Data API (collegebasketballdata.com),
using the SAME CFBD_API_KEY as the football side - same vendor, same key,
different base URL.

Unlike football, there's no native "week" concept for games here - this
script defines PowerSwap's own Monday-Sunday calendar weeks and queries
CBBD by date range for whatever falls inside each one. Games within a
week are sorted chronologically before being handed to the swap engine,
since a team can realistically play more than once in the same week and
the engine needs to see those games in the order they actually happened.

This script needs network access and will NOT run inside Claude's
sandboxed environment - run it locally or via GitHub Actions.

Usage:
    export CFBD_API_KEY="your_key_here"
    python sports/cbb/fetch_results.py --season 2024 --preseason-poll
    python sports/cbb/fetch_results.py --season 2024 --week 1 --season-start-date 2023-11-06
"""

import argparse
import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

try:
    import requests
except ImportError:
    print("This script requires the 'requests' library. Install with:")
    print("  pip install requests")
    sys.exit(1)

sys.path.insert(0, str(Path(__file__).parent))
from team_norm import normalize_team_list, normalize_games
import config as cbb_config

DATA_DIR = Path(__file__).parent.parent.parent / "data" / "cbb" / "seasons"


def get_api_key() -> str:
    key = os.environ.get("CFBD_API_KEY")
    if not key:
        print("ERROR: CFBD_API_KEY environment variable is not set.")
        print("(Yes, CFBD_API_KEY - the basketball API uses the same key as football.)")
        print("Get a free key at https://collegefootballdata.com/key")
        sys.exit(1)
    return key


def cbbd_get(endpoint: str, params: dict) -> list | dict:
    headers = {"Authorization": f"Bearer {get_api_key()}"}
    resp = requests.get(f"{cbb_config.API_BASE_URL}{endpoint}", headers=headers, params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()


def fetch_preseason_poll(season: int) -> list[str]:
    """
    Ordered list of the preseason AP Top 25, index 0 = #1.
    Mirrors the football version's approach - season's /rankings, week=1,
    look for the AP Top 25 poll specifically.
    """
    data = cbbd_get("/rankings", {"season": season, "seasonType": "regular", "week": 1})

    for week_block in data:
        for poll in week_block.get("polls", []):
            if poll.get("poll") == cbb_config.POLL_NAME:
                ranks = sorted(poll["ranks"], key=lambda r: r["rank"])
                teams = [r["school"] for r in ranks[:25]]
                if len(teams) < 25:
                    print(f"WARNING: only found {len(teams)} ranked teams, expected 25")
                return normalize_team_list(teams)

    raise RuntimeError(
        f"Could not find an AP Top 25 preseason poll for {season} in the CBBD "
        f"response. This is the first thing to manually inspect if basketball "
        f"data doesn't come through right - the response shape here is "
        f"unverified against this project's assumptions."
    )


def week_date_range(season_start_date: date, week_number: int) -> tuple[date, date]:
    """
    week_number 1 = the 7-day window starting on season_start_date.
    season_start_date should be the Monday on/before the season's first games.
    """
    start = season_start_date + timedelta(days=7 * (week_number - 1))
    end = start + timedelta(days=6)
    return start, end


def fetch_week_games(season: int, week_number: int, season_start_date: date) -> list[dict]:
    """
    Fetches all games in the calendar window for this week number, sorted
    chronologically. Returns list of {"winner": str, "loser": str, "date": str}.
    """
    start, end = week_date_range(season_start_date, week_number)

    games = cbbd_get("/games", {
        "season": season,
        "startDateRange": start.isoformat(),
        "endDateRange": end.isoformat(),
        "seasonType": "regular",
    })

    results = []
    for g in games:
        home_team = g.get(cbb_config.FIELD_HOME_TEAM)
        away_team = g.get(cbb_config.FIELD_AWAY_TEAM)
        home_pts = g.get(cbb_config.FIELD_HOME_POINTS)
        away_pts = g.get(cbb_config.FIELD_AWAY_POINTS)
        game_date = g.get(cbb_config.FIELD_START_DATE, "")

        if home_pts is None or away_pts is None:
            continue  # not yet played

        if home_pts > away_pts:
            results.append({"winner": home_team, "loser": away_team, "date": game_date})
        elif away_pts > home_pts:
            results.append({"winner": away_team, "loser": home_team, "date": game_date})

    # Critical: sort chronologically. Multiple games for the same team in
    # one calendar week MUST be processed in the order they actually
    # happened, or the swap engine will use a stale rank for the second game.
    results.sort(key=lambda r: r["date"])

    return normalize_games(results)


def save_json(data: dict, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Wrote {path}")


def main():
    parser = argparse.ArgumentParser(description="Fetch CBBD data for PowerSwap CBB")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, help="PowerSwap calendar-week number (1, 2, 3...)")
    parser.add_argument("--season-start-date", type=str,
                         help="YYYY-MM-DD - the Monday on/before this season's first games. "
                              "Required when fetching --week data.")
    parser.add_argument("--preseason-poll", action="store_true")
    args = parser.parse_args()

    season_dir = DATA_DIR / str(args.season)

    if args.preseason_poll:
        teams = fetch_preseason_poll(args.season)
        save_json(
            {"season": args.season, "poll": cbb_config.POLL_NAME, "type": "preseason", "teams": teams},
            season_dir / "preseason_poll.json",
        )
    elif args.week:
        if not args.season_start_date:
            parser.error("--season-start-date is required when fetching --week data")
        start_date = date.fromisoformat(args.season_start_date)
        games = fetch_week_games(args.season, args.week, start_date)
        window_start, window_end = week_date_range(start_date, args.week)
        save_json(
            {
                "season": args.season, "week": args.week,
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "games": games,
            },
            season_dir / "raw" / f"week_{args.week:02d}_games.json",
        )
    else:
        parser.error("Specify either --preseason-poll or --week N (with --season-start-date)")


if __name__ == "__main__":
    main()
