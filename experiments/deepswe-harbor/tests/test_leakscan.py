"""leakscan: every credential shape is found, no value is ever printed, and benign look-alikes are not flagged.

Secret-shaped strings are built at run time, so this file itself scans clean (it is in the commit set).
"""
import base64
import gzip
import json

import leakscan as ls


def b64u(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip('=')


def fake_jwt(iss: str) -> str:
    return '.'.join([b64u({'alg': 'RS256', 'kid': 'k1'}), b64u({'iss': iss, 'token_use': 'access', 'scope': 'x/invoke'}),
                     'c2lnbmF0dXJlLXBhcnQtZm9yLXRlc3Rz'])


# 12-digit values are built at run time: the folder's N5 test forbids 12-digit runs in any committed .py file.
ACCT = str(10**11 + 424242)                 # a 12-digit number that is not a placeholder
ZEROS, ONES = '0' * 12, '1' * 12             # one digit repeated: placeholders
DOC_EXAMPLE = ''.join(str(i % 10) for i in range(1, 13))   # the AWS documentation's example account id
COGNITO = fake_jwt('https://cognito-idp.ap-southeast-1.amazonaws.com/pool_X')
OTHER_JWT = fake_jwt('https://issuer.example')
AKID = 'AKIA' + 'Z' * 16
BASIC = base64.b64encode(b'client-id-123:client-secret-value-456').decode()


def scan_text(tmp_path, text: str, name: str = 'f.log', exact=(), gz=False):
    p = tmp_path / name
    data = text.encode()
    p.write_bytes(gzip.compress(data) if gz else data)
    rep = ls.Report()
    ls.Scanner(exact).scan_path(tmp_path, rep)
    return rep


def kinds(rep):
    return sorted(f.kind for f in rep.findings)


def test_cognito_and_other_jwts(tmp_path):
    rep = scan_text(tmp_path, f'authorization: Bearer {COGNITO}\nfixture={OTHER_JWT}\n')
    assert kinds(rep) == ['cognito-jwt', 'jwt']
    assert all(f.severity == 'high' for f in rep.findings)
    assert [f.line for f in rep.findings] == [1, 2]


def test_dummy_bearer_ignored_other_bearer_found(tmp_path):
    rep = scan_text(tmp_path, 'Authorization: Bearer not-a-credential\nAuthorization: Bearer ' + 'opaque-token' + '-value-0123\n')
    assert kinds(rep) == ['bearer'] and rep.findings[0].line == 2


def test_basic_credential_only_when_it_decodes_to_user_colon_secret(tmp_path):
    not_cred = base64.b64encode(b'just some words here').decode()
    rep = scan_text(tmp_path, f'Authorization: Basic {BASIC}\nbasic {not_cred}\n')
    assert kinds(rep) == ['basic-credential']


def test_aws_shapes(tmp_path):
    session = 'IQoJb3JpZ2lu' + 'A' * 40
    sig = 'X-Amz-Signature=' + 'ab' * 32
    hdr = 'AWS4-HMAC-SHA256 Credential=' + AKID + '/20261105/ap-southeast-1/bedrock/aws4_request'
    rep = scan_text(tmp_path, f'{session}\n{sig}\n{hdr}\n')
    assert kinds(rep) == ['aws-access-key-id', 'aws-session-token', 'sigv4-header', 'sigv4-query']


def test_access_key_alone(tmp_path):
    assert kinds(scan_text(tmp_path, f'key={AKID}\n')) == ['aws-access-key-id']


def test_account_ids_by_context_and_placeholders(tmp_path):
    text = '\n'.join([
        f'arn:aws:iam::{ACCT}:role/x',
        f'{ACCT}.dkr.ecr.ap-southeast-1.amazonaws.com/repo:tag',
        f'"accountId": "{ACCT}"',
        f'n = {ACCT}',
        f'arn:aws:iam::{ZEROS}:role/x', f'arn:aws:iam::{DOC_EXAMPLE}:role/x',
        f'ts=1730812345678 v=1.{DOC_EXAMPLE} h=4bf92f3577b34da6a3ce929d0e0e4736',
        'sha=1206c54353bb7982f44be' + ACCT + f'ede54 placeholder={ONES} word=id' + ACCT + 'x',
    ])
    rep = scan_text(tmp_path, text)
    assert kinds(rep) == ['account-field', 'account-in-arn', 'account-in-ecr-host', 'bare-12-digits']
    assert [f.severity for f in sorted(rep.findings, key=lambda f: f.line)] == ['high', 'high', 'high', 'review']


def test_exact_values_win_and_are_not_double_reported(tmp_path):
    secret = 'k8s9d7f6g5h4j3k2l1z0x9c8v7b6n5m4'  # nosec B105: fake test fixture, not a credential
    rep = scan_text(tmp_path, f'x {secret} y\narn:aws:iam::{ACCT}:role/r\n', exact=[secret, ACCT, '', 'short'])
    assert kinds(rep) == ['exact', 'exact']


def test_no_value_ever_printed(tmp_path, capsys):
    (tmp_path / 'a.log').write_text(f'{COGNITO}\n{AKID}\narn:aws:iam::{ACCT}:role/x\nAuthorization: Basic {BASIC}\n')
    out_json = tmp_path.parent / f'{tmp_path.name}-report.json'
    rc = ls.main([str(tmp_path), '--strict', '--json', str(out_json)])
    out = capsys.readouterr().out + out_json.read_text()
    assert rc == 1 and 'FAIL' in out
    for v in (COGNITO, COGNITO.split('.')[1], AKID, ACCT, BASIC, 'client-secret-value-456'):
        assert v not in out


def test_fingerprints_group_within_a_scan_but_not_across(tmp_path):
    a, b = ls.Scanner(key=b'k' * 32), ls.Scanner(key=b'j' * 32)
    assert a.fingerprint(b'v') == a.fingerprint(b'v') != b.fingerprint(b'v')


def test_gzip_long_lines_and_clean_exit(tmp_path, capsys):
    long_line = 'x' * (ls.WINDOW + 10) + AKID + 'y' * 100
    rep = scan_text(tmp_path, long_line + '\n', name='big.log.gz', gz=True)
    assert kinds(rep) == ['aws-access-key-id']
    clean = tmp_path / 'clean'
    clean.mkdir()
    (clean / 'ok.txt').write_text('nothing to see; dummy Bearer not-a-credential\n')
    assert ls.main([str(clean)]) == 0
    assert 'PASS' in capsys.readouterr().out


def test_review_numbers_do_not_fail_unless_strict(tmp_path):
    (tmp_path / 'n.txt').write_text(f'id {ACCT}\n')
    assert ls.main([str(tmp_path)]) == 0
    assert ls.main([str(tmp_path), '--strict']) == 1


def test_symlinks_are_listed_not_followed(tmp_path):
    target = tmp_path.parent / f'{tmp_path.name}-outside.txt'
    target.write_text(f'{AKID}\n')
    (tmp_path / 'link').symlink_to(target)
    rep = ls.Report()
    ls.Scanner().scan_path(tmp_path, rep)
    assert rep.findings == [] and rep.unscanned and 'symlink' in rep.unscanned[0][1]


def test_missing_path_is_an_error(tmp_path):
    assert ls.main([str(tmp_path / 'nope')]) == 2


def test_scan_file_api_for_the_export(tmp_path):
    bad, ok, num = tmp_path / 'calls.jsonl', tmp_path / 'ok.log', tmp_path / 'n.txt'
    bad.write_text(f'{{"auth": "Bearer {COGNITO}"}}\n')
    ok.write_text('Authorization: Bearer not-a-credential\n')
    num.write_text(f'id {ACCT}\n')
    sc = ls.Scanner()
    found = ls.scan_file(bad, sc)
    assert [(f.kind, f.severity, f.line) for f in found] == [('cognito-jwt', 'high', 1)]
    assert ls.scan_file(ok, sc) == [] and ls.scan_file(num, sc) == []
    assert [f.kind for f in ls.scan_file(num, sc, review=True)] == ['bare-12-digits']
    (tmp_path / 'link').symlink_to(bad)
    import pytest
    with pytest.raises(ValueError):
        ls.scan_file(tmp_path / 'link')
    (tmp_path / 'broken.gz').write_bytes(b'not gzip')
    with pytest.raises(OSError):
        ls.scan_file(tmp_path / 'broken.gz')
    with pytest.raises(OSError):
        ls.scan_file(tmp_path / 'missing')


def fake_encrypted_reasoning(**extra) -> str:
    """Shaped like reasoning `encrypted_content` in a Codex rollout: JWS-like header, payload {ciphertext, protected}."""
    header = {'alg': 'ES256', 'certificate': 'Y2VydA', 'iss': 'issuer.example', 'iss_meta': {}, 'kid': 'k1',
              'profile': 'p1', 'typ': 'JOSE'}
    payload = {'ciphertext': 'Y2lwaGVydGV4dC1ieXRlcy1mb3ItdGVzdHM', 'protected': 'cHJvdGVjdGVkLWhlYWRlcg', **extra}
    return '.'.join([b64u(header), b64u(payload), 'c2lnbmF0dXJlLXBhcnQtZm9yLXRlc3Rz'])


ENC = fake_encrypted_reasoning()


def rollout_line(enc: str) -> str:
    return json.dumps({'type': 'response_item', 'payload': {'type': 'reasoning', 'encrypted_content': enc}})


def test_encrypted_reasoning_is_not_reported_but_counted(tmp_path, capsys):
    assert ls.classify_jwt(ENC.split('.')[1].encode()) == 'encrypted-reasoning'
    sc = ls.Scanner()
    rep = ls.Report()
    (tmp_path / 'rollout-1.jsonl').write_text(rollout_line(ENC) + '\n' + rollout_line(ENC) + '\n')
    sc.scan_path(tmp_path, rep)
    assert rep.findings == [] and sc.suppressed == {'encrypted-reasoning': 2}
    assert ls.scan_file(tmp_path / 'rollout-1.jsonl') == []
    out_json = tmp_path.parent / f'{tmp_path.name}-enc.json'
    assert ls.main([str(tmp_path), '--strict', '--json', str(out_json)]) == 0
    out = capsys.readouterr().out
    assert 'PASS' in out and 'encrypted-reasoning=2' in out
    rep_json = json.loads(out_json.read_text())
    assert rep_json['not_reported'] == {'encrypted-reasoning': 2} and rep_json['findings'] == []
    assert ENC not in out + out_json.read_text()


def test_cognito_and_other_jwts_still_fail_next_to_encrypted_reasoning(tmp_path):
    p = tmp_path / 'rollout-2.jsonl'
    p.write_text(f'{rollout_line(ENC)}\nauthorization: Bearer {COGNITO}\n{rollout_line(ENC)} fixture={OTHER_JWT}\n')
    found = ls.scan_file(p)
    assert [(f.kind, f.severity, f.line) for f in found] == [('cognito-jwt', 'high', 2), ('jwt', 'high', 3)]
    assert ls.main([str(p)]) == 1


def test_only_the_exact_payload_keyset_is_encrypted_reasoning(tmp_path):
    cognito_iss = 'https://cognito-idp.ap-southeast-1.amazonaws.com/pool_X'
    payload = lambda tok: tok.split('.')[1].encode()   # noqa: E731
    assert ls.classify_jwt(payload(fake_encrypted_reasoning(iss=cognito_iss))) == 'cognito-jwt'
    assert ls.classify_jwt(payload(fake_encrypted_reasoning(sub='u1'))) == 'jwt'
    assert ls.classify_jwt(payload(fake_encrypted_reasoning(token_use='access'))) == 'jwt'  # nosec B106: JWT claim value in a test, not a credential
    only_ct = '.'.join([b64u({'alg': 'ES256'}), b64u({'ciphertext': 'eA'}), 'c2lnbmF0dXJlLXBhcnQtZm9yLXRlc3Rz'])
    assert ls.classify_jwt(payload(only_ct)) == 'jwt'
    near = [fake_encrypted_reasoning(iss=cognito_iss), fake_encrypted_reasoning(sub='u1'), only_ct]
    rep = scan_text(tmp_path, '\n'.join(near) + '\n')
    assert kinds(rep) == ['cognito-jwt', 'jwt', 'jwt'] and all(f.severity == 'high' for f in rep.findings)


def test_exact_values_still_found_in_and_as_encrypted_reasoning(tmp_path):
    secret = 'k8s9d7f6g5h4j3k2l1z0x9c8v7b6n5m4'  # nosec B105: fake test fixture, not a credential
    rep = scan_text(tmp_path, f'{rollout_line(ENC)} {secret}\n{rollout_line(ENC)}\n', exact=[secret, ENC])
    assert kinds(rep) == ['exact', 'exact', 'exact'] and all(f.severity == 'high' for f in rep.findings)


def test_fixture_values_are_counted_not_reported_but_exact_values_always_are(tmp_path):
    acct = ''.join(str((i * 7 + 3) % 10) for i in range(12))      # a made-up account id, built at run time (N5)
    arn = f'arn:aws:iam::{acct}:role/fixture-role'
    fx = tmp_path / 'tasks' / 't1' / 'tests'
    fx.mkdir(parents=True)
    (fx / 'data.txt').write_text(f'fixture: {arn}\n')
    traj = tmp_path / 'trial'
    traj.mkdir()
    (traj / 'rollout.jsonl').write_text(json.dumps({'output': f'cat data.txt -> {arn}'}) + '\n')
    plain = ls.Scanner()
    rep = ls.Report()
    plain.scan_path(traj, rep)
    assert [f.kind for f in rep.high()] == ['account-in-arn']                 # without the allowance: blocked
    sc = ls.Scanner(fixtures=[tmp_path / 'tasks'])
    rep = ls.Report()
    sc.scan_path(traj, rep)
    assert rep.high() == [] and sc.suppressed['fixture'] == 1
    other = traj / 'other.txt'                                                 # a different account id is still found
    other.write_text(f'arn:aws:iam::{acct[::-1]}:role/x\n')
    rep = ls.Report()
    sc.scan_path(traj, rep)
    assert [f.kind for f in rep.high()] == ['account-in-arn']
    other.unlink()
    ex = ls.Scanner(exact=[acct], fixtures=[tmp_path / 'tasks'])       # the real account id (IMDS) is never suppressed
    rep = ls.Report()
    ex.scan_path(traj, rep)
    assert [f.kind for f in rep.high()] == ['exact']
    assert ls.main(['--fixture-dir', str(tmp_path / 'tasks'), str(traj)]) == 0
    assert ls.main([str(traj)]) == 1
    assert ls.main(['--fixture-dir', str(tmp_path / 'nope'), str(traj)]) == 2


def _cc_line(blocks, blob=False):
    msg = {'type': 'assistant', 'message': {'role': 'assistant', 'content': blocks}}
    if blob:                                       # Claude Code 2.1's api-request-blob: thinking blocks nested deep
        msg = {'type': 'api-request-blob', 'body': {'messages': [{'role': 'assistant', 'content': blocks}]}}
    return json.dumps(msg)


def test_opaque_thinking_fields_relax_only_the_review_rule(tmp_path):
    sig = 'Ep4BCkYIBxgCKkA+' + ACCT + '/xQz' + 'A' * 40              # base64 with a bare 12-digit run inside
    lines = [_cc_line([{'type': 'thinking', 'thinking': 'Let me look.', 'signature': sig}]),
             _cc_line([{'type': 'redacted_thinking', 'data': sig}], blob=True)]
    sc, rep = ls.Scanner(), ls.Report()
    (tmp_path / 'sess.jsonl').write_text('\n'.join(lines) + '\n')
    sc.scan_path(tmp_path, rep)
    assert rep.findings == [] and sc.suppressed['opaque-signature'] == 2


def test_opaque_allowance_does_not_cover_text_or_high_rules(tmp_path):
    sig = 'Ep4BCkYIBxgCKkA+' + 'A' * 40
    lines = [_cc_line([{'type': 'thinking', 'thinking': f'account {ACCT} looks odd', 'signature': sig}]),   # text: reviewed
             _cc_line([{'type': 'thinking', 'thinking': 'x', 'signature': f'arn:aws:iam::{ACCT}:role/r' + sig}]),   # high: reported
             _cc_line([{'type': 'text', 'text': 'x', 'signature': 'Ep4B+' + ACCT + '/' + 'A' * 20}]),     # not a thinking block
             _cc_line([{'type': 'thinking', 'thinking': 'x', 'signature': sig + '+' + AKID}])]
    rep = ls.Report()
    (tmp_path / 'sess.jsonl').write_text('\n'.join(lines) + '\n')
    ls.Scanner([ACCT]).scan_path(tmp_path, rep)
    assert kinds(rep) == ['aws-access-key-id', 'exact', 'exact', 'exact']           # the exact account id wins everywhere
    rep = ls.Report()
    ls.Scanner().scan_path(tmp_path, rep)
    assert kinds(rep) == ['account-in-arn', 'aws-access-key-id', 'bare-12-digits', 'bare-12-digits']
