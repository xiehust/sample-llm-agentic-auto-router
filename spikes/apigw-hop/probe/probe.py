"""V9d gate probe: a Lambda inside the spike VPC that reaches the private REST API through the execute-api VPC
endpoint (private DNS off: connect to the VPCE name, Host = the API hostname).

Its role is NOT the gateway role, but its identity policy DOES allow execute-api:Invoke on this API. In the same
account API Gateway allows a call if either policy allows it, so a 403 for other_role proves the resource policy's
explicit Deny (principal != gateway role) works. Every request below must be denied:
  unsigned_models / unsigned_messages  -> 403 (no SigV4)
  other_role_models / other_role_messages -> 403 (valid SigV4, explicit Deny in the resource policy)
  direct_tcp_task / direct_tcp_nlb     -> timeout (task SG admits only the NLB SG; NLB SG has no ingress rules)
It returns status codes, a short body excerpt and resolved addresses; never credentials.
"""
import json
import re
import socket
import urllib.error
import urllib.request

import botocore.session
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

BODY = json.dumps({'model': 'v9-echo', 'max_tokens': 8, 'messages': [{'role': 'user', 'content': 'ping'}]}).encode()


def mask(text):
    return re.sub(r'\d{12}', '<acct>', text)[:400]


def send(vpce, method, path, headers, body=None):
    req = urllib.request.Request(f'https://{vpce}{path}', data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:  # nosec B310 - URL is built as https://<endpoint DNS><path> above
            return {'status': r.status, 'body': mask(r.read(400).decode('utf-8', 'replace'))}
    except urllib.error.HTTPError as e:
        return {'status': e.code, 'body': mask(e.read(400).decode('utf-8', 'replace')),
                'x-amzn-errortype': e.headers.get('x-amzn-errortype')}
    except Exception as e:  # noqa: BLE001 - every failure mode is a result
        return {'status': None, 'error': mask(repr(e))}


def signed(api_host, region, method, path, body=None):
    creds = botocore.session.get_session().get_credentials().get_frozen_credentials()
    headers = {'host': api_host, 'content-type': 'application/json', 'anthropic-version': '2023-06-01'}
    req = AWSRequest(method=method, url=f'https://{api_host}{path}', data=body, headers=headers)
    SigV4Auth(creds, 'execute-api', region).add_auth(req)
    return dict(req.headers.items())


def tcp(ip, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(5)
    try:
        s.connect((ip, port))
        return {'ip_class': ip.rsplit('.', 1)[0] + '.x', 'result': 'connected'}
    except socket.timeout:
        return {'ip_class': ip.rsplit('.', 1)[0] + '.x', 'result': 'timeout'}
    except OSError as e:
        return {'ip_class': ip.rsplit('.', 1)[0] + '.x', 'result': 'error', 'error': repr(e)}
    finally:
        s.close()


def handler(event, _context):
    vpce, api, region, port = event['vpceDns'], event['apiHost'], event['region'], int(event['port'])
    plain = {'host': api, 'content-type': 'application/json', 'anthropic-version': '2023-06-01'}
    out = {'vpce_resolved': sorted({a[4][0] for a in socket.getaddrinfo(vpce, 443, proto=socket.IPPROTO_TCP)})}
    out['unsigned_models'] = send(vpce, 'GET', '/v1/models', plain)
    out['unsigned_messages'] = send(vpce, 'POST', '/v1/messages', plain, BODY)
    out['other_role_models'] = send(vpce, 'GET', '/v1/models', signed(api, region, 'GET', '/v1/models'))
    out['other_role_messages'] = send(vpce, 'POST', '/v1/messages', signed(api, region, 'POST', '/v1/messages', BODY), BODY)
    out['direct_tcp_task'] = tcp(event['taskIp'], port)
    nlb_ips = sorted({a[4][0] for a in socket.getaddrinfo(event['nlbDns'], port, proto=socket.IPPROTO_TCP)})
    out['direct_tcp_nlb'] = [tcp(ip, port) for ip in nlb_ips]
    return out
