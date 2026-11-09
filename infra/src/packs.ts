// Packs archive for the config bucket (admin console C4): the console shows the rules behind each decision, for the
// packs of the running and of older images. Staged at synth from the committed manifest by the assessor's own writer
// (manifest-cli --archive): deterministic, offline (no network), and the router verifies the same manifest at boot.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = new URL('../../packages/assessor/src/manifest-cli.ts', import.meta.url).pathname

/** Writes `<dir>/packs/current.json` and `<dir>/packs/<packVersion>.json` into a fresh staging dir and returns it. */
export function stagePacksArchive(dir: string = mkdtempSync(join(tmpdir(), 'llmar-packs-'))): string {
  execFileSync(process.execPath, [CLI, '--archive', dir], { stdio: ['ignore', 'ignore', 'inherit'], env: { PATH: process.env.PATH ?? '' } })
  if (!existsSync(join(dir, 'packs', 'current.json'))) {
    throw new Error('packs archive: manifest-cli --archive wrote no packs/current.json (needs the assessor manifest writer, admin console C4)')
  }
  return dir
}
