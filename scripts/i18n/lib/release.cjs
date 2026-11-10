'use strict'
/**
 * The i18n checks of a release (docs/design/output-and-languages.md §16.4): predist's step 5 and
 * verify-dist's limit on the built catalogues.
 *
 * - Step 5 runs scripts/i18n/check.mjs with --report until config.json says "scan": "fail" (step S4);
 *   from then on an installer cannot be built with a UI text that has no key.
 * - verify-dist fails when src/shared/i18n/built/ (what the app bundles of the translations) grows by
 *   more than 1 MB over the previous release, recorded in scripts/i18n/built-baseline.json and updated
 *   after each release.
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const files = require('./files.cjs')

/** Growth of the built catalogues allowed between two releases (decimal MB, as verify-dist prints sizes). */
const BUILT_GROWTH_LIMIT = 1_000_000

/** check.mjs's arguments for step 5: `args` as given, without --report once the scan fails (S4). */
function stringsCheckArgs(config, args) {
  return config?.scan === 'fail' ? args.filter((a) => a !== '--report') : args
}

/** Predist step 5 on the tree at `root`: null when the checks pass, else the problem to report. */
function stringsStep(root, args, run = spawnSync) {
  const config = files.readConfig(root)
  const r = run(process.execPath, [...stringsCheckArgs(config, args), '--root', root], { cwd: root, stdio: 'inherit' })
  return r.status === 0 ? null : 'the string and catalogue checks failed (scripts/i18n/check.mjs, see above).'
}

/** Bytes of the built catalogue files in `dir`. */
function builtBytes(dir) {
  if (!fs.existsSync(dir)) return 0
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .reduce((total, f) => total + fs.statSync(path.join(dir, f)).size, 0)
}

/** The previous release's size of the built catalogues (scripts/i18n/built-baseline.json). */
function readBaseline(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof raw?.bytes !== 'number' || !Number.isFinite(raw.bytes) || raw.bytes < 0 || typeof raw.release !== 'string') throw new Error(`${file} needs the previous release and its built catalogues' bytes`)
  return raw
}

/** verify-dist's check: the built catalogues' size now, the baseline, and the problem when they grew by more than 1 MB. */
function builtGrowth(root = files.ROOT) {
  const bytes = builtBytes(path.join(root, files.BUILT_DIR))
  const baseline = readBaseline(path.join(root, files.TOOLS_DIR, 'built-baseline.json'))
  const growth = bytes - baseline.bytes
  const problem = growth > BUILT_GROWTH_LIMIT ? `the built catalogues grew by ${growth} B since ${baseline.release} (${baseline.bytes} B -> ${bytes} B), more than the ${BUILT_GROWTH_LIMIT} B allowed` : null
  return { bytes, baseline, growth, problem }
}

module.exports = { BUILT_GROWTH_LIMIT, stringsCheckArgs, stringsStep, builtBytes, readBaseline, builtGrowth }
