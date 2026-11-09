// Writes dist/third-party-licenses.txt: the minified bundle drops licence comments, and CloudFront redistributes
// Apache-2.0 code (Cloudscape, oidc-client-ts), so the notices ship as a file (18-frontend-stack §1.1).
// Uses `pnpm licenses list --json --prod` for this package; no extra dependency.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Entry { name: string; versions: string[]; paths: string[]; license: string; homepage?: string }

const pkgDir = new URL('..', import.meta.url).pathname
const out = join(pkgDir, 'dist', 'third-party-licenses.txt')
const raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod'], { cwd: pkgDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const byLicense = JSON.parse(raw) as Record<string, Entry[]>

const textOf = (dir: string): string => {
  if (!existsSync(dir)) return ''
  const parts: string[] = []
  for (const f of readdirSync(dir)) if (/^(licen[cs]e|notice|copying)(\.(md|txt))?$/i.test(f)) parts.push(readFileSync(join(dir, f), 'utf8').trim())
  return parts.join('\n\n')
}

const blocks: string[] = ['Third-party software in the LLM Auto Router console bundle.', '']
for (const [license, entries] of Object.entries(byLicense).sort(([a], [b]) => a.localeCompare(b))) {
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const text = e.paths.map(textOf).find((x) => x) ?? `License: ${license}`
    blocks.push('='.repeat(78), `${e.name} ${e.versions.join(', ')} (${license})${e.homepage ? ` ${e.homepage}` : ''}`, '-'.repeat(78), text, '')
  }
}
writeFileSync(out, blocks.join('\n'))
console.log(`wrote ${out} (${Object.values(byLicense).flat().length} packages)`)
