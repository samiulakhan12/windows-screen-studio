import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UiInfo } from '../src/shared/api/ui'

/*
 * The renderer's side of the UI language (docs/design/output-and-languages.md §9.4 step 4, §9.6,
 * §9.7, §11.1, §12): the language set before the first render, English on any failure (test 55);
 * canvases pinned to English in a translated UI only (test 84); confirmations (test 80); number
 * fields (test 83); the UI fonts and scripts.css (test 59). No DOM: the few browser objects each
 * module touches are stood in for here, and React's useState is answered by the test.
 */

// Stand-ins for the browser, installed before any module under test loads.
class FakeContext {
  lang = 'inherit'
}
class FakeCanvas {
  attrs = new Map<string, string>()
  hasAttribute(n: string): boolean {
    return this.attrs.has(n)
  }
  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v)
  }
  getContext(type: string): unknown {
    return type === '2d' ? new FakeContext() : { webgl: true }
  }
}
class FakeOffscreen {
  getContext(type: string): unknown {
    return type === '2d' ? new FakeContext() : null
  }
}
const faces: { family: string; source: string; descriptors: unknown; settle: 'now' | 'never' }[] = []
let faceLoad: 'now' | 'never' = 'now'
class FakeFontFace {
  constructor(
    readonly family: string,
    readonly source: string,
    readonly descriptors: unknown
  ) {
    faces.push({ family, source, descriptors, settle: faceLoad })
  }
  load(): Promise<unknown> {
    return faceLoad === 'now' ? Promise.resolve(this) : new Promise(() => undefined)
  }
}
const added: unknown[] = []
const html = { lang: 'en', dir: '' }
vi.stubGlobal('HTMLCanvasElement', FakeCanvas)
vi.stubGlobal('OffscreenCanvas', FakeOffscreen)
vi.stubGlobal('FontFace', FakeFontFace)
vi.stubGlobal('document', { documentElement: html, fonts: { add: (f: unknown) => void added.push(f) } })

const api = {
  uiInfo: vi.fn<() => Promise<UiInfo>>(),
  listProjects: vi.fn(async () => [{ id: 'p1' }]),
  noteLanguageSeen: vi.fn(async () => undefined),
  confirm: vi.fn(async () => true)
}
const confirm = vi.fn(() => false)
vi.stubGlobal('window', { api, confirm })

// React's useState, answered here so components can be called as functions.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], i: 0 }))
vi.doMock('react', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useState: (init: unknown) => {
    const k = hooks.i++
    if (!(k in hooks.states)) hooks.states[k] = typeof init === 'function' ? (init as () => unknown)() : init
    return [hooks.states[k], (v: unknown) => (hooks.states[k] = typeof v === 'function' ? (v as (p: unknown) => unknown)(hooks.states[k]) : v)]
  }
}))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const BOOT = '../src/renderer/src/i18n/boot'
const CANVAS = '../src/renderer/src/i18n/canvasLang'
const FONTS = '../src/renderer/src/i18n/uiFonts'
const CONFIRM = '../src/renderer/src/i18n/askConfirm'
const FIELD = '../src/renderer/src/i18n/NumberField'
const MIXED = '../src/renderer/src/editor/mixedControls'
const CATALOG_FONTS = '../src/renderer/src/render/catalogFonts'
const boot = (await import(/* @vite-ignore */ BOOT)) as {
  bootLanguage(view: string): Promise<UiInfo>
  currentUiInfo(): UiInfo
  showLanguageSection(info: UiInfo): boolean
  reopenAfterRelaunch(open: (id: string) => void): void
  noteProjectLanguages(project: unknown): void
  noteHomeShown(shown: boolean): void
  editorProjectToReopen(): string | null
  resetBootForTests(): void
  BUILT_CATALOGUES: Record<string, () => Promise<unknown>>
  BOOT_LIMIT_MS: number
}
const canvas = (await import(/* @vite-ignore */ CANVAS)) as { pinCanvasLanguage(): void; canvasLanguagePinned(): boolean }
const fonts = (await import(/* @vite-ignore */ FONTS)) as { loadUiFont(l: string): Promise<boolean>; UI_FONTS: Record<string, { family: string; file: string; url: string }> }
const { askConfirm } = (await import(/* @vite-ignore */ CONFIRM)) as { askConfirm(message: string, action: string): Promise<boolean> }
const field = (await import(/* @vite-ignore */ FIELD)) as {
  NumberField(props: Record<string, unknown>): { type: unknown; props: Record<string, unknown> }
  stepValue(from: number, dir: 1 | -1, bounds: { min?: number; max?: number; step?: number }): number
}
const { GroupTimeField } = (await import(/* @vite-ignore */ MIXED)) as {
  GroupTimeField(props: { label: string; value: number; mixed?: boolean; min: number; max: number; onCommit: (v: number) => void; testId?: string }): { type: unknown; props: Record<string, unknown> }
}
const { BUNDLED_FONT_URLS } = (await import(/* @vite-ignore */ CATALOG_FONTS)) as { BUNDLED_FONT_URLS: Record<string, string> }
const rt = await import('../src/shared/i18n/t')
const { fmt } = await import('../src/shared/i18n/fmt')

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/i18n/bn.json'), 'utf8')) as { messages: Record<string, string>; latn: string[]; user: Record<string, string[]> }
const ENGLISH_INFO: UiInfo = { language: 'en', formatLocale: 'en-US', dir: 'ltr', digits: 'western', system: 'en', offer: null, shipped: [], preview: [], prefs: {}, reopen: null }
const BANGLA_INFO: UiInfo = { ...ENGLISH_INFO, language: 'bn', formatLocale: 'bn', digits: 'native', shipped: ['bn'], preview: ['bn'], prefs: { language: 'bn' } }
const english = (): void => rt.setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' })
const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

beforeEach(() => {
  boot.resetBootForTests()
  english()
  html.lang = 'en'
  html.dir = ''
  api.uiInfo.mockReset()
  api.noteLanguageSeen.mockClear()
  api.confirm.mockClear()
  confirm.mockClear()
  warn.mockClear()
  faceLoad = 'now'
  for (const k of Object.keys(boot.BUILT_CATALOGUES)) delete boot.BUILT_CATALOGUES[k]
})
afterEach(() => vi.useRealTimers())

describe('English starts as today (tests 55 and 84)', () => {
  it('asks ui:info once and loads nothing, sets nothing on the page and pins no canvas', async () => {
    const load = vi.fn(async () => FIXTURE)
    boot.BUILT_CATALOGUES['/src/shared/i18n/built/bn.json'] = load
    api.uiInfo.mockResolvedValue({ ...ENGLISH_INFO, shipped: ['bn'] })
    expect(await boot.bootLanguage('main')).toMatchObject({ language: 'en', shipped: ['bn'] })
    expect(api.uiInfo).toHaveBeenCalledTimes(1)
    expect(load).not.toHaveBeenCalled()
    expect(faces).toEqual([])
    expect(rt.uiLanguage()).toBe('en')
    expect(html).toEqual({ lang: 'en', dir: '' })
    expect(canvas.canvasLanguagePinned()).toBe(false)
    const c = new FakeCanvas()
    expect((c.getContext('2d') as FakeContext).lang).toBe('inherit')
    expect(c.attrs.has('lang')).toBe(false)
  })

  it('keeps the recording bar English without asking', async () => {
    api.uiInfo.mockResolvedValue(BANGLA_INFO)
    expect(await boot.bootLanguage('toolbar')).toMatchObject({ language: 'en' })
    expect(api.uiInfo).not.toHaveBeenCalled()
  })

  it('shows English when ui:info fails, and says why in the log', async () => {
    api.uiInfo.mockRejectedValue(new Error('no main'))
    expect(await boot.bootLanguage('main')).toEqual(ENGLISH_INFO)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no main'))
    expect(rt.uiLanguage()).toBe('en')
  })

  it('shows English when the catalogue takes longer than 1.5 s, and applies nothing that arrives later', async () => {
    vi.useFakeTimers()
    let arrive!: (v: unknown) => void
    boot.BUILT_CATALOGUES['/src/shared/i18n/built/bn.json'] = () => new Promise((r) => (arrive = r))
    api.uiInfo.mockResolvedValue(BANGLA_INFO)
    const started = boot.bootLanguage('main')
    await vi.advanceTimersByTimeAsync(boot.BOOT_LIMIT_MS - 1)
    let done = false
    void started.then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await started).toMatchObject({ language: 'en', formatLocale: 'en-US', shipped: ['bn'], prefs: { language: 'bn' } })
    arrive({ messages: FIXTURE.messages })
    await vi.advanceTimersByTimeAsync(10)
    expect(rt.uiLanguage()).toBe('en')
    expect(html.lang).toBe('en')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1500 ms'))
  })

  it('shows English when ui:info itself takes longer than 1.5 s', async () => {
    vi.useFakeTimers()
    api.uiInfo.mockReturnValue(new Promise(() => undefined))
    const started = boot.bootLanguage('notes')
    await vi.advanceTimersByTimeAsync(boot.BOOT_LIMIT_MS)
    expect(await started).toEqual(ENGLISH_INFO)
  })

  it('shows English for a language whose catalogue is missing or not one', async () => {
    api.uiInfo.mockResolvedValue(BANGLA_INFO)
    expect(await boot.bootLanguage('main')).toMatchObject({ language: 'en' })
    boot.BUILT_CATALOGUES['/src/shared/i18n/built/bn.json'] = async () => ['not', 'a', 'catalogue']
    expect(await boot.bootLanguage('main')).toMatchObject({ language: 'en' })
    expect(rt.uiLanguage()).toBe('en')
  })
})

describe('a translated UI is set before the first render (test 55)', () => {
  it('loads the built catalogue chunk and the UI font, then sets the catalogue, the canvases and <html lang dir>', async () => {
    const load = vi.fn(async () => FIXTURE)
    boot.BUILT_CATALOGUES['/src/shared/i18n/built/bn.json'] = load
    boot.BUILT_CATALOGUES['/src/shared/i18n/built/hi.json'] = async () => {
      throw new Error('not this one')
    }
    api.uiInfo.mockResolvedValue(BANGLA_INFO)
    expect(await boot.bootLanguage('main')).toEqual(BANGLA_INFO)
    expect(load).toHaveBeenCalledTimes(1)
    expect(rt.uiLanguage()).toBe('bn')
    expect(rt.t('language.section.title')).toBe('ভাষা')
    // A key the catalogue lacks: its English.
    expect(rt.t('language.offer.notNow')).toBe('Not now')
    // Its Latin-digit keys and the user's placeholders come with it.
    expect(rt.t('language.digits.western')).toBe('ইংরেজি 0123')
    expect(rt.userPlaceholders('presets.header.named' as never)).toEqual(['name'])
    expect(html).toEqual({ lang: 'bn', dir: 'ltr' })
    expect(faces.map((f) => f.family)).toContain('Flown UI Bengali')
    expect(canvas.canvasLanguagePinned()).toBe(true)
    expect(boot.currentUiInfo()).toEqual(BANGLA_INFO)
  })

  it('takes the catalogue ui:info hands over in a test build, and does not keep it', async () => {
    api.uiInfo.mockResolvedValue({ ...BANGLA_INFO, catalogue: FIXTURE })
    const info = await boot.bootLanguage('region')
    expect(info.language).toBe('bn')
    expect(info).not.toHaveProperty('catalogue')
    expect(rt.t('language.restart.button')).toBe('‹bn› Restart now')
  })

  it('starts the renderer only after the language is set: main.tsx awaits bootLanguage before it imports the views', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/renderer/src/main.tsx'), 'utf8')
    expect(main.indexOf('await bootLanguage(')).toBeGreaterThan(0)
    expect(main.indexOf("await import('./views')")).toBeGreaterThan(main.indexOf('await bootLanguage('))
    expect(main).not.toMatch(/^import .*['"]\.\/(App|views)['"]/m)
  })
})

describe('canvases in a translated UI (test 84)', () => {
  it('gives every canvas lang="en" when it has none, and every 2D context lang "en" where it has the property', () => {
    canvas.pinCanvasLanguage()
    const c = new FakeCanvas()
    expect((c.getContext('2d') as FakeContext).lang).toBe('en')
    expect(c.attrs.get('lang')).toBe('en')
    const own = new FakeCanvas()
    own.setAttribute('lang', 'fr')
    own.getContext('webgl')
    expect(own.attrs.get('lang')).toBe('fr')
    expect((new FakeOffscreen().getContext('2d') as FakeContext).lang).toBe('en')
    // A context without the property gains none.
    expect('lang' in (new FakeCanvas().getContext('webgl') as object)).toBe(false)
    // Installed once: a second call wraps nothing again.
    const wrapped = FakeCanvas.prototype.getContext
    canvas.pinCanvasLanguage()
    expect(FakeCanvas.prototype.getContext).toBe(wrapped)
  })
})

describe('reopening after a relaunch, the Language section, the languages seen (tests 55, 57, 58)', () => {
  it('opens the project once, and only when it still exists', async () => {
    api.uiInfo.mockResolvedValue({ ...ENGLISH_INFO, reopen: 'p1' })
    await boot.bootLanguage('main')
    const open = vi.fn()
    boot.reopenAfterRelaunch(open)
    boot.reopenAfterRelaunch(open)
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('p1'))
    expect(open).toHaveBeenCalledTimes(1)
    api.uiInfo.mockResolvedValue({ ...ENGLISH_INFO, reopen: 'gone' })
    await boot.bootLanguage('main')
    const none = vi.fn()
    boot.reopenAfterRelaunch(none)
    await new Promise((r) => setTimeout(r, 5))
    expect(none).not.toHaveBeenCalled()
  })

  it('shows the Language section only once a language other than English ships', () => {
    expect(boot.showLanguageSection(ENGLISH_INFO)).toBe(false)
    expect(boot.showLanguageSection({ ...ENGLISH_INFO, shipped: ['en'] })).toBe(false)
    expect(boot.showLanguageSection({ ...ENGLISH_INFO, shipped: ['bn'] })).toBe(true)
  })

  it('notes a shipped language a project is in once, and nothing in an English-only install', async () => {
    const project = (id: string, transcript: string | null, tracks: string[] = []) => ({
      id,
      transcript: transcript ? { language: transcript, segments: [{ id: 's', start: 0, end: 1, text: 'x', words: [] }] } : undefined,
      captionTracks: tracks.map((language) => ({ language }))
    })
    api.uiInfo.mockResolvedValue(ENGLISH_INFO)
    await boot.bootLanguage('main')
    boot.noteProjectLanguages(project('a', 'bn-BD'))
    expect(api.noteLanguageSeen).not.toHaveBeenCalled()
    api.uiInfo.mockResolvedValue({ ...ENGLISH_INFO, shipped: ['bn'] })
    await boot.bootLanguage('main')
    boot.noteProjectLanguages(project('b', 'en', ['hi', 'es']))
    expect(api.noteLanguageSeen).not.toHaveBeenCalled()
    boot.noteProjectLanguages(project('c', 'en', ['bn']))
    boot.noteProjectLanguages(project('d', 'bn'))
    expect(api.noteLanguageSeen.mock.calls).toEqual([['bn']])
    boot.resetBootForTests()
    api.uiInfo.mockResolvedValue({ ...ENGLISH_INFO, shipped: ['bn'], prefs: { seen: ['bn'] } })
    await boot.bootLanguage('main')
    boot.noteProjectLanguages(project('e', 'bn'))
    expect(api.noteLanguageSeen).toHaveBeenCalledTimes(1)
  })

  it('reopens the editor’s project after Restart now, and none from Home', () => {
    expect(boot.editorProjectToReopen()).toBeNull()
    boot.noteProjectLanguages({ id: 'open-1' })
    expect(boot.editorProjectToReopen()).toBe('open-1')
    boot.noteHomeShown(true)
    expect(boot.editorProjectToReopen()).toBeNull()
    // A project that finished opening after Home came back is not the one on screen.
    boot.noteProjectLanguages({ id: 'late' })
    expect(boot.editorProjectToReopen()).toBeNull()
    boot.noteHomeShown(false)
    boot.noteProjectLanguages({ id: 'open-2' })
    expect(boot.editorProjectToReopen()).toBe('open-2')
  })
})

describe('askConfirm (test 80)', () => {
  it('in English asks window.confirm with exactly the message, and nothing else', async () => {
    confirm.mockReturnValueOnce(true)
    expect(await askConfirm('Delete this project? This cannot be undone.', 'presets.delete.confirm')).toBe(true)
    expect(confirm.mock.calls).toEqual([['Delete this project? This cannot be undone.']])
    expect(api.confirm).not.toHaveBeenCalled()
  })

  it('in Bangla asks main with the action and Cancel in the UI language, and returns the choice', async () => {
    rt.setCatalogue({ language: 'bn', messages: FIXTURE.messages, formatLocale: 'bn', dir: 'ltr' })
    api.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await askConfirm('প্রকল্পটি মুছবেন?', 'presets.delete.confirm')).toBe(true)
    expect(await askConfirm('প্রকল্পটি মুছবেন?', 'presets.delete.confirm')).toBe(false)
    expect(api.confirm.mock.calls).toEqual([
      [{ message: 'প্রকল্পটি মুছবেন?', action: 'মুছুন', cancel: 'বাতিল' }],
      [{ message: 'প্রকল্পটি মুছবেন?', action: 'মুছুন', cancel: 'বাতিল' }]
    ])
    expect(confirm).not.toHaveBeenCalled()
    // Main could not ask: the question is still asked.
    api.confirm.mockRejectedValueOnce(new Error('Invalid confirmation'))
    confirm.mockReturnValueOnce(true)
    expect(await askConfirm('x'.repeat(3000), 'presets.delete.confirm')).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})

describe('number fields (test 83)', () => {
  const site = { inputMode: 'decimal', 'aria-label': 'Target size in MB', placeholder: 'Off', min: 1, max: 4000, step: 1 }

  it('in English renders the same <input type="number"> as the site it replaces', async () => {
    const onValue = vi.fn()
    const el = field.NumberField({ ...site, value: 25, onValue })
    expect(el.type).toBe('input')
    const { onChange, ...attrs } = el.props
    expect(attrs).toEqual({ type: 'number', ...site, value: 25 })
    expect(Object.keys(el.props)).toEqual(['type', ...Object.keys(site), 'value', 'onChange'])
    ;(onChange as (e: unknown) => void)({ currentTarget: { valueAsNumber: 30 } })
    expect(onValue).toHaveBeenCalledWith(30)
  })

  it('in Bangla is a text field showing ২৫ that reads any digits and steps within min and max', () => {
    rt.setCatalogue({ language: 'bn', messages: {}, formatLocale: 'bn', dir: 'ltr' })
    const onValue = vi.fn()
    const render = (value: number) => {
      hooks.i = 0
      const outer = field.NumberField({ ...site, min: 1, max: 30, value, onValue })
      return (outer.type as (p: Record<string, unknown>) => { type: string; props: Record<string, unknown> })(outer.props)
    }
    hooks.states = []
    let el = render(25)
    expect(el.type).toBe('input')
    expect(el.props).toMatchObject({ type: 'text', inputMode: 'decimal', role: 'spinbutton', value: '২৫', 'aria-valuenow': 25, 'aria-valuemin': 1, 'aria-valuemax': 30, 'aria-label': 'Target size in MB' })
    expect(el.props).not.toHaveProperty('min')
    const key = (k: string): { preventDefault: () => void; prevented: boolean } => {
      const e = { key: k, defaultPrevented: false, prevented: false, preventDefault: () => ((e.prevented = true), (e.defaultPrevented = true)) }
      ;(el.props.onKeyDown as (e: unknown) => void)(e)
      return e
    }
    expect(key('ArrowUp').prevented).toBe(true)
    expect(onValue).toHaveBeenLastCalledWith(26)
    key('ArrowDown')
    expect(onValue).toHaveBeenLastCalledWith(24)
    expect(key('a').prevented).toBe(false)
    el = render(30)
    key('ArrowUp')
    expect(onValue).toHaveBeenLastCalledWith(30)
    el = render(1)
    key('ArrowDown')
    expect(onValue).toHaveBeenLastCalledWith(1)
    // Typed or pasted digits of any script, kept as typed while the field has the focus.
    ;(el.props.onChange as (e: unknown) => void)({ currentTarget: { value: '২৭' } })
    expect(onValue).toHaveBeenLastCalledWith(27)
    el = render(1)
    expect(el.props.value).toBe('২৭')
    ;(el.props.onChange as (e: unknown) => void)({ currentTarget: { value: '2৫x' } })
    expect(onValue.mock.lastCall![0]).toBeNaN()
    ;(el.props.onBlur as (e: unknown) => void)({})
    expect(render(27).props.value).toBe('২৭')
  })

  it('in the Selection view outside English, the group’s time field shows each step, says it, and commits where the steps end', () => {
    rt.setCatalogue({ language: 'bn', messages: {}, formatLocale: 'bn', dir: 'ltr' })
    type Node = { type: unknown; props: Record<string, unknown> }
    let value = 1
    const commits: number[] = []
    const onCommit = (v: number): void => void (commits.push(v), (value = v))
    // GroupTimeField, then NumberField, then the field outside English: one useState each, in that order.
    const render = (): Node => {
      hooks.i = 0
      let el: Node = GroupTimeField({ label: 'Starts at', testId: 'group-start', value, min: 0, max: 30, onCommit })
      while (typeof el.type === 'function') el = (el.type as (p: Record<string, unknown>) => Node)(el.props)
      return el
    }
    const key = (k: string): void => {
      const e = { key: k, defaultPrevented: false, preventDefault: () => void (e.defaultPrevented = true), stopPropagation: () => undefined }
      ;(render().props.onKeyDown as (e: unknown) => void)(e)
    }
    hooks.states = []
    expect(render().props).toMatchObject({ type: 'text', role: 'spinbutton', 'data-testid': 'group-start', value: fmt.count(1), 'aria-valuenow': 1 })
    for (const shown of [1.1, 1.2, 1.3]) {
      key('ArrowUp')
      expect(render().props).toMatchObject({ value: fmt.count(shown), 'aria-valuenow': shown, 'aria-valuetext': fmt.count(shown) })
    }
    expect(commits).toEqual([])
    ;(render().props.onBlur as (e: unknown) => void)({})
    expect(commits).toEqual([1.3])
    expect(render().props).toMatchObject({ value: fmt.count(1.3), 'aria-valuenow': 1.3 })
    // Typed digits, then a step from them; Enter commits where the step ends.
    ;(render().props.onChange as (e: unknown) => void)({ currentTarget: { value: '২.৫' } })
    key('ArrowDown')
    expect(render().props).toMatchObject({ value: fmt.count(2.4), 'aria-valuenow': 2.4 })
    key('Enter')
    expect(commits).toEqual([1.3, 2.4])
  })

  it('steps as a number input does, from min by step, without float noise', () => {
    expect(field.stepValue(0.1, 1, { step: 0.1 })).toBe(0.2)
    expect(field.stepValue(0.2, 1, { step: 0.1 })).toBe(0.3)
    expect(field.stepValue(2.5, 1, { min: 0, step: 1 })).toBe(3)
    expect(field.stepValue(2.5, -1, { min: 0, step: 1 })).toBe(2)
    expect(field.stepValue(3, 1, { min: 1, step: 2 })).toBe(5)
    expect(field.stepValue(Number.NaN, 1, { min: 5, max: 9 })).toBe(6)
    expect(field.stepValue(9, 1, { min: 5, max: 9 })).toBe(9)
    expect(field.stepValue(5, -1, { min: 5 })).toBe(5)
    expect(fmt.parseNumber('২৫')).toBe(25)
  })
})

describe('the UI fonts and scripts.css (test 59)', () => {
  it('registers "Flown UI Bengali" from the bundled caption font, bounded at 1 s; nothing for English', async () => {
    faces.length = 0
    added.length = 0
    expect(await fonts.loadUiFont('en')).toBe(true)
    expect(await fonts.loadUiFont('es')).toBe(true)
    expect(faces).toEqual([])
    expect(await fonts.loadUiFont('hi')).toBe(true)
    expect(faces[0]).toMatchObject({ family: 'Flown UI Devanagari', source: `url("${BUNDLED_FONT_URLS['noto-sans-devanagari.woff2']}")`, descriptors: { weight: '100 900' } })
    vi.useFakeTimers()
    faces.length = 0
    faceLoad = 'never'
    // A fresh module, so the Bengali face is registered here.
    vi.resetModules()
    const fresh = (await import(/* @vite-ignore */ FONTS)) as typeof fonts
    const loading = fresh.loadUiFont('bn')
    await vi.advanceTimersByTimeAsync(999)
    let done: boolean | null = null
    void loading.then((v) => (done = v))
    await Promise.resolve()
    expect(done).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(await loading).toBe(false)
    expect(faces).toEqual([expect.objectContaining({ family: 'Flown UI Bengali', source: `url("${BUNDLED_FONT_URLS['noto-sans-bengali.woff2']}")` })])
    expect(added).toHaveLength(2)
  })

  it('adds no asset: each UI face is a bundled caption font, imported by the same file name', () => {
    const src = (f: string): string => fs.readFileSync(path.join(__dirname, '../src/renderer/src', f), 'utf8')
    const imports = (text: string): string[] => [...text.matchAll(/from '([^']+\.woff2)\?url'/g)].map((m) => m[1]!)
    const ui = imports(src('i18n/uiFonts.ts'))
    expect(ui).toEqual(['../../../../resources/fonts/noto-sans-bengali.woff2', '../../../../resources/fonts/noto-sans-devanagari.woff2'])
    const caption = imports(src('render/catalogFonts.ts'))
    for (const file of ui) expect(caption, file).toContain(file)
    for (const f of Object.values(fonts.UI_FONTS)) expect(f.url).toBe(BUNDLED_FONT_URLS[f.file])
  })

  it('raises the tokens and names the face in the mono stack under :lang(bn) and :lang(hi) only', () => {
    const css = fs.readFileSync(path.join(__dirname, '../src/renderer/src/i18n/scripts.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = css
      .split('}')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [sel, body] = r.split('{')
        return { selectors: sel!.split(',').map((s) => s.trim()), body: body!.trim() }
      })
    expect(rules.length).toBeGreaterThan(3)
    for (const r of rules) for (const s of r.selectors) expect(s, s).toMatch(/:lang\((bn|hi)\)$/)
    const decl = (selector: string, name: string): string | undefined =>
      rules
        .filter((r) => r.selectors.includes(selector))
        .flatMap((r) => r.body.split(';'))
        .map((d) => d.split(':').map((x) => x.trim()))
        .find(([k]) => k === name)?.[1]
    expect(decl(':root:lang(bn)', '--text-md')).toBe('14px')
    expect(decl(':root:lang(hi)', '--text-2xs')).toBe('11.5px')
    expect(decl(':root:lang(bn)', '--leading-tight')).toBe('1.4')
    expect(decl(':root:lang(bn)', '--leading-normal')).toBe('1.6')
    expect(decl(':root:lang(bn)', '--tracking-caps')).toBe('0')
    expect(decl(':root:lang(bn)', '--font-mono')).toMatch(/^'Cascadia Mono', 'Flown UI Bengali'/)
    expect(decl(':root:lang(hi)', '--font-mono')).toMatch(/^'Cascadia Mono', 'Flown UI Devanagari'/)
    expect(decl(':root:lang(bn)', '--font-sans')).toMatch(/^'Segoe UI Variable Text', 'Segoe UI', 'Flown UI Bengali'/)
    for (const r of rules) if (/Bengali/.test(r.body)) expect(r.selectors).toEqual([':root:lang(bn)'])
    for (const r of rules) if (/Devanagari/.test(r.body)) expect(r.selectors).toEqual([':root:lang(hi)'])
    // Every line height of 1 the design names is raised.
    for (const sel of ['.chapter-flag', '.tick', '.shortcut-keys kbd', '.freeze-label', '.notes-window .nw-line-marker']) expect(decl(`${sel}:lang(bn)`, 'line-height'), sel).toBe('1.4')
  })
})
