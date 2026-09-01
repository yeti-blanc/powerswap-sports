"""
PowerSwap Live Scores - BBS diagnose / dev helper.

Not used by the deployed Worker (that's live/worker.js, running in
Cloudflare's JS runtime). This is a local tool for two things:

    python live/fetch_live_scores.py --diagnose
        Makes one real authenticated call to BBS's /v1/matches and prints
        the raw response, so a human can eyeball real field names before
        anyone touches live/bbs_client.js's parsing logic. Run this again
        whenever something in the live feed looks wrong.

    python live/fetch_live_scores.py --ranked-check
        Fetches the current ranked-teams list the same way the Worker
        does, and fetches live BBS matches, and prints which BBS games
        resolve to a ranked team - a quick local sanity check of the
        team-name matching logic without needing to redeploy the Worker.

Reads BBS_API_KEY (required) and, implicitly, nothing else - this script
never touches CFBD_API_KEY. Loads .env from the repo root if present;
never prints the key itself.
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from sports.cfb.team_norm import norm  # noqa: E402
from live.bbs_config import BASE_URL, SPORT, LEAGUE, MATCHES_PATH  # noqa: E402

RANKED_TEAMS_URL = (
    "https://raw.githubusercontent.com/yeti-blanc/powerswap-sports/"
    "main/data/cfb/seasons/2026/season_history.json"
)


def load_env(path=None):
    path = path or os.path.join(os.path.dirname(__file__), "..", ".env")
    env = {}
    if not os.path.exists(path):
        return env
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def fetch_matches(api_key):
    url = f"{BASE_URL}{MATCHES_PATH}?sport={SPORT}&league={LEAGUE}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def fetch_ranked_teams():
    req = urllib.request.Request(RANKED_TEAMS_URL)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []  # expected until the 2026 season_history.json exists
        raise
    snapshots = data.get("snapshots", [])
    if not snapshots:
        return []
    return [slot["team"] for slot in snapshots[-1].get("rankings", [])]


def resolve_bbs_name(bbs_name, ranked_teams):
    # Same "school name is a leading prefix of School Mascot" heuristic as
    # live/team_norm.js's resolveBbsTeamName - see that file for the real
    # examples this was confirmed against. Kept intentionally simple/dumb
    # here since this script is a diagnostic tool, not production logic.
    folded = bbs_name.lower()
    for canonical in ranked_teams:
        if folded == canonical.lower() or folded.startswith(canonical.lower() + " "):
            return canonical
    return None


def cmd_diagnose(args):
    env = load_env()
    key = env.get("BBS_API_KEY") or os.environ.get("BBS_API_KEY")
    if not key:
        print("BBS_API_KEY not found in .env or environment.", file=sys.stderr)
        sys.exit(1)

    status, body = fetch_matches(key)
    print(f"STATUS: {status}")
    print(json.dumps(body, indent=2))


def cmd_ranked_check(args):
    env = load_env()
    key = env.get("BBS_API_KEY") or os.environ.get("BBS_API_KEY")
    if not key:
        print("BBS_API_KEY not found in .env or environment.", file=sys.stderr)
        sys.exit(1)

    ranked = fetch_ranked_teams()
    print(f"Ranked teams ({len(ranked)}): {ranked}")
    if not ranked:
        print("No 2026 season_history.json yet - nothing to match against.")
        return

    status, body = fetch_matches(key)
    matches = body.get("data", [])
    hits = 0
    for g in matches:
        home = resolve_bbs_name(g["home"]["name"], ranked)
        away = resolve_bbs_name(g["away"]["name"], ranked)
        if home or away:
            hits += 1
            print(f"  {g['home']['name']} ({home}) vs {g['away']['name']} ({away}) - {g['status']}")
    print(f"{hits} relevant game(s) out of {len(matches)} total.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--diagnose", action="store_true")
    parser.add_argument("--ranked-check", action="store_true")
    args = parser.parse_args()

    if args.diagnose:
        cmd_diagnose(args)
    elif args.ranked_check:
        cmd_ranked_check(args)
    else:
        parser.print_help()
