/** The bundled or supplied catalog violates the schema. */
export class CatalogError extends Error {
  override name = 'CatalogError'
}

/** A price needed for a cost calculation is missing from the catalog entry. */
export class PricingError extends Error {
  override name = 'PricingError'
}

/** A response body carries no usage object for the given dialect. */
export class UsageNotFoundError extends Error {
  override name = 'UsageNotFoundError'
}
