"""
PowerSwap Sports - Team Registry Builder

Generates data/teams/<sport>_teams.json (see core/teams.py for what it is
and how it's used) from:
  - ESPN's public team list (no key) - the live-scores primary source
  - CFBD /teams (football) or CBBD /teams (basketball) - the results/
    schedule source. CFBD_API_KEY covers both, same as everywhere else.
  - data/teams/<sport>_overrides.json - hand-maintained pins/aliases
  - the PREVIOUS generated file, if any - see NAME STABILITY below

ID SPACE. Football: the registry ID is CFBD's team ID, which is the same
number ESPN's scoreboard uses for every real game (verified 2026-10-19,
e.g. Colorado=38, Ole Miss=145). ESPN's own /teams LIST has a few stale
IDs (Charlotte 3253 / Troy 3237 there, but 2429 / 2653 on every real
scoreboard and in CFBD) - those are matched by school name and kept as
alternate IDs, so either number resolves. Basketball: the registry ID is
ESPN's (CBBD exposes it as `sourceId`; CBBD's own `id` is a different
number, kept as an alternate under "cbbd:").

NAME STABILITY. A team's canonical `name` is what season_history.json,
matchups and lineage are keyed by, so it must never drift just because a
vendor rebranded a school's display string. Precedence: overrides
`names` > the previous build's name for that ID > legacy display name
(the pre-registry NORM table's choice, e.g. "Mississippi", "Central
Florida") > the vendor's school name. A rename is therefore always an
explicit override edit, never a side effect of a rebuild.

AMBIGUITY. An alias claimed by more than one school is resolved by
strength tier (a school's real name beats another's abbreviation), then
by a single unambiguous higher-division claimant; otherwise it is
dropped from the index and listed in "ambiguous_aliases". The build
never guesses silently - it prints every ambiguity it drops.

Usage:
    export CFBD_API_KEY=...
    python scripts/build_team_registry.py --sport cfb
    python scripts/build_team_registry.py --sport cbb
    python scripts/build_team_registry.py --sport cfb --check   # exit 1 if output would change
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    print("This script requires the 'requests' library: pip install requests")
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "core"))
from teams import TEAMS_DIR, fold  # noqa: E402

SCHEMA_VERSION = 1
ESPN_UA = "curl/8.14.1"  # ESPN's WAF 403s browser-like UAs - see PROJECT_BIBLE.md §6

SPORTS = {
    "cfb": {
        "espn_teams": "https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=2000",
        "vendor": "cfbd",
        "vendor_teams": "https://api.collegefootballdata.com/teams",
    },
    "cbb": {
        "espn_teams": "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams?limit=2000",
        "vendor": "cbbd",
        "vendor_teams": "https://api.collegebasketballdata.com/teams",
    },
}

# The pre-registry NORM table's display choices (sports/cfb/team_norm.py
# as of 2026-10-19). Stored 2021-2026 season data uses these names, so
# they're pinned for any team whose vendor school name is a key here.
# Applied to basketball too, so a school reads the same in both sports.
LEGACY_DISPLAY = {
    "Hawai'i": "Hawaii",
    "App State": "Appalachian State",
    "Sam Houston": "Sam Houston State",
    "UMass": "Massachusetts",
    "UConn": "Connecticut",
    "Ole Miss": "Mississippi",
    "Pitt": "Pittsburgh",
    "USF": "South Florida",
    "UCF": "Central Florida",
    "FIU": "Florida International",
    "FAU": "Florida Atlantic",
    "UTSA": "UT San Antonio",
    "UNLV": "Nevada-Las Vegas",
    "San Jose State": "San José State",
    "Miami (FL)": "Miami",
    "Miami (OH)": "Miami (Ohio)",
}

PROMINENCE = {"fbs": 4, "d1": 4, "fcs": 3, "ii": 2, "iii": 1}
TIER_STRONG, TIER_ALT, TIER_ABBREV = 1, 2, 3


# ── fetching ────────────────────────────────────────────────────────────

def get_api_key() -> str:
    key = os.environ.get("CFBD_API_KEY")
    if not key:
        sys.exit("ERROR: CFBD_API_KEY is not set (same key for CFBD and CBBD).")
    return key


def fetch_espn(url: str) -> list[dict]:
    resp = requests.get(url, headers={"User-Agent": ESPN_UA}, timeout=60)
    resp.raise_for_status()
    leagues = resp.json()["sports"][0]["leagues"]
    return [entry["team"] for league in leagues for entry in league["teams"]]


def fetch_vendor(url: str) -> list[dict]:
    resp = requests.get(url, headers={"Authorization": f"Bearer {get_api_key()}"}, timeout=60)
    resp.raise_for_status()
    return resp.json()


def load_json(path: Path, default):
    if not path.exists():
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ── merging ─────────────────────────────────────────────────────────────

def new_team(tid: str) -> dict:
    return {
        "id": tid, "school": None, "mascot": None, "abbreviation": None,
        "classification": None, "conference": None, "color": None, "logo": None,
        "state": None, "source_ids": defaultdict(set), "aliases": defaultdict(set),
        "mascot_set": set(),
    }


def add_alias(team: dict, tier: int, name) -> None:
    if isinstance(name, str) and name.strip():
        team["aliases"][tier].add(name.strip())


def absorb_vendor_record(team: dict, rec: dict, vendor: str) -> None:
    """Vendor (CFBD/CBBD) record -> team fields + aliases."""
    team["source_ids"][vendor].add(str(rec["id"]))
    team["school"] = team["school"] or rec.get("school")
    team["mascot"] = team["mascot"] or rec.get("mascot")
    team["abbreviation"] = team["abbreviation"] or rec.get("abbreviation")
    team["classification"] = team["classification"] or rec.get("classification")
    team["conference"] = team["conference"] or rec.get("conference")
    team["color"] = team["color"] or (rec.get("color") or rec.get("primaryColor"))
    logos = rec.get("logos") or []
    team["logo"] = team["logo"] or (logos[0] if logos else None)
    loc = rec.get("location") or {}
    team["state"] = team["state"] or loc.get("state") or rec.get("currentState")
    school, mascot = rec.get("school"), rec.get("mascot")
    add_alias(team, TIER_STRONG, school)
    add_alias(team, TIER_STRONG, rec.get("displayName"))
    if school and mascot:
        add_alias(team, TIER_STRONG, f"{school} {mascot}")
    for alt in rec.get("alternateNames") or []:
        add_alias(team, TIER_ALT, alt)
    add_alias(team, TIER_ALT, rec.get("shortDisplayName"))
    add_alias(team, TIER_ABBREV, rec.get("abbreviation"))
    if mascot:
        team["mascot_set"].add(mascot)


def absorb_espn_record(team: dict, rec: dict) -> None:
    team["source_ids"]["espn"].add(str(rec["id"]))
    team["school"] = team["school"] or rec.get("location")
    team["mascot"] = team["mascot"] or rec.get("name")
    team["abbreviation"] = team["abbreviation"] or rec.get("abbreviation")
    team["color"] = team["color"] or rec.get("color")
    logos = rec.get("logos") or []
    team["logo"] = team["logo"] or (logos[0].get("href") if logos else None)
    add_alias(team, TIER_STRONG, rec.get("location"))
    add_alias(team, TIER_STRONG, rec.get("displayName"))
    add_alias(team, TIER_ALT, rec.get("shortDisplayName"))
    add_alias(team, TIER_ALT, rec.get("nickname"))
    add_alias(team, TIER_ABBREV, rec.get("abbreviation"))
    if rec.get("name"):
        team["mascot_set"].add(rec["name"])


def prominence(rec_or_team: dict) -> int:
    return PROMINENCE.get(rec_or_team.get("classification") or "", 0)


def merge_cfb(espn: list[dict], vendor: list[dict]) -> dict[str, dict]:
    """Primary ID = CFBD id. CFBD records sharing a school name collapse
    into the most prominent one (CFBD carries legacy duplicate IDs for
    many small schools, e.g. Minnesota Duluth 134 + 1001020), unless two
    of them are classified - then they're genuinely different schools."""
    by_name = defaultdict(list)
    for rec in vendor:
        by_name[fold(rec.get("school"))].append(rec)
    espn_ids = {str(t["id"]) for t in espn}

    teams: dict[str, dict] = {}
    for recs in by_name.values():
        recs.sort(key=lambda r: (-prominence(r), str(r["id"]) not in espn_ids, r["id"]))
        classified = [r for r in recs if r.get("classification")]
        groups = [[r] for r in classified[1:]] if len(classified) > 1 else []
        primary_group = [r for r in recs if r not in [g[0] for g in groups]]
        for group in [primary_group, *groups]:
            team = new_team(str(group[0]["id"]))
            for rec in group:
                absorb_vendor_record(team, rec, "cfbd")
            teams[team["id"]] = team

    by_cfbd_id = {i: t for t in teams.values() for i in t["source_ids"]["cfbd"]}
    by_school = {}
    for t in teams.values():
        by_school.setdefault(fold(t["school"]), t)
    for rec in espn:
        team = by_cfbd_id.get(str(rec["id"])) or by_school.get(fold(rec.get("location")))
        if team is None:
            team = new_team(f"espn-{rec['id']}")
            teams[team["id"]] = team
        absorb_espn_record(team, rec)
    return teams


def merge_cbb(espn: list[dict], vendor: list[dict]) -> dict[str, dict]:
    """Primary ID = ESPN id (CBBD's `sourceId`)."""
    teams: dict[str, dict] = {}
    for rec in espn:
        team = new_team(str(rec["id"]))
        absorb_espn_record(team, rec)
        team["classification"] = "d1"  # ESPN's men's list is exactly Division I
        teams[team["id"]] = team
    by_school = {fold(t["school"]): t for t in teams.values()}
    for rec in vendor:
        sid = str(rec.get("sourceId") or "")
        if not sid.isdigit():  # real CBBD junk like "UNKNOWN#Whittier" - not an ESPN id
            sid = ""
        team = teams.get(sid) or by_school.get(fold(rec.get("school")))
        if team is None:
            team = new_team(sid or f"cbbd-{rec['id']}")
            teams[team["id"]] = team
            by_school[fold(rec.get("school"))] = team
        absorb_vendor_record(team, rec, "cbbd")
    return teams


# ── naming, aliasing, indexing ──────────────────────────────────────────

def assign_names(teams: dict[str, dict], overrides: dict, previous: dict) -> None:
    pinned_names = overrides.get("names", {})
    prev_teams = previous.get("teams", {})
    for tid, t in teams.items():
        if tid in pinned_names:
            t["name"], t["pinned"] = pinned_names[tid], True
        elif tid in prev_teams:
            t["name"], t["pinned"] = prev_teams[tid]["name"], True
        else:
            school = t["school"] or tid
            t["name"], t["pinned"] = LEGACY_DISPLAY.get(school, school), school in LEGACY_DISPLAY

    # Canonical names must be unique. Pinned names never move; a new,
    # unpinned duplicate gets the less-prominent side disambiguated.
    seen: dict[str, str] = {}
    for tid, t in sorted(teams.items(), key=lambda kv: (not kv[1]["pinned"], -prominence(kv[1]), kv[0])):
        key = fold(t["name"])
        if key in seen:
            if t["pinned"]:
                sys.exit(f"ERROR: pinned name {t['name']!r} used by both {seen[key]} and {tid} - fix the overrides.")
            suffix = f" ({t['state']})" if t["state"] else f" [{tid}]"
            t["name"] = f"{t['name']}{suffix}"
            if fold(t["name"]) in seen:
                t["name"] = f"{t['name']} [{tid}]"
            key = fold(t["name"])
        seen[key] = tid


def build_indexes(teams: dict[str, dict], overrides: dict, sport: str) -> tuple[dict, dict, dict]:
    for tid, t in teams.items():
        add_alias(t, TIER_STRONG, t["name"])
        for legacy, display in LEGACY_DISPLAY.items():
            if display == t["name"]:
                add_alias(t, TIER_STRONG, legacy)
        for alias in overrides.get("aliases", {}).get(tid, []):
            add_alias(t, 0, alias)  # tier 0: an explicit override beats everything
        schoolish = {t["name"], t["school"], *t["aliases"][TIER_STRONG]} - {None}
        schoolish = {s for s in schoolish if not any(fold(s).endswith(" " + fold(m)) for m in t["mascot_set"])}
        for s in schoolish:
            for m in t["mascot_set"]:
                add_alias(t, TIER_ALT, f"{s} {m}")

    blocked = {fold(a) for a in overrides.get("blocked_aliases", [])}
    claims: dict[str, dict[str, int]] = defaultdict(dict)
    for tid, t in teams.items():
        for tier, names in t["aliases"].items():
            for n in names:
                key = fold(n)
                if key and key not in blocked:
                    claims[key][tid] = min(tier, claims[key].get(tid, 99))

    alias_index, ambiguous = {}, {}
    for key, by_team in claims.items():
        best = min(by_team.values())
        contenders = [tid for tid, tier in by_team.items() if tier == best]
        if len(contenders) == 1:
            alias_index[key] = contenders[0]
            continue
        own_name = [tid for tid in contenders if fold(teams[tid]["name"]) == key]
        if len(own_name) == 1:
            alias_index[key] = own_name[0]
            continue
        ranked = sorted(contenders, key=lambda tid: -prominence(teams[tid]))
        top, runner_up = prominence(teams[ranked[0]]), prominence(teams[ranked[1]])
        if top >= PROMINENCE["fcs"] and top > runner_up:
            alias_index[key] = ranked[0]
            continue
        ambiguous[key] = sorted(contenders)

    id_index = {}
    for tid, t in teams.items():
        for source, ids in t["source_ids"].items():
            for sid in ids:
                id_index[f"{source}:{sid}"] = tid
    return alias_index, ambiguous, id_index


def serialize(teams: dict[str, dict], alias_index: dict, ambiguous: dict, id_index: dict,
              sport: str, counts: dict) -> dict:
    out_teams = {}
    for tid in sorted(teams, key=lambda x: (len(x), x)):
        t = teams[tid]
        out_teams[tid] = {
            "name": t["name"],
            "school": t["school"],
            "mascot": t["mascot"],
            "abbreviation": t["abbreviation"],
            "classification": t["classification"],
            "conference": t["conference"],
            "color": t["color"],
            "logo": t["logo"],
            "source_ids": {k: sorted(v) for k, v in sorted(t["source_ids"].items())},
            "mascots": sorted({fold(m) for m in t["mascot_set"] if fold(m)}),
            "aliases": sorted({a for names in t["aliases"].values() for a in names}),
        }
    return {
        "schema_version": SCHEMA_VERSION,
        "sport": sport,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_counts": counts,
        "teams": out_teams,
        "alias_index": dict(sorted(alias_index.items())),
        "ambiguous_aliases": dict(sorted(ambiguous.items())),
        "id_index": dict(sorted(id_index.items())),
    }


def build(sport: str) -> dict:
    cfg = SPORTS[sport]
    out_path = TEAMS_DIR / f"{sport}_teams.json"
    overrides = load_json(TEAMS_DIR / f"{sport}_overrides.json", {})
    previous = load_json(out_path, {})

    espn = fetch_espn(cfg["espn_teams"])
    vendor = fetch_vendor(cfg["vendor_teams"])
    print(f"Fetched {len(espn)} ESPN teams, {len(vendor)} {cfg['vendor'].upper()} teams")
    if len(espn) < 300 or len(vendor) < 300:
        sys.exit("ERROR: suspiciously small team list from a vendor - refusing to overwrite the registry.")

    teams = merge_cfb(espn, vendor) if sport == "cfb" else merge_cbb(espn, vendor)

    # A team the previous build knew must never vanish (stored data may
    # reference it) - carry it forward untouched if a vendor dropped it.
    for tid, old in previous.get("teams", {}).items():
        if tid not in teams:
            print(f"  NOTE: {old['name']} ({tid}) missing from vendor lists - kept from previous build")
            t = new_team(tid)
            for k in ("school", "mascot", "abbreviation", "classification", "conference", "color", "logo"):
                t[k] = old.get(k)
            for source, ids in old["source_ids"].items():
                t["source_ids"][source].update(ids)
            t["aliases"][TIER_ALT].update(old["aliases"])
            t["mascot_set"].update(old.get("mascots", []))
            teams[tid] = t

    assign_names(teams, overrides, previous)
    alias_index, ambiguous, id_index = build_indexes(teams, overrides, sport)

    renamed = [(tid, previous["teams"][tid]["name"], t["name"]) for tid, t in teams.items()
               if tid in previous.get("teams", {}) and previous["teams"][tid]["name"] != t["name"]]
    for tid, old, new in renamed:
        print(f"  RENAMED by override: {tid} {old!r} -> {new!r}")
    print(f"{len(teams)} teams, {len(alias_index)} aliases indexed, {len(ambiguous)} ambiguous aliases dropped")
    for key, tids in ambiguous.items():
        print(f"  ambiguous: {key!r} -> " + ", ".join(f"{teams[t]['name']} ({t})" for t in tids))

    return serialize(teams, alias_index, ambiguous, id_index, sport,
                     {"espn": len(espn), cfg["vendor"]: len(vendor)})


def main():
    parser = argparse.ArgumentParser(description="Build data/teams/<sport>_teams.json")
    parser.add_argument("--sport", required=True, choices=sorted(SPORTS))
    parser.add_argument("--check", action="store_true",
                        help="Don't write; exit 1 if the registry content would change")
    args = parser.parse_args()

    registry = build(args.sport)
    out_path = TEAMS_DIR / f"{args.sport}_teams.json"
    previous = load_json(out_path, {})
    unchanged = {k: v for k, v in previous.items() if k != "generated_at"} == \
                {k: v for k, v in registry.items() if k != "generated_at"}
    if args.check:
        print("Registry is up to date." if unchanged else "Registry would change.")
        sys.exit(0 if unchanged else 1)
    if unchanged:
        print(f"No content change - left {out_path} untouched.")
        return
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(registry, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
