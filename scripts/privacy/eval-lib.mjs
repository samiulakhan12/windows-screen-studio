// Shared pieces of the privacy evaluation set (make-eval-set.mjs): a seeded generator of
// realistic private items (key and token shapes from gitleaks' rules, Luhn-valid card numbers,
// mod-97-valid IBANs, phone numbers from ranges set aside for fiction where a region has one),
// the markers that turn an item into truth, and the shared window chrome and themes.
//
// Every planted item is wrapped in <span data-k="KIND" data-t="TEXT">; make-eval-set.mjs reads the
// span's rendered rectangles back from the page. KIND is one of KINDS below. "ordinary" marks
// text that looks close to private but must not be hidden.

/** What Find covers by default (§0 decision 2) and what it leaves alone. */
export const KINDS = {
  password: { on: true }, // a labelled password, PIN, passphrase or the password part of a URL
  code: { on: true }, // a one-time, verification, recovery or backup code, a CVC
  qr: { on: true }, // a QR code (class secret or other)
  key: { on: true }, // an API key or token (prefix or strong label)
  jwt: { on: true },
  privateKey: { on: true }, // a private key header, body line or footer
  linkToken: { on: true }, // a token in a link or a webhook path
  email: { on: true },
  card: { on: true },
  iban: { on: true },
  phone: { on: true },
  id: { on: true }, // a labelled ID number, SSN, NI number, passport number
  name: { on: true }, // a name the user listed
  address: { on: false },
  dots: { on: false }, // password dots
  randomString: { on: false }, // an unlabelled random-looking string
  ordinary: { on: false } // must never be hidden
}

/** The names the user listed (Settings > Private info > Names to cover). */
export const LISTED_NAMES = ['Priya Raman', 'Tomasz Kowalczyk', 'Aisha Rahman', 'Jordan Ellis', 'Mei Lin Chen']

export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LO = 'abcdefghijklmnopqrstuvwxyz'
const DIG = '0123456789'
const ALNUM = UP + LO + DIG
const HEX = '0123456789abcdef'
const B64 = ALNUM + '+/'
const B64URL = ALNUM + '-_'

export function makeTokens(seed) {
  const r = mulberry32(seed)
  const pick = (alpha, n) => Array.from({ length: n }, () => alpha[Math.floor(r() * alpha.length)]).join('')
  const digits = (n) => pick(DIG, n)
  const b64url = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  const luhn = (body) => {
    let sum = 0
    const ds = body.split('').reverse().map(Number)
    for (let i = 0; i < ds.length; i++) {
      let d = ds[i]
      if (i % 2 === 0) {
        d *= 2
        if (d > 9) d -= 9
      }
      sum += d
    }
    return String((10 - (sum % 10)) % 10)
  }
  const card = (prefix, len) => {
    const body = prefix + digits(len - prefix.length - 1)
    return body + luhn(body)
  }
  const group = (s, sizes, sep = ' ') => {
    const out = []
    let i = 0
    for (const n of sizes) {
      out.push(s.slice(i, i + n))
      i += n
    }
    if (i < s.length) out.push(s.slice(i))
    return out.join(sep)
  }
  const iban = (country, bban) => {
    const moved = (bban + country + '00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
    let mod = 0
    for (const ch of moved) mod = (mod * 10 + Number(ch)) % 97
    const check = String(98 - mod).padStart(2, '0')
    return (country + check + bban).replace(/(.{4})/g, '$1 ').trim()
  }
  const jwt = (claims) => `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${b64url(JSON.stringify(claims))}.${pick(B64URL, 43)}`
  return {
    pick,
    digits,
    aws: () => 'AKIA' + pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16),
    awsSecret: () => pick(ALNUM + '/+', 40),
    ghp: () => 'ghp_' + pick(ALNUM, 36),
    ghpat: () => 'github_pat_11' + pick(UP + DIG, 20) + '_' + pick(ALNUM, 59),
    glpat: () => 'glpat-' + pick(ALNUM + '-_', 20),
    xoxb: () => `xoxb-${digits(12)}-${digits(13)}-${pick(ALNUM, 24)}`,
    xoxp: () => `xoxp-${digits(12)}-${digits(12)}-${digits(13)}-${pick(HEX, 32)}`,
    slackHookPath: () => `T${pick(UP + DIG, 8)}/B${pick(UP + DIG, 10)}/${pick(ALNUM, 24)}`,
    discordHookPath: () => `${digits(19)}/${pick(B64URL, 68)}`,
    openai: () => 'sk-proj-' + pick(B64URL, 58) + 'T3BlbkFJ' + pick(B64URL, 58),
    stripeLive: () => 'sk_live_51' + pick(ALNUM, 40),
    stripeRestricted: () => 'rk_live_51' + pick(ALNUM, 40),
    stripeTest: () => 'sk_test_51' + pick(ALNUM, 40),
    stripePublishable: () => 'pk_live_51' + pick(ALNUM, 40),
    whsec: () => 'whsec_' + pick(ALNUM, 32),
    gcp: () => 'AIza' + pick(ALNUM + '-_', 35),
    sendgrid: () => 'SG.' + pick(B64URL, 22) + '.' + pick(B64URL, 43),
    npm: () => 'npm_' + pick(ALNUM, 36),
    shopify: () => 'shpat_' + pick(HEX, 32),
    hf: () => 'hf_' + pick(UP + LO, 34),
    pypi: () => 'pypi-AgEIcHlwaS5vcmc' + pick(B64URL, 60),
    twilio: () => 'SK' + pick(HEX, 32),
    azureSecret: () => pick(ALNUM, 3) + digits(1) + 'Q~' + pick(ALNUM + '_~.-', 32),
    hex: (n) => pick(HEX, n),
    b64: (n) => pick(B64, n),
    alnum: (n) => pick(ALNUM, n),
    upnum: (n) => pick(UP + DIG, n),
    jwt,
    pemBody: () => pick(B64, 64),
    visa: () => group(card('4', 16), [4, 4, 4, 4]),
    mastercard: (sep = ' ') => group(card('5' + '12345'[Math.floor(r() * 5)], 16), [4, 4, 4, 4], sep),
    amex: () => group(card('37', 15), [4, 6, 5]),
    discover: () => group(card('6011', 16), [4, 4, 4, 4]),
    cardPlain: () => card('4', 16),
    ibanGB: () => iban('GB', 'NWBK' + digits(6) + digits(8)),
    ibanDE: () => iban('DE', digits(8) + digits(10)),
    ibanFR: () => iban('FR', digits(5) + digits(5) + pick(UP + DIG, 11) + digits(2)),
    ibanNL: () => iban('NL', 'ABNA' + digits(10)),
    luhn
  }
}

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A planted item: `kind` must be in KINDS. `extra` adds attributes (region, qrClass). */
export function P(kind, text, extra = {}) {
  if (!KINDS[kind]) throw new Error(`unknown kind ${kind}`)
  const attrs = Object.entries(extra)
    .map(([k, v]) => ` data-${k}="${esc(v)}"`)
    .join('')
  return `<span data-k="${kind}" data-t="${esc(text)}"${attrs}>${esc(text)}</span>`
}
/** Ordinary text that must not be hidden. */
export const O = (text) => P('ordinary', text)

/** A QR code drawn from eval-qr.json, as an SVG marked with kind qr. */
export function QR(qrs, key, px, theme = 'light') {
  const q = qrs[key]
  const n = q.rows.length
  const quiet = 4
  const size = n + quiet * 2
  let rects = ''
  q.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '1') rects += `<rect x="${x + quiet}" y="${y + quiet}" width="1" height="1"/>`
  })
  // A QR is always dark on light, even in a dark theme (as apps draw them).
  return `<svg data-k="qr" data-t="${esc(q.data)}" data-qrclass="${q.class}" data-inset="${quiet / size}" width="${px}" height="${px}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" style="background:#fff;display:block"><g fill="#000">${rects}</g></svg>`
}

export const THEMES = {
  dark: {
    bg: '#1e1e1e', panel: '#252526', panel2: '#2d2d30', border: '#3c3c3c', text: '#d4d4d4', dim: '#9d9d9d', accent: '#3794ff',
    key: '#9cdcfe', str: '#ce9178', com: '#6a9955', kw: '#569cd6', num: '#b5cea8', sel: '#264f78', hit: '#613214', card: '#2b2b2b', input: '#3c3c3c', danger: '#f48771'
  },
  light: {
    bg: '#ffffff', panel: '#f3f3f3', panel2: '#e8e8e8', border: '#d4d4d4', text: '#1f1f1f', dim: '#6e6e6e', accent: '#005fb8',
    key: '#0451a5', str: '#a31515', com: '#008000', kw: '#0000ff', num: '#098658', sel: '#add6ff', hit: '#f8c33a', card: '#ffffff', input: '#ffffff', danger: '#c72e0f'
  }
}

export function baseCss(t, ui = 'Inter', size = 14) {
  return `
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:100%;height:100%;overflow:hidden;background:${t.bg};color:${t.text};font-family:'${ui}',sans-serif;font-size:${size}px;line-height:1.45}
  ::selection{background:${t.sel};color:inherit}
  .row{display:flex}.col{display:flex;flex-direction:column}.grow{flex:1;min-width:0}
  .dim{color:${t.dim}}.b{font-weight:600}.mono{font-family:'JetBrains Mono',monospace}
  .titlebar{height:32px;background:${t.panel2};display:flex;align-items:center;padding:0 12px;gap:12px;font-size:12px;color:${t.dim};border-bottom:1px solid ${t.border}}
  .titlebar .ctl{margin-left:auto;display:flex;gap:22px;letter-spacing:2px}
  .browser-tabs{height:38px;background:${t.panel2};display:flex;align-items:flex-end;padding:0 8px;gap:2px}
  .tab{background:${t.panel};padding:7px 16px;border-radius:8px 8px 0 0;font-size:12px;max-width:240px;white-space:nowrap;overflow:hidden}
  .tab.on{background:${t.bg}}
  .urlbar{height:40px;display:flex;align-items:center;gap:10px;padding:0 12px;background:${t.bg};border-bottom:1px solid ${t.border}}
  .url{flex:1;background:${t.panel};border-radius:16px;padding:6px 14px;font-size:13px;white-space:nowrap;overflow:hidden}
  .taskbar{position:absolute;left:0;right:0;bottom:0;height:40px;background:${t === THEMES.dark ? '#202020' : '#eef1f6'};border-top:1px solid ${t.border};display:flex;align-items:center;justify-content:center;gap:14px;font-size:12px}
  .taskbar .clock{position:absolute;right:14px;text-align:right;line-height:1.3}
  .taskbar .ico{width:24px;height:24px;border-radius:5px;background:${t.accent};opacity:.85}
  .toast{position:absolute;right:16px;bottom:56px;width:364px;background:${t === THEMES.dark ? '#2b2b2b' : '#f9f9f9'};border:1px solid ${t.border};border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35);padding:14px 16px;font-size:13px}
  .toast .app{font-size:12px;color:${t.dim};margin-bottom:6px;display:flex;gap:8px;align-items:center}
  .toast .app i{width:16px;height:16px;border-radius:4px;background:${t.accent};display:inline-block}
  table{border-collapse:collapse;width:100%}
  th{text-align:left;font-weight:600;color:${t.dim};font-size:12px;padding:8px 12px;border-bottom:1px solid ${t.border}}
  td{padding:8px 12px;border-bottom:1px solid ${t.border};white-space:nowrap}
  .card{background:${t.card};border:1px solid ${t.border};border-radius:8px;padding:16px 18px}
  .btn{display:inline-block;background:${t.accent};color:#fff;border-radius:6px;padding:6px 14px;font-size:13px}
  .btn2{display:inline-block;border:1px solid ${t.border};border-radius:6px;padding:5px 12px;font-size:13px}
  .field{background:${t.input};border:1px solid ${t.border};border-radius:6px;padding:7px 10px;min-height:34px}
  .label{font-size:12px;color:${t.dim};margin:12px 0 4px}
  `
}

export const browserChrome = (t, tabs, url, active = 0) => `
  <div class="browser-tabs">${tabs.map((x, i) => `<div class="tab${i === active ? ' on' : ''}">${x}</div>`).join('')}</div>
  <div class="urlbar"><span class="dim">&#8592; &#8594; &#8635;</span><div class="url">${url}</div><span class="dim">&#9734; &#8942;</span></div>`

export const taskbar = (time, date) => `<div class="taskbar"><span class="ico"></span><span class="ico" style="opacity:.6"></span><span class="ico" style="opacity:.45"></span><span class="ico" style="opacity:.3"></span><div class="clock">${O(time)}<br>${O(date)}</div></div>`

export const toast = (app, title, bodyHtml) => `<div class="toast"><div class="app"><i></i>${app}</div><div class="b" style="margin-bottom:4px">${title}</div><div>${bodyHtml}</div></div>`
