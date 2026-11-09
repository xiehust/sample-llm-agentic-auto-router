"""Run scheduler (design §5 order, R6): every (task, arm) run of a phase, shuffled with a fixed seed (pilot: fixed
order, most expensive first), concurrency 4.

Per run: reserve the worst case in the ledger (wait while in-flight runs settle; stop when nothing is in flight and
the run still does not fit) → mint a fresh gateway token (arms A–C) → register the proxy route → agent run →
unregister → settle the ledger from the proxy's per-call pricing → grade in a fresh container → append the result
row. Stops on the cap, on `--max-consecutive-errors` harness errors in a row, or when results/STOP exists.
Re-running a phase skips runs that already have a non-error row; a re-run gets a new run id (attempt suffix), so it
never shares router session state with the failed attempt.
"""
from __future__ import annotations

import dataclasses
import pathlib
import random
import shutil
import threading
import time
import uuid
from collections import defaultdict
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from typing import Any

import codex_setup
import protocol
import results
from common import ARM_MODELS, ARM_PIN, RESULTS, append_jsonl, read_json, read_jsonl, write_json
from dataset import Task
from ledger import Ledger, call_margin, worst_model
from proxy import EgressProxy, Route

RESULTS_FILE = RESULTS / 'results.jsonl'
CALLS_FILE = RESULTS / 'calls.jsonl'
STOP_FILE = RESULTS / 'STOP'
MIN_FREE_GB = 30
DOCKER_ROOT = pathlib.Path('/var/lib/docker')


def free_gb(paths: list[pathlib.Path]) -> float:
    """Smallest free space (GB) over the results disk and Docker's data root (when present)."""
    vals = [shutil.disk_usage(p).free / 1e9 for p in paths if p.exists()]
    return min(vals) if vals else float('inf')


@dataclasses.dataclass(frozen=True)
class Planned:
    phase: str
    arm: str
    task_id: str
    rep: int


def plan(sel: dict[str, Any], phase: str, seed: int) -> list[Planned]:
    """Design §11. Pilot: A and F on all 3 pilot tasks, B, C and D on one each (fixed order, most expensive first, so
    the $10 cap is checked against them while little is spent). Main: every arm on its task list, shuffled with the
    seed. Repeat: A and F again on the repeat list, `rules.repeat_reps` more times each (rep 2, 3, …)."""
    if phase == 'pilot':
        pilot = sorted(sel['pilot'])
        runs = [Planned('pilot', a, t, 1) for t in pilot for a in ('A', 'F')]
        runs += [Planned('pilot', a, pilot[i % len(pilot)], 1) for i, a in enumerate(('C', 'B', 'D'))]
        order = {'C': 0, 'B': 1, 'A': 2, 'D': 3, 'F': 4}
        return sorted(runs, key=lambda r: (order[r.arm], r.task_id))
    if phase == 'main':
        runs = [Planned('main', a, t, 1) for a, ids in sorted(sel['arms'].items()) for t in ids]
    elif phase == 'repeat':
        reps = range(2, 2 + int(sel['rules'].get('repeat_reps', 1)))
        runs = [Planned('repeat', a, t, r) for t in sel['repeat'] for a in ('A', 'F') for r in reps]
    else:
        raise ValueError(f'unknown phase {phase}')
    runs.sort(key=lambda r: (r.arm, r.task_id, r.rep))
    random.Random(f'{seed}:{phase}').shuffle(runs)
    return runs


def run_key(p: Planned) -> str:
    """Human-readable key of a planned run (phase/arm/task/rep); several attempts can share it."""
    return f'{p.phase}/{p.arm}/{p.task_id}/r{p.rep}'


def new_run_id() -> str:
    """Random per attempt (uuid4): it is the x-router-session value, so its logged label cannot be guessed, and a
    re-run never shares router state with an earlier attempt."""
    return f'r-{uuid.uuid4().hex}'


class Scheduler:
    def __init__(self, env: protocol.Env, proxy: EgressProxy, ledger: Ledger, tasks: dict[str, Task], sel: dict[str, Any],
                 codex_bin: pathlib.Path, token_factory: Callable[[], Callable[[], str]] | None, concurrency: int = 4,
                 timeout_s: int = 2400, max_consecutive_errors: int = 5, results_dir: pathlib.Path = RESULTS,
                 validation_dir: pathlib.Path | None = None, log: Callable[[str], None] = print, min_free_gb: float = MIN_FREE_GB):
        self.env, self.proxy, self.ledger, self.tasks, self.sel = env, proxy, ledger, tasks, sel
        self.codex_bin, self.token_factory = codex_bin, token_factory
        self.concurrency, self.timeout_s, self.max_err = concurrency, timeout_s, max_consecutive_errors
        self.dir = results_dir
        self.vdir = validation_dir or results_dir / 'validation'
        self.log = log
        self.free_gb = free_gb
        self.min_free_gb = min_free_gb
        self.calls: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.lock = threading.Lock()
        self.consecutive_errors = 0
        self.stop_reason: str | None = None
        proxy.on_call = self._on_call

    def _on_call(self, rec: dict[str, Any]) -> None:
        append_jsonl(self.dir / CALLS_FILE.name, rec)
        with self.lock:
            self.calls[rec['run_id']].append(rec)

    def _spec(self, task_id: str) -> dict[str, Any]:
        p = self.vdir / f'{task_id}.json'
        if not p.exists():
            raise RuntimeError(f'{task_id} has no validation record; run `cli.py validate` first')
        v = read_json(p)
        if not v['verdict']['ok']:
            raise RuntimeError(f'{task_id} failed validation: {v["verdict"]["reasons"]}')
        return {**v['spec'], 'base_rebuild_ok': v.get('base_rebuild_ok')}

    def _attempt(self, p: Planned) -> int:
        """1 + earlier attempts of this run (the ledger has an entry for every attempt, crashed ones included)."""
        k = run_key(p)
        return 1 + sum(1 for v in self.ledger.data['runs'].values() if v.get('key') == k)

    def one(self, p: Planned, rid: str, attempt: int) -> dict[str, Any]:
        """One run. The ledger is always settled from the proxy's records, whatever fails."""
        cs: dict[str, Any] | None = None
        route: Route | None = None
        try:
            task = self.tasks[p.task_id]
            spec = protocol.RunSpec(rid, p.phase, p.arm, task, self.sel['tasks'][p.task_id]['pred_tier'], p.rep, attempt)
            grade_spec = self._spec(p.task_id)
            token = self.token_factory() if p.arm != 'D' and self.token_factory else None
            route = Route(run_id=rid, arm=p.arm, kind='bedrock' if p.arm == 'D' else 'gateway',
                          hint=f'pin={ARM_PIN[p.arm]}' if p.arm in ARM_PIN else None,
                          budget_usd=self.ledger.budgets[p.arm], token=token,
                          # review M1: routed arms may only send model "auto" (no auto:<tier>, no concrete id); D only Sol.
                          allowed_model=ARM_MODELS['D'] if p.arm == 'D' else 'auto',
                          margin_usd=call_margin(p.arm), worst_model=worst_model(p.arm))
            self.proxy.register(route)
            run_dir = self.dir / 'runs' / rid
            try:
                agent = protocol.run_agent(self.env, spec, self.proxy.base_url(rid), self.codex_bin, run_dir, self.timeout_s)
            finally:
                self.proxy.unregister(rid)
            cs = self._settle(rid, route)
            g = None
            if agent.get('exit_reason') != 'harness-error':
                g = protocol.grade(self.env, task, agent.get('patch_text', ''), grade_spec, f'{rid}-grade',
                                   base_rebuild_ok=grade_spec.get('base_rebuild_ok'))
                write_json(run_dir / 'grade.json', g)
            meta = {'version': codex_setup.CODEX['version'], 'settings': codex_setup.CODEX_SETTINGS,
                    'provider': codex_setup.PROVIDER_SETTINGS}
            row = results.build_row(spec, agent, g, cs, meta, dataclasses.asdict(self.env.limits))
            append_jsonl(self.dir / RESULTS_FILE.name, row)
            return row
        finally:
            if cs is None:
                self._settle(rid, route)

    def _settle(self, rid: str, route: Route | None) -> dict[str, Any]:
        with self.lock:
            calls = list(self.calls.pop(rid, []))
        cs = results.calls_summary(calls)
        if route is not None:
            cs['proxy'] = {'calls': route.calls, 'blocked': route.blocked, 'spent_usd': round(route.spent_usd, 6)}
        self.ledger.settle(rid, cs['ledger_usd'], {'calls': cs['calls'], 'budget_stopped': cs['budget_stopped']})
        return cs

    def run(self, planned: list[Planned]) -> dict[str, Any]:
        prior = list(read_jsonl(self.dir / RESULTS_FILE.name))
        done = results.done_keys(prior)
        todo = [p for p in planned if (p.phase, p.arm, p.task_id, p.rep) not in done]
        self.log(f'{len(planned)} planned, {len(planned) - len(todo)} already done, {len(todo)} to run')
        queue = list(todo)
        futures: dict[Future, Planned] = {}
        finished: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
            while queue or futures:
                if (self.dir / STOP_FILE.name).exists():
                    self.stop_reason = self.stop_reason or 'stop-file'
                if queue and not self.stop_reason and (gb := self.free_gb([self.dir, DOCKER_ROOT])) < self.min_free_gb:
                    self.stop_reason = f'disk: {gb:.1f} GB free < {self.min_free_gb} GB'   # review L10: start nothing new
                while queue and len(futures) < self.concurrency and not self.stop_reason:
                    p = queue[0]
                    attempt = self._attempt(p)
                    rid = new_run_id()
                    if self.ledger.reserve(rid, p.arm, p.phase, key=run_key(p)) is None:
                        if not futures:
                            self.stop_reason = f'cap: {self.ledger.summary()}'
                        break
                    queue.pop(0)
                    futures[pool.submit(self.one, p, rid, attempt)] = p
                if not futures:
                    break
                done_set, _ = wait(list(futures), timeout=30, return_when=FIRST_COMPLETED)
                for f in done_set:
                    p = futures.pop(f)
                    try:
                        row = f.result()
                    except Exception as e:  # noqa: BLE001 - e.g. no validation record (one() already settled the ledger)
                        row = {'phase': p.phase, 'arm': p.arm, 'task_id': p.task_id, 'rep': p.rep, 'exit_reason': 'harness-error',
                               'error': f'{type(e).__name__}: {str(e)[:200]}'}
                    if row.get('schema'):
                        prior.append(row)
                    finished.append(row)
                    err = row.get('exit_reason') == 'harness-error'
                    self.consecutive_errors = self.consecutive_errors + 1 if err else 0
                    self.log(f"{p.phase} {p.arm} {p.task_id}: {row.get('exit_reason')} resolved={row.get('resolved')} "
                             f"${(row.get('ledger_usd') or 0):.3f} total=${self.ledger.total():.2f}")
                    if self.consecutive_errors >= self.max_err:
                        self.stop_reason = f'{self.consecutive_errors} consecutive harness errors'
                if self.stop_reason and not futures:
                    break
                if self.stop_reason:
                    queue.clear()
                time.sleep(0.1)
        return {'planned': len(planned), 'ran': len(finished), 'stop_reason': self.stop_reason, 'ledger': self.ledger.summary()}
