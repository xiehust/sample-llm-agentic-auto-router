// Writes dist/build.json {gitSha, dirty, builtAt}. The CDK console wiring refuses to upload a bundle whose gitSha is
// not the deploying worktree's HEAD, or that was built from a dirty tree (deploys come from a clean worktree).

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const pkgDir = new URL('..', import.meta.url).pathname
const git = (...args: string[]) => execFileSync('git', args, { cwd: pkgDir, encoding: 'utf8' }).trim()
let gitSha = 'unknown'
let dirty = true
try {
  gitSha = git('rev-parse', 'HEAD')
  dirty = git('status', '--porcelain', '--', '.').length > 0
} catch { /* not a git checkout */ }
const info = { gitSha, dirty, builtAt: new Date().toISOString() }
writeFileSync(join(pkgDir, 'dist', 'build.json'), `${JSON.stringify(info, null, 2)}\n`)
console.log(`build ${gitSha.slice(0, 12)}${dirty ? ' (dirty)' : ''}`)
