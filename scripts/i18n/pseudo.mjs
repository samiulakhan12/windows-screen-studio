#!/usr/bin/env node
// The pseudo-locales (docs/design/output-and-languages.md §16.3), for development only: en-XA (accented,
// bracketed, 40% longer), bn-XA (Bengali syllables with reph, chandrabindu, below-base forms and
// conjuncts, about 30% longer) and ar-XB (reversed inside right-to-left marks, right to left).
//
//   node scripts/i18n/pseudo.mjs [--root <dir>] [--out <dir>]
//
// Writes, under scripts/i18n/pseudo/ (not committed):
// - <locale>.json: the catalogue in the built format with its direction;
// - <locale>/: the same as a catalogue folder an unpackaged build reads through
//   SSW_I18N_CATALOGUE_DIR, standing in for a UI language (bn-XA for bn, the others for es), so
//   `SSW_I18N_CATALOGUE_DIR=scripts/i18n/pseudo/bn-XA npm run dev` and choosing that language in
//   Settings › Language shows it. The page's direction follows the language it stands in for.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const files = require('./lib/files.cjs')
const { PSEUDO_LOCALES, pseudoCatalogue } = require('./lib/pseudo.cjs')
const { builtFile } = require('./lib/build.cjs')

const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const root = path.resolve(option('--root') ?? files.ROOT)
const out = path.resolve(option('--out') ?? path.join(root, files.TOOLS_DIR, 'pseudo'))
/** The UI language each pseudo-locale stands in for in a catalogue folder. */
const SLOT = { 'en-XA': 'es', 'bn-XA': 'bn', 'ar-XB': 'es' }

const en = files.readEnglish(root)
const json = (v) => `${JSON.stringify(v, null, 2)}\n`
for (const locale of PSEUDO_LOCALES) {
  const cat = pseudoCatalogue(locale, en.messages, en.meta)
  fs.mkdirSync(path.join(out, locale), { recursive: true })
  fs.writeFileSync(path.join(out, `${locale}.json`), json(cat))
  const slot = SLOT[locale]
  fs.writeFileSync(path.join(out, locale, `${slot}.json`), json(builtFile(cat.messages, en.meta)))
  fs.writeFileSync(path.join(out, locale, `${slot}.main.json`), json(builtFile(cat.messages, en.meta, (k) => files.MAIN_NAMESPACES.includes(files.namespaceOf(k)))))
  fs.writeFileSync(path.join(out, locale, 'shipped.json'), json([{ language: slot, preview: false }]))
  console.log(`i18n pseudo: ${locale} (${cat.dir}): ${Object.keys(cat.messages).length} message(s) -> ${path.relative(root, path.join(out, locale))}/ as ${slot}`)
}
