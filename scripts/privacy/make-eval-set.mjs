#!/usr/bin/env node
// Renders the privacy evaluation set: 24 lossless 1920x1080 PNG frames of everyday screens (code
// editors, terminals, logs, dashboards, a CRM, an inbox, settings, 2FA setup, checkout and bank
// forms, chat, docs), dark and light, at 100%, 125% and 150% display scale, with planted private
// items of every kind and ordinary text that must not be hidden. Writes the frames and truth.json
// (each item's text, kind and pixel rectangles, read back from the rendered page).
//
//   node scripts/privacy/make-eval-set.mjs [out_dir]     # default tests/fixtures/privacy-eval
//   node scripts/privacy/make-eval-set.mjs out_dir --holdout
//        the same scenes with other tokens (seed 5000+), dark and light swapped and the scales
//        rotated (100->125->150->100): a check that rules tuned on the set are not tuned to it
//
// Needs Chromium through `playwright` or `playwright-core` (CHROMIUM_PATH picks the executable),
// and the fonts Inter, JetBrains Mono, DejaVu Sans Mono, Liberation Sans/Mono and Carlito. The
// committed PNGs are the reference; a machine with other fonts or another Chromium draws slightly
// different pixels, so truth.json records the Chromium version and every frame's SHA-256.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KINDS, LISTED_NAMES, THEMES, baseCss, makeTokens } from './eval-lib.mjs'
import { FRAMES } from './eval-scenes.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const args = process.argv.slice(2)
const holdout = args.includes('--holdout')
const outDir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(root, 'tests', 'fixtures', 'privacy-eval'))
const ROTATE = { 1: 1.25, 1.25: 1.5, 1.5: 1 }
const require = createRequire(import.meta.url)

function chromiumType() {
  for (const m of ['playwright', 'playwright-core']) {
    try {
      return require(m).chromium
    } catch {}
  }
  throw new Error('make-eval-set: neither playwright nor playwright-core is installed')
}

// Selections drawn by the browser itself over an item's parent element: [frame id, kind, nth].
const SELECT = { 'inbox-0': ['linkToken', 0], 'chat-1': ['password', 0], 'docs-1': ['email', 0] }

const W = 1920
const H = 1080

function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

async function main() {
  const qrs = JSON.parse(readFileSync(path.join(here, 'eval-qr.json'), 'utf8'))
  mkdirSync(outDir, { recursive: true })
  const browser = await chromiumType().launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
  const frames = []
  try {
    for (const [i, [scene, variant, theme0, scale0, fn]] of FRAMES.entries()) {
      const id = `${scene}-${variant}`
      const theme = holdout ? (theme0 === 'dark' ? 'light' : 'dark') : theme0
      const scale = holdout ? ROTATE[scale0] : scale0
      const t = THEMES[theme]
      const { css, html } = fn(variant, t, makeTokens((holdout ? 5000 : 1000) + i), qrs)
      const page = await browser.newPage({ viewport: { width: Math.round(W / scale), height: Math.round(H / scale) }, deviceScaleFactor: scale })
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(t)}${css}</style></head><body>${html}</body></html>`)
      await page.evaluate(() => document.fonts.ready)
      if (SELECT[id]) {
        const [kind, nth] = SELECT[id]
        await page.evaluate(
          ([kind, nth]) => {
            const el = document.querySelectorAll(`[data-k="${kind}"]`)[nth].parentElement
            const r = document.createRange()
            r.selectNodeContents(el)
            const s = window.getSelection()
            s.removeAllRanges()
            s.addRange(r)
          },
          [kind, nth]
        )
      }
      const items = await page.evaluate(() => {
        const vw = window.innerWidth
        const vh = window.innerHeight
        // The visible part of a rectangle: inside the viewport and every clipping ancestor.
        const clip = (el, r) => {
          let [x0, y0, x1, y1] = [Math.max(0, r.left), Math.max(0, r.top), Math.min(vw, r.right), Math.min(vh, r.bottom)]
          for (let p = el.parentElement; p; p = p.parentElement) {
            const st = getComputedStyle(p)
            if (st.overflowX !== 'visible' || st.overflowY !== 'visible') {
              const c = p.getBoundingClientRect()
              x0 = Math.max(x0, c.left)
              y0 = Math.max(y0, c.top)
              x1 = Math.min(x1, c.right)
              y1 = Math.min(y1, c.bottom)
            }
          }
          return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null
        }
        return [...document.querySelectorAll('[data-k]')].map((el) => {
          let rects
          if (el.tagName.toLowerCase() === 'svg') {
            // A QR code's truth is its modules, without the blank quiet zone around them.
            const r = el.getBoundingClientRect()
            const k = Number(el.dataset.inset || 0)
            rects = [new DOMRect(r.left + r.width * k, r.top + r.height * k, r.width * (1 - 2 * k), r.height * (1 - 2 * k))]
          }
          else {
            const range = document.createRange()
            range.selectNodeContents(el)
            rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5)
          }
          const visible = rects.map((r) => clip(el, r)).filter(Boolean)
          const d = el.dataset
          return { kind: d.k, text: d.t, region: d.region, qrClass: d.qrclass, rects: visible, all: rects.length }
        })
      })
      const png = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' })
      await page.close()
      const size = pngSize(png)
      if (size.w !== W || size.h !== H) throw new Error(`${id}: ${size.w}x${size.h}, not ${W}x${H}`)
      const file = `${holdout ? 'h' : ''}${String(i + 1).padStart(2, '0')}-${id}-${theme}-${Math.round(scale * 100)}.png`
      writeFileSync(path.join(outDir, file), png)
      const out = []
      for (const [n, it] of items.entries()) {
        if (!it.rects.length && holdout) continue // scrolled out of view at this scale
        if (!it.rects.length) throw new Error(`${id}: item ${n} (${it.kind} ${it.text}) is not visible`)
        if (it.rects.length !== it.all && !holdout) throw new Error(`${id}: item ${n} (${it.kind} ${it.text}) is partly clipped`)
        const rects = it.rects.map(([x0, y0, x1, y1]) => {
          const a = [Math.floor(x0 * scale), Math.floor(y0 * scale), Math.min(W, Math.ceil(x1 * scale)), Math.min(H, Math.ceil(y1 * scale))]
          return [a[0], a[1], a[2] - a[0], a[3] - a[1]]
        })
        const xs = rects.flatMap(([x, , w]) => [x, x + w])
        const ys = rects.flatMap(([, y, , h]) => [y, y + h])
        const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
        const entry = { id: `${id}/${n}`, kind: it.kind, on: KINDS[it.kind].on, text: it.text, box, rects }
        if (it.region) entry.region = it.region
        if (it.qrClass) entry.qrClass = it.qrClass
        out.push(entry)
      }
      frames.push({ file, scene, variant, theme, scale, width: W, height: H, sha256: createHash('sha256').update(png).digest('hex'), selection: SELECT[id] ? `${SELECT[id][0]}#${SELECT[id][1]}` : null, items: out })
      console.log(`${file}: ${out.filter((x) => x.on).length} private, ${out.filter((x) => !x.on && x.kind !== 'ordinary').length} off by default, ${out.filter((x) => x.kind === 'ordinary').length} ordinary`)
    }
  } finally {
    await browser.close()
  }
  const counts = {}
  for (const f of frames) for (const it of f.items) counts[it.kind] = (counts[it.kind] || 0) + 1
  const truth = {
    version: 1,
    generator: 'scripts/privacy/make-eval-set.mjs' + (holdout ? ' --holdout' : ''),
    chromium: (await chromiumType().launch({ executablePath: process.env.CHROMIUM_PATH || undefined }).then(async (b) => [b.version(), await b.close()][0])),
    listedNames: LISTED_NAMES,
    kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.on])),
    counts,
    frames
  }
  writeFileSync(path.join(outDir, 'truth.json'), JSON.stringify(truth, null, 1) + '\n')
  console.log(JSON.stringify(counts))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
