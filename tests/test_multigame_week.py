"""
PowerSwap CBB stress test: a team playing more than once within a single
"week" call. Football basically never needs this (one game per team per
week), but basketball routinely does. The engine itself doesn't have a
basketball-specific code path - this test exists to prove the existing
sequential-processing behavior actually produces the right answer when
fed multiple games for the same team in one call, not just to assume it.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "core"))

from swap_engine import PowerSwapRankings


def test_same_team_plays_twice_in_one_week():
    print("TEST: a team plays twice in one week-call, rank used in game 2 "
          "must reflect the result of game 1, not the start-of-week rank")

    teams = [f"Team{n}" for n in range(1, 26)]
    teams[0] = "Duke"        # rank 1
    teams[9] = "Gonzaga"     # rank 10
    teams[19] = "Davidson"   # rank 20

    rankings = PowerSwapRankings.from_preseason_poll(teams, "preseason")

    # Tuesday: unranked "Cinderella" beats #1 Duke -> Cinderella takes #1
    # Saturday, same week: #10 Gonzaga beats Cinderella (now #1) -> swap,
    # since Gonzaga (worse-ranked, #10) beat the better-ranked team (#1)
    games_this_week = [
        {"winner": "Cinderella", "loser": "Duke", "date": "2024-11-05"},
        {"winner": "Gonzaga", "loser": "Cinderella", "date": "2024-11-09"},
    ]

    events = rankings.apply_week(games_this_week, "week1")

    assert rankings.team_rank("Gonzaga") == 1, f"Expected Gonzaga at #1, got {rankings.team_rank('Gonzaga')}"
    assert rankings.team_rank("Cinderella") == 10, f"Expected Cinderella at #10, got {rankings.team_rank('Cinderella')}"
    assert rankings.team_rank("Duke") is None, f"Expected Duke unranked, got {rankings.team_rank('Duke')}"

    assert len(events) == 2
    assert events[0].kind == "dethrone"
    assert events[1].kind == "swap"
    assert events[1].loser_old_rank == 1, (
        f"Second event used a stale rank for Cinderella: expected 1, got {events[1].loser_old_rank}. "
        f"This means games aren't being processed in chronological order within the week."
    )

    print(f"  PASS - rank #1 lineage after both games: Duke -> Cinderella -> Gonzaga\n")
    print(f"  PASS - second game correctly used Cinderella's POST-game-1 rank (#1), "
          f"not its start-of-week rank (#10)\n")


def test_chronological_order_matters():
    print("TEST: feeding the SAME two games in the WRONG order produces a "
          "different (wrong) result - proving order is load-bearing, not cosmetic")

    teams = [f"Team{n}" for n in range(1, 26)]
    teams[0] = "Duke"
    teams[9] = "Gonzaga"

    rankings = PowerSwapRankings.from_preseason_poll(teams, "preseason")

    games_wrong_order = [
        {"winner": "Gonzaga", "loser": "Cinderella", "date": "2024-11-09"},  # processed first - wrong
        {"winner": "Cinderella", "loser": "Duke", "date": "2024-11-05"},     # processed second - wrong
    ]

    events = rankings.apply_week(games_wrong_order, "week1")

    assert rankings.team_rank("Cinderella") == 1
    assert rankings.team_rank("Gonzaga") == 10  # untouched - wrong!
    assert rankings.team_rank("Duke") is None

    print("  PASS - confirmed: wrong order silently produces a wrong season. "
          "fetch_results.py MUST sort by date before calling apply_week().\n")


def test_cfb_postseason_multi_round():
    print("TEST: CFB postseason - a team advancing through multiple playoff "
          "rounds must have each round see the result of the round before it")

    teams = [f"Team{n}" for n in range(1, 26)]
    teams[0] = "Texas"        # rank 1
    teams[14] = "Notre Dame"  # rank 15

    rankings = PowerSwapRankings.from_preseason_poll(teams, "preseason")

    # This is the exact shape fetch_postseason_games() saves to disk after
    # its own chronological sort - backtest.py trusts this order as-is.
    postseason_games = [
        {"winner": "Cinderella", "loser": "Texas", "date": "2024-12-20"},        # round 1: dethrone
        {"winner": "Notre Dame", "loser": "Cinderella", "date": "2025-01-10"},    # round 2: swap (ND was #15, worse than Cinderella's #1)
    ]

    events = rankings.apply_week(postseason_games, "postseason")

    assert rankings.team_rank("Notre Dame") == 1, f"Expected Notre Dame at #1, got {rankings.team_rank('Notre Dame')}"
    assert rankings.team_rank("Cinderella") == 15, f"Expected Cinderella dropped to #15, got {rankings.team_rank('Cinderella')}"
    assert rankings.team_rank("Texas") is None, "Texas should be fully unranked after round 1"
    assert len(events) == 2
    assert events[0].kind == "dethrone"
    assert events[1].kind == "swap"
    assert events[1].loser_old_rank == 1, (
        f"Round 2 used a stale rank: expected 1, got {events[1].loser_old_rank}. "
        f"fetch_postseason_games() MUST sort by date before saving."
    )

    print("  PASS - postseason rounds resolved in correct chronological order: "
          "Texas -> Cinderella -> Notre Dame at #1, Cinderella correctly dropped to #15\n")


if __name__ == "__main__":
    test_same_team_plays_twice_in_one_week()
    test_chronological_order_matters()
    test_cfb_postseason_multi_round()
    print("=" * 50)
    print("ALL MULTI-GAME-WEEK TESTS PASSED")