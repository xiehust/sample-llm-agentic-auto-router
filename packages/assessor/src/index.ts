// @auto-router/assessor public API (design §9).
export type { AssessorResult, CardContext, Tier, TierAssessor } from './contract.ts'
export { TIERS } from './contract.ts'
export { buildCard, CARD_LIMITS, cut, isTaskCard, sanitize, stripSystemReminders, taskCardIssue, type CardBuildContext, type CutText, type TaskCard } from './card.ts'
export {
  cardJson, defaultPackDir, defaultPackName, isPackName, loadPack, packDirs, PACK_LIMITS, PackError, renderPrompt, renderSystem, validatePack,
  type Pack, type PackExample, type PackName, type PackRule, type RenderedPrompt,
} from './pack.ts'
export { outputSchema, REASONING_DEPTHS, SCOPES, SPECIFICATIONS, type JsonSchema } from './schema.ts'
export { validateAssessment, VALIDATION_LIMITS, type Assessment, type RuleAssessment, type TaskFacts, type ValidationResult } from './validate.ts'
export { DEFAULT_MAPPING, DEFAULT_THRESHOLD, FACT_SIGNALS, mapTier, type FactSignal, type MapOptions, type MapOutcome, type PackMapping, type TierMapping } from './map.ts'
export {
  anthropicMessagesAdapter, BEDROCK_ANTHROPIC_VERSION, openAiChatAdapter, openAiResponsesAdapter, SCHEMA_NAME, selectAdapter, TOOL_NAME,
  type AdapterCfg, type BuildParams, type ModelAdapter, type OpenAiApi, type ParseResult,
} from './adapters/index.ts'
export { fakeTransport, type FakeStep, type FakeTransport, type Transport, type TransportRequest, type TransportResponse } from './transport.ts'
export {
  createAssessor, DEFAULT_ASSESSOR_MODEL, DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_REASONING_EFFORT, DEFAULT_TIMEOUT_MS, precheck, scrub,
  type Assessor, type AssessorCallInfo, type AssessorConfig,
} from './assessor.ts'
export {
  buildManifest, writePacksArchive, loadBundledPacks, manifestEntry, manifestMismatches, manifestPath, manifestText, MANIFEST_SCHEMA_VERSION, readManifest,
  type BundledPack, type ManifestPack, type PackManifest,
} from './manifest.ts'
