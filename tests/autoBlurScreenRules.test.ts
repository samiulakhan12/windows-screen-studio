import { describe, expect, it } from 'vitest'
import { DEFAULT_KINDS, PRIVATE_KINDS } from '../src/shared/privacy/kinds'
import { classQr } from '../src/shared/privacy/detect/qr'
import { detectFrame } from '../src/shared/privacy/detect/detect'
import { compileNames, NO_NAMES } from '../src/shared/privacy/detect/names'
import { STRONG_RULES } from '../src/shared/privacy/detect/tables'
import type { PrivateKind } from '../src/shared/types'
import { FRAME, hitsOn, line, loadTruth, screenProblems, token, VECTORS } from './autoBlurRulesFixtures'

/*
 * Auto-blur P3: the screen's text rules one by one (docs/design/auto-blur.md §6.3-6.12, tests 107-109
 * and 111-124; phones are test 110, in autoBlurPhones.test.ts). Token-shaped values are made at run
 * time from seeded placeholders.
 */

const texts = (text: string, opts?: Parameters<typeof hitsOn>[1]): string[] => hitsOn(text, opts).map((h) => `${h.kind}:${h.tier}:${h.text}`)

/** A number with its Luhn check digit added. */
function withLuhn(body: string): string {
  for (let d = 0; d < 10; d++) {
    const n = body + d
    let sum = 0
    for (let i = 0; i < n.length; i++) {
      let v = Number(n[n.length - 1 - i])
      if (i % 2) v = v * 2 > 9 ? v * 2 - 9 : v * 2
      sum += v
    }
    if (sum % 10 === 0) return n
  }
  throw new Error('no digit')
}
const group4 = (d: string): string => d.replace(/(\d{4})(?=\d)/g, '$1 ')

/** An IBAN with its check digits computed (mod 97). */
function iban(country: string, bban: string): string {
  const num = (s: string): string => [...s].map((c) => (/[0-9]/.test(c) ? c : String(c.charCodeAt(0) - 55))).join('')
  let rem = 0
  for (const d of num(bban + country + '00')) rem = (rem * 10 + Number(d)) % 97
  return country + String(98 - rem).padStart(2, '0') + bban
}

describe('auto-blur P3: the screen rules', () => {
  it('107. emails: strict before tolerant; the TLD list; role and reserved addresses at 0.60; git@host:, @2x.png and @types/node are not emails', () => {
    expect(texts('From: jane.doe@acme-mail.io')).toEqual(['email:auto:jane.doe@acme-mail.io'])
    // Strict first: the tolerant pattern would swallow " · Sales" as a domain.
    expect(texts('Write to priya.raman@acme-cloud.io · Sales team')).toEqual(['email:auto:priya.raman@acme-cloud.io'])
    // Tolerant where the strict one finds nothing: © for @, a comma for a dot.
    expect(texts('riad.hasan©gmail.com')).toEqual(['email:check:riad.hasan©gmail.com'])
    expect(texts('riad.hasan@gmail,com')).toEqual(['email:check:riad.hasan@gmail,com'])
    // The top-level domain must be in Flown's lists.
    expect(texts('jane@acme.notarealtld')).toEqual([])
    // Role and reserved addresses: Check.
    expect(hitsOn('support@acme-cloud.io')[0]).toMatchObject({ kind: 'email', score: 0.6 })
    expect(hitsOn('jane@example.com')[0]).toMatchObject({ kind: 'email', score: 0.6 })
    expect(hitsOn('jane@contoso.test')[0]).toMatchObject({ kind: 'email', score: 0.6 })
    // Not emails.
    for (const t of ['git@github.com:owner/repo.git', 'icon@2x.png', 'npm i @types/node', 'ssh admin@PRINTER', 'https://abcdef0123456789abcdef0123456789@o1.ingest.sentry.io/1'])
      expect(hitsOn(t).filter((h) => h.kind === 'email'), t).toEqual([])
  })

  it('108. cards: grouping, Luhn and issuer; merged groups; a reference label gives 0.60; a Luhn failure only with a card label; test numbers and masked cards skipped', () => {
    const visa = withLuhn('491761234567890')
    const amex = withLuhn('37828224631001')
    // Grouping: none, one kind of separator in fours, Amex 4-6-5; mixed separators are not a card.
    expect(hitsOn(group4(visa))[0]).toMatchObject({ kind: 'card', score: 0.96, text: group4(visa) })
    expect(hitsOn(visa)[0]).toMatchObject({ kind: 'card', score: 0.88 })
    expect(hitsOn(`${amex.slice(0, 4)} ${amex.slice(4, 10)} ${amex.slice(10)}`)[0]).toMatchObject({ kind: 'card', rule: 'card-luhn:amex' })
    expect(hitsOn(`${visa.slice(0, 4)}-${visa.slice(4, 8)} ${visa.slice(8, 12)} ${visa.slice(12)}`)).toEqual([])
    // OCR dropped a space: 4-8-4 is groups of fours merged.
    expect(hitsOn(`${visa.slice(0, 4)} ${visa.slice(4, 12)} ${visa.slice(12)}`)[0]).toMatchObject({ kind: 'card', score: 0.96 })
    // Luhn: a failing number without a card label is nothing; with one, 4-4-4-4 and a prefix, Check.
    const bad = visa.slice(0, 15) + ((Number(visa[15]) + 1) % 10)
    expect(hitsOn(group4(bad))).toEqual([])
    expect(hitsOn('Card number: ' + group4(bad))[0]).toMatchObject({ kind: 'card', rule: 'card-misread', score: 0.8 })
    // Issuer: a Luhn-valid number with no network's prefix is not a card.
    expect(hitsOn(group4(withLuhn('999912345678901')))).toEqual([])
    // A reference label: Check.
    expect(hitsOn('Ref ' + group4(visa))[0]).toMatchObject({ kind: 'card', score: 0.6 })
    expect(hitsOn('Order #' + visa)[0]).toMatchObject({ kind: 'card', score: 0.6 })
    // Test numbers and masked cards are skipped; CVV with its label is found.
    expect(hitsOn('4242 4242 4242 4242')).toEqual([])
    expect(hitsOn('Visa •••• •••• •••• 4242')).toEqual([])
    expect(texts('CVV: 381')).toEqual(['card:auto:381'])
  })

  it('109. IBAN: lengths, mod 97, one and two swaps at 0.85, lower case refused, published examples skipped', () => {
    const de = iban('DE', '370400440532013019')
    const spaced = de.replace(/(.{4})(?=.)/g, '$1 ')
    expect(hitsOn(spaced)[0]).toMatchObject({ kind: 'card', rule: 'iban', score: 0.97, text: spaced })
    expect(hitsOn('IBAN ' + iban('GB', 'NWBK60161331926819'))[0]).toMatchObject({ rule: 'iban', score: 0.97 })
    // Lengths: too short for its country, or a country outside the registry.
    expect(hitsOn(de.slice(0, 20))).toEqual([])
    expect(hitsOn('ZZ' + de.slice(2))).toEqual([])
    // One swap (0 read as O) and two swaps repair to 0.85; a failing number with an IBAN label is Check.
    const zero = de.indexOf('0', 4)
    const one = de.slice(0, zero) + 'O' + de.slice(zero + 1)
    expect(hitsOn(one)[0]).toMatchObject({ rule: 'iban-repaired', score: 0.85 })
    const second = one.indexOf('0', zero + 1)
    const two = one.slice(0, second) + 'O' + one.slice(second + 1)
    expect(hitsOn(two)[0]).toMatchObject({ rule: 'iban-repaired', score: 0.85 })
    const broken = de.slice(0, 21) + ((Number(de[21]) + 3) % 10)
    expect(hitsOn(broken)).toEqual([])
    expect(hitsOn('IBAN: ' + broken)[0]).toMatchObject({ rule: 'iban-labelled', score: 0.75 })
    // Lower case is never an IBAN; the published examples are skipped.
    expect(hitsOn(de.toLowerCase())).toEqual([])
    expect(hitsOn('GB82 WEST 1234 5698 7654 32')).toEqual([])
    expect(hitsOn('DE89 3704 0044 0532 0130 00')).toEqual([])
  })

  it('111. IDs: SSN exclusions, NI prefixes, labelled IDs beside, after and under, every label on a line, product and licence keys', () => {
    expect(hitsOn('123-45-6789')[0]).toMatchObject({ kind: 'id', rule: 'ssn', score: 0.85 })
    expect(hitsOn('SSN: 123-45-6789')[0]).toMatchObject({ kind: 'id', rule: 'ssn', score: 0.95 })
    for (const t of ['000-45-6789', '666-45-6789', '912-45-6789', '123-00-6789', '123-45-0000']) expect(hitsOn(t), t).toEqual([])
    expect(texts('NI number AB 12 34 56 C')).toEqual(['id:auto:AB 12 34 56 C'])
    for (const t of ['QQ 12 34 56 C', 'GB 12 34 56 C', 'AO 12 34 56 C', 'AB 12 34 56 E', 'ab123456c']) expect(hitsOn(t).filter((h) => h.rule === 'uk-nino'), t).toEqual([])
    // After, under and beside an ID label; every label on a line.
    expect(texts('Account number: 12345678')).toEqual(['id:auto:12345678'])
    expect(texts('CU-55102931', { above: 'Customer ID' })).toEqual(['id:auto:CU-55102931'])
    expect(texts('P4471029', { left: ['Passport'] })).toEqual(['id:auto:P4471029'])
    expect(texts('Employee ID: EMP-002931 · Payroll ID: PR-55102')).toEqual(['id:auto:EMP-002931', 'id:auto:PR-55102'])
    // A label followed by words is nothing.
    expect(hitsOn('Account number must have 10 digits')).toEqual([])
    // Windows product keys (kind key) and licence keys after their label.
    expect(texts('Product key: BCDF2-GHJKM-PQRT3-VWXY4-6789B')).toEqual(['key:auto:BCDF2-GHJKM-PQRT3-VWXY4-6789B'])
    expect(texts('BCDFG-HJKMP-QRTVW-XYBCD-FGHJK')).toEqual([])
    expect(texts('Licence key: ABCD-1234-EFGH-5678')).toEqual(['id:auto:ABCD-1234-EFGH-5678'])
  })

  /** A positive token of each strong rule (placeholders: a class letter and a count, see autoBlurRulesFixtures). */
  const POSITIVE: Record<string, string> = {
    anthropic: '«=sk-ant-api03-|B90»',
    openai: '«=sk-proj-|B48»',
    'openai-legacy': '«=sk-|A20»T3BlbkFJ«A20»',
    'sk-generic': '«=sk-or-v1-|a40»',
    github: '«=ghp_|A36»',
    'github-fine': '«=github_pat_|A22»_«A59»',
    gitlab: '«=glpat-|B20»',
    slack: '«=xoxb-|D11»-«D12»-«A24»',
    'slack-app': '«=xapp-1-|U11»-«D13»-«H64»',
    'aws-id': '«=AKIA|U16»',
    google: '«=AIza|B35»',
    stripe: '«=sk_live_|A24»',
    'stripe-webhook': '«=whsec_|A32»',
    'stripe-pk': '«=pk_live_|A24»',
    sendgrid: '«=SG.|B22».«B43»',
    'twilio-key': '«=SK|H32»',
    npm: '«=npm_|A36»',
    pypi: '«=pypi-AgEIcHlwaS5vcmc|B60»',
    huggingface: '«=hf_|A34»',
    'azure-ad-secret': '«A3»7Q~«A30»',
    digitalocean: '«=dop_v1_|H64»',
    shopify: '«=shpat_|H32»',
    linear: '«=lin_api_|A40»',
    notion: '«=ntn_|D11»«A35»',
    perplexity: '«=pplx-|A48»',
    sentry: '«=sntrys_|A60»',
    grafana: '«=glsa_|A32»_«H8»',
    vault: '«=hvs.|B100»',
    databricks: '«=dapi|H32»',
    postman: '«=PMAK-|H24»-«H34»',
    heroku: '«=HRKU-AA|B58»',
    age: '«=AGE-SECRET-KEY-1|U58»',
    telegram: '«D10»:AA«B33»',
    jwt: '«=eyJ|B20».«=eyJ|B30».«B43»',
    'azure-conn': '«=AccountKey=|S44»==',
    'private-key': '-----BEGIN RSA PRIVATE KEY-----'
  }

  it('112. strong prefixes: each of the 36 rules with a positive and a placeholder negative; …EXAMPLE and the allow list skipped', () => {
    expect(STRONG_RULES.map((r) => r.id).sort()).toEqual(Object.keys(POSITIVE).sort())
    expect(STRONG_RULES).toHaveLength(36)
    for (const r of STRONG_RULES) {
      const tok = token(POSITIVE[r.id], 7).replace(/^AGE-SECRET-KEY-1([A-Z2-7]{58})$/, (_m, b: string) => 'AGE-SECRET-KEY-1' + b.replace(/[BIO1]/g, 'Q'))
      const hits = hitsOn(`value ${tok} end`)
      const hit = hits.find((h) => h.kind === 'key')
      expect(hit, r.id).toBeDefined()
      expect(hit!.rule.replace(/-(?:lost|block)$/, ''), r.id).toBe(r.id)
      if (r.id === 'private-key') continue
      expect(hit!.text, r.id).toBe(tok)
      // The placeholder negative: the same shape with every made-up character 0 (X where 0 is not allowed); the pattern still matches it.
      const neg = POSITIVE[r.id].replace(/«([^»]*)»/g, (_m, body: string) =>
        body
          .split('|')
          .map((item) => (item.startsWith('=') ? item.slice(1) : (item[0] === 'U' ? 'X' : '0').repeat(Number(item.slice(1)))))
          .join('')
      )
      expect(new RegExp(r.pattern.source).test(neg), r.id).toBe(true)
      expect(hitsOn(`value ${neg} end`).filter((h) => h.kind === 'key'), r.id).toEqual([])
    }
    // A public key or a certificate is not a private key.
    expect(hitsOn('-----BEGIN PUBLIC KEY-----')).toEqual([])
    expect(hitsOn('-----BEGIN CERTIFICATE-----')).toEqual([])
    // AWS's documentation ids and the allow list are skipped.
    expect(hitsOn('AKIA' + 'ABCDEFGHI' + 'EXAMPLE')).toEqual([])
    expect(hitsOn('AIzaSy' + 'abcdefghijklmnopqrstuvwxyz1234567')).toEqual([])
    expect(hitsOn('AIzaSy' + 'abcdefghijklmnopqrstuvwxyz1234568')[0]).toMatchObject({ kind: 'key', rule: 'google' })
  })

  it('113. PEM: a block from BEGIN to END at full width; BEGIN and END widened by five characters; no END gives a lost area to the region’s bottom', () => {
    const body = Array.from({ length: 4 }, (_v, i) => token(`«S${i === 3 ? 40 : 64}»`, 11 + i))
    const lines = [line('-----BEGIN PRIVATE KEY-----', 100, 200), ...body.map((b, i) => line(b, 100, 224 + 24 * i)), line('-----END PRIVATE KEY-----', 100, 320), line('Next steps', 100, 360)]
    const hits = detectFrame(lines, [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })
    expect(hits).toHaveLength(1)
    const [h] = hits
    expect(h).toMatchObject({ kind: 'key', rule: 'private-key-block', score: 0.99 })
    expect(h.spans.map((s) => s.line)).toEqual([0, 1, 2, 3, 4, 5])
    expect(h.lost).toBeUndefined()
    // The full width of the block: the widest body line, and the BEGIN line widened by five characters.
    const pad = Math.max(3, 0.35 * 20)
    expect(h.box[0]).toBeCloseTo(100 - 5 * 10 - 10, 5)
    expect(h.box[0] + h.box[2]).toBeCloseTo(100 + 64 * 10 + 10, 5)
    expect(h.box[1]).toBeCloseTo(200 - pad, 5)
    expect(h.box[1] + h.box[3]).toBeCloseTo(340 + pad, 5)
    // BEGIN and END widened by five characters past a narrow body.
    const narrow = [line('-----BEGIN PRIVATE KEY-----', 100, 200), line(token('«S12»', 3), 100, 224), line('-----END PRIVATE KEY-----', 100, 248)]
    const [n] = detectFrame(narrow, [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })
    expect(n.box[0] + n.box[2]).toBeCloseTo(100 + 27 * 10 + 5 * 10 + 10, 5)
    // No END line: a lost area from BEGIN to the frame's bottom, at least a body line wide.
    const open = [line('-----BEGIN OPENSSH PRIVATE KEY-----', 100, 200), line(token('«S64»', 5), 100, 224)]
    const [o] = detectFrame(open, [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })
    expect(o).toMatchObject({ rule: 'private-key-lost', lost: true })
    expect(o.box[1] + o.box[3]).toBe(FRAME.height)
    expect(o.box[0] + o.box[2]).toBeGreaterThanOrEqual(100 + 64 * 10)
    // BEGIN and END with nothing read between them: a lost area too.
    const empty = [line('-----BEGIN PRIVATE KEY-----', 100, 200), line('-----END PRIVATE KEY-----', 100, 224)]
    expect(detectFrame(empty, [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })[0]).toMatchObject({ rule: 'private-key-lost', lost: true })
    // A BEGIN marker read apart from the JSON key before it, the body at the row's left: the block runs
    // on under the row, across the body's width, to its END line (the small editor at 200%).
    const json = [line('"PrivateKey": "', 100, 200), line('-----BEGIN PRIVATE KEY-----\\n', 300, 200), ...body.slice(0, 3).map((b, i) => line(b + '\\n', 60, 224 + 24 * i)), line('-----END PRIVATE KEY-----', 60, 296)]
    const [j] = detectFrame(json, [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME }).filter((x) => x.kind === 'key')
    expect(j).toMatchObject({ rule: 'private-key-block' })
    expect(j.lost).toBeUndefined()
    expect(j.box[0]).toBeLessThanOrEqual(60)
    expect(j.box[0] + j.box[2]).toBeGreaterThanOrEqual(60 + 66 * 10)
  })

  it('114. links: each webhook, userinfo, DSN, query parameter and path token; tsc -p and docker -p are not secrets', () => {
    const slack = token('«=T|A8»/«=B|A10»/«A24»', 2)
    expect(texts(`https://hooks.slack.com/services/${slack}`)).toEqual([`link:auto:${slack}`])
    const discord = token('«D18»/«B68»', 3)
    expect(texts(`https://discord.com/api/webhooks/${discord}`)).toEqual([`link:auto:${discord}`])
    const teams = token('«H8»-«H4»@«H8»/IncomingWebhook/«H32»', 4)
    expect(texts(`https://acme.webhook.office.com/webhookb2/${teams}`)).toEqual([`link:auto:${teams}`])
    const chat = token('key=«B39»&token=«B43»', 5)
    expect(hitsOn(`https://chat.googleapis.com/v1/spaces/AAAA1234/messages?${chat}`).some((h) => h.kind === 'link' && h.rule === 'google-chat-webhook')).toBe(true)
    // userinfo: only the password; a DSN: only the key.
    expect(texts('postgres://admin:Hn8wQ4zLk2@db.acme.io:5432/app')).toEqual(['link:auto:Hn8wQ4zLk2'])
    expect(texts('postgres://user:password@localhost/app')).toEqual([])
    const dsn = token('«H32»', 6)
    expect(texts(`https://${dsn}@o4507.ingest.sentry.io/123`)).toEqual([`link:auto:${dsn}`])
    // Query parameters and path tokens.
    const q = token('«B32»', 8)
    expect(texts(`https://app.acme.io/auth?state=ok&access_token=${q}`)).toEqual([`link:auto:${q}`])
    expect(texts(`https://s3.amazonaws.com/b/f.pdf?X-Amz-Signature=${q}`)).toEqual([`link:auto:${q}`])
    expect(texts('https://youtube.com/watch?v=dQw4w9WgXcQ&t=42')).toEqual([])
    expect(texts('https://api.acme.io/items?page=2&code=en')).toEqual([])
    const p = token('«a10»7«a10»', 9)
    expect(texts(`https://acme.io/reset/${p}`)).toEqual([`link:auto:${p}`])
    // CLI flags: -p only where it takes a password.
    expect(texts('mysql -u root -p S3cr3tPassw0rd!')).toEqual(['key:auto:S3cr3tPassw0rd!'])
    expect(texts('tsc -p tsconfig.web.json')).toEqual([])
    expect(texts('docker run -p 8080:80 nginx')).toEqual([])
    expect(texts('kubectl logs -p frontend-7d9f8c')).toEqual([])
    expect(texts('deploy --token ' + q)).toEqual(['key:auto:' + q])
  })

  it('115. strong labels at 0.75 with the entropy rule and every skip; authenticator keys at 0.95', () => {
    const v = token('«H24»', 12)
    expect(texts(`API_KEY = "${v}"`)).toEqual([`key:check:${v}`])
    expect(texts(`client_secret: ${v}`)).toEqual([`key:check:${v}`])
    // The entropy rule: a value with less than 3 bits a character is skipped.
    expect(texts('api_key = "aaaabbbbaaaabbbb"')).toEqual([])
    expect(texts('api_key = "1111222211112222"')).toEqual([])
    // Every skip: letters only, true/false/null, placeholders, reads from elsewhere, URLs, paths, env assignments of URLs.
    for (const t of ['token = "changeme"', 'secret = null', 'api_key = "<your-api-key>"', 'token: "${API_TOKEN}"', 'password = "{{password}}"', 'api_key = os.environ["API_KEY"]', 'token = process.env.GITHUB_TOKEN', 'secret = getenv("SECRET")', 'auth_url = https://login.acme.io/oauth', 'secret_path = /etc/acme/secret.pem', 'SENTRY_DSN=https://x.ingest.sentry.io'])
      expect(texts(t), t).toEqual([])
    // UI labels: after, under and beside, Check.
    const ui = token('«A28»', 13)
    expect(texts(ui, { above: 'API key' })).toEqual([`key:check:${ui}`])
    expect(texts(ui, { left: ['Client secret'] })).toEqual([`key:check:${ui}`])
    expect(texts('Signing secret: ' + ui)).toEqual([`key:check:${ui}`])
    // Authenticator setup keys: 0.95.
    expect(texts('JBSW Y3DP EHPK 3PXP', { above: 'Setup key' })).toEqual(['key:auto:JBSW Y3DP EHPK 3PXP'])
    expect(hitsOn('JBSWY3DPEHPK3PXPJBSW', { left: ['Secret key'] })[0]).toMatchObject({ rule: 'otp-secret', score: 0.95 })
  })

  it('A hint in brackets or parentheses between a label and its colon is part of the label: `aws configure`\'s "AWS Secret Access Key [None]: " names the secret after it (found end to end: the whole line was read and the secret never covered, only the AKIA id beside it)', () => {
    const secret = token('«S40»', 14)
    for (const label of ['AWS Secret Access Key [None]', 'AWS Secret Access Key [****************TsV1]', 'API key [default]', 'API key (optional)', 'Enter your API key (from the dashboard)', 'Client secret [none]'])
      expect(texts(`${label}: ${secret}`), label).toEqual([`key:check:${secret}`])
    expect(texts('Verification code (sent to your phone): 482913')).toEqual(['code:auto:482913'])
    // Still only before a colon or an equals sign, and a placeholder or dots after it are no value.
    for (const t of [`API key (optional) ${secret}`, 'API key [default]: None', 'Access token (optional): <your-token-here>', 'Secret key [hidden]: ********'])
      expect(texts(t), t).toEqual([])
  })

  it('116. passwords: separators, quotes, "PIN for the shared phone is 2580", pass rules, the not-a-password words', () => {
    expect(texts('Password: Vq7#pL2m!xR9')).toEqual(['password:auto:Vq7#pL2m!xR9'])
    expect(texts('password=Vq7pL2mxR9')).toEqual(['password:auto:Vq7pL2mxR9'])
    expect(texts('The password is Vq7pL2mxR9')).toEqual(['password:auto:Vq7pL2mxR9'])
    expect(texts('"PASSWORD":"Hn8$wQ4z-Lk2"')).toEqual(['password:auto:Hn8$wQ4z-Lk2'])
    expect(texts('contraseña: Kq8mZr2p')).toEqual(['password:auto:Kq8mZr2p'])
    expect(texts('PIN for the shared phone is 2580')).toEqual(['code:auto:2580'])
    // `pass` only at the start of a line or after a user field, with : or =.
    expect(texts('user: admin  pass: hunter2x')).toEqual(['password:auto:hunter2x'])
    expect(texts('pass: hunter2x')).toEqual(['password:auto:hunter2x'])
    expect(texts('Please pass the salt shaker')).toEqual([])
    expect(texts('if (job.pass = nextValue) return')).toEqual([])
    // The not-a-password words, placeholders and code.
    for (const t of ['Forgot password? Reset it here', 'Password must have at least 8 characters', 'Show password', 'Change your password', 'Password: ********', 'password = os.environ["PW"]', 'Password strength: Strong!', 'Reset password: 12-Nov-2026'])
      expect(texts(t), t).toEqual([])
    expect(texts('Enter your password', { above: 'Password' })).toEqual([])
    expect(texts('WPA2-Personal', { left: ['Network security key'] })).toEqual([])
  })

  it('117. codes: after the label, value first, under a sentence, recovery blocks and grids; CODE_NOT; heading numbers', () => {
    expect(texts('Your verification code: 482913')).toEqual(['code:auto:482913'])
    expect(texts('OTP 204 617')).toEqual(['code:auto:204 617'])
    expect(texts('Pairing code WDJB-MJ7T')).toEqual(['code:auto:WDJB-MJ7T'])
    expect(texts('G-482913 is your Google verification code.')).toEqual(['code:auto:G-482913'])
    expect(texts('739204', { above: 'Use this code to finish signing in.' })).toEqual(['code:auto:739204'])
    expect(texts('739204', { above: 'Signed in as Jordan', above2: 'Enter the code we sent you' })).toEqual(['code:auto:739204'])
    // A code's two digit groups read as boxes of their own, under a sentence naming a code (the two-factor page at 150%): one code over both.
    const fields = [line('3. Enter the 6-digit code', 100, 160), line('204', 120, 200, { h: 27 }), line('617', 165, 199, { h: 30 })]
    const both = detectFrame(fields, [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })
    expect(both.map((h) => `${h.kind}:${h.rule}:${h.spans.map((sp) => sp.line).join(',')}`)).toEqual(['code:code-labelled-groups:1,2'])
    // Not without a line naming a code, nor groups set a field apart.
    expect(detectFrame([line('Order total', 100, 160), ...fields.slice(1)], [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })).toEqual([])
    expect(detectFrame([fields[0], fields[1], line('617', 300, 199, { h: 30 })], [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })).toEqual([])
    // Recovery blocks: a line of codes under the heading; a sentence there is not codes; a numbered line's number is not a code.
    expect(texts('8f3k-2m9q 7p4x-c1zt h9w2-r6bd', { recovery: true })).toEqual(['code:auto:8f3k-2m9q', 'code:auto:7p4x-c1zt', 'code:auto:h9w2-r6bd'])
    expect(texts('Each code works once. Generated 23 Nov 2026.', { recovery: true })).toEqual([])
    expect(texts('1. 8f3k2m9q4x', { recovery: true })).toEqual(['code:auto:8f3k2m9q4x'])
    // Grids: a box on the row of a box in a recovery block.
    const grid = [line('Backup codes', 100, 170), line('7k2m-9q4p', 100, 200), line('h3w8-c5zt', 300, 200)]
    const hits = detectFrame(grid, [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })
    expect(hits.map((h) => h.rule).sort()).toEqual(['recovery-code', 'recovery-code-grid'])
    // CODE_NOT and years, algorithms.
    for (const t of ['Error code: 500123', 'ZIP code 94103', 'Promo code SAVE2024', 'VS Code 2024 release', 'code 2025', 'Verification uses SHA-256']) expect(texts(t), t).toEqual([])
    expect(texts('2026', { above: 'Your code' })).toEqual([])
  })

  it('118. rows: beside with boxes between, under a short label line', () => {
    expect(texts('58204716', { left: ['Router admin PIN', 'From the sticker'] })).toEqual(['code:auto:58204716'])
    expect(texts('Plum-0rchard-4418', { left: ['Network security key', 'WPA2-Personal'] })).toEqual(['password:auto:Plum-0rchard-4418'])
    expect(texts('hunter2!x', { above: 'Password' })).toEqual(['password:auto:hunter2!x'])
    expect(texts('hunter2!x', { above: 'Password *' })).toEqual(['password:auto:hunter2!x'])
    // A label line that says more than a label is not one.
    expect(texts('hunter2!x', { above: 'Choose a strong password for the new team account' })).toEqual([])
    // Too far to the left on the row (more than three boxes between) is not beside.
    expect(texts('58204716', { left: ['Router admin PIN', 'a', 'b', 'c'] })).toEqual([])
    // A label with a hint line under it, the value centred on the pair 0.65 line heights from each (a
    // settings row at 150% display scale) is beside; a time on a sender's row, a subject naming a
    // password under the sender, is not: it is not centred on the pair.
    const run = (lines: ReturnType<typeof line>[]) => detectFrame(lines, [], { kinds: DEFAULT_KINDS, regions: ['US'], names: NO_NAMES, frame: FRAME }).map((h) => `${h.kind}:${h.rule}`)
    expect(run([line('Router admin PIN', 100, 387), line('From the sticker', 100, 413), line('58204716', 900, 400)])).toEqual(['code:pin-labelled'])
    expect(run([line('National Insurance number', 100, 387), line('For payroll', 100, 413), line('QQ 12 34 56 C', 900, 400)])).toEqual(['id:id-labelled'])
    expect(run([line('IT Service Desk', 100, 400), line('Your temporary password', 100, 423), line('11:02', 900, 401)])).toEqual([])
  })

  it('119. continuation: a JWT head at a line end continues onto the next lines; a webhook token wrapped after - continues; at most 6 lines', () => {
    const head = token('«=eyJ|B30».«=eyJ|B40»', 21)
    const rest = [token('«B40»', 22), token('«B20».«B20»', 23)]
    const jwt = hitsOn(head, { below: rest }).filter((h) => h.kind === 'key')
    expect(jwt).toHaveLength(1)
    expect(jwt[0].rule).toBe('jwt-head+continued')
    expect(jwt[0].hit.spans.map((s) => s.line)).toEqual([0, 1, 2])
    // A webhook token wrapped after a dash.
    const id = token('«D19»', 24)
    const wrapped = hitsOn(`https://discord.com/api/webhooks/${id}/R7-`, { below: [token('«B40»', 25), token('«B12»', 26)] })
    expect(wrapped).toHaveLength(1)
    expect(wrapped[0]).toMatchObject({ kind: 'link', rule: 'discord-webhook-head+continued', text: `${id}/R7-` })
    expect(wrapped[0].hit.spans.map((s) => s.line)).toEqual([0, 1, 2])
    // At most 6 lines are chained.
    const chain = hitsOn(head, { below: Array.from({ length: 9 }, (_v, i) => token('«B40»', 30 + i)) }).filter((h) => h.kind === 'key')
    expect(new Set(chain[0].hit.spans.map((s) => s.line)).size).toBe(7)
    // A plain word, a label line or a line set apart is not the rest of a token.
    expect(hitsOn(head, { below: ['Export'] })[0].hit.spans).toHaveLength(1)
    expect(hitsOn(head, { below: ['STRIPE_KEY=abc123def'] })[0].hit.spans).toHaveLength(1)
    const apart = [line(head, 100, 200), line(token('«B40»', 40), 100, 240)]
    expect(detectFrame(apart, [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })[0].spans).toHaveLength(1)
    const frameHits = (lines: ReturnType<typeof line>[]) => detectFrame(lines, [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME })
    const own = (lines: ReturnType<typeof line>[], h: { spans: { line: number; variant: number; start: number; end: number }[] }): string[] => h.spans.map((sp) => lines[sp.line].variants[sp.variant].text.slice(sp.start, sp.end))
    // The next line is found under the row even when the reader also returned a piece of the row cut at
    // a tile's edge, reaching lower than the row's own box (the 150% dashboard's webhook).
    const cut = [line(`https://discord.com/api/webhooks/${id}/R7-`, 100, 400), line('https://di', 100, 401, { h: 21 }), line(token('«B40»', 27), 100, 424)]
    const past = frameHits(cut).filter((h) => h.kind === 'link')
    expect(past).toHaveLength(1)
    expect(past[0].spans.map((s) => s.line)).toEqual([0, 2])
    // The last one to three characters of a token wrapped at its block's right edge, alone on the next
    // row but for a closing quote: a cover of their own, under the line (the editor at 150%) ...
    const whole = token('«=eyJ|B30».«=eyJ|B40».«B43»', 28)
    const under = [line(`SERVICE_JWT = "${whole.slice(0, -1)}`, 100, 200), line(`${whole.slice(-1)}"`, 100, 224)]
    const tail = frameHits(under).filter((h) => h.kind === 'key')
    expect(tail.map((h) => h.rule)).toEqual(['jwt', 'jwt+tail'])
    expect(own(under, tail[1])).toEqual([whole.slice(-1)])
    expect(tail[1].box[1]).toBeGreaterThan(214)
    // ... or at the start of its row, where the reader read a log line's time apart from its message (the held-out logs page).
    const log = [line('12:03:44 INFO', 100, 200), line(`auth ok token ${whole.slice(0, -1)}`, 300, 200), line(`${whole.slice(-1)}"`, 100, 224)]
    const logged = frameHits(log).filter((h) => h.kind === 'key')
    expect(logged.map((h) => h.rule)).toEqual(['jwt', 'jwt+tail'])
    expect(own(log, logged[1])).toEqual([whole.slice(-1)])
    // An editor's next line number at the row's start is not a tail: it is not alone on its row.
    const numbered = [line('25', 40, 200), line(`JWT = "${whole}"`, 100, 200), line('26', 40, 224), line('const x = 1', 100, 224)]
    expect(frameHits(numbered).map((h) => h.rule)).toEqual(['jwt'])
  })

  it('120. one space in a key: sk-proj- with one inner space is one token; two spaces are not', () => {
    const a = token('«=sk-proj-|A12»', 41)
    const b = token('«A32»', 42)
    expect(texts(`key ${a} ${b} here`)).toEqual([`key:auto:${a} ${b}`])
    expect(hitsOn(`key ${a} ${b}`)[0].rule).toBe('openai+space')
    expect(texts(`key ${a}  ${b} here`)).toEqual([])
    // Parts that match alone are not joined.
    const whole = token('«=ghp_|A36»', 43)
    expect(texts(`${whole} ${b}`)).toEqual([`key:auto:${whole}`])
    // In a quoted value, a key that stops one space before the value's last characters and its closing
    // quote runs to the quote (an underscore read as a space at 200%); not past a different quote or a
    // second word.
    expect(texts(`"UploadToken": "${whole} 6i0c"},`)).toEqual([`key:auto:${whole} 6i0c`])
    expect(texts(`"UploadToken": "${whole} 6i0c'`)).toEqual([`key:auto:${whole}`])
    expect(texts(`"UploadToken": "${whole} is ok"`)).toEqual([`key:auto:${whole}`])
  })

  it('121. wrap join: a joined token matching a strong rule covers both parts', () => {
    const tok = token('«=ghp_|A36»', 51)
    const first = tok.slice(0, 20)
    const second = tok.slice(20)
    // The first line reaches its block's right edge: it is the widest of its column, and the token wraps.
    const lines = [line('config', 100, 176), line('x'.repeat(24) + ' ' + first, 100, 200), line(second + ' # rotate', 100, 224)]
    const hits = detectFrame(lines, [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME }).filter((h) => h.kind === 'key')
    expect(hits).toHaveLength(1)
    expect(hits[0].rule).toBe('github+wrap')
    const own = hits[0].spans.map((s) => lines[s.line].variants[s.variant].text.slice(s.start, s.end))
    expect(own).toEqual([first, second])
    // Parts that match alone are left as they are.
    const lone = [line('config', 100, 176), line('x'.repeat(8) + ' ' + tok, 100, 200), line('abcdef1234 next', 100, 224)]
    expect(detectFrame(lone, [], { kinds: DEFAULT_KINDS, regions: [], names: NO_NAMES, frame: FRAME }).filter((h) => h.rule.includes('wrap'))).toEqual([])
  })

  it('122. names on screen: folding, distances by length, wildcards, overlapping matches, one word of a full name is not a match, never-hide removes a hit', () => {
    const names = ['Riad Hasan', 'Mei Lin Chen', 'Acme*', 'Aldo']
    expect(texts('Signed in as Riad Hasan', { names })).toEqual(['name:auto:Riad Hasan'])
    // Folding: digits for letters, joined words, rn for m.
    expect(texts('R1ad Hasan shared a file', { names })).toEqual(['name:auto:R1ad Hasan'])
    expect(texts('RiadHasan shared a file', { names })).toEqual(['name:auto:RiadHasan'])
    expect(texts('Mei Lin Chen', { names })).toEqual(['name:auto:Mei Lin Chen'])
    expect(texts('Mei Lin Cherr', { names })).toEqual(['name:check:Mei Lin Cherr'])
    // Distances by length: one edit for 5-8 letters, two for 9 or more, none for 4 or fewer.
    expect(texts('Riad Hasam', { names })).toEqual(['name:check:Riad Hasam'])
    expect(texts('Ried Hasam', { names })).toEqual(['name:check:Ried Hasam'])
    expect(texts('Rxed Hasam', { names })).toEqual([])
    expect(texts('Aldo', { names })).toEqual(['name:auto:Aldo'])
    expect(texts('Alda', { names })).toEqual([])
    // Wildcards.
    expect(texts('AcmeCorp Ltd invoice', { names })).toEqual(['name:auto:AcmeCorp'])
    expect(texts('Microsoft', { names: ['*soft'] })).toEqual(['name:auto:Microsoft'])
    // Overlapping matches: the smallest distance wins.
    expect(texts('as Riad Hasan', { names })).toEqual(['name:auto:Riad Hasan'])
    // One word of a listed full name is not a match.
    expect(texts('Hasan Ali joined', { names })).toEqual([])
    // Never-hide removes a hit whose own folded text equals an entry.
    expect(texts('AcmeCloud status', { names, neverHide: ['AcmeCloud'] })).toEqual([])
    expect(texts('AcmeCorp status', { names, neverHide: ['AcmeCloud'] })).toEqual(['name:auto:AcmeCorp'])
    // Never-hide applies to every kind.
    expect(texts('support@acme-cloud.io', { neverHide: ['support@acme-cloud.io'] })).toEqual([])
  })

  it('123. off-by-default kinds find their vectors only when on', () => {
    const offKinds: PrivateKind[] = ['address', 'dots', 'random']
    for (const v of VECTORS.screen.filter((x) => x.options)) {
      expect(screenProblems(v), v.id).toEqual([])
      expect(screenProblems({ ...v, options: undefined, expect: [] }), v.id + ' off').toEqual([])
    }
    // Addresses: the planted ones of the evaluation set.
    const truth = loadTruth('truth')
    const addresses = truth.frames.flatMap((f) => f.items.filter((i) => i.kind === 'address').map((i) => i.text))
    expect(addresses.length).toBe(13)
    for (const a of addresses) {
      expect(hitsOn(a, { kinds: [...DEFAULT_KINDS, ...offKinds] }).filter((h) => h.kind === 'address'), a).toHaveLength(1)
      expect(hitsOn(a).filter((h) => h.kind === 'address'), a).toEqual([])
    }
    expect(texts('NW1 6XE', { above: '221B Baker Street', kinds: [...DEFAULT_KINDS, 'address'] })).toEqual(['address:check:NW1 6XE'])
    expect(PRIVATE_KINDS.filter((k) => !DEFAULT_KINDS.includes(k))).toEqual(['address', 'dots', 'random', 'text'])
  })

  it('124. classQr: each class of §6.9 and null as undecoded', () => {
    expect(classQr('otpauth://totp/Acme:jane?secret=JBSWY3DPEHPK3PXP&issuer=Acme')).toEqual({ kind: 'qr', score: 0.99, class: 'secret' })
    expect(classQr('otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8')).toMatchObject({ class: 'secret' })
    expect(classQr('WIFI:T:WPA;S:Office;P:Plum-0rchard-4418;;')).toMatchObject({ class: 'secret', score: 0.99 })
    expect(classQr('WIFI:S:Guest;T:nopass;;')).toMatchObject({ class: 'other', score: 0.6 })
    expect(classQr('https://app.acme.io/login?token=' + token('«B32»', 60))).toMatchObject({ class: 'secret' })
    expect(classQr('config ' + token('«=ghp_|A36»', 61))).toMatchObject({ class: 'secret' })
    expect(classQr('https://discord.com/ra/abcdefgh')).toMatchObject({ class: 'secret' })
    expect(classQr('https://s.team/q/1234/5678')).toMatchObject({ class: 'secret' })
    expect(classQr('2@abcDEF123,keyKEY456,idID789,advADV')).toMatchObject({ class: 'secret' })
    for (const p of ['BEGIN:VCARD\nFN:Jane\nEND:VCARD', 'MECARD:N:Jane;;', 'mailto:jane@acme.io', 'tel:+14155550100', 'sms:+14155550100', 'geo:23.8,90.4']) expect(classQr(p), p).toEqual({ kind: 'qr', score: 0.9, class: 'personal' })
    expect(classQr('https://flown.app/download')).toEqual({ kind: 'qr', score: 0.6, class: 'other' })
    expect(classQr(null)).toEqual({ kind: 'qr', score: 0.6, class: 'undecoded' })
    // detectFrame gives a QR code's hit its quad's box padded, and nothing of the payload.
    const [q] = detectFrame([], [{ quad: [[100, 100], [205, 100], [205, 205], [100, 205]], payload: 'tel:+14155550100' }], { kinds: DEFAULT_KINDS, regions: [], names: compileNames([], []), frame: FRAME })
    expect(q).toMatchObject({ kind: 'qr', rule: 'qr-personal', score: 0.9, spans: [] })
    expect(q.box).toEqual([80, 80, 145, 145])
    expect(JSON.stringify(q)).not.toContain('4155550100')
  })
})
