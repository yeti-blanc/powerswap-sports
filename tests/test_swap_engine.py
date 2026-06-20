"""
Sanity tests for the PowerSwap swap engine, using the exact scenarios
talked through before any code was written. If these don't pass, the
engine is wrong and nothing built on top of it can be trusted.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "core"))

from swap_engine import PowerSwapRankings


def make_test_poll():
    # 25 placeholder teams, #1 through #25, with the specific teams
    # we need for these test scenarios slotted into their example ranks.
    teams = [f"Team{n}" for n in range(1, 26)]
    teams[0] = "Indiana"        # rank 1
    teams[3] = "Alabama"        # rank 4
    teams[6] = "LSU"            # rank 7
    teams[14] = "Oklahoma"      # rank 15
    return teams


def test_basic_swap_lower_ranked_winner():
    print("TEST 1: #15 Oklahoma beats #4 Alabama -> straight swap")
    teams = make_test_poll()
    rankings = PowerSwapRankings.from_preseason_poll(teams, "preseason")

    events = rankings.apply_week(
        games=[{"winner": "Oklahoma", "loser": "Alabama"}],
        week_label="week1",
    )

    assert rankings.team_rank("Oklahoma") == 4, f"Expected OK at #4, got {rankings.team_rank('Oklahoma')}"
    assert rankings.team_rank("Alabama") == 15, f"Expected Bama at #15, got {rankings.team_rank('Alabama')}"
    assert len(events) == 1 and events[0].kind == "swap"
    print("  PASS - Oklahoma is #4, Alabama is #15\n")


def test_chalk_no_movement():
    print("TEST 2: #4 Alabama beats #15 Oklahoma (better team wins) -> no movement")
    teams = make_test_poll()
    rankings = PowerSwapRankings.from_preseason_poll(teams, "preseason")

    events = rankings.apply_week(
        games=[{"winner": "Alabama", "loser": "Oklahoma"}],
        week_label="week1",
    )

    assert rankings.team_rank("Alabama") == 4
    assert rankings.team_rank("Oklahoma") == 15
    assert len(events) == 0
    print("  PASS - no swap occurred, chalk result\n")


def test_dethrone_by_unranked():
    print("TEST 3: unranked Western Carolina beats #4 Alabama -> dethrone")
    teams = make_test_poll()
    rankings = PowerSwapRankings.from_preseason_poll(teams, "preseason")

    events = rankings.apply_week(
        games=[{"winner": "Western Carolina", "loser": "Alabama"}],
        week_label="week1",
    )

    assert rankings.team_rank("Western Carolina") == 4
    assert rankings.team_rank("Alabama") is None
    assert len(events) == 1 and events[0].kind == "dethrone"
    print("  PASS - WCU is #4, Alabama is fully unranked\n")
    return rankings


def test_full_lineage_chain():
    print("TEST 4: full chain - Bama loses to WCU, WCU loses to LSU, Bama beats LSU and reclaims #4")
    teams = make_test_poll()
    rankings = PowerSwapRankings.from_preseason_poll(teams, "preseason")

    # Week 1: unranked WCU beats #4 Alabama
    rankings.apply_week(
        games=[{"winner": "Western Carolina", "loser": "Alabama"}],
        week_label="week1",
    )
    assert rankings.team_rank("Western Carolina") == 4
    assert rankings.team_rank("Alabama") is None

    # Week 3: #4 WCU loses to #7 LSU -> LSU was worse-ranked, so LSU takes #4, WCU drops to #7
    rankings.apply_week(
        games=[{"winner": "LSU", "loser": "Western Carolina"}],
        week_label="week3",
    )
    assert rankings.team_rank("LSU") == 4, f"Expected LSU at #4, got {rankings.team_rank('LSU')}"
    assert rankings.team_rank("Western Carolina") == 7

    # Week 6: unranked-since-week1 Alabama plays #4 LSU and wins -> Bama reclaims #4
    rankings.apply_week(
        games=[{"winner": "Alabama", "loser": "LSU"}],
        week_label="week6",
    )
    assert rankings.team_rank("Alabama") == 4, f"Expected Bama back at #4, got {rankings.team_rank('Alabama')}"
    assert rankings.team_rank("LSU") is None, f"Expected LSU unranked, got {rankings.team_rank('LSU')}"

    # Check the lineage on rank slot #4 tells the whole story
    slot4 = rankings.slots[4]
    lineage_teams = [e.team for e in slot4.lineage]
    expected_chain = ["Alabama", "Western Carolina", "LSU", "Alabama"]
    assert lineage_teams == expected_chain, f"Lineage mismatch: {lineage_teams}"

    print(f"  PASS - rank #4 lineage: {' -> '.join(lineage_teams)}\n")


def test_bye_week_frozen():
    print("TEST 5: team with no game this week stays exactly where it is")
    teams = make_test_poll()
    rankings = PowerSwapRankings.from_preseason_poll(teams, "preseason")
    before = rankings.team_rank("Indiana")

    rankings.apply_week(games=[], week_label="week2")  # nobody plays

    after = rankings.team_rank("Indiana")
    assert before == after == 1
    print("  PASS - Indiana frozen at #1 with no games played\n")


def test_unranked_vs_unranked_ignored():
    print("TEST 6: two unranked teams playing each other has zero effect on rankings")
    teams = make_test_poll()
    rankings = PowerSwapRankings.from_preseason_poll(teams, "preseason")
    before_snapshot = rankings.to_dict("week1")

    events = rankings.apply_week(
        games=[{"winner": "RandomUnranked1", "loser": "RandomUnranked2"}],
        week_label="week1",
    )

    after_snapshot = rankings.to_dict("week1")
    assert events == []
    assert before_snapshot["rankings"] == after_snapshot["rankings"]
    print("  PASS - no change, no events\n")


def test_serialization_roundtrip():
    print("TEST 7: to_dict/from_dict roundtrip preserves full state including lineage")
    teams = make_test_poll()
    rankings = PowerSwapRankings.from_preseason_poll(teams, "preseason")
    rankings.apply_week(
        games=[{"winner": "Western Carolina", "loser": "Alabama"}],
        week_label="week1",
    )

    d = rankings.to_dict("week1")
    restored = PowerSwapRankings.from_dict(d)

    assert restored.team_rank("Western Carolina") == 4
    assert restored.team_rank("Alabama") is None
    assert restored.slots[4].lineage[0].team == "Alabama"
    assert restored.slots[4].lineage[1].team == "Western Carolina"
    print("  PASS - roundtrip preserved rankings and lineage\n")


if __name__ == "__main__":
    test_basic_swap_lower_ranked_winner()
    test_chalk_no_movement()
    test_dethrone_by_unranked()
    test_full_lineage_chain()
    test_bye_week_frozen()
    test_unranked_vs_unranked_ignored()
    test_serialization_roundtrip()
    print("=" * 50)
    print("ALL TESTS PASSED")
