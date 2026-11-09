"""Claude Code × Harbor offline tier pass, Python side (design-assessor.md §3). Stdlib only; run with -I.

  python3 -I experiments/claude-code-harbor/tierpass.py bodies --dataset deepswe|tb21 --tasks-dir <tasks> \
      --captured-body <first main-loop request.json> --captured-task <id> [--captured-workdir /app]
  python3 -I experiments/claude-code-harbor/tierpass.py capture-bodies --dataset deepswe|tb21 --tasks-dir <tasks> \
      --capture <task_id>=<first main-loop request.json> [--capture ...]
  python3 -I experiments/claude-code-harbor/tierpass.py fidelity --template-cards <cards.jsonl> --capture-cards <cards.jsonl>
  python3 -I experiments/claude-code-harbor/tierpass.py summary --calls <label> [--calls <label>] --codex-calls-dir <dir> \
      [--codex-tierpass deepswe=<tiers-r1.jsonl> --codex-tierpass tb21=<tiers-r1.jsonl>] [--cards <cards.jsonl>]

bodies: the first main-loop request of a live Claude Code trial, captured through Harbor's claude-code agent against a
mock upstream (4f's local e2e), becomes a template: the one place that holds the captured task's instruction (a text
block equal to it, or a text block containing it once) becomes the placeholder, and the captured workdir in the system
text is replaced by each task's Dockerfile WORKDIR. Each analysis task's body is the template with its instruction
(instruction.md, canary lines stripped, as Harbor sends it). capture-bodies turns real captures of specific tasks into
the same bodies format, for the fidelity check: their cards must equal the template cards in every field but
stats.estPromptTokens and the per-session billing-header suffix in systemHead. Bodies and cards carry task text and stay in results/ (gitignored). The task repos are untrusted
data: only instruction.md and the Dockerfile's WORKDIR are read, as text.

summary: the gate table for the user (§3.4): per dataset and pack, the call mix, per-task majority, flip rate,
no-opinion reasons, latency and cost; agreement (tiers and facts) with the Codex-card calls of the same pack on the same
tasks; and the session share arm B would serve on Haiku / Sonnet / Opus. Counts and codes only.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import pathlib
import re
import statistics
import sys
import unicodedata
from collections import Counter, defaultdict
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
RESULTS = HERE / 'results'
OUT = RESULTS / 'tierpass'


def _load_dsw() -> Any:
    """deepswe-harbor/tierpass.py (strip_canary, workdir_of, TASK_ID, json helpers), under its own module name: this
    file is also called tierpass, so a plain import would find itself."""
    import importlib.util
    spec = importlib.util.spec_from_file_location('dsw_tierpass', REPO / 'experiments' / 'deepswe-harbor' / 'tierpass.py')
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


dsw = _load_dsw()

PLACEHOLDER = '@@LLMAR_TASK_INSTRUCTION@@'
DATASETS = ('deepswe', 'tb21')
TIERS = ('fast', 'standard', 'frontier', 'none')
ARM = {'fast': 'F (Haiku)', 'standard': 'A (Sonnet)', 'none': 'A (Sonnet)', 'frontier': 'C (Opus)'}
FACTS = ('scope', 'specification', 'reasoning_depth', 'prior_failures', 'edits_code')
# The Codex-card calls of each pack (experiments/assessor-v22/results/calls; v2.2 = v2.2-D content, hash e2183dce2cb9:
# d1a = DeepSWE tune, v22d-eval = DeepSWE held-out + all TB; v2.1 = the v2.1 baseline on all tasks).
CODEX_LABELS = {'v2.2': ('d1a', 'v22d-eval'), 'v2.1': ('v21-base',)}
CODEX_HASH = {'v2.2': 'e2183dce2cb9', 'v2.1': '2696c56a9c6c'}
GATE_MAX_BAD_SHARE = 0.05   # invalid or past-deadline calls (§3.4)


def head_of(instruction: str) -> str:
    return unicodedata.normalize('NFC', instruction).strip()[:60]


# ---------------------------------------------------------------- bodies

def user_text_blocks(body: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for m in body.get('messages', []):
        if isinstance(m, dict) and m.get('role') == 'user' and isinstance(m.get('content'), list):
            out.extend(c for c in m['content'] if isinstance(c, dict) and c.get('type') == 'text' and isinstance(c.get('text'), str))
    return out


def template_of(body: dict[str, Any], instruction: str) -> tuple[dict[str, Any], str]:
    """The captured body with its instruction replaced by the placeholder; returns (template, 'block' | 'joined')."""
    tmpl = copy.deepcopy(body)
    if any(isinstance(m, dict) and m.get('role') == 'user' and isinstance(m.get('content'), str) for m in tmpl.get('messages', [])):
        raise ValueError('a user message has string content; expected text blocks (check the capture)')
    blocks = user_text_blocks(tmpl)
    exact = [c for c in blocks if c['text'].strip() == instruction.strip()]
    if len(exact) == 1:
        exact[0]['text'] = PLACEHOLDER
        return tmpl, 'block'
    inner = [c for c in blocks if instruction.strip() in c['text']]
    if len(exact) == 0 and len(inner) == 1 and inner[0]['text'].count(instruction.strip()) == 1:
        inner[0]['text'] = inner[0]['text'].replace(instruction.strip(), PLACEHOLDER)
        return tmpl, 'joined'
    raise ValueError(f'the captured instruction must occur exactly once in the user text blocks (exact {len(exact)}, inside {len(inner)})')


def system_text_blocks(body: dict[str, Any]) -> list[dict[str, Any]]:
    """Text blocks of `system` and of `system`-role messages (Claude Code 2.1 sends its environment block, with the
    cwd, as a system-role message after the prompt)."""
    out = [c for c in (body.get('system') if isinstance(body.get('system'), list) else [])
           if isinstance(c, dict) and isinstance(c.get('text'), str)]
    for m in body.get('messages', []):
        if isinstance(m, dict) and m.get('role') == 'system' and isinstance(m.get('content'), list):
            out.extend(c for c in m['content'] if isinstance(c, dict) and isinstance(c.get('text'), str))
    return out


def set_workdir(body: dict[str, Any], old: str, new: str) -> int:
    """Replaces the captured workdir in the system text (path-boundary match); returns the replacement count."""
    if old == new:
        return 0
    pat = re.compile(rf'(?<![\w/.-]){re.escape(old.rstrip("/"))}(?![\w.-])')
    n = 0
    for c in system_text_blocks(body):
        c['text'], k = pat.subn(new.rstrip('/') or '/', c['text'])
        n += k
    if isinstance(body.get('system'), str):
        body['system'], k = pat.subn(new.rstrip('/') or '/', body['system'])
        n += k
    return n


def task_body(tmpl: dict[str, Any], instruction: str) -> dict[str, Any]:
    body = copy.deepcopy(tmpl)
    hits = 0
    for c in user_text_blocks(body):
        if PLACEHOLDER in c['text']:
            c['text'] = c['text'].replace(PLACEHOLDER, instruction)
            hits += 1
    if hits != 1:
        raise ValueError(f'expected one placeholder, found {hits}')
    return body


def instruction_of(tasks_dir: pathlib.Path, tid: str) -> tuple[str, str]:
    d = tasks_dir / tid
    instruction = dsw.strip_canary((d / 'instruction.md').read_text(encoding='utf-8'))
    df = d / 'environment' / 'Dockerfile'
    return instruction, (dsw.workdir_of(df) if df.is_file() else '/')


def cmd_bodies(a: argparse.Namespace) -> None:
    tasks_dir = pathlib.Path(a.tasks_dir).resolve()
    if not dsw.TASK_ID.match(a.captured_task):
        sys.exit('bad --captured-task')
    cap_instruction, _ = instruction_of(tasks_dir, a.captured_task)
    tmpl, form = template_of(dsw.read_json(pathlib.Path(a.captured_body)), cap_instruction)
    rows, wds, subs, lens = [], Counter(), Counter(), []
    for d in sorted(p for p in tasks_dir.iterdir() if p.is_dir() and (p / 'instruction.md').is_file()):
        if not dsw.TASK_ID.match(d.name):
            sys.exit(f'unexpected task directory name: {d.name!r}')
        instruction, wd = instruction_of(tasks_dir, d.name)
        body = task_body(tmpl, instruction)
        subs[set_workdir(body, a.captured_workdir, wd)] += 1
        wds[wd] += 1
        lens.append(len(instruction))
        rows.append({'dataset': a.dataset, 'task_id': d.name, 'instruction_head': head_of(instruction), 'body': body})
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f'bodies-{a.dataset}.jsonl'
    out.write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')
    source = {
        'schema': 'claude-code-harbor-tierpass-source/v1', 'created': dsw.now_iso(), 'dataset': a.dataset, 'n_tasks': len(rows),
        'tasks_commit': dsw.git_head(tasks_dir.parent), 'captured_task': a.captured_task, 'instruction_form': form,
        'template_sha256': dsw.hashlib.sha256(json.dumps(tmpl, sort_keys=True).encode()).hexdigest()[:16],
        'tools': [t.get('name') for t in tmpl.get('tools', []) if isinstance(t, dict)],
        'system_blocks': len(tmpl['system']) if isinstance(tmpl.get('system'), list) else 1,
        'user_text_blocks': len(user_text_blocks(tmpl)), 'workdirs': dict(wds),
        'workdir_replacements': {str(k): v for k, v in sorted(subs.items())},
        'instruction_chars': {'min': min(lens), 'median': statistics.median(lens), 'max': max(lens),
                              'over_card_limit_4000': sum(1 for x in lens if x > 4000)},
    }
    dsw.write_json(OUT / f'source-{a.dataset}.json', source)
    print(json.dumps(source, indent=1))


def cmd_capture_bodies(a: argparse.Namespace) -> None:
    tasks_dir = pathlib.Path(a.tasks_dir).resolve()
    rows = []
    for spec in a.capture:
        tid, _, path = spec.partition('=')
        if not dsw.TASK_ID.match(tid) or not path:
            sys.exit(f'bad --capture {spec!r} (want <task_id>=<file>)')
        instruction, _ = instruction_of(tasks_dir, tid)
        body = dsw.read_json(pathlib.Path(path))
        template_of(body, instruction)  # the capture must hold its task's instruction exactly once
        rows.append({'dataset': a.dataset, 'task_id': tid, 'instruction_head': head_of(instruction), 'body': body})
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f'capture-bodies-{a.dataset}.jsonl'
    out.write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')
    print(json.dumps({'dataset': a.dataset, 'captures': len(rows), 'out': out.name}))


# ---------------------------------------------------------------- fidelity

# Claude Code 2.1 puts `x-anthropic-billing-header: cc_version=<version>.<3 hex>; …` in system block 0, inside
# systemHead. The suffix differs per session (it follows the first message), so a real capture and its template body
# cannot agree on it; fidelity compares systemHead with the suffix masked (same length, so role.chars still compares).
BILLING_SUFFIX = re.compile(r'(cc_version=[0-9][0-9.]*\.)[0-9a-f]{3}(?=;)')


def masked(card: dict[str, Any]) -> dict[str, Any]:
    c = copy.deepcopy(card)
    if isinstance(c.get('role'), dict) and isinstance(c['role'].get('systemHead'), str):
        c['role']['systemHead'] = BILLING_SUFFIX.sub(r'\1xxx', c['role']['systemHead'])
    return c


def cmd_fidelity(a: argparse.Namespace) -> None:
    tmpl = {(r['dataset'], r['task_id']): r['card'] for r in dsw.read_jsonl(pathlib.Path(a.template_cards))}
    caps = dsw.read_jsonl(pathlib.Path(a.capture_cards))
    out, ok = [], True
    for r in caps:
        key = (r['dataset'], r['task_id'])
        t = tmpl.get(key)
        if t is None:
            sys.exit(f'{key}: no template card')
        c = masked(r['card'])
        t2 = masked(t)
        ratio = c['stats']['estPromptTokens'] / t2['stats']['estPromptTokens'] if t2['stats']['estPromptTokens'] else None
        c['stats'].pop('estPromptTokens'); t2['stats'].pop('estPromptTokens')
        diff = sorted(k for k in set(c) | set(t2) if c.get(k) != t2.get(k))
        ok &= not diff
        out.append({'dataset': key[0], 'task_id': key[1], 'identical_except_est_tokens': not diff, 'differing_fields': diff,
                    'est_tokens_ratio_capture_over_template': round(ratio, 3) if ratio else None})
    res = {'schema': 'claude-code-harbor-fidelity/v1', 'created': dsw.now_iso(), 'pass': ok, 'cards': out}
    dsw.write_json(OUT / 'fidelity.json', res)
    print(json.dumps(res, indent=1))
    if not ok:
        sys.exit(1)


# ---------------------------------------------------------------- summary

def calls_of(d: pathlib.Path, labels: tuple[str, ...] | list[str]) -> list[dict[str, Any]]:
    rows = []
    for lab in labels:
        ld = d / lab
        if not ld.is_dir():
            sys.exit(f'no calls for {lab} under {d}')
        rows.extend(r for f in sorted(ld.glob('r*.jsonl')) for r in dsw.read_jsonl(f))
    return rows


def majority(calls: list[str]) -> str:
    c = Counter(calls).most_common()
    return c[0][0] if len(c) == 1 or c[0][1] > c[1][1] else 'mixed'


def kappa(pairs: list[tuple[str, str]]) -> float | None:
    if not pairs:
        return None
    n = len(pairs)
    po = sum(a == b for a, b in pairs) / n
    ca, cb = Counter(a for a, _ in pairs), Counter(b for _, b in pairs)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / (n * n)
    return round((po - pe) / (1 - pe), 3) if pe < 1 else None


def pct(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, int(q * len(s)))]


def per_task(rows: list[dict[str, Any]], ds: str) -> dict[str, list[dict[str, Any]]]:
    by: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        if r['dataset'] == ds:
            by[r['task_id']].append(r)
    return by


def modal_fact(rs: list[dict[str, Any]], k: str) -> str:
    return majority([str((r.get('facts') or {}).get(k, 'none')) for r in rs])


def summarize(cc_rows: list[dict[str, Any]], codex_rows: list[dict[str, Any]], ds: str) -> dict[str, Any]:
    cc, cx = per_task(cc_rows, ds), per_task(codex_rows, ds)
    tasks = sorted(cc)
    calls = [r for t in tasks for r in cc[t]]
    tier = lambda r: r.get('pred') if r.get('pred') in TIERS else 'none'  # noqa: E731
    bad = sum(1 for r in calls if r.get('status') != 'ok' or not r.get('within_deadline'))
    none_why = Counter(('unavailable:' + str(r.get('reason'))) if r.get('status') != 'ok' else
                       ('past-deadline' if not r.get('within_deadline') else str(r.get('outcome')))
                       for r in calls if tier(r) == 'none')
    maj = {t: majority([tier(r) for r in cc[t]]) for t in tasks}
    both = [t for t in tasks if t in cx]
    cx_maj = {t: majority([tier(r) for r in cx[t]]) for t in both}
    pairs = [(cx_maj[t], maj[t]) for t in both]
    xt: dict[str, Counter] = defaultdict(Counter)
    for a, b in pairs:
        xt[a][b] += 1
    top = max(Counter(maj.values()).values()) / len(tasks) if tasks else 0
    facts = {}
    for k in FACTS:
        fp = [(modal_fact(cx[t], k), modal_fact(cc[t], k)) for t in both]
        fx: dict[str, Counter] = defaultdict(Counter)
        for a, b in fp:
            fx[a][b] += 1
        facts[k] = {'agreement': round(sum(a == b for a, b in fp) / len(fp), 3) if fp else None, 'kappa': kappa(fp),
                    'codex_x_claude_code': {a: dict(v) for a, v in sorted(fx.items())}}
    arm = Counter()
    for t in tasks:
        for r in cc[t]:
            arm[ARM[tier(r)]] += 1 / len(cc[t])
    lat = [float(r['latency_ms']) for r in calls if isinstance(r.get('latency_ms'), (int, float))]
    return {
        'tasks': len(tasks), 'calls': len(calls), 'calls_per_task': sorted({len(cc[t]) for t in tasks}),
        'call_mix': {k: Counter(tier(r) for r in calls)[k] for k in TIERS},
        'task_majority': dict(Counter(maj.values())),
        'flip_rate': round(sum(1 for t in tasks if len({tier(r) for r in cc[t]}) > 1) / len(tasks), 3) if tasks else None,
        'no_opinion_reasons': dict(none_why),
        'bad_calls': bad, 'bad_share': round(bad / len(calls), 4) if calls else None,
        'latency_ms': {'p50': pct(lat, 0.5), 'p95': pct(lat, 0.95), 'max': max(lat) if lat else None},
        'cost_usd': round(sum(float(r.get('cost_usd') or 0) for r in calls), 4),
        'vs_codex': {'tasks_both': len(both), 'majority_agreement': round(sum(a == b for a, b in pairs) / len(pairs), 3) if pairs else None,
                     'kappa': kappa(pairs), 'kappa_degenerate': top > 0.9,
                     'codex_x_claude_code': {a: dict(v) for a, v in sorted(xt.items())},
                     'codex_call_mix': dict(Counter(tier(r) for t in both for r in cx[t]))},
        'facts_vs_codex': facts,
        'arm_b_session_share': {k: round(v / len(tasks), 3) for k, v in sorted(arm.items())} if tasks else {},
    }


def cut_rates(cards: pathlib.Path | None, codex_tierpass: dict[str, pathlib.Path]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if cards:
        by = Counter(); cut = Counter()
        for r in dsw.read_jsonl(cards):
            by[r['dataset']] += 1
            cut[r['dataset']] += 'chars' in r['card']['latestUser']
        out['claude_code'] = {ds: {'cards': by[ds], 'latest_user_cut': cut[ds]} for ds in by}
    for ds, f in codex_tierpass.items():
        rows = dsw.read_jsonl(f)
        out.setdefault('codex', {})[ds] = {'cards': len(rows), 'latest_user_cut': sum(1 for r in rows if r.get('latest_truncated'))}
    return out


def cmd_summary(a: argparse.Namespace) -> None:
    codex_dir = pathlib.Path(a.codex_calls_dir).resolve()
    res: dict[str, Any] = {'schema': 'claude-code-harbor-tierpass-summary/v1', 'created': dsw.now_iso(), 'packs': {}}
    gate_ok = True
    for lab in a.calls:
        meta = dsw.read_json(RESULTS / 'calls' / lab / 'meta.json')
        pack = meta['pack']
        if pack not in CODEX_LABELS:
            sys.exit(f'{lab}: pack {pack} has no Codex-card calls to compare with')
        if not meta['packVersion'].endswith(CODEX_HASH[pack]):
            sys.exit(f'{lab}: pack version {meta["packVersion"]} is not the {pack} prompt the Codex calls used ({CODEX_HASH[pack]})')
        cc_rows = calls_of(RESULTS / 'calls', [lab])
        cx_rows = calls_of(codex_dir, CODEX_LABELS[pack])
        per = {ds: summarize(cc_rows, cx_rows, ds) for ds in DATASETS if any(r['dataset'] == ds for r in cc_rows)}
        for s in per.values():
            gate_ok &= (s['bad_share'] or 0) <= GATE_MAX_BAD_SHARE
        res['packs'][pack] = {'label': lab, 'packVersion': meta['packVersion'], 'codex_labels': list(CODEX_LABELS[pack]), 'datasets': per}
    tp = {}
    for spec in a.codex_tierpass or []:
        ds, _, f = spec.partition('=')
        tp[ds] = pathlib.Path(f)
    res['latest_user_cut'] = cut_rates(pathlib.Path(a.cards) if a.cards else None, tp)
    res['gate'] = {'pass': gate_ok, 'rule': f'invalid or past-deadline calls ≤ {GATE_MAX_BAD_SHARE:.0%} per dataset and pack; card checks passed in tierpass.ts'}
    OUT.mkdir(parents=True, exist_ok=True)
    dsw.write_json(OUT / 'summary.json', res)
    for pack, p in res['packs'].items():
        for ds, s in p['datasets'].items():
            mix = ' '.join(f'{k} {s["call_mix"][k]}' for k in TIERS)
            arm = ', '.join(f'{k} {v:.0%}' for k, v in s['arm_b_session_share'].items())
            print(f'{pack} {ds}: {s["tasks"]} tasks / {s["calls"]} calls | {mix} | flip {s["flip_rate"]:.0%} | bad {s["bad_share"]:.1%} | '
                  f'p95 {s["latency_ms"]["p95"]} ms | ${s["cost_usd"]:.3f} | vs Codex majority agree {s["vs_codex"]["majority_agreement"]} | B: {arm}')
    print(f'gate: {"PASS" if gate_ok else "FAIL"}')
    if not gate_ok:
        sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    b = sub.add_parser('bodies')
    b.add_argument('--dataset', required=True, choices=DATASETS)
    b.add_argument('--tasks-dir', required=True)
    b.add_argument('--captured-body', required=True)
    b.add_argument('--captured-task', required=True)
    b.add_argument('--captured-workdir', default='/app')
    c = sub.add_parser('capture-bodies')
    c.add_argument('--dataset', required=True, choices=DATASETS)
    c.add_argument('--tasks-dir', required=True)
    c.add_argument('--capture', action='append', required=True)
    f = sub.add_parser('fidelity')
    f.add_argument('--template-cards', required=True)
    f.add_argument('--capture-cards', required=True)
    s = sub.add_parser('summary')
    s.add_argument('--calls', action='append', required=True)
    s.add_argument('--codex-calls-dir', required=True)
    s.add_argument('--codex-tierpass', action='append')
    s.add_argument('--cards')
    a = ap.parse_args()
    {'bodies': cmd_bodies, 'capture-bodies': cmd_capture_bodies, 'fidelity': cmd_fidelity, 'summary': cmd_summary}[a.cmd](a)


if __name__ == '__main__':
    main()
