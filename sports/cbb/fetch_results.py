"""
PowerSwap CBB - CBBD Data Fetcher

Pulls from the College Basketball Data API (collegebasketballdata.com),
using the SAME CFBD_API_KEY as the football side - same vendor, same key,
different base URL.

Unlike football, there's no native "week" concept for games here - this
script defines PowerSwap's own Monday-Sunday calendar weeks (US Eastern
dates, see config.py) and queries CBBD by date range for whatever falls
inside each one. Games within a week are sorted chronologically before
being handed to the swap engine, since a team can realistically play more
than once in the same week and the engine needs to see those games in the
order they actually happened.

Usage:
    export CFBD_API_KEY="your_key_here"
    python sports/cbb/fetch_results.py --season 2026 --preseason-poll
    python sports/cbb/fetch_results.py --season 2026 --through-today
    python sports/cbb/fetch_results.py --season 2026 --week 1

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
from team_norm import norm, normalize_games, UNRESOLVED
import config as cbb_config

EASTERN = ZoneInfo("America/New_York")
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


def week1_monday(season: int) -> date:
    if season not in cbb_config.WEEK1_MONDAY:
        raise SystemExit(f"No WEEK1_MONDAY pinned for CBB {season} in sports/cbb/config.py - "
                         f"check the real opening schedule and add it.")
    return date.fromisoformat(cbb_config.WEEK1_MONDAY[season])


def week_date_range(season_start_date: date, week_number: int) -> tuple[date, date]:
    """
    Monday-Sunday window (US Eastern dates) for a PowerSwap week.
    season_start_date is week 1's Monday. Week 1 also absorbs any opener
    dated before that Monday - see fetch_week_games() and config.WEEK1_MONDAY.
    """
    start = season_start_date + timedelta(days=7 * (week_number - 1))
    end = start + timedelta(days=6)
    return start, end


def eastern_date(start_date_utc: str) -> date:
    """CBBD startDate ("2026-11-15T03:00:00.000Z") -> its US Eastern calendar date."""
    dt = datetime.fromisoformat(start_date_utc.replace("Z", "+00:00"))
    return dt.astimezone(EASTERN).date()


def today_eastern() -> date:
    return datetime.now(EASTERN).date()


def fetch_week_games(season: int, week_number: int, season_start_date: date) -> dict:
    """
    All FINAL games whose US Eastern date falls in this week's window,
    sorted chronologically. Returns the raw week file's contents.
    """
    start, end = week_date_range(season_start_date, week_number)
    first_day = start - timedelta(days=cbb_config.WEEK1_LOOKBACK_DAYS) if week_number == 1 else start

    # CBBD filters on UTC and treats endDateRange as that date's 00:00Z
    # (verified 2026-11-15: endDateRange=2026-11-09 silently dropped
    # Houston @ California, Sun 11-08 8:30pm ET = 2026-11-09T01:30Z). So
    # over-fetch by 2 days on the end, 1 on the start, and decide
    # membership by Eastern date ourselves.
    games = cbbd_get("/games", {
        "season": cbb_config.cbbd_season(season),
        "startDateRange": (first_day - timedelta(days=1)).isoformat(),
        "endDateRange": (end + timedelta(days=2)).isoformat(),
        "seasonType": "regular",
    })

    results, not_final = [], []
    for g in games:
        game_date = g.get(cbb_config.FIELD_START_DATE, "")
        if not game_date or not (first_day <= eastern_date(game_date) <= end):
            continue
        home_team = g.get(cbb_config.FIELD_HOME_TEAM)
        away_team = g.get(cbb_config.FIELD_AWAY_TEAM)
        home_pts = g.get(cbb_config.FIELD_HOME_POINTS)
        away_pts = g.get(cbb_config.FIELD_AWAY_POINTS)

        if g.get("status") != "final" or home_pts is None or away_pts is None:
            not_final.append(f"{away_team} @ {home_team} {game_date} ({g.get('status')})")
            continue

        home_id, away_id = g.get("homeTeamId"), g.get("awayTeamId")
        if home_pts > away_pts:
            results.append({"winner": home_team, "loser": away_team, "date": game_date,
                            "winner_vendor_id": home_id, "loser_vendor_id": away_id})
        elif away_pts > home_pts:
            results.append({"winner": away_team, "loser": home_team, "date": game_date,
                            "winner_vendor_id": away_id, "loser_vendor_id": home_id})

    # Critical: sort chronologically. Multiple games for the same team in
    # one calendar week MUST be processed in the order they actually
    # happened, or the swap engine will use a stale rank for the second game.
    results.sort(key=lambda r: r["date"])

    return {
        "season": season,
        "cbbd_season": cbb_config.cbbd_season(season),
        "week": week_number,
        # Week 1 starts at the real opener when one precedes its Monday.
        "window_start": min([start] + [eastern_date(r["date"]) for r in results]).isoformat(),
        "window_end": end.isoformat(),
        "date_basis": "US Eastern calendar date",
        "not_final": not_final,
        "games": normalize_games(results),
    }


def completed_weeks(season: int, today: date | None = None) -> int:
    """How many PowerSwap weeks have fully ended (their Sunday is past, ET)."""
    today = today or today_eastern()
    return max(0, (today - week1_monday(season)).days // 7)


def save_json(data: dict, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Wrote {path}")


def write_week(season: int, week: int) -> dict:
    week_data = fetch_week_games(season, week, week1_monday(season))
    save_json(week_data, DATA_DIR / str(season) / "raw" / f"week_{week:02d}_games.json")
    print(f"  week {week}: {week_data['window_start']}..{week_data['window_end']}, "
          f"{len(week_data['games'])} final games")
    if week_data["not_final"]:
        print(f"  NOTE: {len(week_data['not_final'])} game(s) in week {week} not final "
              f"(postponed/unplayed): " + "; ".join(week_data["not_final"]))
    return week_data


def main():
    parser = argparse.ArgumentParser(description="Fetch CBBD data for PowerSwap CBB")
    parser.add_argument("--season", type=int, required=True,
                        help="PowerSwap season = the year it STARTS (2026 = 2026-27)")
    parser.add_argument("--week", type=int, help="PowerSwap calendar-week number (1, 2, 3...)")
    parser.add_argument("--preseason-poll", action="store_true")
    parser.add_argument("--through-today", action="store_true",
                        help="(Re)fetch every fully-completed week; prints COMPLETED_WEEKS=N")
    args = parser.parse_args()

    if not (args.preseason_poll or args.week or args.through_today):
        parser.error("Specify --preseason-poll, --week N, and/or --through-today")

    if args.preseason_poll:
        teams = fetch_preseason_poll(args.season)
        save_json(
            {"season": args.season, "cbbd_season": cbb_config.cbbd_season(args.season),
             "poll": cbb_config.POLL_NAME, "type": "preseason", "teams": teams},
            DATA_DIR / str(args.season) / "preseason_poll.json",
        )
    if args.week:
        if args.week > completed_weeks(args.season):
            print(f"WARNING: week {args.week} hasn't finished yet (ET) - writing partial results")
        write_week(args.season, args.week)
    if args.through_today:
        n = completed_weeks(args.season)
        for w in range(1, n + 1):
            write_week(args.season, w)
        print(f"COMPLETED_WEEKS={n}")

    if UNRESOLVED:
        raise SystemExit(f"UNRESOLVED CBB TEAMS: {sorted(UNRESOLVED)} - add aliases to "
                         f"data/teams/cbb_overrides.json and rebuild the registry")


if __name__ == "__main__":
    main()
