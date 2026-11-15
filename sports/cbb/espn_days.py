"""
PowerSwap CBB - ESPN day files (the basketball results + schedule source).

Basketball standings move game by game (every swap is reflected as soon as
the game goes final - user's call 2026-11-15), so results come from ESPN's
scoreboard, which is real-time, instead of CBBD (final-results API with an
unknown posting lag). ESPN's team IDs ARE the CBB registry's IDs (§13).
Verified 2026-11-15: ESPN and CBBD agreed on every D-I game of week 1.

One file per US Eastern calendar day - ESPN's own `dates=` bucketing
(PROJECT_BIBLE §8, 2026-09-25) - at data/cbb/seasons/<year>/raw/days/:

    {"date": "2026-11-14", "games": [
        {"id": "401...", "start": "2026-11-14T20:30Z", "time_valid": true,
         "status": "final", "neutral": false, "note": "Empire Classic",
         "home": {"id": "2250", "name": "Gonzaga", "score": 80},
         "away": {"id": "99", "name": "LSU", "score": 81}}, ...]}

status: scheduled | in_progress | final | postponed | canceled. Scores are
written ONLY for finals - live scores belong to the live Worker, and
keeping them out means a file changes only when a game starts, ends, or
gets rescheduled (not every poll). A team the registry can't place keeps
ESPN's school name with id null (it can never match a ranked team; if one
ever beats a ranked team, build_season.py refuses to write - loud, not a
guess). Files are only rewritten when their content actually changes.

Usage:
    python sports/cbb/espn_days.py --season 2026            # routine refresh
    python sports/cbb/espn_days.py --season 2026 --full     # + whole horizon
"""

import argparse
import json
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "core"))
import config as cbb_config  # noqa: E402
from teams import load_registry  # noqa: E402

EASTERN = ZoneInfo("America/New_York")
DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "cbb" / "seasons"
SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard"
# ESPN's WAF rejects browser/Node/PowerShell User-Agents (PROJECT_BIBLE §6).
HEADERS = {"User-Agent": "curl/8.14.1"}

NEAR_DAYS = 3        # tomorrow..+3 refetched every run (tip times get set/moved)
HORIZON_DAYS = 28    # how far ahead "next game" can look
TERMINAL = {"final", "postponed", "canceled"}


def today_eastern() -> date:
    return datetime.now(EASTERN).date()


def day_path(season: int, d: date) -> Path:
    return DATA_DIR / str(season) / "raw" / "days" / f"{d.isoformat()}.json"


def _status(comp: dict) -> str:
    st = comp["status"]["type"]
    name = st.get("name", "")
    if st.get("completed") and st.get("state") == "post":
        return "final"
    if "POSTPONED" in name or "SUSPENDED" in name:
        return "postponed"
    if "CANCELED" in name or "CANCELLED" in name or "FORFEIT" in name:
        return "canceled"
    if st.get("state") == "in":
        return "in_progress"
    return "scheduled"


def parse_event(ev: dict, registry) -> dict:
    comp = ev["competitions"][0]
    status = _status(comp)
    sides = {}
    for c in comp["competitors"]:
        t = c["team"]
        tid = (registry.resolve_id("espn", t.get("id"))
               or registry.resolve(t.get("displayName"))
               or registry.resolve(t.get("location")))
        side = {"id": tid, "name": registry.name(tid) if tid else t.get("location") or t.get("displayName")}
        if status == "final":
            side["score"] = int(c["score"])
        sides[c["homeAway"]] = side
    notes = [n.get("headline") for n in comp.get("notes", []) if n.get("headline")]
    game = {
        "id": str(ev["id"]),
        "start": ev["date"],
        "time_valid": bool(comp.get("timeValid", True)),
        "status": status,
        "neutral": bool(comp.get("neutralSite")),
        "home": sides["home"],
        "away": sides["away"],
    }
    if notes:
        game["note"] = notes[0]
    return game


def fetch_day(d: date, registry) -> list[dict]:
    params = {"dates": d.strftime("%Y%m%d"), "groups": 50, "limit": 500}
    for attempt in range(3):
        try:
            resp = requests.get(SCOREBOARD, params=params, headers=HEADERS, timeout=30)
            resp.raise_for_status()
            events = resp.json()["events"]
            break
        except (requests.RequestException, ValueError, KeyError) as err:
            if attempt == 2:
                raise
            print(f"  retrying {d} after: {err}")
            time.sleep(3)
    games = [parse_event(ev, registry) for ev in events]
    if len(events) >= 500:
        raise RuntimeError(f"{d}: ESPN returned {len(events)} events - the limit=500 cap may be truncating")
    return sorted(games, key=lambda g: (g["start"], g["id"]))


def write_if_changed(path: Path, data: dict) -> bool:
    text = json.dumps(data, indent=1, ensure_ascii=False) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return True


def load_day(season: int, d: date) -> dict | None:
    p = day_path(season, d)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def days_to_fetch(season: int, today: date, full: bool) -> list[date]:
    """Which days this run refreshes. Every run: yesterday, today, and the
    next NEAR_DAYS. Past days: only if missing or still holding a
    non-terminal game (late final / backfill). Further-out horizon days:
    only if missing or on a --full run (the workflow does that a few
    times a day - schedules that far out rarely move)."""
    first = date.fromisoformat(cbb_config.SEASON_FIRST_DAY[season])
    out = []
    d = first
    while d <= today + timedelta(days=HORIZON_DAYS):
        existing = load_day(season, d)
        if today - timedelta(days=1) <= d <= today + timedelta(days=NEAR_DAYS):
            out.append(d)
        elif d < today:
            if existing is None or any(g["status"] not in TERMINAL for g in existing["games"]):
                out.append(d)
        elif existing is None or full:
            out.append(d)
        d += timedelta(days=1)
    return out


def main():
    parser = argparse.ArgumentParser(description="Refresh PowerSwap CBB ESPN day files")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--full", action="store_true", help="also refresh the whole look-ahead horizon")
    parser.add_argument("--today", help="override today's ET date (testing)")
    args = parser.parse_args()

    registry = load_registry("cbb")
    today = date.fromisoformat(args.today) if args.today else today_eastern()
    changed = 0
    for d in days_to_fetch(args.season, today, args.full):
        games = fetch_day(d, registry)
        if write_if_changed(day_path(args.season, d), {"date": d.isoformat(), "games": games}):
            changed += 1
            print(f"  updated {d}: {len(games)} games")
    print(f"Day files changed: {changed}")


if __name__ == "__main__":
    main()
