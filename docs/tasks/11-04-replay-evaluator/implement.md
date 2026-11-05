# Implement plan: @auto-router/replay

Edit only `packages/replay/**` and this task directory. Add no new dependencies, make no commits, and make
no AWS calls. Trace data is untrusted: it is parsed as JSON only.

## Steps

1. [ ] **Scaffold**
   - `deps.ts` plus `_stubs/` (the §3 types, a minimal `costOf`, a pass-through engine).
   - `.gitignore` for `data/*`, and `data/README.md` (TraceLab source, sha256, CC BY 4.0 attribution, fetch command).
   - `package.json`: add the `replay` script and the `bin` entry. Scripts only, no dependencies.
2. [ ] **Schema and IO**
   - `schema.ts`: types plus a validator that checks Σ segments = promptTokens, ids are non-empty, and numbers are finite and ≥ 0.
   - `trace-io.ts`: streaming read and write, gzip-aware.
   - Tests cover validator rejections and a round trip.
3. [ ] **Prefix**
   - `prefix.ts`: the shared-prefix rule, plus the memoized `blockHashes`.
   - Tests cover append-only, rewrite, compaction, disjoint lineages, and hashes being stable and extending.
4. [ ] **Simulator** (`sim.ts`)
   - TTL with refresh-on-hit, minTokens, the write-price fallback, the lookback option, and scatter shards with a seeded PRNG.
   - Tests cover: hit within the TTL; expiry at TTL+1 ms; refresh extending the life; no sharing across models; fragmentation (A → B → A within the TTL rewrites only the delta); lookback miss; scatter determinism.
5. [ ] **Synthetic generator** (`synth.ts`)
   - A break-even scenario, plus an agent-session scenario with tool loops, user turns with idle gaps, compaction and sub-agents.
6. [ ] **Policies and replayer**
   - The model map, pools, `recorded`, `always-*`, `classifier`, `sticky-session`, `scripted`, and a `core-*` adapter that builds `RequestSummary` and uses a virtual clock.
   - `replayer.ts`.
   - Tests on synthetic sessions: `sticky` never switches; `classifier` switches on tool-result turns; `core-*` with the stub runs end to end.
7. [ ] **Break-even acceptance test** (`breakeven.test.ts`, design §7)
   - Uses the fixture catalog until pricing lands.
8. [ ] **Metrics, report, CLI** (`metrics.ts`, `report.ts`, `cli.ts`)
   - Report JSON plus a markdown table.
   - A snapshot test of the report on a small synthetic trace.
9. [ ] **TraceLab adapter** (`adapters/tracelab.ts`, design §3.1)
   - Unit tests on hand-written rows: drop/compaction, rewrite inference, append, timestamps, `lastTurn`.
   - Convert the full trace to `data/tracelab/tracelab-v0.0.2.replay.jsonl`, globally time-sorted.
10. [ ] **Calibration**
    - Run `recorded` on the converted trace.
    - Compare the simulated and recorded hit rates per provider. Target: Claude within 5 percentage points.
    - If it misses, tune the adapter rules (not the simulator) and document why.
11. [ ] **First policy report**
    - Run `--policy all` on the full trace: claude and codex separately, plus combined.
    - Save `research/replay-report-tracelab-v0.0.2.{json,md}` in this task directory, with the notes (prefix reconstruction limits, no failover, core rows pending if core has not landed).
12. [ ] **Integration** (when core and pricing land)
    - Switch `deps.ts` to the real packages, delete `_stubs/` and the fixture catalog (if the real catalog reproduces break-even), and re-run steps 7 and 11.
13. [ ] **Validation**
    - `pnpm -C packages/replay typecheck && pnpm -C packages/replay test`, plus `pnpm -r typecheck`.
    - Run trellis-check, then report to the parent: test results plus the report.

## Rollback points

- The simulator, policies and report (steps 2–8) stand on synthetic data alone. If the TraceLab conversion or calibration fails, the break-even acceptance still holds, and the trace gap is reported.
- If core slips, the baseline policies still produce a report, with the core rows marked `pending`.

## Performance budget

- Full trace: 665K calls × 8 policies.
- Target: under 3 minutes per policy on one core.
- Means: memoized block hashes (blocks of 4096 tokens), a trie cache, and lazy pruning.
- `--sessions N` / `--provider` filters are for quick runs.
