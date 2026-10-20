"""
PowerSwap Sports - Team Registry (sport-agnostic)

One generated file per sport, data/teams/<sport>_teams.json, is the single
source of truth for "which school is this?" everywhere: CFBD/CBBD
ingestion, backtest, havoc ratings, and (via its JS twin
live/team_registry.js, which reads the SAME file) the live-scores Worker.
It replaces the three hand-synced NORM tables that preceded it (see
PROJECT_BIBLE.md §4 rule 1 and §8's 2026-10-19 entry for why).

Built by scripts/build_team_registry.py from ESPN's + CFBD's (or CBBD's)
full team lists. Never hand-edit the generated file - put pins and extra
aliases in data/teams/<sport>_overrides.json and rebuild.

Resolution order, strongest first:
  1. By source ID (resolve_id): CFBD's team IDs, ESPN's team IDs, CBBD's
     team IDs. An ID is never ambiguous, never misspelled, and never
     changes when a school rebrands - always prefer it when a source
     gives one.
  2. By exact (folded) alias (resolve): every spelling either vendor uses
     for the school, abbreviations, "School Mascot" combos, legacy
     variants. Aliases two different schools both claim are left OUT of
     the index (listed under "ambiguous_aliases") rather than guessed.
  3. "School + mascot" fallback: a known school alias followed by
     something that closely matches THAT school's own mascot (catches
     vendor typos like BBS's "Golde Lions"). Never matches a school
     prefix followed by an unrelated word ("Texas" + "A&M Aggies"
     resolves by exact alias to Texas A&M, never to Texas).
  4. name_variants(): a few conservative rewrites ("... University",
     "... St", trailing state code) looked up exactly.
  Otherwise: None. Callers must treat None as loud, never silently keep
  a guess - that's the whole point of this module.

fold() MUST stay byte-for-byte equivalent to foldTeamName() in
live/team_registry.js - tests/test_team_registry.py checks every alias
in both registries through both implementations.
"""

from __future__ import annotations

import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TEAMS_DIR = REPO_ROOT / "data" / "teams"

_APOSTROPHES_AND_DOTS = re.compile(r"[’‘ʻʼ`´'.]")
_AMPERSAND = re.compile(r"\s*&\s*")
_NON_ALNUM = re.compile(r"[^a-z0-9&()]+")


def fold(name: str | None) -> str:
    """Canonical comparison key for a team-name string. Diacritics,
    case, apostrophes, periods, hyphens and spacing never distinguish two
    schools, so they're all folded away: "San José St." -> "san jose st",
    "Hawai'i" -> "hawaii", "Texas A & M" -> "texas a&m"."""
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", name)
    s = "".join(ch for ch in s if not unicodedata.category(ch).startswith("M"))
    s = s.lower()
    s = _APOSTROPHES_AND_DOTS.sub("", s)
    s = _AMPERSAND.sub("&", s)
    s = _NON_ALNUM.sub(" ", s)
    return " ".join(s.split())


def _edit_distance(a: str, b: str, limit: int) -> int:
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def mascot_matches(remainder: str, mascot: str) -> bool:
    """Close-enough check for the school+mascot fallback. Both folded."""
    if not remainder or not mascot:
        return False
    if remainder == mascot:
        return True
    if len(mascot) >= 4 and len(remainder) >= 4 and (remainder.startswith(mascot) or mascot.startswith(remainder)):
        return True
    return len(mascot) >= 5 and _edit_distance(remainder, mascot, 2) <= 2


DIVISION_I = ("fbs", "fcs", "d1")  # "d1" = basketball
_GENERIC_SUFFIXES = (" university", " college", " univ")
_STATE_CODE_SUFFIX = re.compile(r"^(.+) ([a-z]{2})$")


def name_variants(key: str) -> list[str]:
    """Conservative rewrites of a folded name that has NO exact alias -
    how CFBD's game feed spells small schools ("Harding University",
    "Pittsburg St", "Trinity University TX"). Each is only ever looked
    up exactly; nothing here strips a parenthetical qualifier, since
    "Dickinson (PA)" -> "dickinson" could land on a different school."""
    out = []
    base = key[len("university of "):] if key.startswith("university of ") else key
    for suffix in _GENERIC_SUFFIXES:
        if base.endswith(suffix):
            base = base[: -len(suffix)]
    if base != key:
        out.append(base)
    m = _STATE_CODE_SUFFIX.match(base)
    if m and m.group(2) not in ("st", "of"):
        stem = m.group(1)
        for suffix in _GENERIC_SUFFIXES:
            if stem.endswith(suffix):
                stem = stem[: -len(suffix)]
        out.append(f"{stem} ({m.group(2)})")
    if base.endswith(" st"):
        out.append(base[:-3] + " state")
    return out


class UnknownTeamError(LookupError):
    pass


class TeamRegistry:
    def __init__(self, data: dict):
        self.data = data
        self.sport = data["sport"]
        self.teams: dict[str, dict] = data["teams"]
        self.alias_index: dict[str, str] = data["alias_index"]
        self.id_index: dict[str, str] = data["id_index"]
        self.ambiguous: dict[str, list[str]] = data.get("ambiguous_aliases", {})
        self._by_name = {t["name"]: tid for tid, t in self.teams.items()}

    # -- lookups ---------------------------------------------------------

    def team(self, team_id: str) -> dict:
        return self.teams[team_id]

    def id_for_name(self, canonical_name: str) -> str | None:
        """Exact canonical-name -> ID (what stored season data uses)."""
        return self._by_name.get(canonical_name)

    def resolve_id(self, source: str, source_id) -> str | None:
        """Registry ID for a vendor's own team ID, e.g. ("cfbd", 2429),
        ("espn", "3253"), ("cbbd", 96). None if unknown."""
        if source_id is None or source_id == "":
            return None
        return self.id_index.get(f"{source}:{source_id}")

    def resolve(self, raw_name: str | None) -> str | None:
        """Registry ID for a vendor's team-name string, or None."""
        key = fold(raw_name)
        if not key:
            return None
        hit = self.alias_index.get(key)
        if hit:
            return hit
        words = key.split(" ")
        for cut in range(len(words) - 1, 0, -1):
            prefix_id = self.alias_index.get(" ".join(words[:cut]))
            if not prefix_id:
                continue
            remainder = " ".join(words[cut:])
            if any(mascot_matches(remainder, m) for m in self.teams[prefix_id]["mascots"]):
                return prefix_id
        # Never onto an FBS/FCS team: both vendors' full spellings for
        # those are already exact aliases, so a variant-only hit there is
        # far likelier a different school (real: "Louisiana College" ->
        # "louisiana" would have landed on the Ragin' Cajuns).
        for variant in name_variants(key):
            hit = self.alias_index.get(variant)
            if hit and self.teams[hit]["classification"] not in DIVISION_I:
                return hit
        return None

    # -- canonical-name helpers -----------------------------------------

    def name(self, team_id: str) -> str:
        return self.teams[team_id]["name"]

    def canonical(self, raw_name: str | None, source: str | None = None, source_id=None) -> str:
        """Canonical display name, ID first then name. Raises
        UnknownTeamError - never returns a guess."""
        tid = self.resolve_id(source, source_id) if source else None
        tid = tid or self.resolve(raw_name)
        if not tid:
            raise UnknownTeamError(
                f"Unknown {self.sport.upper()} team {raw_name!r}"
                + (f" ({source} id {source_id})" if source else "")
                + f". Rebuild the registry (scripts/build_team_registry.py --sport {self.sport})"
                f" or add an alias in data/teams/{self.sport}_overrides.json."
            )
        return self.teams[tid]["name"]


@lru_cache(maxsize=None)
def load_registry(sport: str) -> TeamRegistry:
    path = TEAMS_DIR / f"{sport}_teams.json"
    with open(path, encoding="utf-8") as f:
        return TeamRegistry(json.load(f))


def annotate_season_history(history: dict, registry: TeamRegistry) -> list[str]:
    """Stamps registry IDs onto a backtest's output in place - "team_id"
    on every ranking slot and lineage entry, "winner_id"/"loser_id" on
    every event, plus a top-level "team_ids" {name: id} map covering
    every name in the file (team_histories included). Additive only:
    no existing field changes. Returns names that are NOT canonical
    registry names - the caller must treat any as fatal, since a
    non-canonical name inside the rankings is exactly the silent
    corruption this registry exists to prevent."""
    ids: dict[str, str | None] = {}

    def tag(name: str) -> str | None:
        if name not in ids:
            ids[name] = registry.id_for_name(name)
        return ids[name]

    for snap in history.get("snapshots", []):
        for slot in snap.get("rankings", []):
            slot["team_id"] = tag(slot["team"])
            for held in slot.get("lineage", []):
                held["team_id"] = tag(held["team"])
    for event in history.get("events", []):
        event["winner_id"] = tag(event["winner"])
        event["loser_id"] = tag(event["loser"])
    for name in history.get("team_histories", {}):
        tag(name)
    history["team_ids"] = dict(sorted(ids.items()))
    return sorted(n for n, tid in ids.items() if tid is None)
