"""Pre-registered classification (design §7.4): every rule of classify.py on logged fields only."""
import pytest

import classify as c


def res(reward=None, exc=None, agent_done=True):
    return {'exception_info': {'exception_type': exc} if exc else None,
            'verifier_result': {'rewards': {'reward': reward}} if reward is not None else None,
            'agent_execution': {'finished_at': '2026-11-05T01:00:00Z' if agent_done else None}}


OK = {'calls': 12, 'last_call': {'status': 200, 'origin': None, 'ok': True}, 'cap_stopped': False}


def px(status, origin, calls=12):
    return {'calls': calls, 'last_call': {'status': status, 'origin': origin, 'ok': False}, 'cap_stopped': False}


@pytest.mark.parametrize('result,proxy,kw,cls,action', [
    (res(1.0), OK, {}, 'agent', 'score'),
    (res(0.0), OK, {}, 'agent', 'score'),
    (res(0.0, 'AgentTimeoutError'), OK, {}, 'agent', 'score'),
    (res(None, 'ContextWindowExceededError'), OK, {'patch_bytes': 120}, 'agent', 'reverify'),
    (res(None, 'ContextWindowExceededError'), OK, {}, 'agent', 'score_zero'),
    (res(0.0, 'AgentSafetyRefusalError'), OK, {}, 'agent', 'score'),
    (res(0.0, 'NonZeroAgentExitCodeError'), OK, {}, 'agent', 'score'),
    (res(0.0, 'NonZeroAgentExitCodeError'), px(500, 'router'), {}, 'sut', 'score_zero'),
    (res(1.0, 'NonZeroAgentExitCodeError'), px(503, 'upstream'), {}, 'upstream', 'rerun'),
    (res(0.0, 'NonZeroAgentExitCodeError'), px(None, 'transport'), {}, 'upstream', 'rerun'),
    (res(0.0, 'NonZeroAgentExitCodeError'), px(429, 'gateway'), {}, 'upstream', 'rerun'),
    (res(0.0, 'NonZeroAgentExitCodeError'), px(502, 'proxy'), {}, 'harness', 'rerun'),
    (res(0.0, 'NonZeroAgentExitCodeError'), {**OK, 'calls': 0}, {}, 'harness', 'rerun'),
    (res(1.0), px(500, 'upstream'), {}, 'upstream', 'rerun'),   # exit 0 but the session ended on an upstream error
    (res(None, 'EnvironmentStartTimeoutError', agent_done=False), None, {}, 'harness', 'rerun'),
    (res(None, 'SandboxBuildFailedError', agent_done=False), None, {}, 'harness', 'rerun'),
    (res(None, 'VerifierTimeoutError'), OK, {'patch_bytes': 10}, 'verifier_infra', 'reverify'),
    (res(None, 'VerifierTimeoutError'), OK, {}, 'verifier_infra', 'rerun'),
    (res(None, 'RewardFileNotFoundError'), OK, {'patch_bytes': 0}, 'verifier_infra', 'reverify'),
    (res(-1.0), OK, {'patch_bytes': 10}, 'verifier_infra', 'reverify'),
    (res(None, 'DownloadVerifierDirError'), OK, {'patch_bytes': 10}, 'verifier_infra', 'reverify'),
    (res(None, 'DownloadVerifierDirError', agent_done=False), OK, {'patch_bytes': 10}, 'harness', 'rerun'),
    (res(0.0, 'SandboxLikelyOutOfMemoryError'), OK, {}, 'agent', 'score'),
    (res(0.0, 'SandboxLikelyOutOfMemoryError'), OK, {'host': {'oom_global_trial': 1}}, 'harness', 'rerun'),
    (res(1.0), OK, {'host': {'oom_global_trial': 1}}, 'harness', 'rerun'),       # a host fault hit the trial (§7.7)
    (res(0.0), OK, {'host': {'oom_global_window': 2, 'exit137': 1}}, 'harness', 'rerun'),
    (res(0.0), OK, {'host': {'oom_global_window': 2, 'exit137': 1, 'oom_memcg_trial': 1}}, 'agent', 'score'),
    (res(0.0), OK, {'host': {'oom_memcg_trial': 3}}, 'agent', 'score'),
    (res(None, 'ModelNotFoundError'), OK, {}, 'upstream', 'rerun'),
    (res(None, 'AgentAuthenticationError'), OK, {}, 'harness', 'rerun'),
    (res(None, 'SomethingNewError'), OK, {}, 'harness', 'rerun'),
    (res(None), OK, {}, 'harness', 'rerun'),
    (None, None, {'rc': 1}, 'harness', 'rerun'),
    (res(1.0), {**OK, 'cap_stopped': True}, {}, 'cap_stop', 'exclude'),
    (res(1.0), OK, {'killed': 'operator'}, 'cancelled', 'rerun'),
    (res(None, 'CancelledError'), OK, {}, 'cancelled', 'rerun'),
    (res(1.0), OK, {'killed': 'wall-timeout'}, 'harness', 'rerun'),
    (None, None, {'killed': 'driver-restart'}, 'harness', 'rerun'),
])
def test_classification_table(result, proxy, kw, cls, action):
    out = c.classify(result, proxy, **kw)
    assert (out['class'], out['action']) == (cls, action), out['reason']
    assert out['class'] in c.CLASSES and out['action'] in c.ACTIONS


def test_scores_are_binary_and_zero_for_sut():
    assert c.classify(res(1.0), OK)['score'] == 1.0
    assert c.classify(res(0.0), OK)['score'] == 0.0
    assert c.classify(res(1.0, 'NonZeroAgentExitCodeError'), px(500, 'router'))['score'] == 0.0
    assert c.classify(res(None, 'EnvironmentStartTimeoutError'), None)['score'] is None


def test_the_reward_value_never_changes_the_class():
    for r in (0.0, 1.0):
        for exc in (None, 'AgentTimeoutError', 'NonZeroAgentExitCodeError'):
            assert c.classify(res(r, exc), OK)['class'] == 'agent'
        for exc in (None, 'NonZeroAgentExitCodeError'):
            assert c.classify(res(r, exc), px(503, 'upstream'))['class'] == 'upstream'


def test_agent_limits_take_precedence_over_the_last_call():
    # At a 3 h timeout Harbor kills Codex mid-call, so the cut-off call is a consequence, not the cause.
    assert c.classify(res(0.0, 'AgentTimeoutError'), px(None, 'transport'))['class'] == 'agent'
    assert c.classify(res(0.0, 'ContextWindowExceededError'), px(400, 'upstream'))['class'] == 'agent'


def test_reward_extraction():
    assert c.reward_of({'verifier_result': {'rewards': {'reward': 1}}}) == 1.0
    assert c.reward_of({'verifier_result': {'rewards': {'score': 0.0}}}) == 0.0
    assert c.reward_of({'verifier_result': {'rewards': {'a': 1, 'b': 2}}}) is None
    assert c.reward_of({'verifier_result': {'rewards': {'reward': True}}}) is None
    assert c.reward_of({}) is None


def test_reverify_outcomes():
    orig = c.classify(res(None, 'VerifierTimeoutError'), OK, patch_bytes=5)
    good = c.classify_reverify(res(1.0), orig)
    assert (good['class'], good['action'], good['score']) == ('agent', 'score', 1.0)
    again = c.classify_reverify(res(None, 'VerifierTimeoutError'), orig)
    assert (again['class'], again['action']) == ('verifier_infra', 'reverify')
    assert c.classify_reverify(None, orig)['action'] == 'reverify'
    agent_orig = c.classify(res(None, 'ContextWindowExceededError'), OK, patch_bytes=5)
    assert c.classify_reverify(res(0.0), agent_orig)['class'] == 'agent'


@pytest.mark.parametrize('kind,result,ok', [
    ('oracle', res(1.0), True), ('oracle', res(0.0), False), ('oracle', res(-1.0), None),
    ('oracle', res(None, 'EnvironmentStartTimeoutError'), None), ('oracle', None, None),
    ('nop', res(0.0), True), ('nop', res(1.0), False), ('nop', res(None, 'VerifierTimeoutError'), None),
])
def test_check_verdicts(kind, result, ok):
    assert c.check_verdict(kind, result)['ok'] is ok


def pxc(status, origin, code=None):
    return {'calls': 12, 'last_call': {'status': status, 'origin': origin, 'ok': False, 'code': code}, 'cap_stopped': False}


@pytest.mark.parametrize('status,origin,code,cls', [
    (500, 'upstream', None, 'upstream'), (503, 'gateway', None, 'upstream'), (429, 'upstream', 'ThrottlingException', 'upstream'),
    (429, 'gateway', None, 'upstream'), (408, 'upstream', None, 'upstream'), (404, 'upstream', 'model_not_found', 'upstream'),
    (None, 'transport', None, 'upstream'),
    (400, 'upstream', 'invalid_request_error', 'agent'), (400, 'upstream', 'context_length_exceeded', 'agent'),
    (400, 'gateway', None, 'agent'), (413, 'upstream', None, 'agent'), (422, 'upstream', None, 'agent'),
    (401, 'gateway', None, 'harness'), (403, 'gateway', None, 'harness'), (403, 'upstream', 'AccessDeniedException', 'harness'),
    (500, 'router', None, 'sut'), (400, 'router', None, 'sut'), (502, 'proxy', None, 'harness'),
    (None, 'upstream', 'server_error', 'upstream'), (None, 'upstream', 'rate_limit_exceeded', 'upstream'),
    (None, 'upstream', None, 'upstream'), (None, 'upstream', 'context_length_exceeded', 'agent'),
    (None, 'upstream', 'content_filter', 'agent'),
])
def test_failed_last_call_split_by_status_and_code(status, origin, code, cls):
    """0d F1/F4: content-caused 4xx (and stream errors with request-problem codes) are agent outcomes, scored."""
    out = c.classify(res(0.0, 'NonZeroAgentExitCodeError'), pxc(status, origin, code))
    assert out['class'] == cls, out['reason']
    assert out['action'] == {'agent': 'score', 'sut': 'score_zero', 'upstream': 'rerun', 'harness': 'rerun'}[cls]


def test_agent_class_from_a_failed_call_without_a_verifier_result():
    out = c.classify(res(None, 'NonZeroAgentExitCodeError'), pxc(400, 'upstream', 'invalid_request_error'), patch_bytes=50)
    assert (out['class'], out['action']) == ('agent', 'reverify')
    out = c.classify(res(None, 'NonZeroAgentExitCodeError'), pxc(400, 'upstream'))
    assert (out['class'], out['action'], out['score']) == ('agent', 'score_zero', 0.0)


def test_model_not_found_flag_is_upstream_even_on_a_400():
    last = {'calls': 3, 'last_call': {'status': 400, 'origin': 'upstream', 'ok': False, 'code': 'ValidationException', 'model_not_found': True}}
    assert c.classify(res(0.0, 'NonZeroAgentExitCodeError'), last)['class'] == 'upstream'
