"""Dev-box capture of Claude Code's first main-loop request per profile (4f, design-harness §5.2; 73's (a)–(c)).
No AWS, no proxy: the pinned binary in a fresh user + network + mount namespace (loopback only) against
mock_capture.py, with exactly cc_config.agent_env and Harbor's claude-code flags, client model Sonnet (the A/B client).

  python3 experiments/claude-code-harbor/e2e/capture.py --claude <pinned binary> --profile deepswe|tb21 \
      --instruction-file <task>/instruction.md --task-id <id>

Writes results/capture/<profile>/ (gitignored: the bodies hold Claude Code's prompt and the task's instruction):
- first-main.json: the first main-loop request body, verbatim as sent;
- requests.jsonl: text-free facts per request (path, model, call_type via cc_calls, hashes, sizes, flags);
- reminders.json: messages[0]'s block structure (which blocks are <system-reminder>, and where the instruction is);
- d6.json: version, platform, endpoints called, request header names, the env keys, flags.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(REPO / 'experiments' / 'deepswe-harbor'))

import hcommon  # noqa: E402  isort: skip
import cc_calls  # noqa: E402
import cc_config  # noqa: E402
from run_e2e import FLAGS, enter_namespace, repo  # noqa: E402

PORT = 18089


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--claude', required=True)
    ap.add_argument('--profile', required=True, choices=('deepswe', 'tb21'))
    ap.add_argument('--instruction-file', required=True)
    ap.add_argument('--task-id', required=True)
    a = ap.parse_args()
    enter_namespace(sys.argv)
    subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True)  # nosec B603: argument list, no shell; arguments are the operator's own
    binary = pathlib.Path(a.claude).resolve()
    plat = hcommon.claude_platform(os.uname().machine)
    if hashlib.sha256(binary.read_bytes()).hexdigest() != hcommon.CLAUDE_CODE['sha256'][plat]:
        sys.exit(f'{binary}: not the pinned {plat} build')
    instruction = pathlib.Path(a.instruction_file).read_text(encoding='utf-8')
    out = REPO / 'experiments' / 'claude-code-harbor' / 'results' / 'capture' / a.profile
    out.mkdir(parents=True, exist_ok=True)
    work = pathlib.Path(tempfile.mkdtemp(prefix='cc-capture-'))
    rec = work / 'requests.raw.jsonl'
    mock = subprocess.Popen([sys.executable, str(HERE / 'mock_capture.py'), str(rec), str(PORT)])  # nosec B603: argument list, no shell; arguments are the operator's own
    time.sleep(1)
    try:
        home = work / 'home'
        home.mkdir()
        env = {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'TERM': 'dumb', 'IS_SANDBOX': '1', 'CLAUDE_CONFIG_DIR': str(work / 'sessions'),
               'ANTHROPIC_MODEL': hcommon.CC_CLIENT_MODEL['A'], **cc_config.agent_env(f'http://127.0.0.1:{PORT}/r/capture-{a.profile}/v1')}
        cwd = repo(work)
        p = subprocess.run([str(binary), *FLAGS], input=instruction, text=True, capture_output=True, cwd=cwd, env=env, timeout=300, check=False)  # nosec B603: argument list, no shell; arguments are the operator's own
    finally:
        mock.terminate()
    reqs = [json.loads(x) for x in rec.read_text().splitlines()]
    clf = cc_calls.load_classifier()
    rows = []
    first_main = None
    for r in reqs:
        b = r.get('body') if isinstance(r.get('body'), dict) else {}
        facts = cc_calls.roles(r['headers'], b, hcommon.CC_CLIENT_MODEL['A'], clf) if b else {}
        if first_main is None and facts.get('call_type') == 'main':
            first_main = b
        rows.append({'seq': r['seq'], 'method': r['method'], 'path': r['path'].split('?')[0].split('/r/', 1)[-1].split('/', 1)[-1],
                     'model': b.get('model'), 'is_first_main': b is first_main, 'max_tokens': b.get('max_tokens'),
                     'thinking': (b.get('thinking') or {}).get('type'), 'effort': (b.get('output_config') or {}).get('effort'),
                     'betas': (r['headers'].get('anthropic-beta') or '').split(','), 'stream': b.get('stream'),
                     'cache_ttls': sorted({str((x.get('cache_control') or {}).get('ttl', '5m')) for x in b.get('system') or [] if isinstance(x, dict) and x.get('cache_control')}),
                     **{k: facts.get(k) for k in ('call_type', 'call_role', 'call_role_struct', 'system_sig', 'tools_sig', 'n_tools')}})
    if first_main is None:
        sys.exit('no main-loop request captured')
    (out / 'first-main.json').write_text(json.dumps(first_main, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    (out / 'requests.jsonl').write_text(''.join(json.dumps(x) + '\n' for x in rows))
    blocks = first_main['messages'][0]['content']
    instr_idx = [i for i, x in enumerate(blocks) if isinstance(x, dict) and x.get('text') == instruction]
    (out / 'reminders.json').write_text(json.dumps({
        'blocks': [{'index': i, 'type': x.get('type'), 'chars': len(x.get('text') or ''), 'system_reminder': (x.get('text') or '').lstrip().startswith('<system-reminder>'),
                    'is_instruction': i in instr_idx} for i, x in enumerate(blocks)],
        'instruction_alone_in_one_block': len(instr_idx) == 1, 'task_id': a.task_id, 'cwd': str(cwd)}, indent=1))
    (out / 'd6.json').write_text(json.dumps({
        'claude_code': hcommon.CLAUDE_CODE['version'], 'platform': plat, 'exit_code': p.returncode,
        'requests': [(x['method'], x['path']) for x in rows], 'request_headers': sorted(reqs[0]['headers']),
        'env_keys': sorted(env), 'flags': FLAGS, 'client_model': hcommon.CC_CLIENT_MODEL['A'], 'task_id': a.task_id}, indent=1))
    print(json.dumps({'profile': a.profile, 'requests': len(rows), 'first_main_found': True,
                      'instruction_alone_in_one_block': len(instr_idx) == 1, 'exit': p.returncode}))


if __name__ == '__main__':
    main()
