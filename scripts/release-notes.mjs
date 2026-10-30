#!/usr/bin/env node
// The notes of one version for its GitHub release (docs/RELEASING.md): the `## <version>` section of
// docs/RELEASE-NOTES.md, without its heading, up to the next `## ` heading. Flown shows them in
// Settings › About as plain text (docs/design/auto-update.md §1.7).
//
//   node scripts/release-notes.mjs 0.7.1     # prints the notes; exits 1 when the section is missing
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The `## <version>` section of `markdown` (trimmed, without its heading), or null. */
export function notesFor(markdown, version) {
  const lines = String(markdown).split(/\r?\n/)
  const heading = `## ${version}`
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start === -1) return null
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  if (end === -1) end = lines.length
  const body = lines.slice(start + 1, end).join('\n').trim()
  return body || null
}

const self = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const version = process.argv[2]
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('release-notes: give the version, for example: node scripts/release-notes.mjs 0.7.1')
    process.exit(2)
  }
  const file = path.join(path.dirname(self), '..', 'docs', 'RELEASE-NOTES.md')
  const notes = notesFor(readFileSync(file, 'utf8'), version)
  if (!notes) {
    console.error(`release-notes: docs/RELEASE-NOTES.md has no "## ${version}" section; write the notes first.`)
    process.exit(1)
  }
  process.stdout.write(`${notes}\n`)
}
