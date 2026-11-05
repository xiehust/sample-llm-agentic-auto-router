// Scrubbing and the budget ledger for live eval runs. Nothing that names an account, request or response is persisted.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const PATTERNS: Array<[RegExp, string]> = [
  [/arn:aws[a-z-]*:[^\s"']+/g, 'arn:SCRUBBED'],
  [/\b\d{12}\b/g, 'ACCOUNT_SCRUBBED'],
  [/\b(?:req|resp|msg|chatcmpl|call|fc|rs|toolu|msgbatch)_[A-Za-z0-9_-]{6,}/g, 'ID_SCRUBBED'], // incl. msg_bdrk_01…
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'UUID_SCRUBBED'],
  [/\b(?:ASIA|AKIA)[A-Z0-9]{16}\b/g, 'KEY_SCRUBBED'],
]

/** Removes ARNs, 12-digit numbers, provider ids, UUIDs and access-key ids from a string. */
export function scrubText(s: string): string {
  let out = s
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep)
  return out
}

/** Deep scrub: drops keys that carry identifiers and scrubs every string value. */
export function scrub<T>(v: T): T {
  const DROP = new Set(['id', 'requestId', 'request_id', 'responseId', 'response_id', 'x-amzn-requestid', 'system_fingerprint'])
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return scrubText(x)
    if (Array.isArray(x)) return x.map(walk)
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(x)) if (!DROP.has(k)) o[k] = walk(val)
      return o
    }
    return x
  }
  return walk(v) as T
}

export interface LedgerEntry { at: string; label: string; calls: number; usd: number }
export interface LedgerFile { capUsd: number; spentUsd: number; entries: LedgerEntry[] }

const isUsd = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * Persistent spend ledger. reserve() refuses a call whose worst-case cost would cross the cap. Spend is written to the
 * file on every settle (a crash mid-run cannot lose booked spend); flush() closes the run's entry with its label.
 * A non-finite cap, estimate or stored spend is rejected: NaN would make every `> cap` comparison false.
 */
export class Ledger {
  readonly path: string
  readonly capUsd: number
  private file: LedgerFile
  private pending = 0
  private runCalls = 0
  private runUsd = 0
  private openEntry: LedgerEntry | undefined

  constructor(path: string, capUsd: number) {
    if (!isUsd(capUsd)) throw new Error(`ledger: cap must be a finite number >= 0 (got ${String(capUsd)})`)
    this.path = path
    this.capUsd = capUsd
    this.file = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as LedgerFile) : { capUsd, spentUsd: 0, entries: [] }
    if (typeof this.file !== 'object' || this.file === null || !isUsd(this.file.spentUsd) || !Array.isArray(this.file.entries)) {
      throw new Error(`ledger: ${path} is malformed (spentUsd must be a finite number >= 0); refusing to run`)
    }
    this.file.capUsd = capUsd
  }

  get spentUsd(): number { return this.file.spentUsd }

  /** Reserve worst-case `estUsd`; false when spent + pending + est would exceed the cap (or est is not a valid amount). */
  reserve(estUsd: number): boolean {
    if (!isUsd(estUsd)) return false
    if (this.spentUsd + this.pending + estUsd > this.capUsd) return false
    this.pending += estUsd
    return true
  }

  /** Settle a reservation with the actual cost (costOf); unknown or invalid cost settles at the reserved estimate. */
  settle(estUsd: number, actualUsd: number | undefined): void {
    const est = isUsd(estUsd) ? estUsd : 0
    const usd = isUsd(actualUsd) ? actualUsd : est
    this.pending = Math.max(0, this.pending - est)
    this.runUsd += usd
    this.runCalls += 1
    this.file.spentUsd += usd
    if (!this.openEntry) {
      this.openEntry = { at: new Date().toISOString(), label: 'in-progress', calls: 0, usd: 0 }
      this.file.entries.push(this.openEntry)
    }
    this.openEntry.calls = this.runCalls
    this.openEntry.usd = Math.round(this.runUsd * 1e6) / 1e6
    this.write()
  }

  /** Close this run's entry with `label` and write the ledger file. */
  flush(label: string): void {
    if (this.runCalls === 0 || !this.openEntry) return
    this.openEntry.label = label
    this.openEntry = undefined
    this.runCalls = 0
    this.runUsd = 0
    this.write()
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.file, null, 2) + '\n')
  }
}
