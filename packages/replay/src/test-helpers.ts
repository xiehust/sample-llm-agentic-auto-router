import { findModel, loadCatalog, type ModelPrice } from './deps.ts'

export const catalog = loadCatalog()
export function model(id: string): ModelPrice {
  const m = findModel(catalog, id)
  if (!m) throw new Error(`test: ${id} not in catalog`)
  return m
}
export const OPUS = 'global.anthropic.claude-opus-5-5'
export const SONNET = 'global.anthropic.claude-sonnet-5-5'
export const HAIKU = 'global.anthropic.claude-haiku-5-5'
export const SOL = 'global.openai.gpt-6.1-sol'
export const TERRA = 'global.openai.gpt-6.1-terra'
export const LUNA = 'global.openai.gpt-6-luna'
