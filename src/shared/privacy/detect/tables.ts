/**
 * The tables of the text rules (docs/design/auto-blur.md §6, §7.2; scripts/privacy/detect/RULES.md):
 * label words in English, Bangla, Spanish and Hindi, issuer prefixes, IBAN lengths, the patterns
 * translated from gitleaks v8.30.1 (MIT, resources/notices/40-gitleaks-rules.txt), the allow lists,
 * the spoken number words and the regions of the UI languages. Data only: every regular expression of
 * the rules is here, so the pattern check (scripts/privacy/regexCheck.mjs, test 224) and the time
 * limit test (test 104) see each one. Every Bangla word is written in NFC, the form clean.ts and
 * said.ts compare in (§7.2: য়, ড় and ঢ় stay two code points).
 */
/* ---------- cleaning (§6.2) ---------- */

/** Every dash OCR returns: U+2010-2015, U+2212, U+FE58, U+FE63, U+FF0D. */
export const DASH = /[‐-―−﹘﹣－]/
/** Bullet-like dots, read as '•'. */
export const BULLET = /[•●∙⦁⚫⬤‧・⭘◦]/
/** Zero-width characters and the soft hyphen: removed. */
export const ZERO_WIDTH = /[​-‍⁠﻿­]/
/** Inside a token holding an ASCII letter or digit: slashed and dotted zeros, the multiplication sign, Greek and Cyrillic look-alikes. */
export const LOOKALIKES: Readonly<Record<string, string>> = Object.freeze({
  θ: '0', Θ: '0', ø: '0', Ø: '0', '⊘': '0', '×': 'x',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  ο: 'o', ν: 'v', ρ: 'p'
})
/** OCR confusions read as digits inside a run of digit groups (the digit view). */
export const TO_DIGIT: Readonly<Record<string, string>> = Object.freeze({
  O: '0', o: '0', D: '0', Q: '0', l: '1', I: '1', '|': '1', i: '1', '!': '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6', b: '6', g: '9', q: '9', T: '7'
})
/** Characters a digit group of the digit view may hold. */
export const DIGITISH = /[0-9OoDQlI|i!SsBZzGbgqT]/
/** Separators between the digit groups of one run (at most two in a row). */
export const DIGIT_GROUP_SEP = /[ .\/()-]/
/** Token characters (careful-long's trigger counts runs of these, §5.6). */
export const TOKEN_CHAR = /[A-Za-z0-9_\-+/.~]/
/** A run of 16 or more token characters: careful-long re-reads the line (§5.6, question 16). */
export const LONG_TOKEN_RUN = /[A-Za-z0-9_\-+/.~]{16,}/
/** Token prefixes whose letters OCR confuses with digits ("x0xb-", "AK1A", "Alza"): rewritten in the prefix view. */
export const PREFIXES: readonly string[] = Object.freeze([
  'xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-', 'xoxe-', 'xoxe.', 'xapp-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-', 'glsa_', 'AKIA', 'ASIA',
  'ABIA', 'ACCA', 'AIza', 'sk-ant-', 'sk-proj-', 'sk-', 'sk_live_', 'sk_test_', 'rk_live_', 'rk_test_', 'pk_live_', 'pk_test_', 'whsec_', 'SG.', 'npm_', 'hf_',
  'dop_v1_', 'doo_v1_', 'dor_v1_', 'shpat_', 'shpss_', 'lin_api_', 'ntn_', 'pplx-', 'hvs.', 'dapi', 'PMAK-', 'HRKU-AA', 'eyJ', 'AGE-SECRET-KEY-1', 'pypi-AgEIcHlwaS5vcmc'
])
/** How the prefix view compares a character with a prefix's: the OCR confusions folded together. */
export const PREFIX_FOLD: Readonly<Record<string, string>> = Object.freeze({
  '0': 'o', O: 'o', o: 'o', '1': 'l', l: 'l', I: 'l', i: 'l', '|': 'l', '5': 's', S: 's', s: 's', '8': 'b', B: 'b', b: 'b', '2': 'z', Z: 'z', z: 'z', '9': 'g', g: 'g', _: '_', ' ': '_', '-': '-'
})
/** A character that may start a token in the prefix view. */
export const PREFIX_START = /[A-Za-z0-9|_.-]/
/** What must follow a rewritten prefix: 8 or more token characters. */
export const AFTER_PREFIX = /^[A-Za-z0-9_-]{8}/
/** A link in the URL view: where a single space between two runs of 6+ token characters is a lost '_'. */
export const LINK_START = /(?:https?:\/\/|www\.)[^\s]/g
/** A word of the label view (with two letters in a row, TWO_LETTERS): digits inside it read as the letters they stand for. */
export const LABEL_WORD = /[A-Za-z0-9_]+/g
export const TWO_LETTERS = /[A-Za-z]{2}/

/* ---------- numbers (§6.8) ---------- */

/** Major card networks: [prefix from, prefix to (same length), allowed lengths, network]. Wikipedia "Payment card number". */
export const IIN: readonly (readonly [string, string, readonly number[], string])[] = Object.freeze([
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
] as const)

/** IBAN lengths of the SWIFT registry's countries (89). */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    'AL28 AD24 AT20 AZ28 BH22 BY28 BE16 BA20 BR29 BG22 BI27 CR22 HR21 CY28 CZ24 DK18 DJ27 DO28 TL23 EG29 SV28 EE20 FK18 FO18 FI18 FR27 GE22 DE22 GI23 GR27 GL18 GT28 HN28 HU28 IS26 IQ23 IE22 IL23 IT27 JO30 KZ20 XK20 KW30 LV21 LB28 LY25 LI21 LT20 LU20 MT31 MR27 MU30 MC27 MD24 MN20 ME22 NL18 NI28 MK19 NO15 OM23 PK24 PS29 PL28 PT25 QA29 RO24 RU33 LC32 SM27 ST25 SA24 RS22 SC31 SK24 SI19 SO23 ES24 SD18 SE24 CH21 TN24 TR26 UA29 AE23 GB22 VA22 VG24 YE30'
      .split(' ')
      .map((x) => [x.slice(0, 2), Number(x.slice(2))])
  )
)
/** The OCR swaps an IBAN repair tries after its first four characters. */
export const IBAN_SWAPS: Readonly<Record<string, string>> = Object.freeze({ '0': 'O', O: '0', '1': 'I', I: '1', '5': 'S', S: '5', '8': 'B', B: '8', '2': 'Z', Z: '2', '6': 'G', G: '6' })

/**
 * Published test values and examples: never suggested. Cards and IBANs as written; the AWS
 * documentation's example key id and secret, and the 16 Google API keys gitleaks allows
 * (gitleaks.toml gcp-api-key), are kept as the hash of allowHash so no key-shaped text is stored.
 */
export const ALLOW_VALUES: ReadonlySet<string> = new Set([
  '4242424242424242', '4000056655665556', '5555555555554444', '2223003122003222', '5200828282828210', '5105105105105100', '378282246310005', '371449635398431',
  '6011111111111117', '6011000990139424', '3056930009020004', '36227206271667', '3566002020360505', '6200000000000005', '4111111111111111', '4012888888881881',
  'GB82WEST12345698765432', 'DE89370400440532013000'
])
export const ALLOW_HASHES: ReadonlySet<string> = new Set([
  '15to2nk1milqo', '12ej6b61f7cgj', '0w2v1xj16etbm', '1ur3y4401p7sh', '031k04d1twibg', '0lnvgsr1w1f32', '1f6m3am05v96p', '15pw3d60csu0q', '06qg2sn1wnqap',
  '008hs2w0tekbi', '1cpmqyo0vd76k', '0vojowg1ise7a', '1jo6nl5047h86', '06gxi0c1u6b9d', '1vzpgfm1t9ebr', '0thdmoh1loctk', '13n7kuf1tk7ly', '1d9bsi906xjuh'
])
/** The hash ALLOW_HASHES holds: two FNV-1a rounds of the text, base 36 (not a secret's hash; it only keeps key-shaped text out of the source). */
export function allowHash(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x0100019d) >>> 0
  }
  return (a.toString(36).padStart(7, '0') + b.toString(36).padStart(7, '0')).slice(0, 13)
}
/** Whether a value is an allow-listed example. */
export const isAllowed = (value: string): boolean => ALLOW_VALUES.has(value) || ALLOW_HASHES.has(allowHash(value))

/* ---------- emails (§6.3) ---------- */

/** The strict address: local part, '@', labels and a top-level domain. */
export const EMAIL_STRICT = /(?<![A-Za-z0-9._%+/-])([A-Za-z0-9][A-Za-z0-9._%+-]{0,63})(@)((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,8})([A-Za-z]{2,24})(?![A-Za-z0-9@])/g
/** The OCR-tolerant address: '©' or '®' for '@', a comma, middle dot or space around a dot; tried only where the strict one found nothing. */
export const EMAIL_OCR = /(?<![A-Za-z0-9._%+/-])([A-Za-z0-9][A-Za-z0-9._%+-]{0,63}) ?([@©®]) ?((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])? ?[.,·] ?){1,8})([A-Za-z]{2,24})(?![A-Za-z0-9@])/g
/** Text before an address's local part that puts it inside a link's authority (`scheme://user:` or `scheme://`): a password or a DSN key, not an email. */
export const IN_AUTHORITY = /[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/@]{0,200}$/i
/** Reserved domains (RFC 2606, 6761): a stand-in for an address is still covered, as Check. */
export const EXAMPLE_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/i
/** Role local parts: Check. */
export const ROLE_LOCAL = /^(?:no-?reply|do-?not-?reply|donotreply|notifications?|support|info|hello|contact|sales|admin|postmaster|webmaster|git|team|help|billing|security|privacy|press|jobs|careers|feedback)$/i

/* ---------- labels (en, bn, es, hi) ---------- */

/** Label words per kind, matched on the label view, case-insensitively, as whole words. */
export const LABEL_WORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  password: ['passwords?', 'passwd', 'pwd', 'pass', 'passcode', 'passphrase', 'pass phrase', 'contraseña', 'clave', 'পাসওয়ার্ড', 'পাসওয়ার্ড', 'গোপন ?নম্বর', 'पासवर्ड', 'कूटशब्द', 'network security key', 'wi-?fi password', 'wpa2? key', 'pre-?shared key', 'psk'],
  pin: ['pin', 'pin code', 'pin number', 'পিন', 'पिन', 'nip'],
  code: ['code', 'otp', 'one[- ]time (?:code|password|passcode)', '2fa', 'two[- ]factor', 'verification', 'security code', 'auth(?:entication)? code', 'confirmation code', 'login code', 'sign[- ]in code', 'código', 'কোড', 'ওটিপি', 'যাচাই', 'कोड', 'ओटीपी', 'सत्यापन'],
  phone: ['phone', 'tel', 'telephone', 'mobile', 'cell', 'fax', 'whatsapp', 'call', 'teléfono', 'móvil', 'celular', 'ফোন', 'মোবাইল', 'টেলিফোন', 'फ़ोन', 'फोन', 'मोबाइल'],
  card: ['card', 'card number', 'card no', 'credit card', 'debit card', 'visa', 'mastercard', 'amex', 'tarjeta', 'কার্ড', 'कार्ड'],
  cvv: ['cvv2?', 'cvc2?', 'csc', 'card security code', 'card code'],
  iban: ['iban'],
  key: ['api[ _-]?key', 'apikey', 'secret[ _-]?key', 'client[ _-]?secret', 'access[ _-]?token', 'auth[ _-]?token', 'refresh[ _-]?token', 'bearer', 'personal access token', 'token', 'signing secret', 'webhook secret', 'private key', 'secret access key', 'access key', 'app secret', 'secret', 'credentials?', 'clave de api', 'এপিআই কী', 'টোকেন', 'टोकन'],
  keyShort: ['key', 'setup key', 'secret key', 'this key', 'type this key', 'token', 'read token', 'write token', 'secret', 'api key', 'access key', 'secret access key', 'client secret'],
  recovery: ['recovery codes?', 'backup codes?', 'recovery phrase', 'seed phrase', 'secret recovery phrase', 'mnemonic', 'recovery key', 'রিকভারি কোড', 'códigos de recuperación', 'रिकवरी कोड'],
  id: ['account (?:number|no\\.?|#)', 'acct\\.?(?: no\\.?| #)?', 'a/c', 'customer (?:id|number|no\\.?)', 'member (?:id|number)', 'policy (?:number|no\\.?)', 'passport(?: no\\.?| number)?', "driver'?s licen[cs]e(?: no\\.?| number)?", 'licen[cs]e (?:number|no\\.?)', 'tax id', 'tin', 'ein', 'itin', 'ssn', 'social security(?: number| no\\.?)?', 'national insurance(?: number| no\\.?)?', 'ni number', 'nino', 'nid', 'national id', 'id (?:number|no\\.?)', 'aadhaar', 'pan', 'nhs number', 'medicare', 'routing(?: number)?', 'aba', 'sort code', 'bsb', 'employee id', 'student id', 'payroll id', 'tax file number', 'tfn', 'sin', 'social insurance number', 'dni', 'nie', 'cpf', 'curp', 'rfc', 'número de cuenta', 'cuenta', 'জাতীয় পরিচয়(?:পত্র)?', 'এনআইডি', 'হিসাব নম্বর', 'অ্যাকাউন্ট নম্বর', 'পাসপোর্ট', 'खाता संख्या', 'आधार', 'पैन'],
  licence: ['licen[cs]e key', 'product key', 'serial(?: number| key)?', 'activation (?:key|code)', 'registration (?:key|code)'],
  /** Labels a reference number stands under: a card-shaped number there is Check. */
  reference: ['ref', 'reference', 'order', 'invoice', 'inv', 'tracking', 'ticket', 'serial', 'sku', 'imei', 'iccid', 'isbn', 'ean', 'upc']
})

/** A label pattern: any of `words` as a whole word (group 1), preceded by the start or a non-word character. */
const labelPattern = (words: readonly string[], flags = 'iu'): RegExp => new RegExp('(?:^|[^\\p{L}\\p{N}\\p{M}])(' + words.map((w) => w.normalize('NFC')).join('|') + ')(?![\\p{L}\\p{N}\\p{M}])', flags)

/** One label pattern per kind (no 'g' flag: used with test and exec). */
export const LABELS: Readonly<Record<keyof typeof LABEL_WORDS, RegExp>> = Object.freeze(
  Object.fromEntries(Object.entries(LABEL_WORDS).map(([k, words]) => [k, labelPattern(words)])) as Record<keyof typeof LABEL_WORDS, RegExp>
)
/** The same, global, to list every label on a line. */
export const LABELS_ALL: Readonly<Record<keyof typeof LABEL_WORDS, RegExp>> = Object.freeze(
  Object.fromEntries(Object.entries(LABEL_WORDS).map(([k, words]) => [k, labelPattern(words, 'giu')])) as Record<keyof typeof LABEL_WORDS, RegExp>
)
/** A PIN label as written ("Pin to taskbar" is the verb). */
export const PIN_AS_WRITTEN = /^(?:PIN|পিন|पिन|NIP)$/u

/** After a label: quotes, a separator (`: = ： #`, `no.`) or `is` and its translations, quotes. */
export const LABEL_SEPARATOR = /^["'`]?\s{0,3}(?:([:=：#]|no\.?)|(is|es|হলো|হচ্ছে|है|was)(?![\p{L}\p{N}\p{M}]))?\s{0,3}(?:[:=]\s{0,3})?["'`]?/iu
/** "PIN for the shared phone is 2580": up to five words between the label and `is`. */
export const LABEL_FAR_IS = /^(?:\s{1,3}[\p{L}\p{N}'’-]{1,30}){1,5}?\s{1,3}(is|was|es|হলো|হচ্ছে|है)(?![\p{L}\p{N}\p{M}])\s{0,3}["'`]?/iu
/** Separators an ID value may follow. */
export const ID_SEPARATOR = /^["'`]?\s{0,3}(?:[:=：#]|no\.?)?\s{0,3}/i
/** A short label line's own characters besides the label: `*`, `:`, `•`, brackets and spaces. */
export const LABEL_LINE_EXTRA = /[\s:*•()]/g
/** `pass` counts only at the start of the line or after a user field. */
export const PASS_AFTER_USER = /^\s*$|(?:user(?:name)?|login|id)\s{0,3}[:=]\s{0,3}\S{1,64}[\s,;/|]{0,6}$/i
/** A value's trailing punctuation, removed. */
export const TRAILING_PUNCT = /[,;)\]}'"`]+$/

/** 'code' phrases that are not one-time codes (CODE_NOT), on the line or the label line. */
export const CODE_NOT =
  /\b(?:zip|postal|post|country|area|dial(?:ling)?|error|status|exit|return|source|promo|promotional|discount|coupon|gift|referral|qr|bar|colou?r|hex|http|language|currency|airport|product|item|sku|tax|reason|response|event|key ?code|code (?:of conduct|review|block|editor|snippet|base|signing)|(?:vs|visual studio|claude) code)\b|\bcode\s{0,3}(?:[.:]\s{0,3})?(?:19|20)\d\d\b/i
/** Algorithm and standard names that look like codes (SHA-256, UTF-8, RFC 6238). */
export const ALGORITHM = /^(?:SHA|MD|AES|RSA|UTF|ISO|RFC|CVE|HS|RS|ES|PS|ECDSA|ED|TLS|SSL|HTTP|IPV|X)-?\d/i
/** A code value: an optional letter and dash, then 4-8 digits or two groups of 3-4; or a device code `WDJB-MJ7T`. */
export const CODE_VALUE = /^(?:[A-Z]-)?(?:\d{3,4}[ -]\d{3,4}|\d{4,8})(?![\p{L}\p{N}]|-\d)|^[A-Z0-9]{4}-[A-Z0-9]{4}(?![\p{L}\p{N}])/u
/** The value first: "482913 is your verification code". */
export const CODE_FIRST = /(?<![\p{L}\p{N}])((?:[A-Z]-)?\d{4,8})\s{1,3}(?:is|es|হলো|है)\s{1,3}(?:your|the|tu|su|আপনার|आपका)(?![\p{L}\p{N}\p{M}])/iu
/** A heading number ("2. Save your backup codes"). */
export const HEADING_NUMBER = /^\s{0,3}\d{1,2}[.)]\s/
/** A year. */
export const YEAR = /^(?:19|20)\d\d$/
/** A PIN value. */
export const PIN_VALUE = /^\d{4,8}(?![\p{L}\p{N}]|-\d)/u
/** A recovery code token (on a line in a recovery block): a group pair or a 6-12 run. */
export const RECOVERY_CODE = /(?<![A-Za-z0-9])(?:[A-Za-z0-9]{3,6}[- ][A-Za-z0-9]{3,6}|[A-Za-z0-9]{6,12})(?![A-Za-z0-9])/g
/** A token of a recovery line that is code-shaped. */
export const RECOVERY_TOKEN = /^[A-Za-z0-9-]{3,12}$/

/** Lines that are password UI, not a password field. */
export const PASSWORD_UI = /\b(?:forgot|reset|change|show|hide|confirm your|enter (?:your )?|manager|must|at least|strength|requirements?|policy|incorrect|wrong|invalid|expired|update|new password\?|remember)\b/i
/** Placeholders and words that are not a value. */
export const PLACEHOLDER =
  /^(?:[•*·.x]{1,64}|\*{1,64}|<[^>]{0,64}>?|\$\{[^}]{0,64}\}?|\{\{[^}]{0,64}(?:\}\})?|your[_ -]?\w{1,30}(?:[_ -]here)?|changeme|change[_-]?it|pass|passwd|pwd|user|username|example|dummy|test|sample|redacted|hidden|none|null|undefined|password|secret|token|true|false|enabled|disabled|\d{1,3})$/i
/** Wi-Fi security types and buttons beside a password field: not the password. */
export const NOT_A_PASSWORD = /^(?:WPA\d?(?:-\w{1,12})?|WEP|AES|TKIP|Open|None|Hide|Show|Copy|Edit|Change|Reveal|From the sticker)$/i
/** A value that is code reading a secret from elsewhere, not the secret. */
export const CODE_EXPR = /^(?:[A-Za-z_$][\w$.]{0,80}\s{0,3}[([]|[A-Za-z_$][\w$]{0,40}\.[\w$.]{0,80}[,;)\]}]{0,4}$|\$\{?|%\w{1,40}%|process\.env|os\.environ|getenv|env\.|\/.{0,80}\/[gimsuy]{0,6}[,;)]{0,4}$|.{0,80}\\[bdswnrtSDW])/
/** An identifier written in CamelCase (code after `pass:`), never a password. */
export const CAMEL_IDENTIFIER = /^[A-Za-z_$]{1,64}$/
/** Words that are not a generic key's value. */
export const GENERIC_STOP = /^(?:true|false|null|none|undefined|string|number|boolean|object|function|required|optional|process\.env\.\w{1,40}|env\.\w{1,40}|os\.environ|getenv|config\.[\w.]{1,60}|self\.[\w.]{1,60}|this\.[\w.]{1,60})$/i
/** A value of letters only. */
export const LETTERS_ONLY = /^[A-Za-z_.-]+$/
/** A URL scheme as an assignment's value (`SENTRY_DSN=https://…`). */
export const URL_SCHEME = /^(?:https?|wss?|ftp|file|s3|gs)$/i
/** A path as an assignment's value. */
export const PATH_VALUE = /^\/\/|^\/[\w-]{1,64}\//
/** An environment assignment as a value (`FOO=bar`). */
export const ENV_ASSIGNMENT = /^[A-Z_][A-Z0-9_]{0,64}=/
/** Not a key value: a URL, a file name or a Wi-Fi type. */
export const NOT_A_KEY_VALUE = /^(?:https?:)?\/\/|:\/\/|^[\w.-]{1,64}\/[\w./-]{1,128}\.\w{2,5}$|\.(?:ya?ml|json|env|txt|pem|key|crt|cfg|ini|toml)$|^(?:WPA\d?(?:-\w{1,12})?|WEP|AES|TKIP)$/i
/** An authenticator setup key (base32), grouped in fours or as one run. */
export const OTP_SECRET = /^[A-Z2-7]{4}(?: [A-Z2-7]{4}){3,15}$|^[A-Z2-7]{16,128}$/
/** A label box that ends in `secret/key/token =` (a code label to the left). */
export const KEY_LABEL_BOX = /(?:secret|key|token)\w{0,30}\s{0,3}[:=]\s{0,3}$/i
export const PASSWORD_LABEL_BOX = /(?:password|passwd|pwd)\w{0,30}\s{0,3}[:=]\s{0,3}$/i
/** A CVV label alone on its line, above or beside the value. */
export const CVV_LABEL_LINE = /^\s{0,3}(?:CVV2?|CVC2?|CSC|CVV\/CVC)\s{0,3}:?\s{0,3}$/i
/** A CVV right after its label. */
export const CVV_AFTER = new RegExp(labelPattern(LABEL_WORDS.cvv).source + '\\s{0,3}[:=]?\\s{0,3}(\\d{3,4})(?![\\p{L}\\p{N}])', 'giu')
/** A line that is a value alone: 3-4 digits. */
export const CVV_VALUE_LINE = /^\s{0,3}\d{3,4}\s{0,3}$/

/* ---------- keys and tokens (§6.4, gitleaks v8.30.1 translated) ---------- */

const B = '(?<![A-Za-z0-9_])'
const E = '(?![A-Za-z0-9_])'
const SEP = '[_ -]?'

export interface StrongRule {
  id: string
  pattern: RegExp
  score: number
}

const rule = (id: string, src: string, score: number): StrongRule => ({ id, pattern: new RegExp(src, 'g'), score })

/** The 36 strong rules of §6.4 (RULES.md §4.1), run on the prefix view; 'private-key' is a PEM BEGIN line. */
export const STRONG_RULES: readonly StrongRule[] = Object.freeze([
  // anthropic-api-key (150), anthropic-admin-api-key (144)
  rule('anthropic', B + 'sk-ant-(?:api|admin)0\\d-[A-Za-z0-9_-]{80,100}' + E, 0.98),
  // openai-api-key (2704)
  rule('openai', B + 'sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,200}' + E, 0.98),
  // openai-api-key (2704)
  rule('openai-legacy', B + 'sk-[A-Za-z0-9]{20}T3B[l1I]bkFJ[A-Za-z0-9]{20}' + E, 0.98),
  // the shape of redact.ts (DeepSeek, OpenRouter)
  rule('sk-generic', B + 'sk-(?:or-v1-)?[A-Za-z0-9_-]{24,200}' + E, 0.9),
  // github-pat (2159), github-oauth (2152), github-app-token (2131), github-refresh-token (2170)
  rule('github', B + 'gh[pousr]' + SEP + '[0-9A-Za-z]{34,38}' + E, 0.97),
  // github-fine-grained-pat (2145)
  rule('github-fine', B + 'github' + SEP + 'pat' + SEP + '[0-9A-Za-z_]{80,84}' + E, 0.98),
  // gitlab-pat (2226) and the other gitlab rules
  rule('gitlab', B + 'gl(?:pat|dt|ptt|rt|cbt|soat|ffct|ft|imt|agent|oas)-[0-9A-Za-z_-]{20,200}' + E, 0.97),
  // slack-bot-token (2971), slack-user-token (3022), slack-legacy-token (3002), slack-config-access-token (2978)
  rule('slack', B + 'xox[baprseo]-[0-9A-Za-z-]{10,200}' + E, 0.97),
  // slack-app-token (2964)
  rule('slack-app', B + 'xapp-\\d-[A-Z0-9]{1,32}-\\d{1,20}-[a-z0-9]{1,128}' + E, 0.97),
  // aws-access-token (206)
  rule('aws-id', B + '(?:A3T[A-Z0-9]|AK[I1l]A|ASIA|ABIA|ACCA)[A-Z2-7]{16}' + E, 0.92),
  // gcp-api-key (612)
  rule('google', B + 'A[I1l|]za[0-9A-Za-z_-]{33,37}' + E, 0.97),
  // stripe-access-token (3077)
  rule('stripe', B + '(?:sk|rk)_(?:live|test|prod)_[0-9A-Za-z]{10,99}' + E, 0.97),
  // Stripe webhook signing secret
  rule('stripe-webhook', B + 'whsec_[0-9A-Za-z]{24,200}' + E, 0.97),
  // Stripe publishable key (public by design: Check)
  rule('stripe-pk', B + 'pk_(?:live|test)_[0-9A-Za-z]{10,99}' + E, 0.6),
  // sendgrid-api-token (2855)
  rule('sendgrid', B + 'SG\\.[A-Za-z0-9_-]{20,24}\\.[A-Za-z0-9_-]{40,46}' + E, 0.97),
  // twilio-api-key (3117)
  rule('twilio-key', B + 'SK[0-9a-fA-F]{32}' + E, 0.85),
  // npm-access-token (2659)
  rule('npm', B + 'npm' + SEP + '[A-Za-z0-9]{30,38}' + E, 0.97),
  // pypi-upload-token (2809)
  rule('pypi', B + 'pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,400}' + E, 0.98),
  // huggingface-access-token (2364), digits allowed for OCR
  rule('huggingface', B + 'hf' + SEP + '[A-Za-z0-9]{32,36}' + E, 0.95),
  // azure-ad-client-secret (237)
  rule('azure-ad-secret', '(?<![A-Za-z0-9_~.])[a-zA-Z0-9_~.]{3}\\dQ~[a-zA-Z0-9_~.-]{25,34}', 0.95),
  // digitalocean-pat (408) and its siblings
  rule('digitalocean', B + 'do[pro]_v1_[a-f0-9]{64}' + E, 0.98),
  // shopify-access-token (2918), shopify-shared-secret (2939)
  rule('shopify', B + 'shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}' + E, 0.97),
  // linear-api-key (2478)
  rule('linear', B + 'lin_api_[A-Za-z0-9]{40}' + E, 0.97),
  // notion-api-token (2652)
  rule('notion', B + '(?:ntn_[0-9]{11}[A-Za-z0-9]{35}|secret_[A-Za-z0-9]{43})' + E, 0.95),
  // perplexity-api-key (2718)
  rule('perplexity', B + 'pplx-[A-Za-z0-9]{48}' + E, 0.97),
  // sentry-user-token (2883), sentry-org-token
  rule('sentry', B + 'sntry[su]_[A-Za-z0-9_=+/]{40,400}' + E, 0.95),
  // grafana-service-account-token (2311)
  rule('grafana', B + 'glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}' + E, 0.97),
  // vault-service-token (3173)
  rule('vault', B + 'hvs\\.[A-Za-z0-9_-]{90,120}' + E, 0.97),
  // databricks-api-token (382)
  rule('databricks', B + 'dapi[a-f0-9]{32}(?:-\\d)?' + E, 0.95),
  // postman-api-token (2771)
  rule('postman', B + 'PMAK-[a-fA-F0-9]{24}-[a-fA-F0-9]{34}' + E, 0.97),
  // heroku-api-key-v2 (2351)
  rule('heroku', B + 'HRKU-AA[0-9A-Za-z_-]{58}' + E, 0.97),
  // age-secret-key (106)
  rule('age', B + 'AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}' + E, 0.99),
  // telegram-bot-api-token (3105)
  rule('telegram', '(?:(?<=bot)|(?<![A-Za-z0-9_]))[0-9]{8,10}:AA[A-Za-z0-9_-]{33}' + E, 0.92),
  // jwt (2424)
  rule('jwt', B + 'e[yv][JIl1][A-Za-z0-9_-]{10,2000}\\.e[yv][JIl1][A-Za-z0-9_-]{10,2000}\\.[A-Za-z0-9_-]{10,2000}' + E, 0.93),
  // Azure storage and service bus connection strings
  rule('azure-conn', '(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{30,400}={0,2}', 0.97),
  // private-key (2785): a PEM BEGIN line, dashes not required
  rule('private-key', '(?:^|[\\s"\'-])BEG[I1l]N\\s{1,4}(?:[A-Z0-9]{1,12}\\s{1,4}){0,3}PR[I1l]VATE\\s{1,4}KEY(?:\\s{1,4}BLOCK)?\\b', 0.99)
])
/** A Windows product key (with a digit), and the licence-key values after their label. */
export const PRODUCT_KEY = new RegExp(B + '(?:[BCDFGHJKMPQRTVWXY2346789]{5}-){4}[BCDFGHJKMPQRTVWXY2346789]{5}' + E, 'g')
export const LICENCE_VALUE = /^[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){2,5}(?![A-Za-z0-9])|^[A-Z0-9]{12,40}(?![A-Za-z0-9])/i
/** A strong rule's payload that is a placeholder: XXXX, xxxxxx, 8 zeros, ****, .... */
export const PLACEHOLDER_PAYLOAD = /X{4}|x{6}|0{8}|\*{4}|\.{4}/
/** A PEM END line (dashes optional). */
export const PEM_END = /(?:^|[\s"'-])END\s{1,4}(?:[A-Z0-9]{1,12}\s{1,4}){0,3}PR[I1l]VATE\s{1,4}KEY\b/
/** A JWT head at the end of a line, its third part on later lines (§6.10, new). */
export const JWT_HEAD = /(?<![A-Za-z0-9_-])e[yv][JIl1][A-Za-z0-9_-]{10,2000}\.e[yv][JIl1][A-Za-z0-9_-]{4,2000}\.?[A-Za-z0-9_-]{0,9}$/
/** A strong prefix token followed by one space and 6+ token characters (§6.10 one space in a key). */
export const SPACED_KEY = /(?<![A-Za-z0-9_])((?:sk-(?:proj|ant|svcacct|admin|or)-|gh[pousr]_|github_pat_|glpat-|xox[baprseo]-|AIza|AKIA|hf_|npm_|whsec_|sk_live_|rk_live_|lin_api_|pplx-|dop_v1_|shpat_|glsa_|PMAK-|HRKU-AA|eyJ)[A-Za-z0-9_-]{4,400}) ([A-Za-z0-9_-]{6,400})(?![A-Za-z0-9_])/g
/** The token at the end of a line (for continuation and the wrap join). */
export const TOKEN_AT_END = /[A-Za-z0-9_+/=.-]{6,2000}$/
/** The token at the start of a line. */
export const TOKEN_AT_START = /^\s{0,8}([A-Za-z0-9_+/=.-]{4,2000})/
/** The last one to three characters of a wrapped token, alone on their line but for closing marks (§6.10). */
export const SHORT_TAIL = /^\s{0,8}([A-Za-z0-9_+/=-]{1,3})["'\u2019\u201d`)\]}>]{0,2}\s*$/
/** A plain word, not the rest of a token. */
export const PLAIN_WORD = /^\s{0,8}[A-Za-z]{1,30}[.,:;]?$/

/* ---------- secrets in links (§6.5, the URL view) ---------- */

export interface LinkRule {
  id: string
  pattern: RegExp
  score: number
}
/** Link rules: group 1 is the secret part, the only part covered. */
export const LINK_RULES: readonly LinkRule[] = Object.freeze([
  { id: 'slack-webhook', pattern: /(?:https?:\/\/)?hooks\.slack\.com\/(?:services|workflows|triggers)\/([A-Za-z0-9+/_-]{20,400})/g, score: 0.98 },
  { id: 'discord-webhook', pattern: /discord(?:app)?\.com\/api(?:\/v\d{1,2})?\/webhooks\/(\d{5,30}\/[A-Za-z0-9_-]{20,400})/g, score: 0.98 },
  { id: 'teams-webhook', pattern: /webhook\.office\.com\/webhookb2\/([^\s"'<>]{20,600})/g, score: 0.98 },
  { id: 'google-chat-webhook', pattern: /chat\.googleapis\.com\/v1\/spaces\/[^\s/]{1,64}\/messages\?([^\s"'<>]{1,600})/g, score: 0.98 },
  { id: 'url-userinfo', pattern: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{1,128}:([^\s/@]{3,128})@/gi, score: 0.97 },
  { id: 'url-user-token', pattern: /\b[a-z][a-z0-9+.-]{0,30}:\/\/([A-Za-z0-9]{16,128})@/gi, score: 0.9 },
  { id: 'path-token', pattern: /\/(?:invite|invitation|reset|reset-password|magic|verify|confirm|activate|join|share|s)\/((?=[A-Za-z_-]{0,400}\d)(?=[0-9_-]{0,400}[A-Za-z])[A-Za-z0-9_-]{16,400})/gi, score: 0.9 }
])
/** Webhook paths whose token is cut at the end of a line (group 1 the secret part): they start a continuation (§6.10). */
export const LINK_HEADS: readonly LinkRule[] = Object.freeze([
  { id: 'slack-webhook', pattern: /hooks\.slack\.com\/(?:services|workflows|triggers)\/([A-Za-z0-9+/_-]{1,400})$/, score: 0.98 },
  { id: 'discord-webhook', pattern: /discord(?:app)?\.com\/api(?:\/v\d{1,2})?\/webhooks\/(\d{5,30}\/?[A-Za-z0-9_-]{0,400})$/, score: 0.98 },
  { id: 'teams-webhook', pattern: /webhook\.office\.com\/webhookb2\/([^\s"'<>]{1,600})$/, score: 0.98 }
])
/** Query or fragment parameters whose value is a secret: group 1 the name, group 2 the value. */
export const SECRET_PARAM =
  /[?&#](access_token|id_token|refresh_token|token|auth|auth_token|authorization|api[_-]?key|apikey|key|secret|client_secret|password|passwd|pwd|pass|sig|signature|code|session|sessionid|sid|jwt|otp|reset_token|invite|magic|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|ticket|oobcode|login_token|invite_token|auth_key|secret_key|private_token|access_key|state_token|t_token)=([^&#\s"'<>]{8,600})/gi
/** Parameters that need 16 characters or a digit to count. */
export const WEAK_PARAMS: ReadonlySet<string> = new Set(['code', 'key', 'sid', 'session'])
/** A parameter value that is a template or a mask. */
export const PARAM_PLACEHOLDER = /^(?:\{\{.{0,64}\}\}|<.{0,64}>|\$\{.{0,64}\}|x{1,64}|\*{1,64})$/i
/** An ISO date as a parameter value. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:]{2,12}Z?)?$/
/** CLI secret flags and their value (group 1). */
export const CLI_SECRET_FLAG = /(?:^|\s)(?:--password|--passwd|--pass|--token|--secret|--client-secret|--api-key|--apikey|--access-key|--secret-key|--auth-token|-p)[ =]([^\s"']{8,200}|"[^"]{8,200}"|'[^']{8,200}')/g
/** Lines where `-p` takes a password. */
export const P_FLAG_COMMANDS = /\b(?:login|mysql|mysqladmin|mariadb|sshpass|psql|mongo(?:sh)?|redis-cli|smbclient|rdesktop|xfreerdp)\b/i
/** A flag value that is a port, a file or a variable. */
export const FLAG_NOT_SECRET = /^\d{1,6}(?::\d{1,6}){0,3}$|^[$%]|\.(?:json|ya?ml|toml|js|ts|txt|cfg|conf|ini)\W{0,3}$/i
/** The `-p` flag. */
export const P_FLAG = /^\s?-p\b/

/* ---------- strong labels (§6.6) ---------- */

/** The generic labelled assignment (gitleaks generic-api-key, 638): group 1 the key name, group 2 the value. */
export const ASSIGNMENT =
  /(?:^|[^\p{L}\p{N}_])((?:[\w.-]{0,30}?)(?:api[_.-]?key|apikey|secret|token|passw(?:or)?d|pwd|credential|creds|auth|access[_.-]?key|private[_.-]?key|client[_.-]?secret))(?:[ \t\w.-]{0,20})["']?\s{0,3}(?:=|:|:=|=>|,|\|\|)\s{0,3}["'`]?([A-Za-z0-9_.=+/~-]{8,150})["'`]?/giu

/* ---------- names (§6.11) ---------- */

/** A word of a line, for names. */
export const NAME_WORD = /[\p{L}\p{N}\p{M}'’.-]+/gu
/** Characters a name may hold for looksLikeName: letters, spaces, '.', ''' and '-'. */
export const NAME_LIKE = /^[\p{L}\p{M} .'’-]{1,40}$/u

/* ---------- QR codes (§6.9) ---------- */

export const QR_SECRET = /^(?:otpauth:\/\/|otpauth-migration:\/\/)|discord\.com\/ra\/|s\.team\/q\/|^\d@[^,]{1,200},[^,]{1,200},[^,]{1,200}/is
export const QR_PERSONAL = /^(?:BEGIN:VCARD|MECARD:|mailto:|tel:|sms:|smsto:|geo:)/i
/** A WIFI payload's password field (its fields split on unescaped ';'). */
export const WIFI_PASSWORD = /(?:^WIFI:|;)P:(?:[^;\\]|\\.){1,512}/i

/* ---------- off by default (§6.12) ---------- */

/** Street words (en, es, fr, pl, bn, hi): an address names one with a house number (§6.12). */
export const STREET_WORDS: readonly string[] = Object.freeze([
  'Street', 'St', 'Road', 'Rd', 'Avenue', 'Ave', 'Av', 'Lane', 'Ln', 'Drive', 'Dr', 'Way', 'Court', 'Ct', 'Place', 'Pl', 'Square', 'Sq', 'Boulevard', 'Blvd', 'Row', 'Terrace',
  'Close', 'Crescent', 'Highway', 'Hwy', 'Calle', 'Avenida', 'Paseo', 'Plaza', 'Carrera', 'Rue', 'ul', 'ulica', 'al', 'aleja', 'রোড', 'সড়ক', 'লেন', 'मार्ग', 'रोड', 'गली'
].map((w) => w.normalize('NFC')))
const STREET_ALT = STREET_WORDS.join('|')
/** A house number, up to four words, then a street word ("221B Baker Street", "House 14, Road 7", "8 Rue de Rivoli"). */
export const STREET = new RegExp(`(?<![\\p{L}\\p{N}])\\d{1,5}[A-Za-z]?,?\\s{1,3}(?:[\\p{L}\\p{M}.'-]{1,30}\\s{1,3}){0,4}(?:${STREET_ALT})(?![\\p{L}\\p{N}])\\.?`, 'iu')
/** A street word, up to four words, then a house number ("Calle Mayor 12", "ul. Marszałkowska 84", "Av. Paulista 1000"). */
export const STREET_FIRST = new RegExp(`(?<![\\p{L}\\p{N}])(?:${STREET_ALT})\\.?\\s{1,3}(?:[\\p{L}\\p{M}.'-]{1,30}\\s{1,3}){1,4}\\d{1,5}[A-Za-z]?(?![\\p{L}\\p{N}])`, 'iu')
/** A Japanese block address: chome and ban numbers, then a district ("2-1 Marunouchi, Chiyoda"). */
export const BLOCK_ADDRESS = /(?<![\p{L}\p{N}-])\d{1,4}(?:-\d{1,4}){1,2}\s{1,3}\p{Lu}[\p{L}\p{M}]{2,30},\s{0,3}\p{Lu}[\p{L}\p{M}]{2,30}/u
/** A postcode on the line below a street line: US ZIP with a state, UK postcode, Indian PIN with a label, Spanish 5-digit with a city. */
export const POSTCODE = /\b[A-Z]{2}\s{1,3}\d{5}(?:-\d{4})?\b|\b[A-Z]{1,2}\d[A-Z\d]?\s{1,3}\d[A-Z]{2}\b|\b(?:PIN|Pincode|পিন কোড|पिन कोड)\s{0,3}:?\s{0,3}\d{6}\b|\b\d{5}\s{1,3}[A-ZÁÉÍÓÚÑ][\p{L}]{2,30}/u
/** Four or more bullet-like dots: a masked password. */
export const PASSWORD_DOTS = /^•{4,64}$/
/** A random-looking token (Check, when on): 24 or more token characters. */
export const RANDOM_STRING = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{24,2000}(?![A-Za-z0-9+/_=-])/g

/* ---------- phones (§6.8) ---------- */

/** A phone candidate on the digit view: an optional `+` or `00`, then digits with spaces, brackets, dots and dashes. */
export const PHONE_CANDIDATE = /(?<![\p{L}\p{N}./:-])(\+|00)?\s?(\(?\d[\d\s().-]{5,20}\d)(?![\p{L}\p{N}]|[./:]\d)/gu
/** Dates, IPv4 addresses and times. */
export const PHONE_NOT = /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$|^\d{1,3}(?:\.\d{1,3}){3}$|^\d{1,2}:\d{2}/
/** A decimal number. */
export const DECIMAL = /(?:^|[^\d])\.\d|-\.|\d\.\d(?:[^\d]|$)/
/** Words on a line that make a bare mobile number something else. */
export const NOT_PHONE_LINE = /\b(?:order|invoice|inv|ticket|ref|reference|tracking|sku|account|acct|serial|build|version|id)\b|#/i
/** A card candidate on the digit view: 12-19 digits with single spaces or dashes. */
export const CARD_CANDIDATE = /(?<![\p{L}\p{N}.,/-])\d(?:[ -]?\d){11,18}(?![\p{L}\p{N}]|[.,/-]\d)/gu
/** An IBAN as written, upper case. */
export const IBAN_CANDIDATE = /(?<![A-Za-z0-9])([A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{1,4}){3,9})(?![A-Za-z0-9])/g
/** A US social security number on the digit view. */
export const SSN = /(?<![\p{L}\p{N}-])(\d{3})([- ])(\d{2})\2(\d{4})(?![\p{L}\p{N}]|-\d)/gu
/** A UK National Insurance number as written (HMRC NIM39110). */
export const NINO = /(?<![A-Za-z0-9])((?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]) ?(\d{2}) ?(\d{2}) ?(\d{2}) ?([A-D])(?![A-Z0-9])/g
/** An ID value after its label. */
export const ID_VALUE = /^[A-Z0-9][A-Z0-9 -]{3,28}[A-Z0-9](?![A-Za-z0-9])/i

/** The region of each UI language for phone numbers (§0 decision 2): English adds none. */
export const LANGUAGE_REGION: Readonly<Record<string, string>> = Object.freeze({ bn: 'BD', hi: 'IN', es: 'ES' })

/* ---------- speech (§7.2) ---------- */

/** Words that say one digit or one number, in English, Bangla (and English digits in Bangla script), Spanish and Hindi. */
export const SAID_DIGITS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    (
      [
        ['zero', '0'], ['oh', '0'], ['o', '0'], ['nought', '0'], ['nil', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'], ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'],
        ['ten', '10'], ['eleven', '11'], ['twelve', '12'], ['thirteen', '13'], ['fourteen', '14'], ['fifteen', '15'], ['sixteen', '16'], ['seventeen', '17'], ['eighteen', '18'], ['nineteen', '19'],
        ['শূন্য', '0'], ['এক', '1'], ['দুই', '2'], ['দু', '2'], ['তিন', '3'], ['চার', '4'], ['পাঁচ', '5'], ['ছয়', '6'], ['ছ', '6'], ['সাত', '7'], ['আট', '8'], ['নয়', '9'],
        ['জিরো', '0'], ['ওয়ান', '1'], ['টু', '2'], ['থ্রি', '3'], ['ফোর', '4'], ['ফাইভ', '5'], ['সিক্স', '6'], ['সেভেন', '7'], ['এইট', '8'], ['নাইন', '9'],
        ['cero', '0'], ['uno', '1'], ['una', '1'], ['dos', '2'], ['tres', '3'], ['cuatro', '4'], ['cinco', '5'], ['seis', '6'], ['siete', '7'], ['ocho', '8'], ['nueve', '9'],
        ['शून्य', '0'], ['एक', '1'], ['दो', '2'], ['तीन', '3'], ['चार', '4'], ['पांच', '5'], ['पाँच', '5'], ['छह', '6'], ['छः', '6'], ['सात', '7'], ['आठ', '8'], ['नौ', '9']
      ] as const
    ).map(([w, d]) => [w.normalize('NFC'), d])
  )
)
/** English tens: a tens word alone is x0; with a ones word after it ("twenty five") one number. */
export const SAID_TENS: Readonly<Record<string, string>> = Object.freeze({ twenty: '2', thirty: '3', forty: '4', fifty: '5', sixty: '6', seventy: '7', eighty: '8', ninety: '9' })
/** "twenty-five" written as one token. */
export const SAID_TENS_HYPHEN = /^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(one|two|three|four|five|six|seven|eight|nine)$/
/** `double five`, `triple one`. */
export const SAID_REPEAT: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries((
    [['double', 2], ['triple', 3], ['ডাবল', 2], ['ট্রিপল', 3], ['doble', 2], ['डबल', 2], ['ट्रिपल', 3]] as const
  ).map(([w, n]) => [w.normalize('NFC'), n]))
)
/** Fillers kept inside a run of digits (`and` is not one: it ends a run, §7.2). */
export const SAID_FILLERS: ReadonlySet<string> = new Set(['um', 'uh', 'erm', 'then', 'dash', 'hyphen', 'space', 'comma', 'is', 'উম', 'আর', 'ড্যাশ', 'y', 'guion', 'guión'].map((w) => w.normalize('NFC')))
/** Words that are zero only inside a run. */
export const ZERO_INSIDE_ONLY: ReadonlySet<string> = new Set(['oh', 'o'])
/** A version number said as one token ("44.9.3"): no digits. */
export const VERSION_TOKEN = /^\d{1,6}\.\d{1,6}\.\d/
/** A digit token with dashes or dots between groups ("4111-1111", "4111."). */
export const DIGIT_TOKEN = /^\d{1,30}(?:[-.]\d{1,30}){0,8}[.,]?$/

/** Label words said before a run (the 12 words or 10 s before it), per kind. */
export const SAID_LABELS: Readonly<Record<'card' | 'code' | 'phone' | 'id' | 'password', RegExp>> = Object.freeze({
  card: /\b(?:card|credit|debit|visa|mastercard|amex)\b|কার্ড|tarjeta|कार्ड/iu,
  code: /\b(?:code|otp|verification|passcode|pin)\b|কোড|ওটিপি|পিন|código|कोड|ओटीपी|पिन/iu,
  phone: /\b(?:phone|number|call|mobile|cell|whatsapp)\b|ফোন|মোবাইল|নম্বর|নাম্বার|teléfono|número|फ़ोन|फोन|नंबर|मोबाइल/iu,
  id: /\b(?:social security|ssn|account|routing|passport|licen[cs]e|national insurance|aadhaar|nid)\b|অ্যাকাউন্ট|হিসাব|পাসপোর্ট|এনআইডি|cuenta|खाता|आधार/iu,
  password: /\b(?:password|passphrase|passcode)\b|পাসওয়ার্ড|পাসওয়ার্ড|contraseña|पासवर्ड/iu
})
/** Words after a password word that say its value follows. */
export const SAID_IS: ReadonlySet<string> = new Set(['is', 'was', '=', ':', 'হলো', 'হল', 'হচ্ছে', 'es', 'है', 'its', "it's"].map((w) => w.normalize('NFC')))
/** The end of a sentence. */
export const SENTENCE_END = /[.!?।]$/
/** A Bangladeshi mobile said with no label. */
export const BD_MOBILE = /^(?:01[3-9]\d{8}|8801[3-9]\d{8})$/
/** `at`, `at the rate` and their translations in an address said aloud. */
export const SAID_AT: ReadonlySet<string> = new Set(['at', 'অ্যাট', 'এট', 'arroba', 'एट'].map((w) => w.normalize('NFC')))
export const SAID_DOT: ReadonlySet<string> = new Set(['dot', 'ডট', 'punto', 'डॉट'].map((w) => w.normalize('NFC')))
export const SAID_TLDS: ReadonlySet<string> = new Set(['com', 'net', 'org', 'io', 'co', 'edu', 'gov', 'bd', 'uk', 'in', 'es', 'ai', 'dev', 'me', 'info', 'কম', 'নেট', 'অর্গ'].map((w) => w.normalize('NFC')))
/** Words before `at` that are not part of the address. */
export const SAID_ADDRESS_STOP = /^(?:is|me|my|email|mail|at|to|write|it's|its|or|and)$/
/** A word that can be part of an address said aloud. */
export const SAID_ADDRESS_WORD = /^[a-z0-9._-]{1,64}$/
/** Punctuation and symbols at a word's ends (vowel signs and the nukta are marks, never stripped). */
export const WORD_EDGES = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu
/** A Latin word, for double metaphone. */
export const LATIN_WORD = /^[A-Za-z][A-Za-z'’-]*$/
/** A Bangla word. */
export const BANGLA_WORD = /[ঀ-৿]/

/* ---------- every pattern (tests 104 and 224) ---------- */

/** Every regular expression of the rules, named. */
export function everyPattern(): { name: string; pattern: RegExp }[] {
  const out: { name: string; pattern: RegExp }[] = []
  const own: Record<string, unknown> = {
    DASH, BULLET, ZERO_WIDTH, DIGITISH, DIGIT_GROUP_SEP, TOKEN_CHAR, LONG_TOKEN_RUN, PREFIX_START, AFTER_PREFIX, LINK_START, LABEL_WORD, TWO_LETTERS, EMAIL_STRICT, EMAIL_OCR, IN_AUTHORITY, EXAMPLE_DOMAIN, ROLE_LOCAL,
    PIN_AS_WRITTEN, LABEL_SEPARATOR, LABEL_FAR_IS, ID_SEPARATOR, LABEL_LINE_EXTRA, PASS_AFTER_USER, TRAILING_PUNCT, CODE_NOT, ALGORITHM, CODE_VALUE, CODE_FIRST, HEADING_NUMBER, YEAR,
    PIN_VALUE, RECOVERY_CODE, RECOVERY_TOKEN, PASSWORD_UI, PLACEHOLDER, NOT_A_PASSWORD, CODE_EXPR, CAMEL_IDENTIFIER, GENERIC_STOP, LETTERS_ONLY, URL_SCHEME, PATH_VALUE, ENV_ASSIGNMENT,
    NOT_A_KEY_VALUE, OTP_SECRET, KEY_LABEL_BOX, PASSWORD_LABEL_BOX, CVV_LABEL_LINE, CVV_AFTER, CVV_VALUE_LINE, PRODUCT_KEY, LICENCE_VALUE, PLACEHOLDER_PAYLOAD, PEM_END, JWT_HEAD, SPACED_KEY,
    TOKEN_AT_END, TOKEN_AT_START, SHORT_TAIL, PLAIN_WORD, SECRET_PARAM, PARAM_PLACEHOLDER, ISO_DATE, CLI_SECRET_FLAG, P_FLAG_COMMANDS, FLAG_NOT_SECRET, P_FLAG, ASSIGNMENT, NAME_WORD, NAME_LIKE, QR_SECRET,
    QR_PERSONAL, WIFI_PASSWORD, STREET, STREET_FIRST, BLOCK_ADDRESS, POSTCODE, PASSWORD_DOTS, RANDOM_STRING, PHONE_CANDIDATE, PHONE_NOT, DECIMAL, NOT_PHONE_LINE, CARD_CANDIDATE, IBAN_CANDIDATE, SSN, NINO, ID_VALUE,
    SAID_TENS_HYPHEN, VERSION_TOKEN, DIGIT_TOKEN, SENTENCE_END, BD_MOBILE, SAID_ADDRESS_STOP, SAID_ADDRESS_WORD, WORD_EDGES, LATIN_WORD, BANGLA_WORD
  }
  for (const [name, p] of Object.entries(own)) if (p instanceof RegExp) out.push({ name, pattern: p })
  for (const [k, p] of Object.entries(LABELS)) out.push({ name: `LABELS.${k}`, pattern: p })
  for (const [k, p] of Object.entries(LABELS_ALL)) out.push({ name: `LABELS_ALL.${k}`, pattern: p })
  for (const [k, p] of Object.entries(SAID_LABELS)) out.push({ name: `SAID_LABELS.${k}`, pattern: p })
  for (const r of STRONG_RULES) out.push({ name: `STRONG_RULES.${r.id}`, pattern: r.pattern })
  for (const r of LINK_RULES) out.push({ name: `LINK_RULES.${r.id}`, pattern: r.pattern })
  for (const r of LINK_HEADS) out.push({ name: `LINK_HEADS.${r.id}`, pattern: r.pattern })
  return out
}
