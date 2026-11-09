"""Pre-registered trial classification (design §7.4). A deterministic function of logged fields only: Harbor's
result.json (exception type, verifier reward, timings), the proxy's per-trial summary (statuses, error origins,
the session's last model call, cap stop), whether the collected patch exists, the host counters over the trial's
window, and how the driver ended the process. It never looks at whether a reward is good or bad, only at
whether it exists.

| class | action | when |
|---|---|---|
| agent | score (verifier reward; no patch = 0) | verifier ran; agent timeout; context window or output limit; refusal; Codex exits non-zero with its last model call answered; task-container OOM within the task's limit |
| sut | score_zero | the session's last model call failed with an error the router generated (the router is the treatment) |
| upstream | rerun | the session's last model call failed upstream or at the gateway with 5xx, 429, 408 or 404 (model not found), a stream error without a request-problem code, or a transport drop |
| agent (from a failed call) | score | the session's last model call failed upstream or at the gateway with any other 4xx (invalid request, context length, content filter, 413/422), or a stream error whose code names a request problem (0d F1/F4) |
| harness | rerun | proxy errors (token, ledger, refusals), gateway or upstream 401/403, environment, image or sidecar failures, a host (global) OOM kill of one of the trial's processes whatever the outcome (§7.7), a crashed or killed Harbor process, Codex failing before any model call, any exception type not in these tables |
| verifier_infra | reverify (re-run only the verifier); rerun if the patch is lost | verifier timeout, crash (reward −1 sentinel), missing, empty or unparsable reward, verifier-phase upload failures |
| cap_stop | exclude | the proxy's hard cap refused a call of this trial (in-flight trials at a cap stop are excluded, never rerun) |
| cancelled | rerun (not counted as a rerun) | the operator stopped the driver and it cancelled the trial |

Claude Code only (0c, 2026-11-07): a trial with any model call that never reached the router (the gateway's fallback
answered it, fallback_calls) is `harness` / rerun whatever else happened, unless it is a cap stop or was cancelled.
The merge-time router-log join applies the same rule post hoc (fleet.py: `router_short`, then `requeue`).

Claude Code only (0d design-stats §18, Amendment 9): a refusal whose fallback the pin blocks is `sut` / score_zero,
reason `refusal_fallback_blocked`, never rerun (refusal_fallback_blocked: the pinned model refused, Claude Code
switched the session to its built-in fallback model, hproxy's pool check refused that request, and the session
ended on it). fleet.py merge applies it post hoc to the recorded attempts (the first such attempt is the key's
final; later ones are superseded).

Agent-scored classes need a verifier reward. If the agent phase ended with an agent exception before the
verifier ran, the action is `reverify` when a patch was collected, and `score_zero` when none was (no commit
means no patch, which scores 0).
The driver caps reruns at 2 and re-verifies at 2 per (task, arm, rep); still errored after that, the trial is
`excluded` (pairwise complete; design §7.4).

Terminal-Bench 2.1 (TB design §6.3, 0d §7.4/7.5), only when the driver passes `verifier` evidence (the TB profile):
the verifier is shared (it runs in the trial container after the agent) and installs its test tools from the
internet, and there is no patch artifact, so nothing can be re-verified:
- (a) `verifier_infra` is always a rerun;
- (b) reward 0 AND the test runner did not run (no verifier/ctrf.json, or 0 tests in it) AND a network-error pattern
  (NET_ERROR_PATTERNS) in verifier/test-stdout.txt AND the agent changed no network configuration (lookupscan's
  `net_config_touched` is False) → `verifier_infra`, rerun. This is the one rule that reads a reward value; it is
  pre-registered and fixed before the pilot. Anything else with reward 0 stays an agent outcome;
- (c) an agent exception before the verifier ran (no reward) → `verifier_infra`, rerun (DeepSWE: no patch = 0).
The oracle/null checks apply (b) without the lookupscan condition (no agent runs there).
"""
from __future__ import annotations

import hashlib
import pathlib
import re
from typing import Any

# Harbor 0.25.0 exception type names (models/trial/error_policy.py), regrouped by the §7.4 table.
AGENT_LIMITS = frozenset({'AgentTimeoutError', 'ContextWindowExceededError', 'OutputTokenExceededError',
                          'ContextLengthExceededError', 'OutputLengthExceededError'})
AGENT_REFUSAL = frozenset({'AgentSafetyRefusalError', 'ContentPolicyViolationError'})
NONZERO_EXIT = frozenset({'NonZeroAgentExitCodeError', 'ClaudeCodeNoResult'})
OOM = frozenset({'SandboxLikelyOutOfMemoryError', 'MemoryLimitExceededError'})
SANDBOX = frozenset({'EnvironmentStartTimeoutError', 'SandboxBuildFailedError', 'AgentSetupTimeoutError', 'HealthcheckError',
                     'SSHAccessError', 'GKEExecStreamClosedError', 'GKEPodNotFoundError', 'RuntimeRequestError'})
VERIFIER_PHASE_SANDBOX = frozenset({'AddTestsDirError', 'DownloadVerifierDirError'})
VERIFIER_ERRORS = frozenset({'VerifierTimeoutError', 'RewardFileNotFoundError', 'RewardFileEmptyError', 'VerifierOutputParseError'})
PROVIDER = frozenset({'ApiError', 'ApiRateLimitError', 'ApiInternalServerError', 'ApiOverloadedError', 'ApiConnectionClosedError',
                      'ApiResponseStalledError', 'UnknownApiError', 'NetworkConnectionError', 'ApiConnectionError', 'ApiUsageLimitError',
                      'RateLimitError', 'InternalServerError', 'ServiceUnavailableError', 'APIConnectionError', 'APIError', 'Timeout',
                      'BadRequestError', 'UnprocessableEntityError', 'UnsupportedParamsError', 'APIResponseValidationError',
                      'BudgetExceededError'})
MODEL_NOT_FOUND = frozenset({'ModelNotFoundError', 'ApiProviderResourceNotFoundError', 'NotFoundError'})
AUTH = frozenset({'AgentAuthenticationError', 'AuthenticationError', 'PermissionDeniedError'})
HARBOR = frozenset({'ServiceOperationsUnsupportedError', 'VercelScopeError', 'DspyImportError', 'MissingExtraError', 'RegradeError'})
CANCELLED = frozenset({'CancelledError'})

CLASSES = ('agent', 'sut', 'upstream', 'harness', 'verifier_infra', 'cap_stop', 'cancelled')
ACTIONS = ('score', 'score_zero', 'reverify', 'rerun', 'exclude')
SCORED = frozenset({'agent', 'sut'})
RERUN_CLASSES = frozenset({'upstream', 'harness', 'verifier_infra'})   # count toward the 2-rerun limit

# TB rule (b): messages of the tools the 89 test.sh files use to install their test runner (curl, apt-get, the
# astral uv installer, uv/uvx, pip) when the network fails, plus resolver and socket errors. 4f reproduced them on a
# TB-style image with DNS blackholed, --network none and connection refused (the runner's egress gives a fast RST or
# ICMP for anything but TCP 80/443 to public IPv4). pip's no-network error lines ("Could not find a version that
# satisfies …", "No matching distribution found") are left out on purpose: pip prints them for a missing version too;
# its network evidence is the retry warnings (NewConnectionError, …). Case-insensitive.
NET_ERROR_PATTERNS: tuple[tuple[str, str], ...] = (
    ('curl', r'curl: \((?:6|7|28|35|52|56)\)'),
    ('apt-resolve', r'Temporary failure resolving'), ('apt-resolve2', r"Could not resolve '"),
    ('apt-connect', r'Could not connect to'), ('apt-fetch', r'Failed to fetch http'),
    ('apt-archives', r'Unable to fetch some archives'), ('apt-err', r'^Err:\d+ https?://'),
    ('apt-index', r'Some index files failed to download'),
    ('uv-download', r'failed to download'), ('uv-request', r'error sending request for url'), ('uv-dns', r'dns error'),
    ('uv-tcp', r'tcp connect error'), ('uv-retries', r'Request failed after \d+ retries'), ('uv-fetch', r'error: Failed to fetch'),
    ('uv-lookup', r'failed to lookup address information'), ('timed-out', r'operation timed out'),
    ('pip-conn', r'NewConnectionError'), ('pip-connect-timeout', r'ConnectTimeoutError'), ('pip-read-timeout', r'ReadTimeoutError'),
    ('pip-retries', r'Max retries exceeded with url'),
    ('resolver', r'Temporary failure in name resolution'), ('resolver2', r'Name or service not known'),
    ('net-unreachable', r'Network is unreachable'), ('no-route', r'No route to host'),
    ('conn-reset', r'Connection reset by peer'), ('conn-refused', r'Connection refused'),
)
_NET_RES = tuple((name, re.compile(rx, re.IGNORECASE | re.MULTILINE)) for name, rx in NET_ERROR_PATTERNS)
VERSION = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()   # recorded in run-config (TB, §7.4)


def net_error(test_stdout: str | None) -> str | None:
    """The first NET_ERROR_PATTERNS name found in the verifier's stdout, else None."""
    if not test_stdout:
        return None
    for name, rx in _NET_RES:
        if rx.search(test_stdout):
            return name
    return None


def tests_ran(ctrf: dict[str, Any] | None) -> bool:
    """True if pytest's CTRF report exists and counts at least one test."""
    summ = ((ctrf or {}).get('results') or {}).get('summary') or {}
    n = summ.get('tests')
    return isinstance(n, int) and not isinstance(n, bool) and n > 0


def net_flake(reward: float | None, verifier: dict[str, Any], *, need_untouched: bool = True) -> bool:
    """TB rule (b)."""
    return (reward == 0 and verifier.get('tests_ran') is not True and bool(verifier.get('net_error'))
            and (verifier.get('net_config_touched') is False or not need_untouched))


def exception_type(result: dict[str, Any] | None) -> str | None:
    """The trial's first recorded exception (Harbor records only the first; multi-step trials record per step)."""
    if not result:
        return None
    ei = result.get('exception_info')
    if isinstance(ei, dict) and ei.get('exception_type'):
        return str(ei['exception_type'])
    for step in result.get('step_results') or []:
        ei = (step or {}).get('exception_info')
        if isinstance(ei, dict) and ei.get('exception_type'):
            return str(ei['exception_type'])
    return None


def reward_of(result: dict[str, Any] | None) -> float | None:
    """The verifier's `reward` (DeepSWE: binary 0/1, −1 is the verifier crash sentinel). A single-key rewards
    dict counts as the reward; anything else is None."""
    vr = (result or {}).get('verifier_result') or {}
    rewards = vr.get('rewards') if isinstance(vr, dict) else None
    if not isinstance(rewards, dict) or not rewards:
        return None
    v = rewards.get('reward', next(iter(rewards.values())) if len(rewards) == 1 else None)
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def agent_finished(result: dict[str, Any] | None) -> bool:
    ae = (result or {}).get('agent_execution') or {}
    return isinstance(ae, dict) and bool(ae.get('finished_at'))


def session_error(proxy: dict[str, Any] | None) -> dict[str, Any] | None:
    """The session's last model call if it failed ({origin, status, code}), else None."""
    if not proxy:
        return None
    last = proxy.get('last_call')
    if not isinstance(last, dict) or last.get('ok', True):
        return None
    return {'origin': str(last.get('origin') or 'transport'), 'status': last.get('status'), 'code': last.get('code'),
            'model_not_found': bool(last.get('model_not_found'))}


_INFRA_CODE = ('rate_limit', 'throttl', 'server_error', 'internal', 'overload', 'unavailable', 'timeout', 'timed_out',
               'service', 'capacity', 'model_not_found', 'not_found')


def failed_call_class(err: dict[str, Any]) -> str:
    """0d's F1/F4 split of a session-ending failed model call, on its origin, HTTP status and error code only:
    - router: 'sut' (the router is the treatment);
    - proxy: 'harness';
    - transport (connection or stream drop): 'upstream';
    - upstream or gateway: 5xx, 429, 408 and 404 (model not found) are 'upstream'. 401 and 403 (JWT, token,
      access) are 'harness'. Any other 4xx (invalid request, context length, content filter, 413, 422) is
      'agent', a deterministic outcome of what the agent sent. A stream error event (no status) is
      'upstream', unless its code names a request problem rather than a service problem, which makes it
      'agent'."""
    origin, status, code = err.get('origin'), err.get('status'), str(err.get('code') or '').lower()
    if origin == 'router':
        return 'sut'
    if origin == 'proxy':
        return 'harness'
    if origin not in ('upstream', 'gateway'):
        return 'upstream'
    if err.get('model_not_found'):   # §7.4: model-not-found is upstream infrastructure, whatever its status (Bedrock may say 400)
        return 'upstream'
    if isinstance(status, int) and status >= 400:
        if status >= 500 or status in (429, 408, 404):
            return 'upstream'
        if status in (401, 403):
            return 'harness'
        return 'agent'
    if code and not any(k in code for k in _INFRA_CODE):
        return 'agent'
    return 'upstream'


def host_oom(host: dict[str, Any] | None) -> bool:
    """A host-level (global, not cgroup-limit) OOM kill hit this trial: the kernel log names one of the trial's
    containers as the victim of a CONSTRAINT_NONE kill, or a global kill happened in the window while one of the
    trial's containers died with 137 and no limit OOM explains it (design §7.4/§7.7: host faults are
    infrastructure)."""
    if not host:
        return False
    if int(host.get('oom_global_trial') or 0) > 0:
        return True
    return (int(host.get('oom_global_window') or 0) > 0 and int(host.get('exit137') or 0) > 0
            and int(host.get('oom_memcg_trial') or 0) == 0)


def _out(cls: str, action: str, reason: str, reward: float | None, exc: str | None) -> dict[str, Any]:
    assert cls in CLASSES and action in ACTIONS
    score = None
    if action == 'score':
        score = 1.0 if (reward or 0) > 0 else 0.0
    elif action == 'score_zero':
        score = 0.0
    return {'class': cls, 'action': action, 'reason': reason, 'reward': reward, 'score': score, 'exception_type': exc}


def _agent(reason: str, reward: float | None, exc: str | None, patch_bytes: int | None,
           verifier: dict[str, Any] | None = None) -> dict[str, Any]:
    if verifier is not None:   # TB: shared verifier, no patch (module docstring, rules a–c)
        if reward is not None and reward >= 0:
            if net_flake(reward, verifier):
                return _out('verifier_infra', 'rerun', f"{reason}; tests never ran: verifier network ({verifier['net_error']})", reward, exc)
            return _out('agent', 'score', reason, reward, exc)
        if reward is not None:
            return _out('verifier_infra', 'rerun', f'{reason}; verifier crashed (reward {reward:g})', reward, exc)
        return _out('verifier_infra', 'rerun', f'{reason}; no verifier result (nothing to re-verify)', None, exc)
    if reward is not None and reward >= 0:
        return _out('agent', 'score', reason, reward, exc)
    if reward is not None:   # the crash sentinel: the verifier itself failed on an intact trial
        return _out('verifier_infra', 'reverify' if patch_bytes is not None else 'rerun', f'{reason}; verifier crashed (reward {reward:g})', reward, exc)
    if patch_bytes is not None:
        return _out('agent', 'reverify', f'{reason}; no verifier result, patch collected', None, exc)
    return _out('agent', 'score_zero', f'{reason}; no verifier result and no patch', None, exc)


AGENT_COMMS = frozenset({'claude', 'bun', 'node'})   # Claude Code's process names in a container (OOM victim split)
CC_NO_RESULT = 'ClaudeCodeNoResult'   # no stream-json `result` event: Harbor pipes claude into tee without pipefail (4f)


def main_view(proxy: dict[str, Any] | None) -> dict[str, Any] | None:
    """Claude Code (CC design §4; 0d design-stats §11, Amendment 2): the proxy summary seen through the root session's
    main-loop calls. 4f's summary keeps the all-call keys and adds `calls_by_role` {main, main_subagent, helper}; the
    `main` entry carries {calls, statuses, error_origins, last_call} besides the cost keys. Subagent and helper calls
    (Task subagents, Haiku titles, summaries, Explore) never decide the session's outcome: a failed one is returned to
    the main loop, which goes on. Without the split (Codex, or no roles recorded): the summary as it is."""
    if not proxy:
        return proxy
    roles = proxy.get('calls_by_role')
    m = roles.get('main') if isinstance(roles, dict) else proxy.get('main')
    if not isinstance(m, dict):
        return proxy
    return {**proxy, **{k: m[k] for k in ('calls', 'statuses', 'error_origins', 'last_call') if k in m}}


def oom_tags(result: dict[str, Any] | None, host: dict[str, Any] | None) -> list[str]:
    """Claude Code (CC design §2.4, 0d §9/§10): a container-limit OOM of the trial (kernel memcg kill, docker oom
    event, the cgroup's memory.events oom_kill, or Harbor's OOM exception) is tagged with its victim (agent = claude,
    bun or node; workload; unknown). Tags never change the class: the run is scored by the verifier if it ran. A host
    (global) OOM is not tagged here; it is a harness rerun."""
    h = host or {}
    mem = h.get('mem') or {}
    container = (int(h.get('oom_memcg_trial') or 0) > 0 or int(h.get('docker_oom') or 0) > 0 or int(mem.get('oom_kill') or 0) > 0
                 or exception_type(result) in OOM)
    if not container or host_oom(host):
        return []
    victims = [str(v) for v in h.get('oom_victims') or []]
    who = 'agent' if any(v in AGENT_COMMS for v in victims) else ('workload' if victims else 'unknown')
    return ['oom-container', f'victim:{who}']


def fallback_calls(proxy: dict[str, Any] | None) -> int:
    """Claude Code (0c, 2026-11-07): model calls of the trial, of any role, that the gateway answered without the router
    (its Bedrock fallback serves any body model that is not `auto*`). That is 4f's per-trial `gateway_fallback_calls`
    (a 2xx or a relayed Bedrock error without x-router-* headers), and at least calls_summary's count of 200s without
    router headers."""
    if not proxy:
        return 0
    top = proxy.get('gateway_fallback_calls')
    floor = (proxy.get('calls_summary') or {}).get('gateway_fallback_calls')
    return max(int(v) for v in (top, floor, 0) if isinstance(v, int) and not isinstance(v, bool))


REFUSAL_FALLBACK = 'refusal_fallback_blocked'   # 0d design-stats §18 (Amendment 9): the class reason
POOL_REFUSED = 'model-not-allowed'   # hproxy._check_body's only refusal of a body model: the model is not in cc_calls.POOL
NOT_REFUSAL_FALLBACK_CLASSES = ('cap_stop', 'cancelled')


def _is_model_record(c: dict[str, Any]) -> bool:
    leaf = c.get('leaf')
    return leaf in ('messages', 'responses') or (leaf is None and c.get('method') in (None, 'POST'))


def refusal_evidence(calls: list[dict[str, Any]]) -> dict[str, Any]:
    """The refusal-fallback evidence of one trial from its proxy call records (merged calls.jsonl), in the shape
    hproxy's trial summary gives it at run time: `refusals` {served_model: model calls with stop_reason refusal} and
    the trial's last model call (t_start, then seq order) {status, origin, refused}. Count_tokens and other local
    records are not model calls."""
    model = sorted((c for c in calls if _is_model_record(c)),
                   key=lambda c: (float(c.get('t_start') or 0.0), int(c['seq']) if isinstance(c.get('seq'), int) else 0))
    refusals: dict[str, int] = {}
    for c in model:
        if c.get('stop_reason') == 'refusal':
            refusals[str(c.get('served_model'))] = refusals.get(str(c.get('served_model')), 0) + 1
    last = model[-1] if model else None
    return {'refusals': refusals,
            'last_call': {k: last.get(k) for k in ('status', 'origin', 'refused', 'seq', 't_start')} if last else None}


def summary_refusal_evidence(proxy: dict[str, Any] | None) -> dict[str, Any]:
    """The same evidence from hproxy's per-trial summary (`refusals`, last_call, last_failure). The last call's
    `refused` is last_failure's when the last call is itself a failure (last_failure is the last call with an origin)."""
    p = proxy or {}
    last, lf = p.get('last_call'), p.get('last_failure') or {}
    if not isinstance(last, dict):
        return {'refusals': dict(p.get('refusals') or {}), 'last_call': None}
    same = last.get('origin') is not None and lf.get('status') == last.get('status') and lf.get('origin') == last.get('origin')
    return {'refusals': dict(p.get('refusals') or {}),
            'last_call': {'status': last.get('status'), 'origin': last.get('origin'), 'refused': lf.get('refused') if same else None}}


def refusal_fallback_blocked(ev: dict[str, Any] | None, m_arm: str | None) -> bool:
    """0d design-stats §18 (Amendment 9), from refusal_evidence or summary_refusal_evidence; reward-blind. All of:
    - ≥ 1 model call with stop_reason `refusal` served by M_arm;
    - after it, a request with requested_model ≠ M_arm that hproxy answered 403 `model-not-allowed`. hproxy records
      no body field of a request it refuses, so the record has no requested_model; the refusal reason establishes it:
      hproxy's only model-not-allowed answer to a Messages request is its pool check (cc_calls.POOL), and M_arm is in
      the pool, so the request named another model (Claude Code's built-in refusal fallback);
    - that request is the trial's last model call, so it is the session's terminal API error (every refusal call
      precedes it).
    m_arm None (an auto arm without an assessed tier) never matches."""
    if not ev or m_arm is None:
        return False
    last = ev.get('last_call') or {}
    return (int((ev.get('refusals') or {}).get(m_arm) or 0) >= 1 and last.get('status') == 403 and last.get('origin') == 'proxy'
            and last.get('refused') == POOL_REFUSED)


def refusal_fallback_outcome(out: dict[str, Any], *, killed: str | None, host: dict[str, Any] | None,
                             fallback: int = 0) -> dict[str, Any] | None:
    """The §18 outcome replacing `out` (the attempt's classification) once refusal_fallback_blocked holds: `sut` /
    score_zero, reason REFUSAL_FALLBACK, with the replaced classification under `reclassified_from`. None (keep
    `out`) for a cap stop, a cancelled or killed trial, a host OOM, or a call that never reached the router: those
    rules come first."""
    if out.get('class') in NOT_REFUSAL_FALLBACK_CLASSES or killed or host_oom(host) or fallback:
        return None
    if out.get('class') == 'sut' and out.get('reason') == REFUSAL_FALLBACK:
        return None
    new = _out('sut', 'score_zero', REFUSAL_FALLBACK, out.get('reward'), out.get('exception_type'))
    return {**new, 'tags': out.get('tags') or [],
            'reclassified_from': {k: out.get(k) for k in ('class', 'action', 'reason')}}


def classify(result: dict[str, Any] | None, proxy: dict[str, Any] | None = None, *, killed: str | None = None,
             patch_bytes: int | None = None, host: dict[str, Any] | None = None, rc: int | None = None,
             verifier: dict[str, Any] | None = None, agent: str | None = None, cc: dict[str, Any] | None = None,
             m_arm: str | None = None) -> dict[str, Any]:
    """The §7.4 classification of one attempt. `agent='claude-code'` (CC design §4): the proxy summary is read through
    its main-loop calls (main_view); a run without a stream-json `result` event (`cc` = {'result': 'missing'}) and
    no Harbor exception is a Claude Code crash, classified as a non-zero exit (harness before any main call, else
    agent or the failed call's class); container OOMs are tagged (oom_tags). A trial with any call that never reached
    the router (fallback_calls) is a harness rerun, never scored (0c), unless it is a cap stop or was cancelled. A
    refusal whose fallback the pin blocks (refusal_fallback_blocked, with `m_arm` the arm's pinned model) is sut /
    score_zero (0d §18). agent=None is the Codex path, unchanged."""
    if agent != 'claude-code':
        return _classify(result, proxy, killed=killed, patch_bytes=patch_bytes, host=host, rc=rc, verifier=verifier)
    view = main_view(proxy)
    res = result
    if result is not None and exception_type(result) is None and (cc or {}).get('result') == 'missing':
        res = {**result, 'exception_info': {'exception_type': CC_NO_RESULT}}
    out = _classify(res, view, killed=killed, patch_bytes=patch_bytes, host=host, rc=rc, verifier=verifier)
    fb = fallback_calls(proxy)
    if refusal_fallback_blocked(summary_refusal_evidence(proxy), m_arm):
        rf = refusal_fallback_outcome(out, killed=killed, host=host, fallback=fb)
        if rf is not None:
            return {**rf, 'tags': oom_tags(result, host)}
    if fb and out['class'] not in ('cap_stop', 'cancelled'):
        why = f"{fb} of {int((proxy or {}).get('calls') or 0)} model calls never reached the router (gateway fallback)"
        out = _out('harness', 'rerun', why + (f"; {out['reason']}" if out['class'] == 'harness' else ''), out['reward'], out['exception_type'])
    return {**out, 'tags': oom_tags(result, host)}


def _classify(result: dict[str, Any] | None, proxy: dict[str, Any] | None = None, *, killed: str | None = None,
              patch_bytes: int | None = None, host: dict[str, Any] | None = None, rc: int | None = None,
              verifier: dict[str, Any] | None = None) -> dict[str, Any]:
    """`verifier` (TB profile only; None keeps the DeepSWE rules exactly): {'tests_ran', 'net_error',
    'net_config_touched'} from the trial dir and lookupscan (module docstring). `killed`: 'operator' (the driver was stopped and cancelled the trial), 'wall-timeout' (the driver's
    watchdog), 'driver-restart' (found orphaned after a driver crash) or None. `patch_bytes`: the size of
    artifacts/model.patch, None if the file is absent. `host` (kernel log and docker events over the trial's
    window): oom_global_trial / oom_memcg_trial (kernel OOM kills of this trial's containers, global or at the
    container's own limit), oom_global_window (all global kills in the window), exit137 (the trial's containers that
    died with 137)."""
    exc = exception_type(result)
    reward = reward_of(result)
    if proxy and proxy.get('cap_stopped'):
        return _out('cap_stop', 'exclude', 'the proxy hard cap refused a call of this trial', reward, exc)
    if killed == 'operator' or (exc in CANCELLED and killed is None):
        return _out('cancelled', 'rerun', 'cancelled by the operator stopping the driver', reward, exc)
    if killed:
        return _out('harness', 'rerun', f'killed: {killed}', reward, exc)
    if result is None:
        return _out('harness', 'rerun', f'no result.json (harbor exit {rc})', None, None)
    if exc in CANCELLED:
        return _out('harness', 'rerun', 'cancelled inside Harbor', reward, exc)
    if host_oom(host):
        return _out('harness', 'rerun', 'host OOM killed a process of this trial', reward, exc)

    if exc in AGENT_LIMITS or exc in AGENT_REFUSAL:
        return _agent(f'agent outcome: {exc}', reward, exc, patch_bytes, verifier)
    if exc in OOM:
        return _agent(f'agent outcome: {exc} within the task memory limit', reward, exc, patch_bytes, verifier)
    if exc in SANDBOX:
        return _out('harness', 'rerun', f'environment: {exc}', reward, exc)
    if exc in VERIFIER_PHASE_SANDBOX:
        if agent_finished(result) and patch_bytes is not None:
            return _out('verifier_infra', 'reverify', f'verifier setup: {exc}', reward, exc)
        return _out('harness', 'rerun', f'environment: {exc}', reward, exc)
    if exc in HARBOR:
        return _out('harness', 'rerun', f'harbor: {exc}', reward, exc)
    if exc in AUTH:
        return _out('harness', 'rerun', f'auth: {exc}', reward, exc)

    err = session_error(proxy)
    if err is not None and (exc is None or exc in NONZERO_EXIT or exc in PROVIDER or exc in VERIFIER_ERRORS or exc in MODEL_NOT_FOUND):
        cls = failed_call_class(err)
        why = f"session ended on a failed model call (origin {err['origin']}, status {err['status']}" + (f", code {err['code']})" if err.get('code') else ')')
        if cls == 'sut':
            return _out('sut', 'score_zero', why, reward, exc)
        if cls == 'agent':
            if exc in VERIFIER_ERRORS:
                return _out('verifier_infra', 'reverify' if patch_bytes is not None else 'rerun', f'{why}; verifier: {exc}', reward, exc)
            return _agent(f'agent outcome: {why}', reward, exc, patch_bytes, verifier)
        return _out(cls, 'rerun', why, reward, exc)
    if exc in MODEL_NOT_FOUND:
        return _out('upstream', 'rerun', f'model not found: {exc}', reward, exc)
    if exc in PROVIDER:
        return _out('upstream', 'rerun', f'provider: {exc}', reward, exc)
    if exc in NONZERO_EXIT:
        if proxy is not None and int(proxy.get('calls') or 0) == 0:
            return _out('harness', 'rerun', 'Codex exited non-zero before any model call', reward, exc)
        return _agent('agent outcome: Codex exited non-zero with its last model call answered', reward, exc, patch_bytes, verifier)
    if exc in VERIFIER_ERRORS:
        if patch_bytes is not None:
            return _out('verifier_infra', 'reverify', f'verifier: {exc}', reward, exc)
        return _out('verifier_infra', 'rerun', f'verifier: {exc}, patch lost' if verifier is None else f'verifier: {exc}', reward, exc)
    if exc is not None:
        return _out('harness', 'rerun', f'unclassified: {exc}', reward, exc)
    if reward is None:
        return _out('harness', 'rerun', 'no exception and no verifier reward', None, None)
    return _agent('verified', reward, None, patch_bytes, verifier)


def classify_reverify(regrade: dict[str, Any] | None, original: dict[str, Any], *, rc: int | None = None) -> dict[str, Any]:
    """The outcome of a verifier-only re-run (`harbor jobs regrade`) of a trial whose action was `reverify`.
    The agent phase is the original one, so a good reward gives the original's agent class (or `agent` for a
    verifier_infra original); a verifier failure stays `verifier_infra` and may be re-verified again."""
    if regrade is None:
        return _out('verifier_infra', 'reverify', f'regrade produced no result.json (exit {rc})', None, None)
    exc = exception_type(regrade)
    reward = reward_of(regrade)
    if exc is None and reward is not None and reward >= 0:
        cls = original['class'] if original['class'] in SCORED else 'agent'
        return _out(cls, 'score', f"re-verified ({original['reason']})", reward, original.get('exception_type'))
    why = f'regrade: {exc}' if exc else (f'regrade: verifier crashed (reward {reward:g})' if reward is not None else 'regrade: no reward')
    return _out('verifier_infra', 'reverify', why, reward, exc)


def check_verdict(kind: str, result: dict[str, Any] | None, *, killed: str | None = None, rc: int | None = None,
                  verifier: dict[str, Any] | None = None) -> dict[str, Any]:
    """Oracle (reference solution applied) and null (unmodified base, nop agent) checks, no model calls (design
    §7.4). `ok` is True if the check gave the expected reward (oracle 1, null 0), False if it gave the other one,
    and None if it hit an infrastructure error (rerun the check; never drop a task for that)."""
    if kind not in ('oracle', 'nop'):
        raise ValueError(kind)
    exc = exception_type(result)
    reward = reward_of(result)
    if killed or result is None:
        return {'ok': None, 'reward': reward, 'exception_type': exc, 'reason': f'infra: {killed or f"no result.json (exit {rc})"}'}
    if exc is not None and exc not in AGENT_LIMITS:
        return {'ok': None, 'reward': reward, 'exception_type': exc, 'reason': f'infra: {exc}'}
    if reward is None or reward < 0:
        return {'ok': None, 'reward': reward, 'exception_type': exc, 'reason': 'infra: no valid verifier reward'}
    if verifier is not None and net_flake(reward, verifier, need_untouched=False):
        return {'ok': None, 'reward': reward, 'exception_type': exc, 'reason': f"infra: tests never ran: verifier network ({verifier['net_error']})"}
    want = 1.0 if kind == 'oracle' else 0.0
    passed = reward > 0
    ok = passed == (want > 0)
    what = 'reference solution' if kind == 'oracle' else 'unmodified base'
    return {'ok': ok, 'reward': reward, 'exception_type': exc,
            'reason': f"{what} {'passes' if passed else 'fails'}" + ('' if ok else f" (expected {'pass' if want else 'fail'})")}
