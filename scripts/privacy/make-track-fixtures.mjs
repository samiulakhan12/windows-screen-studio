#!/usr/bin/env node
// Renders the tracking set of docs/design/auto-blur.md A16 (§17.3, §16.0 item 13): lossless 60 fps
// videos of screens that move (a scrolling list, a fast flick, browser zoom, a selection, a sticky
// header, a window dragged diagonally, toasts sliding in and out, a tooltip passing over text, an
// email typed into a field, a key typed into a terminal and deleted, a key typed on a terminal's last
// line before Enter scrolls it, a token pasted after its prompt), each with a truth file holding
// every planted item's box in every frame, read back from the page as make-eval-set.mjs reads its
// truth. Every frame is set by the page itself (window.setFrame(n)), never by a clock, so the same
// case draws the same frames on every run.
//
//   node scripts/privacy/make-track-fixtures.mjs <out_dir> [--case <id>] [--seconds <s>] [--size <w>x<h>] [--seed <n>]
//
// A case may hold its own length (the toasts, whose notifications live 2.8 s; the flick, at rest 5.2 s
// before each of its three flicks) and the keystrokes cursor.json would hold for it (`cursor`: typing
// bursts and shortcut keys, in frames; the truth file gives them in seconds). Writes <id>.mp4
// (-c:v libx264rgb -qp 0 -r 60) and <id>.truth.json per case: { fps, width, height,
// frames: [{ n, items: [{ id, kind, on, text, box: [x, y, w, h] }] }] }, an item listed in the frames
// it shows in. The evaluation frames at 150% and 200% display scale and the held-out frames come from
// make-eval-set.mjs (--scale, --seed). Needs Chromium through `playwright` or `playwright-core`
// (CHROMIUM_PATH picks the executable) and ffmpeg (FFMPEG, else the bundled ffmpeg-static, else PATH).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KINDS, THEMES, baseCss, esc, makeTokens, O, P } from './eval-lib.mjs'

const require = createRequire(import.meta.url)
const FPS = 60

function chromiumType() {
  for (const m of ['playwright', 'playwright-core']) {
    try {
      return require(m).chromium
    } catch {}
  }
  throw new Error('make-track-fixtures: neither playwright nor playwright-core is installed')
}

function ffmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG
  try {
    const p = require('ffmpeg-static')
    if (p) return p
  } catch {}
  return 'ffmpeg'
}

/** The planted values of a run: made once from the evaluation set's token generators (seeded). */
export function plantValues(tok) {
  return {
    email: `jamie.${tok.alnum(5).toLowerCase()}@example.com`,
    key: tok.aws(),
    card: tok.visa(),
    phone: `+1 415 555 ${tok.digits(4)}`,
    token: tok.ghp(),
    password: `Pw-${tok.alnum(10)}`,
    code: tok.digits(6),
    secret: tok.awsSecret()
  }
}

/**
 * A list of `n` rows, every other one a planted item alone on its line, the rest ordinary text. The
 * row above a password is its label, "Password": a password is found by its label (§6.7, decision 2;
 * an unlabelled one is a random-looking string, off by default), and planted alone with ordinary text
 * above it Find never found it, so A16 counted it uncovered in every frame.
 */
function listRows(v, n) {
  const planted = [
    ['email', v.email],
    ['key', v.key],
    ['card', v.card],
    ['phone', v.phone],
    ['key', v.token],
    ['password', v.password]
  ]
  const rows = []
  for (let i = 0; i < n; i++) {
    if (i % 2) rows.push(`<div class="row">${O(planted[((i + 1) / 2) % planted.length][0] === 'password' ? 'Password' : `Ticket ${1000 + i} · updated by the support team`)}</div>`)
    else {
      const [kind, text] = planted[(i / 2) % planted.length]
      rows.push(`<div class="row">${P(kind, text)}</div>`)
    }
  }
  return rows.join('')
}

/**
 * The cases: each draws a page whose window.setFrame(n) puts frame n on screen, for `seconds` when a
 * case gives its own length. The flick moves 1,600 px a second; the list scroll moves 240 px a second.
 */
export const CASES = {
  'list-scroll': (v) => ({
    css: '.list{position:absolute;inset:0;overflow:hidden}.row{height:28px;line-height:28px;padding:0 16px;white-space:nowrap}',
    html: `<div class="list" id="l">${listRows(v, 160)}</div>`,
    script: 'window.setFrame=(n)=>{document.getElementById("l").scrollTop=Math.round(n*240/60)}'
  }),
  'flick-scroll': (v) => ({
    // Three flicks at 1,600 px a second, 672, 672 and 456 px (0.42, 0.42 and 0.29 s), from the list's
    // top to 1,800 px, each after 5.2 s at rest, and 1.075 s at rest at the end. Every other row is a
    // planted item, as in the first version (one flick of 1,800 px after 0.2 s), and every row the
    // flicks carry past is also at rest, whole, for 5.2 s or more at one of the stops (0, 672, 1,344,
    // 1,800 px, 24 rows apart, a frame showing 25): a row only carried past is on screen under half a
    // second, never still, as a page scrolled past quickly is, which Find may miss (§2.9, §5.4 point
    // 6), and reads of stops less than 5 s apart are merged when the plan is over its budget (§5.4
    // point 7).
    seconds: 17.8,
    css: '.list{position:absolute;inset:0;overflow:hidden}.row{height:28px;line-height:28px;padding:0 16px;white-space:nowrap}',
    html: `<div class="list" id="l">${listRows(v, 400)}</div>`,
    script:
      'window.setFrame=(n)=>{let t=n/60,y=1800;const s=[0,672,1344,1800];for(let i=0;i<3;i++){if(t<5.2){y=s[i];break}t-=5.2;const d=(s[i+1]-s[i])/1600;if(t<d){y=s[i]+1600*t;break}t-=d}document.getElementById("l").scrollTop=Math.round(y)}'
  }),
  'browser-zoom': (v) => ({
    css: '.page{position:absolute;inset:0;overflow:hidden;transform-origin:0 0;padding:16px}.row{line-height:28px;white-space:nowrap}',
    html: `<div class="page" id="p">${listRows(v, 20)}</div>`,
    script: 'window.setFrame=(n)=>{const s=[1,1.1,1.25,1.5,1.25,1.1,1,0.9,0.8,0.9][Math.floor(n/12)%10];document.getElementById("p").style.zoom=String(s)}'
  }),
  'select-text': (v) => ({
    css: '.page{padding:16px}.row{line-height:28px;white-space:nowrap}',
    html: `<div class="page">${listRows(v, 12)}</div>`,
    script:
      'window.setFrame=(n)=>{const s=getSelection();s.removeAllRanges();if(Math.floor(n/30)%2){const r=document.createRange();const el=document.querySelectorAll("[data-k]")[Math.floor(n/60)%3].parentElement;r.selectNodeContents(el);s.addRange(r)}}'
  }),
  'sticky-header': (v) => ({
    css: '.list{position:absolute;inset:0;overflow:hidden}.head{position:sticky;top:0;height:40px;line-height:40px;padding:0 16px;background:#20232a;color:#fff;z-index:2}.row{height:28px;line-height:28px;padding:0 16px;white-space:nowrap}',
    html: `<div class="list" id="l"><div class="head">${P('email', v.email)}</div>${listRows(v, 120)}</div>`,
    script: 'window.setFrame=(n)=>{document.getElementById("l").scrollTop=Math.round(n*300/60)}'
  }),
  'window-drag': (v) => ({
    css: '.win{position:absolute;width:300px;padding:12px;background:#fff;box-shadow:0 0 0 1px #888;color:#111}.row{line-height:24px;white-space:nowrap}',
    html: `<div class="win" id="w"><div class="row">${O('Sign in')}</div><div class="row">${P('email', v.email)}</div><div class="row">${O('Password')}</div><div class="row">${P('password', v.password)}</div></div>`,
    script: 'window.setFrame=(n)=>{const w=document.getElementById("w");w.style.left=(20+n*1.5)+"px";w.style.top=(10+n*0.9)+"px"}'
  }),
  toasts: (v) => ({
    // Notifications live 2 s or more (§6.13): each slides in over 20 frames, rests 130 (2.17 s) and
    // slides out over 20, the second stacked under the first from frame 30; the recording runs on
    // 10 frames after the second is gone. `bottom:auto`: the evaluation set's own .toast (baseCss)
    // pins its bottom, which stretched these to 90% of the frame's height.
    seconds: 3.5,
    css: '.toast{position:absolute;right:12px;bottom:auto;width:260px;padding:10px;background:#2b2f36;color:#fff;border-radius:6px;white-space:nowrap}.page{padding:16px}.row{line-height:28px}',
    html: `<div class="page">${listRows(v, 6)}</div><div class="toast" id="t1">${O('Your code')} ${P('code', v.code)}</div><div class="toast" id="t2">${O('New login')} ${P('email', v.email)}</div>`,
    script:
      'window.setFrame=(n)=>{const x=(k,start)=>{const f=n-start;return f<0?-400:f<20?-400+f*20:f<150?0:f<170?-(f-150)*20:-400};const a=document.getElementById("t1"),b=document.getElementById("t2");a.style.top="12px";a.style.right=(12+Math.min(0,x(0,10)))+"px";b.style.top="70px";b.style.right=(12+Math.min(0,x(0,30)))+"px"}'
  }),
  tooltip: (v) => ({
    css: '.page{padding:16px}.row{line-height:28px;white-space:nowrap}.tip{position:absolute;padding:6px 10px;background:#111;color:#fff;border-radius:4px;white-space:nowrap}',
    html: `<div class="page">${listRows(v, 8)}</div><div class="tip" id="tip">${O('Copied to the clipboard')}</div>`,
    script: 'window.setFrame=(n)=>{const t=document.getElementById("tip");t.style.left=(10+n*3)+"px";t.style.top=(18+n*0.5)+"px";t.style.display=n<100?"block":"none"}'
  }),
  'type-email': (v) => ({
    css: '.form{padding:24px}.field{border:1px solid #888;height:32px;line-height:32px;padding:0 8px;width:360px;white-space:nowrap}',
    html: `<div class="form"><div>${O('Email address')}</div><div class="field"><span data-k="email" data-t="${esc(v.email)}" id="f"></span></div></div>`,
    script: `window.setFrame=(n)=>{const s=${JSON.stringify(v.email)};const k=Math.min(s.length,Math.floor(n/3));const f=document.getElementById("f");f.textContent=s.slice(0,k);f.dataset.t=s.slice(0,k)}`
  }),
  'type-key': (v) => ({
    css: '.term{position:absolute;inset:0;background:#0c0c0c;color:#ddd;font-family:monospace;padding:12px;white-space:nowrap}',
    html: `<div class="term">${O('$ export AWS_SECRET_ACCESS_KEY=')}<span data-k="key" data-t="" id="f"></span></div>`,
    script: `window.setFrame=(n)=>{const s=${JSON.stringify(v.secret)};const up=Math.min(s.length,Math.floor(n/2));const k=n<80?up:Math.max(0,up-(n-80));const f=document.getElementById("f");f.textContent=s.slice(0,k);f.dataset.t=s.slice(0,k)}`
  }),
  'type-key-enter': (v) => ({
    // A key typed on a full terminal's last line, a character every two frames from frame 4, then Enter
    // at frame 90: two lines of output and a new prompt scroll the terminal up three lines. Keystrokes
    // were recorded: one typing burst, ending at Enter. The key is read only after the scroll, and was
    // covered there back to the burst's start while it was typed a line lower (§5.8, the typing rule).
    css: '.term{position:absolute;inset:0;background:#0c0c0c;color:#ddd;font:14px/20px monospace;padding:0 12px;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;white-space:nowrap}.term div{height:20px;flex:none}',
    html: `<div class="term">${Array.from({ length: 40 }, (_v, i) => `<div>${O(`Compiling module ${i + 1} of 40 (${((i * 37) % 90) + 10} ms)`)}</div>`).join('')}<div>${O('$ export GITHUB_TOKEN=')}<span data-k="key" data-t="" id="f"></span></div>${['Token saved for github.com.', 'Done in 0.4 s.', '$'].map((t, i) => `<div id="o${i}" style="display:none">${O(t)}</div>`).join('')}</div>`,
    script: `window.setFrame=(n)=>{const s=${JSON.stringify(v.token)};const k=n<4?0:Math.min(s.length,Math.floor((n-4)/2)+1);const f=document.getElementById("f");f.textContent=s.slice(0,k);f.dataset.t=s.slice(0,k);for(let i=0;i<3;i++)document.getElementById("o"+i).style.display=n>=90?"block":"none"}`,
    cursor: { typing: [[4, 90]], keys: [[90, 'Enter']] }
  }),
  'paste-after-label': (v) => ({
    // A script in a terminal asks for a token: its prompt, "Personal access token (from the dashboard): ",
    // is printed at 1 s; the token is pasted (Ctrl+V) after it at 6.5 s, and Enter at 8 s prints "OK" and
    // a new prompt. Only the token's own tiles change when it is pasted, the label on screen already: its
    // reads reach to the left for the label that names it (§5.4 point 2), whose hint in parentheses is part
    // of the label (§6.6). The prompt is read alone 5.5 s before, too far to be read with the token even by
    // a plan over its budget, and what Enter prints is short, so no other read takes in the token's line
    // whole. Keystrokes were recorded: the paste, and Enter (a typing burst of its own).
    seconds: 12,
    css: '.term{position:absolute;inset:0;background:#0c0c0c;color:#ddd;font:16px/22px monospace;padding:12px;white-space:nowrap}.term div{height:22px}',
    html: `<div class="term"><div>${O('$ ./deploy.sh production')}</div><div>${O('Deploying build 2.4.1 to production.')}</div><div id="l1" style="visibility:hidden">${O('Personal access token (from the dashboard): ')}<span data-k="key" data-t="" id="k1"></span></div><div id="l2" style="visibility:hidden">${O('OK')}</div><div id="l3" style="visibility:hidden">${O('$')}</div></div>`,
    script: `window.setFrame=(n)=>{const s=${JSON.stringify(v.secret)};const show=(id,on)=>{document.getElementById(id).style.visibility=on?"visible":"hidden"};const f=document.getElementById("k1");const k=n>=390?s:"";f.textContent=k;f.dataset.t=k;show("l1",n>=60);show("l2",n>=483);show("l3",n>=486)}`,
    cursor: { typing: [[480, 480]], keys: [[390, 'Ctrl + V'], [480, 'Enter']] }
  })
}

/** Every planted item's visible box in the page now, in pixels (as make-eval-set.mjs reads its truth). */
function readItems(page, scale) {
  return page.evaluate((px) => {
    const vw = window.innerWidth
    const vh = window.innerHeight
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
    // What is drawn over an item (a toast, a tooltip, a sticky header) hides it there: only the parts on top count.
    const onTop = (el, x, y) => {
      const hit = document.elementFromPoint(x, y)
      return !!hit && (hit === el || el.contains(hit) || hit.contains(el))
    }
    return [...document.querySelectorAll('[data-k]')].flatMap((el, i) => {
      if (el.dataset.k === 'ordinary' || !el.textContent) return []
      const range = document.createRange()
      range.selectNodeContents(el)
      const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5).map((r) => clip(el, r)).filter(Boolean)
      const shown = rects.filter(([x0, y0, x1, y1]) => onTop(el, (x0 + x1) / 2, (y0 + y1) / 2) || onTop(el, x0 + 1, (y0 + y1) / 2) || onTop(el, x1 - 1, (y0 + y1) / 2))
      if (!shown.length) return []
      const xs = shown.flatMap(([a, , c]) => [a, c])
      const ys = shown.flatMap(([, b, , d]) => [b, d])
      const x0 = Math.floor(Math.min(...xs) * px)
      const y0 = Math.floor(Math.min(...ys) * px)
      const x1 = Math.ceil(Math.max(...xs) * px)
      const y1 = Math.ceil(Math.max(...ys) * px)
      return [{ id: `${el.dataset.k}#${i}`, kind: el.dataset.k, text: el.dataset.t, box: [x0, y0, x1 - x0, y1 - y0] }]
    })
  }, scale)
}

async function renderCase(browser, id, out, { seconds, width, height, seed }) {
  const make = CASES[id]
  if (!make) throw new Error(`make-track-fixtures: no case ${id} (${Object.keys(CASES).join(', ')})`)
  const t = THEMES.light
  const { css, html, script, seconds: own, cursor } = make(plantValues(makeTokens(seed)))
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(t)}html,body{margin:0;overflow:hidden}${css}</style></head><body>${html}<script>${script}</script></body></html>`)
  await page.evaluate(() => document.fonts.ready)
  const tmp = mkdtempSync(path.join(os.tmpdir(), `flown-track-${id}-`))
  const frames = []
  try {
    const count = Math.round((own ?? seconds) * FPS)
    for (let n = 0; n < count; n++) {
      await page.evaluate((k) => window.setFrame(k), n)
      const items = await readItems(page, 1)
      frames.push({ n, items: items.map((it) => ({ ...it, on: KINDS[it.kind]?.on ?? true })) })
      await page.screenshot({ path: path.join(tmp, `f${String(n).padStart(5, '0')}.png`), type: 'png', animations: 'disabled', caret: 'hide' })
    }
    const video = path.join(out, `${id}.mp4`)
    execFileSync(ffmpeg(), ['-v', 'error', '-y', '-framerate', String(FPS), '-i', path.join(tmp, 'f%05d.png'), '-c:v', 'libx264rgb', '-qp', '0', '-r', String(FPS), video])
    // A case's cursor.json hints (keystrokes recorded: typing bursts and shortcut keys), in seconds.
    const hints = cursor ? { typing: (cursor.typing ?? []).map(([a, b]) => ({ t: a / FPS, end: b / FPS })), keys: (cursor.keys ?? []).map(([f, label]) => ({ t: f / FPS, label })) } : undefined
    writeFileSync(path.join(out, `${id}.truth.json`), JSON.stringify({ version: 1, case: id, fps: FPS, width, height, seed, frames, ...(hints ? { cursor: hints } : {}) }) + '\n')
    console.log(`${id}: ${count} frames, ${frames.reduce((s, f) => s + f.items.length, 0)} item boxes`)
  } finally {
    await page.close()
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const value = (flag, fallback) => {
    const i = args.indexOf(flag)
    if (i < 0) return fallback
    const v = args[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`make-track-fixtures: ${flag} needs a value`)
    return v
  }
  const flags = ['--case', '--seconds', '--size', '--seed']
  const out = path.resolve(args.find((a, i) => !a.startsWith('--') && !flags.includes(args[i - 1])) ?? 'track-fixtures')
  const only = value('--case', null)
  const seconds = Number(value('--seconds', '2'))
  const [width, height] = value('--size', '1280x720').split('x').map(Number)
  const seed = Number(value('--seed', '7000'))
  if (!(seconds > 0) || !(width > 0) || !(height > 0) || !Number.isInteger(seed)) throw new Error('make-track-fixtures: bad --seconds, --size or --seed')
  mkdirSync(out, { recursive: true })
  const browser = await chromiumType().launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
  try {
    for (const id of only ? [only] : Object.keys(CASES)) await renderCase(browser, id, out, { seconds, width, height, seed })
  } finally {
    await browser.close()
  }
}

// Run as a script (imported, by the tests, it only exports the cases).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
