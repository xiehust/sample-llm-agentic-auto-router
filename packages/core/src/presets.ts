// Ready-made policies (used by replay to compare boundary-gated vs cost-modeled routing).
import { DEFAULT_ALIASES, validatePolicy, type Policy, type PolicyInput, type PolicyRule } from './policy.ts'

type Pool = NonNullable<Policy['pools']['openai-chat']>
const openAiPool = (): Pool => ({
  defaultTier: 'standard',
  models: [
    { model: 'global.openai.gpt-6-astra', tier: 'frontier' },
    { model: 'global.openai.gpt-6.1-sol', tier: 'standard' },
    { model: 'global.openai.gpt-6-luna', tier: 'fast' },
  ],
})

function preset(version: string, userTurn: Policy['userTurn'], rules: PolicyRule[] = [], hysteresis?: PolicyInput['hysteresis']): Policy {
  const input: PolicyInput = {
    schemaVersion: 1,
    version,
    mode: 'auto',
    userTurn,
    aliases: { ...DEFAULT_ALIASES },
    pools: {
      'anthropic-messages': {
        defaultTier: 'standard',
        models: [
          { model: 'global.anthropic.claude-opus-5-5' },
          { model: 'global.anthropic.claude-sonnet-5-5' },
          { model: 'global.anthropic.claude-haiku-5-5' },
        ],
      },
      'openai-chat': openAiPool(),
      'openai-responses': openAiPool(),
    },
    rules,
    ...(hysteresis ? { hysteresis } : {}),
  }
  return validatePolicy(input)
}

export const policyPresets: {
  readonly boundaryGated: Policy
  readonly costModeled: Policy
  readonly costModeledSubagentFast: Policy
} = {
  /** Switches only at free break points; user turns always retain. */
  boundaryGated: preset('preset-boundary-gated-v1', 'retain'),
  /** Also allows cost-gated downgrades (and tier-driven upgrades) at user turns. */
  costModeled: preset('preset-cost-modeled-v2', 'cost-gated', [], { minTurnsBeforeSwitch: 1 }),
  /**
   * Opt-in: costModeled plus one rule, sub-agent lineages desire 'fast'; root lineages keep the pool default
   * ('standard'). Exercises the cost gate when a sub-agent's first call is followed by user turns.
   */
  costModeledSubagentFast: preset('preset-cost-modeled-subagent-fast-v2', 'cost-gated', [
    { id: 'subagent-fast', when: { lineageKind: 'subagent' }, tier: 'fast' },
  ], { minTurnsBeforeSwitch: 1 }),
}
