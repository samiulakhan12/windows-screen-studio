import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SoundLibraryState } from '../src/shared/api/soundLibrary'
import type { Project } from '../src/shared/types'
import { byLabel, byTestId, allByTestId, contexts, key, mockReact, render, settle, testStore, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * Editing polish, part P5 (docs/design/editing-polish.md §2.6, §12, §16, §19.1 test 73): the Audio
 * tab's music library, its sound effects and Settings › Downloads › More music, rendered without a
 * DOM. The main process is a stand-in that lists the beds as main would (the eight download beds
 * only while a source exists) and records the calls.
 */

const api = vi.hoisted(() => ({
  states: [] as SoundLibraryState[],
  progress: null as null | ((s: SoundLibraryState) => void),
  calls: [] as unknown[][],
  failDownload: null as string | null
}))
const played = vi.hoisted(() => [] as { url: string; paused: boolean; volume: number }[])
vi.mock('../src/renderer/src/editor/media', async (original) => ({
  ...(await original<object>()),
  createAudio: (url: string) => {
    const a = { url, paused: true, volume: 1, onended: null as null | (() => void), play: async () => void (a.paused = false), pause: () => void (a.paused = true) }
    played.push(a)
    return a
  }
}))
vi.stubGlobal('window', {
  api: {
    soundLibraryList: async () => api.states,
    soundLibraryDownload: async (id: string) => {
      api.calls.push(['download', id])
      if (api.failDownload) throw new Error(api.failDownload)
      return { id, state: 'downloaded', bytes: 1 }
    },
    soundLibraryUseBed: async (projectId: string, id: string) => {
      api.calls.push(['useBed', projectId, id])
      return { file: `music-${api.calls.filter((c) => c[0] === 'useBed').length + 1}.ogg` }
    },
    soundLibraryRemove: async () => void api.calls.push(['remove']),
    soundLibraryCancel: async () => undefined,
    onSoundLibraryProgress: (fn: (s: SoundLibraryState) => void) => {
      api.progress = fn
      return () => (api.progress = null)
    }
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined
})
vi.stubGlobal('document', { activeElement: null, body: {} })

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const LIB = '../src/renderer/src/editor/panels/MusicLibrarySection'
const FX = '../src/renderer/src/editor/panels/SoundEffectsSection'
const DL = '../src/renderer/src/settings/MusicDownloadsSection'
const { MusicLibrarySection, MusicCredit } = (await import(/* @vite-ignore */ LIB)) as { MusicLibrarySection: (p: unknown) => unknown; MusicCredit: (p: unknown) => unknown }
const { SoundEffectsSection } = (await import(/* @vite-ignore */ FX)) as { SoundEffectsSection: (p: unknown) => unknown }
const { MusicDownloadsSection } = (await import(/* @vite-ignore */ DL)) as { MusicDownloadsSection: () => unknown }
await useEditorContexts()
const { createProject } = await import('../src/shared/engine/project')
const { MUSIC_BEDS, soundBed } = await import('../src/shared/audio/soundLibrary')
const { sfxCounts } = await import('../src/shared/render/sfxJob')

const base = createProject({ id: 'p1', name: 'p', duration: 60, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: false, capture: { method: 'native', cursorInVideo: false, region: null } })
const bundled = (): SoundLibraryState[] => MUSIC_BEDS.filter((b) => b.bundled).map((b) => ({ id: b.id, state: 'bundled', bytes: b.prepared.bytes }))
const withDownloads = (): SoundLibraryState[] => [...bundled(), ...MUSIC_BEDS.filter((b) => !b.bundled).map((b) => ({ id: b.id, state: 'missing' as const, bytes: b.prepared.bytes }))]

let store: ReturnType<typeof testStore<Project>>
const player = { reloadMusic: vi.fn() }
beforeEach(() => {
  unmountAll()
  played.length = 0
  api.calls.length = 0
  api.failDownload = null
  api.states = bundled()
  store = testStore<Project>({ ...base, audio: { ...base.audio, music: { path: 'music-1.mp3', volume: 0.6, ducking: 0.4, loop: false, fadeIn: 3, fadeOut: 4 } } })
  contexts.editor = { store, player }
  player.reloadMusic.mockClear()
})

const lib = (): unknown => ({ type: MusicLibrarySection, props: { project: store.state } })
const rows = (els: El[]): string[] => allByTestId(els, 'music-row').map((r) => String(r.props['data-bed']))
const inRow = (els: El[], id: string, testId: string): El | undefined => {
  // The row's elements follow it in document order up to the next row.
  const start = els.findIndex((e) => e.props['data-testid'] === 'music-row' && e.props['data-bed'] === id)
  const next = els.findIndex((e, i) => i > start && e.props['data-testid'] === 'music-row')
  return els.slice(start, next < 0 ? undefined : next).find((e) => e.props['data-testid'] === testId)
}
const click = (el: El | undefined): unknown => (el!.props.onClick as () => unknown)()
const live = (els: El[]): string => textOf(els.find((e) => e.props.role === 'status')!)
/** Lets the main process's answers arrive (a click's work is not awaited by the button), then renders the project as it is now. */
const after = async (): Promise<El[]> => {
  await settle(lib())
  return render(lib())
}

describe('the music library (test 73)', () => {
  it('lists the four bundled beds only while there is no download source, with title, artist, mood and length', async () => {
    const els = await settle(lib())
    expect(rows(els)).toEqual(['calm-spring-on-the-horizon', 'upbeat-sweet-sun', 'corporate-one-cool-minute', 'lofi-coexistenz'])
    expect(byTestId(els, 'music-library')!.props.role).toBe('list')
    const row = allByTestId(els, 'music-row').find((r) => r.props['data-bed'] === 'upbeat-sweet-sun')!
    expect(textOf(row)).toContain('Sweet Sun')
    expect(textOf(row)).toContain('Loyalty Freak Music · Upbeat · 1:43')
    // Screen readers hear the length in words.
    expect(textOf(row)).toContain('1 minute 43 seconds')
    expect(allByTestId(els, 'music-download')).toHaveLength(0)
  })

  it('the mood chips are a radiogroup that filters, with arrow keys', async () => {
    let els = await settle(lib())
    const group = byTestId(els, 'music-mood')!
    expect(group.props.role).toBe('radiogroup')
    const radios = els.filter((e) => e.props.role === 'radio')
    expect(radios.map((r) => textOf(r))).toEqual(['All', 'Calm', 'Upbeat', 'Corporate', 'Lo-fi', 'Cinematic'])
    expect(radios.map((r) => r.props['aria-checked'])).toEqual([true, false, false, false, false, false])
    click(radios[4])
    els = render(lib())
    expect(rows(els)).toEqual(['lofi-coexistenz'])
    const e = key('ArrowRight')
    ;(els.filter((x) => x.props.role === 'radio')[4].props.onKeyDown as (e: unknown) => void)(e)
    expect(e.prevented).toBe(true)
    els = render(lib())
    expect(els.filter((x) => x.props.role === 'radio')[5].props['aria-checked']).toBe(true)
    expect(rows(els)).toEqual([])
  })

  it('Play toggles a preview from the library, Esc in the list stops it, and the live region says so', async () => {
    let els = await settle(lib())
    const play = inRow(els, 'upbeat-sweet-sun', 'music-play')!
    expect(play.props['aria-label']).toBe('Play preview of Sweet Sun')
    expect(play.props['aria-pressed']).toBe(false)
    click(play)
    els = render(lib())
    expect(played.at(-1)!.url).toBe('studio-media://sounds/bed-upbeat-sweet-sun.ogg')
    expect(played.at(-1)!.paused).toBe(false)
    expect(inRow(els, 'upbeat-sweet-sun', 'music-play')!.props['aria-pressed']).toBe(true)
    expect(live(els)).toBe('Playing preview: Sweet Sun, 1 minute 43 seconds')
    const esc = key('Escape')
    ;(byTestId(els, 'music-library')!.props.onKeyDown as (e: unknown) => void)(esc)
    expect(esc.prevented).toBe(true)
    els = render(lib())
    expect(played.at(-1)!.paused).toBe(true)
    expect(live(els)).toBe('Stopped')
    expect(inRow(els, 'upbeat-sweet-sun', 'music-play')!.props['aria-pressed']).toBe(false)
    // Play again, then its own button stops it.
    click(inRow(els, 'upbeat-sweet-sun', 'music-play'))
    els = render(lib())
    click(inRow(els, 'upbeat-sweet-sun', 'music-play'))
    els = render(lib())
    expect(played.at(-1)!.paused).toBe(true)
    // Space on the toggle plays and stops the preview (it does not reach the editor, where Space plays the video).
    const space = key(' ')
    ;(inRow(els, 'lofi-coexistenz', 'music-play')!.props.onKeyDown as (e: unknown) => void)(space)
    expect(space.prevented).toBe(true)
    els = render(lib())
    expect(played.at(-1)!.url).toBe('studio-media://sounds/bed-lofi-coexistenz.ogg')
    expect(live(els)).toBe('Playing preview: Coexistenz, 1 minute 32 seconds')
    ;(inRow(els, 'lofi-coexistenz', 'music-play')!.props.onKeyDown as (e: unknown) => void)(key(' '))
    els = render(lib())
    expect(played.at(-1)!.paused).toBe(true)
    // Other keys are left to the editor.
    const k = key('k')
    ;(inRow(els, 'lofi-coexistenz', 'music-play')!.props.onKeyDown as (e: unknown) => void)(k)
    expect(k.prevented).toBe(false)
  })

  it('Use is one update that keeps volume, ducking, loop and fades, and the credit shows', async () => {
    let els = await settle(lib())
    const use = inRow(els, 'lofi-coexistenz', 'music-use')!
    expect(use.props['aria-label']).toBe('Use Coexistenz')
    click(use)
    els = await after()
    expect(api.calls).toEqual([['useBed', 'p1', 'lofi-coexistenz']])
    expect(store.steps).toBe(1)
    expect(store.state.audio.music).toEqual({ path: 'music-2.ogg', volume: 0.6, ducking: 0.4, loop: false, fadeIn: 3, fadeOut: 4, library: { id: 'lofi-coexistenz' } })
    expect(player.reloadMusic).toHaveBeenCalledTimes(1)
    const inUse = inRow(els, 'lofi-coexistenz', 'music-use')!
    expect(textOf(inUse)).toBe('In use')
    // Still focusable: aria-disabled, never disabled.
    expect(inUse.props['aria-disabled']).toBe(true)
    expect(inUse.props.disabled).toBeUndefined()
    expect(live(els)).toBe('Music: Coexistenz by Loyalty Freak Music')
    const credit = render({ type: MusicCredit, props: { project: store.state } })
    expect(textOf(byTestId(credit, 'music-credit')!)).toBe('Music: Coexistenz by Loyalty Freak Music (CC0)')
    // Another bed replaces it, keeping the settings again.
    click(inRow(els, 'upbeat-sweet-sun', 'music-use'))
    await after()
    expect(store.state.audio.music).toMatchObject({ volume: 0.6, ducking: 0.4, loop: false, fadeIn: 3, fadeOut: 4, library: { id: 'upbeat-sweet-sun' } })
    expect(store.steps).toBe(2)
  })

  it('a row not downloaded: one Download and use button, a disabled Play with "Download to listen", then progress', async () => {
    api.states = withDownloads()
    let els = await settle(lib())
    expect(rows(els)).toHaveLength(12)
    const id = 'upbeat-go-to-the-picnic'
    expect(inRow(els, id, 'music-use')).toBeUndefined()
    const dl = inRow(els, id, 'music-download')!
    expect(textOf(dl)).toBe('Download and use (1.0 MB)')
    expect(dl.props['aria-label']).toBe('Download and use Go to the Picnic, 1.0 megabytes')
    const play = inRow(els, id, 'music-play')!
    expect(play.props['aria-disabled']).toBe(true)
    const hint = els.find((e) => e.props.id === play.props['aria-describedby'])!
    expect(textOf(hint)).toBe('Download to listen')
    click(play)
    expect(played).toHaveLength(0)
    // Progress arrives from main while it downloads.
    api.progress!({ id, state: 'downloading', bytes: soundBed(id)!.prepared.bytes, progress: 0.4 })
    els = render(lib())
    const bar = inRow(els, id, 'music-progress')!
    expect(bar.props.role).toBe('progressbar')
    expect(bar.props['aria-valuenow']).toBe(40)
    expect(bar.props['aria-valuetext']).toBe('40 percent')
    click(inRow(els, id, 'music-download'))
    await after()
    expect(api.calls).toEqual([])
    // Done: downloaded, then used, in one update.
    api.progress!({ id, state: 'downloaded', bytes: soundBed(id)!.prepared.bytes })
    els = render(lib())
    click(inRow(els, id, 'music-use'))
    await after()
    expect(store.state.audio.music?.library).toEqual({ id })
  })

  it('Download and use downloads, then uses; a failed download says why and changes nothing', async () => {
    api.states = withDownloads()
    let els = await settle(lib())
    api.failDownload = 'The download did not match the expected file, so it was deleted.'
    click(inRow(els, 'calm-old-key', 'music-download'))
    els = await after()
    expect(textOf(els.find((e) => e.props.role === 'alert')!)).toBe(api.failDownload)
    expect(store.steps).toBe(0)
    api.failDownload = null
    click(inRow(els, 'calm-old-key', 'music-download'))
    els = await after()
    expect(api.calls.slice(-2)).toEqual([
      ['download', 'calm-old-key'],
      ['useBed', 'p1', 'calm-old-key']
    ])
    expect(store.steps).toBe(1)
    expect(textOf(inRow(els, 'calm-old-key', 'music-use')!)).toBe('In use')
  })
})

describe('sound effects (test 73, §2.6)', () => {
  const fx = (): unknown => ({ type: SoundEffectsSection, props: { project: store.state } })
  it('rules are selects of None then the effects that fit first; each change is one step; Plays N times', async () => {
    store.state = { ...store.state, zooms: [0, 1, 2, 3].map((k) => ({ id: `z${k}`, start: 10 + k, end: 10.2 + k, scale: 2, focus: { mode: 'fixed' as const, x: 0.5, y: 0.5 }, auto: false, transition: 0.4 })) }
    let els = await settle(fx())
    expect(byTestId(els, 'sfx-section')).toBeDefined()
    const sel = byTestId(els, 'sfx-rule-zoomIn')!
    expect(sel.props.value).toBe('none')
    expect(byTestId(els, 'sfx-count-zoomIn')).toBeUndefined()
    expect(byTestId(els, 'sfx-play-zoomIn')!.props.disabled).toBe(true)
    click(byTestId(els, 'sfx-soft-whoosh'))
    expect(store.state.soundFx).toEqual({ zoomIn: 'sfx:whoosh-soft' })
    expect(store.steps).toBe(1)
    els = render({ type: SoundEffectsSection, props: { project: store.state } })
    expect(byTestId(els, 'sfx-rule-zoomIn')!.props.value).toBe('sfx:whoosh-soft')
    // Four zooms 1 s apart: two whooshes (§19.3 E14).
    expect(sfxCounts(store.state).zoomIn).toBe(2)
    expect(textOf(byTestId(els, 'sfx-count-zoomIn')!)).toBe('Plays 2 times')
    const play = byTestId(els, 'sfx-play-zoomIn')!
    expect(play.props['aria-label']).toBe('Play Soft whoosh')
    click(play)
    expect(played.at(-1)!.url).toBe('studio-media://sounds/sfx-whoosh-soft.ogg')
    expect(played.at(-1)!.volume).toBeCloseTo(0.35, 9)
    ;(byTestId(els, 'sfx-rule-titles')!.props.onChange as (e: unknown) => void)({ target: { value: 'sfx:bell' } })
    expect(store.state.soundFx).toEqual({ zoomIn: 'sfx:whoosh-soft', titles: 'sfx:bell' })
    ;(byTestId(els, 'sfx-rule-titles')!.props.onChange as (e: unknown) => void)({ target: { value: 'none' } })
    ;(byTestId(els, 'sfx-rule-zoomIn')!.props.onChange as (e: unknown) => void)({ target: { value: 'none' } })
    // Nothing set any more: the field is gone, as in a project from before.
    expect('soundFx' in store.state).toBe(false)
    expect(store.steps).toBe(4)
    // The Volume slider merges a drag into one step.
    const vol = byLabel(render({ type: SoundEffectsSection, props: { project: store.state } }), 'Volume')!
    ;(vol.props.onChange as (e: unknown) => void)({ target: { value: '0.5' } })
    ;(vol.props.onChange as (e: unknown) => void)({ target: { value: '0.6' } })
    expect(store.state.soundFx).toEqual({ volume: 0.6 })
    expect(store.steps).toBe(5)
    const titles = byTestId(els, 'sfx-rule-titles')!
    const groups = (titles.props.children as El[]).flat().filter((c) => c && (c as El).type === 'optgroup') as El[]
    expect(groups[0].props.label).toBe('Suggested')
  })
})

describe('Settings › Downloads › More music (§2.6)', () => {
  it('is hidden while there is nothing to download, and shows 8 tracks, 7.1 MB with a source', async () => {
    let els = await settle({ type: MusicDownloadsSection, props: {} })
    expect(byTestId(els, 'music-downloads')).toBeUndefined()
    unmountAll()
    api.states = withDownloads()
    els = await settle({ type: MusicDownloadsSection, props: {} })
    expect(textOf(byTestId(els, 'music-downloads')!)).toContain('8 tracks, 7.1 MB')
    expect(byTestId(els, 'music-downloads-remove')!.props.disabled).toBe(true)
    click(byTestId(els, 'music-download-all'))
    await settle({ type: MusicDownloadsSection, props: {} })
    expect(api.calls.map((c) => c[0])).toEqual(Array(8).fill('download'))
  })
})
