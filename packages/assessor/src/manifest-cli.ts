// Regenerates prompts/assessor/manifest.json: `pnpm --filter @auto-router/assessor manifest` (or `-- --check`).
import { readFileSync, writeFileSync } from 'node:fs'
import { buildManifest, manifestPath, manifestText, readManifest, writePacksArchive } from './manifest.ts'

const text = manifestText(buildManifest())
const archive = process.argv.indexOf('--archive')
if (archive >= 0) {
  // --archive <dir>: the config-bucket packs archive from the committed manifest (RouterStack BucketDeployment).
  const dir = process.argv[archive + 1]
  if (!dir) { process.stderr.write('usage: manifest-cli.ts --archive <dir>\n'); process.exit(2) }
  for (const k of writePacksArchive(dir, readManifest())) process.stdout.write(`${k}\n`)
} else if (process.argv.includes('--check')) {
  let current = ''
  try { current = readFileSync(manifestPath, 'utf8') } catch { /* missing = stale */ }
  if (current !== text) {
    process.stderr.write(`${manifestPath} is stale: run pnpm --filter @auto-router/assessor manifest\n`)
    process.exit(1)
  }
  process.stdout.write('manifest up to date\n')
} else {
  writeFileSync(manifestPath, text)
  process.stdout.write(`wrote ${manifestPath}\n`)
}
