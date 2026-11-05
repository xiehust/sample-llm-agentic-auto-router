// Catalog selection by region. The bundled @auto-router/pricing catalog is used when no region is asked for (or when
// the bundled one is for that region), so existing reports reproduce; any other region needs a catalog file for it.
import { loadCatalog, type PriceCatalog, validateCatalog } from './deps.ts'

export function selectCatalog(o: { region?: string; catalogJson?: unknown }): PriceCatalog {
  const catalog = o.catalogJson !== undefined ? validateCatalog(o.catalogJson) : loadCatalog()
  if (o.region !== undefined && catalog.region !== o.region) {
    throw new Error(o.catalogJson !== undefined
      ? `--catalog is for region ${catalog.region}, not ${o.region}`
      : `the bundled catalog is for ${catalog.region}; pass --catalog <file> priced for ${o.region}`)
  }
  return catalog
}
