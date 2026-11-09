"""Writes a calls label in the tier-pass file format that 0d's scorer reads (design §7.4): per dataset and pass,
one line per card with task_id and pred_tier (the call the router acts on). Stdlib only; run with -I.

  python3 -I experiments/assessor-v22/export.py --label <calls label> [--subset tune|heldout|all]
  → results/export/<label>/<dataset>-r<n>-<subset>.jsonl
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from collections import defaultdict

HERE = pathlib.Path(__file__).resolve().parent
RESULTS = HERE / 'results'


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--label', required=True)
    ap.add_argument('--subset', default=None, help='only calls files of this subset (default: every subset found)')
    a = ap.parse_args()
    src = RESULTS / 'calls' / a.label
    if not src.is_dir():
        sys.exit(f'no calls for {a.label}')
    meta = json.loads((src / 'meta.json').read_text(encoding='utf-8'))
    dst = RESULTS / 'export' / a.label
    dst.mkdir(parents=True, exist_ok=True)
    written = []
    for f in sorted(src.glob('r*-*.jsonl')):
        m = re.match(r'^r(\d+)-([a-z]+)\.jsonl$', f.name)
        if not m or (a.subset and m.group(2) != a.subset):
            continue
        by: dict[str, list[dict]] = defaultdict(list)
        for line in f.read_text(encoding='utf-8').splitlines():
            if line.strip():
                r = json.loads(line)
                by[r['dataset']].append({'task_id': r['task_id'], 'pred_tier': r.get('pred') if r.get('pred') in ('fast', 'standard', 'frontier') else 'none',
                                         'pack': meta['packVersion'], 'rep': int(m.group(1))})
        for ds, rows in sorted(by.items()):
            ids = [r['task_id'] for r in rows]
            if len(ids) != len(set(ids)):
                sys.exit(f'{f.name}: duplicate task ids for {ds}')
            out = dst / f'{ds}-r{m.group(1)}-{m.group(2)}.jsonl'
            out.write_text(''.join(json.dumps(r) + '\n' for r in sorted(rows, key=lambda r: r['task_id'])), encoding='utf-8')
            written.append((out.name, len(rows)))
    print(json.dumps({'label': a.label, 'packVersion': meta['packVersion'], 'files': written}))


if __name__ == '__main__':
    main()
