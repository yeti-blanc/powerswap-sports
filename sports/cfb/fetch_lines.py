"""
PowerSwap CFB - CFBD Betting Lines Fetcher

Pulls from CFBD's /lines endpoint: real sportsbook spread/over-under/
moneyline data per game, per provider. Feeds havoc_rating.py - this
script only fetches and normalizes, it never scores anything itself.

CFBD has no injury-report endpoint (checked its full 84-path OpenAPI
spec directly, 2026-09-04 - nothing injury-related exists). havoc_rating.py
carries an explicit placeholder for that factor rather than pretending
its absence means zero impact.

Confirmed real 2026-09-04: the same real-world sportsbook is spelled two
different ways in the same response ("DraftKings" vs "Draft Kings") -
odds_norm.py normalizes this the same way team_norm.py normalizes team
name variants.

This script needs network access and a CFBD API key - it will NOT run
inside Claude's sandboxed environment. Run it locally with CFBD_API_KEY
set, or inside a GitHub Action with CFBD_API_KEY as a repo secret.

Usage:
    export CFBD_API_KEY="your_key_here"
    python sports/cfb/fetch_lines.py --season 2024 --week 1
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
from team_norm import norm as norm_team
from odds_norm import normalize_lines
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


def fetch_week_lines(season: int, week: int) -> list[dict]:
    """
    list of {home_team, away_team, lines: [{provider, spread, over_under,
    home_moneyline, away_moneyline}]} for every game CFBD has odds for
    that week. Team names run through team_norm.norm() same as every
    other CFBD pull in this project; provider names run through
    odds_norm.norm().
    """
    games = cfbd_get("/lines", {
        "year": season, "week": week, "seasonType": "regular",
    })

    results = []
    for g in games:
        raw_lines = g.get("lines", [])
        if not raw_lines:
            continue  # CFBD has the game but no sportsbook has posted a line yet

        lines = [
            {
                "provider": line["provider"],
                "spread": line.get("spread"),
                "over_under": line.get("overUnder"),
                "home_moneyline": line.get("homeMoneyline"),
                "away_moneyline": line.get("awayMoneyline"),
            }
            for line in raw_lines
        ]

        results.append({
            "home_team": norm_team(g.get("homeTeam", "")),
            "away_team": norm_team(g.get("awayTeam", "")),
            "lines": normalize_lines(lines),
        })

    return results


def save_json(data: dict, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Wrote {path}")


def main():
    parser = argparse.ArgumentParser(description="Fetch CFBD betting lines for PowerSwap CFB")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, required=True)
    args = parser.parse_args()

    lines = fetch_week_lines(args.season, args.week)
    save_json(
        {"season": args.season, "week": args.week, "games": lines},
        DATA_DIR / str(args.season) / "raw" / f"week_{args.week:02d}_lines.json",
    )


if __name__ == "__main__":
    main()
