"""
Generates a small synthetic season so the full pipeline - preseason poll
-> weekly games -> backtest -> season_history.json - can be proven correct
end to end without needing a real API key or network access.

For --sport cbb specifically, each "week" intentionally includes MULTIPLE
games for some teams (mirroring real college basketball schedules), with
games already pre-sorted chronologically, exactly like the real
sports/cbb/fetch_results.py is supposed to hand off to the engine.

This is throwaway test data under data/<sport>/seasons/9999/ - delete that
folder once real data is flowing.
"""

import argparse
import json
import random
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
TEST_SEASON = 9999


def generate_cfb(season_dir: Path, raw_dir: Path):
    random.seed(42)
    ranked_teams = [f"RankedTeam{i}" for i in range(1, 26)]
    unranked_pool = [f"UnrankedTeam{i}" for i in range(1, 41)]

    with open(season_dir / "preseason_poll.json", "w") as f:
        json.dump({"season": TEST_SEASON, "poll": "AP Top 25", "type": "preseason", "teams": ranked_teams}, f, indent=2)
    print(f"Wrote fake CFB preseason poll")

    for week in range(1, 6):
        games = []
        teams_playing = ranked_teams.copy()
        random.shuffle(teams_playing)

        for i in range(0, 10, 2):
            t1, t2 = teams_playing[i], teams_playing[i + 1]
            if random.random() < 0.3:
                games.append({"winner": t2, "loser": t1})
            else:
                games.append({"winner": t1, "loser": t2})

        for ranked_team in teams_playing[10:14]:
            opponent = random.choice(unranked_pool)
            if random.random() < 0.15:
                games.append({"winner": opponent, "loser": ranked_team})
            else:
                games.append({"winner": ranked_team, "loser": opponent})

        with open(raw_dir / f"week_{week:02d}_games.json", "w") as f:
            json.dump({"season": TEST_SEASON, "week": week, "games": games}, f, indent=2)
        print(f"Wrote fake CFB week {week} games ({len(games)} games, ~1 per team)")


def generate_cbb(season_dir: Path, raw_dir: Path):
    random.seed(99)
    ranked_teams = [f"RankedTeam{i}" for i in range(1, 26)]
    unranked_pool = [f"UnrankedTeam{i}" for i in range(1, 81)]

    with open(season_dir / "preseason_poll.json", "w") as f:
        json.dump({"season": TEST_SEASON, "poll": "AP Top 25", "type": "preseason", "teams": ranked_teams}, f, indent=2)
    print(f"Wrote fake CBB preseason poll")

    for week in range(1, 6):
        games = []
        day_counter = 0

        # Unlike football, generate 2-3 games per ranked team this week,
        # on different days, to mirror a real CBB schedule. This is the
        # part that stresses the chronological-ordering requirement.
        for team in ranked_teams:
            num_games = random.choice([1, 2, 2, 3])  # mostly 2, sometimes 1 or 3
            for _ in range(num_games):
                day_counter += 1
                date_str = f"2024-11-{min(day_counter, 28):02d}"
                opponent = random.choice(unranked_pool + ranked_teams)
                if opponent == team:
                    continue
                # 20% chance the "team" loses this individual game
                if random.random() < 0.2:
                    games.append({"winner": opponent, "loser": team, "date": date_str})
                else:
                    games.append({"winner": team, "loser": opponent, "date": date_str})

        # CRITICAL: sort chronologically, exactly like the real
        # sports/cbb/fetch_results.py must do before saving.
        games.sort(key=lambda g: g["date"])

        with open(raw_dir / f"week_{week:02d}_games.json", "w") as f:
            json.dump({"season": TEST_SEASON, "week": week, "games": games}, f, indent=2)
        print(f"Wrote fake CBB week {week} games ({len(games)} games, multiple per team, sorted)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sport", required=True, choices=["cfb", "cbb"])
    args = parser.parse_args()

    season_dir = REPO_ROOT / "data" / args.sport / "seasons" / str(TEST_SEASON)
    raw_dir = season_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    if args.sport == "cfb":
        generate_cfb(season_dir, raw_dir)
    else:
        generate_cbb(season_dir, raw_dir)


if __name__ == "__main__":
    main()
