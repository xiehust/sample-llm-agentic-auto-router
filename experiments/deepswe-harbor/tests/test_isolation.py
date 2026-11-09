"""Isolation suite judges and probe pieces (design §10), without Docker, Harbor or any non-loopback network."""
import http.server
import json
import socket
import threading
import tomllib

import pytest

import isolation as iso
import isoprobe

PROXY = '172.17.0.1:8088'


def _agent_probe(**over):
    p = {'interfaces': ['eth0', 'lo'], 'packet_socket': 'EPERM', 'raw_inet_socket': 'EPERM',
         'proxy_http': {'connect': 'ok', 'reply': 'bytes'}, 'internet_tls': {'handshake': 'ECONNRESET'},
         'internet_tcp80': {'connect': 'ok', 'reply': 'closed'}, 'imds_http': {'connect': 'ok', 'reply': 'closed'},
         'dns': {'getaddrinfo': 'failed:gaierror', 'getent': 'failed:rc2'},
         'host_ports': {'172.17.0.1:22': {'connect': 'ok', 'reply': 'timeout'}}}
    p.update(over)
    return p


def test_gate1_verifier_lo_only():
    assert iso.judge_verifier({'interfaces': ['lo'], 'packet_socket': 'created'})['status'] == 'PASS'   # packet: info
    assert iso.judge_verifier({'interfaces': ['eth0', 'lo']})['status'] == 'FAIL'
    assert iso.judge_verifier(None)['status'] == 'FAIL'


def test_gate2_packet_socket_must_be_eperm():
    assert iso.judge_agent_caps({'packet_socket': 'EPERM'})['status'] == 'PASS'
    assert iso.judge_agent_caps({'packet_socket': 'created'})['status'] == 'FAIL'
    assert iso.judge_agent_caps({'packet_socket': 'EAFNOSUPPORT'})['status'] == 'FAIL'


def test_gate3_sidecar_counts_replies_not_connects():
    assert iso.judge_sidecar(_agent_probe(), 'runner')['status'] == 'PASS'   # local connects are the transparent proxy
    for bad in ({'proxy_http': {'connect': 'ok', 'reply': 'closed'}}, {'internet_tls': {'handshake': 'ok'}},
                {'imds_http': {'connect': 'ok', 'reply': 'bytes'}}, {'dns': {'getaddrinfo': 'resolved', 'getent': 'absent'}},
                {'dns': {'getaddrinfo': 'failed:gaierror', 'getent': 'resolved'}}, {'internet_tcp80': {'connect': 'ok', 'reply': 'bytes'}}):
        assert iso.judge_sidecar(_agent_probe(**bad), 'runner')['status'] == 'FAIL', bad
    ssh = _agent_probe(host_ports={'172.17.0.1:22': {'connect': 'ok', 'reply': 'bytes'}})
    assert iso.judge_sidecar(ssh, 'runner')['status'] == 'FAIL'
    dev = iso.judge_sidecar(ssh, 'devbox')                                   # no runner firewall on the dev box
    assert dev['status'] == 'PASS' and dev['runner_only']['replied'] == ['172.17.0.1:22']


def _bridge(**over):
    p = {'proxy_http': {'connect': 'ok', 'reply': 'bytes'}, 'internet_tls': {'handshake': 'timeout'},
         'internet_tcp80': {'connect': 'timeout'}, 'imds_http': {'connect': 'timeout'},
         'dns': {'getaddrinfo': 'failed:gaierror', 'getent': 'failed:rc2'},
         'host_ports': {'172.17.0.1:22': {'connect': 'timeout'}, '172.18.0.1:8088': {'connect': 'refused'}}}
    p.update(over)
    return p


def test_gate4_plain_bridges_connect_decides():
    g = iso.judge_bridge({'docker0': _bridge(), 'user-network': _bridge()}, PROXY)
    assert g['status'] == 'PASS' and g['kind'] == 'runner-only'
    open_port = _bridge(host_ports={'172.18.0.1:22': {'connect': 'ok', 'reply': 'bytes'}})
    assert iso.judge_bridge({'docker0': _bridge(), 'user-network': open_port}, PROXY)['status'] == 'FAIL'
    assert iso.judge_bridge({'docker0': _bridge(imds_http={'connect': 'ok'})}, PROXY)['status'] == 'FAIL'
    assert iso.judge_bridge({'docker0': None}, PROXY)['status'] == 'FAIL'


def test_gate5_host_listeners():
    tcp = iso.parse_ss('LISTEN 0 4096 127.0.0.1:631 0.0.0.0:*\nLISTEN 0 128 172.17.0.1:8088 0.0.0.0:*\nLISTEN 0 4096 [::1]:25 [::]:*\n')
    assert tcp == ['127.0.0.1:631', '172.17.0.1:8088', '[::1]:25']
    udp = iso.parse_ss('UNCONN 0 0 0.0.0.0%eth0:68 0.0.0.0:*\nUNCONN 0 0 0.0.0.0:5355 0.0.0.0:*\n')
    g = iso.judge_host_listeners(tcp, udp, '172.17.0.1', 8088)
    assert g['status'] == 'PASS' and len(g['info']['udp_68_5355']) == 2 and g['kind'] == 'runner-only'
    for extra in ('0.0.0.0:22', '[::]:22', '172.17.0.1:8089', '10.0.0.5:8088'):
        assert iso.judge_host_listeners(tcp + [extra], udp, '172.17.0.1', 8088)['status'] == 'FAIL', extra


def test_gate5_security_group_json():
    ok = {'SecurityGroups': [{'GroupId': 'sg-x', 'IpPermissions': [], 'IpPermissionsEgress': [{'IpProtocol': '-1'}]}]}
    assert iso.judge_aws(ok)['status'] == 'PASS'
    bad = {'SecurityGroups': [{'GroupId': 'sg-x', 'IpPermissions': [{'IpProtocol': 'tcp', 'FromPort': 22}]}]}
    assert iso.judge_aws(bad)['status'] == 'FAIL'
    assert iso.judge_aws({'SecurityGroups': []})['status'] == 'FAIL'
    inst = {'Reservations': [{'Instances': [{'InstanceId': 'i-x', 'SecurityGroups': [{'GroupId': 'sg-x'}, {'GroupId': 'sg-y'}],
                                              'MetadataOptions': {'HttpTokens': 'required', 'HttpPutResponseHopLimit': 1}}]}]}
    g = iso.judge_aws(ok, inst)
    assert g['status'] == 'FAIL' and 'missing' in g['detail']['error']        # sg-y was not judged
    inst['Reservations'][0]['Instances'][0]['SecurityGroups'] = [{'GroupId': 'sg-x'}]
    g = iso.judge_aws(ok, inst)
    assert g['status'] == 'PASS' and g['info'][0]['imds_tokens'] == 'required'


def test_verdict_runner_only_gates_count_only_on_the_runner():
    gates = {'1': {'status': 'PASS'}, '4': {'status': 'FAIL', 'kind': 'runner-only'}, '5aws': {'status': 'SKIP'}}
    assert iso.verdict(gates, 'devbox') is True
    assert iso.verdict(gates, 'runner') is False
    assert iso.verdict({'2': {'status': 'FAIL'}}, 'devbox') is False


def test_probe_task_is_valid_and_grades(tmp_path):
    t = iso.probe_task(tmp_path, iso.PROBE_IMAGE, PROXY)
    cfg = tomllib.loads((t / 'task.toml').read_text())
    assert cfg['agent']['network_mode'] == 'no-network' and cfg['verifier']['environment_mode'] == 'separate'
    assert cfg['environment']['docker_image'] == iso.PROBE_IMAGE
    test_sh = (t / 'tests' / 'test.sh').read_text()
    assert '{"reward": 1}' in test_sh and '{{' not in test_sh
    assert (t / 'tests' / 'isoprobe.py').exists() and (t / 'solution' / 'isoprobe.py').exists()
    assert '--role agent' in (t / 'solution' / 'solve.sh').read_text()


def test_isoprobe_tcp_on_loopback():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), http.server.BaseHTTPRequestHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        port = srv.server_address[1]
        assert isoprobe.http_reply('127.0.0.1', port, '/x') == {'connect': 'ok', 'reply': 'bytes'}
    finally:
        srv.shutdown()
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    closed = s.getsockname()[1]
    s.close()
    assert isoprobe.tcp('127.0.0.1', closed, timeout=1)['connect'] == 'refused'
    assert isoprobe.sock_create(socket.AF_INET, socket.SOCK_STREAM) == 'created'


def test_last_json_and_cli_aws(tmp_path, capsys):
    assert iso.last_json('noise\n{"a": 1}\n') == {'a': 1} and iso.last_json('nothing') is None
    sg = tmp_path / 'sg.json'
    sg.write_text(json.dumps({'SecurityGroups': [{'GroupId': 'sg-x', 'IpPermissions': []}]}))
    assert iso.main(['aws', '--sg', str(sg)]) == 0
    assert json.loads(capsys.readouterr().out)['status'] == 'PASS'


@pytest.mark.parametrize('name', ['isoprobe.py', 'isolation.py'])
def test_no_ids_in_files(name):
    import re
    t = (iso.HERE / name).read_text()
    assert not re.search(r'(?<!\d)\d{12}(?!\d)', t)


def test_ensure_image_requires_a_digest_and_pulls_when_missing(monkeypatch):
    assert iso.ensure_image('python:3.13-slim')['status'] == 'FAIL'
    calls = []

    class R:
        def __init__(self, rc):
            self.returncode, self.stderr, self.stdout = rc, '', ''
    state = {'present': False}

    def fake(argv, timeout=600, env=None):
        calls.append(argv[:3])
        if argv[:3] == ['docker', 'image', 'inspect']:
            return R(0 if state['present'] else 1)
        if argv[:2] == ['docker', 'pull']:
            state['present'] = True
            return R(0)
        return R(1)
    monkeypatch.setattr(iso, '_run', fake)
    g = iso.ensure_image(iso.PROBE_IMAGE)
    assert g['status'] == 'PASS' and g['detail']['pulled'] is True and ['docker', 'pull', '-q'] in calls
    assert iso.ensure_image(iso.PROBE_IMAGE)['detail']['pulled'] is False      # present now: no pull


# ---------------------------------------------------------------- profile tb21 (TB design §4.6)

HOST_IP = '10.91.0.40'
PEERS = {'online': '10.201.0.9:8000', 'docker0': '172.17.0.5:8000', 'pool': '10.200.3.2:8000'}


def _online_probe(**over):
    no = {'connect': 'timeout', 'reply': None}
    tcp = {f'{h}:80': dict(no) for h in iso.ONLINE_PRIVATE}
    tcp.update({'169.254.169.254:80': dict(no), '169.254.170.2:80': dict(no), '10.91.0.2:53': dict(no),
                '172.17.0.1:22': dict(no), '10.201.0.1:22': dict(no), '10.201.0.1:8088': dict(no), f'{HOST_IP}:22': dict(no),
                f'{HOST_IP}:8088': dict(no), **{v: dict(no) for v in PEERS.values()}})
    p = {'interfaces': ['eth0', 'lo'], 'gateway': '10.201.0.1', 'packet_socket': 'EPERM',
         'resolv': {'nameservers': ['127.0.0.11'], 'ext_servers': '[host(169.254.169.253)]'},
         'proxy_http': {'connect': 'ok', 'reply': 'bytes'},
         'dns': {n: {'getaddrinfo': 'resolved'} for n in ('pypi.org', 'example.com', 'github.com')},
         'internet_tls': {'handshake': 'ok'}, 'internet_http80': {'connect': 'ok', 'reply': 'bytes'},
         'public_tcp': {'github.com:22': {'connect': 'refused', 's': 0.05}, '1.1.1.1:8443': {'connect': 'refused', 's': 0.04}},
         'public_udp53': {'result': 'ECONNREFUSED'}, 'public_quic': {'result': 'ECONNREFUSED'},
         'vpc_resolver_link_local': {'udp53': {'result': 'reply'}, 'tcp443': {'connect': 'timeout'}},
         'tcp': tcp, 'imds_v6': {'connect': 'ENETUNREACH'}}
    p.update(over)
    return p


def _probes(**over):
    return {'agent': _online_probe(**over), 'verifier': _online_probe(**over)}


def test_tb_online_gates_pass_on_a_good_runner_probe():
    pr = _probes()
    for g in (iso.judge_online_internet(pr), iso.judge_online_limits(pr), iso.judge_online_metadata(pr),
              iso.judge_online_private(pr, HOST_IP, '10.91.0.2', iso.ONLINE_PRIVATE), iso.judge_online_host(pr, PROXY, 'runner'),
              iso.judge_online_peers(pr, PEERS), iso.judge_caps_online(pr)):
        assert g['status'] == 'PASS', g
    net = {'name': 'llmar-online'}
    rec = {'veth': 'veth1', 'ip': '10.201.0.7'}
    assert iso.judge_online_network(net, None, pr, '169.254.169.253', rec)['status'] == 'PASS'
    assert iso.judge_online_network(None, 'missing', pr, '169.254.169.253', rec)['status'] == 'FAIL'
    assert iso.judge_online_network(net, None, pr, '169.254.169.253', None)['status'] == 'FAIL'


@pytest.mark.parametrize('judge,over', [
    ('internet', {'internet_tls': {'handshake': 'timeout'}}),
    ('internet', {'dns': {'pypi.org': {'getaddrinfo': 'failed:gaierror'}}}),
    ('limits', {'public_tcp': {'github.com:22': {'connect': 'ok', 's': 0.1}}}),
    ('limits', {'public_tcp': {'github.com:22': {'connect': 'refused', 's': 5.0}}}),        # a slow refusal is the SG, not our RST
    ('limits', {'public_quic': {'result': 'reply'}}),
    ('limits', {'public_udp53': {'result': 'reply'}}),
    ('limits', {'vpc_resolver_link_local': {'udp53': {'result': 'timeout'}, 'tcp443': {'connect': 'timeout'}}}),
    ('limits', {'vpc_resolver_link_local': {'udp53': {'result': 'reply'}, 'tcp443': {'connect': 'ok'}}}),
    ('caps', {'packet_socket': 'created'}),
])
def test_tb_online_gates_fail(judge, over):
    pr = _probes(**over)
    fn = {'internet': iso.judge_online_internet, 'limits': iso.judge_online_limits, 'caps': iso.judge_caps_online}[judge]
    assert fn(pr)['status'] == 'FAIL'


def test_tb_reachable_metadata_private_host_or_peer_fails():
    def with_open(key):
        p = _online_probe()
        p['tcp'] = {**p['tcp'], key: {'connect': 'ok', 'reply': 'bytes'}}
        return {'agent': _online_probe(), 'verifier': p}            # one phase is enough to fail
    assert iso.judge_online_metadata(with_open('169.254.169.254:80'))['status'] == 'FAIL'
    assert iso.judge_online_private(with_open('192.168.0.1:80'), HOST_IP, '10.91.0.2', iso.ONLINE_PRIVATE)['status'] == 'FAIL'
    assert iso.judge_online_private(with_open(f'{HOST_IP}:22'), HOST_IP, '10.91.0.2', iso.ONLINE_PRIVATE)['status'] == 'FAIL'
    assert iso.judge_online_host(with_open('10.201.0.1:8088'), PROXY, 'runner')['status'] == 'FAIL'
    dev = iso.judge_online_host(with_open('172.17.0.1:22'), PROXY, 'devbox')
    assert dev['status'] == 'PASS' and dev['runner_only']
    assert iso.judge_online_peers(with_open(PEERS['online']), PEERS)['status'] == 'FAIL'
    assert iso.judge_online_metadata({'agent': None, 'verifier': _online_probe()})['status'] == 'FAIL'
    no_proxy = _probes(proxy_http={'connect': 'ok', 'reply': None})
    assert iso.judge_online_host(no_proxy, PROXY, 'devbox')['status'] == 'FAIL'


def test_tb_inbound_and_conn_log():
    assert iso.judge_inbound(['', ''], '-P PREROUTING ACCEPT\n-A DOCKER -i docker0 -j RETURN\n', 'llmar-online', '10.201.0.0/24')['status'] == 'PASS'
    assert iso.judge_inbound(['0.0.0.0:8080->80/tcp'], '', 'llmar-online', '10.201.0.0/24')['status'] == 'FAIL'
    assert iso.judge_inbound([''], '-A DOCKER ! -i br-llmon -p tcp --dport 80 -j DNAT --to-destination 10.201.0.5:80\n',
                             'llmar-online', '10.201.0.0/24')['status'] == 'FAIL'
    assert iso.judge_inbound([''], None, 'llmar-online', '10.201.0.0/24')['status'] == 'FAIL'
    j = '\n'.join(json.dumps({'MESSAGE': f'llmar-online: IN=br-llmon OUT=ens5 PHYSIN=veth1 SRC=10.201.0.7 DST=1.2.3.4 PROTO=TCP DPT={p}',
                              '__REALTIME_TIMESTAMP': '1762400000000000'}) for p in (443, 22)) + '\nnot json\n'
    lines = iso.parse_conn_log(j)
    assert lines[0] == {'ts_us': 1762400000000000, 'src': '10.201.0.7', 'dst': '1.2.3.4', 'dpt': 443, 'physin': 'veth1'}
    g = iso.judge_conn_log(lines, {'veth': 'veth1', 'ip': '10.201.0.7'})
    assert g['status'] == 'PASS' and g['info']['physin_is_the_trial_veth']
    assert iso.judge_conn_log(lines[:1], {'veth': 'veth1', 'ip': '10.201.0.7'})['status'] == 'FAIL'
    nophys = iso.parse_conn_log(j.replace('PHYSIN=veth1 ', ''))
    g = iso.judge_conn_log(nophys, {'veth': 'veth1', 'ip': '10.201.0.7'})
    assert g['status'] == 'PASS' and not g['info']['physin_is_the_trial_veth']     # fallback: IP + window


def test_tb_probe_task_shape(tmp_path):
    t = iso.probe_task_online(tmp_path, iso.PROBE_IMAGE, '--proxy 172.17.0.1:8088')
    cfg = tomllib.loads((t / 'task.toml').read_text())
    assert cfg['environment']['allow_internet'] is True and 'environment' not in cfg['verifier'] and 'network_mode' not in cfg['agent']
    import harbor_job
    assert harbor_job.task_network_public(t)
    assert '--role verifier-online' in (t / 'tests' / 'test.sh').read_text() and '--role agent-online' in (t / 'solution' / 'solve.sh').read_text()
    assert iso.vpc_resolver('10.91.0.0/24') == '10.91.0.2'
    assert iso.read_env_file(tmp_path / 'none') == {}
    (tmp_path / 'e').write_text('# c\nONLINE_NETWORK=llmar-online\nONLINE_DNS="169.254.169.253"\n')
    assert iso.read_env_file(tmp_path / 'e') == {'ONLINE_NETWORK': 'llmar-online', 'ONLINE_DNS': '169.254.169.253'}


def test_isoprobe_quic_and_dns_payloads():
    q = isoprobe.quic_probe()
    assert len(q) == 1200 and q[0] & 0xc0 == 0xc0 and q[1:5] == bytes.fromhex('0a0a0a0a')
    d = isoprobe.dns_query('example.com')
    assert d[12:] == b'\x07example\x03com\x00\x00\x01\x00\x01'


# ---------------------------------------------------------------- the runner's driver venv has no Harbor (real-run regression)

RUNNER_VENV_MODULES = ('driver', 'isolation', 'isoprobe', 'lookupscan', 'taskpin', 'harvest', 'classify', 'hproxy', 'harbor_job',
                       'codex_config', 'hcommon', 'leakscan', 'shardplan', 'profiles')

_BLOCK = '''
import sys
class _NoHarbor:
    def find_spec(self, name, path=None, target=None):
        if name == "harbor" or name.startswith("harbor."):
            raise ImportError("harbor is not installed in the runner venv (test block)")
        return None
sys.meta_path.insert(0, _NoHarbor())
'''


def test_runner_venv_modules_import_without_harbor(tmp_path):
    import importlib.util
    import subprocess
    import sys
    here = iso.HERE
    mods = [m for m in RUNNER_VENV_MODULES if (here / f'{m}.py').exists()]
    code = _BLOCK + f'sys.path.insert(0, {str(here)!r})\nimport importlib\nfor m in {mods!r}:\n    importlib.import_module(m)\nprint("ok")\n'
    r = subprocess.run([sys.executable, '-I', '-c', code], capture_output=True, text=True, timeout=120, cwd=tmp_path)  # nosec B603: argument list, no shell; arguments are the operator's own
    assert r.returncode == 0 and r.stdout.strip().endswith('ok'), r.stderr[-2000:]
    assert importlib.util.find_spec('isolation') is not None


def test_tb_isolation_entry_runs_without_harbor(tmp_path, monkeypatch):
    """run_tb end to end with Harbor unimportable and every docker/harbor/journalctl call faked: it must reach the
    `harbor run` shell-out and the judges without importing Harbor (the 2026-11-06 runner failure)."""
    import socket
    import subprocess
    import sys

    class NoHarbor:
        def find_spec(self, name, path=None, target=None):
            if name == 'harbor' or name.startswith('harbor.'):
                raise ImportError('harbor is not installed in the runner venv (test block)')
            return None
    for m in [m for m in sys.modules if m == 'harbor' or m.startswith('harbor.') or m == 'llmar_env']:
        monkeypatch.delitem(sys.modules, m)
    monkeypatch.setattr(sys, 'meta_path', [NoHarbor(), *sys.meta_path])
    env = tmp_path / 'llmar-runner.env'
    env.write_text('CONTAINER_EGRESS=internet\nONLINE_NETWORK=llmar-online\nONLINE_DNS=169.254.169.253\n')
    for k in ('ONLINE_NETWORK', 'ONLINE_DNS'):
        monkeypatch.delenv(k, raising=False)
    net = [{'Name': 'llmar-online', 'Id': 'n', 'Driver': 'bridge', 'EnableIPv6': False, 'Internal': False,
            'IPAM': {'Config': [{'Subnet': '10.201.0.0/24'}]},
            'Options': {'com.docker.network.bridge.name': 'br-llmon', 'com.docker.network.bridge.enable_icc': 'false',
                        'com.docker.network.bridge.enable_ip_masquerade': 'true'}}]
    calls = []

    def fake(argv, timeout=600, env=None):
        calls.append(list(argv))
        out = ''
        if argv[:3] == ['docker', 'network', 'inspect']:
            out = json.dumps(net)
        elif argv[:3] == ['docker', 'run', '-d']:
            out = 'peer\n'
        elif argv[:2] == ['docker', 'inspect']:
            out = '10.201.0.9\n'
        elif argv[:2] == ['ip', '-4']:
            out = '1.1.1.1 via 10.91.0.1 dev ens5 src 10.91.0.40 uid 0\n'
        return subprocess.CompletedProcess(argv, 0, stdout=out, stderr='')
    monkeypatch.setattr(iso, '_run', fake)
    srv = socket.socket()
    srv.bind(('127.0.0.1', 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    try:
        rc = iso.main(['run', '--where', 'runner', '--profile', 'tb21', '--env', 'llmar', '--harbor', 'harbor', '--proxy-host', '127.0.0.1',
                       '--proxy-port', str(port), '--env-file', str(env), '--out', str(tmp_path / 'out')])
    finally:
        srv.close()
    assert rc == 1                                          # no real trial ran, so gates fail; no exception
    assert any(c[:2] == ['harbor', 'run'] for c in calls)   # it got as far as shelling out to Harbor
    assert not any(m == 'harbor' or m.startswith('harbor.') for m in sys.modules)
    report = json.loads(next((tmp_path / 'out').rglob('report.json')).read_text())
    assert report['online'] == {'ONLINE_NETWORK': 'llmar-online', 'ONLINE_DNS': '169.254.169.253'}
    task = next((tmp_path / 'out').rglob('llmar-isoprobe-online/task.toml'))
    assert 'allow_internet = true' in task.read_text()
    assert report['gates']['O8_network']['detail']['network']['bridge'] == 'br-llmon'
