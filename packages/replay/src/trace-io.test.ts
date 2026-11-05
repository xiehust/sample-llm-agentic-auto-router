import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TraceError } from './schema.ts'
import { breakEvenCalls } from './synth.ts'
import { collect, readTrace, writeJsonLines } from './trace-io.ts'

describe('trace-io', () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-io-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const calls = breakEvenCalls({ contextTokens: 20_000, steps: 5 })
  for (const name of ['t.replay.jsonl', 't.replay.jsonl.gz']) {
    it(`round-trips ${name}`, async () => {
      const p = join(dir, name)
      expect(await writeJsonLines(p, calls)).toBe(calls.length)
      expect(await collect(readTrace(p))).toEqual(calls)
    })
  }
  it('reports the line of invalid JSON and of invalid calls', async () => {
    const bad = join(dir, 'bad.jsonl')
    writeFileSync(bad, `${JSON.stringify(calls[0])}\n\n{oops\n`)
    await expect(collect(readTrace(bad))).rejects.toThrow(/bad\.jsonl:3: invalid JSON/)
    writeFileSync(bad, `${JSON.stringify({ ...calls[0], promptTokens: 1 })}\n`)
    await expect(collect(readTrace(bad))).rejects.toThrow(TraceError)
  })
})
