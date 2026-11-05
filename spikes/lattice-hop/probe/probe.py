"""V9 gate probe: runs as a Lambda inside the spike VPC (associated with the service network).

Its own role is deliberately NOT in the Lattice auth policy, but its identity policy does allow
vpc-lattice-svcs:Invoke, so a 403 for other_role comes from the auth policy. Every request below must be denied:
  unsigned            -> 403 from Lattice (no credentials)
  other_role          -> 403 from Lattice (valid SigV4 + UNSIGNED-PAYLOAD, principal not in the auth policy)
  other_role_signed_payload -> recorded only: how Lattice answers a payload-signed request (R-a1 signature)
  direct_tcp          -> connect to task_ip:port must time out (task SG admits only the Lattice prefix list)
It returns status codes, a short body excerpt and the resolved addresses; never credentials.
"""
import json
import re
import socket
import urllib.error
import urllib.request
from urllib.parse import urlparse

import botocore.session
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

BODY = json.dumps({'model': 'v9-echo', 'max_tokens': 8, 'messages': [{'role': 'user', 'content': 'ping'}]}).encode()


def mask(text):
    return re.sub(r'\d{12}', '<acct>', text)[:300]


def send(url, headers):
    if not url.startswith('https://'):
        raise ValueError('probe only sends https requests')
    req = urllib.request.Request(url, data=BODY, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=15) as r:  # nosec B310 - https only, checked above
            return {'status': r.status, 'body': mask(r.read(300).decode('utf-8', 'replace'))}
    except urllib.error.HTTPError as e:
        return {'status': e.code, 'body': mask(e.read(300).decode('utf-8', 'replace')),
                'x-amzn-errortype': e.headers.get('x-amzn-errortype')}
    except Exception as e:  # noqa: BLE001 - every failure mode is a result
        return {'status': None, 'error': mask(repr(e))}


def signed_headers(url, region, unsigned_payload):
    creds = botocore.session.get_session().get_credentials().get_frozen_credentials()
    headers = {'content-type': 'application/json', 'anthropic-version': '2023-06-01'}
    if unsigned_payload:
        headers['x-amz-content-sha256'] = 'UNSIGNED-PAYLOAD'
    req = AWSRequest(method='POST', url=url, data=BODY, headers=headers)
    req.context['payload_signing_enabled'] = not unsigned_payload
    SigV4Auth(creds, 'vpc-lattice-svcs', region).add_auth(req)
    return dict(req.headers.items())


def handler(event, _context):
    url = event['serviceUrl'].rstrip('/') + '/v1/messages'
    region = event['region']
    host = urlparse(url).hostname
    out = {'resolved': sorted({a[4][0] for a in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)})}
    out['unsigned'] = send(url, {'content-type': 'application/json', 'anthropic-version': '2023-06-01'})
    out['other_role'] = send(url, signed_headers(url, region, True))
    out['other_role_signed_payload'] = send(url, signed_headers(url, region, False))
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(5)
    try:
        s.connect((event['taskIp'], int(event['taskPort'])))
        out['direct_tcp'] = {'result': 'connected'}
    except socket.timeout:
        out['direct_tcp'] = {'result': 'timeout'}
    except OSError as e:
        out['direct_tcp'] = {'result': 'error', 'error': repr(e)}
    finally:
        s.close()
    return out
