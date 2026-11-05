# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3>=1.40"]
# ///
"""Capture the inputs for one region's price catalog (read-only AWS calls only).

  uv run packages/pricing/scripts/capture_prices.py --region <aws-region> [--fallback-region us-east-1]
  node packages/pricing/scripts/build-catalog.ts --region <aws-region>     # then: node packages/pricing/scripts/gen-catalog.ts

Writes packages/pricing/data/snapshots/price-list.<region>.json and bedrock-ids.<region>.json.

Calls (all read-only):
- pricing:GetProducts (Price List endpoint us-east-1), ServiceCode AmazonBedrockFoundationModels and AmazonBedrock,
  filter regionCode=<region>. Only on-demand standard rows are kept (no flex/priority/batch/provisioned).
- bedrock:ListInferenceProfiles (SYSTEM_DEFINED) and bedrock:ListFoundationModels in <region>.
- For a model in data/models.json with no SKU in <region>, the global-profile SKU of --fallback-region is used
  (global cross-Region inference is priced per global profile) and recorded as such.

Optional: --expect-account <id> (or LLMAR_EXPECT_ACCOUNT) refuses to run under any other account. The id is never
printed or written. Nothing in the output names the account.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import sys

import boto3

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parent / 'data'
SERVICE_CODES = ('AmazonBedrockFoundationModels', 'AmazonBedrock')
PROVIDERS = re.compile(r'(^|\.)(anthropic|openai|moonshot|amazon\.nova)')
NOT_ON_DEMAND = re.compile(r'(flex|priority|batch|provisioned|reserved)', re.I)
UNIT_SCALE = {'1M tokens': 1, '1K tokens': 1000}


def normalize(usagetype: str) -> str:
    """'APS1-MP:APS1_input_tokens_global_standard-Units' -> 'input_tokens_global_standard';
    'APS1-moonshotai.kimi-k3-mantle-input-tokens-global-standard' -> 'moonshotai.kimi-k3-mantle-input-tokens-global-standard'."""
    key = re.sub(r'^[A-Z]{2,4}\d?-', '', usagetype)
    key = re.sub(r'^MP:[A-Z]{2,4}\d?_', '', key)
    return re.sub(r'-Units$', '', key)


def price_rows(region: str, names: set[str]) -> dict[str, dict[str, float]]:
    pricing = boto3.client('pricing', region_name='us-east-1')
    rows: dict[str, dict[str, float]] = {}
    for sc in SERVICE_CODES:
        for page in pricing.get_paginator('get_products').paginate(
                ServiceCode=sc, Filters=[{'Type': 'TERM_MATCH', 'Field': 'regionCode', 'Value': region}]):
            for item in page['PriceList']:
                p = json.loads(item) if isinstance(item, str) else item
                a = p['product']['attributes']
                name, usagetype = a.get('model', ''), a.get('usagetype', '')
                if name not in names or NOT_ON_DEMAND.search(usagetype) or NOT_ON_DEMAND.search(a.get('service_tier') or ''):
                    continue
                for term in p.get('terms', {}).get('OnDemand', {}).values():
                    for dim in term.get('priceDimensions', {}).values():
                        scale = UNIT_SCALE.get(dim.get('unit', ''))
                        if scale is None:
                            continue
                        usd = float(dim['pricePerUnit']['USD']) * scale
                        rows.setdefault(name, {})[normalize(usagetype)] = round(usd, 10)
    return {n: dict(sorted(r.items())) for n, r in sorted(rows.items())}


def ids(region: str) -> dict[str, object]:
    bedrock = boto3.client('bedrock', region_name=region)
    profiles = [p['inferenceProfileId'] for page in bedrock.get_paginator('list_inference_profiles').paginate(typeEquals='SYSTEM_DEFINED')
                for p in page['inferenceProfileSummaries'] if p.get('status') == 'ACTIVE']
    fms = bedrock.list_foundation_models()['modelSummaries']
    return {
        'inferenceProfileIds': sorted(p for p in profiles if PROVIDERS.search(p)),
        'foundationModels': sorted(({'modelId': m['modelId'], 'inferenceTypesSupported': sorted(m.get('inferenceTypesSupported', []))}
                                    for m in fms if PROVIDERS.search(m['modelId'])), key=lambda m: m['modelId']),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--region', required=True)
    ap.add_argument('--fallback-region', default='us-east-1')
    ap.add_argument('--expect-account', default=os.environ.get('LLMAR_EXPECT_ACCOUNT', ''))
    args = ap.parse_args()
    if not re.fullmatch(r'[a-z]{2}(-[a-z]+)+-\d', args.region):
        sys.exit(f'not an AWS region: {args.region}')
    if args.expect_account and boto3.client('sts').get_caller_identity()['Account'] != args.expect_account:
        sys.exit('refusing to run: the caller account is not the expected account')

    models = json.loads((DATA / 'models.json').read_text())['models']
    names = {m['sku']['name'] for m in models if m.get('sku')}
    today = dt.date.today().isoformat()
    rows = price_rows(args.region, names)
    missing = sorted(names - rows.keys())
    fallback: dict[str, object] = {}
    if missing and args.fallback_region != args.region:
        other = price_rows(args.fallback_region, set(missing))
        for name, r in other.items():
            glob = {k: v for k, v in r.items() if 'global' in k.lower()}
            if glob:
                fallback[name] = {'region': args.fallback_region, 'rows': glob}
    snapshot = {
        'capturedAt': today, 'region': args.region,
        'call': f'pricing:GetProducts (endpoint us-east-1) ServiceCode in {list(SERVICE_CODES)}, Filter regionCode={args.region}; '
                'on-demand standard rows only; usagetype region prefix stripped; USD per 1M tokens',
        'rows': rows, 'fallback': fallback, 'missing': [n for n in missing if n not in fallback],
    }
    snap_dir = DATA / 'snapshots'
    (snap_dir / f'price-list.{args.region}.json').write_text(json.dumps(snapshot, indent=2) + '\n')
    (snap_dir / f'bedrock-ids.{args.region}.json').write_text(json.dumps({
        'capturedAt': today, 'region': args.region,
        'note': 'Filtered to anthropic/openai/moonshot/amazon.nova ids. Calls: bedrock:ListInferenceProfiles(typeEquals=SYSTEM_DEFINED, ACTIVE), bedrock:ListFoundationModels.',
        **ids(args.region)}, indent=2) + '\n')
    print(f'{args.region}: {len(rows)} priced models, {len(fallback)} via {args.fallback_region} global SKU, '
          f'{len(snapshot["missing"])} without any SKU: {snapshot["missing"]}')


if __name__ == '__main__':
    main()
