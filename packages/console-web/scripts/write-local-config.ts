// Writes public/config.json for `pnpm dev` against a deployed console API (D1 option B or local work), from the
// stack outputs file of `cdk deploy --outputs-file <file>`. The output is gitignored: it names a pool and region.
//
//   node scripts/write-local-config.ts <cdk-outputs.json> [stackName]
//
// Expected outputs on the console stack: Region, UserPoolId, ConsoleLocalClientId, CognitoDomain, ConsoleScope.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [file, stackName] = process.argv.slice(2)
if (!file) { console.error('usage: write-local-config.ts <cdk-outputs.json> [stackName]'); process.exit(2) }
const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string>>
const stack = stackName ?? Object.keys(all).find((k) => 'ConsoleLocalClientId' in (all[k] ?? {}))
const o = stack ? all[stack] : undefined
const need = ['Region', 'UserPoolId', 'ConsoleLocalClientId', 'CognitoDomain', 'ConsoleScope']
const missing = need.filter((k) => !o?.[k])
if (!o || missing.length) { console.error(`missing outputs: ${missing.join(', ') || 'stack not found'} (deploy with -c consoleLocalDev=true)`); process.exit(2) }
const config = {
  schemaVersion: 1,
  region: o.Region,
  issuer: `https://cognito-idp.${o.Region}.amazonaws.com/${o.UserPoolId}`,
  cognitoDomain: o.CognitoDomain,
  clientId: o.ConsoleLocalClientId,
  scopes: ['openid', o.ConsoleScope],
  apiBase: '/api',
  tokenStorage: 'session',
}
const out = join(new URL('..', import.meta.url).pathname, 'public', 'config.json')
writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`)
console.log(`wrote ${out}; run CONSOLE_API_TARGET=<api url> CONSOLE_COGNITO_ORIGIN=${o.CognitoDomain} pnpm dev, then open http://127.0.0.1:5173`)
