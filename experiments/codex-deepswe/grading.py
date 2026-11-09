"""Grading (design D4).

Primary, SWE-bench style: FAIL_TO_PASS = tests failing on base and passing on gold; PASS_TO_PASS = passing on both;
a run is resolved when every F2P test passes and every P2P test still passes. Tests failing under both are ignored.
Secondary: R2E-Gym strict (r2e.r2e_reward: every expected status matches).

Validation runs base and gold 3x each (fresh container each time); a task whose per-test statuses differ between
repeats is unstable and dropped.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import r2e

PASS = 'PASSED'  # nosec B105: test status constant, not a credential
MISSING = 'MISSING'


def statuses(test_output: str) -> dict[str, str]:
    """Parsed, R2E-normalised statuses for one run_tests output."""
    return r2e.normalize(r2e.parse_log_pytest(r2e.clean(test_output)))


def _consensus(runs: Sequence[dict[str, str]]) -> tuple[dict[str, str], list[str]]:
    """Per-test status when every run agrees (absent from a run counts as MISSING); the list of tests that differ."""
    names = sorted({k for r in runs for k in r if k})
    agreed: dict[str, str] = {}
    unstable: list[str] = []
    for n in names:
        seen = {r.get(n, MISSING) for r in runs}
        if len(seen) == 1:
            agreed[n] = seen.pop()
        else:
            unstable.append(n)
    return agreed, unstable


def derive_spec(base_runs: Sequence[dict[str, str]], gold_runs: Sequence[dict[str, str]]) -> dict[str, Any]:
    """F2P / P2P from repeated base and gold runs. `stable` is False when any test's status differs between repeats."""
    base, ub = _consensus(base_runs)
    gold, ug = _consensus(gold_runs)
    names = sorted(set(base) | set(gold))
    f2p = [n for n in names if base.get(n, MISSING) != PASS and gold.get(n) == PASS]
    p2p = [n for n in names if base.get(n) == PASS and gold.get(n) == PASS]
    p2f = [n for n in names if base.get(n) == PASS and gold.get(n, MISSING) != PASS]
    fail_both = [n for n in names if base.get(n, MISSING) != PASS and gold.get(n, MISSING) != PASS]
    return {
        'stable': not ub and not ug,
        'unstable_base': ub, 'unstable_gold': ug,
        'f2p': f2p, 'p2p': p2p, 'p2f': p2f, 'fail_both': fail_both,
        'n_tests': len(names),
    }


def grade_swebench(parsed: dict[str, str], spec: dict[str, Any]) -> dict[str, Any]:
    f2p_ok = [n for n in spec['f2p'] if parsed.get(n) == PASS]
    p2p_ok = [n for n in spec['p2p'] if parsed.get(n) == PASS]
    resolved = bool(spec['f2p']) and len(f2p_ok) == len(spec['f2p']) and len(p2p_ok) == len(spec['p2p'])
    return {'resolved': resolved, 'f2p_pass': len(f2p_ok), 'f2p_total': len(spec['f2p']),
            'p2p_pass': len(p2p_ok), 'p2p_total': len(spec['p2p'])}


def grade_strict(parsed: dict[str, str], expected_output_json: str) -> bool:
    return r2e.r2e_reward(parsed, expected_output_json) == 1.0


def validation_verdict(spec: dict[str, Any], base_strict: Sequence[bool], gold_strict: Sequence[bool],
                       durations_s: Sequence[float], limit_s: float = 600.0) -> dict[str, Any]:
    """Keep a task only if: statuses are stable over the repeats, F2P is non-empty, the unmodified repo does not
    pass R2E-Gym strict in any run, the gold patch passes it in every run, and no test run exceeded the limit
    (design §4: drop what runs longer than 10 minutes)."""
    reasons = []
    if not spec['stable']:
        reasons.append('unstable')
    if not spec['f2p']:
        reasons.append('no-f2p')
    if any(base_strict):
        reasons.append('base-passes-strict')
    if not all(gold_strict) or not gold_strict:
        reasons.append('gold-fails-strict')
    slowest = max(durations_s) if durations_s else 0.0
    if slowest > limit_s:
        reasons.append('slow')
    return {'ok': not reasons, 'reasons': reasons, 'slowest_s': round(slowest, 1)}
