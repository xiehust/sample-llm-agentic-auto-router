// anthropic-beta value (or prefix glob ending in *) -> model-id globs KNOWN TO REJECT it (deny list).
// Anything not listed is allowed: Bedrock validates anthropic-beta itself and answers 400 for a bad value.
// Seeded from spike V8: Bedrock rejected the obsolete extended-cache-ttl-2025-04-11 (on Haiku 5.5; the 1h TTL is
// GA without a beta). interleaved-thinking-* and context-1m-* were accepted, so they are not listed.
// Extend only with observed rejections (E2E step 3 lists Claude Code's default betas).
export const BETA_REJECTS: Readonly<Record<string, readonly string[]>> = {
  "extended-cache-ttl-*": ["*.anthropic.claude-*"],
}
