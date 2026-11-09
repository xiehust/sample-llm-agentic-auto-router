// Pack archive helpers (research 73 §2). The archive (`packs/<packVersion>.json`, append-only) resolves a record's
// basis rule ids to rule text for the exact pack version; `packs/current.json` is the manifest deployed with the
// console. The router's config reports list the packs its image bundles.
import type { PackEntry, PacksResponse } from '@auto-router/console-contract'
import type { PackInfo } from '@auto-router/router/settings'
import { HttpError } from '../http.ts'
import type { Issue } from '../local-types.ts'
import type { Deps } from '../ports.ts'

export const PACK_VERSION = /^[a-z0-9/._-]{1,60}\+[0-9a-f]{12}$/
export const packKey = (packVersion: string) => `packs/${packVersion}.json`

async function readJson<T>(deps: Deps, key: string): Promise<T | undefined> {
  const text = await deps.objects.get(key)
  if (text === undefined) return undefined
  try { return JSON.parse(text) as T } catch { throw new HttpError(500, 'internal', `${key} is not valid JSON`) }
}

export const archivedPack = (deps: Deps, packVersion: string) => readJson<PackEntry>(deps, packKey(packVersion))
export const currentManifest = (deps: Deps) => readJson<Omit<PacksResponse, 'stats'>>(deps, 'packs/current.json')

export interface RunningPacks {
  packs: PackEntry[]
  /** 'router': reported by the running router; 'console': the console's manifest (no router report yet). */
  source: 'router' | 'console'
  /** A reported pack missing from the archive, or the console's manifest differs from the router's. */
  warnings: Issue[]
}

/** The packs of the image the router runs (design §2.1: image-dependent checks validate against it). */
export async function runningPacks(deps: Deps): Promise<RunningPacks> {
  const reported = (await deps.usage.configReports(20)).find((r) => r.packs?.length)?.packs
  const current = await currentManifest(deps)
  const warnings: Issue[] = []
  if (reported) {
    const packs: PackEntry[] = []
    for (const p of reported) {
      const entry = PACK_VERSION.test(p.packVersion) ? await archivedPack(deps, p.packVersion) : undefined
      if (entry) packs.push(entry)
      else warnings.push({ path: '', message: `pack ${p.name} (${p.packVersion}) is not in the packs archive`, code: 'assessor', rule: 'pack-archive-missing' })
    }
    const consoleView = new Map<string, string>((current?.packs ?? []).map((p) => [p.name, p.packVersion]))
    if (reported.length !== consoleView.size || reported.some((p) => consoleView.get(p.name) !== p.packVersion)) {
      warnings.push({ path: '', message: 'the router image and the console manifest list different packs', code: 'assessor', rule: 'image-console-mismatch' })
    }
    return { packs, source: 'router', warnings }
  }
  return { packs: current?.packs ?? [], source: 'console', warnings }
}

export const packInfo = (p: PackEntry): PackInfo => ({ name: p.name, packVersion: p.packVersion, autoCapable: p.autoCapable })
