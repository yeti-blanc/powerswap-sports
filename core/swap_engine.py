"""
PowerSwap CFB - Core Swap Engine

Rules (locked in, no exceptions):
1. Baseline: Week 1 PowerSwap rankings come from applying Week 1 real-world
   game results to the preseason AP Top 25. Every week after that, the AP
   poll is irrelevant. Only PowerSwap results matter.
2. Ranked vs Ranked: if the winner held a worse (numerically higher) rank
   than the loser, they swap ranks. If the better-ranked team wins, nothing
   changes (chalk result).
3. Ranked vs Unranked: if the unranked team wins, it takes the ranked team's
   slot outright. The beaten ranked team is OUT of the rankings entirely,
   with no special status. It only gets back in by beating a team that is
   CURRENTLY in the PowerSwap top 25, whenever that next game happens.
4. Unranked vs Unranked: irrelevant, no rankings impact, not tracked.
5. Bye week / team doesn't play: that rank slot is frozen, unchanged.
6. Every rank slot carries a lineage: the ordered history of every team
   that has ever held it, so "who does the #3 spot trace back to" is always
   answerable.

This module only knows about game outcomes. It does not know how to fetch
data from any API - see fetch_results.py for that.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class LineageEntry:
    team: str
    held_from: str   # week label, e.g. "preseason", "week1", "week2"
    held_until: Optional[str] = None  # None means still holding


@dataclass
class RankSlot:
    rank: int
    team: str
    lineage: list[LineageEntry] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "rank": self.rank,
            "team": self.team,
            "lineage": [
                {"team": e.team, "held_from": e.held_from, "held_until": e.held_until}
                for e in self.lineage
            ],
        }

    @staticmethod
    def from_dict(d: dict) -> "RankSlot":
        slot = RankSlot(rank=d["rank"], team=d["team"])
        slot.lineage = [
            LineageEntry(team=e["team"], held_from=e["held_from"], held_until=e.get("held_until"))
            for e in d["lineage"]
        ]
        return slot


@dataclass
class SwapEvent:
    """A single rank-changing event for the weekly recap log."""
    kind: str  # "swap" or "dethrone"
    week: str
    winner: str
    loser: str
    winner_old_rank: Optional[int]
    loser_old_rank: int
    winner_new_rank: int
    loser_new_rank: Optional[int]  # None = unranked

    def to_dict(self) -> dict:
        return self.__dict__


class PowerSwapRankings:
    """
    Holds the current state of the 25 PowerSwap rank slots and applies
    a week's worth of game results to produce the next state.
    """

    def __init__(self, slots: list[RankSlot]):
        # slots must be exactly ranks 1-25, no gaps
        self.slots: dict[int, RankSlot] = {s.rank: s for s in slots}

    @classmethod
    def from_preseason_poll(cls, ranked_teams: list[str], week_label: str = "preseason") -> "PowerSwapRankings":
        """ranked_teams is an ordered list, index 0 = AP #1."""
        slots = []
        for i, team in enumerate(ranked_teams, start=1):
            slot = RankSlot(rank=i, team=team)
            slot.lineage.append(LineageEntry(team=team, held_from=week_label))
            slots.append(slot)
        return cls(slots)

    def team_rank(self, team: str) -> Optional[int]:
        for rank, slot in self.slots.items():
            if slot.team == team:
                return rank
        return None

    def apply_week(self, games: list[dict], week_label: str) -> list[SwapEvent]:
        """
        games: list of {"winner": str, "loser": str}
        Ties are not a thing in modern CFB, so only winner/loser is needed.
        Returns the list of SwapEvents that occurred this week, in the order
        processed. Mutates self in place to reflect the new state.
        """
        events: list[SwapEvent] = []

        for game in games:
            winner = game["winner"]
            loser = game["loser"]

            winner_rank = self.team_rank(winner)
            loser_rank = self.team_rank(loser)

            # Case: loser not ranked -> no effect regardless of winner's rank
            # (winning team can't improve by beating an unranked opponent)
            if loser_rank is None:
                continue

            # Case: loser ranked, winner unranked -> dethrone
            if winner_rank is None:
                slot = self.slots[loser_rank]
                old_team = slot.team
                # close out the old holder's lineage entry
                if slot.lineage:
                    slot.lineage[-1].held_until = week_label
                slot.team = winner
                slot.lineage.append(LineageEntry(team=winner, held_from=week_label))
                events.append(SwapEvent(
                    kind="dethrone",
                    week=week_label,
                    winner=winner,
                    loser=loser,
                    winner_old_rank=None,
                    loser_old_rank=loser_rank,
                    winner_new_rank=loser_rank,
                    loser_new_rank=None,
                ))
                continue

            # Case: both ranked
            if winner_rank > loser_rank:
                # winner was worse-ranked (higher number) than loser -> swap
                w_slot = self.slots[winner_rank]
                l_slot = self.slots[loser_rank]

                if w_slot.lineage:
                    w_slot.lineage[-1].held_until = week_label
                if l_slot.lineage:
                    l_slot.lineage[-1].held_until = week_label

                w_slot.team, l_slot.team = winner, loser
                # winner moves to loser's old (better) slot
                self.slots[loser_rank].team = winner
                self.slots[winner_rank].team = loser
                self.slots[loser_rank].lineage.append(LineageEntry(team=winner, held_from=week_label))
                self.slots[winner_rank].lineage.append(LineageEntry(team=loser, held_from=week_label))

                events.append(SwapEvent(
                    kind="swap",
                    week=week_label,
                    winner=winner,
                    loser=loser,
                    winner_old_rank=winner_rank,
                    loser_old_rank=loser_rank,
                    winner_new_rank=loser_rank,
                    loser_new_rank=winner_rank,
                ))
            # else: better-ranked team won (chalk) -> no movement, no event

        return events

    def to_dict(self, week_label: str) -> dict:
        return {
            "week": week_label,
            "rankings": [self.slots[r].to_dict() for r in sorted(self.slots.keys())],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "PowerSwapRankings":
        slots = [RankSlot.from_dict(s) for s in d["rankings"]]
        return cls(slots)

    def pretty_print(self) -> str:
        lines = []
        for rank in sorted(self.slots.keys()):
            lines.append(f"{rank:>2}. {self.slots[rank].team}")
        return "\n".join(lines)
