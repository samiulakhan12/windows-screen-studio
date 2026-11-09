/**
 * The Short clips panel (docs/design/smart-tools.md §2.4; §22.1 tests 125, 126 and 127): the
 * moments listed, Captions and the vertical look of the copies made, the too-short and captions-
 * first notes, the space line, Made from this video, Play through playStretch (its end, a second
 * press, Esc), the copy menu's label and items, and the Publish and Export links that open the
 * panel. window.api and the preview player are fakes (clipsUi.ts); nothing leaves the test.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { projectCopy } from '../src/shared/editor/duplicate'
import type { Project } from '../src/shared/types'
import { clipProject, steadyTalk } from './clipFixtures'
import { bench, change, closes, CopyMenu, el, editing, fake, frame, mount, narrated, opened, player, press, reset, SHORT_NEEDS_CAPTIONS, ShortClipsPanel } from './clipsUi'
import { button, byLabel, byTestId, focused, render, settle, textOf, unmountAll } from './studioHarness'

beforeEach(reset)

describe('the panel (test 125)', () => {
  it('lists the moments; the copies made show captions and a vertical one gets Auto style’s look', async () => {
    const view = mount(narrated())
    const before = bench.store.state
    let out = await settle(view())
    expect(byTestId(out, 'clips-panel')!.props).toMatchObject({ role: 'region', 'aria-label': 'Short clips' })
    const rows = out.filter((e) => e.props['data-testid'] === 'clips-row')
    expect(rows.length).toBeGreaterThan(0)
    expect(textOf(byTestId(out, 'clips-intro'))).toBe('The best moments to post on their own. Each one you make becomes a copy; this video stays as it is.')
    // The first control has the focus.
    expect(focused.some((f) => f.props['data-testid'] === 'clips-focus')).toBe(true)
    expect(textOf(byTestId(out, 'clips-space'))).toBe("The copies share this video's files: they take almost no space.")
    expect(byTestId(out, 'clips-make')!.props.disabled).toBe(true)
    change(byLabel(out, 'Make clip 1'), true)
    out = await settle(view())
    expect(textOf(byTestId(out, 'clips-make'))).toBe('Make 1 copy')
    // Work still holding the project makes its edit first, as Duplicate's copies do.
    let finished = 0
    const finish = bench.store.finish
    bench.store.finish = () => {
      finished++
      expect(fake.copies).toHaveLength(0)
      finish()
    }
    press(byTestId(out, 'clips-make'))
    out = await settle(view())
    expect(fake.copies).toHaveLength(1)
    expect(finished).toBe(1)
    const copy = fake.copies[0].copy as unknown as Project
    expect(fake.copies[0].sourceId).toBe(before.id)
    expect(copy.captions!.show).toBe(true)
    expect(copy.style.aspectRatio).toBe('9:16')
    expect(copy.captions!.studio).toEqual(projectCopy(before, 'vertical', null).captions!.studio)
    expect(copy.clipOf).toMatchObject({ kind: 'moment' })
    expect(textOf(byTestId(out, 'clips-status'))).toBe('Made 1 copy. Your original “Billing tour” is unchanged.')
    // The row says Made, with Open.
    press(byLabel(out, 'Open clip 1'))
    expect(opened).toEqual(['made-1'])
    // The original never changed.
    expect(bench.store.state).toBe(before)
    expect(bench.store.canUndo).toBe(false)
  })

  it('Captions off: the copies hide them; Square and Same as this video are Duplicate’s shapes', async () => {
    const view = mount(narrated())
    let out = await settle(view())
    change(byTestId(out, 'clips-captions'), false)
    out = await settle(view())
    const square = out.find((e) => e.type === 'input' && e.props.type === 'radio' && e.props.value === 'square')
    change(square, true)
    out = await settle(view())
    change(byLabel(out, 'Make clip 1'), true)
    out = await settle(view())
    press(byTestId(out, 'clips-make'))
    await settle(view())
    const copy = fake.copies[0].copy as unknown as Project
    expect(copy.captions!.show).toBe(false)
    expect(copy.style.aspectRatio).toBe('1:1')
    // The choices are remembered.
    expect(fake.prefs.get('shortClips')).toMatchObject({ shape: 'square', captions: false })
  })

  it('a tall recording: Vertical is disabled with its reason and the copy keeps its shape', async () => {
    const tall = narrated({ width: 1080, height: 1920 })
    editing(tall)
    const out = await settle(el(ShortClipsPanel, tall, 1080, 1920))
    const vertical = out.find((e) => e.type === 'input' && e.props.value === 'vertical')!
    expect(vertical.props.disabled).toBe(true)
    expect(out.find((e) => e.type === 'input' && e.props.value === 'same')!.props.checked).toBe(true)
    expect(out.some((e) => textOf(e) === '(Your recording is already tall)')).toBe(true)
  })

  it('under 45 s: “Too short for clips: post the whole video.”', async () => {
    const view = mount(clipProject({ said: steadyTalk(8), duration: 44 }))
    const out = await settle(view())
    expect(textOf(byTestId(out, 'clips-too-short'))).toBe('Too short for clips: post the whole video.')
    expect(byTestId(out, 'clips-moments')).toBeUndefined()
  })

  it('speech heard without captions: Make captions first, or Use activity only', async () => {
    const window = 0.05
    const power = new Float32Array(Math.round(120 / window)).fill(1e-9)
    fake.levels = { mix: { window, power, speech: [{ start: 1, end: 40 }] } }
    const view = mount(clipProject({ duration: 120, id: 'speech-no-captions' }))
    let out = await settle(view())
    const note = byTestId(out, 'clips-needs-captions')!
    expect(textOf(note)).toContain('Make captions first: clips are picked from what you say.')
    press(button(out, 'Use activity only'))
    out = await settle(view())
    expect(byTestId(out, 'clips-needs-captions')).toBeUndefined()
    press(out.find((e) => e.type === 'button' && textOf(e) === 'Make captions'))
    expect(closes).toHaveLength(1)
    expect(fake.commands).toEqual(['generateCaptions'])
  })

  it('the space line under OneDrive, and the block when the copies would not fit', async () => {
    fake.cost = { linked: false, bytes: 1.2e9, free: 2.1e9 }
    const view = mount(narrated())
    let out = await settle(view())
    expect(textOf(byTestId(out, 'clips-space'))).toBe('Each copy takes 1.2 GB: files in a OneDrive folder cannot be shared.')
    change(byLabel(out, 'Make clip 1'), true)
    out = await settle(view())
    change(byLabel(out, 'Make clip 2'), true)
    out = await settle(view())
    expect(textOf(byTestId(out, 'clips-space'))).toBe('These 2 copies need 2.4 GB; 2.1 GB is free.')
    expect(byTestId(out, 'clips-make')!.props.disabled).toBe(true)
  })

  it('Made from this video lists copies of this project only, each with Open', async () => {
    const view = mount(narrated())
    fake.projects = [
      { id: 'a', name: 'Mine (clip)', copyOf: { id: 'clips', name: 'Billing tour' }, clip: true },
      { id: 'b', name: 'Other (clip)', copyOf: { id: 'someone-else', name: 'X' }, clip: true },
      { id: 'clips', name: 'Billing tour' }
    ]
    const out = await settle(view())
    const list = byTestId(out, 'clips-made-from')!
    expect(textOf(list)).toContain('Mine (clip)')
    expect(textOf(list)).not.toContain('Other (clip)')
    press(byLabel(out, 'Open Mine (clip)'))
    expect(opened).toEqual(['a'])
  })



})

describe('names with an AI (tests 102 and 125)', () => {
  const OPENAI = { id: 'o1', kind: 'openai', label: 'My OpenAI', model: 'gpt', maskedKey: '…', createdAt: '' }

  it('the names request carries a request id; LocalProgress follows it; Stop reaches cancelAiText and nothing is made', async () => {
    fake.providers = [OPENAI]
    fake.prefs.set('shortClips', { length: 'any', shape: 'vertical', names: 'o1', captions: true })
    let answer!: (v: unknown) => void
    fake.answer = () => new Promise((r) => (answer = r))
    const view = mount(narrated())
    const skip = ['LocalProgress']
    let out = await settle(view(), skip)
    expect(out.find((e) => e.type === 'select')!.props.value).toBe('o1')
    change(byLabel(out, 'Make clip 1'), true)
    out = await settle(view(), skip)
    press(byTestId(out, 'clips-make'))
    out = await settle(view(), skip)
    expect(fake.ai).toHaveLength(1)
    const { request, requestId } = fake.ai[0]
    expect(requestId).toMatch(/^short-clips-\d+$/)
    expect(request.requestId).toBe(requestId)
    expect((request.names as { kind: string }).kind).toBe('clip')
    const progress = out.find((e) => (e.type as { name?: string }).name === 'LocalProgress')!
    expect(progress.props.requestId).toBe(requestId)
    press(byTestId(out, 'clips-stop'))
    await settle(view(), skip)
    expect(fake.cancelled).toEqual([requestId])
    answer({ task: 'names', names: [{ id: '0', name: 'Too late' }] })
    out = await settle(view(), skip)
    expect(fake.copies).toHaveLength(0)
    expect(out.find((e) => (e.type as { name?: string }).name === 'LocalProgress')!.props.requestId).toBeNull()
  })

  it('Make reads its cost sentence when an AI names the copies (§11.5), and only then', async () => {
    fake.providers = [OPENAI]
    fake.prefs.set('shortClips', { length: 'any', shape: 'vertical', names: 'o1', captions: true })
    const out = await settle(mount(narrated())(), ['LocalProgress', 'CostLine'])
    const make = byTestId(out, 'clips-make')!
    const cost = out.find((e) => (e.type as { name?: string }).name === 'CostLine')!
    expect(String(make.props['aria-describedby'] ?? '').split(/\s+/)).toContain(`${cost.props.id}-names`)
    unmountAll()
    fake.prefs.set('shortClips', { length: 'any', shape: 'vertical', names: 'offline', captions: true })
    const offline = await settle(mount(narrated())(), ['LocalProgress', 'CostLine'])
    expect(String(byTestId(offline, 'clips-make')!.props['aria-describedby'] ?? '')).not.toMatch(/-cost-names/)
  })

  it('a name the AI gives becomes the copy’s; one holding a link keeps the title from what was said', async () => {
    fake.providers = [OPENAI]
    fake.prefs.set('shortClips', { length: 'any', shape: 'same', names: 'o1', captions: true })
    fake.answer = (request) => Promise.resolve({ task: 'names', names: (request.names as { items: { id: string }[] }).items.map((i) => ({ id: i.id, name: i.id === '0' ? 'Set up billing' : 'See example.com/pay' })) })
    const view = mount(narrated())
    let out = await settle(view())
    const offline = textOf(out.filter((e) => e.props.className === 'clips-title')[1])
    change(byLabel(out, 'Make clip 1'), true)
    out = await settle(view())
    change(byLabel(out, 'Make clip 2'), true)
    out = await settle(view())
    press(byTestId(out, 'clips-make'))
    await settle(view())
    expect(fake.copies.map((c) => c.copy.name)).toEqual(['Set up billing (clip)', `${offline} (clip)`])
  })
})

describe('Play (test 126)', () => {
  it('plays the moment’s range through playStretch and stops at its end', async () => {
    const view = mount(narrated())
    let out = await settle(view())
    const play = byLabel(out, 'Play clip 1')!
    expect(play.props['aria-pressed']).toBe(false)
    press(play)
    out = await settle(view())
    const range = textOf(out.find((e) => e.props.className === 'clips-time'))
    expect(range).toMatch(/ to /)
    expect(player.playing).toBe(true)
    const start = player.time
    expect(byLabel(out, 'Play clip 1')!.props['aria-pressed']).toBe(true)
    /** Playback moves on a quarter second a frame. */
    const advance = (seconds: number): void => {
      for (let k = 0; k < seconds * 4 && player.playing; k++) {
        player.time += 0.25
        frame()
      }
    }
    // Five seconds in: the row says so.
    advance(5)
    out = render(view())
    expect(textOf(byTestId(out, 'clips-playing'))).toMatch(/^Playing · 0:05 of 0:\d\d$/)
    // At its end the stretch pauses, inside the moment, and the row stops saying it plays.
    advance(120)
    expect(player.playing).toBe(false)
    expect(player.pauses).toBe(1)
    expect(player.time - start).toBeLessThanOrEqual(90.25)
    expect(player.time - start).toBeGreaterThanOrEqual(15)
    frame()
    out = render(view())
    expect(byTestId(out, 'clips-playing')).toBeUndefined()
    expect(byLabel(out, 'Play clip 1')!.props['aria-pressed']).toBe(false)
  })

  it('a second press stops it; Esc stops it before it closes the panel', async () => {
    const view = mount(narrated())
    let out = await settle(view())
    press(byLabel(out, 'Play clip 1'))
    out = await settle(view())
    press(byLabel(out, 'Play clip 1'))
    out = await settle(view())
    expect(player.playing).toBe(false)
    expect(byLabel(out, 'Play clip 1')!.props['aria-pressed']).toBe(false)
    press(byLabel(out, 'Play clip 2'))
    out = await settle(view())
    expect(player.playing).toBe(true)
    const esc = (): void => {
      const e = { key: 'Escape', defaultPrevented: false, preventDefault() {}, stopPropagation() {} }
      ;(byTestId(out, 'clips-panel')!.props.onKeyDown as (e: unknown) => void)(e)
    }
    esc()
    out = await settle(view())
    expect(player.playing).toBe(false)
    expect(closes).toHaveLength(0)
    esc()
    expect(closes).toHaveLength(1)
  })

  it('Esc stops it wherever the focus is (a click on Play leaves it on the page)', async () => {
    const view = mount(narrated())
    let out = await settle(view())
    expect(fake.keys).toHaveLength(0)
    press(byLabel(out, 'Play clip 1'))
    out = await settle(view())
    expect(fake.keys).toHaveLength(1)
    const e = { key: 'Escape', defaultPrevented: false, preventDefault() {
      e.defaultPrevented = true
    }, stopPropagation() {} }
    fake.keys[0](e)
    out = await settle(view())
    expect(player.playing).toBe(false)
    expect(e.defaultPrevented).toBe(true)
    expect(byLabel(out, 'Play clip 1')!.props['aria-pressed']).toBe(false)
    expect(closes).toHaveLength(0)
    // Not playing: the window's Esc is left alone.
    expect(fake.keys).toHaveLength(0)
  })
})

describe('entry points (test 127)', () => {
  it('the copy menu reads “Copies: vertical, square, short clips” and its items open the panel and the dialog', async () => {
    const calls: string[] = []
    const menu = (p: Project) => ({ type: CopyMenu, props: { project: p, vw: 1920, vh: 1080, run: () => undefined, onClips: () => calls.push('clips'), onShort: () => calls.push('short') } })
    let out = render(menu(narrated()))
    const toggle = byTestId(out, 'copy-menu')!
    expect(toggle.props).toMatchObject({ title: 'Copies: vertical, square, short clips', 'aria-label': 'Copies: vertical, square, short clips' })
    press(toggle)
    out = render(menu(narrated()))
    const items = out.filter((e) => e.props.role === 'menuitem')
    expect(items.map((e) => textOf(e))).toEqual([
      'Make a vertical versionA 9:16 copy that follows your cursor, for TikTok, Reels and Shorts',
      'Make a square versionA 1:1 copy that follows your cursor',
      'Find short clips…The best 15 to 90 second moments, each as a copy',
      'Make a shorter version…30, 60 or 90 seconds, the most useful sentences in order',
      'DuplicateA copy you can edit separately'
    ])
    press(items[2])
    press(items[3])
    expect(calls).toEqual(['clips', 'short'])
    // Without captions the shorter version says why, and stays focusable.
    unmountAll()
    out = render(menu(clipProject({ duration: 100 })))
    press(byTestId(out, 'copy-menu'))
    out = render(menu(clipProject({ duration: 100 })))
    const short = out.find((e) => e.props['data-testid'] === 'copy-short')!
    expect(short.props['aria-disabled']).toBe(true)
    expect(textOf(short)).toContain(SHORT_NEEDS_CAPTIONS)
  })

  it('the Publish dialog and the Export dialog’s done view open the Short clips panel', () => {
    const src = (file: string): string => readFileSync(path.join(__dirname, '../src/renderer/src', file), 'utf8')
    const publish = src('publish/PublishDialog.tsx')
    expect(publish).toMatch(/data-testid="publish-short-clips" onClick=\{onShortClips\}>\s*Make short clips for Shorts and Reels…/)
    const exporter = src('editor/ExportDialog.tsx')
    expect(exporter).toMatch(/data-testid="export-short-clips" onClick=\{props\.onShortClips\}>\s*Make short clips for Shorts and Reels…/)
    // The done view holds it (after "Export finished").
    expect(exporter.indexOf('export-short-clips')).toBeGreaterThan(exporter.indexOf('Export finished'))
    const editor = src('views/Editor.tsx')
    expect(editor).toMatch(/onShortClips=\{\(\) => \{\s*setPublishRequest\(null\)\s*setDialog\(null\)\s*openClips\(\)/)
    expect(editor).toMatch(/onShortClips=\{\(\) => \{\s*setExporting\(false\)\s*openClips\(\)/)
    expect(editor).toMatch(/const openClips = useCallback\(\(\): void => \{\s*setReviewOpen\(false\)\s*setSmartPanel\(\{ kind: 'clips' \}\)/)
    expect(editor).toMatch(/smartPanel\?\.kind === 'clips' && \(\s*<ShortClipsPanel/)
  })
})
