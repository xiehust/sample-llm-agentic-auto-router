// Test-only helpers; excluded from the build (tsconfig.build.json).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const fixtureDir = fileURLToPath(new URL('./__fixtures__/', import.meta.url))
export const packageDir = fileURLToPath(new URL('../', import.meta.url))

export function readFixtureJson(path: string): unknown {
  return JSON.parse(readFileSync(fixtureDir + path, 'utf8'))
}

export function readFixtureText(path: string): string {
  return readFileSync(fixtureDir + path, 'utf8')
}
