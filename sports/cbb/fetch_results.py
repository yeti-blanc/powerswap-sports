"""
PowerSwap CBB - preseason AP poll fetcher (CBBD).

Only the BASELINE comes from CBBD (collegebasketballdata.com, same
CFBD_API_KEY as football). Game results and schedules come from ESPN -
see espn_days.py / build_season.py - because basketball standings move
game by game and ESPN is real-time.

Usage:
    python sports/cbb/fetch_results.py --season 2026 --preseason-poll

--season is PowerSwap's naming (the year the season STARTS: 2026 = 2026-27).
CBBD names seasons by the year they END - see config.cbbd_season().
"""

import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    import requests
except ImportError:
    print("This script requires the 'requests' library. Install with:")
    print("  pip install requests")
    sys.exit(1)

sys.path.insert(0, str(Path(__file__).parent))
from team_norm import norm, UNRESOLVED
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
    `season` is PowerSwap's start-year naming - mapped to CBBD's end-year
    naming via cbb_config.cbbd_season() (see config.py).
    """
    data = cbbd_get("/rankings", {"season": cbb_config.cbbd_season(season), "seasonType": "regular", "week": 1})

    # Real CBBD shape (verified 2026-10-19, re-verified 2026-11-15 against
    # CBBD season 2027): a FLAT list of {pollType, ranking, teamId, team,
    # pollDate, ...} rows. ranking is None for "others receiving votes".
    rows = [r for r in data if r.get("pollType") == cbb_config.POLL_NAME and r.get("ranking") is not None]
    if not rows:
        raise RuntimeError(
            f"Could not find an AP Top 25 preseason poll for {season} (CBBD season "
            f"{cbb_config.cbbd_season(season)}) in the CBBD response."
        )

    # Guard against the 2026-10-19 mistake (CBBD season 2026 is 2025-26, a
    # whole season off): the preseason poll must be dated in this PowerSwap
    # season's own start year, before November.
    poll_dates = sorted({(r.get("pollDate") or "")[:10] for r in rows})
    if not all(d.startswith(f"{season}-") and d < f"{season}-11-01" for d in poll_dates):
        raise RuntimeError(
            f"Preseason poll dates {poll_dates} don't belong to the {season}-{(season + 1) % 100:02d} season")

    ranks = sorted(rows, key=lambda r: r["ranking"])
    # CBBD's own teamId (registry key "cbbd:<id>"), name as fallback.
    teams = [norm(r["team"], r.get("teamId")) for r in ranks[:25]]
    if len(teams) < 25:
        print(f"WARNING: only found {len(teams)} ranked teams, expected 25")
    print(f"Preseason AP poll dated {poll_dates}: " + ", ".join(f"{i + 1}. {t}" for i, t in enumerate(teams)))
    return teams


def save_json(data: dict, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Wrote {path}")


def main():
    parser = argparse.ArgumentParser(description="Fetch the CBB preseason AP poll from CBBD")
    parser.add_argument("--season", type=int, required=True,
                        help="PowerSwap season = the year it STARTS (2026 = 2026-27)")
    parser.add_argument("--preseason-poll", action="store_true", required=True)
    args = parser.parse_args()

    teams = fetch_preseason_poll(args.season)
    if UNRESOLVED:
        raise SystemExit(f"UNRESOLVED CBB TEAMS: {sorted(UNRESOLVED)} - add aliases to "
                         f"data/teams/cbb_overrides.json and rebuild the registry")
    save_json(
        {"season": args.season, "cbbd_season": cbb_config.cbbd_season(args.season),
         "poll": cbb_config.POLL_NAME, "type": "preseason", "teams": teams},
        DATA_DIR / str(args.season) / "preseason_poll.json",
    )


if __name__ == "__main__":
    main()
