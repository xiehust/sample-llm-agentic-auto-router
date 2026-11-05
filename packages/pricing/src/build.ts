// Builds one region's PriceCatalog from region-independent model metadata (data/models.json) plus that region's
// captured snapshots (data/snapshots/price-list.<region>.json, bedrock-ids.<region>.json). Used by
// scripts/build-catalog.ts and by the tests (which rebuild every bundled catalog and compare). Not exported publicly.
import type { CacheTtl, ModelPrice, PriceCatalog, UsdPerMTok } from './types.ts'

export type SkuScheme = 'claude' | 'claude-legacy' | 'gpt' | 'mantle'

export interface ModelMeta extends Omit<ModelPrice, 'price' | 'longContext' | 'priceSource'> {
  longContextAboveTokens?: number
  /** Price List SKU: the `model` attribute and how its usagetypes are named. `prefix` is for mantle-style usagetypes. */
  sku?: { name: string; scheme: SkuScheme; prefix?: string }
  /** Global profiles with no Price List SKU: the Bedrock model-card price (global pricing is region-independent). */
  modelCardPrice?: { price: UsdPerMTok; longContext?: UsdPerMTok }
}

export interface ModelsFile { schemaVersion: 1; models: ModelMeta[]; excluded?: Array<{ modelId: string; reason: string }> }

export interface PriceListSnapshot {
  capturedAt: string
  region: string
  rows: Record<string, Record<string, number>>
  fallback?: Record<string, { region: string; rows: Record<string, number> }>
}

export interface IdsSnapshot { region: string; inferenceProfileIds: string[]; foundationModels: Array<{ modelId: string; inferenceTypesSupported: string[] }> }

export interface BuildOptions { version?: string; asOf?: string }

type Field = 'input' | 'output' | 'cacheRead' | `write:${CacheTtl}`

/** Usagetype name for one price field (`long` = long-context tier), or undefined when the scheme has none. */
function usageKey(meta: ModelMeta, field: Field, long: boolean): string | undefined {
  const sku = meta.sku
  if (!sku) return undefined
  const geo = meta.endpointScope === 'geo'
  const inRegion = meta.endpointScope === 'in-region'
  const lc = long ? '_long_ctx' : ''
  if (sku.scheme === 'claude' || sku.scheme === 'gpt') {
    const base = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_tokens',
      'write:5m': 'cache_write_tokens', 'write:1h': 'cache_write_tokens_1h', 'write:30m': 'cache_write_tokens_30m', 'write:12h': undefined }[field]
    return base && `${base}${lc}${geo ? '_standard' : '_global_standard'}`
  }
  if (sku.scheme === 'claude-legacy') {
    if (long) return undefined
    const base = { input: 'InputTokenCount', output: 'OutputTokenCount', cacheRead: 'CacheReadInputTokenCount',
      'write:5m': 'CacheWriteInputTokenCount', 'write:1h': 'CacheWrite1hInputTokenCount', 'write:30m': undefined, 'write:12h': undefined }[field]
    return base && `${base}${geo ? '' : '_Global'}`
  }
  // mantle: '<prefix>-input-tokens-global-standard'; in-region models: '<prefix>-input-tokens'
  if (long) return undefined
  const base = { input: 'input-tokens', output: 'output-tokens', cacheRead: 'cache-read-tokens',
    'write:5m': undefined, 'write:1h': undefined, 'write:30m': 'cache-write-tokens-30m', 'write:12h': undefined }[field]
  return base && `${sku.prefix}-${base}${inRegion ? '' : '-global-standard'}`
}

function priceFrom(meta: ModelMeta, rows: Record<string, number>, long: boolean): { price?: UsdPerMTok; missing: string[] } {
  const missing: string[] = []
  const get = (f: Field): number | undefined => {
    const k = usageKey(meta, f, long)
    const v = k === undefined ? undefined : rows[k]
    if (v === undefined) missing.push(k ?? `${f}${long ? ' (long context)' : ''}`)
    return v
  }
  const input = get('input')
  const output = get('output')
  if (meta.cache.mode === 'none') {
    return missing.length || input === undefined || output === undefined ? { missing } : { price: { input, output, cacheRead: input, cacheWrite: {} }, missing }
  }
  const cacheRead = get('cacheRead')
  const cacheWrite: Partial<Record<CacheTtl, number>> = {}
  for (const ttl of meta.cache.ttls) { const v = get(`write:${ttl}`); if (v !== undefined) cacheWrite[ttl] = v }
  if (missing.length || input === undefined || output === undefined || cacheRead === undefined) return { missing }
  return { price: { input, output, cacheRead, cacheWrite }, missing }
}

export function buildCatalog(models: ModelsFile, prices: PriceListSnapshot, ids: IdsSnapshot, o: BuildOptions = {}): PriceCatalog {
  if (prices.region !== ids.region) throw new Error(`snapshot regions differ: ${prices.region} vs ${ids.region}`)
  const region = prices.region
  const profiles = new Set(ids.inferenceProfileIds)
  const onDemand = new Set(ids.foundationModels.filter((f) => f.inferenceTypesSupported.includes('ON_DEMAND')).map((f) => f.modelId))
  const out: ModelPrice[] = []
  const excluded = [...(models.excluded ?? [])]
  for (const meta of models.models) {
    const available = meta.endpointScope === 'in-region' ? onDemand.has(meta.modelId) : profiles.has(meta.modelId)
    if (!available) { excluded.push({ modelId: meta.modelId, reason: `not offered in ${region} (no ${meta.endpointScope === 'in-region' ? 'on-demand foundation model' : 'inference profile'})` }); continue }
    let price: UsdPerMTok | undefined
    let longPrice: UsdPerMTok | undefined
    let priceSource: string
    if (meta.sku) {
      const own = prices.rows[meta.sku.name]
      const fb = own ? undefined : prices.fallback?.[meta.sku.name]
      const rows = own ?? fb?.rows
      if (!rows) { excluded.push({ modelId: meta.modelId, reason: `no Price List SKU '${meta.sku.name}' in ${region}` }); continue }
      const base = priceFrom(meta, rows, false)
      if (!base.price) { excluded.push({ modelId: meta.modelId, reason: `Price List SKU '${meta.sku.name}' lacks ${base.missing.join(', ')}` }); continue }
      price = base.price
      if (meta.longContextAboveTokens !== undefined) {
        const lc = priceFrom(meta, rows, true)
        longPrice = lc.price ?? meta.modelCardPrice?.longContext
        if (!longPrice) { excluded.push({ modelId: meta.modelId, reason: `no long-context price (${lc.missing.join(', ')})` }); continue }
      }
      priceSource = fb ? `price-list:${fb.region} global SKU (no ${region} SKU published)` : `price-list:${region}`
    } else if (meta.modelCardPrice) {
      price = meta.modelCardPrice.price
      longPrice = meta.modelCardPrice.longContext
      priceSource = 'model-card'
      if (meta.longContextAboveTokens !== undefined && !longPrice) { excluded.push({ modelId: meta.modelId, reason: 'no long-context model-card price' }); continue }
    } else {
      excluded.push({ modelId: meta.modelId, reason: 'no price source (neither sku nor modelCardPrice)' })
      continue
    }
    const { sku: _sku, modelCardPrice: _mc, longContextAboveTokens, ...rest } = meta
    const entry: ModelPrice = {
      ...rest, price,
      ...(longContextAboveTokens !== undefined && longPrice ? { longContext: { aboveTokens: longContextAboveTokens, price: longPrice } } : {}),
      priceSource,
    }
    out.push(entry)
  }
  const asOf = o.asOf ?? prices.capturedAt
  return {
    version: o.version ?? `${asOf}.1`, asOf, region,
    source: `AWS Price List API (regionCode=${region}; Standard tier, on-demand) + Amazon Bedrock model cards`,
    models: out, excluded,
  }
}
