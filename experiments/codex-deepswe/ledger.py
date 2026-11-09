"""Spend ledger (design §6, R6): pilot cap $10, total cap $200 (Bedrock via the gateway or direct, the offline tier
pass, and runner hours).

Each run reserves its worst case before it starts: its per-run budget (the proxy refuses calls once the run has
spent it) + one more call at the auto-compact prompt size, uncached, plus the output margin, + an
assessor allowance for arm B. A run starts only when committed + every in-flight reservation + its own worst case
stays within the caps. When the run ends its reservation is replaced by its actual spend (proxy per-call pricing,
an upper bound: unknown served models are priced as Astra).
"""
from __future__ import annotations

import dataclasses
import pathlib
import threading
import time
from typing import Any

import pricing
from common import ARM_MODELS, POOL_MODELS, RESULTS, now_iso, read_json, write_json

LEDGER = RESULTS / 'ledger.json'
CAPS = {'pilot': 10.0, 'total': 200.0}
DEFAULT_BUDGETS = {'A': 2.5, 'F': 0.5, 'B': 6.0, 'C': 6.0, 'D': 2.5}   # F (Luna) is ~20x cheaper than Sol
ASSESSOR_ALLOWANCE = 0.01     # router-side Luna consultations per B run (≈ $0.0006 each); reconciled from logs
MARGIN_PROMPT_TOKENS = 200_000  # = model_auto_compact_token_limit in the Codex config: Codex compacts above it
MARGIN_OUTPUT_TOKENS = 16_000


def worst_model(arm: str) -> str:
    """The most expensive model a run of this arm can be served by (B: any pool model)."""
    m = ARM_MODELS[arm]
    return m if m else max(POOL_MODELS, key=lambda x: pricing.catalog()[x]['price']['input'])


def call_margin(arm: str) -> float:
    return pricing.worst_call_usd(worst_model(arm), MARGIN_PROMPT_TOKENS, MARGIN_OUTPUT_TOKENS)


@dataclasses.dataclass
class Reservation:
    run_id: str
    arm: str
    phase: str
    budget: float
    worst: float


class CapExceeded(Exception):
    pass


class Ledger:
    """Thread-safe; persisted to results/ledger.json after every change."""

    def __init__(self, path: pathlib.Path = LEDGER, caps: dict[str, float] | None = None,
                 budgets: dict[str, float] | None = None, runner_usd_per_hour: float = 0.0,
                 runner_started_at: float | None = None, clock=time.time):
        self.path = path
        self.caps = dict(caps or CAPS)
        self.budgets = dict(budgets or DEFAULT_BUDGETS)
        self.clock = clock
        self._lock = threading.Lock()
        self.data: dict[str, Any] = read_json(path) if path.exists() else {
            'schema': 'codex-deepswe-ledger/v1', 'created': now_iso(), 'committed': {}, 'runs': {}, 'charges': []}
        if runner_started_at is not None:
            self.data['runner_started_at'] = runner_started_at
        # The rate is stored too, so a later read-only Ledger() (cli.py report) can still price the runner hours.
        if runner_usd_per_hour > 0:
            self.data['runner_usd_per_hour'] = runner_usd_per_hour
        self.runner_rate = runner_usd_per_hour or float(self.data.get('runner_usd_per_hour') or 0.0)
        self.inflight: dict[str, Reservation] = {}
        # A run still 'running' in the file was cut off by a crash: its spend is unknown, so charge its worst case.
        for run in self.data['runs'].values():
            if run.get('status') == 'running':
                run.update(status='settled', usd=run.get('worst', 0.0), crashed=True, settled=now_iso())
                ph = run.get('phase', 'main')
                self.data['committed'][ph] = self.data['committed'].get(ph, 0.0) + float(run.get('worst', 0.0))

    # ------------------------------------------------------------ totals
    def runner_usd(self) -> float:
        t0 = self.data.get('runner_started_at')
        return 0.0 if t0 is None or self.runner_rate <= 0 else max(0.0, self.clock() - t0) / 3600 * self.runner_rate

    def committed(self, phase: str | None = None) -> float:
        c = self.data['committed']
        return sum(v for k, v in c.items() if phase is None or k == phase)

    def total(self) -> float:
        return self.committed() + self.runner_usd()

    def _inflight(self, phase: str | None = None) -> float:
        return sum(r.worst for r in self.inflight.values() if phase is None or r.phase == phase)

    def headroom(self) -> dict[str, float]:
        with self._lock:
            return {'total': self.caps['total'] - self.total() - self._inflight(),
                    'pilot': self.caps['pilot'] - self.committed('pilot') - self._inflight('pilot')}

    # ------------------------------------------------------------ runs
    def worst_case(self, arm: str) -> float:
        return self.budgets[arm] + call_margin(arm) + (ASSESSOR_ALLOWANCE if arm == 'B' else 0.0)

    def reserve(self, run_id: str, arm: str, phase: str, key: str = '') -> Reservation | None:
        """The reservation, or None when starting this run could pass a cap (the caller waits for in-flight runs
        to settle, then retries; with nothing in flight a None means stop)."""
        worst = self.worst_case(arm)
        with self._lock:
            if self.total() + self._inflight() + worst > self.caps['total']:
                return None
            if phase == 'pilot' and self.committed('pilot') + self._inflight('pilot') + worst > self.caps['pilot']:
                return None
            r = Reservation(run_id, arm, phase, self.budgets[arm], worst)
            self.inflight[run_id] = r
            self.data['runs'][run_id] = {'key': key, 'arm': arm, 'phase': phase, 'budget': r.budget, 'worst': worst,
                                         'started': now_iso(), 'status': 'running'}
            self._save()
            return r

    def settle(self, run_id: str, usd: float, detail: dict[str, Any] | None = None) -> None:
        with self._lock:
            r = self.inflight.pop(run_id, None)
            run = self.data['runs'].setdefault(run_id, {})
            phase = r.phase if r else run.get('phase', 'main')
            run.update({'status': 'settled', 'usd': round(usd, 6), 'settled': now_iso(), **(detail or {})})
            self.data['committed'][phase] = self.data['committed'].get(phase, 0.0) + usd
            self._save()

    def charge(self, phase: str, usd: float, what: str) -> None:
        """A spend outside the runs (e.g. the offline tier pass)."""
        with self._lock:
            self.data['committed'][phase] = self.data['committed'].get(phase, 0.0) + usd
            self.data['charges'].append({'at': now_iso(), 'phase': phase, 'usd': round(usd, 6), 'what': what})
            self._save()

    def check_or_raise(self, phase: str, usd: float) -> None:
        with self._lock:
            if self.total() + self._inflight() + usd > self.caps['total']:
                raise CapExceeded(f'{phase}: ${usd:.2f} would pass the ${self.caps["total"]:.0f} total cap (spent ${self.total():.2f})')

    def summary(self) -> dict[str, Any]:
        with self._lock:
            return {'committed': {k: round(v, 4) for k, v in self.data['committed'].items()},
                    'runner_usd': round(self.runner_usd(), 4), 'total': round(self.total(), 4), 'caps': self.caps,
                    'inflight': len(self.inflight), 'inflight_worst': round(self._inflight(), 4)}

    def _save(self) -> None:
        self.data['updated'] = now_iso()
        self.data['caps'] = self.caps
        self.data['budgets'] = self.budgets
        write_json(self.path, self.data)
