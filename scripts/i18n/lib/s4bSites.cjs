'use strict'
/**
 * Step S4b's inventory (docs/design/output-and-languages.md §9.1, §9.3, §9.6, §16.1): every UI text
 * the words rule finds still in English (word tables, copy and sentences made of pieces), with the
 * file, line, kind and words, and the split of the files into three disjoint groups, so three builders
 * work in parallel without touching the same file:
 *
 * - `b`: src/shared and main-side tables, and the captions, speech, sound and AI files;
 * - `c`: the editor, the panels, review rows, notes, share, search, titles and the other renderer files;
 * - `d`: every file with a sentence in pieces, main's and the renderer's cancel paths ('Cancelled.'
 *   thrown or compared, §9.6) and the FLOWN_I18N_PSEUDO wiring (§12.3, §16.3).
 *
 * A file with a site in two groups' reach goes to d first, then c, then b. The other account's files
 * (pending.json) are left out: they stay pending (§9.5). scripts/i18n/s4b-sites.mjs writes the result
 * to scripts/i18n/s4b-sites.json; allow.json and the English catalogues are shared by the groups.
 */
const fs = require('node:fs')
const path = require('node:path')
const files = require('./files.cjs')
const { globRegExp, matchesAny, scanTree, WORD_KINDS } = require('./scan.cjs')

const INVENTORY = 'scripts/i18n/s4b-sites.json'

/** Main's and the renderer's cancel paths (§9.6): where 'Cancelled.' is thrown or rejected, or compared against, and the comments that promise it. */
const CANCEL_PATHS = [
  { file: 'src/main/ai/request.ts', why: "cancelled() rejects AI requests with an AiError whose message is the English 'Cancelled.'" },
  { file: 'src/main/ai/transcribe.ts', why: "throws request.ts's cancelled() ('Cancelled.') when a transcription is stopped" },
  { file: 'src/main/speech/localClient.ts', why: "throws request.ts's cancelled() ('Cancelled.') when captions on this PC are stopped" },
  { file: 'src/main/speech/download.ts', why: "a stopped speech model download fails with DownloadFailure('cancelled', 'Cancelled.')" },
  { file: 'src/shared/captions/transcriptErrors.ts', why: "describeFailure gives the English 'Cancelled.' for a cancelled request" },
  { file: 'src/main/speech/models.ts', why: "rejects a stopped download with errors.cancelled; its comment promises 'Cancelled.'" },
  { file: 'src/main/localAi/models.ts', why: "rejects a stopped download with errors.cancelled; its comment promises \"Cancelled.\"" },
  { file: 'src/main/share/webhookPost.ts', why: 'throws errors.cancelled when a post is stopped' },
  { file: 'src/renderer/src/editor/cancelled.ts', why: "isCancel compares a message with 'Cancelled.' or errors.cancelled" },
  { file: 'src/renderer/src/editor/captionItems.ts', why: 'tells a cancelled transcription by isCancel(message)' },
  { file: 'src/renderer/src/editor/speechState.ts', why: 'tells a cancelled speech model download by isCancel(message)' },
  { file: 'src/renderer/src/settings/SpeechModelsSection.tsx', why: 'tells a cancelled speech model download by isCancel(message)' },
  { file: 'src/renderer/src/settings/LocalAiSection.tsx', why: "tells a cancelled model download by comparing the message with errors.cancelled" },
  { file: 'src/shared/api/speech.ts', why: "its comment promises a rejection with 'Cancelled.'" },
  { file: 'src/shared/speech/errors.ts', why: "its comment lists 'Cancelled.' among the failure sentences" }
]

/**
 * Where a piece the rule finds is put into a sentence, when that is another file (§9.3): the merge
 * group's English path and its `.whole` message are made there.
 */
const FRAGMENT_JOINS = [
  { file: 'src/renderer/src/editor/LayoutTrack.tsx', why: "appends autoTitleSuffix() (camera.director.autoTitleSuffix, a piece starting ' · ') to a layout block's title" },
  { file: 'src/shared/editor/shortcuts.ts', why: "undoHint's keys.undoHint (' · {keys} to undo') goes into other messages' {undo} placeholder (cutsCopy, multiSelectCopy, polishCopy, directorCopy, captions/great.ts): those messages keep the placeholder" }
]

/** Where FLOWN_I18N_PSEUDO is to be wired (§12.3, §16.3): main picks the pseudo-locale's catalogue folder in an unpackaged build. */
const PSEUDO_WIRING = [
  { file: 'src/main/i18n.ts', why: 'reads the catalogue folder for an unpackaged build (SSW_I18N_CATALOGUE_DIR today); FLOWN_I18N_PSEUDO=en-XA|bn-XA|ar-XB selects a pseudo-locale there' },
  { file: 'src/shared/api/ui.ts', why: "UiInfo's catalogue comment names the unpackaged builds' catalogue folder" },
  { file: 'src/renderer/src/i18n/boot.ts', why: "takes the catalogue ui:info hands over, and the page's direction (ar-XB is right to left)" },
  { file: 'scripts/i18n/pseudo.mjs', why: 'writes the pseudo-locales FLOWN_I18N_PSEUDO selects' },
  { file: 'scripts/i18n/lib/pseudo.cjs', why: 'makes the pseudo-locales' }
]

/** Renderer files of captions, speech, sound and AI (group b): by their folder or by a word of their name. */
const B_RENDERER_DIR = /^src\/renderer\/src\/(?:ai|publish|editor\/sounds)\//
const B_RENDERER_NAME = /caption|speech|sound|voice|audio|music|transcript|studio|speaker|languages|great|cleanup|localai|aiprovider|provider|textchoices/i

/** Shared and main files of the editor, review rows, notes, share, search, titles and the engine's looks the panels show (group c). */
const C_SHARED = ['src/shared/editor/**', 'src/shared/engine/**', 'src/shared/review/**', 'src/shared/notes/**', 'src/shared/share/**', 'src/shared/search/**', 'src/shared/import/**', 'src/shared/guide/**', 'src/shared/clips/**', 'src/shared/chapters/**', 'src/shared/smart/**', 'src/shared/render/**', 'src/main/share/**', 'src/main/notes/**', 'src/main/guide/**', 'src/main/versions.ts', 'src/main/projectCopy.ts']

/** The group of a file that holds sites and is neither a sentence in pieces' nor a cancel path's nor the pseudo wiring's. */
function groupOf(file) {
  if (file.startsWith('src/renderer/')) return B_RENDERER_DIR.test(file) || B_RENDERER_NAME.test(path.posix.basename(file)) ? 'b' : 'c'
  if (C_SHARED.some((g) => globRegExp(g).test(file))) return 'c'
  return 'b'
}

/**
 * Main-side English tables that a renderer words file already shows in the UI language (§9.5, §9.6:
 * main keeps the English as data). Their sites need a look, not new messages: when the renderer shows
 * only the words file's text, the table goes to allow.json with that reason.
 */
const MIRRORS = {
  'src/shared/render/exportPresets.ts': 'src/renderer/src/editor/exportNames.ts',
  'src/shared/render/exportPlan.ts': 'src/renderer/src/editor/exportNames.ts',
  'src/shared/render/exportBundle.ts': 'src/renderer/src/editor/exportNames.ts',
  'src/shared/render/exportRows.ts': 'src/renderer/src/editor/exportNames.ts',
  'src/shared/editor/versions.ts': 'src/shared/editor/versionWords.ts',
  'src/shared/publish/pack.ts': 'src/renderer/src/publish/publishWords.ts',
  'src/shared/captions/captionTracks.ts': 'src/renderer/src/editor/captionWords.ts',
  'src/shared/captions/subtitles.ts': 'src/renderer/src/editor/captionWords.ts',
  'src/shared/captions/speakers.ts': 'src/renderer/src/editor/captionWords.ts',
  'src/shared/audio/soundLibrary.ts': 'src/shared/audio/soundNames.ts',
  'src/shared/engine/backgrounds.ts': 'src/shared/engine/lookNames.ts',
  'src/shared/engine/wallpapers.ts': 'src/shared/engine/lookNames.ts',
  'src/shared/engine/easing.ts': 'src/shared/engine/lookNames.ts',
  'src/shared/engine/tilt.ts': 'src/shared/engine/lookNames.ts'
}

/** The inventory of `root`: the sites, the three groups and their counts. */
function inventoryOf(root = files.ROOT) {
  const scan = scanTree(root, { wordsMode: 'report' })
  const sites = scan.words.filter((f) => WORD_KINDS.includes(f.kind))
  const pending = files.readPending(root)
  const groupFiles = { b: new Set(), c: new Set(), d: new Set() }
  const dWhy = {}
  for (const f of sites) if (f.kind === 'fragment') (dWhy[f.file] ??= []).push('a sentence in pieces')
  for (const p of [...FRAGMENT_JOINS, ...CANCEL_PATHS, ...PSEUDO_WIRING]) {
    if (!fs.existsSync(path.join(root, p.file)) || matchesAny(p.file, pending.files)) continue
    ;(dWhy[p.file] ??= []).push(p.why)
  }
  for (const file of Object.keys(dWhy)) groupFiles.d.add(file)
  for (const f of sites) if (!groupFiles.d.has(f.file)) groupFiles[groupOf(f.file)].add(f.file)
  const group = (file) => (groupFiles.d.has(file) ? 'd' : groupFiles.c.has(file) ? 'c' : 'b')
  const listed = sites.map((f) => ({ file: f.file, line: f.line, kind: f.kind, text: f.text, group: group(f.file), ...(MIRRORS[f.file] ? { mirroredBy: MIRRORS[f.file] } : {}) }))
  const count = (list, kind) => list.filter((s) => s.kind === kind).length
  const groups = {}
  const titles = {
    b: 'Shared and main-side tables, and the captions, speech, sound and AI files',
    c: 'The editor, panels, review rows, notes, share, search and titles files',
    d: "Sentences in pieces (merge groups and .whole messages, §9.3), main's and the renderer's cancel paths (§9.6) and the FLOWN_I18N_PSEUDO wiring (§12.3, §16.3)"
  }
  for (const g of ['b', 'c', 'd']) {
    const own = listed.filter((s) => s.group === g)
    groups[g] = {
      title: titles[g],
      sites: own.length,
      tables: count(own, 'table'),
      copy: count(own, 'copy'),
      fragments: count(own, 'fragment'),
      files: [...groupFiles[g]].sort(),
      ...(g === 'd' ? { why: Object.fromEntries(Object.entries(dWhy).sort(([a], [b2]) => a.localeCompare(b2)).map(([k, v]) => [k, [...new Set(v)]])) } : {})
    }
  }
  return {
    counts: { sites: listed.length, tables: count(listed, 'table'), copy: count(listed, 'copy'), fragments: count(listed, 'fragment'), files: new Set(listed.map((s) => s.file)).size, pending: scan.pending.filter((f) => WORD_KINDS.includes(f.kind)).length },
    groups,
    sites: listed
  }
}

/** The inventory as the JSON file holds it. */
function inventoryJson(root = files.ROOT) {
  const inv = inventoryOf(root)
  return `${JSON.stringify(
    {
      $comment:
        "Step S4b's inventory (docs/design/output-and-languages.md §9.1, §9.3, §9.6, §16.1), written by node scripts/i18n/s4b-sites.mjs: every UI text the scanner's words rule (scripts/i18n/lib/scan.cjs, WORD_KINDS) finds still in English, as 'table' (a word table: labels, names, hints, notes and sentences in object and array literals, maps keyed by ids, getters), 'copy' (words a function returns or builds outside a table) and 'fragment' (a sentence made of pieces: it needs a merge group with a .whole message, §9.3, unless one message with a placeholder gives the same English). Each site is in one group; the groups' files are disjoint, so the builders of b, c and d never touch the same source file (allow.json and the English catalogues are shared). 'mirroredBy' names a renderer words file that already shows a main-side table in the UI language: such a table stays English as data (§9.5, §9.6) and goes to allow.json with that reason once the renderer shows only the words file's text. Text that is data (ids, AI prompts, file-format words, words in exported files) goes to allow.json with its reason; UI text never does. The other account's files are left out (pending, §9.5).",
      ...inv
    },
    null,
    2
  )}\n`
}

module.exports = { INVENTORY, FRAGMENT_JOINS, CANCEL_PATHS, PSEUDO_WIRING, MIRRORS, groupOf, inventoryOf, inventoryJson }
