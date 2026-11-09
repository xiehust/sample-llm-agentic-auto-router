"""Step 1 (design §3): offline tier pass on the DeepSWE v1.1 tasks and the B simulation. Stdlib only; run with -I.

  python3 -I experiments/deepswe-harbor/tierpass.py bodies --tasks-dir <deep-swe clone>/tasks [--harbor-dir <harbor clone>]
  python3 -I experiments/deepswe-harbor/tierpass.py cards --region <r>   # build and check the cards, no model calls
  python3 -I experiments/deepswe-harbor/tierpass.py live --region <r> --rep 1 [--cap-usd 0.15]   # repeat with --rep 2, 3
  python3 -I experiments/deepswe-harbor/tierpass.py simulate --trials <trials.json>
  python3 -I experiments/deepswe-harbor/tierpass.py strata    # pre-registered live-report strata -> results/tierpass/strata.json

The task repo is untrusted data: this script only reads `instruction.md` and the Dockerfile's WORKDIR as
text, and never runs anything from it. Bodies, tiers and the ledger go to results/ (gitignored): bodies carry task text,
the other files carry task ids, codes and numbers only.

Bodies: Harbor's installed Codex agent runs `codex exec ... -- <instruction>`, where the instruction is instruction.md
with leading canary lines stripped (harbor.models.task.task.strip_canary). The session-start body is the Codex
capture from the R2E experiment (experiments/codex-deepswe, Codex 0.166.0: instructions, developer messages, tools,
environment context) with the cwd set to the task's WORKDIR and the R2E prompt message replaced by the instruction.
"""
from __future__ import annotations

import argparse
import copy
import datetime
import hashlib
import itertools
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
RESULTS = HERE / 'results'
OUT = RESULTS / 'tierpass'      # --set v1 (the default); --set <name> uses results/tierpass-<name>/
STRATA = RESULTS / 'tierpass' / 'strata.json'   # the one pre-registered strata file the live report reads
LEDGER = RESULTS / 'ledger.json'
LEDGER_CAP_USD = 0.50          # approved by the parent session for step 1
CALL_MARGIN_USD = 0.005        # tierpass.ts may pass its cap by one call (≈ $0.0007)
R2E_TEMPLATE = REPO / 'experiments/codex-deepswe/results/capture/template-B.json'
R2E_CAPTURE_D6 = REPO / 'experiments/codex-deepswe/results/capture/d6-B.json'
PLACEHOLDER = '@@LLMAR_TASK_ISSUE@@'
DEADLINE_MS = 5000             # deployed ROUTER_ASSESSOR_TIMEOUT_MS
TASK_ID = re.compile(r'^[a-z0-9][a-z0-9._-]{0,99}$')

# Router tier → the public-data model that stands in for ours (we run gpt-6 Luna, gpt-6.1 Sol, gpt-6 Astra).
PUBLIC = {'fast': 'gpt-5-6-luna', 'standard': 'gpt-5-6-sol', 'frontier': 'gpt-6-astra'}
DEFAULT_TIER = 'standard'      # policy.experiment pool default: no opinion → Sol
EFFORT = 'high'


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')


def read_json(p: pathlib.Path) -> Any:
    return json.loads(p.read_text(encoding='utf-8'))


def write_json(p: pathlib.Path, obj: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + '.tmp')
    tmp.write_text(json.dumps(obj, indent=1, sort_keys=False) + '\n', encoding='utf-8')
    tmp.replace(p)


def read_jsonl(p: pathlib.Path) -> list[dict[str, Any]]:
    return [json.loads(x) for x in p.read_text(encoding='utf-8').splitlines() if x.strip()]


# ---------------------------------------------------------------- bodies

_CANARY_LINE = re.compile(r'^(<!--.*canary.*-->|#.*canary.*)$', re.IGNORECASE)


def strip_canary(text: str) -> str:
    """Same as Harbor's strip_canary: drop leading canary comment lines and the blank lines after them."""
    lines = text.split('\n')
    i = 0
    while i < len(lines) and _CANARY_LINE.match(lines[i].strip()):
        i += 1
    while i < len(lines) and lines[i].strip() == '':
        i += 1
    return '\n'.join(lines[i:])


def workdir_of(dockerfile: pathlib.Path) -> str:
    wd = '/'
    for line in dockerfile.read_text(encoding='utf-8', errors='replace').splitlines():
        m = re.match(r'^\s*WORKDIR\s+(\S+)\s*$', line)
        if m and m.group(1).startswith('/'):
            wd = m.group(1)
    return wd


def _walk(x: Any, fn) -> Any:
    if isinstance(x, str):
        return fn(x)
    if isinstance(x, list):
        return [_walk(v, fn) for v in x]
    if isinstance(x, dict):
        return {k: _walk(v, fn) for k, v in x.items()}
    return x


def task_body(tmpl: dict[str, Any], instruction: str, workdir: str) -> dict[str, Any]:
    """The template with the cwd set to the task's workdir and the prompt message's text replaced by the instruction."""
    body = _walk(copy.deepcopy(tmpl), lambda s: s.replace('/testbed', workdir))
    hits = 0
    for item in body['input']:
        if item.get('type') == 'message' and item.get('role') == 'user':
            for c in item['content']:
                if PLACEHOLDER in c.get('text', ''):
                    c['text'] = instruction
                    hits += 1
    if hits != 1:
        raise ValueError(f'expected one prompt placeholder in the template, found {hits}')
    return body


def git_head(d: pathlib.Path) -> str | None:
    try:
        return subprocess.run(['git', '-C', str(d), 'rev-parse', 'HEAD'], capture_output=True, text=True,  # nosec B603 B607
                              check=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def captured_template(body: dict[str, Any], instruction: str) -> dict[str, Any]:
    """A live first request (Harbor's Codex, captured against a mock upstream) as a template: the user message whose
    text is that task's instruction becomes the placeholder. Its cwd is already the task WORKDIR (/app)."""
    tmpl = copy.deepcopy(body)
    hits = 0
    for item in tmpl.get('input', []):
        if item.get('type') == 'message' and item.get('role') == 'user':
            for c in item.get('content', []):
                if c.get('text', '').strip() == instruction.strip():
                    c['text'] = PLACEHOLDER
                    hits += 1
    if hits != 1:
        raise ValueError(f'the captured body must contain the captured task\'s instruction exactly once, found {hits}')
    return tmpl


def cmd_bodies(a: argparse.Namespace) -> None:
    tasks_dir = pathlib.Path(a.tasks_dir).resolve()
    if a.captured_body:
        if not a.captured_task or not TASK_ID.match(a.captured_task):
            sys.exit('--captured-body needs --captured-task <id>')
        cap = pathlib.Path(a.captured_body)
        tmpl = captured_template(read_json(cap),
                                 strip_canary((tasks_dir / a.captured_task / 'instruction.md').read_text(encoding='utf-8')))
        tmpl_src, d6 = cap, {'codex_version': a.codex_version}
    else:
        tmpl, tmpl_src = read_json(R2E_TEMPLATE), R2E_TEMPLATE
        d6 = read_json(R2E_CAPTURE_D6) if R2E_CAPTURE_D6.exists() else {}
    OUT.mkdir(parents=True, exist_ok=True)
    rows, lens, wds = [], [], Counter()
    for d in sorted(p for p in tasks_dir.iterdir() if p.is_dir()):
        if not (d / 'instruction.md').is_file():
            continue
        if not TASK_ID.match(d.name):
            sys.exit(f'unexpected task directory name: {d.name!r}')
        instruction = strip_canary((d / 'instruction.md').read_text(encoding='utf-8'))
        wd = workdir_of(d / 'environment' / 'Dockerfile') if (d / 'environment' / 'Dockerfile').is_file() else '/'
        wds[wd] += 1
        lens.append(len(instruction))
        rows.append({'task_id': d.name, 'body': task_body(tmpl, instruction, wd)})
    with open(OUT / 'bodies.jsonl', 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r) + '\n')
    source = {
        'schema': 'deepswe-harbor-tierpass-source/v1', 'created': now_iso(), 'n_tasks': len(rows),
        'deep_swe_commit': git_head(tasks_dir.parent),
        'harbor_commit': git_head(pathlib.Path(a.harbor_dir).resolve()) if a.harbor_dir else None,
        'codex_capture': {'source': 'harbor-live' if a.captured_body else 'r2e-0.166.0', 'captured_task': a.captured_task,
                          'version': d6.get('codex_version'), 'template_sha256': hashlib.sha256(tmpl_src.read_bytes()).hexdigest()[:16],
                          'tools': d6.get('tools') or [t.get('name') or t.get('type') for t in tmpl.get('tools', [])],
                          'input_roles': d6.get('input_roles') or [f"{i.get('type')}:{i.get('role')}" for i in tmpl.get('input', [])]},
        'workdirs': dict(wds),
        'instruction_chars': {'min': min(lens), 'median': statistics.median(lens), 'max': max(lens),
                              'over_card_limit_4000': sum(1 for x in lens if x > 4000)},
    }
    write_json(OUT / 'source.json', source)
    print(json.dumps(source, indent=1))


# ---------------------------------------------------------------- ledger + live

def ledger() -> dict[str, Any]:
    if LEDGER.exists():
        return read_json(LEDGER)
    return {'schema': 'deepswe-harbor-ledger/v1', 'created': now_iso(), 'caps': {'step1_tierpass': LEDGER_CAP_USD}, 'charges': []}


def spent(led: dict[str, Any], what: str) -> float:
    return sum(c['usd'] for c in led['charges'] if c['what'] == what)


def run_tierpass(region: str, out: pathlib.Path, live: bool, cap_usd: float) -> subprocess.CompletedProcess:
    argv = ['node', str(HERE / 'tierpass.ts'), '--region', region, '--deadline-ms', str(DEADLINE_MS),
            '--bodies', str(OUT / 'bodies.jsonl'), '--out', str(out), '--cap-usd', f'{cap_usd:.4f}']
    if live:
        argv += ['--live', '--expect-account-env', 'LLMAR_SPIKE_ACCOUNT']
    return subprocess.run(argv, capture_output=True, text=True, cwd=REPO, timeout=3600)  # nosec B603 B607


def cmd_cards(a: argparse.Namespace) -> None:
    p = run_tierpass(a.region, OUT / 'cards.jsonl', False, 0.0)
    sys.stderr.write(p.stderr[-3000:])
    if p.returncode != 0:
        sys.exit(f'card build failed ({p.returncode})')
    rows = read_jsonl(OUT / 'cards.jsonl')
    est = [r['est_prompt_tokens'] for r in rows]
    print(json.dumps({'cards': len(rows), 'est_prompt_tokens_median': statistics.median(est),
                      'latest_truncated': sum(1 for r in rows if r['latest_truncated']), 'tools': Counter(r['tools'] for r in rows)}))


def cmd_live(a: argparse.Namespace) -> None:
    led = ledger()
    remaining = led['caps']['step1_tierpass'] - spent(led, 'step1_tierpass')
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
        rows = read_jsonl(out) if out.exists() else []
        usd = sum(float(r.get('cost_usd') or 0.0) for r in rows)
        ok = p is not None and p.returncode == 0
        led['charges'].append({'at': now_iso(), 'what': 'step1_tierpass', 'usd': round(usd, 6), 'rows': len(rows),
                               'note': f'assessor tier pass r{a.rep} (Luna, pack v2.1, autoRules all)' + ('' if ok else ' (incomplete)')})
        write_json(LEDGER, led)
    sys.stderr.write(p.stderr[-3000:])
    if p.returncode != 0:
        sys.exit(f'tierpass failed ({p.returncode})')
    print(p.stdout.strip().splitlines()[-1])
    print(f'ledger: ${spent(led, "step1_tierpass"):.4f} of ${led["caps"]["step1_tierpass"]:.2f}')


# ---------------------------------------------------------------- simulation

def public_outcomes(trials_path: pathlib.Path) -> dict[str, dict[str, list[dict[str, Any]]]]:
    """task → public model → its scored attempts at high effort, in attempt order (run_attempt, else start time)."""
    data = read_json(trials_path)
    by: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    models = set(PUBLIC.values())
    for r in data['rows']:
        if r.get('reasoning_effort') != EFFORT or r.get('model') not in models or r.get('source') != 'deep-swe':
            continue
        by[r['task_name']][r['model']].append(r)
    for t in by.values():
        for m, rs in t.items():
            rs.sort(key=lambda r: (r.get('run_attempt') or 0, r.get('started_at') or ''))
    return by


def scored(rs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [r for r in rs if r.get('included_in_score')]


def mean_pass(rs: list[dict[str, Any]]) -> float:
    s = scored(rs)
    return sum(1.0 for r in s if r.get('passed')) / len(s) if s else float('nan')


def mean_cost(rs: list[dict[str, Any]]) -> float:
    s = scored(rs)
    return sum(float(r.get('cost_usd') or 0.0) for r in s) / len(s) if s else float('nan')


def policy_score(choice: dict[str, str], by, tasks: list[str], attempts: slice | None = None) -> tuple[float, float]:
    """(pass rate over tasks, Σ per-task mean cost) for a task → model choice, on the given attempt slice."""
    p = c = 0.0
    for t in tasks:
        rs = by[t][choice[t]] if attempts is None else by[t][choice[t]][attempts]
        p += mean_pass(rs)
        c += mean_cost(rs)
    return p / len(tasks), c


def oracle_choice(by, tasks: list[str], attempts: slice) -> dict[str, str]:
    """Per task: the model with the best pass rate on these attempts; ties → the cheaper one on these attempts."""
    out = {}
    for t in tasks:
        out[t] = min(PUBLIC.values(), key=lambda m: (-mean_pass(by[t][m][attempts]), mean_cost(by[t][m][attempts])))
    return out


def solver_class(by, t: str) -> str:
    """Which model the task needs, from the 4-attempt means: luna-ok (Luna ≥ Sol), sol (Sol > Luna, Sol ≥ Astra),
    astra (Astra > Sol), none (no model ever passes)."""
    pl, ps, pa = (mean_pass(by[t][PUBLIC[k]]) for k in ('fast', 'standard', 'frontier'))
    if max(pl, ps, pa) == 0:
        return 'none'
    if pa > ps and pa > pl:
        return 'astra'
    if pl >= ps:
        return 'luna-ok'
    return 'sol'


def bootstrap(per_task: dict[str, list[float]], stat, n: int = 10_000, seed: int = 7) -> tuple[float, float]:
    """95% percentile CI of stat(resampled columns) over a task bootstrap (tasks resampled with replacement)."""
    rnd = random.Random(seed)
    cols = list(per_task.values())
    k = len(cols[0])
    out = []
    for _ in range(n):
        idx = [rnd.randrange(k) for _ in range(k)]
        out.append(stat([[c[i] for i in idx] for c in cols]))
    out.sort()
    return out[int(0.025 * n)], out[int(0.975 * n) - 1]


def pct(xs: list[float], q: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, int(round(q * (len(xs) - 1)))))]


def opinion(r: dict[str, Any], key: str) -> str:
    v = r.get(key)
    return v if v in PUBLIC else 'none'


def cmd_simulate(a: argparse.Namespace) -> None:
    reps = sorted(OUT.glob('tiers-r*.jsonl'), key=lambda p: int(p.stem.split('-r')[1]))
    if not reps:
        sys.exit('no tiers-r*.jsonl; run `live --rep 1` first')
    runs = [{r['task_id']: r for r in read_jsonl(p)} for p in reps]
    by = public_outcomes(pathlib.Path(a.trials))
    ids = set(runs[0]).intersection(*runs[1:])
    tasks = sorted(t for t in ids if t in by and all(len(scored(by[t][m])) > 0 for m in PUBLIC.values()))
    res: dict[str, Any] = {
        'schema': 'deepswe-harbor-tierpass-sim/v2', 'created': now_iso(), 'n_tasks': len(tasks), 'reps': [p.name for p in reps],
        'tasks_without_public_data': sorted(ids - set(tasks)), 'effort': EFFORT, 'map': PUBLIC, 'no_opinion': DEFAULT_TIER,
        'deadline_ms': DEADLINE_MS,
        'scoring': 'per-task expected pass = mean of the scored public attempts (4; one Sol task has 3), cost = mean '
                   'cost of those attempts; a policy\'s pass rate = mean over tasks, its cost = sum over tasks (one pass of the task set)',
    }

    # ---- assessor: tier mix, stability, latency, cost (per rep)
    per_rep = []
    for i, run in enumerate(runs):
        rows = [run[t] for t in tasks]
        lat = [float(r['latency_ms']) for r in rows]
        conf = [r['confidence'] for r in rows if isinstance(r.get('confidence'), (int, float))]
        per_rep.append({
            'rep': reps[i].name, 'pred_tier': dict(Counter(opinion(r, 'pred_tier') for r in rows)),
            'pred_tier_untimed': dict(Counter(opinion(r, 'pred_tier_untimed') for r in rows)),
            'outcome': dict(Counter(str(r.get('outcome')) for r in rows)), 'status': dict(Counter(r.get('status') for r in rows)),
            'basis': dict(Counter(b for r in rows for b in r.get('basis') or [])),
            'confidence_median': statistics.median(conf) if conf else None,
            'latency_ms': {'p50': pct(lat, .5), 'p90': pct(lat, .9), 'p95': pct(lat, .95), 'max': max(lat),
                           'over_1500': sum(1 for x in lat if x > 1500), 'over_5000': sum(1 for x in lat if x > DEADLINE_MS)},
            'cost_usd': round(sum(float(r.get('cost_usd') or 0) for r in rows), 6),
        })
    res['assessor'] = per_rep
    first = [runs[0][t] for t in tasks]
    res['card'] = {'est_prompt_tokens_median': statistics.median(r['est_prompt_tokens'] for r in first),
                   'latest_chars_median': statistics.median(r['latest_chars'] for r in first),
                   'latest_truncated': sum(1 for r in first if r.get('latest_truncated'))}
    seqs = {t: [opinion(run[t], 'pred_tier_untimed') for run in runs] for t in tasks}
    pairs = [(i, j) for i in range(len(runs)) for j in range(i + 1, len(runs))]
    res['stability'] = {
        'all_reps_agree': sum(1 for s in seqs.values() if len(set(s)) == 1),
        'pairwise_agreement': round(statistics.mean(sum(1 for t in tasks if seqs[t][i] == seqs[t][j]) / len(tasks) for i, j in pairs), 4) if pairs else None,
        'patterns': dict(Counter('/'.join(s) for s in seqs.values() if len(set(s)) > 1)),
        'mode': dict(Counter(Counter(s).most_common(1)[0][0] for s in seqs.values())),
    }

    # ---- policies, scored with per-task expected pass/cost over all public attempts
    def per_task(choice: dict[str, str]) -> tuple[list[float], list[float]]:
        return [mean_pass(by[t][choice[t]]) for t in tasks], [mean_cost(by[t][choice[t]]) for t in tasks]

    def tiered(run: dict[str, dict[str, Any]], key: str) -> dict[str, str]:
        return {t: PUBLIC[opinion(run[t], key) if opinion(run[t], key) != 'none' else DEFAULT_TIER] for t in tasks}

    fixed = {'always_luna': {t: PUBLIC['fast'] for t in tasks}, 'always_sol': {t: PUBLIC['standard'] for t in tasks},
             'always_astra': {t: PUBLIC['frontier'] for t in tasks}}
    sims = {f'B_sim_{reps[i].stem.split("-")[1]}': tiered(run, 'pred_tier') for i, run in enumerate(runs)}
    sims.update({f'B_sim_untimed_{reps[i].stem.split("-")[1]}': tiered(run, 'pred_tier_untimed') for i, run in enumerate(runs)})
    modes = {t: Counter(seqs[t]).most_common(1)[0][0] for t in tasks}
    sims['B_sim_mode_untimed'] = {t: PUBLIC[modes[t] if modes[t] != 'none' else DEFAULT_TIER] for t in tasks}
    pol: dict[str, Any] = {}
    cols: dict[str, tuple[list[float], list[float]]] = {}
    for name, ch in {**fixed, **sims}.items():
        ps, cs = per_task(ch)
        cols[name] = (ps, cs)
        pol[name] = {'pass_rate': round(sum(ps) / len(tasks), 4), 'cost_usd_per_pass': round(sum(cs), 2), 'model_mix': dict(Counter(ch.values()))}
    # B (each rep, timed) against each fixed arm: paired over tasks, task-bootstrap 95% CIs.
    for name in [k for k in sims if not k.startswith('B_sim_untimed')]:
        bp, bc = cols[name]
        cmp = {}
        for ref in fixed:
            rp, rc = cols[ref]
            lo, hi = bootstrap({'b': bp, 'r': rp}, lambda c: (sum(c[0]) - sum(c[1])) / len(c[0]))
            clo, chi = bootstrap({'b': bc, 'r': rc}, lambda c: sum(c[0]) / sum(c[1]))
            cmp[ref] = {'pass_diff_pp': round(100 * (sum(bp) - sum(rp)) / len(tasks), 2), 'pass_ci95_pp': [round(100 * lo, 2), round(100 * hi, 2)],
                        'cost_ratio': round(sum(bc) / sum(rc), 3), 'cost_ratio_ci95': [round(clo, 3), round(chi, 3)]}
        pol[name]['vs'] = cmp
        lo, hi = bootstrap({'b': bp}, lambda c: sum(c[0]) / len(c[0]))
        pol[name]['pass_ci95'] = [round(lo, 4), round(hi, 4)]
    for ref in fixed:
        lo, hi = bootstrap({'r': cols[ref][0]}, lambda c: sum(c[0]) / len(c[0]))
        pol[ref]['pass_ci95'] = [round(lo, 4), round(hi, 4)]

    # Oracles. Held-out: choose on 2 attempts, score on the other 2 (both directions, mean). In-sample: choose and
    # score on all 4 attempts; INFLATED (it picks each task's luckiest model on the very draws it is scored on).
    h1, h2 = slice(0, 2), slice(2, 4)
    o = []
    for sel, ev in ((h1, h2), (h2, h1)):
        ch = oracle_choice(by, tasks, sel)
        p, c = policy_score(ch, by, tasks, ev)
        o.append((p, c, Counter(ch.values())))
    pol['oracle_heldout'] = {'pass_rate': round((o[0][0] + o[1][0]) / 2, 4), 'cost_usd_per_pass': round((o[0][1] + o[1][1]) / 2, 2),
                             'splits': [{'pass_rate': round(p, 4), 'cost_usd_per_pass': round(c, 2), 'model_mix': dict(m)} for p, c, m in o]}
    # The same over all 6 ways to split 4 attempts 2/2 (less dependent on attempt order).
    six = []
    for sel in itertools.combinations(range(4), 2):
        ev = [i for i in range(4) if i not in sel]
        pick = lambda rs, idx: [rs[i] for i in idx if i < len(rs)]  # noqa: E731
        ch = {t: min(PUBLIC.values(), key=lambda m: (-mean_pass(pick(by[t][m], sel)), mean_cost(pick(by[t][m], sel)))) for t in tasks}
        six.append((sum(mean_pass(pick(by[t][ch[t]], ev)) for t in tasks) / len(tasks), sum(mean_cost(pick(by[t][ch[t]], ev)) for t in tasks)))
    pol['oracle_heldout']['all_6_splits'] = {'pass_rate': round(statistics.mean(x for x, _ in six), 4),
                                             'cost_usd_per_pass': round(statistics.mean(y for _, y in six), 2)}
    ideal = {t: min(PUBLIC.values(), key=lambda m: (-mean_pass(by[t][m]), mean_cost(by[t][m]))) for t in tasks}
    p, c = policy_score(ideal, by, tasks)
    pol['oracle_insample_INFLATED'] = {'pass_rate': round(p, 4), 'cost_usd_per_pass': round(c, 2), 'model_mix': dict(Counter(ideal.values()))}
    # The fixed arms and B on the same held-out halves, like-for-like with the held-out oracle.
    for name in [*fixed, 'B_sim_r1']:
        hs = [policy_score(({**fixed, **sims})[name], by, tasks, ev) for ev in (h2, h1)]
        pol[name]['heldout_halves'] = {'pass_rate': round(sum(x for x, _ in hs) / 2, 4), 'cost_usd_per_pass': round(sum(y for _, y in hs) / 2, 2)}
    res['policies'] = pol

    # ---- opinions against which model actually solves each task (rep 1, untimed opinion; 4-attempt means)
    cls = {t: solver_class(by, t) for t in tasks}
    res['solver_class'] = dict(Counter(cls.values()))
    xt: dict[str, Counter] = defaultdict(Counter)
    for t in tasks:
        xt[opinion(runs[0][t], 'pred_tier_untimed')][cls[t]] += 1
    res['opinion_vs_solver_r1'] = {k: dict(v) for k, v in sorted(xt.items())}
    by_op: dict[str, Any] = {}
    for tier in ('fast', 'standard', 'frontier', 'none'):
        ts = [t for t in tasks if opinion(runs[0][t], 'pred_tier_untimed') == tier]
        if ts:
            by_op[tier] = {'n': len(ts), 'mean_pass': {m: round(sum(mean_pass(by[t][m]) for t in ts) / len(ts), 4) for m in PUBLIC.values()},
                           'cost_usd': {m: round(sum(mean_cost(by[t][m]) for t in ts), 2) for m in PUBLIC.values()}}
    res['public_by_opinion_r1'] = by_op
    write_json(OUT / 'simulation.json', res)
    print(json.dumps(res, indent=1))


def cmd_strata(a: argparse.Namespace) -> None:
    """Pre-registered strata for the live report (0d): per task, the majority over the tier pass reps of the opinion
    the router would act on (pred_tier: confidence ≥ 0.8 and within the 5 s deadline), with no opinion counted as
    standard (the router serves the pool default then), plus `stable` = the same tier in every rep."""
    reps = sorted(OUT.glob('tiers-r*.jsonl'), key=lambda p: int(p.stem.split('-r')[1]))
    if len(reps) < 3 or len(reps) % 2 == 0:
        sys.exit(f'need an odd number (≥ 3) of tier pass reps, found {len(reps)}')
    runs = [{r['task_id']: r for r in read_jsonl(p)} for p in reps]
    ids = sorted(set(runs[0]).intersection(*runs[1:]))
    if any(set(run) != set(ids) for run in runs):
        sys.exit('the reps do not cover the same tasks')
    tasks = {}
    for t in ids:
        seq = [opinion(run[t], 'pred_tier') for run in runs]
        seq = [DEFAULT_TIER if x == 'none' else x for x in seq]
        tier, n = Counter(seq).most_common(1)[0]
        if n * 2 <= len(seq):
            sys.exit(f'{t}: no majority tier in {seq}')
        tasks[t] = {'stratum': tier, 'stable': len(set(seq)) == 1, 'reps': seq}
    out = {'schema': 'deepswe-harbor-strata/v1', 'created': now_iso(), 'set': OUT.name, 'reps': [p.name for p in reps],
           'definition': 'majority of pred_tier (the opinion within the 5 s deadline, as the router would act on it) over the reps, '
                         'none counted as standard; stable = same tier in every rep',
           'counts': dict(Counter(v['stratum'] for v in tasks.values())),
           'stable': sum(1 for v in tasks.values() if v['stable']),
           'stable_by_stratum': dict(Counter(v['stratum'] for v in tasks.values() if v['stable'])),
           'tasks': tasks}
    path = STRATA
    if path.exists():
        old = read_json(path)
        if old.get('tasks') == tasks:
            print('strata.json unchanged')
            return
        if not a.force:
            sys.exit('strata.json exists with different strata; it is pre-registered (use --force only before the pilot)')
        # Keep the superseded file for the report (strata.v1.json, .v2.json, ...): never overwritten.
        n = 1
        while (path.parent / f'strata.v{n}.json').exists():
            n += 1
        (path.parent / f'strata.v{n}.json').write_text(path.read_text(encoding='utf-8'), encoding='utf-8')
        print(f'kept the previous strata as strata.v{n}.json')
    write_json(path, out)
    print(json.dumps({k: v for k, v in out.items() if k != 'tasks'}, indent=1))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--set', default='v1', help="tier pass set: v1 = results/tierpass (R2E capture shape), else results/tierpass-<set>")
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('bodies')
    p.add_argument('--tasks-dir', required=True)
    p.add_argument('--harbor-dir')
    p.add_argument('--captured-body', help="a live first request (Harbor's Codex, mock upstream) to use as the template")
    p.add_argument('--captured-task', help='the task the captured body came from')
    p.add_argument('--codex-version', help='Codex version of the captured body (recorded in source.json)')
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
    p = sub.add_parser('simulate')
    p.add_argument('--trials', required=True)
    p.set_defaults(fn=cmd_simulate)
    a = ap.parse_args()
    global OUT
    if a.set != 'v1':
        if not re.match(r'^[a-z0-9][a-z0-9-]{0,19}$', a.set):
            sys.exit('--set must be a short lowercase name')
        OUT = RESULTS / f'tierpass-{a.set}'
    a.fn(a)


if __name__ == '__main__':
    main()
