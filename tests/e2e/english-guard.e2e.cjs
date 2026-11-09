// The English guards (docs/design/output-and-languages.md §10.6, tests 9 and 10): the English UI does
// not change while its strings move into catalogues. The tour of uiTour.cjs runs on a fixed clock and
// fixed data, and each run is compared with the baseline in tests/e2e/english-guard/:
//   test 9:  the title, text, text attributes, accessible names and main-process strings of every
//            screen, exactly;
//   test 10: every element with text: its tag, box (within 0.5 px), font, colour, direction and
//            alignment (logical keywords through the direction), and each screenshot pixel for pixel
//            with 0.1% of pixels allowed to differ by at most 2 levels.
// Modes:
//   node tests/e2e/english-guard.e2e.cjs            compare with the baseline; with none yet, say so and pass
//   node tests/e2e/english-guard.e2e.cjs --twice    run the tour twice and compare the runs (no baseline written)
//   node tests/e2e/english-guard.e2e.cjs --record   run twice; write the baseline only when both runs are identical
// The baseline is recorded once, at step S2 (§10.4), and changed only by a feature that changes the
// English UI on purpose, named in its commit. It is never re-recorded to make an extraction pass.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const tour = require('./uiTour.cjs')

const BASELINE = path.join(__dirname, 'english-guard')
const RUNS = path.join(os.tmpdir(), 'flown-english-guard')

/** Raw RGBA pixels of a PNG (ffmpeg decodes it). */
function pixels(file) {
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim()
  const [width, height] = probe.split(',').map(Number)
  const data = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 30 })
  return { width, height, data }
}

/** Test 10's screenshot rule: at most 0.1% of pixels differ, none by more than 2 levels. */
function compareShots(a, b) {
  const x = pixels(a)
  const y = pixels(b)
  if (x.width !== y.width || x.height !== y.height) return `size ${x.width}×${x.height} against ${y.width}×${y.height}`
  let differ = 0
  let worst = 0
  for (let i = 0; i < x.data.length; i += 4) {
    let d = 0
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(x.data[i + c] - y.data[i + c]))
    if (d) {
      differ++
      worst = Math.max(worst, d)
    }
  }
  const total = x.width * x.height
  if (worst > 2) return `${differ} pixels differ, by up to ${worst} levels`
  if (differ > total * 0.001) return `${differ} pixels differ (more than 0.1% of ${total})`
  return null
}

/** The differences of `run` from `base`, by test: text and names (9) and layout (10). */
function compareRuns(run, base, shots = null) {
  const problems = { text: [], layout: [] }
  const names = (r) => r.screens.map((s) => s.name)
  if (JSON.stringify(names(run)) !== JSON.stringify(names(base))) problems.text.push(`screens: ${names(run).join(', ')} against ${names(base).join(', ')}`)
  for (const b of base.screens) {
    const r = run.screens.find((s) => s.name === b.name)
    if (!r) continue
    for (const key of ['title', 'text', 'aria']) if (r[key] !== b[key]) problems.text.push(`${b.name}: ${key} differs:\n--- baseline\n${b[key]}\n+++ run\n${r[key]}`)
    for (const key of ['attrs', 'main']) if (JSON.stringify(r[key]) !== JSON.stringify(b[key])) problems.text.push(`${b.name}: ${key} differ`)
    if (r.boxes.length !== b.boxes.length) problems.layout.push(`${b.name}: ${r.boxes.length} elements with text against ${b.boxes.length}`)
    else
      r.boxes.forEach((x, i) => {
        const y = b.boxes[i]
        const moved = x.box.some((v, k) => Math.abs(v - y.box[k]) > 0.5)
        const same = x.path === y.path && x.tag === y.tag && JSON.stringify(x.font) === JSON.stringify(y.font) && x.color === y.color && x.direction === y.direction && x.align === y.align
        if (moved || !same) problems.layout.push(`${b.name}: ${x.path} ${JSON.stringify(x)} against ${JSON.stringify(y)}`)
      })
    if (shots) {
      const why = compareShots(path.join(shots.run, `${b.name}.png`), path.join(shots.base, `${b.name}.png`))
      if (why) problems.layout.push(`${b.name}: screenshot: ${why}`)
    }
  }
  return problems
}

async function walk(n) {
  const out = path.join(RUNS, `run-${n}`)
  const result = await tour.runTour({ out, log: (m) => process.env.SSW_GUARD_VERBOSE && console.log(m) })
  fs.writeFileSync(path.join(out, 'tour.json'), JSON.stringify(result, null, 1))
  h.assert(result.blocked.length === 0, `no network request (blocked: ${result.blocked.join(', ')})`)
  return { out, result }
}

function report(problems, what) {
  const all = [...problems.text.map((p) => `test 9: ${p}`), ...problems.layout.map((p) => `test 10: ${p}`)]
  h.assert(all.length === 0, `${what}:\n${all.slice(0, 40).join('\n')}${all.length > 40 ? `\n… and ${all.length - 40} more` : ''}`)
}

async function main() {
  const mode = process.argv.includes('--record') ? 'record' : process.argv.includes('--twice') ? 'twice' : 'compare'
  await h.run(`english guard (${mode})`, async () => {
    if (mode === 'compare') {
      const baseFile = path.join(BASELINE, 'baseline.json')
      const { out, result } = await walk(1)
      if (!fs.existsSync(baseFile)) {
        console.log(`No baseline yet (it is recorded at step S2): the tour walked ${result.screens.length} screens and recorded nothing.`)
        return
      }
      const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'))
      report(compareRuns(result, base, { run: out, base: path.join(BASELINE, 'shots') }), 'the English UI changed')
      return
    }
    const one = await walk(1)
    const two = await walk(2)
    report(compareRuns(two.result, one.result, { run: two.out, base: one.out }), 'two runs of the tour differ, so no baseline can be recorded')
    if (mode === 'twice') {
      console.log(`Two runs of the tour are identical (${one.result.screens.length} screens); no baseline written.`)
      return
    }
    fs.rmSync(BASELINE, { recursive: true, force: true })
    fs.mkdirSync(path.join(BASELINE, 'shots'), { recursive: true })
    fs.writeFileSync(path.join(BASELINE, 'baseline.json'), JSON.stringify(one.result, null, 1))
    for (const s of one.result.screens) fs.copyFileSync(path.join(one.out, `${s.name}.png`), path.join(BASELINE, 'shots', `${s.name}.png`))
    console.log(`Baseline recorded from two identical runs: ${one.result.screens.length} screens.`)
  })
}

if (require.main === module) void main()

module.exports = { compareRuns, compareShots }
