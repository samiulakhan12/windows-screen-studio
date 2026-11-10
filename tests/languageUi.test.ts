import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UiInfo, UiPrefs } from '../src/shared/api/ui'
import { BUSY_COPY } from '../src/shared/updates/updates'

/*
 * Settings › Language and the offer on Home (docs/design/output-and-languages.md §2.5, §2.7, tests
 * 57 and 58), and nothing in the language runtime reaching the network (test 60). No DOM: each
 * component is called as a function with React's hooks answered here, and its elements are walked.
 */

interface El {
  type: unknown
  props: Record<string, unknown>
}

const hooks = vi.hoisted(() => ({ states: [] as unknown[], i: 0, effects: [] as (() => void | (() => void))[] }))
vi.doMock('react', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useState: (init: unknown) => {
    const k = hooks.i++
    if (!(k in hooks.states)) hooks.states[k] = typeof init === 'function' ? (init as () => unknown)() : init
    return [hooks.states[k], (v: unknown) => (hooks.states[k] = typeof v === 'function' ? (v as (p: unknown) => unknown)(hooks.states[k]) : v)]
  },
  useEffect: (fn: () => void | (() => void)) => void hooks.effects.push(fn),
  useRef: (init: unknown) => ({ current: init }),
  useId: () => 'lang'
}))

let prefs: UiPrefs = {}
const api = {
  uiInfo: vi.fn<() => Promise<UiInfo>>(),
  setUiPrefs: vi.fn(async (p: UiPrefs) => void (prefs = p)),
  relaunch: vi.fn(async (_id?: string) => ({ ok: true }) as { ok: true } | { ok: false; reason: string }),
  noteLanguageSeen: vi.fn(async () => undefined),
  listProjects: vi.fn(async () => [])
}
vi.stubGlobal('window', { api })
vi.stubGlobal('document', { documentElement: { lang: 'en', dir: '' }, activeElement: null })

const BOOT = '../src/renderer/src/i18n/boot'
const SECTION = '../src/renderer/src/settings/LanguageSection'
const OFFER = '../src/renderer/src/home/LanguageOffer'
const UPDATES = '../src/renderer/src/updates/useUpdates'
const boot = (await import(/* @vite-ignore */ BOOT)) as {
  bootLanguage(view: string): Promise<UiInfo>
  currentUiInfo(): UiInfo
  showLanguageSection(info: UiInfo): boolean
  noteProjectLanguages(project: unknown): void
  resetBootForTests(): void
}
const { LanguageSection } = (await import(/* @vite-ignore */ SECTION)) as { LanguageSection: () => El }
const { LanguageOffer } = (await import(/* @vite-ignore */ OFFER)) as { LanguageOffer: () => El | null }
const { setRecordingBusy } = (await import(/* @vite-ignore */ UPDATES)) as { setRecordingBusy(reason: string | null): void }
const rt = await import('../src/shared/i18n/t')

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/i18n/bn.json'), 'utf8')) as { messages: Record<string, string>; latn: string[]; user: Record<string, string[]> }
const ENGLISH: UiInfo = { language: 'en', formatLocale: 'en-US', dir: 'ltr', digits: 'western', system: 'en', offer: null, shipped: ['bn'], preview: ['bn'], prefs: {}, reopen: null }

/** Boots with `info` as main would give it, and `stored` as the preference main holds. */
async function start(info: Partial<UiInfo>, stored: UiPrefs = info.prefs ?? {}): Promise<void> {
  boot.resetBootForTests()
  rt.setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' })
  prefs = stored
  const full = { ...ENGLISH, ...info }
  api.uiInfo.mockImplementation(async () => ({ ...full, prefs }))
  await boot.bootLanguage('main')
  hooks.states = []
}

/** Calls the component and every function component under it; host elements and text stay. */
function render(component: () => El | null): El | null {
  hooks.i = 0
  hooks.effects = []
  const expand = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(expand)
    if (!node || typeof node !== 'object' || !('type' in node)) return node
    const el = node as El
    if (typeof el.type === 'function') return expand((el.type as (p: unknown) => unknown)(el.props))
    return { type: el.type, props: { ...el.props, children: expand(el.props.children) } }
  }
  return expand(component()) as El | null
}

function all(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) for (const n of node) all(n, out)
  else if (node && typeof node === 'object' && 'type' in node) {
    out.push(node as El)
    all((node as El).props.children, out)
  }
  return out
}
const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join('') : node && typeof node === 'object' && 'props' in node ? textOf((node as El).props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : ''
const find = (tree: unknown, test: (e: El) => boolean): El | undefined => all(tree).find(test)
const byType = (tree: unknown, type: string): El[] => all(tree).filter((e) => e.type === type)
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  api.setUiPrefs.mockClear()
  api.relaunch.mockClear()
  api.relaunch.mockImplementation(async () => ({ ok: true }))
  setRecordingBusy(null)
})

describe('Settings › Language (test 57)', () => {
  it('is absent while only English ships', async () => {
    await start({ shipped: [], preview: [] })
    expect(boot.showLanguageSection(boot.currentUiInfo())).toBe(false)
    await start({})
    expect(boot.showLanguageSection(boot.currentUiInfo())).toBe(true)
  })

  it('in English: the heading, the label, Follow Windows with the language it gives, and each shipped language', async () => {
    await start({ system: 'bn' })
    const tree = render(LanguageSection)
    expect(textOf(find(tree, (e) => e.type === 'h3'))).toBe('Language')
    expect(textOf(find(tree, (e) => e.type === 'label' && e.props.htmlFor === 'lang-select'))).toBe('Language of Flown')
    const select = find(tree, (e) => e.type === 'select')!
    expect(select.props.value).toBe('en')
    expect(byType(select, 'option').map((o) => [o.props.value, textOf(o)])).toEqual([
      ['system', 'Follow Windows (Bangla)'],
      ['en', 'English'],
      ['bn', 'বাংলা (প্রিভিউ) · Bangla (preview)']
    ])
    await start({ system: 'en', preview: [] })
    const options = byType(render(LanguageSection), 'option').map(textOf)
    expect(options).toEqual(['Follow Windows (English)', 'English', 'বাংলা (Bangla)'])
    // Nothing to restart for, and no digits for English.
    const quiet = render(LanguageSection)
    expect(textOf(find(quiet, (e) => e.props.role === 'status'))).toBe('')
    expect(find(quiet, (e) => e.type === 'button')).toBeUndefined()
    expect(find(quiet, (e) => e.type === 'fieldset')).toBeUndefined()
    expect(byType(quiet, 'p').map(textOf)).toContain('Text that is not translated yet stays in English. This setting does not change your recordings, captions or exported files.')
  })

  it('choosing বাংলা writes ui.language bn on what main holds, and shows the restart notice, the digits and the notes', async () => {
    await start({}, { seen: ['bn'] })
    // Main wrote since the start (the offer answered on Home): kept.
    prefs = { seen: ['bn'], offered: ['bn'] }
    let tree = render(LanguageSection)
    ;(find(tree, (e) => e.type === 'select')!.props.onChange as (e: unknown) => void)({ currentTarget: { value: 'bn' } })
    await flush()
    expect(api.setUiPrefs).toHaveBeenCalledWith({ seen: ['bn'], offered: ['bn'], language: 'bn' })
    tree = render(LanguageSection)
    expect(find(tree, (e) => e.type === 'select')!.props.value).toBe('bn')
    expect(textOf(find(tree, (e) => e.props.role === 'status'))).toBe('Flown switches to Bangla when it restarts.')
    expect(textOf(find(tree, (e) => e.type === 'button'))).toBe('Restart now')
    const radios = byType(find(tree, (e) => e.type === 'fieldset'), 'label')
    expect(radios.map(textOf)).toEqual(['বাংলা ০১২৩', 'Western 0123'])
    expect(find(radios[0], (e) => e.type === 'span')!.props.lang).toBe('bn')
    expect(byType(radios[0], 'input')[0]!.props.checked).toBe(true)
    const notes = byType(tree, 'p').map(textOf)
    expect(notes).toContain('The recording controls are not translated yet.')
    expect(notes).toContain('To hear Flown in Bangla, use a screen reader with a Bangla voice, such as NVDA.')
    ;(byType(radios[1], 'input')[0]!.props.onChange as () => void)()
    await flush()
    expect(api.setUiPrefs).toHaveBeenLastCalledWith({ seen: ['bn'], offered: ['bn'], language: 'bn', digits: 'western' })
  })

  it('Restart now relaunches with the editor’s project, and shows main’s reason or Home’s recording when refused', async () => {
    await start({}, { language: 'bn' })
    boot.noteProjectLanguages({ id: 'proj-1' })
    const press = async (): Promise<El | null> => {
      ;(find(render(LanguageSection), (e) => e.type === 'button')!.props.onClick as () => void)()
      await flush()
      return render(LanguageSection)
    }
    await press()
    expect(api.relaunch).toHaveBeenCalledWith('proj-1')
    api.relaunch.mockImplementation(async () => ({ ok: false, reason: BUSY_COPY.export }))
    let tree = await press()
    expect(textOf(find(tree, (e) => e.props.role === 'status'))).toBe(`Flown switches to Bangla when it restarts. ${BUSY_COPY.export}`)
    // The button stays, to try again.
    expect(find(tree, (e) => e.type === 'button')).toBeDefined()
    api.relaunch.mockClear()
    setRecordingBusy(BUSY_COPY.processing)
    tree = await press()
    expect(api.relaunch).not.toHaveBeenCalled()
    expect(textOf(find(tree, (e) => e.props.role === 'status'))).toContain(BUSY_COPY.processing)
  })

  it('in the Bangla UI: the heading and label keep the English words, English is named in Bangla, and Western digits read ইংরেজি', async () => {
    await start({ language: 'bn', formatLocale: 'bn', digits: 'native', system: 'en', preview: [], catalogue: FIXTURE }, { language: 'bn' })
    expect(rt.uiLanguage()).toBe('bn')
    const tree = render(LanguageSection)
    const h3 = find(tree, (e) => e.type === 'h3')!
    expect(textOf(h3)).toBe('ভাষা · Language')
    expect(find(h3, (e) => e.type === 'span')!.props.lang).toBe('en')
    expect(textOf(find(tree, (e) => e.type === 'label' && e.props.htmlFor === 'lang-select'))).toBe('Flown-এর ভাষা · Language of Flown')
    expect(byType(tree, 'option').map((o) => textOf(o))).toEqual(['Follow Windows (ইংরেজি)', 'English (ইংরেজি)', 'বাংলা'])
    const radios = byType(find(tree, (e) => e.type === 'fieldset'), 'label')
    expect(radios.map(textOf)).toEqual(['বাংলা ০১২৩', 'ইংরেজি 0123'])
    expect(find(radios[0], (e) => e.type === 'span')!.props.lang).toBeUndefined()
    // Nothing changes at a restart yet: no notice.
    expect(textOf(find(tree, (e) => e.props.role === 'status'))).toBe('')
  })
})

describe('the offer on Home (test 58)', () => {
  const offer = async (stored: UiPrefs = {}): Promise<El | null> => {
    await start({ offer: 'bn', preview: [] }, stored)
    const tree = render(LanguageOffer)
    for (const fn of hooks.effects) fn()
    return tree
  }

  it('shows once a shipped language is offered and the language is absent, its Bangla parts in lang="bn"', async () => {
    const tree = (await offer())!
    expect(tree.type).toBe('section')
    expect(tree.props).toMatchObject({ role: 'region', 'aria-label': 'Language' })
    expect(textOf(find(tree, (e) => e.props.role === 'status'))).toBe('Flown is available in Bangla. — Flown এখন বাংলায় পাওয়া যায়।')
    const buttons = byType(tree, 'button')
    expect(buttons.map(textOf)).toEqual(['বাংলা ব্যবহার করুন · Use Bangla', 'এখন না · Not now'])
    for (const e of byType(tree, 'span')) expect(e.props.lang).toBe('bn')
    await start({ offer: null })
    expect(render(LanguageOffer)).toBeNull()
    await start({ offer: 'bn', prefs: { language: 'en' } })
    expect(render(LanguageOffer)).toBeNull()
  })

  it('Not now records the answer and the offer never returns', async () => {
    const tree = (await offer({ seen: ['bn'] }))!
    ;(byType(tree, 'button')[1]!.props.onClick as () => void)()
    expect(render(LanguageOffer)).toBeNull()
    await flush()
    expect(api.setUiPrefs).toHaveBeenCalledWith({ seen: ['bn'], offered: ['bn'] })
    hooks.states = []
    expect(render(LanguageOffer)).toBeNull()
    expect(api.relaunch).not.toHaveBeenCalled()
  })

  it('Use Bangla writes the language and relaunches from Home, with no project to reopen', async () => {
    const tree = (await offer())!
    boot.noteProjectLanguages({ id: 'opened-before' })
    for (const fn of hooks.effects) fn()
    ;(byType(tree, 'button')[0]!.props.onClick as () => void)()
    await flush()
    expect(api.setUiPrefs).toHaveBeenCalledWith({ language: 'bn' })
    expect(api.relaunch).toHaveBeenCalledWith()
  })

  it('while Home records or processes, or main is busy, says Flown opens in Bangla next time and does not quit', async () => {
    setRecordingBusy(BUSY_COPY.processing)
    let tree = (await offer())!
    ;(byType(tree, 'button')[0]!.props.onClick as () => void)()
    await flush()
    expect(api.setUiPrefs).toHaveBeenCalledWith({ language: 'bn' })
    expect(api.relaunch).not.toHaveBeenCalled()
    tree = render(LanguageOffer)!
    expect(textOf(find(tree, (e) => e.props.role === 'status'))).toBe('Flown opens in Bangla the next time it starts. — পরের বার চালু হলে Flown বাংলায় খুলবে।')
    expect(byType(tree, 'button')).toEqual([])
    setRecordingBusy(null)
    api.relaunch.mockImplementation(async () => ({ ok: false, reason: BUSY_COPY.export }))
    tree = (await offer())!
    ;(byType(tree, 'button')[0]!.props.onClick as () => void)()
    await flush()
    expect(api.relaunch).toHaveBeenCalledTimes(1)
    expect(textOf(find(render(LanguageOffer), (e) => e.props.role === 'status'))).toContain('Flown opens in Bangla the next time it starts.')
  })
})

describe('nothing reaches the network (test 60)', () => {
  const root = path.join(__dirname, '..')
  const files = (dir: string): string[] =>
    fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : /\.(ts|tsx|mts|cts|js|mjs)$/.test(d.name) ? [path.join(dir, d.name)] : []))

  it('no source file under src/ imports from scripts/i18n/', () => {
    const offenders = files('src').filter((f) => /from ['"][^'"]*scripts\/i18n\/|import\(['"][^'"]*scripts\/i18n\/|require\(['"][^'"]*scripts\/i18n\//.test(fs.readFileSync(path.join(root, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the language runtime, its settings and its fonts use no network API', () => {
    const own = [
      'src/main/i18n.ts',
      'src/shared/i18n/t.ts',
      'src/shared/i18n/icu.ts',
      'src/shared/i18n/fmt.ts',
      'src/shared/i18n/locale.ts',
      'src/renderer/src/i18n/boot.ts',
      'src/renderer/src/i18n/uiFonts.ts',
      'src/renderer/src/i18n/canvasLang.ts',
      'src/renderer/src/i18n/askConfirm.ts',
      'src/renderer/src/i18n/NumberField.tsx',
      'src/renderer/src/i18n/languageNames.ts',
      'src/renderer/src/settings/LanguageSection.tsx',
      'src/renderer/src/home/LanguageOffer.tsx'
    ]
    for (const f of own) {
      const text = fs.readFileSync(path.join(root, f), 'utf8')
      expect(text, f).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|net\.request|from ['"]node:(https?|net|tls|dgram)['"]|https?:\/\//)
    }
    // The UI faces come from the bundle as same-origin files, never from a URL.
    const fonts = fs.readFileSync(path.join(root, 'src/renderer/src/i18n/uiFonts.ts'), 'utf8')
    expect([...fonts.matchAll(/from '([^']+)'/g)].map((m) => m[1]).filter((s) => s!.includes('fonts/'))).toEqual(['../../../../resources/fonts/noto-sans-bengali.woff2?url', '../../../../resources/fonts/noto-sans-devanagari.woff2?url'])
  })
})
