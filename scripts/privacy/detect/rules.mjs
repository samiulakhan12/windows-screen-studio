// Prototype of the detection rules written in ../rules.md. Research evidence only (not product code):
// it checks that the rules and vectors agree and measures false hits on ordinary text.
// Pure functions; data (TLD list, phone metadata JSON) is passed in by the caller.
import fs from 'node:fs'

/* ================= data loaders (read files as data) ================= */

export function loadTlds(tldsTsPath) {
  const src = fs.readFileSync(tldsTsPath, 'utf8')
  const set = new Set()
  for (const name of ['X_GENERIC_TLDS', 'X_COUNTRY_TLDS']) {
    const i = src.indexOf('export const ' + name)
    const j = src.indexOf('\n\n', i)
    for (const m of src.slice(i, j).matchAll(/'([^']*)'/g)) for (const t of m[1].split('|')) if (t) set.add(t.toLowerCase())
  }
  return set
}

export function loadPhoneMeta(maxJsonPath) {
  const mx = JSON.parse(fs.readFileSync(maxJsonPath, 'utf8'))
  const regions = {}
  for (const [cc, e] of Object.entries(mx.countries)) {
    const types = Array.isArray(e[11]) ? e[11] : []
    const fixed = Array.isArray(types[0]) && types[0][0] ? types[0][0] : null
    const pats = types.filter((t) => Array.isArray(t) && t[0]).map((t) => t[0])
    const mobileSrc = Array.isArray(types[1]) && types[1][0] ? types[1][0] : null // '' = same as fixed line: mobiles cannot be told apart
    regions[cc] = {
      code: e[0],
      general: new RegExp('^(?:' + e[2] + ')$'),
      lengths: new Set(e[3]),
      natPrefix: typeof e[5] === 'string' ? e[5] : null,
      valid: pats.length ? new RegExp('^(?:' + pats.join('|') + ')$') : null,
      mobile: mobileSrc ? new RegExp('^(?:' + mobileSrc + ')$') : null,
      formats: (e[4] || []).map((f) => ({ re: new RegExp('^(?:' + f[0] + ')$'), lead: (f[2] || []).length ? new RegExp('^(?:' + f[2][f[2].length - 1] + ')') : null }))
    }
  }
  return { regions, callingCodes: mx.country_calling_codes }
}

/* ================= text cleaning with an index map ================= */

const DASHES = /[‐-―−﹘﹣－]/
const DOTS = /[•●∙⦁⚫⬤‧・●⭘]/
const ZW = /[​-‍⁠﻿­]/

/** OCR output for Latin text: slashed and dotted zeros, the multiplication sign, Greek and Cyrillic lookalikes. */
const LOOKALIKE = { 'θ': '0', 'Θ': '0', 'ø': '0', 'Ø': '0', '⊘': '0', '×': 'x', 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X', 'ο': 'o', 'ν': 'v', 'ρ': 'p' }
/** Whether the word around raw[i] holds an ASCII letter or digit (lookalikes are mapped only inside Latin tokens). */
const latinNear = (raw, i) => { let a = i; let b = i; while (a > 0 && !/\s/.test(raw[a - 1])) a--; while (b < raw.length && !/\s/.test(raw[b])) b++; return /[A-Za-z0-9]/.test(raw.slice(a, b)) }
/** NFKC per character, dashes to '-', bullet-like dots to '•', zero-width removed, spaces to ' '. map[i] = raw index of t[i]. */
export function clean(raw) {
  let t = ''
  const map = []
  for (let i = 0; i < raw.length; ) {
    const cp = raw.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    let out = ch
    if (DASHES.test(ch)) out = '-'
    else if (DOTS.test(ch)) out = '•'
    else if (ZW.test(ch)) out = ''
    else if (/\s/u.test(ch)) out = ' '
    else if (LOOKALIKE[ch] !== undefined && latinNear(raw, i)) out = LOOKALIKE[ch]
    else out = ch.normalize('NFKC')
    for (const c of out) {
      t += c
      map.push(i)
    }
    i += ch.length
  }
  return { t, map }
}

/* ================= helpers ================= */

const BN_DIGITS = /[০-৯]/g
const DV_DIGITS = /[०-९]/g
export const asciiDigits = (s) => s.replace(BN_DIGITS, (c) => String(c.charCodeAt(0) - 0x9e6)).replace(DV_DIGITS, (c) => String(c.charCodeAt(0) - 0x966))

/** OCR confusions read as digits inside a group that is mostly digits. */
const TO_DIGIT = { O: '0', o: '0', D: '0', Q: '0', l: '1', I: '1', '|': '1', i: '1', '!': '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6', b: '6', g: '9', q: '9', T: '7' }
const CONFUSABLE = /[OoDQlI|i!SsBZzGbgqT]/

/**
 * The digit view of a line: within each group (split by spaces, dashes, dots, slashes, parentheses) that has
 * at least 3 real digits and at most 1 confusable letter per 4 characters, confusable letters become digits.
 * Same length as the input, so spans map one to one.
 */
export function digitView(t) {
  // A run is groups of digits and confusable letters joined by one or two separators. In a run with at least
  // 6 real digits and at most one confusable per 5 characters, the confusables of groups holding a real digit
  // become digits.
  return asciiDigits(t).replace(/(?<![A-Za-z])[0-9OoDQlI|i!SsBZzGbgqT]+(?:[ .\/()-]{1,2}[0-9OoDQlI|i!SsBZzGbgqT]+)*(?![A-Za-z])/g, (run) => {
    const real = (run.match(/[0-9]/g) || []).length
    const conf = (run.match(CONFUSABLE_G) || []).length
    if (real < 6 || conf === 0 || conf > Math.max(1, Math.floor(run.replace(/[ .\/()-]/g, '').length / 5))) return run
    return run.replace(/[0-9OoDQlI|i!SsBZzGbgqT]+/g, (g) => (/[0-9]/.test(g) ? [...g].map((c) => TO_DIGIT[c] ?? c).join('') : g))
  })
}
const CONFUSABLE_G = /[OoDQlI|i!SsBZzGbgqT]/g

export function luhn(digits) {
  let sum = 0
  let dbl = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (dbl) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    dbl = !dbl
  }
  return sum % 10 === 0
}

export function entropy(s) {
  const f = new Map()
  for (const c of s) f.set(c, (f.get(c) || 0) + 1)
  let h = 0
  for (const n of f.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

export function mod97(iban) {
  const r = iban.slice(4) + iban.slice(0, 4)
  let rem = 0
  for (const c of r) {
    const v = /[0-9]/.test(c) ? c : String(c.charCodeAt(0) - 55)
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97
  }
  return rem
}

/* ================= tables ================= */

/** Major card networks: [prefix from, prefix to (same length), allowed lengths]. Wikipedia "Payment card number". */
export const IIN = [
  ['4', '4', [13, 16, 19], 'visa'],
  ['51', '55', [16], 'mastercard'],
  ['2221', '2720', [16], 'mastercard'],
  ['34', '34', [15], 'amex'],
  ['37', '37', [15], 'amex'],
  ['6011', '6011', [16, 17, 18, 19], 'discover'],
  ['644', '649', [16, 17, 18, 19], 'discover'],
  ['65', '65', [16, 17, 18, 19], 'discover'],
  ['300', '305', [14, 15, 16, 17, 18, 19], 'diners'],
  ['36', '36', [14, 15, 16, 17, 18, 19], 'diners'],
  ['38', '39', [14, 15, 16, 17, 18, 19], 'diners'],
  ['3528', '3589', [16, 17, 18, 19], 'jcb'],
  ['62', '62', [16, 17, 18, 19], 'unionpay'],
  ['5018', '5018', [12, 13, 14, 15, 16, 17, 18, 19], 'maestro'],
  ['5020', '5020', [12, 13, 14, 15, 16, 17, 18, 19], 'maestro'],
  ['5038', '5038', [12, 13, 14, 15, 16, 17, 18, 19], 'maestro'],
  ['5893', '5893', [12, 13, 14, 15, 16, 17, 18, 19], 'maestro'],
  ['6304', '6304', [12, 13, 14, 15, 16, 17, 18, 19], 'maestro'],
  ['6759', '6759', [12, 13, 14, 15, 16, 17, 18, 19], 'maestro'],
  ['6761', '6763', [12, 13, 14, 15, 16, 17, 18, 19], 'maestro'],
  ['2200', '2204', [16, 17, 18, 19], 'mir'],
  ['60', '60', [16], 'rupay'],
  ['508', '508', [16], 'rupay'],
  ['81', '82', [16], 'rupay'],
  ['506099', '506198', [16, 18, 19], 'verve'],
  ['507865', '507964', [16, 18, 19], 'verve'],
  ['650002', '650027', [16, 18, 19], 'verve'],
  ['9792', '9792', [16], 'troy'],
  ['5019', '5019', [16], 'dankort'],
  ['636', '636', [16, 17, 18, 19], 'interpayment'],
  ['637', '639', [16], 'instapayment'],
  ['8600', '8600', [16], 'uzcard'],
  ['9860', '9860', [16], 'humo'],
  ['9704', '9704', [16, 19], 'napas'],
  ['1', '1', [15], 'uatp']
]
export function cardNetwork(d) {
  for (const [from, to, lens, name] of IIN) {
    const p = d.slice(0, from.length)
    if (p >= from && p <= to && lens.includes(d.length)) return name
  }
  return null
}

/** IBAN lengths, SWIFT registry countries (Wikipedia "International Bank Account Number"). */
export const IBAN_LEN = Object.fromEntries(
  'AL28 AD24 AT20 AZ28 BH22 BY28 BE16 BA20 BR29 BG22 BI27 CR22 HR21 CY28 CZ24 DK18 DJ27 DO28 TL23 EG29 SV28 EE20 FK18 FO18 FI18 FR27 GE22 DE22 GI23 GR27 GL18 GT28 HN28 HU28 IS26 IQ23 IE22 IL23 IT27 JO30 KZ20 XK20 KW30 LV21 LB28 LY25 LI21 LT20 LU20 MT31 MR27 MU30 MC27 MD24 MN20 ME22 NL18 NI28 MK19 NO15 OM23 PK24 PS29 PL28 PT25 QA29 RO24 RU33 LC32 SM27 ST25 SA24 RS22 SC31 SK24 SI19 SO23 ES24 SD18 SE24 CH21 TN24 TR26 UA29 AE23 GB22 VA22 VG24 YE30'
    .split(' ')
    .map((x) => [x.slice(0, 2), Number(x.slice(2))])
)

/** Published test values and examples: never suggested (allow.json). */
export const ALLOW = new Set([
  '4242424242424242', '4000056655665556', '5555555555554444', '2223003122003222', '5200828282828210', '5105105105105100',
  '378282246310005', '371449635398431', '6011111111111117', '6011000990139424', '3056930009020004', '36227206271667',
  '3566002020360505', '6200000000000005', '4111111111111111', '4012888888881881',
  'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  'GB82WEST12345698765432', 'DE89370400440532013000'
])
const EXAMPLE_DOMAINS = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i
const ROLE_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|notifications?|support|info|hello|contact|sales|admin|postmaster|webmaster|git|team|help|billing|security|privacy|press|jobs|careers|feedback)$/i

/* ================= labels (en, bn, es, hi) ================= */

const L = (words) => new RegExp('(?:^|[^\\p{L}\\p{N}])(' + words.join('|') + ')(?![\\p{L}\\p{N}])', 'iu')
export const LABELS = {
  password: L(['passwords?', 'passwd', 'pwd', 'pass', 'passcode', 'passphrase', 'pass phrase', 'contraseña', 'clave', 'পাসওয়ার্ড', 'পাসওয়ার্ড', 'গোপন ?নম্বর', 'पासवर्ड', 'कूटशब्द', 'network security key', 'wi-?fi password', 'wpa2? key', 'pre-?shared key', 'psk']),
  pin: L(['pin', 'pin code', 'pin number', 'পিন', 'पिन', 'nip']),
  code: L(['code', 'otp', 'one[- ]time (?:code|password|passcode)', '2fa', 'two[- ]factor', 'verification', 'security code', 'auth(?:entication)? code', 'confirmation code', 'login code', 'sign[- ]in code', 'código', 'কোড', 'ওটিপি', 'যাচাই', 'कोड', 'ओटीपी', 'सत्यापन']),
  phone: L(['phone', 'tel', 'telephone', 'mobile', 'cell', 'fax', 'whatsapp', 'call', 'teléfono', 'móvil', 'celular', 'ফোন', 'মোবাইল', 'টেলিফোন', 'फ़ोन', 'फोन', 'मोबाइल']),
  card: L(['card', 'card number', 'card no', 'credit card', 'debit card', 'visa', 'mastercard', 'amex', 'tarjeta', 'কার্ড', 'कार्ड']),
  cvv: L(['cvv2?', 'cvc2?', 'csc', 'card security code', 'card code']),
  iban: L(['iban']),
  key: L(['api[ _-]?key', 'apikey', 'secret[ _-]?key', 'client[ _-]?secret', 'access[ _-]?token', 'auth[ _-]?token', 'refresh[ _-]?token', 'bearer', 'personal access token', 'token', 'signing secret', 'webhook secret', 'private key', 'secret access key', 'access key', 'app secret', 'secret', 'credentials?', 'clave de api', 'এপিআই কী', 'टोकन', 'टोकन']),
  keyShort: L(['key', 'setup key', 'secret key', 'this key', 'type this key', 'token', 'read token', 'write token', 'secret', 'api key', 'access key', 'secret access key', 'client secret']),
  recovery: L(['recovery codes?', 'backup codes?', 'recovery phrase', 'seed phrase', 'secret recovery phrase', 'mnemonic', 'recovery key']),
  id: L(['account (?:number|no\\.?|#)', 'acct\\.?(?: no\\.?| #)?', 'a/c', 'customer (?:id|number|no\\.?)', 'member (?:id|number)', 'policy (?:number|no\\.?)', 'passport(?: no\\.?| number)?', "driver'?s licen[cs]e(?: no\\.?| number)?", 'licen[cs]e (?:number|no\\.?)', 'tax id', 'tin', 'ein', 'itin', 'ssn', 'social security(?: number| no\\.?)?', 'national insurance(?: number| no\\.?)?', 'ni number', 'nino', 'nid', 'national id', 'id (?:number|no\\.?)', 'aadhaar', 'pan', 'nhs number', 'medicare', 'routing(?: number)?', 'aba', 'sort code', 'bsb', 'employee id', 'student id', 'payroll id', 'tax file number', 'tfn', 'sin', 'social insurance number', 'member number', 'passport number', 'dni', 'nie', 'cpf', 'curp', 'rfc', 'número de cuenta', 'cuenta', 'জাতীয় পরিচয়(?:পত্র)?', 'এনআইডি', 'হিসাব নম্বর', 'অ্যাকাউন্ট নম্বর', 'পাসপোর্ট', 'खाता संख्या', 'आधार', 'पैन']),
  licence: L(['licen[cs]e key', 'product key', 'serial(?: number| key)?', 'activation (?:key|code)', 'registration (?:key|code)'])
}
/** 'code' phrases that are not one-time codes. */
export const CODE_NOT = /\b(zip|postal|post|country|area|dial(?:ling)?|error|status|exit|return|source|promo|promotional|discount|coupon|gift|referral|qr|bar|colou?r|hex|http|language|currency|airport|product|item|sku|tax|reason|response|event|key ?code|code (?:of conduct|review|block|editor|snippet|base|signing)|(?:vs|visual studio|claude) code)\b|\bcode\s*(?:[.:]\s*)?(?:19|20)\d\d\b/i

/** Value-less label lines that are UI, not a field: never a password. */
const PASSWORD_UI = /\b(forgot|reset|change|show|hide|confirm your|enter (your )?|manager|must|at least|strength|requirements?|policy|incorrect|wrong|invalid|expired|update|new password\?|remember)\b/i
const PLACEHOLDER = /^(?:[•*·.x]{1,}|x+|\*+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|your[_ -]?\w+(?:[_ -]here)?|changeme|change[_-]?it|pass|passwd|pwd|user|username|example|dummy|test|sample|redacted|hidden|none|null|undefined|password|secret|token|true|false|enabled|disabled|\d{1,3})$/i

/* ================= strong token rules (gitleaks v8.30.1, translated; OCR-tolerant prefixes) ================= */

const B = '(?<![A-Za-z0-9_])' // a token boundary before
const E = '(?![A-Za-z0-9_])' // and after (JS has no \b semantics for '-')
const SEP = '[_ -]?' // OCR loses or replaces '_' and '-' after a prefix
export const TOKEN_RULES = [
  // id, regex source (JS), base score, gitleaks id
  ['anthropic', B + 'sk' + '[-–]ant[-–](?:api|admin)0\\d[-–][A-Za-z0-9_-]{80,100}' + E, 0.98, 'anthropic-api-key'],
  ['openai', B + 'sk[-–](?:proj|svcacct|admin)[-–][A-Za-z0-9_-]{40,200}' + E, 0.98, 'openai-api-key'],
  ['openai-legacy', B + 'sk-[A-Za-z0-9]{20}T3B[l1I]bkFJ[A-Za-z0-9]{20}' + E, 0.98, 'openai-api-key'],
  ['sk-generic', B + 'sk[-–](?:or-v1-)?[A-Za-z0-9_-]{24,}' + E, 0.9, '(redact.ts style)'],
  ['github', B + 'gh[pousr]' + SEP + '[0-9A-Za-z]{34,38}' + E, 0.97, 'github-pat/oauth/app/refresh'],
  ['github-fine', B + 'github' + SEP + 'pat' + SEP + '[0-9A-Za-z_]{80,84}' + E, 0.98, 'github-fine-grained-pat'],
  ['gitlab', B + 'gl(?:pat|dt|ptt|rt|cbt|soat|ffct|ft|imt|agent|oas)-[0-9A-Za-z_-]{20,}' + E, 0.97, 'gitlab-*'],
  ['slack', B + 'xox[baprseo][-–][0-9A-Za-z-]{10,}' + E, 0.97, 'slack-*-token'],
  ['slack-app', B + 'xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+' + E, 0.97, 'slack-app-token'],
  ['aws-id', B + '(?:A3T[A-Z0-9]|AK[I1l]A|ASIA|ABIA|ACCA)[A-Z2-7]{16}' + E, 0.92, 'aws-access-token'],
  ['google', B + 'A[I1l|]za[0-9A-Za-z_-]{33,37}' + E, 0.97, 'gcp-api-key'],
  ['stripe', B + '(?:sk|rk)_(?:live|test|prod)_[0-9A-Za-z]{10,99}' + E, 0.97, 'stripe-access-token'],
  ['stripe-webhook', B + 'whsec_[0-9A-Za-z]{24,}' + E, 0.97, '(stripe webhook secret)'],
  ['stripe-pk', B + 'pk_(?:live|test)_[0-9A-Za-z]{10,99}' + E, 0.6, '(publishable: Check)'],
  ['sendgrid', B + 'SG\\.[A-Za-z0-9_-]{20,24}\\.[A-Za-z0-9_-]{40,46}' + E, 0.97, 'sendgrid-api-token'],
  ['twilio-key', B + 'SK[0-9a-fA-F]{32}' + E, 0.85, 'twilio-api-key'],
  ['npm', B + 'npm' + SEP + '[A-Za-z0-9]{30,38}' + E, 0.97, 'npm-access-token'],
  ['pypi', B + 'pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}' + E, 0.98, 'pypi-upload-token'],
  ['huggingface', B + 'hf' + SEP + '[A-Za-z0-9]{32,36}' + E, 0.95, 'huggingface-access-token (OCR: digits allowed)'],
  ['azure-ad-secret', '(?<![A-Za-z0-9_~.])[a-zA-Z0-9_~.]{3}\\dQ~[a-zA-Z0-9_~.-]{25,34}', 0.95, 'azure-ad-client-secret'],
  ['digitalocean', B + 'do[pro]_v1_[a-f0-9]{64}' + E, 0.98, 'digitalocean-*'],
  ['shopify', B + 'shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}' + E, 0.97, 'shopify-*'],
  ['linear', B + 'lin_api_[A-Za-z0-9]{40}' + E, 0.97, 'linear-api-key'],
  ['notion', B + '(?:ntn_[0-9]{11}[A-Za-z0-9]{35}|secret_[A-Za-z0-9]{43})' + E, 0.95, 'notion-api-token'],
  ['perplexity', B + 'pplx-[A-Za-z0-9]{48}' + E, 0.97, 'perplexity-api-key'],
  ['sentry', B + 'sntr[ys]u?_[A-Za-z0-9_=+/]{40,}' + E, 0.95, 'sentry-*-token'],
  ['grafana', B + 'glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}' + E, 0.97, 'grafana-service-account-token'],
  ['vault', B + 'hvs\\.[A-Za-z0-9_-]{90,120}' + E, 0.97, 'vault-service-token'],
  ['databricks', B + 'dapi[a-f0-9]{32}(?:-\\d)?' + E, 0.95, 'databricks-api-token'],
  ['postman', B + 'PMAK-[a-fA-F0-9]{24}-[a-fA-F0-9]{34}' + E, 0.97, 'postman-api-token'],
  ['heroku', B + 'HRKU-AA[0-9A-Za-z_-]{58}' + E, 0.97, 'heroku-api-key-v2'],
  ['age', B + 'AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}' + E, 0.99, 'age-secret-key'],
  ['telegram', '(?:(?<=bot)|(?<![A-Za-z0-9_]))' + '[0-9]{8,10}:AA[A-Za-z0-9_-]{33}' + E, 0.92, 'telegram-bot-api-token'],
  ['jwt', B + 'e[yv][JIl1][A-Za-z0-9_-]{10,}\\.e[yv][JIl1][A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}' + E, 0.93, 'jwt'],
  ['azure-conn', '(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{30,}={0,2}', 0.97, '(azure connection string)'],
  ['product-key', B + '(?:[BCDFGHJKMPQRTVWXY2346789]{5}-){4}[BCDFGHJKMPQRTVWXY2346789]{5}' + E, 0.9, '(Windows product key)']
].map(([id, src, score, from]) => ({ id, re: new RegExp(src, 'g'), score, from }))

/** Webhook and secret-bearing URL rules: the covered span is the secret part. */
const URL_RULES = [
  ['slack-webhook', /(?:https?:\/\/)?hooks\.slack\.com\/(?:services|workflows|triggers)\/([A-Za-z0-9+/_-]{20,})/g, 0.98],
  ['discord-webhook', /discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{5,}\/[A-Za-z0-9_-]{20,})/g, 0.98],
  ['teams-webhook', /webhook\.office\.com\/webhookb2\/([^\s"'<>]{20,})/g, 0.98],
  ['google-chat-webhook', /chat\.googleapis\.com\/v1\/spaces\/[^\s/]+\/messages\?([^\s"'<>]+)/g, 0.98],
  ['url-userinfo', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]{3,})@/gi, 0.97],
  ['url-user-token', /\b[a-z][a-z0-9+.-]*:\/\/([A-Za-z0-9]{16,})@/gi, 0.9],
  ['cli-secret-flag', /(?:^|\s)(?:--password|--passwd|--pass|--token|--secret|--client-secret|--api-key|--apikey|--access-key|--secret-key|--auth-token|-p)[ =]([^\s"']{8,}|"[^"]{8,}"|'[^']{8,}')/g, 0.85],
  ['path-token', /\/(?:invite|invitation|reset|reset-password|magic|verify|confirm|activate|join|share|s)\/((?=[A-Za-z_-]*\d)(?=[0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,})/gi, 0.9]
]
/** Query or fragment parameters whose value is a secret. */
const SECRET_PARAMS = /[?&#](?:access_token|id_token|refresh_token|token|auth|auth_token|authorization|api[_-]?key|apikey|key|secret|client_secret|password|passwd|pwd|pass|sig|signature|code|session|sessionid|sid|jwt|otp|reset_token|invite|magic|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|ticket|oobcode|login_token|invite_token|auth_key|secret_key|private_token|access_key|state_token|t_token)=([^&#\s"'<>]{8,})/gi
/** The generic gitleaks-style labelled assignment (generic-api-key), value with entropy. */
const ASSIGN = /(?:^|[^\p{L}\p{N}_])((?:[\w.-]{0,30}?)(?:api[_.-]?key|apikey|secret|token|passw(?:or)?d|pwd|credential|creds|auth|access[_.-]?key|private[_.-]?key|client[_.-]?secret))(?:[ \t\w.-]{0,20})["']?\s{0,3}(?:=|:|:=|=>|,|\|\|)\s{0,3}["'`]?([A-Za-z0-9_.=+/~-]{8,150})["'`]?/giu
/** A value that is code reading the secret from elsewhere, not the secret. */
const CODE_EXPR = /^(?:[A-Za-z_$][\w$]*(?:\.[\w$]+)*\s*[(\[]|[A-Za-z_$][\w$]*(?:\.[\w$]+)+[,;)\]}]*$|\$\{?|%[\w]+%|process\.env|os\.environ|getenv|env\.|\/.*\/[gimsuy]*[,;)]*$|.*\\[bdswnrtSDW])/
const GENERIC_STOP = /^(?:true|false|null|none|undefined|string|number|boolean|object|function|required|optional|process\.env\.[\w]+|env\.[\w]+|os\.environ|getenv|config\.[\w.]+|self\.[\w.]+|this\.[\w.]+)$/i

/**
 * Whether the digit groups as written follow one of the region's formats for this national number (the
 * EXACT_GROUPING idea, which libphonenumber-js's matcher does not offer): the written groups, after the
 * country code group and a national prefix are taken off, equal the format's groups or join neighbours of them.
 */
function groupsMatch(r, nat, written, national) {
  let g = [...written]
  if (!national) g = g.slice(1) // the calling code group ("+44")
  if (!g.length) return false
  if (national && r.natPrefix && g[0].startsWith(r.natPrefix) && g.join('').length === nat.length + r.natPrefix.length) g[0] = g[0].slice(r.natPrefix.length)
  if (g[0] === '') g = g.slice(1)
  if (g.length < 2) return false
  for (const f of r.formats) {
    if (f.lead && !f.lead.test(nat)) continue
    const m = f.re.exec(nat)
    if (!m) continue
    const parts = m.slice(1).map((x) => x.length)
    // the written groups must be the format's groups, or neighbours of them joined
    let i = 0
    let ok = true
    for (const w of g) {
      let n = 0
      while (i < parts.length && n < w.length) n += parts[i++]
      if (n !== w.length) { ok = false; break }
    }
    if (ok && i === parts.length) return true
  }
  return false
}

/** BEGIN … PRIVATE KEY with the dashes OCR drops, spaces or doubles (" - - --BEGIN PRIVATE KEY-- - - -"). */
export const PEM_BEGIN = /(?:^|[\s"'-])BEG[I1l]N\s+(?:[A-Z0-9]+\s+){0,3}PR[I1l]VATE\s+KEY(?:\s+BLOCK)?\b/
export const PEM_END = /(?:^|[\s"'-])END\s+(?:[A-Z0-9]+\s+){0,3}PR[I1l]VATE\s+KEY\b/

/** Token prefixes whose letters OCR confuses with digits ("x0xb-", "AK1A", "Alza", "5k-"). */
export const PREFIXES = ['xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-', 'xoxe-', 'xoxe.', 'xapp-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-', 'glsa_', 'AKIA', 'ASIA', 'ABIA', 'ACCA', 'AIza', 'sk-ant-', 'sk-proj-', 'sk-', 'sk_live_', 'sk_test_', 'rk_live_', 'rk_test_', 'pk_live_', 'pk_test_', 'whsec_', 'SG.', 'npm_', 'hf_', 'dop_v1_', 'doo_v1_', 'dor_v1_', 'shpat_', 'shpss_', 'lin_api_', 'ntn_', 'pplx-', 'hvs.', 'dapi', 'PMAK-', 'HRKU-AA', 'eyJ', 'AGE-SECRET-KEY-1', 'pypi-AgEIcHlwaS5vcmc']
const pfold = (c) => ({ '0': 'o', O: 'o', o: 'o', '1': 'l', l: 'l', I: 'l', i: 'l', '|': 'l', '5': 's', S: 's', s: 's', '8': 'b', B: 'b', b: 'b', '2': 'z', Z: 'z', z: 'z', '9': 'g', g: 'g', _: '_', ' ': '_', '-': '-', '–': '-', '—': '-' })[c] ?? c.toLowerCase()
/** The text with confusable characters of a known token prefix replaced by the prefix (same length: spans map one to one). */
export function prefixView(t) {
  let out = t
  for (const m of t.matchAll(/(?<![A-Za-z0-9_])[A-Za-z0-9|_.-]/g)) {
    const i = m.index
    for (const p of PREFIXES) {
      const seg = t.slice(i, i + p.length)
      if (seg.length < p.length || seg === p) continue
      let ok = true
      for (let k = 0; k < p.length && ok; k++) ok = pfold(seg[k]) === pfold(p[k])
      // the prefix must be followed by token characters, so "sk-" in prose is not rewritten
      if (ok && /^[A-Za-z0-9_-]{8}/.test(t.slice(i + p.length))) { out = out.slice(0, i) + p + out.slice(i + p.length); break }
    }
  }
  return out
}

/** Digits inside words read as the letters they stand for ("PASSW0RD", "T0KEN"), for label matching only (same length). */
export const labelFold = (t) => t.replace(/[A-Za-z0-9_]*[A-Za-z]{2}[A-Za-z0-9_]*/g, (w) => w.replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B'))

/** An IBAN that fails mod 97, repaired by up to two OCR swaps (0/O, 1/I, 5/S, 8/B, 2/Z, 6/G); null when none passes. */
export function repairIban(iban) {
  const SW = { '0': 'O', O: '0', '1': 'I', I: '1', '5': 'S', S: '5', '8': 'B', B: '8', '2': 'Z', Z: '2', '6': 'G', G: '6' }
  const pos = [...iban].map((c, i) => (i >= 4 && SW[c] ? i : -1)).filter((i) => i >= 0).slice(0, 12)
  const sw = (s, i) => s.slice(0, i) + SW[s[i]] + s.slice(i + 1)
  for (const i of pos) { const a = sw(iban, i); if (mod97(a) === 1) return a }
  for (let x = 0; x < pos.length; x++) for (let y = x + 1; y < pos.length; y++) { const a = sw(sw(iban, pos[x]), pos[y]); if (mod97(a) === 1) return a }
  return null
}

/* ================= line detector ================= */

/**
 * @param {string} raw the OCR line
 * @param {{ above?: string, regions?: string[], tlds: Set<string>, phone?: any, names?: string[], options?: { randomStrings?: boolean, dots?: boolean } }} ctx
 * @returns {{kind:string, rule:string, start:number, end:number, text:string, score:number}[]} spans index raw
 */
export function detectLine(raw, ctx) {
  const { t, map } = clean(raw)
  const out = []
  const add = (kind, rule, s, e, score) => {
    if (e <= s) return
    const rs = map[s]
    const re = e - 1 < map.length ? map[e - 1] + 1 : raw.length
    out.push({ kind, rule, start: rs, end: re, text: raw.slice(rs, re), score: Math.min(0.99, Math.round(score * 100) / 100) })
  }
  const above = ctx.above ? labelFold(clean(ctx.above).t) : ''
  const lt = labelFold(t)
  const labelled = (kind) => LABELS[kind].test(lt) || (above && LABELS[kind].test(above))

  // URL view: inside a link, a single space between two runs of 6+ token characters is an underscore OCR lost
  const urlView = (() => {
    let u = ''
    const um = []
    const links = [...t.matchAll(/(?:https?:\/\/|www\.)\S+(?: [A-Za-z0-9_-]{6,}(?=[\s.,;)]|$))*/g)]
    let k = 0
    for (const L of links) {
      for (; k < L.index; k++) { u += t[k]; um.push(k) }
      for (; k < L.index + L[0].length; k++) {
        if (t[k] === ' ' && /[A-Za-z0-9_-]{6}$/.test(u)) continue
        u += t[k]
        um.push(k)
      }
    }
    for (; k < t.length; k++) { u += t[k]; um.push(k) }
    return { t: u, map: um }
  })()

  // ---- private keys (PEM) ----
  if (PEM_BEGIN.test(t)) add('key', 'private-key', 0, t.length, 0.99)

  // ---- strong tokens ----
  const pv = prefixView(t)
  for (const r of TOKEN_RULES) {
    for (const m of pv.matchAll(r.re)) {
      const v = m[0]
      if (ALLOW.has(v)) continue
      if (/(X{4,}|x{6,}|0{8,}|\*{4,}|\.{4,})/.test(v) || new Set(v.slice(-12)).size <= 2) continue
      if (r.id === 'aws-id' && /EXAMPLE$/.test(v)) continue
      if (r.id === 'product-key' && !/\d/.test(v)) continue
      add('key', r.id, m.index, m.index + v.length, r.score)
    }
  }
  for (const [id, re, score] of URL_RULES) {
    for (const m of (id === 'cli-secret-flag' ? t : urlView.t).matchAll(re)) {
      if (id === 'url-userinfo' && PLACEHOLDER.test(m[1])) continue
      if (id === 'cli-secret-flag' && (/^\d+(?::\d+)*$/.test(m[1]) || entropy(m[1]) < 3 || CODE_EXPR.test(m[1]) || /^[$%]/.test(m[1]) || /\.(?:json|ya?ml|toml|js|ts|txt|cfg|conf|ini)\W*$/i.test(m[1]))) continue
      if (id === 'cli-secret-flag' && /^\s*-p\b/.test(m[0]) && !/\b(login|mysql|mysqladmin|mariadb|sshpass|psql|mongo(?:sh)?|redis-cli|smbclient|rdesktop|xfreerdp)\b/i.test(t)) continue
      if (id !== 'cli-secret-flag') { const s1 = urlView.map[m.index + m[0].lastIndexOf(m[1])]; const e1 = urlView.map[m.index + m[0].lastIndexOf(m[1]) + m[1].length - 1] + 1; add('key', id, s1, e1, score); continue }
      const s = m.index + m[0].lastIndexOf(m[1])
      add('key', id, s, s + m[1].length, score)
    }
  }
  for (const m of urlView.t.matchAll(SECRET_PARAMS)) {
    const v = m[1]
    if (/^(?:\{\{.*\}\}|<.*>|\$\{.*\}|x+|\*+)$/i.test(v)) continue
    const name = m[0].slice(1, m[0].indexOf('=')).toLowerCase()
    if (['code', 'key', 'sid', 'session'].includes(name) && v.length < 16 && !/\d/.test(v)) continue
    if (/^\d{4}-\d{2}-\d{2}(?:T[\d:]+Z?)?$/.test(v)) continue
    const s = urlView.map[m.index + m[0].length - v.length]
    add('key', 'url-param:' + name, s, urlView.map[m.index + m[0].length - 1] + 1, 0.92)
  }

  // ---- labelled assignment (code and config text) ----
  for (const m of t.matchAll(ASSIGN)) {
    const v = m[2]
    const s = m.index + m[0].length - v.length - (/["'`]$/.test(m[0]) ? 1 : 0)
    if (/^[A-Za-z_.-]+$/.test(v) || GENERIC_STOP.test(v) || PLACEHOLDER.test(v)) continue
    if (/^(?:https?|wss?|ftp|file|s3|gs)$/i.test(v) && t.slice(m.index + m[0].length).startsWith('://')) continue
    if (/^\/\/|^\/[\w-]+\//.test(v)) continue
    if (/^[A-Z_][A-Z0-9_]*=/.test(v)) continue
    const h = entropy(v)
    if (h < 3.0) continue
    if (out.some((o) => o.kind === 'key' && o.start <= map[s] && o.end >= map[Math.min(s + v.length, map.length) - 1])) continue
    add('key', 'labelled-assignment', s, s + v.length, 0.75)
  }

  // ---- emails ----
  const EMAIL_STRICT = /(?<![A-Za-z0-9._%+\/-])([A-Za-z0-9][A-Za-z0-9._%+-]{0,63})(@)((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+)([A-Za-z]{2,24})(?![A-Za-z0-9@])/g
  const EMAIL_OCR = /(?<![A-Za-z0-9._%+\/-])([A-Za-z0-9][A-Za-z0-9._%+-]{0,63})\s?([@©®])\s?((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\s?[.,·]\s?)+)([A-Za-z]{2,24})(?![A-Za-z0-9@])/g
  const emailMatches = [...t.matchAll(EMAIL_STRICT)]
  for (const m of t.matchAll(EMAIL_OCR)) if (!emailMatches.some((e) => m.index < e.index + e[0].length && e.index < m.index + m[0].length)) emailMatches.push(m)
  for (const m of emailMatches) {
    const [all, local, at, mid, tld] = m
    const domain = (mid.replace(/[\s,·]/g, '.').replace(/\.+/g, '.') + tld).toLowerCase()
    const reserved = /^(test|example|invalid|localhost)$/i.test(tld) || EXAMPLE_DOMAINS.test(domain)
    if (!ctx.tlds.has(tld.toLowerCase()) && !reserved) continue
    if (/^git$/i.test(local) && t[m.index + all.length] === ':') continue // an SSH remote
    const damaged = at !== '@' || /[\s,·]/.test(mid) || /\s/.test(all)
    let score = damaged ? 0.75 : 0.95
    if (ROLE_LOCAL.test(local) || reserved) score = 0.6
    add('email', damaged ? 'email-ocr' : 'email', m.index, m.index + all.length, score)
  }

  // ---- digits: cards, IBAN, SSN, phones ----
  const dv = digitView(t)
  const CARD = /(?<![\p{L}\p{N}.,/-])\d(?:[ -]?\d){11,18}(?![\p{L}\p{N}]|[.,/-]\d)/gu
  for (const m of dv.matchAll(CARD)) {
    const run = m[0]
    const groups = run.split(/[ -]/)
    const d = groups.join('')
    const lens = groups.map((g) => g.length)
    const seps = new Set(run.match(/[ -]/g) || [])
    const groupedOk =
      groups.length === 1 ||
      (seps.size === 1 &&
        (lens.slice(0, -1).every((n) => n % 4 === 0) && lens[lens.length - 1] >= 1 && (lens[lens.length - 1] <= 4 || lens[lens.length - 1] % 4 === 0) ||
          (lens.length === 3 && lens[0] === 4 && lens[1] === 6 && (lens[2] === 5 || lens[2] === 4))))
    if (!groupedOk) continue
    if (ALLOW.has(d)) continue
    if ((d.match(/0/g) || []).length / d.length >= 0.75 || new Set(d).size <= 2) continue
    const net = cardNetwork(d)
    const ok = luhn(d)
    const lab = labelled('card')
    const otherLabel = !lab && /\b(ref|reference|order|invoice|inv|tracking|ticket|serial|sku|imei|iccid|isbn|ean|upc)\b|#\s*$/i.test(t.slice(0, m.index))
    if (ok && net) add('card', 'card-luhn:' + net, m.index, m.index + run.length, otherLabel ? 0.6 : groups.length > 1 || lab ? 0.96 : 0.88)
    else if (lab && net && groups.length >= 4 && lens.every((n, i) => i === lens.length - 1 || n === 4)) add('card', 'card-misread', m.index, m.index + run.length, 0.8)
    else if (lab && d.length >= 13 && d.length <= 19) add('card', 'card-labelled', m.index, m.index + run.length, 0.7)
  }
  // CVV right after its label (see afterLabel below, inlined: label, separator, 3-4 digits)
  for (const m of dv.matchAll(new RegExp(LABELS.cvv.source + '\\s*[:=]?\\s*(\\d{3,4})(?![\\p{L}\\p{N}])', 'giu'))) {
    const s0 = m.index + m[0].length - m[2].length
    add('card', 'cvv', s0, s0 + m[2].length, 0.9)
  }
  // IBAN
  const IBANRE = /(?<![A-Za-z0-9])([A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{1,4}){3,9})(?![A-Za-z0-9])/g
  for (const m of t.matchAll(IBANRE)) {
    const compact = m[1].replace(/ /g, '')
    const want = IBAN_LEN[compact.slice(0, 2)]
    if (!want) continue
    let s = m.index
    let e = m.index + m[1].length
    if (compact.length < want) continue
    if (compact.length > want) {
      // the run swallowed following text: cut to the length (counting spaces)
      let n = 0
      let k = s
      while (k < t.length && n < want) {
        if (t[k] !== ' ') n++
        k++
      }
      e = k
    }
    const iban = t.slice(s, e).replace(/ /g, '').toUpperCase()
    if (ALLOW.has(iban) || /XXXX|0{10,}/.test(iban)) continue
    const lab = labelled('iban')
    if (mod97(iban) === 1) add('bank', 'iban', s, e, 0.97)
    else if (repairIban(iban)) add('bank', 'iban-repaired', s, e, 0.85)
    else if (lab) add('bank', 'iban-labelled', s, e, 0.75)
  }
  // SSN (formatted) and UK NI number
  for (const m of dv.matchAll(/(?<![\p{L}\p{N}-])(\d{3})([- ])(\d{2})\2(\d{4})(?![\p{L}\p{N}]|-\d)/gu)) {
    const [all, a, , g, s4] = m
    if (a === '000' || a === '666' || a[0] === '9' || g === '00' || s4 === '0000') continue
    if (ALLOW.has(a + g + s4)) continue
    add('id', 'ssn', m.index, m.index + all.length, labelled('id') ? 0.95 : 0.85)
  }
  for (const m of t.matchAll(/(?<![A-Za-z0-9])((?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]) ?(\d{2}) ?(\d{2}) ?(\d{2}) ?([A-D])(?![A-Z0-9])/g)) {
    add('id', 'uk-nino', m.index, m.index + m[0].length, 0.85)
  }
  // ---- values attached to a label: right after it (only a separator between), or right before "is your … <label>" ----
  const labelHits = (kind) => [...lt.matchAll(new RegExp(LABELS[kind].source, 'giu'))].map((m) => ({ word: m[1], end: m.index + m[0].length }))
  /** The value right after a label of `kind` matching `valueRe` (anchored), with what separated them. */
  const afterLabel = (kind, valueRe, sepRequired) => {
    for (const h of labelHits(kind)) {
      const rest = (kind === 'id' || kind === 'pin' || kind === 'code' || kind === 'phone' ? dv : t).slice(h.end)
      let sep = /^["'`]?\s*(?:([:=：#]|no\.?)|(is|es|হলো|হচ্ছে|है|was)(?![\p{L}\p{N}\p{M}]))?\s*(?:[:=]\s*)?["'`]?/iu.exec(rest)
      // "PIN for the shared phone is 2580": up to five words between the label and "is"
      if (!(sep[1] || sep[2]) && (kind === 'password' || kind === 'pin' || kind === 'code')) {
        const far = /^(?:\s+[\p{L}\p{N}'’-]+){1,5}?\s+(is|was|es|হলো|হচ্ছে|है)(?![\p{L}\p{N}\p{M}])\s*["'`]?/iu.exec(rest)
        if (far) sep = Object.assign([far[0], undefined, far[1]], { index: 0 })
      }
      const hasSep = !!(sep[1] || sep[2])
      if (sepRequired && !hasSep) continue
      if (h.word.toLowerCase() === 'pass' && !/[:=]/.test(sep[0])) continue
      if (h.word.toLowerCase() === 'pass' && !/^\s*$|(?:user(?:name)?|login|id)\s*[:=]\s*\S+[\s,;/|]*$/i.test(t.slice(0, h.end - h.word.length))) continue
      const v = valueRe.exec(rest.slice(sep[0].length))
      if (v) { const vv = v[0].replace(/[,;)\]}'"`]+$/, ''); if (vv) return { s: h.end + sep[0].length, v: vv, hasSep } }
    }
    return null
  }
  /** The line is the value under a short label line of `kind` ("Password", "API key *"). */
  const underLabel = (kind) => {
    if (!above) return null
    const a = above.trim()
    if (a.length > 40 || a.split(/\s+/).length > 4 || !LABELS[kind].test(a)) return null
    if (a.replace(LABELS[kind], '').replace(/[\s:*•()]/g, '').length > 10) return null
    const v = t.trim()
    if (!v) return null
    if (/\s/.test(v) && !((kind === 'id' || kind === 'code') && v.length <= 30 && (asciiDigits(v).match(/\d/g) || []).length / v.replace(/\s/g, '').length >= 0.5)) return null
    return { s: t.indexOf(v), v }
  }
  /** The box is the value of a short label box to its left on the same row (other boxes may sit between). */
  const besideLabel = (kind) => {
    const left = (ctx.left || []).slice(-3).reverse()
    const lab = LABELS[kind]
    const short = kind === 'key' ? LABELS.keyShort : null
    for (const b of left) {
      const c = clean(b).t.trim()
      if (c.split(/\s+/).length > 6) break
      if (lab.test(c) || (short && short.test(c)) || (kind === 'key' && /(?:secret|key|token)\w*\s*[:=]\s*$/i.test(c)) || (kind === 'password' && /(?:password|passwd|pwd)\w*\s*[:=]\s*$/i.test(c))) {
        const v = t.trim().replace(/^["'`]|["'`,;]+$/g, '')
        if (!v) return null
        return { s: t.indexOf(v), v }
      }
    }
    return null
  }
  /** A short label line above for `kind`, also with the short key labels ("Setup key", "Token"). */
  const underShort = (kind) => {
    const u = underLabel(kind)
    if (u || kind !== 'key' || !above) return u
    const a = above.trim()
    if (a.length > 40 || a.split(/\s+/).length > 4 || !LABELS.keyShort.test(a)) return null
    const v = t.trim()
    return v && !/\s/.test(v) ? { s: t.indexOf(v), v } : /^[A-Z2-7]{4}(?: [A-Z2-7]{4}){3,}$/.test(v) ? { s: t.indexOf(v), v } : null
  }
  const lineStartsWithLabel = (kind) => { const m = LABELS[kind].exec(t); return m && t.slice(0, m.index + m[0].length - m[1].length).trim() === '' }

  // labelled ID numbers and licence keys
  {
    const ID_VALUE = /^[A-Z0-9][A-Z0-9 -]{3,28}[A-Z0-9](?![A-Za-z0-9])/i
    const idHits = []
    for (const h of labelHits('id')) {
      const rest = dv.slice(h.end)
      const sep = /^["'`]?\s*(?:[:=：#]|no\.?)?\s*/i.exec(rest)
      const v = ID_VALUE.exec(rest.slice(sep[0].length))
      if (v) idHits.push({ s: h.end + sep[0].length, v: v[0].replace(/[ -]+$/, '') })
    }
    const u = underLabel('id') || besideLabel('id')
    if (u) idHits.push({ s: u.s, v: asciiDigits(u.v) })
    for (const hit of idHits) {
      const digits = (hit.v.match(/\d/g) || []).length
      if (digits >= 4 && digits / hit.v.replace(/[ -]/g, '').length >= 0.5 && !out.some((o) => o.start <= map[hit.s] && o.end > map[hit.s])) add('id', 'id-labelled', hit.s, hit.s + hit.v.length, 0.85)
    }
    const lk = afterLabel('licence', /^[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){2,5}(?![A-Za-z0-9])|^[A-Z0-9]{12,40}(?![A-Za-z0-9])/i, false)
    if (lk && /\d/.test(lk.v) && !out.some((o) => o.start <= map[lk.s] && o.end > map[lk.s])) add('id', 'licence-labelled', lk.s, lk.s + lk.v.length, 0.85)
  }

  // ---- phones (metadata as data; gates per rules.md §2) ----
  if (ctx.phone) {
    const PH = /(?<![\p{L}\p{N}.\/:-])(\+|00)?\s?(\(?\d[\d\s().-]{5,20}\d)(?![\p{L}\p{N}]|[.\/:]\d)/gu
    const notPhone = /\b(order|invoice|inv|ticket|ref|reference|tracking|sku|account|acct|serial|build|version|id)\b|#/i
    for (const m of dv.matchAll(PH)) {
      const all = m[0]
      if (out.some((o) => o.start <= map[m.index] && o.end > map[m.index])) continue
      if (/(?:^|[^\d])\.\d|-\.|\d\.\d(?:[^\d]|$)/.test(all)) continue
      if (/\./.test(all) && all.split('.').some((g, i, a) => { const d = g.replace(/\D/g, '').length; return (i > 0 || a.length > 1) && (d === 1 || d > 4) && i < a.length })) continue
      if (/^\d{4}-\d{2}-\d{2}$|^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$|^\d{1,3}(\.\d{1,3}){3}$|^\d{1,2}:\d{2}/.test(all.trim())) continue
      const digits = all.replace(/\D/g, '')
      const plus = !!m[1]
      const grouped = /[\s().-]/.test(m[2])
      const groups = m[2].split(/[\s().-]+/).filter(Boolean).map((g) => g.replace(/\D/g, ''))
      const lab = labelled('phone')
      let found = null
      if (plus) {
        for (let k = 1; k <= 3 && !found; k++) {
          const cc = digits.slice(0, k)
          for (const reg of ctx.phone.callingCodes[cc] || []) {
            const r = ctx.phone.regions[reg]
            const nat = digits.slice(k)
            if (r && r.lengths.has(nat.length) && r.general.test(nat) && (!r.valid || r.valid.test(nat))) { found = { reg, nat, mobile: r.mobile?.test(nat), groups: groupsMatch(r, nat, groups, false), prefixed: true }; break }
            if (r && r.lengths.has(nat.length) && !found) found = { reg, nat, possibleOnly: true, prefixed: true }
          }
        }
      } else {
        for (const reg of ctx.regions || []) {
          const r = ctx.phone.regions[reg]
          let nat = digits
          const prefixed = !!(r.natPrefix && nat.startsWith(r.natPrefix))
          if (prefixed) nat = nat.slice(r.natPrefix.length)
          if (r.lengths.has(nat.length) && r.general.test(nat) && (!r.valid || r.valid.test(nat))) { found = { reg, nat, mobile: r.mobile?.test(nat), groups: groupsMatch(r, nat, groups, true), prefixed: prefixed || !r.natPrefix }; break }
        }
      }
      if (!found) continue
      let score = 0
      if (plus && found.possibleOnly) score = grouped ? 0.85 : 0.6
      else if (plus || lab) score = 0.92
      else if (grouped && found.groups) score = 0.85
      else if (found.mobile && found.prefixed && !notPhone.test(t)) score = 0.6
      if (score) add('phone', plus ? 'phone-intl' : lab ? 'phone-labelled' : grouped ? 'phone-grouped' : 'phone-bare-mobile', m.index + all.indexOf(all.trim()), m.index + all.length, score)
    }
  }

  // ---- passwords ----
  if (!PASSWORD_UI.test(lt)) {
    let same = afterLabel('password', /^\S{4,64}/, !lineStartsWithLabel('password') || t.trim().split(/\s+/).length !== 2)
    if (same) { const v = same.v.replace(/[,;)\]}'"`]+$/, '').replace(/^['"`]/, ''); same = v.length >= 4 && !(/^[A-Za-z_$][A-Za-z_$]*$/.test(v) && /^[A-Z]|[a-z][A-Z]/.test(v)) ? { s: same.s + (same.v.startsWith(v) ? 0 : 1), v, hasSep: same.hasSep } : null }
    const beside = besideLabel('password')
    const hit = same || (!PASSWORD_UI.test(above) ? underLabel('password') : null) || (beside && !/^(WPA\d?(-\w+)?|WEP|AES|TKIP|Open|None|Hide|Show|Copy|Edit|Change|Reveal|From the sticker)$/i.test(beside.v) ? beside : null)
    if (hit && /^(WPA\d?(-\w+)?|WEP|AES|TKIP|Open|None|Hide|Show|Copy|Edit|Change|Reveal)$/i.test(hit.v)) { /* the security type or a button, not the password */ }
    else if (hit && (/^•+$/.test(hit.v) || (!PLACEHOLDER.test(hit.v) && !CODE_EXPR.test(hit.v) && !/^[\p{P}\p{S}]+$/u.test(hit.v)))) {
      if (/^•+$/.test(hit.v)) {
        if (ctx.options?.dots) add('password', 'password-dots', hit.s, hit.s + hit.v.length, 0.6)
      } else add('password', same ? 'password-labelled' : 'password-below-label', hit.s, hit.s + hit.v.length, 0.9)
    }
  }
  // ---- PINs and one-time codes ----
  const ALGO = /^(?:SHA|MD|AES|RSA|UTF|ISO|RFC|CVE|HS|RS|ES|PS|ECDSA|ED|TLS|SSL|HTTP|IPV|X)-?\d/i
  const CODE_VALUE = /^(?:[A-Z]-)?(?:\d{3,4}[ -]\d{3,4}|\d{4,8})(?![\p{L}\p{N}]|-\d)|^[A-Z0-9]{4}-[A-Z0-9]{4}(?![\p{L}\p{N}])/u
  const codeOk = (v) => !ALGO.test(v) && !/^(19|20)\d\d$/.test(v) && /\d/.test(v.replace(/^[A-Z]-/, '')) || /^[A-Z]{4}-[A-Z]{4}$/.test(v)
  {
    const pinLabelOk = labelHits('pin').some((h) => /^(PIN|পিন|पिन|NIP)$/u.test(h.word))
    let pin = pinLabelOk ? afterLabel('pin', /^\d{4,8}(?![\p{L}\p{N}]|-\d)/u, false) : null
    if (!pin) { const b = besideLabel('pin'); if (b && /^\d{4,8}$/.test(asciiDigits(b.v))) pin = b }
    if (pin) add('code', 'pin-labelled', pin.s, pin.s + pin.v.length, 0.9)
    if (!CODE_NOT.test(t)) {
      let code = afterLabel('code', CODE_VALUE, false)
      if (code && !codeOk(code.v)) code = null
      if (!code) {
        // the value first: "482913 is your verification code", "G-482913 is your Google verification code"
        const m = /(?<![\p{L}\p{N}])((?:[A-Z]-)?\d{4,8})\s+(?:is|es|হলো|है)\s+(?:your|the|tu|su|আপনার|आपका)\b/iu.exec(dv)
        if (m && LABELS.code.test(t.slice(m.index + m[0].length, m.index + m[0].length + 48))) code = { s: m.index, v: m[1] }
      }
      if (!code) {
        // a code alone on its line under a line (or two) that names a code, even in a sentence
        const v = t.trim()
        const near = [above, ctx.above2].filter(Boolean)
        if (v && CODE_VALUE.test(asciiDigits(v)) && asciiDigits(v).length === CODE_VALUE.exec(asciiDigits(v))[0].length && codeOk(asciiDigits(v)) && near.some((a) => LABELS.code.test(a) && !CODE_NOT.test(a))) code = { s: t.indexOf(v), v }
      }
      if (code && !out.some((o) => o.start <= map[code.s] && o.end > map[code.s])) add('code', /[A-Z]{3}/i.test(code.v) ? 'code-alnum-labelled' : 'code-labelled', code.s, code.s + code.v.length, /[A-Z]{3}/i.test(code.v) ? 0.85 : 0.9)
    }
  }
  if (ctx.recovery && (() => { const tk = t.trim().split(/\s+/).filter(Boolean); const codeish = tk.filter((x) => /^[A-Za-z0-9-]{3,12}$/.test(x) && /\d/.test(x)).length; return tk.length > 0 && codeish / tk.length >= 0.6 })()) {
    for (const m of t.matchAll(/(?<![A-Za-z0-9])(?:[A-Za-z0-9]{3,6}[- ][A-Za-z0-9]{3,6}|[A-Za-z0-9]{6,12})(?![A-Za-z0-9])/g)) {
      const v = m[0]
      if (!/\d/.test(v) || v.replace(/[- ]/g, '').length < 6 || /^(19|20)\d\d$/.test(v)) continue
      if (out.some((o) => o.start <= map[m.index] && o.end > map[m.index])) continue
      add('code', 'recovery-code', m.index, m.index + v.length, 0.9)
    }
  }
  // CVV under or beside its label
  if (/^\s*\d{3,4}\s*$/.test(dv) && ((above && /^\s*(CVV2?|CVC2?|CSC|CVV\/CVC)\s*:?\s*$/i.test(above)) || besideLabel('cvv'))) add('card', 'cvv', t.indexOf(t.trim()), t.indexOf(t.trim()) + t.trim().length, 0.9)
  // key labels in UI ("API key" above a value, or "Secret: value")
  if (!out.some((o) => o.kind === 'key')) {
    const hit = afterLabel('key', /^\S{12,200}/, true) || underShort('key') || besideLabel('key')
    if (hit && /^[A-Z2-7]{4}(?: [A-Z2-7]{4}){3,}$|^[A-Z2-7]{16,}$/.test(hit.v)) add('key', 'otp-secret', hit.s, hit.s + hit.v.length, 0.95)
    else if (hit && (/\s/.test(hit.v) || /^(?:https?:)?\/\/|:\/\/|^[\w.-]+\/[\w./-]+\.\w{2,5}$|\.(?:ya?ml|json|env|txt|pem|key|crt|cfg|ini|toml)$/i.test(hit.v) || /^(WPA\d?(-\w+)?|WEP|AES|TKIP)$/i.test(hit.v))) { /* not a key value */ }
    else
    if (hit && hit.v.length >= 12 && /\d/.test(hit.v) && /[A-Za-z]/.test(hit.v) && !PLACEHOLDER.test(hit.v) && !CODE_EXPR.test(hit.v) && entropy(hit.v) >= 3.0) add('key', 'key-strong-label', hit.s, hit.s + hit.v.length, 0.75)
  }

  // ---- names the user lists ----
  for (const name of ctx.names || []) for (const h of findName(t, name)) add('name', h.fuzzy ? 'name-fuzzy' : 'name', h.s, h.e, h.fuzzy ? 0.8 : 0.97)

  // ---- unlabelled random-looking strings (off by default) ----
  if (ctx.options?.randomStrings) {
    for (const m of t.matchAll(/(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{24,}(?![A-Za-z0-9+/_=-])/g)) {
      const v = m[0]
      if (out.some((o) => o.start <= map[m.index] && o.end > map[m.index])) continue
      const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(v)).length
      if (classes < 2 || entropy(v) < 4.0) continue
      add('key', 'random-string', m.index, m.index + v.length, 0.55)
    }
  }
  return dedupe(out)
}

function dedupe(list) {
  list.sort((a, b) => b.score - a.score || (b.end - b.start) - (a.end - a.start))
  const kept = []
  for (const h of list) if (!kept.some((k) => k.start <= h.start && k.end >= h.end)) kept.push(h)
  return kept.sort((a, b) => a.start - b.start)
}

/* ================= names: OCR-tolerant matching ================= */

const NAME_CONF = [[/rn/g, 'm'], [/vv/g, 'w'], [/cl/g, 'd'], [/0/g, 'o'], [/[1|!]/g, 'l'], [/5/g, 's'], [/8/g, 'b'], [/6/g, 'g']]
const fold = (s) => {
  let x = s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  for (const [re, to] of NAME_CONF) x = x.replace(re, to)
  return x.replace(/i/g, 'l')
}
export function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1)
    }
  return dp[a.length][b.length]
}
export const allowedEdits = (n) => (n <= 4 ? 0 : n <= 8 ? 1 : 2)
/** Spans of `t` matching the listed `name` (whole words; spaces optional; '*' at an end is a wildcard). */
export function findName(t, entry) {
  const hits = []
  const prefix = entry.endsWith('*')
  const suffix = entry.startsWith('*')
  const want = fold(entry.replace(/^\*|\*$/g, '')).replace(/\s+/g, '')
  if (want.length < 2) return hits
  const words = [...t.matchAll(/[\p{L}\p{N}'’.-]+/gu)]
  for (let i = 0; i < words.length; i++) {
    let joined = ''
    for (let j = i; j < Math.min(words.length, i + 4); j++) {
      joined += fold(words[j][0]).replace(/[.'’-]/g, '')
      const s = words[i].index
      const e = words[j].index + words[j][0].length
      const cand = prefix ? joined.slice(0, want.length) : suffix ? joined.slice(-want.length) : joined
      const d = lev(cand, want)
      if (d <= allowedEdits(want.length) && (!prefix || joined.length >= want.length) && Math.abs(joined.length - want.length) <= (prefix || suffix ? 99 : allowedEdits(want.length))) {
        hits.push({ s, e, d, fuzzy: d > 0 })
        break
      }
      if (joined.length > want.length + 3) break
    }
  }
  // the best match wins where two overlap ("as Riad Hasan" against "Riad Hasan")
  hits.sort((a, b) => a.d - b.d || (a.e - a.s) - (b.e - b.s))
  const kept = []
  for (const h of hits) if (!kept.some((k) => h.s < k.e && k.s < h.e)) kept.push(h)
  return kept
}

/* ================= speech: digit streams over caption words ================= */

const EN_DIGIT = { zero: '0', oh: '0', o: '0', nought: '0', nil: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' }
const EN_TEEN = { ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19' }
const EN_TENS = { twenty: '2', thirty: '3', forty: '4', fifty: '5', sixty: '6', seventy: '7', eighty: '8', ninety: '9' }
const BN_DIGIT = { 'শূন্য': '0', 'এক': '1', 'দুই': '2', 'দু': '2', 'তিন': '3', 'চার': '4', 'পাঁচ': '5', 'ছয়': '6', 'ছয়': '6', 'ছয়': '6', 'ছ': '6', 'সাত': '7', 'আট': '8', 'নয়': '9', 'নয়': '9', 'নয়': '9' }
const BN_LOAN = { 'জিরো': '0', 'ওয়ান': '1', 'ওয়ান': '1', 'টু': '2', 'থ্রি': '3', 'ফোর': '4', 'ফাইভ': '5', 'সিক্স': '6', 'সেভেন': '7', 'এইট': '8', 'নাইন': '9' }
const ES_DIGIT = { cero: '0', uno: '1', una: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9' }
const HI_DIGIT = { 'शून्य': '0', 'एक': '1', 'दो': '2', 'तीन': '3', 'चार': '4', 'पांच': '5', 'पाँच': '5', 'छह': '6', 'छः': '6', 'सात': '7', 'आठ': '8', 'नौ': '9' }
for (const tb of [BN_DIGIT, BN_LOAN, HI_DIGIT]) for (const k of Object.keys(tb)) tb[k.normalize('NFC')] = tb[k]
const REPEAT = { double: 2, triple: 3, 'ডাবল': 2, 'ট্রিপল': 3, doble: 2, triple_es: 3, 'डबल': 2, 'ट्रिपल': 3 }
const FILLER = new Set(['um', 'uh', 'erm', 'then', 'dash', 'hyphen', 'space', 'comma', 'is', 'উম', 'আর', 'ড্যাশ', 'y', 'guion', 'guión'])
const bare = (w) => asciiDigits(w.normalize('NFC').toLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ''))

/** Digits a word stands for ('' for none). `next` is the following bare word (for "twenty five"). */
function wordDigits(w) {
  if (/^\d+$/.test(w)) return w
  if (/^\d+\.\d+\.\d+/.test(w)) return ''
  if (/^\d+(?:[-.]\d+)+$/.test(w)) return w.replace(/\D/g, '')
  if (/^(?:\d+[.,])+$/.test(w)) return w.replace(/\D/g, '')
  for (const table of [EN_DIGIT, EN_TEEN, BN_DIGIT, BN_LOAN, ES_DIGIT, HI_DIGIT]) if (Object.hasOwn(table, w)) return table[w]
  const hy = /^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(one|two|three|four|five|six|seven|eight|nine)$/.exec(w)
  if (hy) return EN_TENS[hy[1]] + EN_DIGIT[hy[2]]
  if (Object.hasOwn(EN_TENS, w)) return EN_TENS[w] + '0'
  return ''
}

/**
 * Runs of spoken digits over a flat word list [{text,start,end}], across sentence and caption breaks,
 * broken by a pause over `gap` s or a word that is neither a digit word nor a filler. Each run lists
 * its digits and, for every digit, the index of the word it came from.
 */
export function digitRuns(words, gap = 2.0) {
  const runs = []
  let cur = null
  let pendingRepeat = 0
  const close = () => {
    if (cur && cur.digits.length) runs.push(cur)
    cur = null
    pendingRepeat = 0
  }
  for (let i = 0; i < words.length; i++) {
    const w = bare(words[i].text)
    const prev = i > 0 ? words[i - 1] : null
    if (cur && prev && words[i].start - prev.end > gap) close()
    if (Object.hasOwn(REPEAT, w)) {
      if (!cur) cur = { digits: '', from: [], first: i, last: i }
      pendingRepeat = REPEAT[w]
      cur.last = i
      continue
    }
    let d = wordDigits(w)
    // "oh"/"o" is a zero only inside a run
    if ((w === 'oh' || w === 'o') && !cur) d = ''
    // a tens word followed by a unit word: "twenty five"
    if (d.length === 2 && d.endsWith('0') && i + 1 < words.length) {
      const nx = bare(words[i + 1].text)
      if (Object.hasOwn(EN_DIGIT, nx) && nx !== 'zero' && nx !== 'oh' && nx !== 'o') {
        d = d[0] + EN_DIGIT[nx]
        if (!cur) cur = { digits: '', from: [], first: i, last: i }
        cur.digits += d
        cur.from.push(i, i + 1)
        cur.last = i + 1
        i++
        continue
      }
    }
    if (d) {
      if (!cur) cur = { digits: '', from: [], first: i, last: i }
      if (pendingRepeat && d.length === 1) d = d.repeat(pendingRepeat)
      pendingRepeat = 0
      cur.digits += d
      for (let k = 0; k < d.length; k++) cur.from.push(i)
      ;(cur.tokens ??= []).push(d)
      cur.last = i
    } else if (cur && FILLER.has(w)) {
      continue
    } else close()
  }
  close()
  return runs
}

const SPOKEN_LABEL = {
  card: /\b(card|credit|debit|visa|mastercard|amex)\b|কার্ড|tarjeta|कार्ड/iu,
  code: /\b(code|otp|verification|passcode|pin)\b|কোড|ওটিপি|পিন|código|कोड|ओटीपी|पिन/iu,
  phone: /\b(phone|number|call|mobile|cell|whatsapp)\b|ফোন|মোবাইল|নম্বর|নাম্বার|teléfono|número|फ़ोन|फोन|नंबर|मोबाइल/iu,
  id: /\b(social security|ssn|account|routing|passport|licen[cs]e|national insurance|aadhaar|nid)\b|অ্যাকাউন্ট|হিসাব|পাসপোর্ট|এনআইডি|cuenta|खाता|आधार/iu,
  password: /\b(password|passphrase|passcode)\b|পাসওয়ার্ড|পাসওয়ার্ড|contraseña|पासवर्ड/iu
}

/**
 * Spoken secrets in a flat word list: [{kind, rule, first, last, digits?}] word index ranges to bleep.
 * Context: the label words in the 12 words (or 10 s) before the run's first word.
 */
/** A spoken code is one 4-8 digit number, or digits said one by one (at least 4 tokens), never a year or a version. */
const codeShaped = (r) => { const tk = r.tokens || []; if (tk.some((x) => /^(19|20)\d\d$/.test(x))) return false; return (tk.length === 1 && tk[0].length >= 4) || (tk.length >= 4 && tk.every((x) => x.length <= 2)) || (tk.length >= 2 && tk.every((x) => x.length === 3 || x.length === 4)) }
const SAY_IS = new Set(['is', 'was', '=', ':', 'হলো', 'হল', 'হচ্ছে', 'es', 'है', 'its', "it's"].map((w) => w.normalize('NFC')))
export function detectSpoken(words, opts = {}) {
  const found = []
  const contextOf = (i) => {
    const t0 = words[i].start - 10
    const ws = []
    for (let k = i - 1; k >= 0 && k >= i - 12 && words[k].start >= t0; k--) ws.unshift(words[k].text)
    return ws.join(' ')
  }
  for (const r of digitRuns(words)) {
    const d = r.digits
    const ctxText = contextOf(r.first)
    const lab = (k) => SPOKEN_LABEL[k].test(ctxText)
    if (d.length >= 13 && d.length <= 19 && luhn(d) && cardNetwork(d)) found.push({ kind: 'card', rule: 'spoken-card', first: r.first, last: r.last, digits: d })
    else if (d.length >= 13 && d.length <= 19 && lab('card')) found.push({ kind: 'card', rule: 'spoken-card-labelled', first: r.first, last: r.last, digits: d })
    else if (d.length >= 4 && d.length <= 8 && lab('code') && codeShaped(r)) found.push({ kind: 'code', rule: 'spoken-code', first: r.first, last: r.last, digits: d })
    else if (d.length >= 7 && d.length <= 15 && (lab('phone') || /^(?:01[3-9]\d{8}|8801[3-9]\d{8})$/.test(d))) found.push({ kind: 'phone', rule: 'spoken-phone', first: r.first, last: r.last, digits: d })
    else if (d.length >= 6 && d.length <= 20 && lab('id')) found.push({ kind: 'id', rule: 'spoken-id', first: r.first, last: r.last, digits: d })
    else if (d.length >= 9 && d.length <= 15 && opts.anyLongRun) found.push({ kind: 'number', rule: 'spoken-long-number', first: r.first, last: r.last, digits: d })
  }
  // emails said aloud: <1-4 words> at|at the rate|অ্যাট <word> dot <tld> [dot <tld>]
  const W = words.map((w) => bare(w.text))
  const TLDW = new Set(['com', 'net', 'org', 'io', 'co', 'edu', 'gov', 'bd', 'uk', 'in', 'es', 'ai', 'dev', 'me', 'info', 'কম', 'নেট', 'অর্গ'])
  const DOT = new Set(['dot', 'ডট', 'punto', 'डॉट'])
  for (let i = 0; i < W.length; i++) {
    let atLen = 0
    if (W[i] === 'at' || W[i] === 'অ্যাট' || W[i] === 'এট' || W[i] === 'arroba' || W[i] === 'एट') atLen = 1
    if (W[i] === 'at' && W[i + 1] === 'the' && W[i + 2] === 'rate') atLen = 3
    if (!atLen) continue
    let j = i + atLen
    if (j >= W.length) continue
    j++ // domain word
    let dots = 0
    while (j + 1 < W.length && DOT.has(W[j]) && TLDW.has(W[j + 1])) {
      dots++
      j += 2
    }
    if (!dots) continue
    let first = i - 1
    while (first - 1 >= 0 && i - first < 4 && (DOT.has(W[first - 1]) || /^[a-z0-9._-]+$/.test(W[first - 1]) && !/^(is|me|my|email|mail|at|to|write|it's|its)$/.test(W[first - 1]))) first--
    if (first < 0) continue
    found.push({ kind: 'email', rule: 'spoken-email', first, last: j - 1 })
  }
  // a password said after its label: the next words up to a pause of 1 s or 6 words
  for (let i = 0; i < words.length; i++) {
    if (!SPOKEN_LABEL.password.test(words[i].text)) continue
    let j = i + 1
    if (j >= words.length || !SAY_IS.has(bare(words[j].text))) continue // "the password is …", never "password boxes"
    while (j < words.length && SAY_IS.has(bare(words[j].text))) j++
    if (j >= words.length) continue
    let k = j
    while (k + 1 < words.length && k - j < 5 && words[k + 1].start - words[k].end <= 1.0 && !/[.!?।]$/.test(words[k].text)) k++
    found.push({ kind: 'password', rule: 'spoken-password', first: j, last: k })
  }
  return found
}
