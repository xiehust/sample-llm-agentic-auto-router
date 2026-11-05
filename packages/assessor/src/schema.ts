// Output contract as JSON Schema (design §6). Only the portable subset that strict structured-output modes accept:
// type, enum, properties, required (all keys), additionalProperties:false and items. No min/max keywords; bounds are
// re-checked in validate.ts.

export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean'
  enum?: readonly string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: false
  items?: JsonSchema
}

export const SCOPES = ['none', 'single-file', 'multi-file', 'cross-module'] as const
export const SPECIFICATIONS = ['fully-specified', 'partially', 'ambiguous'] as const
export const REASONING_DEPTHS = ['lookup', 'routine', 'deep'] as const

const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
})

/** Schema for the enabled rules; `rule_id` is an enum of their ids (left open when no rule is enabled). */
export function outputSchema(enabledRules: ReadonlyArray<{ id: string }>): JsonSchema {
  const ids = enabledRules.map((r) => r.id)
  const ruleId: JsonSchema = ids.length > 0 ? { type: 'string', enum: ids } : { type: 'string' }
  return object({
    rule_assessments: { type: 'array', items: object({ rule_id: ruleId, matched: { type: 'boolean' }, reason: { type: 'string' } }) },
    task_facts: object({
      edits_code: { type: 'boolean' },
      scope: { type: 'string', enum: SCOPES },
      specification: { type: 'string', enum: SPECIFICATIONS },
      reasoning_depth: { type: 'string', enum: REASONING_DEPTHS },
      prior_failures: { type: 'integer' },
    }),
    confidence: { type: 'number' },
    reason: { type: 'string' },
  })
}
