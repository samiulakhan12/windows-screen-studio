'use strict'
/**
 * How the extraction is split (docs/design/output-and-languages.md §10.5): each extraction part owns
 * files and namespaces, so the parts merge without conflicts. scripts/i18n/split.mjs applies these
 * rules to the merged tree at S2 and writes scripts/i18n/parts.json; a file two rules claim, and a
 * file with UI text no rule claims, are listed for the lead to settle before S3. X6 (formatter call
 * sites) works by call line, not by file, and owns no file here.
 */
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const files = require('./files.cjs')
const { globRegExp, matchesAny, scanTree } = require('./scan.cjs')

const R = 'src/renderer/src'
const panels = (...names) => names.map((n) => `${R}/editor/panels/${n}`)

/** Each part's namespaces and the files it edits, as globs over repository paths (§10.5). */
const PARTS = {
  X1: {
    title: 'Editor shell',
    namespaces: ['editor', 'timeline', 'commands', 'keys'],
    files: [
      `${R}/views/Editor.tsx`,
      `${R}/App.tsx`,
      `${R}/editor/Timeline*.tsx`,
      `${R}/editor/Transport*.tsx`,
      `${R}/editor/PreviewStage.tsx`,
      `${R}/editor/PreviewSpeed.tsx`,
      `${R}/editor/CommandPalette.tsx`,
      `${R}/editor/Shortcut*.tsx`,
      `${R}/editor/SaveIndicator.tsx`,
      `${R}/editor/SnapGuide.tsx`,
      `${R}/editor/Inspector.tsx`,
      `${R}/editor/context.ts`,
      `${R}/editor/videoTrack.ts`,
      `${R}/editor/media.ts`,
      'src/shared/editor/commands.ts',
      'src/shared/editor/shortcuts.ts',
      'src/shared/editor/multiSelectCopy.ts',
      'src/shared/editor/snapping.ts',
      'src/shared/engine/**'
    ]
  },
  X2: {
    title: 'Panels',
    namespaces: ['style', 'zoom', 'camera', 'sound', 'text'],
    files: [
      ...panels(
        'Style*.tsx',
        'Watermark*.tsx',
        'BrandKitBar.tsx',
        'Zoom*.tsx',
        'Cursor*.tsx',
        'Magnifier*.tsx',
        'Camera*.tsx',
        'Director*.tsx',
        'Audio*.tsx',
        'Voice*.tsx',
        'MusicLibrary*.tsx',
        'SoundEffects*.tsx',
        'Shapes*.tsx',
        'TextPanel.tsx',
        'Callout*.tsx',
        'calloutControls.tsx',
        'Bubble*.tsx',
        'Badge*.tsx',
        'Graphics*.tsx',
        'Images*.tsx',
        'ChapterBar*.tsx',
        'ProgressBarLink.tsx',
        'CalmMotion*.tsx',
        'Colour*.tsx',
        'ScreenColour*.tsx',
        'ContrastMeter.tsx',
        'Crop*.tsx',
        'Follow*.tsx',
        'Cut*.tsx',
        'Join*.tsx',
        'Effects*.tsx',
        'Freeze*.tsx',
        'Clip*.tsx',
        'Selection*.tsx',
        'FontPicker.tsx',
        'RadioChips.tsx'
      ),
      `${R}/editor/mixedControls.tsx`,
      `${R}/editor/LayoutTrack.tsx`,
      `${R}/editor/{GraphicsTrack,GraphicHandle,OverlayTrack,OverlayEditor,OverlayDropZone,TitleTrack,CalloutHandles,CropEditor,FreezeMarks,LookButtons}.tsx`,
      `${R}/editor/{overlayItems,directorAnalysis,autoColourRun}.ts`,
      `${R}/editor/sounds/**`,
      'src/shared/editor/layoutCommands.ts',
      'src/shared/audio/voiceCopy.ts',
      'src/shared/audio/soundsCopy.ts',
      'src/shared/audio/**',
      'src/shared/editor/{annotations,calloutsEdit,graphicsEdit,groupEdit,layouts,shapes,titles,zoomEdit}.ts',
      'src/shared/editor/directorCopy.ts',
      'src/shared/editor/cutsCopy.ts',
      'src/shared/editor/stylePresets.ts'
    ]
  },
  X3: {
    title: 'Captions and smart tools',
    namespaces: ['captions', 'smart'],
    files: [
      ...panels('Caption*.tsx', 'Speakers*.tsx', 'Studio*.tsx', 'Transcript*.tsx', 'LocalCaptions.tsx', 'Cleanup*.tsx', 'Languages*.tsx', 'Great*.tsx', 'FindChapters.tsx', 'SubtitlesField.tsx'),
      `${R}/editor/CaptionTrack.tsx`,
      `${R}/editor/panels/captionTiles.ts`,
      `${R}/editor/{captionItems,captionPresets,chaptersRun,greatRun,speechState}.ts`,
      `${R}/guide/**`,
      `${R}/clips/**`,
      `${R}/ai/**`,
      `${R}/smart/**`,
      'src/shared/speech/speechCopy.ts',
      // SPEECH_TIER_NAMES (§9.1): a table of labels the scanner does not see as text.
      'src/shared/speech/catalog.ts',
      'src/shared/speech/**',
      'src/shared/captions/**',
      'src/shared/clips/**',
      'src/shared/localAi/**'
    ]
  },
  X4: {
    title: 'Review and project tools',
    namespaces: ['review'],
    files: [
      `${R}/review/**`,
      `${R}/versions/**`,
      `${R}/editor/PolishDialog.tsx`,
      `${R}/editor/polishRunner.ts`,
      `${R}/notes/**`,
      `${R}/views/NotesWindow.tsx`,
      `${R}/search/**`,
      `${R}/share/**`,
      `${R}/publish/**`,
      `${R}/import/**`,
      `${R}/editor/duplicateFlow.ts`,
      `${R}/editor/CopyMenu.tsx`,
      'src/shared/review/copy.ts',
      'src/shared/review/**',
      'src/shared/editor/polishCopy.ts',
      'src/shared/notes/notesCopy.ts',
      'src/shared/notes/**',
      'src/shared/import/**',
      'src/shared/editor/versions.ts',
      'src/shared/publish/**',
      'src/shared/share/**',
      'src/shared/search/**'
    ]
  },
  X5: {
    title: 'Export, settings, Home and main',
    namespaces: ['home', 'export', 'settings', 'errors', 'main'],
    files: [
      `${R}/editor/ExportDialog.tsx`,
      `${R}/editor/ExportBundleOptions.tsx`,
      `${R}/editor/exportIcons.tsx`,
      `${R}/editor/exporter.ts`,
      `${R}/render/**`,
      // EXPORT_PRESETS labels, RESOLUTION_LABELS and ENCODER_NAMES (§9.1, §10.5): tables of labels
      // the scanner does not see as text.
      'src/shared/render/exportPresets.ts',
      'src/shared/render/exportPlan.ts',
      'src/shared/render/**',
      // The AI providers' names and presets, shown in Settings › AI providers.
      'src/shared/ai/**',
      'src/shared/api/ai.ts',
      `${R}/settings/**`,
      `${R}/updates/**`,
      `${R}/views/Home.tsx`,
      `${R}/views/RegionPicker.tsx`,
      `${R}/views/CameraBubble.tsx`,
      'src/shared/updates/updates.ts',
      'src/shared/jobs/longJobs.ts',
      'src/main/**',
      'src/preload/**'
    ]
  },
  X7: {
    title: 'Right-to-left styles',
    namespaces: [],
    // Every stylesheet is X7's alone; the other parts own no stylesheet.
    css: true,
    files: ['src/**/*.css']
  }
}

/** Never split: the files of parts P1-P7 are keyed already, and this one is P6's (§10.5 row X7). */
const NEVER = ['src/renderer/src/i18n/scripts.css']

/** A glob with {a,b} alternatives as several globs. */
function expand(glob) {
  const m = /\{([^}]*)\}/.exec(glob)
  if (!m) return [glob]
  return m[1].split(',').flatMap((alt) => expand(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)))
}

/**
 * The split of `candidates` (repository paths): each part's files, the files two parts claim and the
 * files no part claims. `parts` defaults to PARTS.
 */
function splitParts(candidates, parts = PARTS, never = NEVER) {
  const out = { parts: {}, conflicts: [], unclaimed: [] }
  const matchers = Object.entries(parts).map(([id, p]) => ({ id, css: !!p.css, res: p.files.flatMap(expand).map(globRegExp) }))
  for (const [id, p] of Object.entries(parts)) out.parts[id] = { title: p.title, namespaces: p.namespaces, files: [] }
  for (const file of [...new Set(candidates)].sort()) {
    if (never.includes(file)) continue
    const isCss = file.endsWith('.css')
    const owners = matchers.filter((m) => m.css === isCss && m.res.some((re) => re.test(file))).map((m) => m.id)
    if (owners.length === 1) out.parts[owners[0]].files.push(file)
    else if (owners.length > 1) out.conflicts.push({ file, parts: owners })
    else out.unclaimed.push(file)
  }
  return out
}

/** Properties whose string values are labels a table holds for the UI (`{ id: 'aurora', label: 'Aurora' }`). */
const LABEL_PROPS = new Set(['label', 'title', 'name', 'description', 'hint', 'tooltip', 'placeholder', 'summary', 'text', 'heading', 'help', 'note'])

/** Whether a property's string looks like words a person reads, not an id or a path: a capitalised word first, or two words. */
const looksLikeWords = (s) => /^[A-Z][a-z]+\b/.test(s) || /[A-Za-z]{2,} [A-Za-z]{2,}/.test(s)

/**
 * The source files that hold tables of labels: a string that looks like words in a property such as
 * `label` or `title` (§9.1: COMMAND_LIST, EXPORT_PRESETS, SPEECH_TIER_NAMES, …). The scanner reads
 * text at its sinks, not in tables, so without these the split would leave such files to nobody.
 */
function labelTablesOf(root = files.ROOT) {
  const out = []
  for (const abs of files.sourceFiles(root)) {
    if (abs.includes(`${path.sep}i18n${path.sep}messages${path.sep}`)) continue
    const text = fs.readFileSync(abs, 'utf8')
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    let found = false
    const visit = (node) => {
      if (found) return
      if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && LABEL_PROPS.has(node.name.text)) {
        const v = node.initializer
        if ((ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) && looksLikeWords(v.text)) found = true
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    if (found) out.push(files.rel(root, abs))
  }
  return out
}

/**
 * The files to split in a tree: every source file with UI text still to extract (the scanner's
 * report and failures), every file with a table of labels, every file a rule names outright, and
 * every stylesheet; the other account's files (pending.json), the parts' files (config.json's
 * failFor) and the files allow.json leaves out whole left out.
 */
function candidatesOf(root = files.ROOT) {
  const scan = scanTree(root, { mode: 'report' })
  const config = files.readConfig(root)
  const pending = files.readPending(root)
  const allow = files.readAllow(root)
  const named = Object.values(PARTS)
    .flatMap((p) => p.files)
    .flatMap(expand)
    .filter((g) => !g.includes('*'))
  const css = files.walk(path.join(root, 'src'), (p) => p.endsWith('.css')).map((p) => files.rel(root, p))
  const all = [...scan.report.map((f) => f.file), ...labelTablesOf(root), ...named.filter((f) => fs.existsSync(path.join(root, f))), ...css]
  return [...new Set(all)].filter((f) => !matchesAny(f, pending.files) && !matchesAny(f, allow.files) && !(config.failFor ?? []).includes(f)).sort()
}

module.exports = { PARTS, NEVER, expand, splitParts, candidatesOf, labelTablesOf }
