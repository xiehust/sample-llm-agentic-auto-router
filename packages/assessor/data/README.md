# packages/assessor/data (gitignored except this file)

Untrusted data. It is parsed with `JSON.parse` only. Never execute or import anything from this directory.

## SWE-bench Verified (`swebench-verified/rows.jsonl`)

- **Source:** `princeton-nlp/SWE-bench_Verified` on Hugging Face (500 rows, split `test`).
- **Fetched:** 2026-11-04, through the datasets-server JSON API (`/rows`, 5 pages of 100).
- **Fields kept:** `instance_id`, `repo`, `problem_statement`, `difficulty`. Everything else is dropped (patch, tests, hints, commits).
- **Licence check (2026-11-04):**
  - The dataset card declares no licence: `cardData` has no `license` tag, and the datasets-server `license` field is empty.
  - The SWE-bench project code (github.com/SWE-bench/SWE-bench) is MIT.
  - `problem_statement` is GitHub issue text from 12 upstream Python projects, which carry their own licences and GitHub's terms.
- **Use (project decision):**
  - internal offline evaluation only;
  - the raw text is not redistributed;
  - reports carry instance ids and aggregates only, with no quoted issue text;
  - few-shot examples are never drawn from this set.
- **Difficulty histogram:**

  | Difficulty | Rows |
  |---|---|
  | `<15 min fix` | 194 |
  | `15 min - 1 hour` | 261 |
  | `1-4 hours` | 42 |
  | `>4 hours` | 3 |

  Problem statement length: p50 1,187 chars, p95 4,789. 35 of the 500 exceed 4,000 chars.

Re-fetch with:

```
node src/eval/cli.ts fetch swebench
```

## eval-runs/

Run outputs and the budget ledger (`ledger.json`).
- Response ids, request ids and account ids are scrubbed before any file is written.
