import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { detectFrame, finishHits, needsCareful, type Hit } from '../src/shared/privacy/detect/detect'
import { compileNames, looksLikeName, NO_NAMES } from '../src/shared/privacy/detect/names'
import { detectLineOf, type DetectLine } from '../src/shared/privacy/detect/score'
import { DEFAULT_KINDS } from '../src/shared/privacy/kinds'
import type { ReadLine } from '../src/shared/privacy/protocol'
import { FRAME, hitsOn, line, loadReads, loadTruth, ROOT, scoreReads, screenProblems, speechTranscript, token, VECTORS } from './autoBlurRulesFixtures'
import { detectSaid, transcriptWords } from '../src/shared/privacy/detect/said'
import { SAID_KINDS } from '../src/shared/privacy/kinds'

/*
 * Auto-blur P3: the rules on whole frames (docs/design/auto-blur.md §6.1, §6.10, §6.15, §10.3, §17.1):
 * the vectors, the evaluation set's reads, variants, dedupe, cover boxes, careful-long's trigger, false
 * hits, long lines, name-like text, and the rules in a worker.
 */

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, ext, out)
    else if (e.name.endsWith(ext)) out.push(p)
  }
  return out
}

describe('auto-blur P3: frames', () => {
  it('101. all 178 screen and 25 speech vectors of rule-vectors.json pass (placeholders expanded as runVectors.mjs does)', () => {
    expect(VECTORS.screen).toHaveLength(178)
    expect(VECTORS.speech).toHaveLength(25)
    const fails: string[] = []
    for (const v of VECTORS.screen) {
      const p = screenProblems(v)
      if (p.length) fails.push(`${v.id}: ${p.join('; ')}`)
    }
    for (const v of VECTORS.speech) {
      const tr = speechTranscript(v.words)
      const words = transcriptWords(tr)
      const got = detectSaid(tr, { kinds: SAID_KINDS, regions: ['US', 'BD'], names: NO_NAMES }).map((h) => ({ kind: h.kind, words: words.slice(h.words[0], h.words[1] + 1).map((w) => w.text).join(' ') }))
      const p: string[] = []
      for (const w of v.expect) if (!got.some((g) => g.kind === w.kind && g.words === w.words)) p.push(`missing ${w.kind} "${w.words}"`)
      for (const g of got) if (!v.expect.some((w) => w.kind === g.kind && w.words === g.words)) p.push(`extra ${g.kind} "${g.words}"`)
      if (p.length) fails.push(`${v.id}: ${p.join('; ')}`)
    }
    expect(fails).toEqual([])
  })

  it('102. on the committed main-set reads (main-tiny, and main-careful-long with every variant): 233 of 233 text items found, at least 227 fully covered, at most 1 visible item touched', () => {
    const truth = loadTruth('truth')
    for (const [reads, variants] of [['main-tiny', 'first'], ['main-careful-long', 'all']] as const) {
      const s = scoreReads(truth, loadReads(reads), variants)
      expect(s.n, reads).toBe(233)
      expect(s.found, `${reads} ${s.misses.join(', ')}`).toBe(233)
      expect(s.covered, `${reads} ${s.misses.join(', ')}`).toBeGreaterThanOrEqual(227)
      expect(s.touched, `${reads} ${s.touchedItems.join(', ')}`).toBeLessThanOrEqual(1)
    }
  })

  it('103. on the committed held-out reads (holdout-careful-long, every variant): 233 of 233 text items found, at least 230 fully covered, at most 2 visible items touched', () => {
    const s = scoreReads(loadTruth('holdout-truth'), loadReads('holdout-careful-long'), 'all')
    expect(s.n).toBe(233)
    expect(s.found, s.misses.join(', ')).toBe(233)
    expect(s.covered, s.misses.join(', ')).toBeGreaterThanOrEqual(230)
    expect(s.touched, s.touchedItems.join(', ')).toBeLessThanOrEqual(2)
  })

  it('125. variants: hits of the tiny and small reads are joined; the higher score wins', () => {
    // The tiny read misses a character the small one has; both reads of the line find the key, by different rules.
    const tail = token('«A40»', 71)
    const l = line('key sk-' + tail.slice(0, 30), 100, 200, { more: [{ text: 'key sk-proj-' + tail, model: 'small' }] })
    const hits = detectFrame([l], [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ kind: 'key', rule: 'openai', score: 0.98 })
    expect(hits[0].spans.map((s) => s.variant).sort()).toEqual([0, 1])
    // The box holds both reads' spans.
    expect(hits[0].box[0] + hits[0].box[2]).toBeGreaterThanOrEqual(100 + ('key sk-proj-' + tail).length * 10)
    // A read that finds nothing does not take away what the other found.
    const one = line('Password: hunter2!x', 100, 200, { more: [{ text: 'Passw ord hunter2!x', model: 'small' }] })
    expect(detectFrame([one], [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME }).map((h) => h.kind)).toEqual(['password'])
  })

  it('126. dedupe: a contained hit is dropped; an overlapping hit of another kind is kept', () => {
    const l = line('aaaa bbbb cccc dddd eeee ffff gggg hhhh', 100, 200)
    const lines = new Map<string, DetectLine>([['0:0', detectLineOf(l, 0, 0)]])
    const hit = (kind: Hit['kind'], score: number, start: number, end: number): Hit => ({ kind, rule: kind, score, spans: [{ line: 0, variant: 0, start, end }], box: [0, 0, 0, 0] })
    const out = finishHits([hit('key', 0.97, 0, 20), hit('id', 0.85, 5, 14), hit('email', 0.6, 15, 30), hit('phone', 0.92, 25, 39), hit('code', 0.9, 30, 35)], lines, { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })
    // id lies inside key: dropped. email overlaps key and phone but lies inside neither: kept. code lies inside phone: dropped.
    expect(out.map((h) => h.kind).sort()).toEqual(['email', 'key', 'phone'])
    // Hits of one kind that overlap are joined into one.
    const joined = finishHits([hit('key', 0.9, 0, 20), hit('key', 0.75, 15, 30)], lines, { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })
    expect(joined).toHaveLength(1)
    expect(joined[0]).toMatchObject({ score: 0.9, spans: [{ line: 0, variant: 0, start: 0, end: 30 }] })
    // Below 0.50, and kinds that are off, nothing.
    expect(finishHits([hit('key', 0.49, 0, 4), hit('address', 0.6, 5, 9)], lines, { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })).toEqual([])
  })

  it('127. cover boxes: padding of §6.1, clipped at the frame’s edge with no rounding past it (finding 22); own spans unpadded (finding 11)', () => {
    // A line 20 px high, characters 10 px wide: 7 px (0.35 × 20) up and down and inside the line, one character width at the line's ends.
    const [mid] = hitsOn('PIN 4821 for the door').map((h) => h.hit)
    expect(mid.box).toEqual([140 - 7, 400 - 7, 40 + 14, 20 + 14])
    const [end] = hitsOn('PIN: 4821').map((h) => h.hit)
    expect(end.box).toEqual([150 - 7, 393, 40 + 7 + 10, 34])
    // At least 3 px on a small line; at least the vertical pad horizontally.
    const small = detectFrame([line('PIN: 4821', 100, 200, { h: 6, charW: 2 })], [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })[0]
    expect(small.box).toEqual([110 - 3, 197, 8 + 6, 12])
    // At the frame's edge the box stops there, never past it, never rounded beyond it.
    const edge = detectFrame([line('PIN: 4821', 1830, 1063, { charW: 10, h: 17 })], [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })[0]
    expect(edge.box[0] + edge.box[2]).toBe(1920)
    expect(edge.box[1] + edge.box[3]).toBe(1080)
    const corner = detectFrame([line('PIN: 4821', 0, 0, { charW: 10, h: 17 }), line('4821', 1880, 1060, { charW: 10, h: 20 })], [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: { width: 1919, height: 1079 } })
    for (const h of corner) {
      expect(h.box[0]).toBeGreaterThanOrEqual(0)
      expect(h.box[1]).toBeGreaterThanOrEqual(0)
      expect(h.box[0] + h.box[2]).toBeLessThanOrEqual(1919)
      expect(h.box[1] + h.box[3]).toBeLessThanOrEqual(1079)
    }
    // Own spans are the secret's own characters, never the padded box (finding 11).
    const pw = hitsOn('Password: Vq7#pL2m!xR9 (rotated)')[0]
    expect(pw.text).toBe('Vq7#pL2m!xR9')
    expect(pw.hit.spans).toEqual([{ line: 0, variant: 0, start: 10, end: 22 }])
  })

  it('128. needsCareful: careful-long’s trigger on cleaned text (rule hit, confidence under 0.9, 16 or more token characters)', () => {
    const plain = line('Settings and preferences', 100, 200)
    expect(needsCareful(plain, [], 0)).toBe(false)
    // A rule hit on the line.
    const pw = line('Password: hunter2!x', 100, 200)
    expect(needsCareful(pw, detectFrame([pw], [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME }), 0)).toBe(true)
    expect(needsCareful(pw, [], 0)).toBe(false)
    // A confidence under 0.9.
    expect(needsCareful(line('Settings and preferences', 100, 200, { conf: 0.89 }), [], 0)).toBe(true)
    // A run of 16 or more token characters after cleaning: θ is a zero inside a token, a zero-width space is removed.
    expect(needsCareful(line('build abcdefghij012345', 100, 200), [], 0)).toBe(true)
    expect(needsCareful(line('build abcdefghijθ12345', 100, 200), [], 0)).toBe(true)
    expect(needsCareful(line('build abcdefghij 12345', 100, 200), [], 0)).toBe(false)
    expect(needsCareful(line('build abcdefgh\u200b12345678', 100, 200), [], 0)).toBe(true)
    expect(needsCareful(line('build abcdefgh 12345678', 100, 200), [], 0)).toBe(false)
    // A line already read again needs nothing more.
    expect(needsCareful(line('build abcdefghij012345', 100, 200, { more: [{ text: 'build abcdefghij012345' }] }), [], 0)).toBe(false)
  })

  it('134. screen false hits: Flown’s English UI catalogue gives 0; docs at most 2 per 10,000 lines', () => {
    const page = (texts: readonly string[]): ReadLine[] => texts.map((t, k) => line(t, 40, 20 + k * 26, { charW: 7 })).filter((l) => l.variants[0].text.trim())
    const run = (texts: string[]): { lines: number; hits: number } => {
      let hits = 0
      for (let i = 0; i < texts.length; i += 40) hits += detectFrame(page(texts.slice(i, i + 40)), [], { kinds: DEFAULT_KINDS, regions: ['US', 'BD'], names: NO_NAMES, frame: { width: 100_000, height: 2000 } }).length
      return { lines: texts.length, hits }
    }
    const ui: string[] = []
    const values = (o: unknown): void => {
      if (typeof o === 'string') ui.push(...o.split('\n'))
      else if (o && typeof o === 'object') for (const v of Object.values(o)) values(v)
    }
    const dir = path.join(ROOT, 'src', 'shared', 'i18n', 'messages', 'en')
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'))) values(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    expect(ui.length).toBeGreaterThan(5000)
    expect(run(ui).hits).toBe(0)
    // The docs as the rules measured them (§6.15): docs/design/auto-blur.md is left out, as it quotes the rules' own vectors.
    const docs = walk(path.join(ROOT, 'docs'), '.md')
      .filter((f) => !f.endsWith(path.join('design', 'auto-blur.md')))
      .flatMap((f) => fs.readFileSync(f, 'utf8').split('\n'))
      .map((l) => l.slice(0, 2000))
    const d = run(docs)
    expect(d.lines).toBeGreaterThan(30_000)
    expect((1e4 * d.hits) / d.lines).toBeLessThanOrEqual(2)
  }, 120_000)

  it('223. window edges: a 900-character JWT on one line is one hit covering the whole token; a hit that touches a window’s edge is extended to the end of its token run', () => {
    const jwt = token('«=eyJ|B30».«=eyJ|B300».«B562»', 81)
    expect(jwt.length).toBe(900)
    const text = 'Authorization: Bearer ' + jwt + ' next'
    const hits = hitsOn(text).filter((h) => h.kind === 'key')
    expect(hits).toHaveLength(1)
    expect(hits[0].text).toBe(jwt)
    // A token starting late in the first window: its match there stops at the window's edge and is extended to its end.
    const late = token('«=eyJ|B20».«=eyJ|B40».«B500»', 82)
    const lateText = 'x'.repeat(300) + ' ' + late + ' tail'
    const lateHits = hitsOn(lateText).filter((h) => h.kind === 'key')
    expect(lateHits).toHaveLength(1)
    expect(lateHits[0].text).toBe(late)
    expect(lateHits[0].hit.spans).toEqual([{ line: 0, variant: 0, start: 301, end: 301 + late.length }])
  })

  it('227. looksLikeName: "Priya Raman", "O’Neil" and "Mei-Lin" are names; a GitHub token, a password with a digit, a six-digit code, an email and a 41-character text are not', () => {
    for (const n of ['Priya Raman', "O'Neil", 'O’Neil', 'Mei-Lin', 'Dr. Aisha Rahman', 'রিয়াদ হাসান']) expect(looksLikeName(n), n).toBe(true)
    for (const n of [token('«=ghp_|A36»', 91), 'hunter2', '482913', 'jane.doe@acme-mail.io', 'A'.repeat(41), '', '   ', 'Password is hunter', "--"]) expect(looksLikeName(n), n).toBe(false)
    expect(looksLikeName('A'.repeat(40))).toBe(true)
  })

  it('228. rules in a worker are the same rules: detectFrame through a worker on the committed main-set reads gives exactly the hits it gives in-process', async () => {
    const truth = loadTruth('truth')
    const reads = loadReads('main-careful-long')
    const options = { kinds: DEFAULT_KINDS, regions: ['US', 'GB', 'BD'], names: compileNames(truth.listedNames, ['Flown']) }
    const frames = reads.map((r) => {
      const f = truth.frames.find((x) => x.file === r.file)!
      return { lines: r.lines, frame: { width: f.width, height: f.height } }
    })
    const inProcess = frames.map((f) => detectFrame(f.lines, [], { ...options, frame: f.frame }))
    // The worker runs detectFrame bundled as main bundles it (RulesHost, src/main/privacy/rulesHost.ts, when it exists).
    const host = path.join(ROOT, 'src', 'main', 'privacy', 'rulesHost.ts')
    let viaWorker: (Hit[] | 'timeout')[]
    if (fs.existsSync(host)) {
      const { RulesHost } = (await import(pathToFileURL(host).href)) as { RulesHost: new () => { detect(l: ReadLine[], q: [], o: unknown): Promise<Hit[] | 'timeout'>; close(): void } }
      const rules = new RulesHost()
      try {
        viaWorker = []
        for (const f of frames) viaWorker.push(await rules.detect(f.lines, [], { ...options, frame: f.frame }))
      } finally {
        rules.close()
      }
    } else {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoblur-rules-'))
      try {
        const entry = path.join(dir, 'entry.ts')
        fs.writeFileSync(entry, `import { parentPort } from 'node:worker_threads'\nimport { detectFrame } from ${JSON.stringify(path.join(ROOT, 'src', 'shared', 'privacy', 'detect', 'detect.ts'))}\nparentPort!.on('message', (m) => parentPort!.postMessage(detectFrame(m.lines, m.qr, m.options)))\n`)
        const out = path.join(dir, 'rules.mjs')
        await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' })
        const worker = new Worker(out)
        try {
          viaWorker = []
          for (const f of frames) {
            viaWorker.push(
              await new Promise<Hit[]>((resolve, reject) => {
                worker.once('message', resolve)
                worker.once('error', reject)
                worker.postMessage({ lines: f.lines, qr: [], options: { ...options, frame: f.frame } })
              })
            )
          }
        } finally {
          await worker.terminate()
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
    expect(viaWorker).toEqual(inProcess)
    expect(inProcess.flat().length).toBeGreaterThan(200)
  }, 120_000)

  it('the text rules’ numbered tests (101-135, 223-228) each exist exactly once', () => {
    const numbers = [...Array.from({ length: 35 }, (_v, i) => 101 + i), ...Array.from({ length: 6 }, (_v, i) => 223 + i)]
    const found = new Map<number, number>()
    for (const file of fs.readdirSync(__dirname).filter((f) => /^autoBlur.*\.test\.ts$/.test(f))) {
      for (const m of fs.readFileSync(path.join(__dirname, file), 'utf8').matchAll(/\bit\(\s*(['"`])(\d+)\. /g)) found.set(Number(m[2]), (found.get(Number(m[2])) ?? 0) + 1)
    }
    for (const n of numbers) expect(found.get(n), `test ${n}`).toBe(1)
  })
})
