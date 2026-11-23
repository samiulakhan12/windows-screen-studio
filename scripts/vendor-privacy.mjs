#!/usr/bin/env node
// Vendors the two libraries the text rules of auto-blur use (docs/design/auto-blur.md §6.14, §16.3)
// into src/shared/privacy/vendor/, as scripts/build-emoji-data.mjs does for the caption data:
//   libphonenumber-js 1.13.16 (MIT; its metadata Apache-2.0, from Google's libphonenumber): the ES
//   modules reached from es6/findPhoneNumbersInText.js, es6/parsePhoneNumber.js,
//   es6/isValidPhoneNumber.js and metadata.max.json.js, under vendor/libphonenumber/;
//   double-metaphone 2.0.1 (MIT): its one module, as vendor/double-metaphone.js.
// Each file keeps its bytes except the `//# sourceMappingURL=` lines (the maps are not copied) and
// gains a GENERATED header naming the package, its version, the tarball's SHA-256 and the file's own.
// The few entry points the rules import get a small declaration file beside them.
//
//   node scripts/vendor-privacy.mjs           # write the files
//   node scripts/vendor-privacy.mjs --check   # exit 1 when a vendored file is not what it would write
//
// The tarballs are pinned by bytes, SHA-256 and the registry's SHA-512 integrity, and downloaded once
// into .cache/privacy-vendor/ (SSW_PRIVACY_VENDOR_CACHE overrides); nothing is read before it matches.
// Notices: resources/notices/38-libphonenumber-js.txt and 39-double-metaphone.txt.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { untar } from './build-emoji-data.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The pinned npm tarballs. */
export const VENDOR_INPUTS = {
  'libphonenumber-js': {
    version: '1.13.16',
    url: 'https://registry.npmjs.org/libphonenumber-js/-/libphonenumber-js-1.13.16.tgz',
    bytes: 1_908_294,
    sha256: '5cc6aa79db25ac97a730d110f47a1ed35cdeb8c53df48bed03b85d73a5205ba5',
    integrity: 'sha512-tIOCM9yx2Go6d5/ZANe0K+G4AZek1Ymx81HxQpf19Sri4zMP95eQbKdnUGHAvFQ4nx0PeLhFqvAfisTADXj3tQ==',
    licence: 'MIT (code), Apache-2.0 (metadata)',
    notice: 'resources/notices/38-libphonenumber-js.txt'
  },
  'double-metaphone': {
    version: '2.0.1',
    url: 'https://registry.npmjs.org/double-metaphone/-/double-metaphone-2.0.1.tgz',
    bytes: 8_588,
    sha256: 'f069e40def102dd0b6c661040a6b72c88ec5c78900204716df4218d40249c1c3',
    integrity: 'sha512-oHqGfNo2bG/VTZSGFz98TWpyv3WD+d9TDOxwAY8L+zqwm4sGawNvEynegjPU+4HowE4HnIXSYAq0lst2YJgfzA==',
    licence: 'MIT',
    notice: 'resources/notices/39-double-metaphone.txt'
  }
}

/** Where the vendored files go. */
export const VENDOR_DIR = path.join('src', 'shared', 'privacy', 'vendor')
const PHONE_DIR = path.join(VENDOR_DIR, 'libphonenumber')
/** The entry points of libphonenumber-js whose import closure is vendored (§6.14). */
export const PHONE_ENTRIES = ['es6/findPhoneNumbersInText.js', 'es6/parsePhoneNumber.js', 'es6/isValidPhoneNumber.js', 'metadata.max.json.js']

/** The folder the tarballs are kept in. */
export function vendorCacheDir(env = process.env) {
  return path.resolve(root, env.SSW_PRIVACY_VENDOR_CACHE || path.join('.cache', 'privacy-vendor'))
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sha512 = (bytes) => 'sha512-' + createHash('sha512').update(bytes).digest('base64')

/** Whether `bytes` are the pinned tarball of `pin`: its length, SHA-256 and SHA-512 integrity. */
export function matchesPin(pin, bytes) {
  return bytes.length === pin.bytes && sha256(bytes) === pin.sha256 && sha512(bytes) === pin.integrity
}

/** The files of a pinned tarball, downloaded into the cache once (never more bytes than pinned). */
export async function vendorInput(name) {
  const pin = VENDOR_INPUTS[name]
  const file = path.join(vendorCacheDir(), path.basename(new URL(pin.url).pathname))
  let bytes = existsSync(file) ? readFileSync(file) : null
  if (!bytes || !matchesPin(pin, bytes)) {
    const res = await fetch(pin.url, { redirect: 'error' })
    if (!res.ok) throw new Error(`${pin.url}: HTTP ${res.status}`)
    const chunks = []
    let got = 0
    for await (const chunk of res.body) {
      got += chunk.length
      if (got > pin.bytes) throw new Error(`${pin.url}: more than the pinned ${pin.bytes} bytes`)
      chunks.push(chunk)
    }
    bytes = Buffer.concat(chunks)
    if (!matchesPin(pin, bytes)) throw new Error(`${pin.url} did not match its pin (${bytes.length} bytes, SHA-256 ${sha256(bytes)})`)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file + '.part', bytes)
    renameSync(file + '.part', file)
  }
  return untar(bytes)
}

/** The relative module paths a module's static imports and re-exports name. */
export function importsOf(source) {
  const out = []
  for (const m of source.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g)) out.push(m[1] ?? m[2])
  return out
}

/** Every file reached from `entries` through static imports (package-relative paths, sorted); a bare import is refused. */
export function closure(files, entries, prefix = 'package/') {
  const seen = new Set()
  const stack = [...entries]
  while (stack.length) {
    const f = stack.pop()
    if (seen.has(f)) continue
    const bytes = files.get(prefix + f)
    if (!bytes) throw new Error(`${f} is not in the package`)
    seen.add(f)
    for (const spec of importsOf(bytes.toString('utf8'))) {
      if (!spec.startsWith('.')) throw new Error(`${f} imports the package "${spec}", which is not vendored`)
      stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(f), spec)))
    }
  }
  return [...seen].sort()
}

/** A source file without its `//# sourceMappingURL=` lines, ending in one line break. */
export function withoutSourceMaps(text) {
  const kept = text.split('\n').filter((l) => !/^\s*\/\/# sourceMappingURL=/.test(l))
  while (kept.length && kept[kept.length - 1] === '') kept.pop()
  return kept.join('\n') + '\n'
}

/** The GENERATED header of a vendored file. */
export function headerOf(name, file, original) {
  const pin = VENDOR_INPUTS[name]
  return (
    `/**\n * GENERATED by scripts/vendor-privacy.mjs: do not edit; \`node scripts/vendor-privacy.mjs --check\` compares.\n` +
    ` * ${name} ${pin.version} (${pin.licence}), ${pin.url}, tarball SHA-256 ${pin.sha256}:\n` +
    ` * package/${file}, SHA-256 ${sha256(original)}, without its source map line. Notice: ${pin.notice}.\n */\n`
  )
}

/** The declaration files of the entry points the rules import (only what they use). */
function declarations() {
  const head = (name, what) =>
    `/**\n * GENERATED by scripts/vendor-privacy.mjs: do not edit; \`node scripts/vendor-privacy.mjs --check\` compares.\n` +
    ` * Types of ${name} ${VENDOR_INPUTS[name].version}'s ${what}, as the text rules call it.\n */\n`
  const phone = 'libphonenumber-js'
  const parsed = `export interface ParsedNumber {
  readonly country?: string
  readonly countryCallingCode: string
  readonly nationalNumber: string
  readonly number: string
  isValid(): boolean
  isPossible(): boolean
  getType(): string | undefined
}
`
  return {
    [path.join(PHONE_DIR, 'metadata.max.json.d.ts')]: head(phone, 'metadata.max.json.js') + 'declare const metadata: { readonly countries: Record<string, readonly unknown[]>; readonly country_calling_codes: Record<string, readonly string[]> }\nexport default metadata\n',
    [path.join(PHONE_DIR, 'es6', 'isValidPhoneNumber.d.ts')]:
      head(phone, 'es6/isValidPhoneNumber.js') + 'export default function isValidPhoneNumber(text: string, options: { defaultCountry?: string; defaultCallingCode?: string }, metadata: object): boolean\n',
    [path.join(PHONE_DIR, 'es6', 'parsePhoneNumber.d.ts')]:
      head(phone, 'es6/parsePhoneNumber.js') + parsed + 'export default function parsePhoneNumber(text: string, options: { defaultCountry?: string; defaultCallingCode?: string; extract?: boolean }, metadata: object): ParsedNumber | undefined\n',
    [path.join(PHONE_DIR, 'es6', 'findPhoneNumbersInText.d.ts')]:
      head(phone, 'es6/findPhoneNumbersInText.js') + parsed + 'export default function findPhoneNumbersInText(text: string, options: { defaultCountry?: string; leniency?: \'POSSIBLE\' | \'VALID\' }, metadata: object): { number: ParsedNumber; startsAt: number; endsAt: number }[]\n',
    [path.join(VENDOR_DIR, 'double-metaphone.d.ts')]: head('double-metaphone', 'index.js') + 'export function doubleMetaphone(value: string): [primary: string, secondary: string]\n'
  }
}

/** Every vendored file, by repository-relative path. */
export async function generate() {
  const out = {}
  const phone = await vendorInput('libphonenumber-js')
  for (const f of closure(phone, PHONE_ENTRIES)) {
    const original = phone.get('package/' + f)
    out[path.join(PHONE_DIR, ...f.split('/'))] = headerOf('libphonenumber-js', f, original) + withoutSourceMaps(original.toString('utf8'))
  }
  const dm = await vendorInput('double-metaphone')
  const index = dm.get('package/index.js')
  if (!index || importsOf(index.toString('utf8')).length) throw new Error('double-metaphone: index.js is missing or imports something')
  out[path.join(VENDOR_DIR, 'double-metaphone.js')] = headerOf('double-metaphone', 'index.js', index) + withoutSourceMaps(index.toString('utf8'))
  Object.assign(out, declarations())
  return out
}

/** Every file under the vendor folder now (repository-relative). */
function vendoredNow() {
  const out = []
  const walk = (dir) => {
    if (!existsSync(path.join(root, dir))) return
    for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name)
      if (e.isDirectory()) walk(rel)
      else out.push(rel)
    }
  }
  walk(VENDOR_DIR)
  return out
}

async function main(args) {
  const check = args.includes('--check')
  const files = await generate()
  let stale = 0
  for (const [file, text] of Object.entries(files)) {
    const at = path.join(root, file)
    let now = null
    try {
      now = readFileSync(at, 'utf8')
    } catch {
      // Missing: written below, or stale in --check.
    }
    if (now === text) continue
    if (check) {
      stale++
      console.error(`vendor-privacy: ${file} is not what the script generates; run "node scripts/vendor-privacy.mjs"`)
    } else {
      mkdirSync(path.dirname(at), { recursive: true })
      writeFileSync(at, text)
      console.log(`vendor-privacy: wrote ${file}`)
    }
  }
  for (const file of vendoredNow()) {
    if (Object.hasOwn(files, file)) continue
    if (check) {
      stale++
      console.error(`vendor-privacy: ${file} is not a vendored file`)
    } else {
      rmSync(path.join(root, file))
      console.log(`vendor-privacy: removed ${file}`)
    }
  }
  if (check && !stale) console.log(`vendor-privacy: the ${Object.keys(files).length} vendored files are up to date`)
  return stale ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`vendor-privacy: ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    }
  )
}
