/**
 * The guide as one HTML file (docs/design/smart-tools.md §5.6, §6): the HTML guide, the
 * click-through demo, the page printed to PDF, and the form *Copy guide* puts on the clipboard.
 *
 * Safety (§16 rule 9): every string of the document is escaped (escapeHtml) and goes only into text
 * or an `alt`, `aria-label`, `title`, `lang` or `dir` attribute; images are `data:` URLs of bytes
 * Flown encoded; the only other URL is the demo's end-screen link, which readLinkUrl accepted. The
 * only script is DEMO_SCRIPT, a constant with no text in it, pinned by its SHA-256 in the page's
 * Content-Security-Policy (`default-src 'none'`); a guide that is not a demo has no script at all,
 * and nothing loads from the network. Positions are numbers Flown computed. The markup is also
 * well-formed XML (void elements closed, attributes quoted), so a strict parser reads it the same.
 * Pure.
 */
import { contrastRatio } from '../captions/colors'
import { readLinkUrl } from '../smart/privateText'
import { calloutPlace, DEMO_NARROW } from './demoLayout'
import type { GuideDoc, GuideImage } from './guideDoc'
import { fill } from './guideWords'

/**
 * The demo's script (§6.1): shows one step at a time, the hotspot and callout of each, Back, Next
 * and Start again, the keys (arrows, Page Up and Down, Home and End), and says the step in the live
 * region. It reads only the page Flown wrote and writes only text it read from it. No `<` or `&`,
 * so the page stays well-formed XML.
 */
export const DEMO_SCRIPT = `(function () {
  var d = document;
  var steps = Array.prototype.slice.call(d.querySelectorAll('li.step'));
  var nav = d.querySelector('.demo-nav');
  if (!steps.length || !nav) return;
  d.documentElement.classList.add('demo');
  var back = nav.querySelector('.back');
  var next = nav.querySelector('.next');
  var again = nav.querySelector('.again');
  var where = nav.querySelector('.where');
  var live = d.querySelector('.live');
  var end = d.querySelector('.end');
  var total = steps.length + (end ? 1 : 0);
  var at = 0;
  var more = Array.prototype.slice.call(d.querySelectorAll('li.step details'));
  more.forEach(function (x) { x.removeAttribute('open'); });
  function text(el, sel) {
    var x = el ? el.querySelector(sel) : null;
    return x ? x.textContent : '';
  }
  function show(i, focus) {
    at = Math.max(0, Math.min(total - 1, i));
    steps.forEach(function (s, k) { s.hidden = k !== at; });
    var step = at === steps.length ? null : steps[at];
    var last = at === total - 1;
    if (end) end.hidden = step !== null;
    back.disabled = at === 0;
    next.hidden = last;
    again.hidden = !last;
    where.textContent = text(step, '.count');
    live.textContent = step ? text(step, '.count') + ': ' + text(step, '.title') : text(end, 'h2');
    if (focus) {
      var spot = step ? step.querySelector('.hotspot') : null;
      (spot || (last ? again : next)).focus();
    }
  }
  back.addEventListener('click', function () { show(at - 1, false); if (back.disabled) next.focus(); });
  next.addEventListener('click', function () { show(at + 1, false); if (next.hidden) again.focus(); });
  again.addEventListener('click', function () { show(0, true); });
  steps.forEach(function (s) {
    var spot = s.querySelector('.hotspot');
    if (spot) spot.addEventListener('click', function () { show(at + 1, true); });
  });
  d.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var k = e.key;
    var to = k === 'ArrowRight' || k === 'PageDown' ? at + 1 : k === 'ArrowLeft' || k === 'PageUp' ? at - 1 : k === 'Home' ? 0 : k === 'End' ? steps.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    show(to, true);
  });
  window.addEventListener('beforeprint', function () { more.forEach(function (x) { x.setAttribute('open', 'open'); }); });
  window.addEventListener('afterprint', function () { more.forEach(function (x) { x.removeAttribute('open'); }); });
  show(0, false);
})();`

/** `sha256-` and the base64 SHA-256 of DEMO_SCRIPT, as the page's CSP names it (test 24 recomputes it). */
export const DEMO_SCRIPT_HASH = 'sha256-JAVx9RFdzRVPfnp08axou5SQkctoo0XzEJ1K69668Lg='

/** The page's colours in each scheme (§5.6): every text pair at least 4.5:1, the hotspot's ring at least 3:1 on the page. */
export const GUIDE_COLOURS = {
  light: { page: '#ffffff', text: '#1b1b1f', muted: '#4f5159', heading: '#1b1b1f', accent: '#0060df', panel: '#f3f4f6', border: '#8a8d96', button: '#0060df', buttonText: '#ffffff' },
  dark: { page: '#141418', text: '#f1f1f4', muted: '#b9bcc6', heading: '#f1f1f4', accent: '#8ab4ff', panel: '#23242a', border: '#80838d', button: '#0060df', buttonText: '#ffffff' }
} as const

/** The screen's font stack; Hind Siliguri is embedded for Bangla text (§5.6, §0 decision 7). */
export const SCREEN_FONTS = '"Segoe UI", "Nirmala UI", "Hind Siliguri", system-ui, sans-serif'
/** The PDF's static fonts (§5.6): Hind Siliguri (embedded) for Latin and Bengali, then Windows' static fonts for other scripts. Never a variable font. */
export const PRINT_FONTS = '"Hind Siliguri", "Segoe UI", "Nirmala UI", "Leelawadee UI", "Yu Gothic UI", "Malgun Gothic", "Microsoft YaHei UI", sans-serif'

/** The family embedded for Bangla text and in the PDF (§0 decision 7). */
export const EMBEDDED_FAMILY = 'Hind Siliguri'

/** Whether any text of `doc` is written in Bengali script. */
export function hasBangla(doc: GuideDoc): boolean {
  const texts = [doc.title, doc.intro ?? '', ...doc.steps.flatMap((s) => [s.title, s.type ?? '', s.text ?? '', s.section ?? '', s.label]), doc.bug?.expected ?? '', doc.bug?.actual ?? '', ...(doc.bug?.details ?? []), doc.end?.heading ?? '', doc.end?.label ?? '']
  return texts.some((t) => /\p{Script=Bengali}/u.test(t))
}

/**
 * The weights of Hind Siliguri a page embeds (§5.6): 400 and 600 for the PDF (its static fonts
 * start with it) and for an HTML guide or demo with Bangla text; none otherwise (and never for the
 * clipboard, whose target app picks its own font).
 */
export function guideFontWeights(doc: GuideDoc, print: boolean): number[] {
  return print || hasBangla(doc) ? [400, 600] : []
}

/** The callout's size the demo is laid out for (CSS px): at most 320 wide (§6.1). */
const CALLOUT = { w: 320, h: 150 }
/** The picture width the callouts' sides are chosen at (CSS px). */
const LAYOUT_WIDTH = 1280

/** `text` safe in HTML text and quoted attributes: `& < > " '` as references, NUL and other controls but tab and line breaks dropped. */
export function escapeHtml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Text with its line breaks as `<br />`. */
const multiline = (text: string): string => escapeHtml(text.replace(/\r\n?/g, '\n')).replace(/[\n\u2028\u2029]/g, '<br />')

/** Base64 of bytes (no Buffer in the renderer). */
function base64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}

const MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])
/** An image as a data URL (only the three image types). */
const dataUrl = (img: GuideImage): string => `data:${MIMES.has(img.mime) ? img.mime : 'image/png'};base64,${base64(img.bytes)}`
const int = (v: number): number => Math.max(1, Math.round(Number.isFinite(v) ? v : 1))
const pct = (v: number): string => `${(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 100).toFixed(4)}%`
const HEX = /^#[0-9a-f]{6}$/i

/** A colour used only where it has `ratio` against `against`, else `fallback`. */
const usable = (colour: string | null | undefined, against: string, ratio: number, fallback: string): string =>
  colour && HEX.test(colour) && contrastRatio(colour, against) >= ratio ? colour.toLowerCase() : fallback

/** The heading and button colours of each scheme with the brand's colour where it reads (§5.6). */
export function guidePalette(brand: string | null | undefined): { light: { heading: string; button: string }; dark: { heading: string; button: string } } {
  const L = GUIDE_COLOURS.light
  const D = GUIDE_COLOURS.dark
  return {
    light: { heading: usable(brand, L.page, 4.5, L.heading), button: usable(brand, L.buttonText, 4.5, L.button) },
    dark: { heading: usable(brand, D.page, 4.5, D.heading), button: usable(brand, D.buttonText, 4.5, D.button) }
  }
}

/** A family name for CSS: letters, digits and spaces only. */
const family = (name: string): string => name.replace(/[^A-Za-z0-9 ]/g, '')

function fontFaces(fonts: readonly { family: string; weight: number; woff2: Uint8Array }[]): string {
  if (!fonts.length) return ''
  const names = [...new Set(fonts.map((f) => family(f.family)))].join(', ')
  const faces = fonts
    .map((f) => `@font-face { font-family: "${family(f.family)}"; font-style: normal; font-weight: ${int(f.weight)}; src: url(data:font/woff2;base64,${base64(f.woff2)}) format("woff2"); }`)
    .join('\n')
  return `/* ${names}: licensed under the SIL Open Font License, Version 1.1. */\n${faces}\n`
}

function styles(doc: GuideDoc, opts: { demo: boolean; print: boolean; fonts: readonly { family: string; weight: number; woff2: Uint8Array }[]; page?: 'A4' | 'Letter' }): string {
  const L = GUIDE_COLOURS.light
  const D = GUIDE_COLOURS.dark
  const brand = guidePalette(doc.brand?.colour)
  const vars = (c: typeof L | typeof D, b: { heading: string; button: string }): string =>
    `--page: ${c.page}; --text: ${c.text}; --muted: ${c.muted}; --heading: ${b.heading}; --accent: ${c.accent}; --panel: ${c.panel}; --border: ${c.border}; --button: ${b.button}; --button-text: ${c.buttonText};`
  const bn = doc.lang === 'bn'
  const pageLabel = bn ? '"পৃষ্ঠা " counter(page, bengali) " / " counter(pages, bengali)' : 'counter(page) " / " counter(pages)'
  const print = opts.print
    ? `@page { size: ${opts.page === 'Letter' ? 'Letter' : 'A4'}; margin: 16mm 14mm; @bottom-center { content: ${pageLabel}; font-size: 9pt; color: #4f5159; } }\n`
    : ''
  return `${fontFaces(opts.fonts)}${print}:root { color-scheme: ${print ? 'light' : 'light dark'}; ${vars(L, brand.light)} }
${print ? '' : `@media (prefers-color-scheme: dark) { :root { ${vars(D, brand.dark)} } }\n`}* { box-sizing: border-box; }
body { margin: 0; padding: ${print ? '0' : '24px 16px 48px'}; background: var(--page); color: var(--text); font-family: ${print ? PRINT_FONTS : SCREEN_FONTS}; font-size: ${print ? '11pt' : '16px'}; line-height: 1.5; }
main, .head, .intro { max-width: ${print ? 'none' : '880px'}; margin: 0 auto; }
.head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.logo { max-height: 48px; width: auto; }
h1, h2 { color: var(--heading); line-height: 1.25; }
h1 { font-size: ${print ? '20pt' : '28px'}; margin: 0; }
h2 { font-size: ${print ? '13pt' : '20px'}; margin: 0 0 8px; }
.intro, .muted { color: var(--muted); }
ol.steps { list-style: none; margin: 24px 0 0; padding: 0; }
li.step { margin: 0 0 32px; break-inside: avoid; }
.num { font-variant-numeric: tabular-nums; }
.type { margin: 0 0 8px; font-weight: 600; }
.note { margin: 8px 0 0; }
figure { margin: 0; }
figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--border); border-radius: 4px; }
.bug h2 { margin-top: 24px; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 4px; }
a { color: var(--accent); }
.hotspot, .demo-nav, .count, .where { display: none; }
.live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
${opts.demo ? demoStyles() : ''}@media print { li.step, figure, .bug { break-inside: avoid; } .demo-nav, .live, .hotspot { display: none !important; } }
`
}

function demoStyles(): string {
  return `.demo body { padding-top: 16px; }
.demo li.step[hidden], .demo .end[hidden] { display: none; }
.demo .frame { position: relative; max-width: 1600px; margin: 0 auto; }
.demo main { max-width: 1600px; }
.demo figure { position: relative; }
.demo figure img { width: 100%; }
.demo .hotspot { display: block; position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; padding: 0; border-radius: 50%; border: 4px solid var(--button); background: transparent; box-shadow: 0 0 0 3px #ffffff; cursor: pointer; animation: pulse 1.2s ease-out 3; }
@keyframes pulse { 0% { box-shadow: 0 0 0 3px #ffffff, 0 0 0 3px rgba(0, 96, 223, 0.55); } 100% { box-shadow: 0 0 0 3px #ffffff, 0 0 0 18px rgba(0, 96, 223, 0); } }
@media (prefers-reduced-motion: reduce) { .demo .hotspot { animation: none; } }
.demo .callout { position: absolute; width: 320px; max-width: calc(100% - 32px); padding: 12px 14px; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25); z-index: 1; }
.demo .callout h2 { font-size: 18px; }
.demo .callout::before { content: ""; position: absolute; width: 0; height: 0; border: 10px solid transparent; }
.demo .callout[data-side="right"]::before { left: -20px; top: 18px; border-right-color: var(--border); }
.demo .callout[data-side="left"]::before { right: -20px; top: 18px; border-left-color: var(--border); }
.demo .callout[data-side="below"]::before { top: -20px; left: 18px; border-bottom-color: var(--border); }
.demo .callout[data-side="above"]::before { bottom: -20px; left: 18px; border-top-color: var(--border); }
.demo .callout[data-side="corner"]::before { display: none; }
.demo summary { cursor: pointer; color: var(--accent); }
.demo .count { display: block; color: var(--muted); }
.demo .demo-nav { display: flex; gap: 12px; align-items: center; justify-content: center; margin: 16px auto; }
.demo .where { display: inline; color: var(--muted); min-width: 8em; text-align: center; }
.demo .demo-nav button, .demo .end-link { min-height: 44px; min-width: 44px; padding: 8px 18px; border: 0; border-radius: 6px; background: var(--button); color: var(--button-text); font: inherit; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
.demo .demo-nav button[disabled] { opacity: 0.5; cursor: default; }
.demo .demo-nav button[hidden] { display: none; }
.demo .end { text-align: center; padding: 48px 16px; }
.end-link { display: inline-block; }
@media (max-width: ${DEMO_NARROW - 0.02}px) { .demo .callout { position: static; width: auto; max-width: none; margin-top: 12px; box-shadow: none; } .demo .callout::before { display: none; } }
@media print { .demo li.step[hidden], .demo .end[hidden] { display: block !important; } .demo .callout { position: static !important; width: auto; box-shadow: none; } .demo .callout::before, .count { display: none !important; } }
`
}

/** The callout's style for a step's hotspot (§6.1): its side chosen at the layout width, anchored to the hotspot in percent and offset in CSS pixels. */
function calloutStyle(hotspot: { x: number; y: number } | undefined, image: GuideImage | null): { side: string; style: string } {
  const w = Math.min(LAYOUT_WIDTH, image ? image.width : LAYOUT_WIDTH)
  const h = image ? (w * image.height) / image.width : w * 0.5625
  const place = calloutPlace(hotspot ? { x: hotspot.x * w, y: hotspot.y * h } : null, { w, h }, CALLOUT)
  const off = 22 + 16
  const top = pct(place.y / h)
  switch (place.side) {
    case 'right':
      return { side: 'right', style: `left: calc(${pct(hotspot!.x)} + ${off}px); top: ${top};` }
    case 'left':
      return { side: 'left', style: `right: calc(${pct(1 - hotspot!.x)} + ${off}px); top: ${top};` }
    case 'below':
      return { side: 'below', style: `left: ${pct(place.x / w)}; top: calc(${pct(hotspot!.y)} + ${off}px);` }
    case 'above':
      return { side: 'above', style: `left: ${pct(place.x / w)}; bottom: calc(${pct(1 - hotspot!.y)} + ${off}px);` }
    default:
      return { side: 'corner', style: 'left: 16px; top: 16px;' }
  }
}

/** One step: a guide's (title, Type, picture, note) or a demo's (picture with its hotspot and callout). */
function stepHtml(doc: GuideDoc, s: GuideDoc['steps'][number], i: number, demo: boolean, headingLevel: 2 | 3): string {
  const w = doc.words
  const h = `h${headingLevel}`
  const title = `<${h} class="step-title" dir="auto"><span class="num">${escapeHtml(s.n)}.</span> <span class="title">${escapeHtml(s.title)}</span></${h}>`
  const type = s.type ? `<p class="type" dir="auto">${escapeHtml(fill(w.typeLine, { text: s.type }))}</p>` : ''
  const note = s.text ? `<p class="note" dir="auto">${multiline(s.text)}</p>` : ''
  const img = s.image ? `<img src="${dataUrl(s.image)}" alt="${escapeHtml(s.alt)}" width="${int(s.image.width)}" height="${int(s.image.height)}" />` : ''
  const section = s.section ? `<h2 class="section" dir="auto">${escapeHtml(s.section)}</h2>` : ''
  if (!demo) return `<li class="step" id="step-${i + 1}">${section}${title}${type}${img ? `<figure>${img}</figure>` : ''}${note}</li>`
  const hotspot =
    s.hotspot && s.image
      ? `<button type="button" class="hotspot" aria-label="${escapeHtml(fill(w.hotspot, { title: s.title }))}" style="left: ${pct(s.hotspot.x)}; top: ${pct(s.hotspot.y)};"></button>`
      : ''
  const call = calloutStyle(s.image ? s.hotspot : undefined, s.image)
  const count = `<p class="count" dir="auto">${escapeHtml(fill(w.stepOf, { n: s.n, m: doc.steps[doc.steps.length - 1]?.n ?? s.n }))}</p>`
  const more = type || note ? `<details class="more" open="open"><summary>${escapeHtml(w.more)}</summary>${type}${note}</details>` : ''
  return `<li class="step" id="step-${i + 1}">${section}<div class="frame">${img ? `<figure>${img}${hotspot}</figure>` : ''}<div class="callout" dir="auto" data-side="${call.side}" style="${call.style}">${count}${title}${more}</div></div></li>`
}

/** The bug report's parts after the steps: Expected, Actual (with its screenshot) and Details. */
function bugHtml(doc: GuideDoc): string {
  const b = doc.bug!
  const w = doc.words
  const img = b.actualImage ? `<figure><img src="${dataUrl(b.actualImage)}" alt="${escapeHtml(w.actual)}" width="${int(b.actualImage.width)}" height="${int(b.actualImage.height)}" /></figure>` : ''
  const details = b.details.length ? `<h2>${escapeHtml(w.details)}</h2><ul>${b.details.map((d) => `<li dir="auto">${escapeHtml(d)}</li>`).join('')}</ul>` : ''
  return `<section class="bug"><h2>${escapeHtml(w.expected)}</h2><p dir="auto">${multiline(b.expected)}</p><h2>${escapeHtml(w.actual)}</h2><p dir="auto">${multiline(b.actual)}</p>${img}${details}</section>`
}

/** The demo's end screen (§6.1): its heading and, with a link readLinkUrl accepts, one button-styled link. */
function endHtml(doc: GuideDoc): string {
  const end = doc.end
  if (!end?.heading?.trim()) return ''
  const url = end.url ? readLinkUrl(end.url) : null
  const link = url && end.label?.trim() ? `<p><a class="end-link" href="${escapeHtml(url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(end.label)}</a></p>` : ''
  return `<section class="end" hidden="hidden"><h2 dir="auto">${escapeHtml(end.heading)}</h2>${link}</section>`
}

/** The clipboard's form of the guide (§5.8): no script, no fonts, styles inline, PNG pictures. */
function clipboardHtml(doc: GuideDoc): string {
  const w = doc.words
  const img = (i: GuideImage, alt: string): string =>
    `<p><img src="${dataUrl(i)}" alt="${escapeHtml(alt)}" width="${int(i.width)}" height="${int(i.height)}" style="max-width: 100%; height: auto;" /></p>`
  const steps = doc.steps
    .map(
      (s) =>
        `<li>${s.section ? `<h2 dir="auto">${escapeHtml(s.section)}</h2>` : ''}<h3 dir="auto" style="margin: 16px 0 4px;">${escapeHtml(s.title)}</h3>` +
        `${s.type ? `<p dir="auto"><b>${escapeHtml(fill(w.typeLine, { text: s.type }))}</b></p>` : ''}${s.image ? img(s.image, s.alt) : ''}${s.text ? `<p dir="auto">${multiline(s.text)}</p>` : ''}</li>`
    )
    .join('')
  const bug = doc.bug
    ? `<h2>${escapeHtml(w.expected)}</h2><p dir="auto">${multiline(doc.bug.expected)}</p><h2>${escapeHtml(w.actual)}</h2><p dir="auto">${multiline(doc.bug.actual)}</p>` +
      `${doc.bug.actualImage ? img(doc.bug.actualImage, w.actual) : ''}${doc.bug.details.length ? `<h2>${escapeHtml(w.details)}</h2><ul>${doc.bug.details.map((d) => `<li dir="auto">${escapeHtml(d)}</li>`).join('')}</ul>` : ''}`
    : ''
  return (
    `<!DOCTYPE html>\n<html lang="${escapeHtml(doc.lang)}"><head><meta charset="utf-8" /><title>${escapeHtml(doc.title)}</title></head>` +
    `<body style="font-family: ${SCREEN_FONTS.replace(/"/g, '&quot;')};"><h1 dir="auto">${escapeHtml(doc.title)}</h1>${doc.intro ? `<p dir="auto">${multiline(doc.intro)}</p>` : ''}` +
    `${doc.bug ? `<h2>${escapeHtml(w.stepsToReproduce)}</h2>` : ''}<ol>${steps}</ol>${bug}</body></html>\n`
  )
}

/**
 * The guide's HTML (§5.6): with `demo`, the click-through demo (§6.1) and its pinned script; with
 * `print`, the page printed to PDF (no script, the PDF's static fonts, page numbers, `page` size);
 * with `clipboard`, the form *Copy guide* puts on the clipboard (no script, no fonts). `fonts` are
 * embedded as WOFF2 data URLs (Hind Siliguri for Bangla text, §0 decision 7).
 */
export function guideHtml(doc: GuideDoc, opts: { demo: boolean; print: boolean; clipboard?: boolean; fonts: readonly { family: string; weight: number; woff2: Uint8Array }[]; page?: 'A4' | 'Letter' }): string {
  if (opts.clipboard) return clipboardHtml(doc)
  const demo = opts.demo && !opts.print
  const w = doc.words
  const csp = `default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; ${demo ? `script-src '${DEMO_SCRIPT_HASH}'; ` : ''}base-uri 'none'; form-action 'none'`
  const sections = doc.steps.some((s) => s.section)
  const logo = doc.brand?.logo ? `<img class="logo" src="${dataUrl(doc.brand.logo)}" alt="" width="${int(doc.brand.logo.width)}" height="${int(doc.brand.logo.height)}" />` : ''
  const steps = doc.steps.map((s, i) => stepHtml(doc, s, i, demo, sections && !demo ? 3 : 2)).join('\n')
  const nav = demo
    ? `<nav class="demo-nav"><button type="button" class="back">${escapeHtml(w.back)}</button><span class="where" aria-hidden="true"></span><button type="button" class="next">${escapeHtml(w.next)}</button><button type="button" class="again" hidden="hidden">${escapeHtml(w.startAgain)}</button></nav>\n<div class="live" role="status" aria-live="polite" aria-atomic="true"></div>\n`
    : ''
  return `<!DOCTYPE html>
<html lang="${escapeHtml(doc.lang)}">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="referrer" content="no-referrer" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(doc.title)}</title>
<style>
${styles(doc, { ...opts, demo })}</style>
</head>
<body>
<header class="head">${logo}<h1 dir="auto">${escapeHtml(doc.title)}</h1></header>
${doc.intro ? `<p class="intro" dir="auto">${multiline(doc.intro)}</p>\n` : ''}<main>
${doc.bug ? `<h2>${escapeHtml(w.stepsToReproduce)}</h2>\n` : ''}<ol class="steps">
${steps}
</ol>
${doc.bug ? `${bugHtml(doc)}\n` : ''}${demo ? `${endHtml(doc)}\n` : ''}</main>
${nav}${demo ? `<script>${DEMO_SCRIPT}</script>\n` : ''}</body>
</html>
`
}

/** The guide as plain text (§5.8): the title, the intro, the numbered titles with their *Type* lines and notes, and a bug report's parts. */
export function guideText(doc: GuideDoc): string {
  const w = doc.words
  const out: string[] = [doc.title, '']
  if (doc.intro) out.push(doc.intro, '')
  if (doc.bug) out.push(w.stepsToReproduce, '')
  for (const s of doc.steps) {
    if (s.section) out.push(s.section, '')
    out.push(`${s.n}. ${s.title}`)
    if (s.type) out.push(fill(w.typeLine, { text: s.type }))
    if (s.text) out.push(s.text)
    out.push('')
  }
  if (doc.bug) {
    out.push(w.expected, doc.bug.expected, '', w.actual, doc.bug.actual, '')
    if (doc.bug.details.length) out.push(w.details, ...doc.bug.details.map((d) => `- ${d}`), '')
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}
