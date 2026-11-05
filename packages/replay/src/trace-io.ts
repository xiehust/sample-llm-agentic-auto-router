import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { createGunzip, createGzip } from 'node:zlib'
import { type TraceCall, TraceError, validateCall } from './schema.ts'

/** Streams parsed JSON values from a (optionally .gz) JSONL file. Data is only JSON.parse'd. */
export async function* readJsonLines(path: string): AsyncGenerator<{ value: unknown; line: number }> {
  const raw = createReadStream(path)
  const input = path.endsWith('.gz') ? raw.pipe(createGunzip()) : raw
  const rl = createInterface({ input, crlfDelay: Infinity })
  let line = 0
  for await (const text of rl) {
    line++
    if (text.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new TraceError(`${path}:${line}: invalid JSON`)
    }
    yield { value, line }
  }
}

/** Streams validated replay-trace/v1 calls. */
export async function* readTrace(path: string): AsyncGenerator<TraceCall> {
  for await (const { value, line } of readJsonLines(path)) yield validateCall(value, `${path}:${line}`)
}

/** Writes JSON lines (gzip if the path ends with .gz), honouring backpressure. Returns the count. */
export async function writeJsonLines(path: string, rows: Iterable<unknown> | AsyncIterable<unknown>): Promise<number> {
  const file = createWriteStream(path)
  const gz = path.endsWith('.gz') ? createGzip() : undefined
  if (gz) gz.pipe(file)
  const out = gz ?? file
  let n = 0
  for await (const row of rows) {
    if (!out.write(JSON.stringify(row) + '\n')) await once(out, 'drain')
    n++
  }
  out.end()
  await once(file, 'finish')
  return n
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}
