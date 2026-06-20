"""
PowerSwap Sports - Season Backtest Runner

Sport-agnostic. Takes one season's worth of already-fetched data
(preseason poll + weekly game results, already normalized at fetch time)
and runs it through the shared swap engine week by week.

Works identically for football and basketball - the engine doesn't know
or care which sport it's processing, since by the time data reaches this
script it's just "team beats team" events with a week label.

Usage:
    python scripts/backtest.py --sport cfb --season 2024 --weeks 15
    python scripts/backtest.py --sport cbb --season 2024 --weeks 18
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "core"))
from swap_engine import PowerSwapRankings

REPO_ROOT = Path(__file__).parent.parent


def load_json(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(
            f"Missing {path}. Run the sport's fetch_results.py for this season/week first."
        )
    with open(path) as f:
        return json.load(f)


def run_season_backtest(sport: str, season: int, max_week: int):
    season_dir = REPO_ROOT / "data" / sport / "seasons" / str(season)
    raw_dir = season_dir / "raw"

    preseason = load_json(season_dir / "preseason_poll.json")
    rankings = PowerSwapRankings.from_preseason_poll(preseason["teams"], "preseason")

    all_snapshots = [rankings.to_dict("preseason")]
    all_events = []
    consecutive_absences = {}

    for week in range(1, max_week + 1):
        week_label = f"week{week}"
        games_path = raw_dir / f"week_{week:02d}_games.json"

        if not games_path.exists():
            print(f"  [{week_label}] no data found, skipping (run fetch_results.py --week {week})")
            continue

        week_data = load_json(games_path)
        teams_in_action = {t for g in week_data["games"] for t in (g["winner"], g["loser"])}

        # Sanity check (see README "Lessons Carried Over" section): a ranked
        # team missing from the game log for 2+ straight weeks is much more
        # likely a name mismatch than a real bye - flag it loudly.
        currently_ranked = {slot.team for slot in rankings.slots.values()}
        for team in currently_ranked:
            if team not in teams_in_action:
                consecutive_absences[team] = consecutive_absences.get(team, 0) + 1
            else:
                consecutive_absences[team] = 0

        for team, streak in consecutive_absences.items():
            if streak == 2:
                print(f"      ⚠ NAME MISMATCH? '{team}' has had no recorded game for 2 straight "
                      f"weeks. Check if the API is spelling this team differently and add it to "
                      f"this sport's team_norm.py.")

        events = rankings.apply_week(week_data["games"], week_label)

        snapshot = rankings.to_dict(week_label)
        all_snapshots.append(snapshot)
        all_events.extend([e.to_dict() for e in events])

        print(f"  [{week_label}] {len(events)} rank-changing event(s)")
        for e in events:
            if e.kind == "swap":
                print(f"      SWAP: {e.winner} (#{e.winner_old_rank}) beat {e.loser} (#{e.loser_old_rank}) "
                      f"-> {e.winner} is now #{e.winner_new_rank}, {e.loser} drops to #{e.loser_new_rank}")
            else:
                print(f"      DETHRONE: unranked {e.winner} beat #{e.loser_old_rank} {e.loser} "
                      f"-> {e.winner} is now #{e.winner_new_rank}, {e.loser} is OUT")

    output_path = season_dir / "season_history.json"
    with open(output_path, "w") as f:
        json.dump({
            "sport": sport,
            "season": season,
            "snapshots": all_snapshots,
            "events": all_events,
        }, f, indent=2)

    print(f"\nFinal {sport.upper()} rankings after week {max_week}:")
    print(rankings.pretty_print())
    print(f"\nWrote full season history to {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Run a PowerSwap season backtest")
    parser.add_argument("--sport", required=True, choices=["cfb", "cbb"])
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--weeks", type=int, required=True, help="Number of weeks to process")
    args = parser.parse_args()

    print(f"Running PowerSwap {args.sport.upper()} backtest for {args.season} season ({args.weeks} weeks)...\n")
    run_season_backtest(args.sport, args.season, args.weeks)


if __name__ == "__main__":
    main()
