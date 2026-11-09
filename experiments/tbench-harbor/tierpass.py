"""Step 1 (design §3): offline tier pass on the Terminal-Bench 2.1 tasks. Stdlib only; run with -I.

  python3 -I experiments/tbench-harbor/tierpass.py bodies --tasks-dir <terminal-bench-2-1 clone>/tasks
  python3 -I experiments/tbench-harbor/tierpass.py cards --region <r>          # build and check the cards, no model calls
  python3 -I experiments/tbench-harbor/tierpass.py live --region <r> --rep 1   # then --rep 2, 3
  python3 -I experiments/tbench-harbor/tierpass.py strata                      # pre-registered strata -> results/tierpass/strata.json
  python3 -I experiments/tbench-harbor/tierpass.py summary                     # tier mix, stability, TB difficulty agreement

Same method as experiments/deepswe-harbor/tierpass.py (whose body, ledger and strata helpers this imports, and whose
tierpass.ts does the card build and the assessor calls): Harbor's Codex agent sends `strip_canary(instruction.md)` as
the only user message; the session-start body is the R2E Codex 0.166.0 capture with the cwd set to the task's last
Dockerfile WORKDIR. On DeepSWE the card from a live Harbor first request matched this one except the router's
template family (not part of the card; carddiff-*.json there).

The task repo is untrusted data: this script reads instruction.md, the Dockerfile's WORKDIR lines and task.toml's
[metadata] lines as text and never runs anything from it. Everything goes to results/ (gitignored): bodies.jsonl
carries task text; the other files carry task ids, TB labels, codes and numbers only. There is no public per-task
outcome data for TB 2.1, so there is no simulated B (unlike DeepSWE).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import random
import re
import statistics
import subprocess  # nosec B404 - fixed argv: git rev-parse, node tierpass.ts
import sys
from collections import Counter, defaultdict
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / 'experiments' / 'deepswe-harbor'))
import tierpass as dsw  # noqa: E402  (deepswe-harbor/tierpass.py: bodies, ledger and strata helpers)

RESULTS = HERE / 'results'
OUT = RESULTS / 'tierpass'
STRATA = OUT / 'strata.json'
LEDGER = RESULTS / 'ledger.json'
LEDGER_CAP_USD = 1.00          # approved by the parent session for step 1 (expected ≈ $0.10)
CALL_MARGIN_USD = dsw.CALL_MARGIN_USD
TIER_TS = REPO / 'experiments' / 'deepswe-harbor' / 'tierpass.ts'
DEADLINE_MS = dsw.DEADLINE_MS
DEFAULT_TIER = dsw.DEFAULT_TIER
TIERS = ('fast', 'standard', 'frontier')
DIFFICULTIES = ('easy', 'medium', 'hard')
NAIVE = {'easy': 'fast', 'medium': 'standard', 'hard': 'frontier'}   # a reference mapping, not a ground truth
ONE_PIN_SHARE = 0.90           # flag: B would equal one pinned arm on ≥ this share of tasks
_META_KEYS = ('difficulty', 'category', 'expert_time_estimate_min', 'junior_time_estimate_min')
_LABEL = re.compile(r'^[a-z0-9][a-z0-9 _.-]{0,59}$')


def labels_of(task_toml: pathlib.Path) -> dict[str, Any]:
    """difficulty, category and the time estimates from task.toml's [metadata] table, read as text (no TOML parser
    on 3.9; only flat `key = "str"` / `key = number` lines are taken, and string values must look like labels)."""
    out: dict[str, Any] = {}
    section = None
    for line in task_toml.read_text(encoding='utf-8', errors='replace').splitlines():
        s = line.strip()
        if s.startswith('['):
            section = s.strip('[]').strip()
            continue
        if section != 'metadata':
            continue
        m = re.match(r'^([a-z_]+)\s*=\s*(.+?)\s*$', s)
        if not m or m.group(1) not in _META_KEYS:
            continue
        k, v = m.groups()
        if v.startswith('"') and v.endswith('"') and _LABEL.match(v[1:-1]):
            out[k] = v[1:-1]
        elif re.match(r'^\d+(\.\d+)?$', v):
            out[k] = float(v)
    return out


def cmd_bodies(a: argparse.Namespace) -> None:
    tasks_dir = pathlib.Path(a.tasks_dir).resolve()
    # The R2E capture is gitignored data of experiments/codex-deepswe; a worktree without it passes the main tree's copy.
    cap_dir = pathlib.Path(a.capture_dir).resolve() if a.capture_dir else dsw.R2E_TEMPLATE.parent
    tmpl_path, d6_path = cap_dir / dsw.R2E_TEMPLATE.name, cap_dir / dsw.R2E_CAPTURE_D6.name
    tmpl = dsw.read_json(tmpl_path)
    d6 = dsw.read_json(d6_path) if d6_path.exists() else {}
    OUT.mkdir(parents=True, exist_ok=True)
    rows, lens, wds, labels = [], [], Counter(), {}
    for d in sorted(p for p in tasks_dir.iterdir() if p.is_dir()):
        if not (d / 'instruction.md').is_file():
            continue
        if not dsw.TASK_ID.match(d.name):
            sys.exit(f'unexpected task directory name: {d.name!r}')
        instruction = dsw.strip_canary((d / 'instruction.md').read_text(encoding='utf-8'))
        df = d / 'environment' / 'Dockerfile'
        wd = dsw.workdir_of(df) if df.is_file() else '/'
        wds[wd] += 1
        lens.append(len(instruction))
        labels[d.name] = {**labels_of(d / 'task.toml'), 'instruction_chars': len(instruction), 'workdir': wd}
        rows.append({'task_id': d.name, 'body': dsw.task_body(tmpl, instruction, wd)})
    manifest = (tasks_dir / 'dataset.toml').read_text(encoding='utf-8') if (tasks_dir / 'dataset.toml').is_file() else ''
    listed = set(re.findall(r'^\[\[tasks\]\]\s*\nname\s*=\s*"terminal-bench/([a-z0-9][a-z0-9._-]*)"\s*$', manifest, re.M))
    with open(OUT / 'bodies.jsonl', 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r) + '\n')
    dsw.write_json(OUT / 'labels.json', labels)
    source = {
        'schema': 'tbench-harbor-tierpass-source/v1', 'created': dsw.now_iso(), 'n_tasks': len(rows),
        'tb_commit': dsw.git_head(tasks_dir.parent),
        'manifest_tasks': len(listed), 'dirs_not_in_manifest': sorted(set(labels) - listed),
        'manifest_not_in_dirs': sorted(listed - set(labels)),
        'codex_capture': {'source': 'r2e-0.166.0', 'version': d6.get('codex_version'),
                          'template_sha256': hashlib.sha256(tmpl_path.read_bytes()).hexdigest()[:16],
                          'tools': d6.get('tools') or [t.get('name') or t.get('type') for t in tmpl.get('tools', [])]},
        'workdirs': dict(wds),
        'instruction_chars': {'min': min(lens), 'median': statistics.median(lens), 'max': max(lens),
                              'over_card_limit_4000': sum(1 for x in lens if x > 4000)},
        'difficulty': dict(Counter(v.get('difficulty') for v in labels.values())),
        'category': dict(Counter(v.get('category') for v in labels.values()).most_common()),
    }
    dsw.write_json(OUT / 'source.json', source)
    print(json.dumps(source, indent=1))


# ---------------------------------------------------------------- ledger + live

def ledger() -> dict[str, Any]:
    if LEDGER.exists():
        return dsw.read_json(LEDGER)
    return {'schema': 'tbench-harbor-ledger/v1', 'created': dsw.now_iso(), 'caps': {'step1_tierpass': LEDGER_CAP_USD}, 'charges': []}


def run_tierpass(region: str, out: pathlib.Path, live: bool, cap_usd: float) -> subprocess.CompletedProcess:
    argv = ['node', str(TIER_TS), '--region', region, '--deadline-ms', str(DEADLINE_MS),
            '--bodies', str(OUT / 'bodies.jsonl'), '--out', str(out), '--cap-usd', f'{cap_usd:.4f}']
    if live:
        argv += ['--live', '--expect-account-env', 'LLMAR_SPIKE_ACCOUNT']
    return subprocess.run(argv, capture_output=True, text=True, cwd=REPO, timeout=3600)  # nosec B603 B607


def cmd_cards(a: argparse.Namespace) -> None:
    p = run_tierpass(a.region, OUT / 'cards.jsonl', False, 0.0)
    sys.stderr.write(p.stderr[-3000:])
    if p.returncode != 0:
        sys.exit(f'card build failed ({p.returncode})')
    rows = dsw.read_jsonl(OUT / 'cards.jsonl')
    est = [r['est_prompt_tokens'] for r in rows]
    print(json.dumps({'cards': len(rows), 'est_prompt_tokens_median': statistics.median(est), 'est_prompt_tokens_range': [min(est), max(est)],
                      'latest_truncated': sum(1 for r in rows if r['latest_truncated']), 'tools': Counter(r['tools'] for r in rows)}))


def cmd_live(a: argparse.Namespace) -> None:
    led = ledger()
    remaining = led['caps']['step1_tierpass'] - dsw.spent(led, 'step1_tierpass')
    cap = min(a.cap_usd, remaining - CALL_MARGIN_USD)
    if cap <= 0:
        sys.exit(f'ledger: ${remaining:.4f} left of the step 1 cap; not starting')
    out = OUT / f'tiers-r{a.rep}.jsonl'
    if out.exists():
        sys.exit(f'{out.name} exists; pick another --rep (repeats measure tier stability)')
    p = None
    try:
        p = run_tierpass(a.region, out, True, cap)
    finally:
        rows = dsw.read_jsonl(out) if out.exists() else []
        usd = sum(float(r.get('cost_usd') or 0.0) for r in rows)
        ok = p is not None and p.returncode == 0
        led['charges'].append({'at': dsw.now_iso(), 'what': 'step1_tierpass', 'usd': round(usd, 6), 'rows': len(rows),
                               'note': f'TB 2.1 assessor tier pass r{a.rep} (Luna, pack v2.1, autoRules all)' + ('' if ok else ' (incomplete)')})
        dsw.write_json(LEDGER, led)
    sys.stderr.write(p.stderr[-3000:])
    if p.returncode != 0:
        sys.exit(f'tierpass failed ({p.returncode})')
    print(p.stdout.strip().splitlines()[-1])
    print(f'ledger: ${dsw.spent(led, "step1_tierpass"):.4f} of ${led["caps"]["step1_tierpass"]:.2f}')


# ---------------------------------------------------------------- strata + summary

def load_reps() -> tuple[list[pathlib.Path], list[dict[str, dict[str, Any]]], list[str]]:
    reps = sorted(OUT.glob('tiers-r*.jsonl'), key=lambda p: int(p.stem.split('-r')[1]))
    runs = [{r['task_id']: r for r in dsw.read_jsonl(p)} for p in reps]
    ids = sorted(set(runs[0]).intersection(*runs[1:])) if runs else []
    if any(set(run) != set(ids) for run in runs):
        sys.exit('the reps do not cover the same tasks')
    return reps, runs, ids


def served(r: dict[str, Any], key: str = 'pred_tier') -> str:
    t = dsw.opinion(r, key)
    return DEFAULT_TIER if t == 'none' else t


def cmd_strata(a: argparse.Namespace) -> None:
    """Pre-registered strata for the live report, as on DeepSWE: per task, the majority over the reps of pred_tier
    (confidence ≥ 0.8 and within the 5 s deadline), no opinion counted as standard; stable = same tier in every rep."""
    reps, runs, ids = load_reps()
    if len(reps) < 3 or len(reps) % 2 == 0:
        sys.exit(f'need an odd number (≥ 3) of tier pass reps, found {len(reps)}')
    tasks = {}
    for t in ids:
        seq = [served(run[t]) for run in runs]
        tier, n = Counter(seq).most_common(1)[0]
        if n * 2 <= len(seq):
            sys.exit(f'{t}: no majority tier in {seq}')
        tasks[t] = {'stratum': tier, 'stable': len(set(seq)) == 1, 'reps': seq}
    out = {'schema': 'tbench-harbor-strata/v1', 'created': dsw.now_iso(), 'set': OUT.name, 'reps': [p.name for p in reps],
           'definition': 'majority of pred_tier (the opinion within the 5 s deadline, as the router would act on it) over the reps, '
                         'none counted as standard; stable = same tier in every rep',
           'counts': dict(Counter(v['stratum'] for v in tasks.values())),
           'stable': sum(1 for v in tasks.values() if v['stable']),
           'stable_by_stratum': dict(Counter(v['stratum'] for v in tasks.values() if v['stable'])),
           'tasks': tasks}
    if STRATA.exists():
        old = dsw.read_json(STRATA)
        if old.get('tasks') == tasks:
            print('strata.json unchanged')
            return
        if not a.force:
            sys.exit('strata.json exists with different strata; it is pre-registered (use --force only before the pilot)')
        n = 1
        while (STRATA.parent / f'strata.v{n}.json').exists():
            n += 1
        (STRATA.parent / f'strata.v{n}.json').write_text(STRATA.read_text(encoding='utf-8'), encoding='utf-8')
        print(f'kept the previous strata as strata.v{n}.json')
    dsw.write_json(STRATA, out)
    print(json.dumps({k: v for k, v in out.items() if k != 'tasks'}, indent=1))


def gamma(pairs: list[tuple[int, int]]) -> float | None:
    """Goodman–Kruskal γ between two ordinal codes (ties dropped): +1 = harder TB label ⇒ higher tier, always."""
    c = d = 0
    for i in range(len(pairs)):
        for j in range(i + 1, len(pairs)):
            s = (pairs[i][0] - pairs[j][0]) * (pairs[i][1] - pairs[j][1])
            c += s > 0
            d += s < 0
    return round((c - d) / (c + d), 4) if c + d else None


def boot_ci(items: list, stat, n: int = 2000, seed: int = 20261106) -> list[float] | None:
    """95% task-bootstrap percentile CI of stat(resampled items)."""
    rnd = random.Random(seed)
    vals = sorted(v for v in (stat([items[rnd.randrange(len(items))] for _ in items]) for _ in range(n)) if v is not None)
    return [round(vals[int(0.025 * len(vals))], 4), round(vals[int(0.975 * len(vals)) - 1], 4)] if vals else None


def xtab(ids: list[str], row_of, col_of) -> dict[str, dict[str, int]]:
    xt: dict[str, Counter] = defaultdict(Counter)
    for t in ids:
        xt[row_of(t)][col_of(t)] += 1
    return {k: dict(v) for k, v in sorted(xt.items())}


def cmd_summary(a: argparse.Namespace) -> None:
    reps, runs, ids = load_reps()
    if not runs:
        sys.exit('no tiers-r*.jsonl; run `live --rep 1` first')
    labels = dsw.read_json(OUT / 'labels.json')
    strata = dsw.read_json(STRATA)['tasks'] if STRATA.exists() else None
    diff = {t: labels[t].get('difficulty', 'unknown') for t in ids}
    res: dict[str, Any] = {'schema': 'tbench-harbor-tierpass-summary/v1', 'created': dsw.now_iso(), 'n_tasks': len(ids),
                           'reps': [p.name for p in reps], 'deadline_ms': DEADLINE_MS, 'no_opinion': DEFAULT_TIER,
                           'difficulty': dict(Counter(diff.values()))}
    per_rep = []
    for p, run in zip(reps, runs):
        rows = [run[t] for t in ids]
        lat = [float(r['latency_ms']) for r in rows]
        conf = [r['confidence'] for r in rows if isinstance(r.get('confidence'), (int, float))]
        per_rep.append({
            'rep': p.name, 'pred_tier': dict(Counter(dsw.opinion(r, 'pred_tier') for r in rows)),
            'pred_tier_untimed': dict(Counter(dsw.opinion(r, 'pred_tier_untimed') for r in rows)),
            # Before the threshold: did the model ever answer fast, or did the pack map anything to fast?
            'raw_tier': dict(Counter(str(r.get('tier')) for r in rows)), 'proposed': dict(Counter(str(r.get('proposed')) for r in rows)),
            'outcome': dict(Counter(str(r.get('outcome')) for r in rows)), 'status': dict(Counter(str(r.get('status')) for r in rows)),
            'basis': dict(Counter(b for r in rows for b in r.get('basis') or []).most_common()),
            'confidence': {'median': statistics.median(conf) if conf else None, 'below_0.8': sum(1 for c in conf if c < 0.8)},
            'latency_ms': {'p50': dsw.pct(lat, .5), 'p95': dsw.pct(lat, .95), 'max': max(lat), 'over_5000': sum(1 for x in lat if x > DEADLINE_MS)},
            'cost_usd': round(sum(float(r.get('cost_usd') or 0) for r in rows), 6),
        })
    res['assessor'] = per_rep
    first = [runs[0][t] for t in ids]
    res['card'] = {'est_prompt_tokens_median': statistics.median(r['est_prompt_tokens'] for r in first),
                   'latest_chars_median': statistics.median(r['latest_chars'] for r in first),
                   'latest_truncated': sum(1 for r in first if r.get('latest_truncated'))}
    seqs = {t: [served(run[t]) for run in runs] for t in ids}
    pairs = [(i, j) for i in range(len(runs)) for j in range(i + 1, len(runs))]
    res['stability'] = {
        'all_reps_agree': sum(1 for s in seqs.values() if len(set(s)) == 1),
        'pairwise_agreement': round(statistics.mean(sum(1 for t in ids if seqs[t][i] == seqs[t][j]) / len(ids) for i, j in pairs), 4) if pairs else None,
        'patterns': dict(Counter('/'.join(s) for s in seqs.values() if len(set(s)) > 1)),
    }
    fast_any = sorted({t for run in runs for t in ids if dsw.opinion(run[t], 'pred_tier_untimed') == 'fast' or run[t].get('tier') == 'fast'
                       or run[t].get('proposed') == 'fast'})
    res['fast'] = {'tasks_with_any_fast_signal': len(fast_any), 'pred_tier_fast_calls': sum(1 for run in runs for t in ids if dsw.opinion(run[t], 'pred_tier') == 'fast'),
                   'tasks': fast_any}

    if strata is not None:
        st = {t: strata[t]['stratum'] for t in ids}
        stable = {t for t in ids if strata[t]['stable']}
        top, n_top = Counter(st.values()).most_common(1)[0]
        res['strata'] = {'counts': dict(Counter(st.values())), 'stable': len(stable), 'stable_by_stratum': dict(Counter(st[t] for t in stable)),
                         'largest': top, 'largest_share': round(n_top / len(ids), 4),
                         'flag_B_equals_one_pin': n_top / len(ids) >= ONE_PIN_SHARE}
        rank = {k: i for i, k in enumerate(TIERS)}
        drank = {k: i for i, k in enumerate(DIFFICULTIES)}
        known = [t for t in ids if diff[t] in drank]
        res['vs_difficulty'] = {
            'stratum_x_difficulty': xtab(ids, lambda t: st[t], lambda t: diff[t]),
            'frontier_share_by_difficulty': {d: (round(sum(1 for t in ids if diff[t] == d and st[t] == 'frontier') / n, 4), n)
                                             for d in DIFFICULTIES if (n := sum(1 for t in ids if diff[t] == d))},
            'gamma_stratum_vs_difficulty': gamma([(rank[st[t]], drank[diff[t]]) for t in known]),
            'gamma_ci95': boot_ci([(rank[st[t]], drank[diff[t]]) for t in known], gamma),
            'hard_minus_rest_frontier_share_ci95': boot_ci(
                [(diff[t] == 'hard', st[t] == 'frontier') for t in known],
                lambda xs: (sum(f for h, f in xs if h) / max(1, sum(1 for h, _ in xs if h)))
                - (sum(f for h, f in xs if not h) / max(1, sum(1 for h, _ in xs if not h)))),
            'gamma_stable_tasks': gamma([(rank[st[t]], drank[diff[t]]) for t in known if t in stable]),
            'gamma_per_rep': [gamma([(rank[served(run[t])], drank[diff[t]]) for t in known]) for run in runs],
            'naive_map_agreement': round(sum(1 for t in known if NAIVE[diff[t]] == st[t]) / len(known), 4) if known else None,
            'naive_map': NAIVE,
            'hard_vs_rest_frontier': {'hard': [sum(1 for t in known if diff[t] == 'hard' and st[t] == 'frontier'), sum(1 for t in known if diff[t] == 'hard')],
                                      'easy_or_medium': [sum(1 for t in known if diff[t] != 'hard' and st[t] == 'frontier'), sum(1 for t in known if diff[t] != 'hard')]},
        }
        res['vs_category'] = xtab(ids, lambda t: labels[t].get('category', 'unknown'), lambda t: st[t])
        # The DeepSWE reading was "long specs read as frontier": instruction length and expert time by stratum.
        res['by_stratum'] = {}
        for tier in TIERS:
            ts = [t for t in ids if st[t] == tier]
            if not ts:
                continue
            ex = [labels[t]['expert_time_estimate_min'] for t in ts if isinstance(labels[t].get('expert_time_estimate_min'), float)]
            res['by_stratum'][tier] = {'n': len(ts), 'instruction_chars_median': statistics.median(labels[t]['instruction_chars'] for t in ts),
                                       'expert_min_median': statistics.median(ex) if ex else None}
        lens = sorted(ids, key=lambda t: labels[t]['instruction_chars'])
        k = len(lens)
        terc = {'short': lens[:k // 3], 'mid': lens[k // 3: 2 * k // 3], 'long': lens[2 * k // 3:]}
        res['frontier_share_by_length_tercile'] = {
            name: {'n': len(ts), 'chars': [labels[ts[0]]['instruction_chars'], labels[ts[-1]]['instruction_chars']],
                   'frontier': round(sum(1 for t in ts if st[t] == 'frontier') / len(ts), 4)} for name, ts in terc.items()}
        res['gamma_stratum_vs_length_tercile'] = gamma([(rank[st[t]], i) for i, ts in enumerate(terc.values()) for t in ts])
    dsw.write_json(OUT / 'summary.json', res)
    print(json.dumps(res, indent=1))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('bodies')
    p.add_argument('--tasks-dir', required=True)
    p.add_argument('--capture-dir', help='directory with the R2E template-B.json / d6-B.json (default: experiments/codex-deepswe/results/capture)')
    p.set_defaults(fn=cmd_bodies)
    p = sub.add_parser('cards')
    p.add_argument('--region', required=True)
    p.set_defaults(fn=cmd_cards)
    p = sub.add_parser('live')
    p.add_argument('--region', required=True)
    p.add_argument('--cap-usd', type=float, default=0.15)
    p.add_argument('--rep', type=int, required=True)
    p.set_defaults(fn=cmd_live)
    p = sub.add_parser('strata')
    p.add_argument('--force', action='store_true')
    p.set_defaults(fn=cmd_strata)
    p = sub.add_parser('summary')
    p.set_defaults(fn=cmd_summary)
    a = ap.parse_args()
    a.fn(a)


if __name__ == '__main__':
    main()
