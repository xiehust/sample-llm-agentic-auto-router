# /// script
# requires-python = "==3.12.*"
# dependencies = ["pyarrow==21.0.0", "boto3==1.40.70"]
# ///
"""Codex x DeepSWE (R2E-Gym) experiment harness. See README.md for the order of steps.

  uv run experiments/codex-deepswe/cli.py <command> [options]

Offline (no AWS, no Docker): fetch-dataset, fetch-codex, candidates, capture, tierpass-bodies, tierpass (cards only),
select, pack, ledger, join-logs, report.
Runner (Docker, no model calls): validate, net-check, cleanup.
Live (model calls, ledger-capped): tierpass --live, run --phase pilot|main|repeat.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import pathlib
import platform
import shutil
import subprocess  # nosec B404 - fixed argv lists only
import sys
import tarfile
import tempfile
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import capture  # noqa: E402
import codex_setup  # noqa: E402
import dataset  # noqa: E402
import selection  # noqa: E402
import common  # noqa: E402
from common import BIN, CANDIDATES, DATASET, RESULTS, SEED, SELECTIONS, read_json, read_jsonl, sha256_file, write_json  # noqa: E402

TIERPASS_DIR = RESULTS / 'tierpass'
CAPTURE_DIR = RESULTS / 'capture'
VALIDATION_DIR = RESULTS / 'validation'


def _arch() -> str:
    m = platform.machine()
    return 'x86_64' if m in ('x86_64', 'AMD64') else 'aarch64' if m in ('aarch64', 'arm64') else m


def codex_path(arch: str | None = None) -> pathlib.Path:
    return BIN / f"codex-{codex_setup.CODEX['version']}-{arch or _arch()}"


def verified_codex(arch: str) -> pathlib.Path:
    p = codex_path(arch)
    if not p.exists():
        sys.exit(f'{p} missing: run `cli.py fetch-codex --arch {arch}`')
    want = read_json(p.with_suffix('.sha256.json'))['binary_sha256']
    if sha256_file(p) != want:
        sys.exit(f'{p}: sha256 changed since fetch-codex')
    return p


# ---------------------------------------------------------------- offline

def cmd_fetch_dataset(_: argparse.Namespace) -> None:
    for p in dataset.fetch():
        print('ok', p.name)


def cmd_fetch_codex(a: argparse.Namespace) -> None:
    asset = codex_setup.CODEX['assets'][a.arch]
    url = f"https://github.com/openai/codex/releases/download/{codex_setup.CODEX['tag']}/{asset['name']}"
    BIN.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=BIN) as td:
        tgz = pathlib.Path(td) / asset['name']
        with urllib.request.urlopen(url, timeout=600) as r, open(tgz, 'wb') as f:  # nosec B310 - fixed https URL
            shutil.copyfileobj(r, f)
        got = sha256_file(tgz)
        if got != asset['sha256']:
            sys.exit(f"{asset['name']}: sha256 {got} != pinned {asset['sha256']}")
        with tarfile.open(tgz) as t:
            m = t.getmember(asset['member'])
            if not m.isfile():
                sys.exit('unexpected archive member')
            src = t.extractfile(m)
            dest = codex_path(a.arch)
            with open(dest, 'wb') as f:
                shutil.copyfileobj(src, f)  # type: ignore[arg-type]
        dest.chmod(0o755)
        write_json(dest.with_suffix('.sha256.json'), {'asset': asset['name'], 'asset_sha256': got, 'binary_sha256': sha256_file(dest),
                                                      'version': codex_setup.CODEX['version']})
    print('ok', dest)


def cmd_candidates(a: argparse.Namespace) -> None:
    tasks = dataset.load()
    ids = selection.candidates([t.task_id for t in tasks], a.n, a.seed)
    by = {t.task_id: t for t in tasks}
    from collections import Counter
    write_json(CANDIDATES, {
        'schema': 'codex-deepswe-candidates/v1', 'seed': a.seed, 'n': len(ids),
        'dataset': {k: DATASET[k] for k in ('repo', 'revision', 'license')},
        'population': {'n': len(tasks), 'by_repo': dict(sorted(Counter(t.repo for t in tasks).items())),
                       'by_size': dict(sorted(Counter(t.size for t in tasks).items()))},
        'sample': {'by_repo': dict(sorted(Counter(by[i].repo for i in ids).items())),
                   'by_size': dict(sorted(Counter(by[i].size for i in ids).items()))},
        'ids': ids,
    })
    print(f'{len(ids)} candidates -> {CANDIDATES.relative_to(HERE)}')


def cmd_capture(a: argparse.Namespace) -> None:
    """Pinned Codex against a loopback mock, inside `unshare -rn` (no network at all). Writes the template and D6."""
    binary = verified_codex(_arch())
    CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        work = pathlib.Path(td)
        inner = [sys.executable, '-I', str(HERE / 'cli.py'), '_capture-inner', str(binary), str(work), a.arm]
        script = '/usr/sbin/ip link set lo up && exec "$@"'
        p = subprocess.run(['unshare', '-rn', '/bin/sh', '-c', script, 'sh', *inner], capture_output=True, text=True, timeout=600)  # nosec B603 B607
        if p.returncode != 0:
            sys.exit(f'capture failed: {p.stderr[-2000:]}')
        out = json.loads((work / 'capture.json').read_text())
    body = capture.first_responses_body(out['records'])
    tmpl = capture.template(body, out['cwd'])
    write_json(CAPTURE_DIR / f'template-{a.arm}.json', tmpl)
    d6 = {
        'codex_version': codex_setup.CODEX['version'], 'arch': _arch(), 'exit_code': out['exit_code'],
        'settings': codex_setup.CODEX_SETTINGS, 'provider': codex_setup.PROVIDER_SETTINGS,
        'requests': [(r['method'], r['path'].split('/v1/', 1)[-1]) for r in out['records']],
        'request_headers': sorted(out['records'][0]['headers']),
        'body_keys': sorted(body), 'reasoning': body.get('reasoning'), 'include': body.get('include'),
        'store': body.get('store'), 'tools': [t.get('name') or t.get('type') for t in body.get('tools', [])],
        'input_roles': [f"{i.get('type')}:{i.get('role')}" for i in body.get('input', [])],
        'instructions_chars': len(body.get('instructions') or ''),
        'warnings': [json.loads(x)['item'].get('message') for x in out['stdout'].splitlines()
                     if x.startswith('{') and '"type":"error"' in x][:5],
    }
    write_json(CAPTURE_DIR / f'd6-{a.arm}.json', d6)
    print(json.dumps(d6, indent=1))


def cmd_capture_inner(a: argparse.Namespace) -> None:
    out = capture.run_capture(pathlib.Path(a.binary), pathlib.Path(a.work), arm=a.arm)
    (pathlib.Path(a.work) / 'capture.json').write_text(json.dumps(out))


def cmd_tierpass_bodies(a: argparse.Namespace) -> None:
    import r2e
    tmpl = read_json(CAPTURE_DIR / 'template-B.json')
    ids = set(read_json(CANDIDATES)['ids'])
    TIERPASS_DIR.mkdir(parents=True, exist_ok=True)
    out = TIERPASS_DIR / 'bodies.jsonl'
    n = 0
    with open(out, 'w', encoding='utf-8') as f:
        for t in sorted(dataset.load(full=True, ids=ids), key=lambda t: t.task_id):
            f.write(json.dumps({'task_id': t.task_id, 'body': capture.task_body(tmpl, r2e.task_instruction(t.problem_statement))}) + '\n')
            n += 1
    print(f'{n} bodies -> {out}')


def tierpass_spend(path: pathlib.Path) -> tuple[float, int]:
    """Σ cost_usd over the rows tierpass.ts wrote (each row is appended right after its call), and the row count."""
    rows = list(read_jsonl(path))
    return sum(float(r.get('cost_usd') or 0.0) for r in rows), len(rows)


def cmd_tierpass(a: argparse.Namespace) -> None:
    out = TIERPASS_DIR / ('tiers.jsonl' if a.live else 'cards.jsonl')
    argv = ['node', str(HERE / 'tierpass.ts'), '--region', common.region(), '--deadline-ms', str(a.deadline_ms),
            '--bodies', str(TIERPASS_DIR / 'bodies.jsonl'),
            '--out', str(out), '--cap-usd', str(a.cap_usd)]
    led = None
    if a.live:
        from ledger import Ledger
        led = Ledger()
        led.check_or_raise('tierpass', a.cap_usd)
        argv.append('--live')
    out.unlink(missing_ok=True)   # review T2: a run that fails before writing can never charge a stale file
    p = None
    try:
        p = subprocess.run(argv, capture_output=True, text=True, cwd=HERE.parents[1])  # nosec B603 B607
    finally:
        # Review T2: charge what the out file says was spent, whatever happened to the process (crash, interrupt).
        if led is not None:
            usd, n = tierpass_spend(out)
            led.charge('tierpass', usd, f'assessor observe pass, {n} rows' + ('' if p and p.returncode == 0 else ' (incomplete)'))
    sys.stderr.write(p.stderr[-3000:])
    if p.returncode != 0:
        sys.exit(f'tierpass failed ({p.returncode})')
    print(p.stdout.strip().splitlines()[-1])


def cmd_select(a: argparse.Namespace) -> None:
    if a.extend:
        prev = read_json(SELECTIONS)
        if prev.get('schema') != 'codex-deepswe-selection/v2':
            sys.exit(f"--extend needs the validated v2 selection, found {prev.get('schema')}")
        sel = selection.extend(prev, n_main=a.n_main, repo_cap_frac=a.repo_cap_frac, n_repeat=a.n_repeat, repeat_reps=a.repeat_reps)
        write_json(SELECTIONS, sel)
        print(json.dumps({'arms': {k: len(v) for k, v in sel['arms'].items()}, 'repeat': len(sel['repeat']),
                          **{k: sel[k] for k in ('rules', 'kept_from_v2', 'repo_counts', 'size_counts', 'repo_cap_effect', 'pred_tier_counts')},
                          'to_validate': sorted(set(sel['main']) - set(sel['validated']))[:3] + ['…'],
                          'n_to_validate': len(set(sel['main']) | set(sel['pilot'])) - sum(1 for t in set(sel['main']) | set(sel['pilot']) if t in sel['validated'])},
                         indent=1))
        return
    ids = read_json(CANDIDATES)['ids']
    rows = {r['task_id']: r for r in read_jsonl(TIERPASS_DIR / 'tiers.jsonl')}
    tiers = {k: r.get('pred_tier', 'none') for k, r in rows.items()}
    missing = [i for i in ids if i not in tiers]
    if missing and not a.allow_missing:
        sys.exit(f'{len(missing)} candidates have no tier-pass result (use --allow-missing to treat them as none)')
    meta = {t.task_id: t for t in dataset.load(ids=set(ids))}
    cands = [{'task_id': i, 'repo': meta[i].repo, 'size': meta[i].size, 'pred_tier': tiers.get(i, 'none'),
              'pred_tier_untimed': (rows.get(i) or {}).get('pred_tier_untimed', 'none')} for i in ids]
    sel = selection.select(cands, seed=a.seed)
    sel['tierpass'] = tierpass_summary(list(rows.values()))
    write_json(SELECTIONS, sel)
    from collections import Counter
    print(json.dumps({'arms': {k: len(v) for k, v in sel['arms'].items()}, 'pilot': len(sel['pilot']),
                      'main_by_repo': dict(Counter(sel['tasks'][t]['repo'] for t in sel['main'])),
                      'main_by_size': dict(Counter(sel['tasks'][t]['size'] for t in sel['main'])),
                      'tierpass': sel['tierpass']}, indent=1))


RECORDED_DEADLINE_MS = 1500   # the D2 live pass (design §11) judged answers against the router's 1500 ms timeout


def pred_at(row: dict, deadline_ms: int) -> str:
    """The opinion the router acts on at a given assessor timeout: the untimed opinion if it answered in time."""
    lat = row.get('latency_ms')
    return (row.get('pred_tier_untimed') or 'none') if isinstance(lat, (int, float)) and lat <= deadline_ms else 'none'


def tierpass_summary(rows: list[dict], deadlines: tuple[int, ...] = (1500, 5000)) -> dict:
    """Aggregates of the live tier pass (counts and latency quantiles only). `deadlines`: router assessor timeouts to
    recompute the timed opinion at, offline from the same rows (design §13); the deadline the pass itself used is
    pinned as `recorded_deadline_ms` (rows from before the per-row field are the 1500 ms pass)."""
    from collections import Counter
    lat = sorted(float(r['latency_ms']) for r in rows if isinstance(r.get('latency_ms'), (int, float)))

    def q(p: float) -> float | None:
        return lat[min(len(lat) - 1, int(p * (len(lat) - 1) + 0.5))] if lat else None
    recorded = sorted({int(r.get('deadline_ms', RECORDED_DEADLINE_MS)) for r in rows}) or [RECORDED_DEADLINE_MS]
    return {'n': len(rows), 'status': dict(Counter(r.get('status') for r in rows)),
            'recorded_deadline_ms': recorded[0] if len(recorded) == 1 else recorded,
            'pred_tier': dict(sorted(Counter(r.get('pred_tier', 'none') for r in rows).items())),
            'pred_tier_untimed': dict(sorted(Counter(r.get('pred_tier_untimed', 'none') for r in rows).items())),
            'within_deadline': sum(1 for r in rows if r.get('within_router_deadline')),
            'deadlines': {str(d): {'pred_tier': dict(sorted(Counter(pred_at(r, d) for r in rows).items())),
                                   'within': sum(1 for r in rows if isinstance(r.get('latency_ms'), (int, float)) and r['latency_ms'] <= d)}
                          for d in deadlines},
            'latency_ms': {'p10': q(0.1), 'p50': q(0.5), 'p90': q(0.9), 'p95': q(0.95), 'max': lat[-1] if lat else None},
            'cost_usd': round(sum(float(r.get('cost_usd') or 0) for r in rows), 6)}


def cmd_tierpass_summary(a: argparse.Namespace) -> None:
    """Design §13: recomputes the tier-pass summary at several deadlines from the existing rows (no model calls) and
    records pred_tier_<deadline> per task in selections.json (descriptive; the recorded pred_tier is unchanged)."""
    rows = {r['task_id']: r for r in read_jsonl(TIERPASS_DIR / 'tiers.jsonl')}
    deadlines = tuple(int(x) for x in a.deadlines.split(','))
    sel = read_json(SELECTIONS)
    sel['tierpass'] = tierpass_summary(list(rows.values()), deadlines)
    for meta in (sel['tasks'], sel.get('reserve_meta', {})):
        for tid, m in meta.items():
            for d in deadlines:
                if d != RECORDED_DEADLINE_MS and tid in rows:
                    m[f'pred_tier_{d}'] = pred_at(rows[tid], d)
    write_json(SELECTIONS, sel)
    print(json.dumps(sel['tierpass'], indent=1))


# ---------------------------------------------------------------- runner (Docker)

def _env(a: argparse.Namespace):
    import protocol
    from docker_ops import Docker, Limits
    d = Docker(network=a.network)   # review F2: every `docker run` must use exactly this network
    internal = a.network_mode == 'internal'
    net = protocol.Env(d, a.network, Limits(a.cpus, a.memory, a.pids), a.test_timeout)
    info = d.ensure_network(a.network, internal=internal)
    return net, d.gateway_ip(info)


def cmd_validate(a: argparse.Namespace) -> None:
    import protocol
    sel = read_json(SELECTIONS)
    env, _ = _env(a)
    VALIDATION_DIR.mkdir(parents=True, exist_ok=True)
    rounds = 0
    while True:
        rounds += 1
        want = sorted(set(sel['pilot']) | set(sel['main']))
        todo = [t for t in want if not (VALIDATION_DIR / f'{t}.json').exists()]
        if not todo:
            break
        tasks = {t.task_id: t for t in dataset.load(full=True, ids=set(todo))}
        with concurrent.futures.ThreadPoolExecutor(max_workers=a.concurrency) as pool:
            for rec in pool.map(lambda t, ts=tasks: protocol.validate(env, ts[t], VALIDATION_DIR), todo):
                v = rec['verdict']
                sel['validated'][rec['task_id']] = {'ok': v['ok'], 'reasons': v['reasons'], 'f2p': len(rec['spec']['f2p']),
                                                    'p2p': len(rec['spec']['p2p']), 'slowest_s': v['slowest_s']}
                print(rec['task_id'], 'ok' if v['ok'] else f"FAIL {v['reasons']}", flush=True)
                if not v['ok']:
                    new = selection.replace(sel, rec['task_id'], ','.join(v['reasons']))
                    print('  replaced by', new)
                write_json(SELECTIONS, sel)
        if rounds > 20:
            sys.exit('too many replacement rounds')
    sel['validation_summary'] = selection.validation_summary(sel)
    write_json(SELECTIONS, sel)
    print(json.dumps(sel['validation_summary']))
    bad = [t for t in set(sel['pilot']) | set(sel['main']) if not sel['validated'].get(t, {}).get('ok')]
    print(f"validated: {len(sel['main'])} main + {len(sel['pilot'])} pilot; not ok: {bad}")


NETCHECK = r'''
import json, socket, urllib.request, urllib.error, sys
ip, port = sys.argv[1], int(sys.argv[2])
out = {}
try:
    urllib.request.urlopen(f"http://{ip}:{port}/r/netcheck/v1/models", timeout=5); out["proxy"] = "200"
except urllib.error.HTTPError as e:
    out["proxy"] = str(e.code)
except Exception as e:
    out["proxy"] = "unreachable:" + type(e).__name__
for name, addr in (("internet", ("1.1.1.1", 443)), ("imds", ("169.254.169.254", 80)), ("host_other_port", (ip, 22))):
    s = socket.socket(); s.settimeout(5)
    try:
        s.connect(addr); out[name] = "OPEN"
    except Exception as e:
        out[name] = "blocked:" + type(e).__name__
    finally:
        s.close()
try:
    socket.getaddrinfo("example.com", 443); out["dns"] = "RESOLVES"
except Exception as e:
    out["dns"] = "blocked:" + type(e).__name__
print(json.dumps(out))
'''


def cmd_net_check(a: argparse.Namespace) -> None:
    import proxy as px
    env, gw = _env(a)
    sel = read_json(SELECTIONS)
    image = next(t.image for t in dataset.load(ids={sel['pilot'][0]}))
    srv = px.EgressProxy(gw, a.proxy_port, px.Upstreams(None, common.region()), on_call=lambda r: None)
    import threading
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    import protocol
    try:
        res = protocol.net_check(env, image, gw, a.proxy_port, NETCHECK)
    except protocol.StepFailed as e:
        print(json.dumps({'ok': False, 'step': e.step, 'code': e.code, 'stderr_tail': e.stderr_tail, 'stdout_tail': e.stdout_tail}, indent=1))
        sys.exit(f'net-check failed at: {e.step}')
    finally:
        srv.shutdown()
    ok = res.get('proxy') == '404' and all(str(res.get(k, '')).startswith('blocked') for k in ('internet', 'imds', 'dns', 'host_other_port'))
    print(json.dumps({'network': a.network, 'mode': a.network_mode, 'gateway_ip': gw, 'docker': env.docker.version(), **res, 'ok': ok}))
    if not ok:
        sys.exit('net-check failed' + ('' if res.get('proxy') == '404' else ': the proxy is unreachable from the network; try --network-mode bridge'))


def cmd_cleanup(a: argparse.Namespace) -> None:
    from docker_ops import Docker
    d = Docker()
    for n in d.leftovers():
        d.rm(n)
        print('removed', n)


# ---------------------------------------------------------------- live runs

def cmd_run(a: argparse.Namespace) -> None:
    import threading

    import auth
    import proxy as px
    import scheduler
    from ledger import DEFAULT_BUDGETS, Ledger
    if not a.runner_usd_per_hour or a.runner_usd_per_hour <= 0 or a.runner_started_at is None:
        sys.exit('run needs --runner-usd-per-hour > 0 and --runner-started-at (the runner hours count against the cap)')
    sel = read_json(SELECTIONS)
    env, gw = _env(a)
    binary = verified_codex('x86_64')
    planned = scheduler.plan(sel, a.phase, a.seed)
    need = {p.task_id for p in planned}
    tasks = {t.task_id: t for t in dataset.load(full=True, ids=need)}
    budgets = dict(DEFAULT_BUDGETS)
    for kv in a.budget or []:
        k, v = kv.split('=')
        budgets[k] = float(v)
    led = Ledger(budgets=budgets, runner_usd_per_hour=a.runner_usd_per_hour, runner_started_at=a.runner_started_at)
    minter = None
    if any(p.arm != 'D' for p in planned):
        if not a.gateway_url:
            sys.exit('--gateway-url is required for arms A-C')
        minter = auth.TokenMinter(auth.read_secret(common.region(), a.secret_id))
    srv = px.EgressProxy(gw, a.proxy_port, px.Upstreams(a.gateway_url, common.region()), on_call=lambda r: None,
                         strip_body_keys=tuple(a.strip_body_key or ()))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        s = scheduler.Scheduler(env, srv, led, tasks, sel, binary, (lambda: auth.RunToken(minter)) if minter else None,
                                concurrency=a.concurrency, timeout_s=a.timeout_min * 60)
        out = s.run(planned)
    finally:
        srv.shutdown()
    write_json(RESULTS / f'run-{a.phase}-{int(time.time())}.json', out)
    print(json.dumps(out, indent=1))


def cmd_pack(a: argparse.Namespace) -> None:
    import packing
    info = packing.build(pathlib.Path(a.out) if a.out else packing.DEFAULT_OUT)
    print(json.dumps(info))


def cmd_ledger(a: argparse.Namespace) -> None:
    """Prints the ledger. `--charge <phase> <usd> <what>` records a spend made elsewhere (e.g. the tier pass run on the
    dev box, before the runner's ledger existed), so the $200 cap covers it."""
    from ledger import Ledger
    led = Ledger()
    if a.charge:
        phase, usd, what = a.charge
        led.charge(phase, float(usd), what)
    print(json.dumps(led.summary(), indent=1))


def cmd_join_logs(a: argparse.Namespace) -> None:
    import results
    import routerlogs
    rows = list(read_jsonl(RESULTS / 'results.jsonl'))
    recs = []
    for f in a.logs:
        recs += routerlogs.parse(pathlib.Path(f).read_text(errors='replace'))
    gw_calls = {r['run_id']: int((r.get('calls') or {}).get('responses_calls') or 0) - int((r.get('calls') or {}).get('gateway_fallback_calls') or 0)
                for r in results.latest(rows).values() if r['arm'] != 'D'}
    joined = routerlogs.join(recs, gw_calls, gw_calls)
    write_json(RESULTS / 'router_join.json', joined)
    print(json.dumps({'records': len(recs), 'runs_joined': len(joined), 'runs': len(gw_calls),
                      'complete': sum(1 for j in joined.values() if j['complete']),
                      'lineages': routerlogs.unique_lineages(joined)}, indent=1))


def cmd_report(a: argparse.Namespace) -> None:
    import report
    from ledger import Ledger
    rows = list(read_jsonl(RESULTS / 'results.jsonl'))
    join = read_json(RESULTS / 'router_join.json') if (RESULTS / 'router_join.json').exists() else {}
    led = Ledger()
    # Runner hours: instance launch (ledger) to --runner-ended-at (instance stop), else to the last run's end.
    runner = {'started_at': led.data.get('runner_started_at'), 'ended_at': a.runner_ended_at,
              'usd_per_hour': a.runner_usd_per_hour or led.data.get('runner_usd_per_hour')}
    data = report.build(rows, join, read_json(SELECTIONS), led.summary(), n_boot=a.n_boot, runner=runner)
    write_json(RESULTS / 'report-data.json', data)
    md = pathlib.Path(a.out) if a.out else RESULTS / 'report.zh-CN.md'
    md.write_text(report.render(data), encoding='utf-8')
    print('ok', RESULTS / 'report-data.json', md)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--region', default=os.environ.get('AWS_REGION') or os.environ.get('AWS_DEFAULT_REGION'),
                    help='experiment Region (default: AWS_REGION); required by tierpass, net-check and run')
    sub = ap.add_subparsers(dest='cmd', required=True)

    def add(name: str, fn, **kw):
        p = sub.add_parser(name, **kw)
        p.set_defaults(fn=fn)
        return p

    def docker_opts(p: argparse.ArgumentParser) -> None:
        p.add_argument('--network', default='llmar-tasks')
        p.add_argument('--network-mode', choices=('internal', 'bridge'), default='internal',
                       help='internal: --internal network (default); bridge: user-defined bridge (review R3 fallback)')
        p.add_argument('--cpus', default='2')
        p.add_argument('--memory', default='8g')
        p.add_argument('--pids', type=int, default=4096)
        p.add_argument('--test-timeout', type=int, default=600)

    add('fetch-dataset', cmd_fetch_dataset)
    p = add('fetch-codex', cmd_fetch_codex)
    p.add_argument('--arch', choices=('x86_64', 'aarch64'), default=_arch())
    p = add('candidates', cmd_candidates)
    p.add_argument('--n', type=int, default=500)
    p.add_argument('--seed', type=int, default=SEED)
    p = add('capture', cmd_capture)
    p.add_argument('--arm', choices=('A', 'B', 'C', 'D'), default='B')
    p = add('_capture-inner', cmd_capture_inner)
    p.add_argument('binary')
    p.add_argument('work')
    p.add_argument('arm')
    add('tierpass-bodies', cmd_tierpass_bodies)
    p = add('tierpass-summary', cmd_tierpass_summary)
    p.add_argument('--deadlines', default='1500,5000', help='comma-separated router assessor timeouts (ms)')
    p = add('tierpass', cmd_tierpass)
    p.add_argument('--live', action='store_true')
    p.add_argument('--cap-usd', type=float, default=0.6)
    p.add_argument('--deadline-ms', type=int, default=1500, help='router assessor timeout to judge against (recorded per row)')
    p = add('select', cmd_select)
    p.add_argument('--seed', type=int, default=SEED)
    p.add_argument('--allow-missing', action='store_true')
    p.add_argument('--extend', action='store_true', help='design §12: grow the validated v2 selection (keeps its 53 tasks)')
    p.add_argument('--n-main', type=int, default=200)
    p.add_argument('--repo-cap-frac', type=float, default=0.25)
    p.add_argument('--n-repeat', type=int, default=20)
    p.add_argument('--repeat-reps', type=int, default=1, help='extra runs of A and F per repeat task (1 → 540 runs in total)')
    p = add('validate', cmd_validate)
    docker_opts(p)
    p.add_argument('--concurrency', type=int, default=4)
    p = add('net-check', cmd_net_check)
    docker_opts(p)
    p.add_argument('--proxy-port', type=int, default=8088)
    add('cleanup', cmd_cleanup)
    p = add('run', cmd_run)
    docker_opts(p)
    p.add_argument('--phase', choices=('pilot', 'main', 'repeat'), required=True)
    p.add_argument('--gateway-url', help='the router stack output GatewayUrl (https)')
    p.add_argument('--secret-id', default='llmar-runner/client', help='Secrets Manager id of the client secret')
    p.add_argument('--proxy-port', type=int, default=8088)
    p.add_argument('--concurrency', type=int, default=4)
    p.add_argument('--timeout-min', type=int, default=40)
    p.add_argument('--seed', type=int, default=SEED)
    p.add_argument('--budget', action='append', help='per-run budget override, e.g. C=8')
    p.add_argument('--runner-usd-per-hour', type=float, default=0.0)
    p.add_argument('--runner-started-at', type=float, help='instance launch time (epoch seconds)')
    p.add_argument('--strip-body-key', action='append', help='drop a top-level request key before forwarding (off by default)')
    p = add('pack', cmd_pack)
    p.add_argument('--out', help='default: results/llmar-experiment.tar.gz')
    p = add('ledger', cmd_ledger)
    p.add_argument('--charge', nargs=3, metavar=('PHASE', 'USD', 'WHAT'))
    p = add('join-logs', cmd_join_logs)
    p.add_argument('logs', nargs='+')
    p = add('report', cmd_report)
    p.add_argument('--n-boot', type=int, default=10_000)
    p.add_argument('--out')
    p.add_argument('--runner-usd-per-hour', type=float, help='runner instance rate (else the rate stored in the ledger)')
    p.add_argument('--runner-ended-at', type=float, help='instance stop time, epoch seconds (else the last run end)')
    a = ap.parse_args()
    if a.region:
        common.set_region(a.region)
        if a.cmd in NEEDS_REGION and not common.catalog_path().exists():
            sys.exit(f'no bundled price catalog for {a.region} ({common.catalog_path().name}); is this the experiment Region?')
    elif a.cmd in NEEDS_REGION:
        sys.exit(f'{a.cmd} needs --region <region> (or AWS_REGION); there is no default Region')
    os.umask(0o077)
    a.fn(a)


NEEDS_REGION = {'tierpass', 'net-check', 'run'}


if __name__ == '__main__':
    main()
