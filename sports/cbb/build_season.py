"""
PowerSwap CBB - build season_history.json + schedule.json from ESPN day files.

Basketball works differently from football (user's call 2026-11-15):
standings move GAME BY GAME, the moment a game goes final - not once a
week. Weeks (Monday-Sunday, US Eastern, see config.py) only group the
season for browsing.

  - Every final game since the season opener is applied to the shared
    swap engine one at a time, in tip-off order (the multi-game-week
    ordering rule, PROJECT_BIBLE §3, taken to its limit).
  - Snapshots: "preseason" (the AP baseline), then "week1".."weekN" =
    standings at the END of that week. The current week's snapshot is the
    standings right now, so a swap shows up as soon as this script runs
    after the game. (Football's week-N tab shows the ranking that governed
    week N; basketball's shows where week N left things - there is no
    "governing" ranking when standings move mid-week.)
  - Every event carries the week it happened in, its tip-off time (`at`),
    the score and the ESPN game id, so the site lists a week's swaps in
    the order they happened - a team that moves twice in one week shows
    both moves.
  - schedule.json: every game (past and upcoming, through the look-ahead
    horizon) for every team that has held a rank slot this season, from
    that team's point of view - drives the cards' results / next game and
    the live Worker's list of games to watch.

Usage: python sports/cbb/build_season.py --season 2026 [--today YYYY-MM-DD]
"""

import argparse
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "core"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from swap_engine import PowerSwapRankings  # noqa: E402
from teams import annotate_season_history, load_registry  # noqa: E402
import config as cbb_config  # noqa: E402

EASTERN = ZoneInfo("America/New_York")


def et_date(iso_utc: str) -> date:
    return datetime.fromisoformat(iso_utc.replace("Z", "+00:00")).astimezone(EASTERN).date()


def week_of(d: date, week1_monday: date) -> int:
    """Week number for an ET date; anything before week 1's Monday is week 1."""
    return max(1, (d - week1_monday).days // 7 + 1)


def load_days(season: int) -> list[dict]:
    days_dir = ROOT / "data" / "cbb" / "seasons" / str(season) / "raw" / "days"
    games = []
    for p in sorted(days_dir.glob("*.json")):
        games.extend(json.loads(p.read_text(encoding="utf-8"))["games"])
    # Same game can't appear on two ET days, but dedupe by id defensively.
    return sorted({g["id"]: g for g in games}.values(), key=lambda g: (g["start"], g["id"]))


def build(season: int, today: date) -> tuple[dict, dict]:
    season_dir = ROOT / "data" / "cbb" / "seasons" / str(season)
    preseason = json.loads((season_dir / "preseason_poll.json").read_text(encoding="utf-8"))
    week1_monday = date.fromisoformat(cbb_config.WEEK1_MONDAY[season])
    first_day = date.fromisoformat(cbb_config.SEASON_FIRST_DAY[season])
    current_week = week_of(today, week1_monday)

    def week_range(n: int) -> dict:
        start = week1_monday + timedelta(days=7 * (n - 1))
        return {"start": (first_day if n == 1 else start).isoformat(),
                "end": (start + timedelta(days=6)).isoformat()}

    games = load_days(season)
    finals = [g for g in games if g["status"] == "final"]

    rankings = PowerSwapRankings.from_preseason_poll(preseason["teams"], "preseason")
    snapshots = [rankings.to_dict("preseason")]
    events = []
    week_cursor = 1
    for g in finals:
        wk = week_of(et_date(g["start"]), week1_monday)
        if wk > current_week:
            continue  # can't happen for a real final; guards a bad --today
        while week_cursor < wk:  # close out finished weeks (incl. game-less ones)
            snapshots.append(rankings.to_dict(f"week{week_cursor}"))
            week_cursor += 1
        home, away = g["home"], g["away"]
        winner, loser = (home, away) if home["score"] > away["score"] else (away, home)
        for e in rankings.apply_week([{"winner": winner["name"], "loser": loser["name"]}], f"week{wk}"):
            ev = e.to_dict()
            ev.update({
                "at": g["start"],
                "game_id": g["id"],
                "winner_score": winner["score"],
                "loser_score": loser["score"],
                "winner_home_away": "neutral" if g["neutral"] else ("home" if winner is home else "away"),
            })
            events.append(ev)
    while week_cursor <= current_week:
        snapshots.append(rankings.to_dict(f"week{week_cursor}"))
        week_cursor += 1

    ever_involved = {e["winner"] for e in events} | {e["loser"] for e in events}
    history = {
        "sport": "cbb",
        "season": season,
        "standings_model": "per_game",
        "generated_at": datetime.now(EASTERN).isoformat(timespec="seconds"),
        "current_week": f"week{current_week}",
        "weeks": {f"week{n}": week_range(n) for n in range(1, current_week + 1)},
        "snapshots": snapshots,
        "events": events,
        "team_histories": {t: rankings.team_history(t) for t in sorted(ever_involved)},
    }
    unknown = annotate_season_history(history, load_registry("cbb"))
    if unknown:
        raise SystemExit(
            f"REFUSING TO WRITE season_history.json - not canonical CBB registry names: {unknown}. "
            f"Add aliases to data/teams/cbb_overrides.json, rebuild the registry, refetch, re-run.")

    # Every team that has held a slot at any point this season.
    tracked = {slot["team_id"] for snap in snapshots for slot in snap["rankings"]}
    tracked |= {e["winner_id"] for e in events} | {e["loser_id"] for e in events}
    tracked.discard(None)
    teams = {}
    for g in games:
        for me, opp in (("home", "away"), ("away", "home")):
            tid = g[me]["id"]
            if tid not in tracked:
                continue
            entry = {
                "id": g["id"], "start": g["start"], "time_valid": g["time_valid"],
                "status": g["status"],
                "home_away": "neutral" if g["neutral"] else me,
                "opponent": g[opp]["name"], "opponent_id": g[opp]["id"],
            }
            if g["status"] == "final":
                entry["score"] = g[me]["score"]
                entry["opponent_score"] = g[opp]["score"]
            if g.get("note"):
                entry["note"] = g["note"]
            teams.setdefault(tid, {"name": g[me]["name"], "games": []})["games"].append(entry)
    schedule = {
        "season": season,
        "generated_at": history["generated_at"],
        "today": today.isoformat(),
        "current_week": history["current_week"],
        "weeks": history["weeks"],
        # Who holds a slot right now - the live Worker watches these
        # teams' games (live_cbb/worker.js).
        "ranked_ids": [slot["team_id"] for slot in snapshots[-1]["rankings"]],
        "teams": dict(sorted(teams.items())),
    }
    return history, schedule


def write_if_changed(path: Path, data: dict, ignore=("generated_at",)) -> bool:
    """Skip the write when only generated_at would change - keeps the
    15-minute job from committing a no-op every run."""
    def strip(d):
        return {k: v for k, v in d.items() if k not in ignore}
    if path.exists():
        old = json.loads(path.read_text(encoding="utf-8"))
        if strip(old) == strip(data):
            return False
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return True


def main():
    parser = argparse.ArgumentParser(description="Build PowerSwap CBB standings from ESPN day files")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--today", help="override today's ET date (testing)")
    args = parser.parse_args()
    today = date.fromisoformat(args.today) if args.today else datetime.now(EASTERN).date()

    history, schedule = build(args.season, today)
    season_dir = ROOT / "data" / "cbb" / "seasons" / str(args.season)
    for name, data in (("season_history.json", history), ("schedule.json", schedule)):
        print(f"{name}: {'updated' if write_if_changed(season_dir / name, data) else 'unchanged'}")

    for e in history["events"]:
        if e["kind"] == "swap":
            print(f"  {e['week']} {e['at']}: SWAP {e['winner']} (#{e['winner_old_rank']}) beat "
                  f"{e['loser']} (#{e['loser_old_rank']}) {e['winner_score']}-{e['loser_score']}")
        else:
            print(f"  {e['week']} {e['at']}: DETHRONE unranked {e['winner']} beat #{e['loser_old_rank']} "
                  f"{e['loser']} {e['winner_score']}-{e['loser_score']}")
    print("Current standings: " + ", ".join(f"{s['rank']}. {s['team']}" for s in history["snapshots"][-1]["rankings"]))


if __name__ == "__main__":
    main()
