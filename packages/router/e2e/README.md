# E2E runner (design §6)

`run.py` (uv, boto3, requests) checks a deployed router stack, E0–E12. `sdk.ts` makes the client-compatibility calls with the official OpenAI and Anthropic SDKs, using the router's dev dependencies.
- **Stack:** the runner only reads the router stack. The one thing it creates is E0's temporary probe stack `<prefix>-e2e-probe` (tagged `Purpose=mvp-e2e`), which `e0-teardown` deletes.
- **Account:** it refuses to run unless the caller account is `LLMAR_SPIKE_ACCOUNT`.
- **Secrets:** the Cognito client secret and the access tokens are read at runtime and kept in memory only.
- **Results:** written to `results/` (gitignored), with account ids masked. The spend ledger is `results/ledger.json`, capped at USD 4.50 by default (`--cap`).
  - Each call is priced from the usage in its response, and the run stops as soon as the total reaches the cap.
  - **A failed or timed-out call is priced at 0**, even though Bedrock may have billed part of it, so the ledger can undercount.
- **Child processes:** `sdk.ts` gets only `PATH`, with no `AWS_*` and no home-directory config. The gateway URL and the token reach it on stdin.

## What the runner writes in the account

- **Probe stack (E0 only):** a CloudFormation stack `<prefix>-e2e-probe`, tagged `Project=llm-auto-router, Purpose=mvp-e2e`, containing:
  - a Lambda function, its log group (1-day retention) and an IAM role (Lambda VPC access + `execute-api:Invoke` on the router API);
  - a security group;
  - **an ingress rule on the router stack's execute-api endpoint SG** (`ApiVpceSgId`), owned by the probe stack, so the probe can reach the endpoint.
  `e0-teardown` deletes all of it and exits non-zero if it can't. `pre-destroy` and `verify-teardown` refuse while the stack exists.
- **Bedrock invocations:** about 260 short calls in total, mostly E11's 200, all under the cap.
- **Stored Responses objects:** E2 creates two responses with `store: true` and deletes them immediately with the documented `DELETE /openai/v1/responses/{id}` on bedrock-runtime, using SigV4 with your credentials (`bedrock:DeleteInvoke`). Their ids and delete statuses are in `results/e2.json`. Any that weren't deleted expire after 30 days (Bedrock Responses retention).
- **CloudWatch Logs reads** (E3, E5b, E6, E8, E9, E11, E12): `filter_log_events` on the router log group. E12 sends no filter pattern and scans locally, so no secret is ever part of an AWS request.
- **Other reads** (E7b): ECS `describe_services`, ELB `describe_load_balancers` / `describe_target_groups` / `describe_target_health`, CloudWatch `list_metrics` / `get_metric_data` on `AWS/Bedrock-AgentCore`. E7b never scales anything itself; you redeploy.

## Deploy order and commands

Run from the repository root with credentials for the target account.

```
source scripts/local.env                                    # LLMAR_SPIKE_ACCOUNT
R=<aws-region>; A=<account-id>; P=<unique-prefix>; OWNER=<owner>
PL=$(aws ec2 describe-managed-prefix-lists --region $R \
      --filters Name=prefix-list-name,Values=com.amazonaws.$R.s3 --query 'PrefixLists[0].PrefixListId' --output text)
CTX="-c region=$R -c account=$A -c prefix=$P -c tags={\"Owner\":\"$OWNER\"}"
```

1. **Bootstrap**, one-time per account and Region: `(cd infra && npx cdk bootstrap aws://$A/$R $CTX)` (the CLI synthesizes the app first, so it needs the same context). The router image is built by `cdk deploy` as an ARM64 Docker asset, so no separate image build or push is needed; Docker must be running.
2. **Deploy at 0 tasks.**
   ```
   (cd infra && npx cdk deploy $CTX -c routerDesiredCount=0 --parameters S3PrefixListId=$PL)
   ```
3. **Gate at 0.** `uv run packages/router/e2e/run.py --region $R --prefix $P e0`. It stops the run on any failure.
4. **Scale to 1.** Redeploy with `-c routerDesiredCount=1`, keeping the same `$CTX` and parameter.
5. **Gate at 1, then the checks.**
   - Run `run.py … e0` again.
   - Run `run.py … all`, which covers e0–e5, e5b, e8, e9, e11 and e12.
   - Then `run.py … e0-teardown`.
6. **State-specific checks.** Each one needs the stack redeployed with the context shown. Use the same `$CTX` and parameter every time, and drop the e2e keys before going back to normal.

   | Check | Deploy context | Notes |
   |---|---|---|
   | E6 | `-c routerDesiredCount=1 -c e2eFault=upstream-503-once:2` | The 503 replaces the task's 2nd upstream attempt, once. Use a fresh task and run e6 first on it: turn 1 is router-served, turn 2 faulted (served by the gateway fallback), turn 3 must be `retain;failover` (`failover: exhausted`). |
   | E10 | `-c routerDesiredCount=1 -c e2eFault=pause-after-first-frame:330000 -c e2eIdleTimeoutMs=420000` | Takes about 6 minutes. |
   | E7 | `-c routerDesiredCount=0` | The gateway documents no fallback or circuit-breaker metric; E7b records the gateway metrics it does publish. |
   | E7b | start at `-c routerDesiredCount=0` | Informational. Run `run.py … e7b` (`--n 30 --probe-s 10 --recover-min 30`). When it prints "phase A done", redeploy with `-c routerDesiredCount=1` from another terminal. It records when the router has a healthy NLB target and when `auto` is served by the router again, then the gateway's CloudWatch metrics for the window. About 6–8 minutes plus the deploy. |

7. **Teardown.**
   - `run.py … e0-teardown`, if it hasn't run yet, then `run.py … pre-destroy` (refuses while the probe stack exists).
   - `(cd infra && npx cdk destroy $CTX)`.
   - `run.py … verify-teardown`. Everything must be empty, except the default-SG custom resource's `/aws/lambda/…CustomVpcRestrictDefaultSG…` log group, which you delete by hand.

## Checks

| Check | Deployment state | Budget (USD) |
|---|---|---|
| e0 | 0 tasks, then 1 | 0 |
| e1 | 1 task | 0.05 |
| e2 | 1 task | 0.05 |
| e3 | 1 task (Anthropic-SDK agent loop shaped like Claude Code: synthetic tool_use/tool_result transcript, 12 calls, tool_choice auto, no local tools) | 0.30 |
| e4 | 1 task | 0.60 |
| e5 | 1 task | 0.02 |
| e5b | 1 task (`auto:fast` on all three paths, `auto:bogus`, `autox`) | 0.02 |
| e6 | `e2eFault=upstream-503-once:2` | 0.05 |
| e7 | 0 tasks | 0.10 |
| e7b | 0 tasks, then scaled to 1 while it runs (informational: circuit-breaker recovery timing) | 0.10 |
| e8 | 1 task | 0.05 |
| e9, e12 | after the others; scans the last `--window-min` minutes of router logs | 0 |
| e10 | `pause-after-first-frame` revision | 0.05 |
| e11 | 1 task | 0.20 |

Each check writes `results/<check>.json` with PASS or FAIL per assertion and its evidence.

**Turns served by the gateway fallback are invisible to the router** (confirmed live in E6 and E7). When the router answers 5xx or can't be reached, the gateway's `bedrock` target serves the request directly. The router never sees that turn's usage or served model, so it is missing from the router's cost accounting, logs/EMF and session state. The next routed turn still sees the whole history in its request, but core's lineage has a gap. Use the gateway's own metrics (fallback and circuit-breaker) and Bedrock's invocation metrics to account for those turns.

## Trying it with Claude Code (manual, in your own sandbox)

The runner never starts Claude Code. An autonomous agent with shell access would inherit the operator's AWS identity, `~/.aws`, `~/.claude` settings, hooks and MCP servers. To see Claude Code against your deployment, do it yourself in an isolated environment, ideally a throwaway container with no cloud credentials:

```
# inside a container or VM with no AWS credentials and no ~/.aws, ~/.claude
umask 077; HELPER=$(mktemp); TOK=$(mktemp)
<obtain a client-credentials access token for <prefix>/invoke> > "$TOK"          # 0600 by umask
printf '#!/bin/sh\ncat %s\n' "$TOK" > "$HELPER"; chmod 700 "$HELPER"
env -i PATH="$PATH" HOME="$(mktemp -d)" \
  ANTHROPIC_BASE_URL="https://<gateway-host>/inference" ANTHROPIC_MODEL=auto ANTHROPIC_SMALL_FAST_MODEL=auto:fast \
  claude --bare --restricted --strict-mcp-config --setting-sources '' \
    --settings "{\"apiKeyHelper\": \"$HELPER\"}" \
    --allowedTools 'Read,Grep,Glob' --max-budget-usd 1 \
    -p "Summarise this repository's README."
rm -f "$HELPER" "$TOK"
```

- Check the flags against `claude --help` for your version; this assumes the isolation flags listed above exist there.
- Keep `--allowedTools` narrow; no `Bash` unless the sandbox is disposable.
- The token comes from an `apiKeyHelper` file that only you can read, and is deleted afterwards; it never goes into the environment or the command line.
- The router logs show the betas Claude Code sent (`headers.anthropic-beta`) and the decision per turn.
