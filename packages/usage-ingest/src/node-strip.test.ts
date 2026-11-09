// The Lambda runs these sources under Node's strip-only type stripping (infra/lambda/Dockerfile), which vitest
// does not: a parameter property crashed the function at init (c3, 2026-11-08). scripts/node-strip-check.mjs runs
// plain `node` on the entry and on every runtime file; this test runs it and proves it fails on each construct.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../../../scripts/node-strip-check.mjs', import.meta.url))

function check(args: string[], cwd = PKG): { status: number | null; out: string } {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: 'utf8', timeout: 90_000 })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('runs under plain Node (strip-only type stripping)', () => {
  it('the Lambda entry imports, and no runtime file uses strip-unsupported syntax', () => {
    const r = check(['--import', 'src/handler.ts', 'src'])
    expect(r.out).toMatch(/PASS/)
    expect(r.status).toBe(0)
  }, 90_000)

  it('the guard fails on parameter properties, enums, namespaces, import = and export =, by import and by scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llmar-strip-'))
    try {
      const bad = {
        'param.ts': 'export class A {\n  constructor(private readonly x: number) {}\n  get(): number { return this.x }\n}\n',
        'enum.ts': 'export enum E { A, B }\n',
        'ns.ts': 'export namespace N { export const x = 1 }\n',
        'import-eq.ts': 'import fs = require("node:fs")\nexport const f = fs.readFileSync\n',
        'export-eq.ts': 'const x = 1\nexport = x\n',
      }
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')
      for (const [name, src] of Object.entries(bad)) writeFileSync(join(dir, name), src)
      writeFileSync(join(dir, 'entry.ts'), "import { A } from './param.ts'\nexport const a: A = new A(1)\n")
      const scan = check([dir])
      expect(scan.status).toBe(1)
      for (const [name, what] of [['param.ts', 'parameter property'], ['enum.ts', 'enum'], ['ns.ts', 'namespace'],
        ['import-eq.ts', 'import equals'], ['export-eq.ts', 'export assignment']] as const) {
        expect(scan.out).toMatch(new RegExp(`strip \\S*${name.replace('.', '\\.')}: ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript ${what}`))
      }
      expect(scan.out).not.toMatch(/strip \S*entry\.ts/)
      const imp = check(['--import', join(dir, 'entry.ts')])
      expect(imp.status).toBe(1)
      expect(imp.out).toMatch(/import \S*entry\.ts: \S*param\.ts:2: SyntaxError \[ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX\]: TypeScript parameter property/)
      writeFileSync(join(dir, 'ok.ts'), 'export const f = (a: number): number => a\nexport type T = { a: string }\n')
      expect(check(['--import', join(dir, 'ok.ts'), join(dir, 'ok.ts')]).status).toBe(0)
      expect(check([]).status).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)
})
