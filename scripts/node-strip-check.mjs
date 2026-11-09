#!/usr/bin/env node
// Strip-only guard. The router image and the console Lambdas run their TypeScript sources directly under Node's
// default type stripping (infra/lambda/Dockerfile, packages/router/Dockerfile). vitest and tsc both transpile, so
// neither sees the syntax that strip-only mode rejects at load time: parameter properties, enums, namespaces with
// runtime code, `import x = require()`, `export =` and `<T>expr` casts. This script runs plain `node`, two ways:
//
//   --import <entry.ts>  a child `node` (no loader, NODE_OPTIONS cleared) imports the entry, so every module it
//                        reaches statically is resolved, stripped, linked and evaluated as at a cold start. Entries
//                        must not do I/O at import time; build clients and read the environment lazily.
//   <file|dir>           every .ts/.mts/.cts file below goes through node:module stripTypeScriptTypes in strip
//                        mode. This covers files that no entry imports statically. Skipped: *.test.*, *.d.ts,
//                        __fixtures__, node_modules, and any path segment or file name passed with --skip.
//
//   node scripts/node-strip-check.mjs [--import <entry.ts>]... [--skip <name>]... [<file|dir>]...
//   e.g. (cd packages/usage-ingest && node ../../scripts/node-strip-check.mjs --import src/handler.ts src)
//
// Exit 0 when clean; 1 with one line per finding; 2 on a usage error. Prints paths and Node's messages only.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { basename, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const TS = /\.(c|m)?ts$/
const SKIP_ALWAYS = new Set(['node_modules', '__fixtures__'])

function usage(msg) {
  process.stderr.write(`node-strip-check: ${msg}\nusage: node scripts/node-strip-check.mjs [--import <entry.ts>]... [--skip <name>]... [<file|dir>]...\n`)
  process.exit(2)
}

const imports = []
const skips = new Set()
const roots = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--import' || a === '--skip') {
    const v = argv[++i]
    if (!v) usage(`${a} needs a value`)
    if (a === '--import') imports.push(v)
    else skips.add(v)
  } else if (a.startsWith('-')) usage(`unknown option ${a}`)
  else roots.push(a)
}
if (imports.length === 0 && roots.length === 0) usage('nothing to check')

const show = (p) => { const r = relative(process.cwd(), p); return r && !r.startsWith('..') ? r : p }
const findings = []
let checked = 0

// 1. Import each entry in a child process under plain node.
const firstLine = (text, re) => text.split('\n').find((l) => re.test(l))?.trim()
for (const entry of imports) {
  const abs = resolve(entry)
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(abs).href)})`],
    { env, encoding: 'utf8', timeout: 60_000 })
  checked += 1
  if (r.status === 0) continue
  const err = `${r.stderr ?? ''}`
  const where = firstLine(err, /^file:\/\/\S+:\d+/)?.replace(/^file:\/\//, '')
  const what = firstLine(err, /^[A-Za-z]*Error\b/) ?? (r.error ? String(r.error.message) : `exit ${r.status ?? r.signal}`)
  findings.push(`import ${show(abs)}: ${where ? `${show(where)}: ` : ''}${what}`)
}

// 2. Strip every TypeScript file under the given roots (strip mode, no evaluation).
function* walk(p) {
  const st = statSync(p)
  if (st.isFile()) { yield p; return }
  for (const name of readdirSync(p).sort()) {
    if (SKIP_ALWAYS.has(name) || skips.has(name)) continue
    const child = join(p, name)
    if (statSync(child).isDirectory()) yield* walk(child)
    else if (TS.test(name) && !/\.test\.|\.d\.(c|m)?ts$/.test(name)) yield child
  }
}
if (roots.length > 0) {
  const strip = nodeModule.stripTypeScriptTypes
  if (typeof strip !== 'function') usage(`node ${process.version} has no module.stripTypeScriptTypes; use --import only`)
  const emit = process.emitWarning
  process.emitWarning = (w, ...rest) => {   // stripTypeScriptTypes is marked experimental in Node 24: keep the report clean
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type
    if (type !== 'ExperimentalWarning') emit.call(process, w, ...rest)
  }
  for (const root of roots) {
    let files
    try { files = [...walk(resolve(root))] } catch (e) { usage(`${root}: ${e.code ?? e.message}`) }
    for (const f of files) {
      if (skips.has(basename(f))) continue
      checked += 1
      try { strip(readFileSync(f, 'utf8'), { mode: 'strip', sourceUrl: pathToFileURL(f).href }) }
      catch (e) { findings.push(`strip ${show(f)}: ${e.code ?? e.name}: ${String(e.message).split('\n')[0]}`) }
    }
  }
  process.emitWarning = emit
}

for (const f of findings) process.stdout.write(`${f}\n`)
process.stdout.write(`node-strip-check: ${findings.length === 0 ? 'PASS' : 'FAIL'} (${checked} checked, ${findings.length} finding${findings.length === 1 ? '' : 's'}, node ${process.version})\n`)
process.exit(findings.length === 0 ? 0 : 1)
