#!/usr/bin/env node
// Generates resources/THIRD_PARTY_NOTICES.txt (docs/design/offline-captions.md §8), shown from
// About and shipped next to the app (extraResources):
//   1. the hand-written entries in resources/notices/*.txt (whisper.cpp and ggml, Silero VAD, the
//      OpenAI Whisper weights, the MinGW-w64 and GCC runtimes, FFmpeg, Chromium, MediaPipe);
//   2. the Rust crates compiled into the native helpers (`cargo metadata` of native/ and
//      native/speech for x86_64-pc-windows-gnu, normal dependencies only) with their licence files;
//   3. the npm packages that ship: the runtime packages in app.asar, the packages Vite bundles into
//      the app (React, MediaPipe, the AI provider SDKs and what they depend on) and Electron.
// Packages whose licence texts are identical share one copy of the text.
//
//   npm run notices               # write the file
//   npm run notices -- --check    # exit 1 when the committed file is not what would be generated
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { dependencyClosure, resolvePackageDir } = require('./lib/packaging.cjs')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(root, 'resources', 'THIRD_PARTY_NOTICES.txt')
const HAND = path.join(root, 'resources', 'notices')
const CRATES = ['native/Cargo.toml', 'native/speech/Cargo.toml']
const TARGET = 'x86_64-pc-windows-gnu'
/** devDependencies that Vite bundles into the app (electron-vite externalises `dependencies` only). */
const BUNDLED = ['react', 'react-dom', '@mediapipe/tasks-vision', '@anthropic-ai/sdk', '@google/genai', 'openai']
/** Type declarations: in the dependency trees, but no code of them ships. */
const TYPES_ONLY = (name) => name.startsWith('@types/') || name === 'undici-types'
const RULE = '='.repeat(78)
const LICENCE_FILE = /^(licen[cs]e|copying|unlicen[cs]e|notice)([-_.].*)?$/i

const clean = (text) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
const key = (text) => text.replace(/\s+/g, ' ').trim()

function licenceFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && LICENCE_FILE.test(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

function licenceText(dir) {
  const files = licenceFiles(dir)
  return files.length ? files.map((f) => clean(readFileSync(path.join(dir, f), 'utf8'))).join(`\n\n${'-'.repeat(40)}\n\n`) : null
}

// ---------------------------------------------------------------------------- Rust crates

function crates() {
  const out = new Map()
  for (const manifest of CRATES) {
    const r = spawnSync('cargo', ['metadata', '--format-version', '1', '--locked', '--filter-platform', TARGET, '--manifest-path', path.join(root, manifest)], {
      encoding: 'utf8',
      maxBuffer: 64 << 20
    })
    if (r.error || r.status !== 0) throw new Error(`cargo metadata for ${manifest} failed: ${r.error?.message ?? r.stderr.trim().split('\n').pop()}`)
    const meta = JSON.parse(r.stdout)
    const byId = new Map(meta.packages.map((p) => [p.id, p]))
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]))
    // Normal (not build or dev) dependencies of the helper, transitively: what is linked in.
    // Procedural macros run in the compiler and are not linked.
    const procMacro = (id) => byId.get(id)?.targets.some((t) => t.kind.includes('proc-macro'))
    const seen = new Set()
    const stack = [meta.resolve.root]
    while (stack.length) {
      const id = stack.pop()
      for (const d of nodes.get(id)?.deps ?? []) {
        if (!d.dep_kinds.some((k) => k.kind === null) || procMacro(d.pkg)) continue
        if (!seen.has(d.pkg)) {
          seen.add(d.pkg)
          stack.push(d.pkg)
        }
      }
    }
    for (const id of seen) {
      const p = byId.get(id)
      out.set(`${p.name}@${p.version}`, { name: p.name, version: p.version, licence: p.license ?? p.license_file ?? 'unknown', url: p.repository ?? `https://crates.io/crates/${p.name}`, text: licenceText(path.dirname(p.manifest_path)) })
    }
  }
  return [...out.values()]
}

// ------------------------------------------------------------------------------- npm packages

function npmPackages() {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const roots = [...Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }), ...BUNDLED]
  const dirs = dependencyClosure(roots, root, root)
  // ffmpeg-static's install-time helpers do not ship (scripts/lib/packaging.cjs installOnlyPackages).
  const { installOnlyPackages } = require('./lib/packaging.cjs')
  const installOnly = new Set(installOnlyPackages(root))
  const electron = resolvePackageDir('electron', root, root)
  if (electron) dirs.add(electron)
  const out = new Map()
  for (const dir of dirs) {
    const p = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    if (TYPES_ONLY(p.name) || installOnly.has(p.name)) continue
    const licence = typeof p.license === 'string' ? p.license : (p.license?.type ?? (Array.isArray(p.licenses) ? p.licenses.map((l) => l.type).join(' OR ') : 'unknown'))
    const url = (typeof p.repository === 'string' ? p.repository : p.repository?.url)?.replace(/^git\+/, '').replace(/\.git$/, '') ?? `https://www.npmjs.com/package/${p.name}`
    out.set(`${p.name}@${p.version}`, { name: p.name, version: p.version, licence, url, text: licenceText(dir) })
  }
  return [...out.values()]
}

// ------------------------------------------------------------------------------------ output

function grouped(title, list) {
  const sorted = [...list].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)))
  const groups = new Map()
  const bare = []
  for (const p of sorted) {
    if (!p.text) {
      bare.push(p)
      continue
    }
    const k = key(p.text)
    if (!groups.has(k)) groups.set(k, { text: p.text, members: [] })
    groups.get(k).members.push(p)
  }
  const parts = []
  for (const g of groups.values()) {
    const names = g.members.map((p) => `  ${p.name} ${p.version} (${p.licence}) ${p.url}`).join('\n')
    parts.push(`${g.members.length === 1 ? 'Package' : 'Packages'}:\n${names}\n\n${g.text}`)
  }
  if (bare.length) {
    parts.push(
      `These packages carry no licence file; the licence each declares applies:\n${bare.map((p) => `  ${p.name} ${p.version} (${p.licence}) ${p.url}`).join('\n')}`
    )
  }
  return `${RULE}\n${title}\n${RULE}\n\n${parts.join(`\n\n${'-'.repeat(78)}\n\n`)}`
}

export function generate() {
  const hand = readdirSync(HAND)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .map((f) => clean(readFileSync(path.join(HAND, f), 'utf8')))
  const head = clean(`Third-party notices for Flown

Flown (c) Qbexel includes, links or downloads on request the third-party software below. Each
component's copyright notice and licence follow. This file is generated by scripts/notices.mjs
from resources/notices/, the Rust crates of the native helpers and the shipped npm packages.`)
  const sections = [
    head,
    `${RULE}\nComponents of the speech engine, the native helpers and the app\n${RULE}\n\n${hand.join(`\n\n${'-'.repeat(78)}\n\n`)}`,
    grouped('Rust crates compiled into the native helpers (ssw-capture.exe, ssw-speech.exe, ssw-speech-compat.exe)', crates()),
    grouped('npm packages in the app (app.asar, and the code Vite bundles into it) and Electron', npmPackages())
  ]
  return `${sections.join('\n\n\n')}\n`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let text
  try {
    text = generate()
  } catch (err) {
    console.error(`notices: ${err.message}`)
    process.exit(1)
  }
  if (process.argv.includes('--check')) {
    const committed = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
    if (committed !== text) {
      console.error(`notices: ${path.relative(root, OUT)} is not up to date (${Buffer.byteLength(committed)} bytes committed, ${Buffer.byteLength(text)} generated). Run npm run notices and commit it.`)
      process.exit(1)
    }
    console.log(`notices: ${path.relative(root, OUT)} is up to date (${Buffer.byteLength(text)} bytes)`)
  } else {
    writeFileSync(OUT, text)
    console.log(`notices: wrote ${path.relative(root, OUT)} (${Buffer.byteLength(text)} bytes)`)
  }
}
