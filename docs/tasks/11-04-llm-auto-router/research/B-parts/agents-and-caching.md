# B. How agent products choose models + prompt-caching mechanics relevant to routing

Research date: 2026-11-04. Sources are official docs unless noted. Quotes are verbatim from the fetched page, sometimes trimmed. "unverified" means I could not fetch a primary source (several openai.com / help.openai.com pages returned 403, and Amp's modes page needs a login).

---

## TL;DR for router design

1. **No provider shares a prompt cache across models.** Anthropic/Claude Code: "each model has its own cache. Switching models recomputes the entire request even when the content is identical" and "two requests share a cache only when their model, speed, and prefix match" (https://code.claude.com/docs/en/prompt-caching). Gemini explicit cache: "Cached content can be only used with model it was created for" (https://aistudio.google.com/api-reference/caching). OpenAI's docs don't say so outright, but they note "A different model can use different weights and caching behavior" (https://developers.openai.com/api/docs/guides/prompt-caching). Treat this as a hard rule: **switching models = a full cold prefill.**
2. **The most mature products now route at cache boundaries, not on every request.** GitHub Copilot Auto: "Routing occurs along natural cache boundaries and large drifts in conversation complexity to avoid additional cache related costs without quality improvements" (https://docs.github.com/en/copilot/concepts/auto-model-selection). Cursor Router "runs a classifier on each agent request" and doesn't document cache stickiness (https://cursor.com/docs/cursor-router).
3. **The common way to use a cheaper model without breaking the cache is a sub-agent hand-off with a fresh context**, not a mid-conversation switch. Anthropic says this outright: "if you're 100k tokens into a conversation with Opus and want to ask a question that is fairly easy to answer, it would actually be more expensive to switch to Haiku than to have Opus answer... If you need to switch models, the best way to do it is with subagents" (https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/).
4. **Effort/thinking/speed/tool-set changes can also break the cache** (Anthropic: thinking config, effort, `speed: fast`, tool definitions, `tool_choice`, images). A router that changes reasoning effort per turn has the same problem as one that changes model, except on models documented as effort-cache-safe.
5. **Infra-level "cache-aware routing" (llm-d, Dynamo, SGLang, AIBrix, OpenAI `prompt_cache_key`) picks a replica of the same model.** It never picks a different model. It complements model routing: once the router fixes a model, it should also send a stable affinity key.

---

## Part 1 — How agent and coding products choose models

### Summary table

| Product | Decision granularity | Signals | Cache awareness | Multi-turn / tool-loop handling | Open source | Deployment form |
|---|---|---|---|---|---|---|
| GitHub Copilot Auto | Per prompt, but switches only at cache boundaries or large complexity drift | Task complexity, real-time health/availability, tier (Efficiency/Balance/Intelligence), policy | **Cost-modeled/sticky**: routes "along natural cache boundaries" | Avoids mid-conversation switches unless complexity drifts a lot | No | SaaS router inside Copilot (Chat, cloud agent, IDEs) |
| VS Code Copilot Auto | "each request" (VS Code docs) | Task complexity, availability, tier, on-device availability | Not stated in VS Code docs (see GitHub doc above) | Can route to on-device model with cloud fallback "before the first output" | Client is OSS (VS Code Copilot Chat); router isn't | Client + SaaS |
| Cursor Auto / Cursor Router | Per agent request ("classifier on each agent request") | "task type and complexity", mode (Cost/Balance/Intelligence) | Not documented | Not documented; subagents start with a clean context | No | SaaS |
| Claude Code | Per session (user `/model`), per mode (`opusplan`), per sub-agent (`model:`), per skill turn | User choice, plan mode on/off, sub-agent definition, safety-classifier fallback | **Explicit**: warns before a switch while the cache is warm; forks share the cache; sub-agents get a separate cache | Sub-agents and forks; auto-compaction via a cache-safe fork | No (CLI closed; Agent SDK available) | Local CLI/IDE/desktop calling Anthropic, Bedrock, Vertex, Foundry or a gateway |
| Cline | Per mode (Plan vs Act) | User toggle | None documented | History carries over on switch, so each switch is a cold prefill on the other model | Yes (Apache-2.0) | VS Code extension, BYOK |
| Roo Code | Per mode (sticky model per mode); per subtask via Orchestrator | Mode, set by user or by agent suggestion; `new_task` `mode` param | None documented | Boomerang subtasks have isolated context; only a summary returns | Yes | VS Code extension, BYOK |
| Kilo Code | Per mode, per subagent | Mode/subagent | None documented | Orchestrator mode deprecated in favor of direct subagents | Yes | VS Code/JetBrains extension, CLI |
| Aider | Per role: main/architect, editor, weak | Fixed roles | `--cache-prompts`, keepalive pings (sticky per model) | Architect then editor = 2 requests per turn; weak model handles commits and summaries | Yes (Apache-2.0) | Local CLI, BYOK |
| ChatGPT GPT-5 router / Auto | Per message (real-time) | Conversation type, complexity, tool needs, explicit intent ("think hard"); usage limits | Not documented (consumer product) | Within one chat it can switch between fast and thinking models | No | ChatGPT only. The API exposes separate models with no router |
| OpenAI Codex (CLI/app) | Per session, user `/model`; reasoning effort per session | User choice; plan/account defaults | Not documented in model docs | `/model` switches mid-session | CLI is open source (Apache-2.0) | Local CLI/IDE/desktop/cloud |
| Kiro Auto | "each task" | Not disclosed | Not documented | n/a | No | IDE/CLI SaaS |
| Devin Desktop (ex-Windsurf) Fusion | Per role: lead vs sidekick | Lead plans and reviews, sidekick implements | Not documented | Lead/sidekick split (sub-agent style) | No | Desktop IDE SaaS |
| Factory Droid | User selection; "Factory route requests across providers automatically" (details unverified) | n/a | n/a | n/a | No | CLI SaaS |
| Amp | Mode-based (smart/rush/etc.) | n/a | unverified (docs behind login) | n/a | No | CLI/IDE SaaS |

### 1.1 GitHub Copilot — Auto model selection

Source: https://docs.github.com/en/copilot/concepts/auto-model-selection

- **What it chooses on:** "One system tracks real-time system health and availability, while the other evaluates task complexity." Selection is language-independent: "Routing decisions depend on what you are trying to do, not what language you're asking in."
- **Tiers:** Efficiency (prioritizes cost), Balance ("For each prompt, the model is selected by considering cost, quality, and latency"), Intelligence (prioritizes quality).
- **Cache/session awareness (key for us):** "Routing occurs along natural cache boundaries and large drifts in conversation complexity to avoid additional cache related costs without quality improvements." This is the clearest public statement from a major vendor of **cache-boundary-aware routing**. It sits between per-request and per-session: the router may re-decide every prompt but only acts at a cache boundary or on a big complexity shift. The doc doesn't define "natural cache boundaries". Likely candidates are a new chat, a TTL lapse, or compaction (unverified).
- **Discount:** "If you are on a paid Copilot plan, you qualify for a 10% discount on model costs while using auto model selection in Copilot Chat, or Copilot cloud agent."
- **Candidate pool** (https://docs.github.com/en/copilot/reference/ai-models/supported-models): GPT-5.6 Luna/Sol/Terra, GPT-6 Astra/Luna/Sol, GPT-6.1 Sol, Claude Haiku 4.5, Opus 4.8/5/5.5, Sonnet 5/5.5, Gemini 3.8 Flash, MAI-Code-1.1-Flash. "Available models may be limited by model policies." Fallback: "as the long term support model, GPT-5.3-Codex will be used in the event no other models are available."
- **Excluded:** models unavailable on the plan, blocked by admin policy, restricted by data residency or FedRAMP, or installed locally.
- **VS Code side** (https://code.visualstudio.com/docs/copilot/customization/language-models): "VS Code evaluates task complexity and real-time model availability to route each request to the optimal model." Same three tiers. Auto can route to an on-device model: "If the on-device model can't respond, model selection falls back to a cloud model before the first output." "Copilot Fusion replaces Auto when dynamic Auto tiers are enabled" in Copilot harness sessions. I didn't find Fusion's details; the docs.github.com Fusion URL returned 404 (unverified).
- **Subagents in VS Code** (https://code.visualstudio.com/docs/copilot/agents/subagents): precedence is explicit `runSubagent` model, then custom agent `model` (name or prioritized list), then Auto (experimental `chat.subagents.defaultToAuto`, off by default), then inherit. Explicit selections are "checked against the main model's cost tier". If a selection exceeds that tier, the subagent doesn't run.

### 1.2 Cursor — Auto / Cursor Router

Sources: https://cursor.com/docs/models, https://cursor.com/docs/cursor-router, https://cursor.com/docs/subagents

- **Modes:** "Cost, Balance, and Intelligence." Cost = "the previous Auto routing logic. It optimizes token spend." Balance "Optimizes for intelligence, speed, and cost." Intelligence "Routes to the most capable models for harder tasks."
- **Granularity:** Cursor Router "runs a classifier on each agent request." Signals: "task type and complexity". Nothing else is documented.
- **Cache awareness:** not documented. The only cache mention is billing: third-party routes are exempt from the Cursor Token Rate if "cache-read price is strictly below $0.10 per million tokens across every pricing tier." Whether a conversation sticks to one model is undocumented (unverified).
- **Billing:** "Cost mode (classic Auto) bills as a Cursor-model request and draws from your weekly pool whatever model serves it." "Balance and Intelligence bill at the routed model's list price."
- **Eligibility:** Router is "only available on Teams and Enterprise plans". It is off by default for Enterprise. "Enabling Grok 4.6 is a requirement for the router to work." "Blocking too many models reduces routing quality and can disable the router."
- **Subagents:** default `model: inherit`. The built-in Explore subagent "Uses a faster model to run many parallel searches." "Each subagent has its own context window." "Subagents start with a clean context." On legacy request plans without Max Mode, "subagents run using Composer regardless of any `model` configuration."

### 1.3 Claude Code (Anthropic)

Sources: https://code.claude.com/docs/en/model-config, /sub-agents, /costs, /prompt-caching, /env-vars; blog https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/

**Aliases and defaults**
- Aliases: `default`, `best`, `fable`, `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan`.
- `opusplan`: "Special mode that uses `opus` during plan mode, then switches to `sonnet` for execution." Env: `ANTHROPIC_DEFAULT_OPUS_MODEL` = "Model ID that the `opus` alias resolves to, and that `opusplan` uses while Plan Mode is active"; `ANTHROPIC_DEFAULT_SONNET_MODEL` = "...that `opusplan` uses when Plan Mode is not active."
- Default model: Opus 5.5 on Pro/Max/Ultra/Team/Enterprise/API, Bedrock, Vertex and Claude Platform on AWS. Microsoft Foundry defaults to Sonnet 4.5.
- **Fallback chains:** `--fallback-model sonnet,haiku` or `"fallbackModel": [...]`, capped at three models. "When a subagent's request fails over, Claude Code tries your configured fallback models in order." Automatic safety-classifier fallback on Fable/Opus 5.5/Sonnet 5.5/Opus 5 "is also a model switch".

**Small/fast model for background tasks**
- `ANTHROPIC_DEFAULT_HAIKU_MODEL`: "Model ID that the `haiku` alias resolves to, also used for background functionality."
- `ANTHROPIC_SMALL_FAST_MODEL`: "[DEPRECATED] Name of Haiku-class model for background tasks."
- One background call is named: session titles ("the background small/fast-model request that generates a session title", `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`). On Bedrock, background tasks run "on the default Sonnet model or the primary model" unless a Haiku model is set.
- Prompt suggestions are designed to reuse the main cache: the request goes "to the model your session is using... That request reuses the conversation's prompt cache, so it is mostly cache reads plus a few output tokens" (costs page). This is a deliberate choice of the *same* model, to stay cache-warm.

**Sub-agents**
- `model:` frontmatter accepts `sonnet`, `opus`, `haiku`, `fable`, a full model ID, or `inherit`. Resolution order: per-invocation `model` param (alias only), then frontmatter, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main conversation model.
- Built-ins: **Explore** now uses "the main conversation's model" (except that when main is Fable on first-party or gateway connections, Explore uses the `opus` alias). This changed from the earlier Explore-on-Haiku design. The blog still says "Claude Code's Explore agents, which use Haiku", so it reflects the older behavior. Plan inherits. general-purpose uses `CLAUDE_CODE_SUBAGENT_MODEL` if set, otherwise inherits. claude-code-guide = Haiku. statusline-setup = Sonnet.
- "Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions."
- Per-subagent cache TTL: `experimental.cacheTtl: 5m|1h` (v2.1.248+).
- Costs advice: "For simple subagent tasks, specify `model: haiku`."

**Fork vs sub-agent (directly relevant to router design)**

| | Fork | Non-fork subagent |
|---|---|---|
| Context | Full conversation history | Fresh context with the prompt you pass |
| Model | Same as main session | From the subagent's `model` field |
| Prompt cache | Shared with main session | Separate cache |

"Because a fork's system prompt and tool definitions are identical to the parent, its first request reuses the parent's prompt cache." Takeaway: **keep the model to reuse the cache (fork), or switch the model with a fresh, short context (sub-agent).** Claude Code never switches models on a long shared context.

**`/model` mid-session and cache**
- "Each model has its own cache. Switching with `/model` means the next request reads the entire conversation history with no cache hits, even though the content is identical."
- "Claude Code asks you to confirm the switch only while the cache is still warm and the new model isn't the one that produced the last response." This is TTL-aware, since v2.1.238. A `PreModelSwitch` hook can require or skip confirmation.
- `opusplan`: "each plan-mode toggle is a model switch and starts a fresh cache."
- A skill whose frontmatter names a different `model` makes that turn a model switch: "the next request reads the entire conversation history with no cache hits. The session model resumes on your next prompt." The switch back is therefore a second cold read if the original model's cache expired; if it is still within TTL it can be a hit (inferred).
- Effort level: "on most models, each effort level has its own cache". The exception is Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 on API key or subscription. Fast mode keeps a separate cache.
- Plan mode itself is cache-safe: it is implemented as tools (`EnterPlanMode`/`ExitPlanMode`) plus a system message, so "The tool definitions never change" (blog).

**Auto-compaction**
- Compaction "replaces your message history with a summary. By design, this invalidates the conversation layer." The summarization request "repeats your conversation's system prompt, tools, and the history being summarized. It ends with a summarization instruction. While the cache is warm, that request reads your prefix from the cache." This is the cache-safe fork pattern. In the blog's figure, a forked compaction call reuses the prefix "at one tenth the price" and returns a summary of ~20k tokens.
- Idle compaction can run on 1h-TTL sessions (`idleCompaction` setting). Sub-agents auto-compact independently; `autoCompactWindow` frontmatter is available.
- **Router implication:** a post-compaction boundary is a natural low-cost point to switch models, because the prefix is short. This is likely one of the "natural cache boundaries" Copilot means (inference).

**TTL policy** (prompt-caching page): main conversation gets 1h on subscription within plan, otherwise 5m. "Everything else" (subagents, workflows, forks, compaction, titles) gets 5m by default. Overrides: `promptCacheTtl`, `subagentPromptCacheTtl`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `ENABLE_PROMPT_CACHING_1H`, `FORCE_PROMPT_CACHING_5M`. Disable with `DISABLE_PROMPT_CACHING[_HAIKU|_SONNET|_OPUS|_FABLE]`.

**Gateway caveat (relevant if our router is an `ANTHROPIC_BASE_URL` gateway):** if the gateway "Removes the markers while returning success: your entire conversation history bills as uncached input on every turn". For 1h TTL through a gateway, "configure the gateway to forward that header [`anthropic-beta`] unchanged".

**Observability:** `/usage` shows "Prompt cache (main): 14 requests · 91% of input tokens from cache · 2 misses ... likely cause: tool definitions changed". Anthropic says it treats cache hit-rate drops as incidents: "we run alerts on our prompt cache hit rate and declare SEVs if they're too low" (blog).

### 1.4 Cline — Plan/Act with separate models

Source: https://docs.cline.bot/features/plan-and-act
- "Plan & Act modes separate thinking from doing."
- Setting: "Use different models for Plan and Act". Typical use is a strong reasoning model for Plan and a faster one for Act.
- "The conversation history carries over when you switch modes." There's no cache discussion. So **each Plan/Act toggle sends the full history to a different model, which means a cold prefill** (inferred from the provider cache rules above). Cline isn't cache-aware here.
- Granularity: per mode (user-driven). Open source, VS Code extension, BYOK.

### 1.5 Roo Code — sticky models per mode, Orchestrator (Boomerang)

Sources: https://roocodeinc.github.io/Roo-Code/basic-usage/using-modes, https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks
- "Each mode remembers your last-used model." So switching mode switches model (sticky per mode).
- Mode switching: dropdown, slash commands (`/architect`, `/ask`, `/debug`, `/code`, `/orchestrator`), keyboard shortcut, or "Click on mode switch suggestions that Roo offers when appropriate." The using-modes page doesn't document fully autonomous switching (`switch_mode` tool; unverified there).
- Orchestrator: "No direct tool access. It delegates subtasks to other modes using the `new_task` tool." "Each subtask operates in complete isolation with its own conversation history." "only this summary returns to the parent" (via `attempt_completion` `result`). With sticky per-mode models, **a subtask in another mode runs on that mode's model with a fresh context.** This is the same cache-friendly hand-off pattern as Claude Code sub-agents (the per-subtask model follows from sticky-mode; inferred).
- Prompt caching isn't discussed on these pages.

### 1.6 Kilo Code

Source: https://kilo.ai/docs/basic-usage/orchestrator-mode
- "Orchestrator mode is deprecated and will be removed in a future release." Code/Plan/Debug agents can now delegate to subagents directly.
- "The subagent has a separate conversation history but shares the parent's project directory or worktree."
- Per-mode/per-subagent model config isn't described on this page (unverified).

### 1.7 Aider — architect/editor + weak model

Sources: https://aider.chat/docs/usage/modes.html, https://aider.chat/docs/config/options.html, https://aider.chat/docs/usage/caching.html
- Architect mode: "An architect model will propose changes and an editor model will translate that proposal". "this uses two LLM requests, which can take longer and increase costs." `--editor-model`: "Specify the model to use for editor tasks".
- `--weak-model`: "Specify the model to use for commit messages and chat history summarization (default depends on –model)". This is role-based routing: cheap model for side tasks that use a small fresh context.
- Caching: `--cache-prompts`. Aider "organizes the chat history to try and cache: The system prompt. Read only files... The repository map. The editable files". `--cache-keepalive-pings N` "ping every 5 minutes to keep the cache warm".
- Granularity: per role, fixed per invocation. Cache awareness: sticky per model, with keepalive. Open source, local CLI.

### 1.8 OpenAI — GPT-5 router (ChatGPT), Auto, Codex

- **GPT-5 router (Aug 2025).** System card / launch, quoted via https://simonwillison.net/2025/Aug/7/gpt-5/ and https://en.wikipedia.org/wiki/GPT-5, since openai.com returned 403: GPT-5 in ChatGPT is "a unified system" with a fast model, a deeper reasoning model, and "a real-time router that quickly decides which model to use based on conversation type, complexity, tool needs, and explicit intent (for example, if you say "think hard about this" in the prompt)." "Once usage limits are reached, a mini version of each model handles remaining queries." "In the near future, we plan to integrate these capabilities into a single model."
  - Training signals: the launch post reportedly says the router "is continuously trained on real signals, including when users switch models, preference rates for responses, and measured correctness" (**unverified**, primary page blocked).
  - **API vs ChatGPT:** "GPT-5 in the API is simpler: it's available as three models" (gpt-5 / mini / nano, plus a chat-latest alias). The router is a ChatGPT feature; the API has no server-side model router. Developers choose the model and `reasoning_effort` themselves (Simon Willison summary of the system card).
  - Launch issues: Altman said "the autoswitcher broke and was out of commission for a chunk of the day" (Bloomberg via Wikipedia). Users criticized inconsistent quality and loss of control.
- **GPT-5.x and ChatGPT "Auto".** Later releases (GPT-5.1 "Instant" and "Thinking", https://en.wikipedia.org/wiki/GPT-5.1) kept the Auto/Instant/Thinking picker in ChatGPT. Press reports in late 2025 said OpenAI rolled the auto-router back for free users and defaulted them to Instant (**unverified**: wired.com and help.openai.com could not be fetched). Granularity is per message, with no documented cache awareness. ChatGPT is a consumer product where OpenAI owns both sides, so cache cost is internal.
- **Codex** (https://learn.chatgpt.com/docs/models): "If you don't specify a model, the ChatGPT desktop app, Codex CLI, or IDE extension uses a recommended model." "In an interactive CLI session, use `/model` to switch models or adjust reasoning effort." "You can change models as your work changes." The page documents no automatic model or effort router and has no prompt-caching guidance. Ultra mode "uses subagents to accelerate complex work". Subagent model config wasn't found (subagents doc URL 404, unverified). Codex CLI is open source.

### 1.9 Other harnesses (brief; only what was sourced)

- **Kiro Auto** (https://kiro.dev/docs/chat/model-selection/): "Routes to the optimal model per task, balances quality and cost automatically." Auto is the 1.0x credit baseline; other models are priced relative to it. Criteria aren't disclosed. In CLI 2.33+, fallback on Auto doesn't name a model because "the service picks the model". No caching info.
- **Devin Desktop (formerly Windsurf; docs.windsurf.com redirects here) — Fusion** (https://docs.devin.ai/desktop/fusion, https://docs.devin.ai/desktop/models): "Fusion pairs a frontier lead model with a cost-efficient sidekick model." The lead "plans, reasons through the hard parts, and reviews the work". The sidekick does "writing code, running builds and tests, and verifying changes", and "most routine work runs on the cheaper sidekick model." Task-specific in-house models: `SWE-1-mini` (Tab), `swe-grep` (context retrieval), `swe-check` (Quick Review). Voice mode "uses a separate agent model". There is no "Auto" router; caching isn't mentioned.
- **Factory Droid** (https://docs.factory.com/cli/user-guides/choosing-your-model): per-model `reasoningEffort`. A related-resource blurb says "Let Factory route requests across providers automatically". The mechanism isn't described (unverified).
- **Amp**: the manual intro says Amp uses "GPT-5.6, Claude Fable 5.1, fast models" — "for what each model is best at" (https://ampcode.com/manual). The modes page (smart/rush etc.) needs a login, so mode-to-model mapping and caching are **unverified**.
- **OpenHands**: not researched in depth. Its known LLM config supports separate models per agent and a condenser (unverified).

---

## Part 2 — Prompt-caching mechanics relevant to routing

### 2.1 Anthropic (Claude API)

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- **Prefix order:** "Prompt caching references the entire prompt: `tools`, `system`, and `messages` (in that order), up to and including the block designated with `cache_control`." Exact match: "Cache hits require 100 percent identical prompt segments".
- **Automatic caching:** "Add a single `cache_control` field at the top level of your request. The system automatically applies the cache breakpoint to the last cacheable block and moves it forward as conversations grow." It uses one of the 4 breakpoint slots. It's unsupported on the legacy Bedrock integration (Opus 4.6 and earlier), which returns a 400.
- **Breakpoints:** up to 4. "The system checks at most 20 positions for each breakpoint". Consecutive `tool_use` or `tool_result` blocks count as one position.
- **TTL:** 5m default, "refreshed for no additional cost each time the cached content is used". 1h is optional. Lifetime is "measured from the start of the request". Longer TTLs must appear before shorter ones.
- **Pricing:** write 5m = 1.25x base input; write 1h = 2x; read = 0.1x. Exceptions: Opus 5.5 and Sonnet 5.5 reads = 0.05x; Fable 5.1 and Mythos 5.1 = 0.025x.
- **Minimum cacheable length:** 512 tokens (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable/Mythos 5.x, Opus 5); 1,024 (Opus 4.8, Sonnet 5, Sonnet 4.6/4.5); 2,048 (Opus 4.7, Haiku 3.5); 4,096 (Opus 4.6/4.5, Haiku 4.5). Shorter prompts are silently not cached.
- **Invalidators:** "Modifying tool definitions (names, descriptions, parameters) invalidates the entire cache." Web search or citations toggles invalidate system and messages. `speed: "fast"` invalidates system and messages. `tool_choice` changes affect message blocks. Images added or removed affect messages. "The thinking configuration... is rendered into the prompt, so changing it always invalidates message blocks". "Changing the `output_config.effort` value always invalidates message blocks". Tip: append a `{"role":"system"}` message instead of editing top-level `system`.
- **Thinking blocks:** on Opus 4.5+, Sonnet 4.6+ and Haiku 5.5, "thinking blocks are preserved by default, so the cache remains valid". On earlier models, prior thinking blocks are stripped, which affects the cache.
- **Isolation:** "Caches are isolated between organizations." Isolation is per workspace on the Claude API, Claude Platform on AWS and Foundry; per organization on Vertex and Bedrock.
- **Cross-model:** the API page doesn't say outright, but Claude Code's docs do: "each model has its own cache"; "two requests share a cache only when their model, speed, and prefix match" (https://code.claude.com/docs/en/prompt-caching). **No cross-model sharing.**

### 2.2 OpenAI (API)

Source: https://developers.openai.com/api/docs/guides/prompt-caching
- "Prompt caching is enabled by default for supported OpenAI models." "Cache reuse requires the entire rendered prefix to match." Minimum is 1,024 tokens on GPT-5.6+. On earlier models, cached tokens are reported in 128-token increments.
- **Routing/affinity:** routing uses "A hash of the initial tokens after the hidden OpenAI content, including tool definitions when present. The number of tokens hashed varies by model." "Cached states live on individual machines, where traffic above 15 requests per minute can lead to overflow routing." Guidance: "aim for about 15 requests per minute in total across all prefixes using each key."
- **`prompt_cache_key`:** "separates cache reuse between groups of requests". "Keys influence routing; they do not pin requests to a machine or guarantee a cache hit." On GPT-5.6+ it's optional and used mainly for separate cache accounting. On earlier models it also helps routing. **For our router:** set a per-session or per-agent key so that same-session calls land on cache-warm machines. Don't use one global key for very high-RPM traffic, because overflow routing spreads it anyway.
- **Retention:** `in_memory` ("around 5 to 10 minutes of inactivity, up to one hour"). `24h` ("typically keeps entries available for around 30 minutes and can retain them for up to 24 hours"). Non-ZDR orgs default to 24h; ZDR orgs default to in_memory. GPT-5.6+ uses `prompt_cache_options.ttl` = `30m` (default) or `12h`.
- **Explicit breakpoints and write billing (GPT-5.6+):** "Explicit-only mode lets you choose where cache writes end." "For GPT-5.6 and later, cache writes cost 1.25× the standard, uncached input-token rate for the default 30-minute lifetime". 12h writes cost 2.5×. Earlier models have no write surcharge. Reads: "discounted up to 95%". GPT-5.6+ reads are 0.1×; GPT-6.1 Sol/Terra are 0.05×.
- **Scope:** "Caches are not shared across organizations and cannot be reused across regional processing boundaries." Cross-model sharing isn't stated outright ("A different model can use different weights and caching behavior"). Assume none.
- **Note:** OpenAI is moving toward Anthropic-style economics (explicit breakpoints plus a write premium on GPT-5.6+). This makes model-switch penalties on OpenAI models larger than the earlier free-write regime.

### 2.3 Google Gemini

Sources: https://aistudio.google.com/docs/caching, https://aistudio.google.com/api-reference/caching
- **Implicit caching:** "Implicit caching is enabled by default for all Gemini 2.5 and newer models." Minimums: 4,096 tokens (Gemini 4 Argon, 3.8 Flash, 3.6 Flash, 3.1 Pro Preview); 2,048 (2.5 Flash/Pro). Tips: "Try putting large and common contents at the beginning of your prompt"; "Try to send requests with similar prefix in a short amount of time". On multi-turn with Gemini 4+, "Gemini caches the full previous request only if the new request adds at least 2,050 tokens." The fetched page gives no discount percentage ("We automatically pass on cost savings").
- **Explicit caching (CachedContent):** not supported on the Interactions API "or for Gemini 4 Argon and onward". It remains available on Gemini 3 / 2.5 via `generateContent`. **Model-bound:** the `model` field is "Immutable", and "Cached content can be only used with model it was created for." TTL is set via `ttl` or `expireTime`. The fetched pages don't state the default TTL or storage price; earlier docs stated 1h default and hourly storage pricing (unverified for current).

### 2.4 Amazon Bedrock

Source: https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
- Two types: **Implicit** ("Amazon Bedrock and the model automatically attempt to reuse eligible prompt prefixes"; best-effort) and **Explicit** (cache checkpoints / `cache_control`). "Anthropic models that support prompt caching on Amazon Bedrock support Explicit Prompt Caching. Requests without cache controls aren't cached."
- **Checkpoint order:** "Cache checkpoints are processed in this order: `tools` → `system` → `messages`... changing content in an earlier section invalidates the cache for later sections". Minimum token counts are cumulative across sections.
- **Server locality:** "A cache entry is stored on the server that processed the request, and a later request can read it only if that server handles it before the entry expires. Requests that are served by a different server, such as one in another Region, or that are sent before an identical request has started its response, write a new entry instead of reading one." With cross-region inference: "At times of high demand, these optimizations may lead to increased cache writes." This matters for **parallel sub-agent fan-out**: sibling requests sent before the first response starts won't hit. Claude Code's workflow fan-out holds siblings "for up to 5 seconds" for this reason (https://code.claude.com/docs/en/prompt-caching).
- **Supported models (explicit):**
  - Claude Haiku/Sonnet/Opus 5.5, Fable 5.1/5, Mythos 5.1/5, Opus 5: min 512 tokens, 4 checkpoints, TTL 5m and 1h, fields `system`/`messages`/`tools`.
  - Opus 4.8 and Sonnet 5/4.6: 1,024.
  - Opus 4.7/4.6/4.5 and Haiku 4.5: 4,096. All of these support 5m and 1h.
  - OpenAI GPT-5.6 Sol/Terra/Luna, GPT-6 Astra/Sol/Luna, GPT-6.1 Sol: 1,024, 4 cache writes, **30-minute** TTL, `prompt_cache_breakpoint`. Converse doesn't support explicit caching for these.
  - Nova 2 Lite / Pro / Lite / Micro: 1K min, 20K max cacheable, 5m, `system` and `messages` only.
- **Automatic caching** (top-level `cache_control`) is supported on Claude Haiku 4.5, Sonnet 4.6, Opus 4.7, 4.8, 5, 5.5, Sonnet 5, 5.5 and Haiku 5.5.
- **Billing:** cache-write rate (can be higher than input), cache-read rate, plus standard input. Cache hits don't count against rate limits for the listed Claude and OpenAI models. On-demand only; not batch.
- **Isolation:** organization-level for Claude on Bedrock (Anthropic doc). Cross-model sharing isn't mentioned; assume none (consistent with Anthropic).

### 2.5 Is cache ever shared across models?

**No**, for every source checked.
- Anthropic/Claude Code: explicit ("each model has its own cache").
- Gemini explicit cache: explicit (model-bound, immutable).
- OpenAI: implied ("different weights and caching behavior").
- Bedrock: entries are server-local, and servers are model-specific.

KV cache is a function of model weights, so this holds by construction. The only cross-*request* sharing is same-model, same-org/workspace, same-prefix (plus same speed/effort on some Anthropic models). Fast mode and standard speed keep separate caches even on the same model.

### 2.6 Provider and infra "cache-aware routing" (replica-level, same model)

| System | What it does | Source |
|---|---|---|
| OpenAI `prompt_cache_key` | Hash of the prefix plus an optional key steers requests to cache-warm machines; ~15 RPM per key before overflow; "do not pin requests to a machine" | https://developers.openai.com/api/docs/guides/prompt-caching |
| Bedrock | Cache is server-local; cross-region inference can raise cache writes; no user-facing affinity key documented for Claude. `prompt_cache_key` appears in the GPT-5.6 Responses example | https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html |
| **llm-d Router** (ex "Inference Scheduler"; Endpoint Picker for Gateway API Inference Extension) | "LLM load and prefix-cache aware routing". The EPP weighs "KV-cache locality, current load, and priority". Pluggable filters and scorers: `prefix-cache-scorer` fed by `approx-prefix-cache-producer` or `precise-prefix-cache-producer` (KV events), `inflight-load-producer`, `session-id-producer`, `predicted-latency-producer`. Also P/D disaggregation sidecar. Integrates with Envoy via ext-proc | https://github.com/llm-d/llm-d-inference-scheduler, docs/architecture.md |
| **NVIDIA Dynamo KV router** | Consumes worker KV events into a KV indexer (radix/hash), or predicts cache state if events are disabled (TTL/LRU). Cost = `prefill_load_scale * max(0, active_prefill_blocks + incoming_prompt_blocks − overlap_credit_blocks) + potential_decode_blocks + active_request_blocks`; picks min cost; `router_temperature` > 0 gives softmax sampling. Tiered credits for host (0.75) and disk (0.25) cache hits. Policies include `dynamo-two-tier-cost-fn` (load first, then prefix overlap) and `dynamo-sticky-min-load` (session-sticky via `X-Dynamo-Session-ID`). `nvext.agent_hints.osl` gives expected output length for agent requests | https://github.com/ai-dynamo/dynamo docs/fern/.../router/routing-concepts.md and configuration-and-tuning.md |
| **SGLang Model Gateway** (sgl-model-gateway, ex sglang-router) | Policies `random`, `round_robin`, `cache_aware`, `power_of_two`, `bucket`. `cache_aware` "maintains a prefix tree of prompts to route repeat traffic and evens load with configurable thresholds (`--cache-threshold`, `--balance-abs-threshold`, `--balance-rel-threshold`, `--eviction-interval`, `--max-tree-size`)". Separate prefill and decode policies in PD mode | https://github.com/sgl-project/sglang/tree/main/sgl-model-gateway (README) |
| **AIBrix** (vLLM project) | Gateway "Picks a pod from live engine state, including prefix-cache, load, and prefill/decode placement". Session affinity "for agentic workloads". Distributed KV cache: "Offload KV cache and reuse it across engines" | https://github.com/vllm-project/aibrix |
| vLLM production-stack router | Prefix-aware / session routing (not fetched; **unverified**) | — |

**Router implication:** these systems solve *which replica* for a fixed model. Session stickiness (Dynamo `X-Dynamo-Session-ID`, llm-d `session-id-producer`, AIBrix session affinity, OpenAI `prompt_cache_key`) is the replica-level twin of model stickiness. An agent-facing model router should pass a stable session or agent ID downstream as an affinity key.

---

## Design takeaways (synthesis; not vendor claims)

1. **Decide at boundaries.** Re-evaluate the model only when the expected cache hit is ~0 anyway: a new session, a new sub-agent or subtask with a fresh context, after compaction, after a TTL lapse (cache idle > 5m/30m/1h depending on provider), or after tool-set changes that already broke the cache. This matches Copilot ("natural cache boundaries") and Claude Code (confirmation only "while the cache is still warm").
2. **Cost-model the switch.** Switching on a context of N tokens costs roughly N × (write multiplier, 1.25–2× on Anthropic and GPT-5.6+) on the new model, versus N × read multiplier (0.025–0.1×) on the current one. Anthropic's 100k Opus-to-Haiku example shows the switch can cost more than staying.
3. **Route sub-agents, not turns.** Sub-agents and boomerang subtasks (Claude Code `model:`, Roo per-mode models, Cursor Explore "faster model", Devin Fusion sidekick, Aider weak/editor) start with a short context, so a cheaper model is cheap to start. Forks should keep the parent's model to reuse its cache.
4. **Treat effort, thinking, fast mode and tool lists as part of the cache key.** Anthropic invalidates message cache on thinking or effort change (except the documented 5.5-gen models), and fast mode keeps a separate cache. Hold them stable within a session, or price their changes like a model switch.
5. **Keep the prefix byte-stable through the router.** Don't reorder or strip `cache_control`. Forward `anthropic-beta` for 1h TTL. Set `prompt_cache_key` per session for OpenAI. Avoid sending parallel sibling calls before the first has started responding (Bedrock server-local writes).
6. **Track cache hit rate as a first-class SLO**, as Anthropic does ("declare SEVs if they're too low").
