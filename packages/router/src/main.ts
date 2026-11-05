// Process entrypoint: node packages/router/src/main.ts (Node 24 type stripping). Config errors exit 1.
import { createEngine, InMemoryStateStore } from '@auto-router/core'
import { ConfigError, loadConfig } from './config.ts'
import { createSigV4Signer } from './forward.ts'
import { createRouter } from './server.ts'

function boot(): void {
  let config
  try {
    config = loadConfig(process.env)
  } catch (e) {
    process.stderr.write(`${e instanceof ConfigError ? e.message : `config: ${(e as Error).message}`}\n`)
    process.exit(1)
  }
  const store = new InMemoryStateStore({ maxEntries: 100_000 })
  const engine = createEngine({ policy: config.policy, catalog: config.catalog, store })
  // Tier assessor: pass `card` (buildCard from @auto-router/assessor) once core's decide accepts extras.
  const { server } = createRouter({ config, engine, store, signer: createSigV4Signer(config.region) })
  server.listen(config.port, config.bind, () => {
    const a = server.address()
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), kind: 'boot', bind: config.bind,
      port: typeof a === 'object' && a ? a.port : config.port, hopAuth: config.hopAuth.kind, mode: config.policy.mode,
      policyVersion: config.policy.version, catalogVersion: config.catalog.version, hints: config.hints })}\n`)
    if (config.fault !== 'none') process.stderr.write(`WARNING: E2E fault injection is ON (${config.fault}); never run this in production\n`)
    if (config.hopAuth.kind === 'reject') process.stderr.write('ROUTER_HOP_AUTH is unset: every model request is refused (fail-closed)\n')
  })
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

boot()
