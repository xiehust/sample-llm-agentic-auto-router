// Process entrypoint: node packages/router/src/main.ts (Node 24 type stripping). Config errors exit 1.
import { createHash } from 'node:crypto'
import { InMemoryStateStore } from '@auto-router/core'
import { stdoutSink } from './account.ts'
import { bedrockTransport } from './assessor.ts'
import { createAssessorRuntime, settingsView } from './assessor-runtime.ts'
import { ConfigError, loadConfig, packInfos } from './config.ts'
import { createSigV4Signer } from './forward.ts'
import { createIdentityGate, createVerifier, identityWatches, IdentityState, type IdentityGate } from './identity.ts'
import { createRuntime } from './runtime.ts'
import { createRouter } from './server.ts'
import { bakedConfigDocument } from './settings.ts'
import { createPoller, s3Fetcher, type Watch } from './source.ts'
import { createStateReporter, type StateReporter } from './state.ts'

/** Objects of the runtime configuration source (design §1); the identity objects come from identity.ts (C2). */
export const CONFIG_KEY = 'config/active.json'
export const PRINCIPALS_KEY = 'identity/principals.json'

async function boot(): Promise<void> {
  let config
  try {
    config = loadConfig(process.env)
  } catch (e) {
    process.stderr.write(`${e instanceof ConfigError ? e.message : `config: ${(e as Error).message}`}\n`)
    process.exit(1)
  }
  const store = new InMemoryStateStore({ maxEntries: 100_000 })
  const signer = createSigV4Signer(config.region)
  // Tier assessor (C4): the document's assessor block over ROUTER_ASSESSOR_* (default off), built from the packs
  // preloaded at boot; same signer (task role) and bedrock-runtime upstream. Config lines carry settings, packs, drift.
  const assessors = createAssessorRuntime({ env: config.assessor, packs: config.packs ?? new Map(), catalog: config.catalog, transport: bedrockTransport(config.upstream, signer) })
  const sink = stdoutSink
  // Generation 0: the complete baked document (every section from the deploy env), version 0-baked.<sha8>. RouterStack
  // stages the same document as config/baked.json for the console (0d-effective-config.md §2).
  const sha256Hex = (t: string): string => createHash('sha256').update(t).digest('hex')
  const baked = bakedConfigDocument({ policy: config.policy, env: process.env, packs: packInfos(config.packs ?? new Map()) }, sha256Hex)
  const runtime = createRuntime(baked, { catalog: config.catalog, store, sink, buildAssessor: assessors.build, lineFields: [assessors.lineFields] })
  const watches: Watch[] = [
    { key: CONFIG_KEY, onObject: (body) => { runtime.applyDocument(body) },
      onAbsent: () => runtime.log('config', 'absent'), onError: (code) => runtime.log('config', 'error', { code }) },
    { key: PRINCIPALS_KEY, onObject: (body, etag) => { runtime.applyPrincipals(body, etag) },
      onAbsent: () => runtime.log('principals', 'absent'), onError: (code) => runtime.log('principals', 'error', { code }) },
  ]
  // Verified principal (ROUTER_IDENTITY_*; config validation requires the config bucket): jwks, blocks and budget
  // blocks are polled with the configuration; the mode is the generation's (document over env).
  let identity: IdentityGate | undefined
  let identityState: IdentityState | undefined
  if (config.identity) {
    const state = new IdentityState()
    identityState = state
    watches.push(...identityWatches(state, sink, Date.now, () => ({ configVersion: runtime.current().configVersion })))
    identity = createIdentityGate({ state, verifier: createVerifier(state, { issuer: config.identity.issuer, scope: config.identity.scope }), header: config.identity.header })
  }
  // State line (source 'state'): after boot, after every object change, and every 5 min (0d-effective-config.md §7).
  const reporter: StateReporter = createStateReporter({ runtime, ...(identityState ? { identity: identityState } : {}) })
  let listening = false
  for (const w of watches) {
    const onObject = w.onObject
    w.onObject = (body, etag) => { onObject(body, etag); if (listening) reporter.emit() }
  }
  const poller = config.configSource
    ? createPoller(s3Fetcher({ bucket: config.configSource.bucket, region: config.region, signer: createSigV4Signer(config.region, undefined, 's3') }),
      watches, config.configSource.pollMs)
    : undefined
  // Boot reads the source once before listening: the document wins over env; absent or invalid → the baked policy.
  if (poller) await poller.pollOnce()
  const { server } = createRouter({ config, runtime, store, signer, sink, ...(identity ? { identity } : {}) })
  server.listen(config.port, config.bind, () => {
    const a = server.address()
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), kind: 'boot', bind: config.bind,
      port: typeof a === 'object' && a ? a.port : config.port, hopAuth: config.hopAuth.kind, mode: runtime.current().policy.mode,
      policyVersion: runtime.current().policy.version, configVersion: runtime.current().configVersion, catalogVersion: config.catalog.version, hints: config.hints,
      assessor: settingsView(runtime.current().assessor),
      identity: config.identity ? { envMode: config.identity.mode, mode: runtime.current().document.identity?.mode ?? config.identity.mode, header: config.identity.header } : { mode: 'off' } })}\n`)
    if (config.fault !== 'none') process.stderr.write(`WARNING: E2E fault injection is ON (${config.fault}); never run this in production\n`)
    if (runtime.current().assessor?.settings.autoRules === 'all') process.stderr.write('NOTE: ROUTER_ASSESSOR_AUTO_RULES=all: every enabled rule and fact signal is auto-eligible, whatever the pack\'s auto flags (experiment switch)\n')
    if (config.hopAuth.kind === 'reject') process.stderr.write('ROUTER_HOP_AUTH is unset: every model request is refused (fail-closed)\n')
    runtime.log('boot', 'active', { origin: config.configSource ? 's3' : 'env' })
    listening = true
    reporter.emit()
    reporter.start()
    poller?.start()
  })
  const stop = () => { poller?.stop(); reporter.stop(); server.close(() => process.exit(0)) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

void boot()
