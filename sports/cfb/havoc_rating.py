"""
PowerSwap CFB - Havoc Rating (baseline)
========================================

A per-game "how much upset/chaos potential does this game carry" score,
built from CFBD's real betting lines (sports/cfb/fetch_lines.py) plus
two independent rank-gap signals: PowerSwap's own alternate-universe
ranks, and the real world's AP Top 25.

Design split, spelled out because it's a real judgment call, not obvious
from "combine odds and rankings":
  - Spread and moneyline are LIKELIHOOD signals: a small spread / a
    near-50-50 moneyline means Vegas thinks either team could plausibly
    win. Smaller gap -> higher score.
  - PowerSwap rank gap and AP rank gap are MAGNITUDE/STAKES signals: they
    say how big a deal it would be if the worse-ranked team won - the
    same "unranked dethrones #2" logic that already drives the swap
    engine's own rules (core/swap_engine.py) and the site's existing
    HAVOC panel of rank-change events. Bigger gap -> higher score. This
    is the OPPOSITE direction from the likelihood signals on purpose:
    a competitive game between #1 and #2 is likely-to-be-close but not
    very "havoc" (whoever wins, the board barely moves), while a
    competitive game between an unranked team and #3 is both plausible
    AND high-stakes - that's the real "havoc" case this is meant to
    surface.
  - Over/under is included because it was asked for, but it's a weak,
    unvalidated, low-weight signal here - a mild proxy for a more
    wide-open game, nothing more.

INJURY DATA: not available from any vendor checked so far (CFBD has no
injury endpoint at all - confirmed against its full OpenAPI spec on
2026-09-04; BBS's /v1/injuries is the NFL's mandated report only,
confirmed live; Highlightly's docs show no injuries endpoint on any
plan, not independently verified live - no key available). Every rating
this module produces carries an explicit `"injury_factor": None` with
`"pending_factors": ["injury_report"]`. That is NOT the same as scoring
injury impact as zero - HAVOC_WEIGHTS below has no entry for it at all,
so it contributes nothing to the composite rather than silently
contributing a false "no impact" data point. If a real CFB injury source
turns up later, add it to HAVOC_WEIGHTS and _component_scores() together
- don't just start populating the field without also giving it a weight.

This is explicitly a BASELINE: the weights below are a reasonable
starting point, not a validated model. Nothing here has been backtested
against real upset outcomes yet.
"""

import argparse
import json
import os
import sys
from pathlib import Path

try:
    import requests
except ImportError:
    print("This script requires the 'requests' library. Install with:")
    print("  pip install requests")
    sys.exit(1)

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent.parent))  # repo root, for core/
from team_norm import norm as norm_team
import config as cfb_config

DATA_DIR = Path(__file__).parent.parent.parent / "data" / "cfb" / "seasons"

# Relative importance of each AVAILABLE component. Renormalized over
# whatever components are actually present for a given game (e.g. an
# unranked-vs-unranked game has no rank-gap components at all, so those
# weights are dropped and the rest scaled up) - these don't need to sum
# to 1. No "injury_factor" key here on purpose - see module docstring.
HAVOC_WEIGHTS = {
    "powerswap_rank_gap": 0.35,
    "ap_rank_gap": 0.25,
    "vegas_closeness": 0.25,
    "moneyline_closeness": 0.10,
    "over_under": 0.05,
}


def get_api_key() -> str:
    key = os.environ.get("CFBD_API_KEY")
    if not key:
        print("ERROR: CFBD_API_KEY environment variable is not set.")
        print("Get a free key at https://collegefootballdata.com/key")
        print('Then: export CFBD_API_KEY="your_key_here"')
        sys.exit(1)
    return key


def cfbd_get(endpoint: str, params: dict) -> list | dict:
    headers = {"Authorization": f"Bearer {get_api_key()}"}
    resp = requests.get(f"{cfb_config.API_BASE_URL}{endpoint}", headers=headers, params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()


def fetch_ap_poll(season: int, week: int) -> dict[str, int]:
    """
    Real-world AP Top 25 for a given week, as {team: rank}. Same
    /rankings endpoint and POLL_NAME lookup fetch_results.py's
    preseason-only fetch_preseason_poll() uses, generalized to any week.
    Returns {} if CFBD has no AP poll for that week yet (expected for a
    week whose games haven't finished - the AP doesn't publish a new
    poll until they have), NOT an error.
    """
    data = cfbd_get("/rankings", {"year": season, "seasonType": "regular", "week": week})
    for week_block in data:
        for poll in week_block.get("polls", []):
            if poll.get("poll") == cfb_config.POLL_NAME:
                return {norm_team(r["school"]): r["rank"] for r in poll["ranks"]}
    return {}


def get_powerswap_ranks(season: int) -> dict[str, int]:
    """
    Latest PowerSwap snapshot's ranks, as {team: rank}. "Latest" (not
    "as of the requested week") is deliberate, same convention as
    fetch_week1_matchups.py: the real use case is rating an UPCOMING
    week's games against current standings, and there is no future
    snapshot to look up yet.
    """
    path = DATA_DIR / str(season) / "season_history.json"
    if not path.exists():
        raise FileNotFoundError(
            f"Missing {path}. Run fetch_results.py --preseason-poll and "
            f"backtest.py for this season first."
        )
    with open(path) as f:
        data = json.load(f)
    latest = data["snapshots"][-1]
    return {slot["team"]: slot["rank"] for slot in latest["rankings"]}


def _implied_prob(moneyline: float) -> float:
    if moneyline < 0:
        return -moneyline / (-moneyline + 100)
    return 100 / (moneyline + 100)


def _average_lines(lines: list[dict]) -> dict:
    """
    Simple mean across providers for whichever fields are present - a
    baseline choice, not a sharp-book-weighted model. Moneylines are
    converted to implied probabilities and rescaled to sum to 1, which
    removes the bookmaker's vig by brute-force proportional scaling, not
    a true no-vig model - fine for a baseline, not a betting tool.
    """
    spreads = [abs(l["spread"]) for l in lines if l.get("spread") is not None]
    ous = [l["over_under"] for l in lines if l.get("over_under") is not None]
    home_probs, away_probs = [], []
    for l in lines:
        hm, am = l.get("home_moneyline"), l.get("away_moneyline")
        if hm is None or am is None:
            continue
        hp, ap = _implied_prob(hm), _implied_prob(am)
        total = hp + ap
        if total <= 0:
            continue
        home_probs.append(hp / total)
        away_probs.append(ap / total)

    return {
        "avg_abs_spread": sum(spreads) / len(spreads) if spreads else None,
        "avg_over_under": sum(ous) / len(ous) if ous else None,
        "avg_home_implied_prob": sum(home_probs) / len(home_probs) if home_probs else None,
        "avg_away_implied_prob": sum(away_probs) / len(away_probs) if away_probs else None,
    }


def _component_scores(game: dict, powerswap_ranks: dict, ap_ranks: dict) -> tuple[dict, dict]:
    home, away = game["home_team"], game["away_team"]
    avg = _average_lines(game["lines"])
    components = {}

    ps_home, ps_away = powerswap_ranks.get(home), powerswap_ranks.get(away)
    if ps_home is not None and ps_away is not None:
        # Magnitude signal: bigger gap -> higher score. See module docstring.
        components["powerswap_rank_gap"] = min(abs(ps_home - ps_away), 24) / 24

    ap_home, ap_away = ap_ranks.get(home), ap_ranks.get(away)
    if ap_home is not None and ap_away is not None:
        components["ap_rank_gap"] = min(abs(ap_home - ap_away), 24) / 24

    if avg["avg_abs_spread"] is not None:
        # Likelihood signal: smaller spread -> higher score. 35 points is
        # a wide-blowout-line ceiling, not a hard cap on real spreads.
        components["vegas_closeness"] = 1 - min(avg["avg_abs_spread"], 35) / 35

    if avg["avg_home_implied_prob"] is not None:
        favorite_prob = max(avg["avg_home_implied_prob"], avg["avg_away_implied_prob"])
        # 0.5 (pick 'em) -> 1.0; 1.0 (lock) -> 0.0.
        components["moneyline_closeness"] = 1 - (favorite_prob - 0.5) / 0.5

    if avg["avg_over_under"] is not None:
        # Weak, exploratory signal only - see module docstring.
        components["over_under"] = min(avg["avg_over_under"], 80) / 80

    return components, avg


def compute_havoc_rating(game: dict, powerswap_ranks: dict, ap_ranks: dict) -> dict:
    home, away = game["home_team"], game["away_team"]
    components, avg = _component_scores(game, powerswap_ranks, ap_ranks)

    # Rule 4 (README): "Unranked vs unranked. No effect, not tracked." A
    # game where NEITHER team currently holds a PowerSwap rank slot can
    # never produce a swap or a dethrone, no matter how competitive Vegas
    # thinks it is - so it isn't "havoc" in this project's sense at all,
    # regardless of how close vegas_closeness/moneyline_closeness/
    # over_under look. Without this gate, a competitive-but-irrelevant
    # unranked game can outscore the week's one real ranked matchup on
    # likelihood signals alone. components/raw_averages are still
    # returned for transparency - only the composite score is withheld.
    not_swap_eligible = home not in powerswap_ranks and away not in powerswap_ranks

    used_weights = {k: HAVOC_WEIGHTS[k] for k in components if k in HAVOC_WEIGHTS}
    total_weight = sum(used_weights.values())
    if not_swap_eligible or total_weight <= 0:
        rating = None
    else:
        rating = 100 * sum(components[k] * used_weights[k] for k in used_weights) / total_weight

    return {
        "home_team": home,
        "away_team": away,
        "havoc_rating": round(rating, 1) if rating is not None else None,
        "not_swap_eligible": not_swap_eligible,
        "components": {k: round(v, 3) for k, v in components.items()},
        "raw_averages": avg,
        "injury_factor": None,
        "pending_factors": ["injury_report"],
    }


def compute_week_havoc_ratings(season: int, week: int) -> list[dict]:
    lines_path = DATA_DIR / str(season) / "raw" / f"week_{week:02d}_lines.json"
    if not lines_path.exists():
        raise FileNotFoundError(
            f"Missing {lines_path}. Run fetch_lines.py --season {season} --week {week} first."
        )
    with open(lines_path) as f:
        lines_data = json.load(f)

    powerswap_ranks = get_powerswap_ranks(season)
    ap_ranks = fetch_ap_poll(season, week)
    if not ap_ranks:
        print(f"  No AP poll found for {season} week {week} yet - ap_rank_gap will be omitted for every game.")

    return [compute_havoc_rating(g, powerswap_ranks, ap_ranks) for g in lines_data["games"]]


def save_json(data: dict, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Wrote {path}")


def main():
    parser = argparse.ArgumentParser(description="Compute baseline Havoc Ratings for a CFB week")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, required=True)
    args = parser.parse_args()

    ratings = compute_week_havoc_ratings(args.season, args.week)
    ratings.sort(key=lambda r: (r["havoc_rating"] is None, -(r["havoc_rating"] or 0)))
    save_json(
        {"season": args.season, "week": args.week, "games": ratings},
        DATA_DIR / str(args.season) / "raw" / f"week_{args.week:02d}_havoc_ratings.json",
    )


if __name__ == "__main__":
    main()
