import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageKey } from '../src/shared/i18n/t'

/*
 * The message runtime (docs/design/output-and-languages.md §9.1, §9.3, §13.3; test 7) and the English
 * catalogue the contracts wrote (§9.2). English is registered by tests/setup/i18n.ts, as main.tsx does.
 */

const rt = await import('../src/shared/i18n/t')
const { parseIcu, formatIcu, argumentsOf } = await import('../src/shared/i18n/icu')
const { isolate, withoutIsolates } = await import('../src/shared/i18n/isolate')

const english = (): void => rt.setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' })
afterEach(english)

const key = (k: string): MessageKey => k as MessageKey

describe('t() (test 7)', () => {
  it('formats English with values', () => {
    expect(rt.t('codecs.notice.cannotMake', { codec: 'HEVC', fallback: 'H.264' })).toBe('This PC cannot make HEVC, so this export uses H.264.')
    expect(rt.t('presets.header.named', { name: 'Client review' })).toBe('Settings · Client review')
  })

  it('falls back to English for a key the catalogue lacks: not translated, or left out as stale by the build', () => {
    rt.setCatalogue({ language: 'bn', messages: { 'presets.save.button': 'প্রিসেট হিসেবে রাখুন' }, formatLocale: 'bn-BD', dir: 'ltr' })
    expect(rt.t('presets.save.button')).toBe('প্রিসেট হিসেবে রাখুন')
    expect(rt.t('presets.save.field')).toBe('Preset name')
    expect(rt.uiLanguage()).toBe('bn')
  })

  it('selects plurals on `count` and shows `n`, so no message needs #', () => {
    expect(rt.t('presets.import.done', { count: 1, n: '1' })).toBe('Imported 1 preset.')
    expect(rt.t('presets.import.done', { count: 1234, n: '1234' })).toBe('Imported 1234 presets.')
    expect(rt.t('presets.import.overLimit', { count: 3, n: '3', limit: '50' })).toBe('You can keep 50 presets, so 3 were not imported.')
    // A Bangla plural holds only `other`, and shows count 0 the same way (§9.3).
    rt.setCatalogue({ language: 'bn', messages: { 'presets.import.done': '{count, plural, other {{n}টি প্রিসেট আনা হয়েছে।}}' }, formatLocale: 'bn-BD', dir: 'ltr' })
    expect(rt.t('presets.import.done', { count: 0, n: '০' })).toBe('০টি প্রিসেট আনা হয়েছে।')
  })

  it('maps rich tags to the caller’s nodes, and keeps their text in a plain string', () => {
    rt.registerMessages('en', { 'test.rich': 'Press <kbd>{key}</kbd> to <b>save</b>.' })
    const parts = rt.tParts<{ tag: string; chunks: unknown[] }>(key('test.rich'), { key: 'Ctrl+S' }, { kbd: (chunks) => ({ tag: 'kbd', chunks }), b: (chunks) => ({ tag: 'b', chunks }) })
    expect(parts).toEqual(['Press ', { tag: 'kbd', chunks: ['Ctrl+S'] }, ' to ', { tag: 'b', chunks: ['save'] }, '.'])
    expect(rt.t(key('test.rich'), { key: 'Ctrl+S' })).toBe('Press Ctrl+S to save.')
  })

  it('isolates the user’s text outside English and adds nothing in English', () => {
    expect(rt.t('presets.more.name', { name: 'مشروع' })).toBe('More for مشروع')
    expect(isolate('মিনা')).toBe('মিনা')
    rt.setCatalogue({ language: 'bn', messages: { 'presets.more.name': '{name}-এর আরও' }, user: { 'presets.more.name': ['name'] }, formatLocale: 'bn-BD', dir: 'ltr' })
    expect(rt.t('presets.more.name', { name: 'Demo 2' })).toBe('\u2068Demo 2\u2069-এর আরও')
    expect(isolate('C:\\x', 'ltr')).toBe('\u2066C:\\x\u2069')
    expect(withoutIsolates(rt.t('presets.more.name', { name: 'Demo' }))).toBe('Demo-এর আরও')
  })

  it('writes Latin digits in a technical line outside English, and prose as given', () => {
    rt.setCatalogue({ language: 'bn', messages: {}, latn: ['codecs.fps.chip'], formatLocale: 'bn-BD', dir: 'ltr' })
    expect(rt.t('codecs.fps.chip', { fps: '১২০' })).toBe('120 fps')
    expect(rt.t('presets.header.named', { name: '১২০' })).toBe('Settings · ১২০')
  })

  it('throws before any messages are registered, so text made at module scope cannot pass quietly', async () => {
    vi.resetModules()
    const fresh = await import('../src/shared/i18n/t')
    expect(() => fresh.t('presets.save.button')).toThrow(/before any messages were registered/)
    fresh.registerMessages('en', { 'presets.save.button': 'Save as preset' })
    expect(fresh.t('presets.save.button')).toBe('Save as preset')
    expect(() => fresh.t(key('presets.nope'))).toThrow(/Unknown message key/)
  })
})

describe('<T> (test 7)', () => {
  it('renders a fragment: no wrapper element, rich tags as the caller’s elements, <bdi> only outside English', async () => {
    // One module registry for T.tsx, t.ts and the English messages (an earlier test reset it).
    vi.resetModules()
    await import('../src/shared/i18n/messages/en/index')
    const rt = await import('../src/shared/i18n/t')
    const React = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const T_PATH = '../src/renderer/src/i18n/T'
    const { T } = (await import(/* @vite-ignore */ T_PATH)) as { T: (props: Record<string, unknown>) => unknown }
    const render = (props: Record<string, unknown>): string => renderToStaticMarkup(React.createElement(T as never, props))
    expect(render({ k: 'presets.save.button' })).toBe('Save as preset')
    rt.registerMessages('en', { 'test.kbd': 'Press <kbd>{key}</kbd>' })
    expect(render({ k: 'test.kbd', values: { key: 'Enter' }, tags: { kbd: (c: unknown[]) => React.createElement('kbd', null, ...(c as string[])) } })).toBe('Press <kbd>Enter</kbd>')
    expect(render({ k: 'presets.more.name', values: { name: 'Demo' } })).toBe('More for Demo')
    rt.setCatalogue({ language: 'bn', messages: { 'presets.more.name': '{name}-এর আরও' }, user: { 'presets.more.name': ['name'] }, formatLocale: 'bn-BD', dir: 'ltr' })
    expect(render({ k: 'presets.more.name', values: { name: 'Demo' } })).toBe('<bdi>Demo</bdi>-এর আরও')
    rt.setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' })
  })
})

describe('the ICU subset', () => {
  const fmt = (source: string, values: Record<string, unknown> = {}, language = 'en'): string => formatIcu<string>(parseIcu(source), values, { language, formatLocale: language }).join('')

  it('reads apostrophes as ICU does', () => {
    expect(fmt("Don't stop")).toBe("Don't stop")
    expect(fmt("It''s {x}", { x: 'fine' })).toBe("It's fine")
    expect(fmt("Type '{name}' literally")).toBe('Type {name} literally')
    expect(fmt("'<b>' stays")).toBe('<b> stays')
  })

  it('selects exact plural values first, then the language’s category, then other', () => {
    const msg = '{count, plural, =0 {none} one {{n} item} other {{n} items}}'
    expect(fmt(msg, { count: 0, n: '0' })).toBe('none')
    expect(fmt(msg, { count: 1, n: '1' })).toBe('1 item')
    expect(fmt(msg, { count: 2, n: '2' })).toBe('2 items')
    expect(fmt('{count, plural, one {a} other {b}}', { count: 0 }, 'bn')).toBe('a')
    expect(fmt('{count, plural, other {b}}', { count: 0 }, 'bn')).toBe('b')
    expect(fmt('{count, plural, offset:1 one {#} other {# more}}', { count: 3 })).toBe('2 more')
    expect(fmt('{kind, select, gif {GIF} other {video}}', { kind: 'gif' })).toBe('GIF')
    expect(fmt('{kind, select, gif {GIF} other {video}}', { kind: 'mp4' })).toBe('video')
  })

  it('refuses what is outside the subset, and names a missing value', () => {
    expect(() => parseIcu('<script>x</script>')).toThrow(/unknown tag/)
    expect(() => parseIcu('{n, plural, one {x}}')).toThrow(/without other/)
    expect(() => parseIcu('{n, date}')).toThrow(/unsupported/)
    expect(() => parseIcu('a } b')).toThrow()
    expect(() => parseIcu('<b>open')).toThrow(/missing <\/b>/)
    expect(() => fmt('Hi {name}')).toThrow(/{name}/)
    expect([...argumentsOf(parseIcu('{a} {count, plural, other {{n}}} <b>{c}</b>'))].sort()).toEqual(['a', 'c', 'count', 'n'])
  })
})

describe('the English catalogue of the contracts (§9.2, §9.3)', () => {
  const dir = path.join(__dirname, '../src/shared/i18n/messages/en')
  const namespaces = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json')).map((f) => f.slice(0, -5))

  it('has every namespace of §9.2, each with its meta file', () => {
    expect(namespaces.sort()).toEqual(
      ['common', 'keys', 'commands', 'home', 'editor', 'timeline', 'style', 'zoom', 'camera', 'sound', 'captions', 'text', 'review', 'smart', 'export', 'settings', 'errors', 'main', 'codecs', 'alpha', 'stems', 'timelines', 'presets', 'language', 'recording'].sort()
    )
    for (const ns of namespaces) expect(fs.existsSync(path.join(dir, `${ns}.meta.json`)), ns).toBe(true)
  })

  it('fills the new features’ namespaces, and every message parses, is NFC, uses no # or number argument, and has its meta entry', () => {
    for (const ns of ['codecs', 'alpha', 'stems', 'timelines', 'presets', 'language', 'errors', 'main']) {
      const messages = JSON.parse(fs.readFileSync(path.join(dir, `${ns}.json`), 'utf8')) as Record<string, string>
      const meta = JSON.parse(fs.readFileSync(path.join(dir, `${ns}.meta.json`), 'utf8')) as Record<string, { description: string; digits?: string; user?: string[] }>
      expect(Object.keys(messages).length, ns).toBeGreaterThan(0)
      expect(Object.keys(meta).sort(), ns).toEqual(Object.keys(messages).sort())
      for (const [k, text] of Object.entries(messages)) {
        const nodes = parseIcu(text)
        expect(text.normalize('NFC'), `${ns}.${k}`).toBe(text)
        expect(text, `${ns}.${k}`).not.toMatch(/\{\s*\w+\s*,\s*number|'[{}#]/)
        expect(JSON.stringify(nodes), `${ns}.${k}`).not.toContain('"pound"')
        expect(meta[k].description.length, `${ns}.${k}`).toBeGreaterThan(0)
        for (const u of meta[k].user ?? []) expect(argumentsOf(nodes).has(u), `${ns}.${k} ${u}`).toBe(true)
      }
    }
  })

  it('keeps the exact English of §2 for the texts users see', () => {
    expect(rt.t('codecs.codec.hevc.title')).toBe("About a third smaller than H.264 at the same quality. Made by your graphics card. Windows needs Microsoft's HEVC Video Extensions to play it")
    expect(rt.t('alpha.hint.fills')).toBe('With no padding the recording fills the frame: nothing will be see-through. Add padding in Style, or choose Overlays only.')
    expect(rt.t('stems.hint.saves', { list: 'Voice, System sound and Music', size: '23 MB' })).toBe('Saves Voice, System sound and Music (32-bit float WAV, about 23 MB each).')
    expect(rt.t('timelines.blocked.finalcutCodec', { codec: 'WebM' })).toBe('Final Cut Pro cannot open WebM files. Choose H.264 or HEVC.')
    expect(rt.t('presets.import.changed', { count: 2, n: '2' })).toBe('2 presets use ProRes, which Flown does not make: they export as MOV with CineForm.')
    expect(rt.t('language.note.untranslated')).toBe('Text that is not translated yet stays in English. This setting does not change your recordings, captions or exported files.')
    expect(rt.t('errors.disk.space', { size: '3.2 GB', free: '1.1 GB' })).toBe('This export needs about 3.2 GB and the folder has 1.1 GB free. Choose another folder or a smaller format.')
    expect(rt.t('codecs.format.made', { codec: 'CineForm', audio: 'pcm' })).toBe('CineForm video with uncompressed audio')
  })
})
