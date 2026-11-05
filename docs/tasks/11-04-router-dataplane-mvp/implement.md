# Implement plan: router data plane MVP

Rules:
- Planning only until the user approves; then `task.py start`.
- **Every AWS write (deploy, update, destroy, invoke beyond the E2E budget) is executed by the parent session 0c.** The implementing session only writes code, synthesizes, and runs local tests.
- Resources are tagged `Project=llm-auto-router`, `Owner=<owner>`, `Purpose=spike|mvp`, and named with the `llmar-` prefix.
- Anonymous denial is verified before any traffic.
- No commits from child sessions.

## Step 0: Approvals (blocking)
- [ ] User reviews `prd.md` and `design.md` and answers the §7 open decisions.
- [ ] 0c approves the dependencies and installs them in the root lockfile:
  - router: `@smithy/signature-v4`, `@aws-crypto/sha256-js`, `@aws-sdk/credential-provider-node`, `@smithy/protocol-http` (+ `jose` only if V9 picks (b));
  - infra: `aws-cdk-lib`, `constructs`, dev `aws-cdk`, dev `cdk-nag`;
  - e2e (dev, in `packages/router`): `openai`, `@anthropic-ai/sdk`.

## Step 1: V9 hop spike (first; spike-style, `Purpose=spike`)
- **Code** (implementer): `spikes/agentcore-gateway/v9/`
  - a minimal CDK or `spike.py` extension: VPC, ECS stub (constant 200, echoes the *names* of headers plus the redacted `x-amzn-lattice-identity` principal and `x-amz-content-sha256`; never logs header values listed in design §2.8), Lattice network/service/listener/target group/auth policy, gateway with an inference target (`vpc-lattice-svcs`, `privateEndpoint`);
  - a check script implementing design §4 checks 1–6.
- **Run** (0c):
  - Deploy.
  - **Check 1 (gate) must pass before any other check.** Then run checks 2–5.
  - Tear down, and run the verification listing.
- **Output:** `research/v9-findings.md` with verdict (a) / (d) / (b) and evidence. If (a) fails on R-a1 (payload signing), try (d) in the same spike before falling back to (b).
- **Rollback:** `cdk destroy` / spike teardown; nothing else depends on it.
- **Validation:** checks script exit 0; teardown listing empty.

## Step 2: Router skeleton (local only)
- `packages/router/src/{config,server,routes,inbound,body,hints}.ts` + tests.
- Bind default `127.0.0.1`.
- Inbound checker for the V9 verdict, fail-closed when unset.
- `spliceTopLevel` with property tests (random JSON, whitespace and escapes preserved, only the `model` span changes).
- Hint unpacking; `x-router-tenant` stripped.
- **Validation:** `pnpm -C packages/router typecheck && pnpm -C packages/router test`.
- **Rollback:** delete the package (nothing else depends on it).

## Step 3: Forwarding, streaming, accounting (local fake Bedrock)
- `forward.ts` (SigV4 via injected signer; tests use a fake signer and credentials), `stream.ts` (incremental SSE tee, backpressure, abort), `account.ts` (pricing normalize, `costOf`, `core.record`, log, EMF).
- Fake Bedrock: a `node:http` server on `127.0.0.1:0` that replays the pricing fixtures (`packages/pricing/src/__fixtures__`), with chunk delays and fault modes (5xx before first byte, mid-stream reset).
- Tests:
  - three dialects × stream / non-stream;
  - usage and cost equal pricing hand values;
  - `chatIncludeUsage` inject-strip produces client bytes equal to the no-injection fixture;
  - client abort cancels upstream;
  - redaction test (no auth headers in logs).
- **Validation:** as in step 2, plus a `pnpm -r typecheck` contract check against core and pricing.

## Step 4: Failover, beta veto, opt-in hints
- `failover.ts`, `beta.ts` + `beta-compat.json` (seeded from V8 and the model cards), `claudeAutoCache`.
- Fault-injection env, gated by `ROUTER_FAULT_INJECT_ALLOW=1`.
- **Validation:** unit tests for retry-once-before-first-byte, no retry after the first byte, the veto path and its reason, and auto-cache insertion only when no `cache_control` exists.

## Step 5: Container
- `packages/router/Dockerfile`: node:24-slim arm64, `pnpm deploy --prod`, non-root, `HEALTHCHECK` none (Lattice checks).
- Image check without publishing any port: `docker run --rm --network none <img> node -e "<boot + GET /healthz on 127.0.0.1>"`. Functional smoke tests run the router process directly on the host, with bind `127.0.0.1` and `ROUTER_INBOUND_TEST_BYPASS=1`; the bypass is refused at boot for any non-loopback bind.
- **Validation:** `docker build` succeeds; the in-container health check passes; the host smoke test against the fake Bedrock passes.

## Step 6: Infra (synth only)
- `infra/` CDK app per design §3. Use L1 `Cfn*` constructs where L2 constructs are missing, and a custom resource for gateway rules if CloudFormation lacks them.
- `cdk-nag` (AwsSolutions) runs at synth time; findings are fixed or justified inline.
- Snapshot tests assert:
  - no `0.0.0.0/0` ingress;
  - router SG ingress comes only from the Lattice prefix list;
  - no IAM `*` actions;
  - every resource is tagged;
  - `RemovalPolicy.DESTROY` everywhere.
- **Validation:** `pnpm -C infra typecheck && pnpm -C infra test && npx cdk synth llmar-mvp` (no deploy).

## Step 7: Deploy and gate (0c)
- `cdk deploy llmar-mvp`, with the router desired count at **0 first**.
- Run E0 (anonymous / wrong-token / direct Lattice / direct IP) **before** scaling to 1. Then scale to 1 and run E0 again.
- **Rollback:** `cdk destroy llmar-mvp`.

## Step 8: E2E (0c runs, implementer prepares the scripts in `packages/router/e2e/`)
- Run E1–E11 from design §6 within the USD 5 budget.
- Results go to `research/e2e-results.md`: hit-rate parity, overhead percentiles, the list of Claude Code betas.
- **Validation:** every E-test passes or has a documented, accepted deviation.

## Step 9: Teardown and wrap-up (0c)
- `cdk destroy llmar-mvp`, then the verification listing (E12).
- Hand over to the parent: spec updates (router conventions, log schema), and the contract note for core `constraints.betas` (design §2.7).

## Review gates
- After step 1: V9 verdict reviewed by the user before infra code depends on it.
- After step 6: synth output and nag report reviewed before the first deploy.
- Before step 8: E2E budget confirmed.
