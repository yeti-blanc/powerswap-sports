"""
PowerSwap CFB - team name normalization (thin wrapper over the team registry)

The hand-maintained NORM table that used to live here (and its copies in
sports/cbb/team_norm.py and live/team_norm.js) was replaced on 2026-10-19
by the generated registry, data/teams/cfb_teams.json - see core/teams.py.
These functions keep their old signatures so every existing caller keeps
working, but now resolve against the full ESPN + CFBD team list, by ID
whenever the caller has one.

Rule (unchanged from the Cote Cup lesson): normalize at ingestion, before
any name touches the rankings. A name the registry can't place is
returned unchanged AND recorded in UNRESOLVED, so callers/validators can
fail loudly instead of letting it silently become "a different team".
To fix one: rebuild the registry (scripts/build_team_registry.py --sport cfb)
or add an alias in data/teams/cfb_overrides.json. Never patch data.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "core"))
from teams import load_registry  # noqa: E402

SPORT = "cfb"
VENDOR = "cfbd"
UNRESOLVED: set[str] = set()


def registry():
    return load_registry(SPORT)


def resolve(team_name: str, vendor_id=None) -> str | None:
    """Registry ID for a vendor team (by CFBD ID first, then name), or None."""
    r = registry()
    return r.resolve_id(VENDOR, vendor_id) or r.resolve(team_name)


def norm(team_name: str, vendor_id=None) -> str:
    """Canonical name for a team; unchanged (and recorded) if unknown."""
    tid = resolve(team_name, vendor_id)
    if tid:
        return registry().name(tid)
    if team_name and team_name not in UNRESOLVED:
        UNRESOLVED.add(team_name)
        print(f"  WARNING: UNRESOLVED CFB TEAM: {team_name!r}"
              + (f" (CFBD id {vendor_id})" if vendor_id is not None else "")
              + f" - not in data/teams/cfb_teams.json", file=sys.stderr)
    return team_name


def team_id(team_name: str, vendor_id=None) -> str | None:
    return resolve(team_name, vendor_id)


def normalize_team_list(teams: list[str]) -> list[str]:
    return [norm(t) for t in teams]


def normalize_games(games: list[dict]) -> list[dict]:
    """{"winner", "loser", optional "winner_vendor_id"/"loser_vendor_id",
    any extra fields like "date"} -> canonical names plus registry
    "winner_id"/"loser_id" (None when unresolvable). **g preserves extra
    fields - postseason/basketball need "date" for chronological sorting."""
    out = []
    for g in games:
        g = dict(g)
        wv, lv = g.pop("winner_vendor_id", None), g.pop("loser_vendor_id", None)
        out.append({**g,
                    "winner": norm(g["winner"], wv), "loser": norm(g["loser"], lv),
                    "winner_id": team_id(g["winner"], wv), "loser_id": team_id(g["loser"], lv)})
    return out
