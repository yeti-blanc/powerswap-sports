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

    # Tuesday: unranked Davidson... wait, Davidson IS ranked (#20) in this
    # setup. Use an unranked team for the first upset instead.
    # Tuesday: unranked "Cinderella" beats #1 Duke -> Cinderella takes #1
    # Saturday, same week: #10 Gonzaga beats Cinderella (now #1) -> swap,
    # since Gonzaga (worse-ranked, #10) beat the better-ranked team (#1)
    games_this_week = [
        {"winner": "Cinderella", "loser": "Duke", "date": "2024-11-05"},
        {"winner": "Gonzaga", "loser": "Cinderella", "date": "2024-11-09"},
    ]

    events = rankings.apply_week(games_this_week, "week1")

    # After game 1: Cinderella is #1, Duke is unranked
    # After game 2: Gonzaga (was #10, worse than #1) beat Cinderella (#1)
    #               -> swap: Gonzaga takes #1, Cinderella drops to #10
    assert rankings.team_rank("Gonzaga") == 1, f"Expected Gonzaga at #1, got {rankings.team_rank('Gonzaga')}"
    assert rankings.team_rank("Cinderella") == 10, f"Expected Cinderella at #10, got {rankings.team_rank('Cinderella')}"
    assert rankings.team_rank("Duke") is None, f"Expected Duke unranked, got {rankings.team_rank('Duke')}"

    assert len(events) == 2
    assert events[0].kind == "dethrone"
    assert events[1].kind == "swap"
    # critically: the second event's loser_old_rank must be 1 (Cinderella's
    # rank AFTER game 1), not 10 (where Cinderella started the week) -
    # this is the actual thing being tested
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

    # Same two games, reversed order - simulating a fetch bug where the
    # API didn't return games in date order and nobody sorted them
    games_wrong_order = [
        {"winner": "Gonzaga", "loser": "Cinderella", "date": "2024-11-09"},  # processed first - wrong
        {"winner": "Cinderella", "loser": "Duke", "date": "2024-11-05"},     # processed second - wrong
    ]

    events = rankings.apply_week(games_wrong_order, "week1")

    # In wrong order: game 1 (Gonzaga beats Cinderella) - but Cinderella
    # isn't ranked yet at this point, so this game is ignored entirely.
    # Then game 2 (Cinderella beats Duke) proceeds as a normal dethrone.
    # End state: Cinderella is #1, Duke unranked, Gonzaga untouched at #10.
    # This is DIFFERENT from the correct chronological result above, which
    # is exactly the point - it demonstrates why fetch_results.py sorting
    # by date before calling apply_week() is not optional.
    assert rankings.team_rank("Cinderella") == 1
    assert rankings.team_rank("Gonzaga") == 10  # untouched - wrong!
    assert rankings.team_rank("Duke") is None

    print("  PASS - confirmed: wrong order silently produces a wrong season. "
          "fetch_results.py MUST sort by date before calling apply_week().\n")


if __name__ == "__main__":
    test_same_team_plays_twice_in_one_week()
    test_chronological_order_matters()
    print("=" * 50)
    print("ALL MULTI-GAME-WEEK TESTS PASSED")
