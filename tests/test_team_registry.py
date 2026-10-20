"""
Team registry tests - the guard rails for data/teams/<sport>_teams.json,
core/teams.py and its JS twin live/team_registry.js.

If any of these fail, a real result can silently vanish or land on the
wrong school (PROJECT_BIBLE.md §4 rule 1, §8's 2026-10-19 entry) - fix
the registry/overrides, never loosen a test to get green.

Run: python tests/test_team_registry.py   (needs `node` on PATH for the
JS-parity test, same Node the Worker is built with)
"""

import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "core"))

from teams import fold, load_registry  # noqa: E402

SPORTS = ("cfb", "cbb")

# (sport, raw vendor string, expected canonical name or None)
KNOWN_CASES = [
    ("cfb", "Mississippi", "Mississippi"),
    ("cfb", "Ole Miss", "Mississippi"),
    ("cfb", "Ole Miss Rebels", "Mississippi"),
    ("cfb", "Miami", "Miami"),
    ("cfb", "Miami (FL)", "Miami"),
    ("cfb", "Miami Hurricanes", "Miami"),
    ("cfb", "Miami (OH)", "Miami (Ohio)"),
    ("cfb", "Miami (OH) RedHawks", "Miami (Ohio)"),
    ("cfb", "Texas", "Texas"),
    ("cfb", "Texas Longhorns", "Texas"),
    ("cfb", "Texas A&M Aggies", "Texas A&M"),
    ("cfb", "Texas A & M", "Texas A&M"),
    ("cfb", "Texas Tech Red Raiders", "Texas Tech"),
    ("cfb", "Texas State Bobcats", "Texas State"),
    ("cfb", "UCF Knights", "Central Florida"),
    ("cfb", "UCF", "Central Florida"),
    ("cfb", "Hawai'i Rainbow Warriors", "Hawaii"),
    ("cfb", "Hawaiʻi", "Hawaii"),
    ("cfb", "San Jose State Spartans", "San José State"),
    ("cfb", "San José St.", "San José State"),
    ("cfb", "Pitt", "Pittsburgh"),
    ("cfb", "USC Trojans", "USC"),
    ("cfb", "Southern California", "USC"),
    ("cfb", "Washington Huskies", "Washington"),
    ("cfb", "Washington State Cougars", "Washington State"),
    ("cfb", "Colorado Buffaloes", "Colorado"),
    ("cfb", "Charlotte 49ers", "Charlotte"),
    ("cfb", "UNLV Rebels", "Nevada-Las Vegas"),
    ("cfb", "UTSA Roadrunners", "UT San Antonio"),
    ("cfb", "App State Mountaineers", "Appalachian State"),
    ("cfb", "Arkansas-Pine Bluff Golde Lions", "Arkansas-Pine Bluff"),  # real BBS typo
    ("cfb", "Louisiana Ragin' Cajuns", "Louisiana"),
    ("cfb", "Louisiana College", None),       # NOT the Ragin' Cajuns
    ("cfb", "Texas Wildcats", None),          # school prefix + someone else's mascot
    ("cfb", "", None),
    ("cbb", "St. John's Red Storm", "St. John's"),
    ("cbb", "Saint Mary's Gaels", "Saint Mary's"),
    ("cbb", "UConn", "Connecticut"),
    ("cbb", "Ole Miss", "Mississippi"),
    ("cbb", "Miami (OH) RedHawks", "Miami (Ohio)"),
    ("cbb", "Texas A&M-Corpus Christi", "Texas A&M-Corpus Christi"),
    ("cbb", "Texas A&M", "Texas A&M"),
    ("cbb", "North Carolina Tar Heels", "North Carolina"),
    ("cbb", "NC State", "NC State"),
    ("cbb", "Southern California", "USC"),
    ("cbb", "Gonzaga Bulldogs", "Gonzaga"),
]

KNOWN_IDS = [
    ("cfb", "cfbd", 38, "Colorado"),
    ("cfb", "espn", "145", "Mississippi"),
    ("cfb", "cfbd", 2429, "Charlotte"),
    ("cfb", "espn", "3253", "Charlotte"),   # ESPN /teams list's stale Charlotte id
    ("cfb", "espn", "3237", "Troy"),        # same for Troy
    ("cbb", "espn", "2599", "St. John's"),
]


def stored_names_that_must_resolve_exactly():
    """Every team name in files the rankings/site actually key on:
    season histories (snapshots, lineage, events, team histories),
    preseason polls, matchups. Raw games files are checked separately -
    they also carry historical small-college opponents CFBD spelled
    loosely, which never touch the rankings."""
    out = {}
    for sport in SPORTS:
        base = os.path.join(REPO_ROOT, "data", sport, "seasons")
        paths = (glob.glob(os.path.join(base, "*", "season_history.json"))
                 + glob.glob(os.path.join(base, "*", "preseason_poll.json"))
                 + glob.glob(os.path.join(base, "*", "*matchups*.json"))
                 + glob.glob(os.path.join(base, "*", "raw", "*matchups*.json")))
        for p in paths:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
            names = set()

            def walk(o):
                if isinstance(o, dict):
                    for k, v in o.items():
                        if k in ("team", "winner", "loser", "opponent") and isinstance(v, str):
                            names.add(v)
                        if k in ("matchups", "team_histories") and isinstance(v, dict):
                            names.update(v)
                        walk(v)
                elif isinstance(o, list):
                    for v in o:
                        walk(v)
            walk(data)
            if isinstance(data.get("teams"), list):
                names.update(data["teams"])
            for n in names:
                out.setdefault((sport, n), os.path.relpath(p, REPO_ROOT))
    return out


def test_registry_internal_consistency():
    print("TEST: registry internal consistency (both sports)")
    for sport in SPORTS:
        r = load_registry(sport)
        names = [t["name"] for t in r.teams.values()]
        assert len(names) == len(set(names)), f"{sport}: duplicate canonical names"
        folded = [fold(n) for n in names]
        assert len(folded) == len(set(folded)), f"{sport}: canonical names collide after folding"
        for tid, t in r.teams.items():
            assert r.resolve(t["name"]) == tid, f"{sport}: {t['name']!r} doesn't resolve to itself"
        for key, tid in r.alias_index.items():
            assert tid in r.teams, f"{sport}: alias {key!r} points at missing team {tid}"
            assert key == fold(key), f"{sport}: alias index key {key!r} isn't folded"
        for sid, tid in r.id_index.items():
            assert tid in r.teams, f"{sport}: id {sid} points at missing team {tid}"
        for key in r.ambiguous:
            assert key not in r.alias_index, f"{sport}: ambiguous alias {key!r} still indexed"
        print(f"  PASS - {sport}: {len(r.teams)} teams, {len(r.alias_index)} aliases, {len(r.id_index)} ids")


def test_every_vendor_id_and_display_name_resolves():
    print("TEST: every vendor ID resolves, every team's own vendor spellings resolve to it")
    for sport in SPORTS:
        r = load_registry(sport)
        for tid, t in r.teams.items():
            for source, ids in t["source_ids"].items():
                for sid in ids:
                    assert r.resolve_id(source, sid) == tid, f"{sport}: {source}:{sid} -> {r.resolve_id(source, sid)}, want {tid}"
            for alias in t["aliases"]:
                got = r.resolve(alias)
                if fold(alias) in r.ambiguous:
                    continue
                assert got is not None, f"{sport}: own alias {alias!r} of {t['name']} doesn't resolve"
        print(f"  PASS - {sport}")


def test_known_cases():
    print("TEST: known tricky names")
    for sport, raw, want in KNOWN_CASES:
        r = load_registry(sport)
        tid = r.resolve(raw)
        got = r.name(tid) if tid else None
        assert got == want, f"{sport}: {raw!r} -> {got!r}, want {want!r}"
    for sport, source, sid, want in KNOWN_IDS:
        r = load_registry(sport)
        tid = r.resolve_id(source, sid)
        assert tid and r.name(tid) == want, f"{sport}: {source}:{sid} -> {tid}, want {want!r}"
    print(f"  PASS - {len(KNOWN_CASES)} names, {len(KNOWN_IDS)} ids")


def test_pinned_names_hold():
    print("TEST: overrides' pinned names are what the registry uses")
    for sport in SPORTS:
        r = load_registry(sport)
        with open(os.path.join(REPO_ROOT, "data", "teams", f"{sport}_overrides.json"), encoding="utf-8") as f:
            overrides = json.load(f)
        for tid, name in overrides.get("names", {}).items():
            assert r.name(tid) == name, f"{sport}: {tid} is {r.name(tid)!r}, pinned {name!r}"
        for tid, aliases in overrides.get("aliases", {}).items():
            for a in aliases:
                assert r.resolve(a) == tid, f"{sport}: override alias {a!r} -> {r.resolve(a)}, want {tid}"
    print("  PASS")


def test_stored_season_data_resolves_exactly():
    print("TEST: every stored ranking/poll/matchup name is a canonical registry name")
    problems = []
    names = stored_names_that_must_resolve_exactly()
    for (sport, n), where in names.items():
        r = load_registry(sport)
        tid = r.resolve(n)
        if not tid or r.name(tid) != n:
            problems.append(f"{sport} {n!r} ({where}) -> {r.name(tid) if tid else None!r}")
    assert not problems, "\n".join(problems)
    print(f"  PASS - {len(names)} stored names")


def test_raw_games_ids_agree_with_names():
    print("TEST: raw games files - every stored winner_id/loser_id agrees with its stored name")
    checked = 0
    for sport in SPORTS:
        r = load_registry(sport)
        for p in glob.glob(os.path.join(REPO_ROOT, "data", sport, "seasons", "*", "raw", "*_games.json")):
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
            for g in data.get("games", []):
                for side in ("winner", "loser"):
                    tid = g.get(f"{side}_id")
                    if tid is None:
                        continue
                    checked += 1
                    # Pre-registry raw files keep CFBD's original loose
                    # spellings ("Harding University"), so the check is
                    # that the stored ID is what the stored name resolves
                    # to; files written since 2026-10-19 are canonical.
                    assert tid in r.teams, f"{p}: {side} {g[side]!r} has unknown id {tid}"
                    assert r.resolve(g[side]) == tid, f"{p}: {side} {g[side]!r} has id {tid} ({r.name(tid)!r})"
    print(f"  PASS - {checked} ids checked")


def test_js_parity():
    print("TEST: live/team_registry.js agrees with core/teams.py on every alias")
    node = shutil.which("node")
    assert node, "node not on PATH - the JS twin can't be verified"
    probes = {}
    for sport in SPORTS:
        r = load_registry(sport)
        inputs = set()
        for t in r.teams.values():
            inputs.update(t["aliases"])
            inputs.add(t["name"])
            for m in t["mascots"][:1]:
                inputs.add(f"{t['name']} {m[:-1]}")  # one-letter-short mascot: exercises the fuzzy path
        inputs.update(raw for s, raw, _ in KNOWN_CASES if s == sport)
        inputs.update(n for (s, n) in stored_names_that_must_resolve_exactly() if s == sport)
        for p in glob.glob(os.path.join(REPO_ROOT, "data", sport, "seasons", "*", "raw", "*_games.json")):
            with open(p, encoding="utf-8") as f:
                for g in json.load(f).get("games", []):
                    inputs.update((g["winner"], g["loser"]))
        probes[sport] = sorted(inputs)

    script = r"""
import { readFileSync } from "fs";
import { pathToFileURL } from "url";
const [regMod, probesPath, root] = process.argv.slice(2);
const { foldTeamName, createTeamRegistry } = await import(pathToFileURL(regMod).href);
const probes = JSON.parse(readFileSync(probesPath, "utf8"));
const out = {};
for (const [sport, inputs] of Object.entries(probes)) {
  const reg = createTeamRegistry(JSON.parse(readFileSync(`${root}/data/teams/${sport}_teams.json`, "utf8")));
  out[sport] = inputs.map((s) => [foldTeamName(s), reg.resolve(s)]);
}
process.stdout.write(JSON.stringify(out));
"""
    with tempfile.TemporaryDirectory() as tmp:
        probes_path = os.path.join(tmp, "probes.json")
        script_path = os.path.join(tmp, "parity.mjs")
        with open(probes_path, "w", encoding="utf-8") as f:
            json.dump(probes, f, ensure_ascii=False)
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(script)
        res = subprocess.run(
            [node, script_path, os.path.join(REPO_ROOT, "live", "team_registry.js"), probes_path, REPO_ROOT],
            capture_output=True, text=True, encoding="utf-8", check=True,
        )
    js = json.loads(res.stdout)
    total = 0
    for sport, inputs in probes.items():
        r = load_registry(sport)
        for raw, (js_fold, js_id) in zip(inputs, js[sport]):
            assert js_fold == fold(raw), f"fold mismatch {raw!r}: py {fold(raw)!r} js {js_fold!r}"
            assert js_id == r.resolve(raw), f"{sport} resolve mismatch {raw!r}: py {r.resolve(raw)} js {js_id}"
            total += 1
    print(f"  PASS - {total} inputs identical in Python and JS")


if __name__ == "__main__":
    test_registry_internal_consistency()
    test_every_vendor_id_and_display_name_resolves()
    test_known_cases()
    test_pinned_names_hold()
    test_stored_season_data_resolves_exactly()
    test_raw_games_ids_agree_with_names()
    test_js_parity()
    print("=" * 50)
    print("ALL TESTS PASSED")
