# Live smoke test (2026-11-04, bedrock-runtime ap-northeast-1)

Pack `assessor/v1`. The cards are 5 hand-labelled items: 3 fast (including one prompt-injection attempt), 1 standard and 1 frontier.

Account check:
- Before any Bedrock call, the caller account must equal `LLMAR_SPIKE_ACCOUNT`.
- The id is not recorded here.

Request, response and account ids are scrubbed from every saved file.

| Model / API | Calls | Result | Tiers (gold → proposed) | Latency | Tokens in / cached / out | $ per call |
|---|---|---|---|---|---|---|
| GPT-6 Luna · Responses (`text.format` json_schema strict, effort `none`, `prompt_cache_key`) | 5 (concurrency 4) | 5/5 valid | 5/5 match | 1.36–1.58 s | ≈3,970 / 0 / 165–199 | ≈$0.00058 |
| GPT-6 Luna · Chat (`response_format` json_schema strict, `reasoning_effort: none`) | 5 (sequential) | 5/5 valid | 5/5 match | 1.24–1.42 s | ≈3,970 / 0 / 162–189 | ≈$0.00058 |
| Claude Haiku 5.5 · Messages (one forced tool), first attempt | 5 | 4 × HTTP 400, 1 timeout | — | — | — | — |
| Claude Haiku 5.5 · Messages (one forced tool), after the fix | 5 (sequential) | 5/5 valid | 5/5 match | 2.71–3.25 s | ≈7,090 / 6,657 (from the 2nd call) / 369–435 | $0.00106 on the first (cache write), then ≈$0.00032 |

Smoke spend: **$0.0128**, from the ledger. The total includes the failed Haiku calls, which are booked at their worst-case estimate.

## Findings

1. **Strict structured output works on Bedrock** for GPT-6 Luna on both Responses and Chat.
   - Forced `tool_choice` works for Haiku 5.5 on `/anthropic/v1/messages`.
   - The body accepted there is `anthropic_version: "bedrock-2023-05-31"` plus `model`.
2. **Haiku 5.5 rejects `temperature`:** `` `temperature` is deprecated for this model `` (HTTP 400). The adapter no longer sends it, and the golden test is updated.
3. **Latency is at or over the 1.5 s budget.**
   - Luna is at 1.24–1.58 s.
   - Haiku is at 2.7–3.3 s. Its prompt is about 7.1K tokens on the Claude tokenizer, against 3.97K for Luna, and it writes about twice as much output (≈400 tokens).
   - With a 1.5 s production timeout, most Haiku assessments would come back `unavailable`.
   - The eval measures this on 580 items.
4. **Luna caching: no cache read seen in 10 calls,** concurrent or sequential, with or without `prompt_cache_key`. Every input token was billed as a 30m cache write ($0.125/MTok).
   - Claude caching works from the second call.
   - Per-call cost is therefore about $0.0006 on Luna and $0.0003 on Haiku once warm. This is above the ≈$0.0003 estimated in research D for Luna, but cost is still negligible.
