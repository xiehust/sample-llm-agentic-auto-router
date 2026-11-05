# Replay trace data

Everything in this directory except this README is gitignored. **Trace files are untrusted data.** The
adapters only `JSON.parse` and type-check them. Nothing from here is executed, imported, or used as a path or
a command.

## TraceLab v0.0.2 (`tracelab/`)

- Source: https://github.com/uw-syfi/TraceLab, release `v0.0.2`, asset `syfi_coding_trace.jsonl.gz`
  (665,453 LLM rounds, 8,058 Claude Code / Codex sessions).
- sha256: `11ce51ec0a25e3d1d95b025bca2f7d1647e47571eb7cc968acd5fc64d4b4fb65`. This matches the GitHub release
  asset digest.
- Licence: **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/). Attribution: "TraceLab (SyFI Lab,
  University of Washington)", https://tracelab.cs.washington.edu.
- Changes we make: we convert the trace to `replay-trace/v1`, with a reconstructed prefix identity (task
  `11-04-replay-evaluator` design §3.1). The same attribution is printed in every replay report.

Fetch, verify and convert (run from `packages/replay`):

```bash
mkdir -p data/tracelab
curl -L --fail -o data/tracelab/syfi_coding_trace.v0.0.2.jsonl.gz \
  https://github.com/uw-syfi/TraceLab/releases/download/v0.0.2/syfi_coding_trace.jsonl.gz
echo "11ce51ec0a25e3d1d95b025bca2f7d1647e47571eb7cc968acd5fc64d4b4fb65  data/tracelab/syfi_coding_trace.v0.0.2.jsonl.gz" | sha256sum -c -
node src/cli.ts convert tracelab data/tracelab/syfi_coding_trace.v0.0.2.jsonl.gz data/tracelab/tracelab-v0.0.2.replay.jsonl
node src/cli.ts replay --trace data/tracelab/tracelab-v0.0.2.replay.jsonl --policy all --out report.json
```

## Synthetic (`synth/`)

`node src/cli.ts synth agent|breakeven <out>` generates deterministic, seeded synthetic traces.
