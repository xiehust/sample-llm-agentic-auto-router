# @auto-router/pricing

This package has no runtime dependencies. It provides:

- versioned Bedrock price catalogs per Region (bundled: ap-northeast-1, ap-southeast-1), plus a pipeline to add a Region;
- usage normalizers for Anthropic Messages, OpenAI Chat Completions and OpenAI Responses, both streaming and non-streaming;
- a cost calculator with long-context tiers.

The contract is documented in `docs/tasks/11-04-llm-auto-router/design.md` §3. The design detail is in `docs/tasks/11-04-pricing-usage/design.md`.

```ts
import { loadCatalog, findModel, normalizeUsage, createStreamUsageAccumulator, parseSse, costOf } from '@auto-router/pricing'

const catalog = loadCatalog('ap-southeast-1')   // throws CatalogError for a Region without a bundled catalog
const usage = normalizeUsage('anthropic-messages', responseBody)
const cost = costOf(usage, findModel(catalog, 'global.anthropic.claude-haiku-5-5')!)
```

## Behaviour to know

- **Chat Completions streams carry usage only when the request sets `stream_options.include_usage`.** Without it, Bedrock sends no usage and `result()` returns `undefined`.
- OpenAI-shape cache writes are attributed to the `30m` TTL, because Bedrock returns no TTL breakdown.
- Long-context pricing applies to the whole request when `promptTokens > longContext.aboveTokens`: 100,000 for Haiku 5.5 and 272,000 for GPT.

## Catalogs per Region

- `loadCatalog(region)` returns the bundled catalog for `region`, and `catalogRegions()` lists the bundled Regions. With no argument it returns the reference catalog (`ap-northeast-1`), which offline tools such as replay, evals and tests use. Deployments always pass their Region.
- `data/models.json` holds the Region-independent model metadata: family, tier, dialects, context window, cache behaviour and the Price List SKU naming. Prices come from each Region's snapshots.
- `data/catalog.ap-northeast-1.json` (2026-11-04.1) is frozen so replays stay reproducible. A test proves the builder reproduces every one of its prices from the Tokyo snapshots.
- `data/catalog.ap-southeast-1.json` is built from its snapshots, and a test rebuilds it and compares. On 2026-11-04 every global-profile price equals Tokyo's. Singapore has its own Sonnet 5.5 SKU, and Kimi K2.5 has no SKU there.

## Adding or refreshing a Region

All AWS calls are read-only: `pricing:GetProducts`, `bedrock:ListInferenceProfiles` and `bedrock:ListFoundationModels`.

```
uv run packages/pricing/scripts/capture_prices.py --region <aws-region> [--fallback-region us-east-1] [--expect-account <id>]
node packages/pricing/scripts/build-catalog.ts --region <aws-region> [--version YYYY-MM-DD.N]
node packages/pricing/scripts/gen-catalog.ts
pnpm -C packages/pricing typecheck && pnpm -C packages/pricing test
```

- `capture_prices.py` writes `data/snapshots/price-list.<region>.json` and `bedrock-ids.<region>.json`. It keeps on-demand standard rows only.
  - A model with no SKU in the Region uses the `--fallback-region` global-profile SKU, recorded as such in `priceSource`.
  - Global profiles without any Price List SKU use `modelCardPrice` from `models.json`.
- `build-catalog.ts` includes only models the Region offers: an inference profile, or an on-demand foundation model for in-Region ids. Everything else is listed under `excluded` with a reason.
- To use a catalog without bundling it, pass the JSON file to the router (`ROUTER_CATALOG_FILE`) and to the infra app (`-c catalogFile=`). Both validate it and require its `region` to match.
- New models need an entry in `data/models.json`: metadata, plus `sku` (Price List `model` name and scheme) or `modelCardPrice`.

Known gaps as of 2026-11-04:

- Tokyo has no Sonnet 5.5 SKU, so it uses the us-east-1 global SKU.
- GPT models other than GPT-6 Astra have no Price List SKU, so their prices come from the model cards.
- GPT-5.5 and 5.4 are excluded because no global price is published.

## Fixtures

`src/__fixtures__/` holds real responses from `global.anthropic.claude-haiku-5-5` and `global.openai.gpt-6-luna`, captured in ap-northeast-1 on 2026-11-04. Account ids, request ids and response ids are scrubbed.

To recapture (this makes a few dozen small, billed Bedrock calls):

```
uv run packages/pricing/scripts/capture_fixtures.py --region <aws-region> [messages|chat|responses|kimi ...]
```

- The Region comes from `--region`, else `AWS_REGION`; there is no default.
- With no dialect named it captures messages, chat and responses; `kimi` is opt-in.
- The script signs requests with botocore SigV4 and the default credential chain. It refuses to run unless the caller account is `LLMAR_SPIKE_ACCOUNT`; set that in your own untracked env file.
- Review the scrubbed fixtures before committing them.
