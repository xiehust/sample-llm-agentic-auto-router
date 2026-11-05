// Builds data/catalog.<region>.json from data/models.json and the region's snapshots (see capture_prices.py).
// Run: node packages/pricing/scripts/build-catalog.ts --region <aws-region> [--version YYYY-MM-DD.N]
//      then node packages/pricing/scripts/gen-catalog.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildCatalog, type IdsSnapshot, type ModelsFile, type PriceListSnapshot } from '../src/build.ts'
import { validateCatalog } from '../src/catalog.ts'

const { values } = parseArgs({ options: { region: { type: 'string' }, version: { type: 'string' } } })
const region = values.region
if (!region || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) {
  console.error('usage: build-catalog.ts --region <aws-region> [--version YYYY-MM-DD.N]')
  process.exit(2)
}
// The ap-northeast-1 catalog (2026-11-04.1) is frozen so replays stay reproducible; the tests prove this builder
// reproduces its prices. Rebuilding it is allowed only with an explicit new version.
const data = fileURLToPath(new URL('../data/', import.meta.url))
const read = <T>(f: string): T => JSON.parse(readFileSync(`${data}${f}`, 'utf8')) as T
const catalog = validateCatalog(buildCatalog(
  read<ModelsFile>('models.json'),
  read<PriceListSnapshot>(`snapshots/price-list.${region}.json`),
  read<IdsSnapshot>(`snapshots/bedrock-ids.${region}.json`),
  values.version ? { version: values.version } : {},
))
if (region === 'ap-northeast-1' && !values.version) {
  console.error('ap-northeast-1 is frozen at 2026-11-04.1 (replay reproducibility); pass --version to publish a new one')
  process.exit(2)
}
writeFileSync(`${data}catalog.${region}.json`, `${JSON.stringify(catalog, null, 2)}\n`)
console.log(`wrote data/catalog.${region}.json: ${catalog.models.length} models, ${catalog.excluded?.length ?? 0} excluded, version ${catalog.version}`)
