"""
PowerSwap Sports - stamp registry team IDs onto already-stored season data

New data gets IDs at ingestion (sports/<sport>/fetch_*.py) and in
backtest.py. This back-fills the same fields onto files written before
the registry existed (2026-10-19), so every season reads the same way:

  season_history.json    team_id on slots/lineage, winner_id/loser_id on
                         events, top-level team_ids (core/teams.py's
                         annotate_season_history)
  raw/week_NN_games.json, raw/postseason_games.json
                         winner_id / loser_id
  week1_matchups.json, raw/week_NN_matchups.json
                         team_id / opponent_id

Additive and idempotent - no existing field is changed, re-running is a
no-op. A season_history name that isn't canonical aborts the whole run
(nothing written). Raw-games names that can't be placed get a null ID and
are listed - historically these are only small-college opponents CFBD's
game feed spelled loosely, which never touch the rankings.

Usage: python scripts/migrate_team_ids.py [--sport cfb] [--dry-run]
"""

import argparse
import glob
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "core"))
from teams import annotate_season_history, load_registry  # noqa: E402


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sport", default="cfb", choices=["cfb", "cbb"])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    reg = load_registry(args.sport)
    base = REPO_ROOT / "data" / args.sport / "seasons"
    pending, unresolved, fatal = {}, set(), []

    for p in sorted(glob.glob(str(base / "*" / "season_history.json"))):
        data = load(p)
        bad = annotate_season_history(data, reg)
        fatal += [f"{os.path.relpath(p, REPO_ROOT)}: {n!r}" for n in bad]
        pending[p] = data

    for p in sorted(glob.glob(str(base / "*" / "raw" / "*_games.json"))):
        data = load(p)
        for g in data.get("games", []):
            for side in ("winner", "loser"):
                tid = reg.resolve(g[side])
                g[f"{side}_id"] = tid
                if tid is None:
                    unresolved.add(g[side])
        pending[p] = data

    for p in sorted(glob.glob(str(base / "*" / "week1_matchups.json"))
                    + glob.glob(str(base / "*" / "raw" / "*_matchups.json"))):
        data = load(p)
        for team, m in data.get("matchups", {}).items():
            m["team_id"] = reg.id_for_name(team)
            m["opponent_id"] = reg.resolve(m["opponent"])
            if m["team_id"] is None:
                fatal.append(f"{os.path.relpath(p, REPO_ROOT)}: matchup key {team!r}")
            if m["opponent_id"] is None:
                unresolved.add(m["opponent"])
        pending[p] = data

    if fatal:
        sys.exit("ABORTED, nothing written - non-canonical names in ranking data:\n  " + "\n  ".join(fatal))

    changed = 0
    for p, data in pending.items():
        text = json.dumps(data, indent=2)  # same format the fetchers/backtest write
        with open(p, encoding="utf-8") as f:
            old = f.read()
        if old.replace("\r\n", "\n").rstrip("\n") != text.rstrip("\n"):
            changed += 1
            if not args.dry_run:
                with open(p, "w", encoding="utf-8", newline="\n") as f:
                    f.write(text)
    print(f"{len(pending)} files scanned, {changed} {'would change' if args.dry_run else 'updated'}")
    print(f"{len(unresolved)} raw-file names left with a null ID (never in the rankings):")
    for n in sorted(unresolved):
        print(f"  {n}")


if __name__ == "__main__":
    main()
