"""Host proxy for Harbor trials (design §5): codex-deepswe/proxy.py in-process in 17's driver, with a shared
refreshing token and a per-call hard cap.

Reused unchanged from the R2E proxy: per-trial routes `/r/<trial-id>/v1/{responses,models}` (only POST responses and
GET models, no CONNECT or absolute URIs, no compressed bodies), `x-router-session: <trial-id>` and the arm's
`x-router-hint` set by the proxy whatever the client sent, the body model must be "auto", exactly one upstream host
(the gateway, resolved once per connection and refused if any address is private/link-local/IMDS, TLS pinned to
the vetted IP), SSE usage tap and per-call pricing, served model per call (`served_model`, `router`), never a body,
prompt or token in any log. Added here:
- Token. One SharedToken for all trials: cached, re-minted 2 minutes before expiry (auth.RunToken), and dropped
  after any upstream 401, so the next call (Codex retries) mints a fresh one. Trials last up to 3 h; the Cognito
  TTL is 60 min. The token stays in this process; containers get a dummy key.
- Hard cap, fail closed (CapLedger). Every model call reserves its worst case before it is forwarded (prompt
  estimated from the trial's previous call, all uncached, at the size's price, + 16k output: R2E's _admit), and
  is admitted only if settled spend + every in-flight reservation + this one ≤ cap − reserve (the cap is
  Bedrock spend seen here, $1,130 per runner by default; runner hours count only if a rate is given). The
  first refusal stops the proxy: every later call is refused (`budget`, HTTP 429) until an operator restarts it
  with a new cap. The admit/settle log is fsynced; after a crash an admitted call with no settle is charged its
  worst case.
- No per-trial budget (design §7.5: truncating a run changes the agent); a trial over $25 is logged to alerts.jsonl.
- Per-trial summary for the driver (unregister_trial): calls, statuses, refusals, error origins, token events,
  tokens by served model.

It listens only on an explicit private IPv4 (docker0's address on the runner), never 0.0.0.0 (check_bind), and has
no auth of its own: it is reachable only from local containers (the runner has no inbound rules and its firewall
accepts only TCP to this port from the docker bridges), and anything that reaches it can spend at most the cap.
"""
from __future__ import annotations

import dataclasses
import json
import pathlib
import re
import threading
import time
import urllib.parse
import uuid
from collections import Counter
from collections.abc import Callable
from typing import Any

import hcommon
import auth
import cc_calls
import cc_pricing
import pricing
import proxy as px
import common
import results
from common import append_jsonl, write_json
from hcommon import ARM_PIN, ARMS

WORST_MODEL = 'global.openai.gpt-6-astra'   # the most expensive pool model (B can be served by any)
DEFAULT_CAP_USD = 1130.0                    # per runner, Bedrock spend seen by the proxy (design §9); configurable
DEFAULT_RESERVE_USD = 10.0                  # headroom for calls that end above their reserved worst case
ALERT_TRIAL_USD = 25.0


class SharedToken(auth.RunToken):
    """auth.RunToken shared by every trial. It re-mints:
    - 2 minutes before expiry (auth.RunToken);
    - after an upstream 401 (invalidate()), at most once per INVALIDATE_EVERY_S: a 401 that is not about the token
      must not mint per call (73 L3);
    - once the token is older than `token_max_age_s`, if set (off by default). The pilot sets 600 s, so every trial
      longer than 10 minutes sees a real mid-session Cognito re-mint (0c).
    `mints` counts every mint (the first included); `remints` counts re-mints by reason (expiry | invalidated | age)."""

    INVALIDATE_EVERY_S = 30.0

    def __init__(self, minter: auth.TokenMinter, clock: Callable[[], float] = time.time,
                 token_max_age_s: float | None = None):
        if token_max_age_s is not None and token_max_age_s <= 0:
            raise ValueError('token_max_age_s must be > 0 (or None: off)')
        self.token_max_age_s = token_max_age_s
        self.remints: Counter[str] = Counter()
        self._invalidated = False
        super().__init__(minter, clock)
        self._minted_at = self._clock()

    def __call__(self) -> str:
        with self._lock:
            now = self._clock()
            if self._invalidated:
                why = 'invalidated'
            elif now > self._exp - 120:
                why = 'expiry'
            elif self.token_max_age_s is not None and now - self._minted_at >= self.token_max_age_s:
                why = 'age'
            else:
                return self._token
            self._token, self._exp = self._minter.mint()
            self._minted_at = now
            self._invalidated = False
            self.mints += 1
            self.remints[why] += 1
            return self._token

    def invalidate(self) -> bool:
        with self._lock:
            now = self._clock()
            if now - getattr(self, '_last_invalidated', float('-inf')) < self.INVALIDATE_EVERY_S:
                return False
            self._last_invalidated = now
            self._invalidated = True
            return True

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {'mints': self.mints, 'remints': dict(self.remints), 'token_max_age_s': self.token_max_age_s}

    def __repr__(self) -> str:  # never show the token
        return f'SharedToken(mints={self.mints})'


@dataclasses.dataclass
class CallReservation:
    call_id: str
    session: str
    worst: float


class CapLedger:
    """Per-runner spend with a hard cap. Persistence: an fsynced append-only JSONL of admit/settle/stop events
    (cap-events.jsonl), and a small totals file (proxy-state.json, rewritten atomically on every settle) for the
    driver. A torn last line after a crash mid-write is skipped (an `admit` lost that way would go uncharged; with
    an fsync per line that needs a crash inside the write itself). The crash charge is the reservation estimate,
    not a strict bound; the reserve covers the difference."""

    def __init__(self, events_path: pathlib.Path, state_path: pathlib.Path, cap_usd: float = DEFAULT_CAP_USD,
                 reserve_usd: float = DEFAULT_RESERVE_USD, runner_usd_per_hour: float = 0.0,
                 runner_started_at: float | None = None, clock: Callable[[], float] = time.time):
        if cap_usd <= 0:
            raise ValueError('cap must be > 0')
        self.events_path, self.state_path = events_path, state_path
        self.cap, self.reserve = float(cap_usd), float(reserve_usd)
        self.rate, self.t0, self.clock = float(runner_usd_per_hour), runner_started_at, clock
        self.lock = threading.Lock()
        self.settled = 0.0
        self.calls = 0
        self.inflight: dict[str, CallReservation] = {}
        self.stopped: str | None = None
        self.crash_charged = 0.0
        self._replay()
        if self.t0 is not None and not self.events_path.exists():
            append_jsonl(self.events_path, {'ev': 'start', 't0': self.t0})

    def _replay(self) -> None:
        """Rebuild from the event log. Fails closed: an admit without a settle (a crash mid-call) is charged its
        worst case; a stop is sticky."""
        if not self.events_path.exists():
            return
        open_calls: dict[str, float] = {}
        for line in self.events_path.read_text(encoding='utf-8', errors='replace').splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get('ev') == 'admit':
                open_calls[e['call_id']] = float(e['worst'])
            elif e.get('ev') == 'settle':
                open_calls.pop(e['call_id'], None)
                self.settled += float(e['usd'])
                self.calls += 1
            elif e.get('ev') == 'crash-charge':
                # The calls left open before this restart were charged here once; they are closed now.
                self.settled += float(e['usd'])
                open_calls.clear()
            elif e.get('ev') == 'stop':
                self.stopped = e.get('reason') or 'stopped'
            elif e.get('ev') == 'unstop':
                self.stopped = None
            elif e.get('ev') == 'start' and self.t0 is None:
                self.t0 = float(e['t0'])
        if open_calls:
            self.crash_charged = sum(open_calls.values())
            self.settled += self.crash_charged
            append_jsonl(self.events_path, {'ev': 'crash-charge', 'usd': round(self.crash_charged, 6), 'calls': len(open_calls)})

    def runner_usd(self) -> float:
        return 0.0 if self.t0 is None or self.rate <= 0 else max(0.0, self.clock() - self.t0) / 3600 * self.rate

    def committed(self) -> float:
        return self.settled + self.runner_usd()

    def admit(self, session: str, worst: float) -> CallReservation | None:
        with self.lock:
            if self.stopped:
                return None
            projected = self.committed() + sum(r.worst for r in self.inflight.values()) + worst
            if projected > self.cap - self.reserve:
                self.stopped = f'cap: projected ${projected:.2f} > ${self.cap - self.reserve:.2f}'
                append_jsonl(self.events_path, {'ev': 'stop', 'reason': self.stopped, 'at': time.time()})
                self._save()
                return None
            r = CallReservation(uuid.uuid4().hex, session, worst)
            self.inflight[r.call_id] = r
            append_jsonl(self.events_path, {'ev': 'admit', 'call_id': r.call_id, 'session': session, 'worst': round(worst, 6)})
            return r

    def settle(self, call_id: str, usd: float) -> None:
        with self.lock:
            if self.inflight.pop(call_id, None) is None:
                return
            self.settled += usd
            self.calls += 1
            append_jsonl(self.events_path, {'ev': 'settle', 'call_id': call_id, 'usd': round(usd, 6)})
            self._save()

    def open_for(self, session: str) -> int:
        with self.lock:
            return sum(1 for r in self.inflight.values() if r.session == session)

    def unstop(self, why: str) -> None:
        """Operator action after a cap change (0c moves headroom between runners): restart with the new cap and
        --resume-after-cap. Logged."""
        with self.lock:
            self.stopped = None
            append_jsonl(self.events_path, {'ev': 'unstop', 'why': why, 'cap': self.cap, 'at': time.time()})
            self._save()

    def stop(self, reason: str) -> None:
        with self.lock:
            if not self.stopped:
                self.stopped = reason
                append_jsonl(self.events_path, {'ev': 'stop', 'reason': reason, 'at': time.time()})
            self._save()

    def summary(self) -> dict[str, Any]:
        return {'cap_usd': self.cap, 'reserve_usd': self.reserve, 'settled_usd': round(self.settled, 6),
                'runner_usd': round(self.runner_usd(), 6), 'committed_usd': round(self.committed(), 6),
                'inflight': len(self.inflight), 'inflight_worst_usd': round(sum(r.worst for r in self.inflight.values()), 6),
                'calls': self.calls, 'crash_charged_usd': round(self.crash_charged, 6), 'stopped': self.stopped,
                'updated': time.time()}

    def _save(self) -> None:
        write_json(self.state_path, self.summary())


def count_tokens_aux(rec: dict[str, Any]) -> bool:
    """0d design-stats §16 (Amendment 7) predicate 1: an auxiliary non-model call, tagged call_type `count_tokens`,
    only if POST on exactly <route>/v1/messages/count_tokens (the leaf; query ignored), status 404, origin 'gateway',
    no router response headers, and no cost or usage. Anything else is left untagged (null roles), so the gate fails
    it (7.3/7.4). Today hproxy itself answers it (_cc_local, mirroring the gateway, which has no such route)."""
    return (rec.get('method') == 'POST' and rec.get('leaf') == 'messages/count_tokens' and rec.get('status') == 404
            and rec.get('origin') == 'gateway' and not rec.get('via_router') and not rec.get('usage')
            and not float(rec.get('cost_usd') or 0) and not float(rec.get('unpriced_estimate_usd') or 0))


def origin(rec: dict[str, Any]) -> str | None:
    """Where a failed model call's error came from, for 17's §7.4 classifier (None for a success):
    - 'proxy': refused here (cap, request checks), or the token mint failed (AuthError);
    - 'transport': a connection or stream failure at the proxy;
    - 'upstream': Bedrock's error: relayed by the router (the response carries x-router-* headers), an OpenAI-shape
      {"error": {...}} body without router headers (the gateway's fallback target), or an error event in a stream;
    - 'router': the router's own error ({"error": "<str>"} without router headers: no eligible model, upstream
      unavailable, pin not allowed, hop auth);
    - 'gateway': any other non-2xx without router headers (the gateway's own, e.g. JWT or throttling);
    - 'gateway-fallback' (Claude Code routes only, where every call goes up as `auto` for the router; the call's
      `gateway_fallback` is True): a response without router headers, 2xx included, that is neither the router's
      own error (error-string) nor a 401/429 (the gateway's own JWT and throttling answers, which stay 'gateway').
      The router never saw it: the gateway's fallback target answered (after a router 5xx; Bedrock unsanitized, no
      Opus: the A/C pilot's 400 and 403). A harness outcome, never the agent's. Codex routes keep the split above.
    Heuristic from status, router headers and the error body's shape; the router-log join checks it post hoc."""
    if rec.get('refused') or rec.get('error') == 'AuthError':
        return 'proxy'
    if rec.get('error'):
        return 'transport'
    st = rec.get('status')
    if gateway_fallback(rec):
        return 'gateway-fallback'
    if isinstance(st, int) and st >= 400:
        if rec.get('via_router') or rec.get('error_shape') == 'error-object':
            return 'upstream'
        return 'router' if rec.get('error_shape') == 'error-string' else 'gateway'
    if rec.get('error_code') or rec.get('response_status') == 'failed' or rec.get('terminal') == 'response.failed':
        return 'upstream'
    return None


GATEWAY_OWN_STATUSES = (401, 429)


def gateway_fallback(rec: dict[str, Any]) -> bool:
    """A Claude Code call the gateway answered without the router (see origin): independent of the body's shape, so a
    Bedrock error in any shape ({"message"}, {"error": {...}}) counts."""
    st = rec.get('status')
    return (rec.get('dialect') == 'anthropic-messages' and isinstance(st, int) and not rec.get('refused') and not rec.get('error')
            and not rec.get('via_router') and rec.get('error_shape') != 'error-string' and st not in GATEWAY_OWN_STATUSES)


def model_not_found(rec: dict[str, Any]) -> bool:
    """Bedrock's model-not-found (a 404 with an error object, or a not-found error code), from codes only."""
    code = str(rec.get('error_code') or '').lower()
    return ('not_found' in code or 'notfound' in code or 'model_not' in code
            or (rec.get('status') == 404 and rec.get('error_shape') == 'error-object'))


_CODE = re.compile(r'[^A-Za-z0-9_.-]')


def safe_code(v: Any) -> str | None:
    """An error code as a bare token ([A-Za-z0-9_.-]{1,64}), never text; None when absent."""
    if v is None:
        return None
    c = _CODE.sub('', str(v))[:64]
    return c or None


def failure(rec: dict[str, Any] | None) -> dict[str, Any] | None:
    """The failure fields of one model call (codes only, no text), None for a success: what 17's classifier splits
    on (0d F1/F4: 5xx/429/408/model-not-found/transport → rerun; other 4xx → agent; gateway 401/403 → harness;
    router → sut). `terminal`/`response_status` cover stream error events (response.failed, an `error` event)."""
    if not rec or rec.get('origin') is None:
        return None
    out = {k: rec.get(k) for k in ('status', 'origin', 'error_shape', 'terminal', 'response_status',
                                   'incomplete_reason', 'refused', 'error', 'model_not_found', 'served_model', 'mid_stream')}
    out['code'] = out['error_code'] = safe_code(rec.get('error_code'))
    return out


def _model_call(r: dict[str, Any]) -> bool:
    return r.get('leaf') in ('responses', 'messages') or (r.get('method') == 'POST' and r.get('leaf') is None)


CC_FORWARD_HEADERS = (*px.FORWARD_REQUEST_HEADERS, 'anthropic-version', 'anthropic-beta')
CC_SPEC_KEYS = ('client_model', 'main_model', 'hint', 'worst_model')


class RunnerProxy(px.EgressProxy):
    """The R2E EgressProxy with per-trial routes registered by the driver, a shared refreshing token and the
    per-call hard cap (module docstring)."""

    def __init__(self, host: str, port: int, upstreams: px.Upstreams, ledger: CapLedger, token: Callable[[], str] | None,
                 out_dir: pathlib.Path, alert_usd: float = ALERT_TRIAL_USD, allow_loopback_bind: bool = False,
                 require_host: str | None = hcommon.PROXY_HOST, clock: Callable[[], float] = time.time):
        # check_bind (R2E) refuses unspecified, loopback and public addresses; on top of that the bind must be the
        # one address the runner firewall opens (review 18 F7). Tests and the dry run pass their own.
        if require_host is not None and host != require_host and not (allow_loopback_bind and host == '127.0.0.1'):
            raise px.Refused(0, 'bind-not-proxy-address')
        common.set_region(upstreams.region)   # the price catalog of the experiment Region (a deploy parameter)
        self.ledger = ledger
        self.paths = default_paths(out_dir)
        self.alert_usd = alert_usd
        self.shared_token = token
        self.records: dict[str, list[dict[str, Any]]] = {}
        self.alerted: set[str] = set()
        super().__init__(host, port, upstreams, on_call=self._on_call, allow_loopback_bind=allow_loopback_bind, clock=clock)
        self.RequestHandlerClass = _CapHandler

    # ------------------------------------------------------------ driver API
    def register_trial(self, trial_id: str, arm: str, spec: dict[str, Any] | None = None) -> str:
        if arm not in ARMS:
            raise ValueError(f'unknown arm {arm!r}')
        if self.shared_token is None:
            raise ValueError('no token provider')
        if spec is not None:
            return self._register_cc(trial_id, arm, spec)
        pin = ARM_PIN[arm]
        with self.lock:
            if trial_id in self.routes:
                raise ValueError(f'trial {trial_id} is already registered')
            self.records[trial_id] = []
        self.register(px.Route(run_id=trial_id, arm=arm, kind='gateway', hint=f'pin={pin}' if pin else None,
                               budget_usd=float('inf'), token=self.shared_token, allowed_model='auto',
                               worst_model=pin or WORST_MODEL))
        return self.base_url(trial_id)

    def _register_cc(self, trial_id: str, arm: str, spec: dict[str, Any]) -> str:
        """A Claude Code route (design-harness §2): Anthropic Messages, the pool's three models allowed, the arm carried
        by the client's body model. The gateway routes only `auto` / `auto:*` to the router (anything else goes to
        its Bedrock fallback, unsanitized and without Opus), so every call goes up as `auto`: with
        `x-router-hint: pin=<the call's own model>` (A, C, F, and B's calls not naming the client model), or with
        no hint when the arm's main model is `auto` and the call names the client model (B: the router decides).
        Pinning each call to the model it named keeps helper calls served as requested; the route's static hint
        stays None (the spec's `hint` must be null)."""
        missing = [k for k in CC_SPEC_KEYS if k not in spec]
        if missing:
            raise ValueError(f'arm spec lacks {missing}')
        if spec['hint'] is not None:
            raise ValueError('Claude Code arms take no router hint (the client model carries the arm)')
        if spec['client_model'] not in cc_calls.POOL:
            raise ValueError(f"client_model {spec['client_model']!r} is not a pool model")
        with self.lock:
            if trial_id in self.routes:
                raise ValueError(f'trial {trial_id} is already registered')
            self.records[trial_id] = []
        agent = {'client_model': spec['client_model'], 'rewrite': spec['main_model'] == 'auto', 'main_model': spec['main_model'],
                 'classifier': self.cc_classifier()}
        self.register(px.Route(run_id=trial_id, arm=arm, kind='gateway', hint=None, budget_usd=float('inf'), token=self.shared_token,
                               allowed_model=None, worst_model=spec['worst_model'], dialect='anthropic-messages', agent=agent))
        return self.base_url(trial_id)

    def cc_classifier(self) -> dict[str, Any]:
        if getattr(self, '_cc_clf', None) is None:
            self._cc_clf = cc_calls.load_classifier()
        return self._cc_clf

    def unregister_trial(self, trial_id: str, wait_s: float = 10.0) -> dict[str, Any]:
        """Stops routing the trial, waits (up to wait_s) for its admitted calls to settle, returns its summary."""
        route = self.unregister(trial_id)
        deadline = time.monotonic() + wait_s
        while self.ledger.open_for(trial_id) and time.monotonic() < deadline:
            time.sleep(0.05)
        with self.lock:
            recs = self.records.pop(trial_id, [])
        out = trial_summary(trial_id, route, recs, self.ledger.stopped)
        # Calls still waiting on the upstream (e.g. the agent was killed mid-call): reserved in the ledger, settled
        # when the upstream ends (≤ READ_TIMEOUT_S), in calls.jsonl but not in this summary.
        out['open_calls'] = self.ledger.open_for(trial_id)
        return out

    def summary(self) -> dict[str, Any]:
        with self.lock:
            active = sorted(self.routes)
        tok = self.shared_token.stats() if isinstance(self.shared_token, SharedToken) else None
        return {**self.ledger.summary(), 'active_trials': active, 'unrouted_refusals': self.unrouted, 'token': tok,
                'token_mints': tok['mints'] if tok else None, 'token_remints': sum(tok['remints'].values()) if tok else None,
                'token_max_age_s': tok['token_max_age_s'] if tok else None}

    # ------------------------------------------------------------ per call
    def _on_call(self, rec: dict[str, Any]) -> None:
        call_id = rec.pop('call_id', None)
        tid = rec.get('run_id')
        route = None
        try:
            if rec.get('status') == 401 and not rec.get('refused') and isinstance(self.shared_token, SharedToken):
                rec['token_invalidated'] = self.shared_token.invalidate()
            rec['origin'] = origin(rec)
            if rec.get('dialect') == 'anthropic-messages':
                rec['gateway_fallback'] = rec['origin'] == 'gateway-fallback'
            rec['model_not_found'] = model_not_found(rec)
            if count_tokens_aux(rec):
                rec.update(call_type='count_tokens', call_role=cc_calls.NON_MODEL, call_role_struct=cc_calls.NON_MODEL)
            if isinstance(self.shared_token, SharedToken):
                rec['token_gen'] = self.shared_token.mints   # which minted token was current when the call ended
            rec['trial_id'] = tid
            with self.lock:
                # Recorded before the settle: unregister_trial waits for the trial's open reservations, then reads these.
                if tid in self.records:
                    self.records[tid].append(rec)
                route = self.routes.get(tid or '')
        finally:
            # Always settle an admitted call, whatever failed above (73 L2): a leaked reservation would block headroom.
            if call_id:
                self.ledger.settle(call_id, float(rec.get('cost_usd') or 0.0) + float(rec.get('unpriced_estimate_usd') or 0.0))
        rec['runner_committed_usd'] = round(self.ledger.committed(), 6)
        append_jsonl(self.paths['calls'], rec)
        spent = route.spent_usd if route else 0.0
        if tid and spent > self.alert_usd and tid not in self.alerted:
            self.alerted.add(tid)
            append_jsonl(self.paths['alerts'], {'at': time.time(), 'trial_id': tid, 'arm': rec.get('arm'),
                                                'spent_usd': round(spent, 4), 'alert_usd': self.alert_usd})


class _CapHandler(px._Handler):  # noqa: SLF001 - reusing the R2E handler is the point
    server: RunnerProxy

    # ------------------------------------------------------------ Anthropic Messages (Claude Code routes)
    def _forward_headers(self, route: px.Route) -> tuple[str, ...]:
        return CC_FORWARD_HEADERS if route.dialect == 'anthropic-messages' else super()._forward_headers(route)

    def _new_tap(self, route: px.Route) -> Any:
        return AnthropicSseTap() if route.dialect == 'anthropic-messages' else super()._new_tap(route)

    def _json_meta(self, route: px.Route, raw: bytes) -> dict[str, Any]:
        return anthropic_json_meta(raw) if route.dialect == 'anthropic-messages' else super()._json_meta(route, raw)

    def _price(self, route: px.Route, model: str | None, usage: dict[str, Any]) -> dict[str, Any]:
        return cc_pricing.cost(model, usage) if route.dialect == 'anthropic-messages' else super()._price(route, model, usage)

    def _normalize(self, route: px.Route, usage: dict[str, Any]) -> dict[str, int]:
        return cc_pricing.normalize(usage) if route.dialect == 'anthropic-messages' else super()._normalize(route, usage)

    def _extra_meta(self, route: px.Route, meta: dict[str, Any]) -> dict[str, Any]:
        return {'stop_reason': meta.get('stop_reason')} if route.dialect == 'anthropic-messages' else {}

    def _check_body(self, route: px.Route, body: bytes) -> tuple[bytes, dict[str, Any]]:
        if route.dialect != 'anthropic-messages':
            return super()._check_body(route, body)
        try:
            j = json.loads(body)
        except ValueError as e:
            raise px.Refused(400, 'body-not-json') from e
        if not isinstance(j, dict):
            raise px.Refused(400, 'body-not-object')
        model = j.get('model')
        a = route.agent or {}
        if model not in cc_calls.POOL:
            raise px.Refused(403, 'model-not-allowed')
        hdrs = {k.lower(): v for k, v in self.headers.items()}
        meta: dict[str, Any] = {'requested_model': model, 'stream': bool(j.get('stream')), 'req_bytes': len(body),
                                'input_items': len(j['messages']) if isinstance(j.get('messages'), list) else None,
                                'max_tokens_margin': cc_pricing.body_max_tokens(j),
                                **cc_calls.roles(hdrs, j, a.get('client_model', ''), a.get('classifier') or self.server.cc_classifier()),
                                'sanitized': cc_calls.sanitized(hdrs, j), 'rewritten': False, 'pin': None,
                                'dialect': route.dialect}
        # Every call goes up as `auto` (the gateway's router rule); requested_model above stays the client's model.
        body = cc_calls.splice_top_level(body, 'model', '"auto"')
        if a.get('rewrite') and model == a.get('client_model'):
            meta['rewritten'] = True      # B's gate: the router picks the model
        else:
            meta['pin'] = model           # served as named, through the router
        return body, meta

    def _hint(self, route: px.Route, rec: dict[str, Any]) -> str | None:
        if route.dialect != 'anthropic-messages':
            return super()._hint(route, rec)
        return f"pin={rec['pin']}" if rec.get('pin') else None

    def _cc_local(self, method: str) -> bool:
        """count_tokens (404, as the gateway has no route for it) and GET models (the allowed ids), answered here for
        Claude Code routes, never forwarded; True when answered. A count_tokens record is tagged in _on_call
        (count_tokens_aux); a models record is not (Amendment 7.3: any other path still fails the gate)."""
        path = urllib.parse.urlsplit(self.path).path if self.path.startswith('/') else ''
        m = px._PATH.match(path)
        if not m or m.group(2) not in ('messages/count_tokens', 'models'):
            return False
        with self.server.lock:
            route = self.server.routes.get(m.group(1))
        if route is None or route.dialect != 'anthropic-messages':
            return False
        if (method, m.group(2)) not in px.ROUTE_LEAVES['anthropic-messages']:
            return False
        self._drain()
        rec = {'run_id': route.run_id, 'arm': route.arm, 'method': method, 'leaf': m.group(2), 'local': True,
               't_start': round(self.server.clock(), 3)}   # no body field: the body is drained unread (Amendment 7.5)
        if m.group(2) == 'models':
            self._reply_json(200, {'data': [{'id': x, 'type': 'model'} for x in cc_calls.POOL], 'has_more': False})
            rec['status'] = 200
        else:
            self._reply_json(404, {'type': 'error', 'error': {'type': 'not_found_error', 'message': 'count_tokens is not available'}})
            rec['status'] = 404
        self.server.on_call(rec)
        return True

    def _serve(self, method: str) -> None:
        if self.server.ledger.stopped:
            # The cap stop is sticky: refuse before forwarding anything (attributed to the trial when the route is known).
            self._drain()
            m = px._PATH.match(urllib.parse.urlsplit(self.path).path) if self.path.startswith('/') else None  # noqa: SLF001
            with self.server.lock:
                route = self.server.routes.get(m.group(1)) if m else None
            rec = {'run_id': route.run_id if route else None, 'arm': route.arm if route else None,
                   'leaf': m.group(2) if m else None, 'method': method, 't_start': round(self.server.clock(), 3), 'cap_stopped': True}
            self._refuse(px.Refused(429, 'budget'), route, rec)
            return
        if self._cc_local(method):
            return
        super()._serve(method)

    def _drain(self) -> None:
        try:
            n = int(self.headers.get('content-length') or 0)
        except ValueError:
            n = 0
        if 0 < n <= px.MAX_BODY:
            self.rfile.read(n)

    def _admit(self, route: px.Route, n_bytes: int, rec: dict[str, Any]) -> None:
        super()._admit(route, n_bytes, rec)   # R2E estimate (rec['est_prompt_tokens']); per-trial budget is inf
        if route.dialect == 'anthropic-messages':
            # Worst case (17 §3): the prompt at max(input, cache write) of its size's price, plus max(16k, max_tokens) out.
            # B's rewritten calls at the arm's worst model (Opus); every other call at the model it names.
            model = route.worst_model if rec.get('rewritten') else (rec.get('requested_model') or route.worst_model)
            worst = cc_pricing.worst(model, rec['est_prompt_tokens'], rec.get('max_tokens_margin') or px.MARGIN_OUTPUT_TOKENS)
        else:
            model = route.worst_model if route.arm == 'B' else (route.last_model or route.worst_model)
            worst = pricing.cost(model, {'input_tokens': rec['est_prompt_tokens'], 'output_tokens': px.MARGIN_OUTPUT_TOKENS})['usd']
        res = self.server.ledger.admit(route.run_id, worst)
        if res is None:
            raise px.Refused(429, 'budget')
        rec['call_id'] = res.call_id
        rec['reserved_usd'] = round(worst, 6)


def trial_summary(trial_id: str, route: px.Route | None, recs: list[dict[str, Any]], cap_stopped: str | None) -> dict[str, Any]:
    """Per-trial proxy summary for the driver (17's classifier keys) and the result row (R2E's calls_summary)."""
    # calls_summary aggregates Responses calls; Claude Code's Messages calls carry the same normalized usage keys.
    cs = results.calls_summary([{**r, 'leaf': 'responses'} if r.get('leaf') == 'messages' else r for r in recs])
    model = [r for r in recs if _model_call(r)]
    last = model[-1] if model else None
    origins = Counter(r['origin'] for r in model if r.get('origin'))
    return {
        'trial_id': trial_id, 'arm': route.arm if route else None,
        'spent_usd': round(route.spent_usd, 6) if route else cs['ledger_usd'], 'calls': len(model),
        'statuses': dict(Counter(str(r.get('status')) for r in model)),
        'error_origins': dict(origins),
        'last_call': {'status': last.get('status'), 'origin': last.get('origin'),
                      'ok': last.get('status') == 200 and last.get('origin') is None,
                      'code': safe_code(last.get('error_code')), 'error_code': safe_code(last.get('error_code')),
                      'terminal': last.get('terminal'),
                      'model_not_found': bool(last.get('model_not_found'))} if last else None,
        'last_failure': failure(next((r for r in reversed(model) if r.get('origin') is not None), None)),
        'failures': dict(Counter(f"{r.get('status')}:{r.get('origin')}:{r.get('error_code') or '-'}" for r in model if r.get('origin'))),
        'throttled': sum(1 for r in model if r.get('status') == 429 and r.get('origin') in ('upstream', 'router', 'gateway')),
        'cap_stopped': any(r.get('cap_stopped') or (r.get('refused') == 'budget') for r in model),
        'cap_stop_reason': cap_stopped,
        'auth_errors': sum(1 for r in model if r.get('error') == 'AuthError'),
        'token_invalidations': sum(1 for r in model if r.get('token_invalidated') is True),
        # Re-mints seen by this trial: distinct token generations across its calls, minus one.
        'token_remints': (len({r['token_gen'] for r in model if r.get('token_gen')}) - 1) if any(r.get('token_gen') for r in model) else 0,
        'refused': cs['refused'], 'served_models': cs['served_models'], 'tokens_by_model': tokens_by_model(model),
        # 0d §18 (classify.refusal_fallback_blocked): model calls that ended with stop_reason refusal, by served model.
        'refusals': dict(Counter(str(r.get('served_model')) for r in model if r.get('stop_reason') == 'refusal')),
        'blocked': route.blocked if route else None,
        'calls_summary': cs,
        **(cc_summary(model) if route is not None and route.dialect == 'anthropic-messages' else {}),
    }


def tokens_by_model(recs: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    """Per served model: calls and tokens (0d finding 4: B's mid-session switches as token share by model)."""
    out: dict[str, dict[str, int]] = {}
    for r in recs:
        u = r.get('usage')
        if not u or r.get('leaf') not in ('responses', 'messages'):
            continue
        m = pricing.resolve(r.get('served_model')) or str(r.get('served_model') or 'unknown')
        d = out.setdefault(m, {'calls': 0, 'prompt': 0, 'read': 0, 'output': 0})
        d['calls'] += 1
        for k in ('prompt', 'read', 'output'):
            d[k] += int(u.get(k) or 0)
    return out


def _last_call(r: dict[str, Any] | None) -> dict[str, Any] | None:
    if r is None:
        return None
    return {'status': r.get('status'), 'origin': r.get('origin'), 'ok': r.get('status') == 200 and r.get('origin') is None,
            'code': safe_code(r.get('error_code')), 'error_code': safe_code(r.get('error_code')), 'terminal': r.get('terminal'),
            'model_not_found': bool(r.get('model_not_found'))}


def cc_summary(model: list[dict[str, Any]]) -> dict[str, Any]:
    """Claude Code trial summary keys (0d design-stats §11; 17's classify reads calls_by_role.main)."""
    by: dict[str, dict[str, Any]] = {}
    for role in cc_calls.ROLES:
        rs = [r for r in model if r.get('call_role') == role]
        tok = {k: sum(int((r.get('usage') or {}).get(k) or 0) for r in rs) for k in ('prompt', 'uncached', 'read', 'write_5m', 'write_1h', 'output')}
        by[role] = {'calls': len(rs), **tok,
                    'cost_usd': round(sum(float(r.get('cost_usd') or 0) + float(r.get('unpriced_estimate_usd') or 0) for r in rs), 6),
                    'served_models': dict(Counter(str(r.get('served_model')) for r in rs if r.get('served_model'))),
                    'statuses': dict(Counter(str(r.get('status')) for r in rs)),
                    'error_origins': dict(Counter(r['origin'] for r in rs if r.get('origin'))),
                    'last_call': _last_call(rs[-1] if rs else None)}
    null = [r for r in model if r.get('call_role') is None]
    return {'calls_by_role': by, 'roles_null': len(null), 'roles_null_cost_usd': round(sum(float(r.get('cost_usd') or 0) for r in null), 6),
            'call_types': dict(Counter(str(r.get('call_type')) for r in model)),
            'role_agreement': {'n': sum(1 for r in model if r.get('call_role') is not None or r.get('call_role_struct') is not None),
                               'agree': sum(1 for r in model if r.get('call_role') is not None and r.get('call_role') == r.get('call_role_struct'))},
            'sanitized_requests': sum(1 for r in model if r.get('sanitized')), 'rewritten_calls': sum(1 for r in model if r.get('rewritten')),
            'pinned_calls': sum(1 for r in model if r.get('pin')),
            'pin_served_other': sum(1 for r in model if r.get('pin') and r.get('status') == 200 and r.get('served_model') != r['pin']),
            'gateway_fallback_calls': sum(1 for r in model if r.get('gateway_fallback'))}


class AnthropicSseTap:
    """Incremental SSE parser for Anthropic Messages streams: message_start (model, base usage), message_delta (usage
    overlay, nulls never erase; stop_reason), message_stop (terminal), error (error.type). Mirrors
    createStreamUsageAccumulator('anthropic-messages')."""

    def __init__(self) -> None:
        self.buf = b''
        self.out: dict[str, Any] = {}
        self._usage: dict[str, Any] | None = None

    def feed(self, chunk: bytes) -> None:
        self.buf = (self.buf + chunk).replace(b'\r\n', b'\n')
        while b'\n\n' in self.buf:
            ev, self.buf = self.buf.split(b'\n\n', 1)
            self._event(ev)
        if len(self.buf) > 4 * 1024 * 1024:
            self.buf = b''

    def close(self) -> None:
        if self.buf.strip():
            self._event(self.buf)
        self.buf = b''

    def _event(self, raw: bytes) -> None:
        data = b'\n'.join(line[5:].lstrip() for line in raw.split(b'\n') if line.startswith(b'data:'))
        if not data:
            return
        try:
            e = json.loads(data)
        except ValueError:
            return
        if not isinstance(e, dict):
            return
        t = e.get('type')
        if t == 'message_start' and isinstance(e.get('message'), dict):
            m = e['message']
            self.out['model'] = m.get('model')
            self.out['response_id'] = m.get('id')
            if isinstance(m.get('usage'), dict):
                self._usage = dict(m['usage'])
                self.out['usage'] = self._usage
        elif t == 'message_delta':
            u = e.get('usage')
            if isinstance(u, dict):
                self._usage = {**(self._usage or {}), **{k: v for k, v in u.items() if v is not None}}
                self.out['usage'] = self._usage
            d = e.get('delta') if isinstance(e.get('delta'), dict) else {}
            if d.get('stop_reason'):
                self.out['stop_reason'] = str(d['stop_reason'])[:40]
        elif t == 'message_stop':
            self.out['terminal'] = 'message_stop'
        elif t == 'error':
            err = e.get('error') if isinstance(e.get('error'), dict) else {}
            self.out['error_code'] = str(err.get('type') or 'error')[:60]


def anthropic_json_meta(raw: bytes) -> dict[str, Any]:
    try:
        j = json.loads(raw)
    except ValueError:
        return {}
    if not isinstance(j, dict):
        return {}
    err = j.get('error') if isinstance(j.get('error'), dict) else {}
    shape = 'error-object' if err else 'error-string' if isinstance(j.get('error'), str) else 'message' if 'message' in j or 'Message' in j else None
    return {'model': j.get('model'), 'usage': j.get('usage'), 'response_id': j.get('id'),
            'stop_reason': str(j['stop_reason'])[:40] if j.get('stop_reason') else None,
            'terminal': 'message' if j.get('type') == 'message' else None,
            'error_code': (str(err.get('type') or err.get('code'))[:60] if err else None), 'error_shape': shape}


def default_paths(out: pathlib.Path) -> dict[str, pathlib.Path]:
    return {'calls': out / 'calls.jsonl', 'events': out / 'cap-events.jsonl', 'state': out / 'proxy-state.json',
            'alerts': out / 'alerts.jsonl'}


def make_ledger(out: pathlib.Path, cap_usd: float = DEFAULT_CAP_USD, **kw: Any) -> CapLedger:
    p = default_paths(out)
    return CapLedger(p['events'], p['state'], cap_usd=cap_usd, **kw)


def serve_in_thread(srv: RunnerProxy) -> threading.Thread:
    t = threading.Thread(target=srv.serve_forever, name='llmar-proxy', daemon=True)
    t.start()
    return t
