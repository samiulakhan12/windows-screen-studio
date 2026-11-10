import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UiLanguage } from '../src/shared/api/ui'
import type { MessageKey } from '../src/shared/i18n/t'

/*
 * The UI language and its formats (docs/design/output-and-languages.md §9.3, §9.4, §11.3; part P6):
 * tests 51 (resolveUiLanguage), 52 (formatLocaleOf and Intl.DurationFormat's tag), 53 (fmt in bn, bn
 * with Western digits, hi and es), 54 (plurals), 82 (digits per message) and the reading half of 83
 * (fmt.parseNumber). English is registered by tests/setup/i18n.ts.
 */

const { resolveUiLanguage, formatLocaleOf, dirOf, languageOf, readShipped, readBuiltCatalogue } = await import('../src/shared/i18n/locale')
const rt = await import('../src/shared/i18n/t')
const { fmt, TIME_FORMS } = await import('../src/shared/i18n/fmt')
const { parseIcu, formatIcu } = await import('../src/shared/i18n/icu')

const english = (): void => rt.setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' })
afterEach(() => {
  english()
  vi.useRealTimers()
})
const lang = (language: UiLanguage, formatLocale: string, extra: Partial<Parameters<typeof rt.setCatalogue>[0]> = {}): void =>
  rt.setCatalogue({ language, messages: {}, formatLocale, dir: 'ltr', ...extra })

const BN = [{ language: 'bn' as const, preview: true }]

describe('resolveUiLanguage (test 51)', () => {
  it('starts in English when the language is absent or English, on any Windows', () => {
    for (const prefs of [null, {}, { language: 'en' as const }]) {
      const info = resolveUiLanguage(prefs, ['bn-BD', 'en-US'], 'bn-BD', BN, [])
      expect(info).toMatchObject({ language: 'en', formatLocale: 'en-US', dir: 'ltr', digits: 'western', system: 'bn', reopen: null })
    }
  })

  it("follows Windows' first language when it has shipped, and English when it has not", () => {
    expect(resolveUiLanguage({ language: 'system' }, ['bn-IN', 'en-US'], 'bn-IN', BN, [])).toMatchObject({ language: 'bn', system: 'bn', formatLocale: 'bn-IN', digits: 'native' })
    expect(resolveUiLanguage({ language: 'system' }, ['bn-IN', 'en-US'], 'bn-IN', [], [])).toMatchObject({ language: 'en', system: 'en' })
    // Only the first of Windows' languages counts.
    expect(resolveUiLanguage({ language: 'system' }, ['en-US', 'bn-BD'], 'en-US', BN, [])).toMatchObject({ language: 'en', system: 'en' })
  })

  it('gives a chosen language only when it has shipped (a built catalogue), else English', () => {
    expect(resolveUiLanguage({ language: 'bn' }, [], 'en-US', BN, [])).toMatchObject({ language: 'bn', formatLocale: 'bn', digits: 'native' })
    expect(resolveUiLanguage({ language: 'hi' }, ['hi-IN'], 'hi-IN', BN, [])).toMatchObject({ language: 'en', formatLocale: 'en-US' })
    expect(resolveUiLanguage({ language: 'bn', digits: 'western' }, [], 'bn-BD', BN, [])).toMatchObject({ language: 'bn', formatLocale: 'bn-BD-u-nu-latn', digits: 'western' })
  })

  it('offers a shipped language once, only while the language is absent', () => {
    const offer = (prefs: Parameters<typeof resolveUiLanguage>[0], preferred: string[], known: UiLanguage[] = []): UiLanguage | null => resolveUiLanguage(prefs, preferred, 'en-US', BN, known).offer
    expect(offer({}, ['bn-BD', 'en-US'])).toBe('bn')
    expect(offer({}, ['en-US', 'bn-IN'])).toBe('bn')
    expect(offer({ offered: ['bn'] }, ['bn-BD'])).toBeNull()
    expect(offer({ language: 'en' }, ['bn-BD'])).toBeNull()
    expect(offer({ language: 'system' }, ['bn-BD'])).toBeNull()
    // Windows lists only English, but Flown knows offline that the user works in Bangla.
    expect(offer({}, ['en-US'])).toBeNull()
    expect(offer({}, ['en-US'], ['bn'])).toBe('bn')
    expect(offer({ seen: ['bn'] }, ['en-US'])).toBe('bn')
    // Nothing is offered that has not shipped.
    expect(resolveUiLanguage({ seen: ['hi'] }, ['hi-IN'], 'hi-IN', BN, ['hi']).offer).toBeNull()
  })

  it("lists what shipped.json ships and which of it is a preview, and reads nothing else", () => {
    const shipped = [
      { language: 'bn' as const, preview: true },
      { language: 'es' as const, preview: false }
    ]
    expect(resolveUiLanguage({}, [], 'en-US', shipped, [])).toMatchObject({ shipped: ['bn', 'es'], preview: ['bn'] })
    expect(resolveUiLanguage({}, [], 'en-US', [], [])).toMatchObject({ shipped: [], preview: [] })
    expect(readShipped([{ language: 'bn', preview: true }, { language: 'en', preview: false }, { language: 'xx' }, { language: 'bn' }, 'hi', null, { language: 'hi', preview: 'yes' }])).toEqual([
      { language: 'bn', preview: true },
      { language: 'hi', preview: false }
    ])
    expect(readShipped({ language: 'bn' })).toEqual([])
  })

  it('knows each language by its subtag and its direction', () => {
    expect(['bn-IN', 'bn_BD', 'BN', 'es-419'].map(languageOf)).toEqual(['bn', 'bn', 'bn', 'es'])
    expect(['bn', 'hi', 'es', 'en', 'ar', 'he', 'ur', 'ar-XB'].map(dirOf)).toEqual(['ltr', 'ltr', 'ltr', 'ltr', 'rtl', 'rtl', 'rtl', 'rtl'])
  })

  it('reads a built catalogue strictly: string messages by full key, the Latin-digit keys and the user placeholders', () => {
    expect(readBuiltCatalogue(null)).toBeNull()
    expect(readBuiltCatalogue({ messages: [] })).toBeNull()
    const read = readBuiltCatalogue({
      messages: { 'home.title': 'হোম', 'bad key': 'x', 'home.n': 3, '__proto__.x': 'y', 'home.long': 'x'.repeat(4001) },
      latn: ['codecs.fps.chip', 7, '../x'],
      user: { 'presets.more.name': ['name', '1x', 2], nope: 'name' },
      extra: true
    })
    expect(read).toEqual({ messages: { 'home.title': 'হোম' }, latn: ['codecs.fps.chip'], user: { 'presets.more.name': ['name'] } })
  })
})

/** Electron's own runtime, run as Node, for what V8 15.2 and ICU 78 do (absent in a CI install without its download). */
const ELECTRON = ((): string | null => {
  try {
    const bin = createRequire(import.meta.url)('electron') as unknown
    return typeof bin === 'string' && fs.existsSync(bin) ? bin : null
  } catch {
    return null
  }
})()

describe('formatLocaleOf (test 52)', () => {
  it("takes the system locale's region for the same language, and writes the digits choice as a -u-nu- tag", () => {
    expect(formatLocaleOf('bn', 'bn-BD', 'western')).toBe('bn-BD-u-nu-latn')
    expect(formatLocaleOf('bn', 'en-US', undefined)).toBe('bn')
    expect(formatLocaleOf('hi', 'en-US', 'native')).toBe('hi-u-nu-deva')
    expect(formatLocaleOf('bn', 'bn-IN', 'native')).toBe('bn-IN-u-nu-beng')
    expect(formatLocaleOf('es', 'es-MX', 'western')).toBe('es-MX')
    expect(formatLocaleOf('es', 'not a locale', undefined)).toBe('es')
    // English keeps each call site's own profile.
    expect(formatLocaleOf('en', 'bn-BD', 'native')).toBe('en-US')
  })

  it('makes Western digits through the tag where the locale writes its own', () => {
    for (const tag of [formatLocaleOf('bn', 'bn-BD', 'western'), formatLocaleOf('bn', 'en-US', 'western')]) {
      expect(new Intl.NumberFormat(tag).format(125)).toBe('125')
      lang('bn', tag)
      expect(fmt.duration(125)).toBe('2 মিনিট, 5 সেকেন্ড')
    }
    expect(new Intl.NumberFormat(formatLocaleOf('bn', 'en-US', undefined)).format(125)).toBe('১২৫')
  })

  it.runIf(ELECTRON)("Intl.DurationFormat in Electron obeys the tag and ignores the option, and fmt's unit list writes what it writes", () => {
    const script = `
      const d = { minutes: 2, seconds: 5 }
      const unitList = (loc) => new Intl.ListFormat(loc, { type: 'unit', style: 'long' }).format([
        new Intl.NumberFormat(loc, { style: 'unit', unit: 'minute', unitDisplay: 'long' }).format(2),
        new Intl.NumberFormat(loc, { style: 'unit', unit: 'second', unitDisplay: 'long' }).format(5)])
      const out = { tag: new Intl.DurationFormat('bn-BD-u-nu-latn', { style: 'long' }).format(d), option: new Intl.DurationFormat('bn', { style: 'long', numberingSystem: 'latn' }).format(d), same: {} }
      for (const loc of ['bn', 'bn-u-nu-latn', 'hi', 'hi-u-nu-deva', 'es']) out.same[loc] = new Intl.DurationFormat(loc, { style: 'long' }).format(d) === unitList(loc)
      console.log(JSON.stringify(out))`
    const run = spawnSync(ELECTRON!, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000 })
    expect(run.status, run.stderr).toBe(0)
    const out = JSON.parse(run.stdout.trim()) as { tag: string; option: string; same: Record<string, boolean> }
    expect(out.tag).toBe('2 মিনিট, 5 সেকেন্ড')
    expect(out.option).toBe('২ মিনিট, ৫ সেকেন্ড')
    expect(out.same).toEqual({ bn: true, 'bn-u-nu-latn': true, hi: true, 'hi-u-nu-deva': true, es: true })
  })
})

describe('fmt in other languages (test 53)', () => {
  const at = new Date(2026, 10, 7, 14, 5).getTime()
  const DAY = 86_400_000
  const grid = (): Record<string, unknown> => ({
    number: fmt.number(1234567.891),
    count: [fmt.count(1234), fmt.count(1234567, { grouping: true })],
    percent: fmt.percent(0.5),
    factor: fmt.factor(1.5),
    bytes: [fmt.bytes(1.5e6), fmt.bytes(2.25e9), fmt.bytes(340e3)],
    duration: [fmt.duration(45), fmt.duration(125), fmt.duration(180)],
    seconds: fmt.seconds(1.23),
    clock: [fmt.clock(62.5), fmt.clock(62.5, 'whole'), fmt.clock(3725, 'hours'), fmt.tick(62.5, 0.5)],
    date: [fmt.date(at, 'day'), fmt.date(at, 'dayYear'), fmt.date(at, 'dayTime')],
    time: fmt.time(at),
    relative: [fmt.relative(at, at + 3 * DAY), fmt.relative(at, at + DAY), fmt.relative(at, at + 1000)],
    list: [fmt.list(['A', 'B', 'C']), fmt.list(['A', 'B'], 'or')]
  })

  it('Bangla: Bangla digits with Indian grouping, full month names, the reviewers’ time form, Latin units', () => {
    // The reviewers choose the time form before S5 (§11.3); until then a Bangla day period before the time.
    expect(TIME_FORMS.bn).toBe('dayPeriod')
    lang('bn', 'bn')
    expect(grid()).toEqual({
      number: '১২,৩৪,৫৬৭.৮৯১',
      count: ['১২৩৪', '১২,৩৪,৫৬৭'],
      percent: '৫০%',
      factor: '১.৫×',
      bytes: ['১.৫ MB', '২.২৫ GB', '৩৪০ KB'],
      duration: ['৪৫ সেকেন্ড', '২ মিনিট, ৫ সেকেন্ড', '৩ মিনিট'],
      seconds: '১.২ s',
      clock: ['১:০২.৫', '১:০২', '১:০২:০৫', '১:০২.৫'],
      date: ['৭ নভেম্বর', '৭ নভেম্বর ২০২৬', '৭ নভেম্বর ২০২৬, দুপুর ২:০৫'],
      time: 'দুপুর ২:০৫',
      relative: ['৩ দিন আগে', 'গতকাল', 'আজ'],
      list: ['A, B এবং C', 'A বা B']
    })
  })

  it('Bangla with Western digits: the same words, 0–9', () => {
    lang('bn', 'bn-BD-u-nu-latn')
    expect(grid()).toMatchObject({
      number: '12,34,567.891',
      count: ['1234', '12,34,567'],
      bytes: ['1.5 MB', '2.25 GB', '340 KB'],
      duration: ['45 সেকেন্ড', '2 মিনিট, 5 সেকেন্ড', '3 মিনিট'],
      clock: ['1:02.5', '1:02', '1:02:05', '1:02.5'],
      date: ['7 নভেম্বর', '7 নভেম্বর 2026', '7 নভেম্বর 2026, দুপুর 2:05'],
      time: 'দুপুর 2:05',
      relative: ['3 দিন আগে', 'গতকাল', 'আজ']
    })
  })

  it('Hindi: Western digits by default (CLDR), Devanagari by choice', () => {
    lang('hi', 'hi')
    expect(grid()).toMatchObject({
      number: '12,34,567.891',
      duration: ['45 सेकंड', '2 मिनट और 5 सेकंड', '3 मिनट'],
      clock: ['1:02.5', '1:02', '1:02:05', '1:02.5'],
      date: ['7 नव॰', '7 नव॰ 2026', '7 नव॰ 2026, 2:05 pm'],
      time: '2:05 pm',
      relative: ['3 दिन पहले', 'कल', 'आज'],
      list: ['A, B, और C', 'A या B']
    })
    lang('hi', 'hi-u-nu-deva')
    expect(grid()).toMatchObject({ number: '१२,३४,५६७.८९१', clock: ['१:०२.५', '१:०२', '१:०२:०५', '१:०२.५'], date: ['७ नव॰', '७ नव॰ २०२६', '७ नव॰ २०२६, २:०५ pm'] })
  })

  it('Spanish: no grouping of four digits, a decimal comma, a 24-hour clock', () => {
    lang('es', 'es')
    expect(grid()).toEqual({
      number: '1.234.567,891',
      count: ['1234', '1.234.567'],
      percent: '50\u00a0%',
      factor: '1,5×',
      bytes: ['1,5 MB', '2,25 GB', '340 KB'],
      duration: ['45 segundos', '2 minutos y 5 segundos', '3 minutos'],
      seconds: '1,2 s',
      clock: ['1:02.5', '1:02', '1:02:05', '1:02.5'],
      date: ['7 nov', '7 nov 2026', '7 nov 2026, 14:05'],
      time: '14:05',
      relative: ['hace 3 días', 'ayer', 'hoy'],
      list: ['A, B y C', 'A o B']
    })
  })

  it('a version time says today and yesterday in the language, and a date before that', () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 7, 18, 0) })
    lang('bn', 'bn')
    expect(fmt.date(at, 'version')).toBe('আজ দুপুর ২:০৫')
    expect(fmt.date(at - DAY, 'version')).toBe('গতকাল দুপুর ২:০৫')
    expect(fmt.date(new Date(2026, 2, 12, 9, 15).getTime(), 'version')).toBe('১২ মার্চ সকাল ৯:১৫')
    expect(fmt.date(new Date(2025, 2, 12, 9, 15).getTime(), 'version')).toBe('১২ মার্চ ২০২৫ সকাল ৯:১৫')
    lang('es', 'es')
    expect(fmt.date(at, 'version')).toBe('Hoy 14:05')
    expect(fmt.date(at - DAY, 'version')).toBe('Ayer 14:05')
  })

  it('leaves English exactly as before, and the English-only steps out of other languages', () => {
    expect(fmt.inSentence('Encoding Video')).toBe('encoding video')
    expect(fmt.relative(0, at)).toBe('never')
    lang('bn', 'bn')
    expect(fmt.inSentence('Encoding Video')).toBe('Encoding Video')
    expect(fmt.relative(0, at)).toBe('')
    expect(fmt.date(Number.NaN, 'dayYear')).toBe('')
  })
})

describe('plurals (test 54)', () => {
  const NUMBERS = [0, 1, 2, 3, 11, 100, 1_000_000]
  const select = (language: string, message: string, count: number): string => formatIcu<string>(parseIcu(message), { count, n: String(count) }, { language, formatLocale: language }).join('')

  it('selects as Intl.PluralRules does in bn (other only), es (one, many, other) and ar (six categories)', () => {
    const cases: [string, string][] = [
      ['bn', '{count, plural, other {other}}'],
      ['es', '{count, plural, one {one} many {many} other {other}}'],
      ['ar', '{count, plural, zero {zero} one {one} two {two} few {few} many {many} other {other}}']
    ]
    for (const [language, message] of cases) {
      const rules = new Intl.PluralRules(language)
      for (const n of NUMBERS) expect(select(language, message, n), `${language} ${n}`).toBe(language === 'bn' ? 'other' : rules.select(n))
    }
    expect(NUMBERS.map((n) => select('es', '{count, plural, one {one} many {many} other {other}}', n))).toEqual(['other', 'one', 'other', 'other', 'other', 'other', 'many'])
  })

  it('formats count 0 through every Bangla plural without a number word', () => {
    const built = path.join(__dirname, '../src/shared/i18n/built/bn.json')
    const catalogues: Record<string, string>[] = [{ 'presets.import.done': '{count, plural, other {{n}টি প্রিসেট আনা হয়েছে।}}' }]
    if (fs.existsSync(built)) catalogues.push((JSON.parse(fs.readFileSync(built, 'utf8')) as { messages: Record<string, string> }).messages)
    let plurals = 0
    for (const messages of catalogues)
      for (const [key, message] of Object.entries(messages)) {
        if (!/,\s*plural\s*,/.test(message)) continue
        plurals++
        lang('bn', 'bn', { messages })
        const text = rt.t(key as MessageKey, { count: 0, n: fmt.count(0), limit: fmt.count(50) })
        expect(text, key).not.toMatch(/এক|১/)
        expect(text, key).toContain('০')
      }
    expect(plurals).toBeGreaterThan(0)
  })
})

describe('digits per message (test 82)', () => {
  /** The technical lines the contracts marked (digits: 'latn' in the meta files), as the build writes them into `latn`. */
  const latn = ['codecs', 'presets', 'stems', 'language'].flatMap((ns) =>
    Object.entries(JSON.parse(fs.readFileSync(path.join(__dirname, `../src/shared/i18n/messages/en/${ns}.meta.json`), 'utf8')) as Record<string, { digits?: string }>)
      .filter(([, m]) => m.digits === 'latn')
      .map(([k]) => `${ns}.${k}`)
  )

  it('writes a technical line in Latin digits and prose in the chosen digits', () => {
    expect(latn).toContain('codecs.fps.chip')
    lang('bn', 'bn', { latn })
    expect(fmt.count(1080)).toBe('১০৮০')
    expect(rt.t('codecs.fps.chip', { fps: fmt.count(1080) })).toBe('1080 fps')
    expect(rt.t('presets.import.done', { count: 1080, n: fmt.count(1080) })).toBe('Imported ১০৮০ presets.')
    lang('bn', 'bn-BD-u-nu-latn', { latn })
    expect(rt.t('codecs.fps.chip', { fps: fmt.count(1080) })).toBe('1080 fps')
    expect(rt.t('presets.import.done', { count: 1080, n: fmt.count(1080) })).toBe('Imported 1080 presets.')
  })
})

describe('reading typed numbers (test 83)', () => {
  it('reads Bangla, Devanagari and Western digits, and nothing else', () => {
    for (const text of ['২৫', '२५', '25', ' 25 ']) expect(fmt.parseNumber(text), text).toBe(25)
    for (const text of ['2৫x', '', '২৫ MB', '1,5']) expect(fmt.parseNumber(text), text).toBeNaN()
    expect(fmt.parseNumber('২.৫')).toBe(2.5)
  })

  it('reads the decimal comma of a language that writes one', () => {
    lang('es', 'es')
    expect(fmt.parseNumber('2,5')).toBe(2.5)
    expect(fmt.parseNumber('2.5')).toBe(2.5)
    expect(fmt.parseNumber('1.234,5')).toBeNaN()
    lang('bn', 'bn')
    expect(fmt.parseNumber('২,৫')).toBeNaN()
  })
})
