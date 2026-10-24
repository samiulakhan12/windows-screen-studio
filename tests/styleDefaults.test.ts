import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadStyleDefaults, saveStyleDefaults } from '../src/main/styleDefaults'
import { applyStyleDefaults, lookOf, sanitizeStyleDefaults, type StyleDefaults } from '../src/shared/editor/styleDefaults'
import { createProject } from '../src/shared/engine/project'
import type { CaptureInfo, Project } from '../src/shared/types'

const dir = mkdtempSync(path.join(tmpdir(), 'ssw-style-defaults-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const NATIVE: CaptureInfo = { method: 'native', cursorInVideo: false, region: null }
const CHROMIUM: CaptureInfo = { method: 'chromium', cursorInVideo: true, region: null }

const newProject = (opts: { capture?: CaptureInfo; hasWebcam?: boolean; cursorValid?: boolean } = {}): Project =>
  createProject({
    id: 'rec-1',
    name: 'Test',
    duration: 10,
    width: 1920,
    height: 1080,
    hasWebcam: opts.hasWebcam ?? false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: opts.cursorValid ?? true,
    capture: opts.capture ?? NATIVE
  })

/** A look a user might save: dark solid background, no padding, rounded camera, top shortcuts. */
const saved: StyleDefaults = {
  style: { background: { type: 'color', color: '#111111' }, padding: 0, cornerRadius: 24, shadow: 0.2, aspectRatio: '16:9' },
  cursor: { show: true, size: 2, smoothing: 0.9, clickEffect: false, hideWhenIdle: false },
  webcam: { show: true, corner: 'top-left', size: 0.3, shape: 'rounded' },
  effects: { motionBlur: 0, keystrokes: { show: false, position: 'top', size: 0.05 } }
}

describe('applyStyleDefaults', () => {
  it('returns the project unchanged without saved defaults', () => {
    const p = newProject()
    expect(applyStyleDefaults(p, null)).toBe(p)
    expect(applyStyleDefaults(p, undefined)).toBe(p)
  })

  it('applies style, cursor, camera and effect settings', () => {
    const p = applyStyleDefaults(newProject({ hasWebcam: true }), saved)
    expect(p.style).toEqual(saved.style)
    expect(p.cursor).toMatchObject({ show: true, size: 2, smoothing: 0.9, clickEffect: false, hideWhenIdle: false })
    expect(p.webcam).toEqual({ show: true, corner: 'top-left', size: 0.3, shape: 'rounded' })
    expect(p.effects).toEqual({ motionBlur: 0, keystrokes: { show: false, position: 'top', size: 0.05 } })
  })

  it('leaves everything else of the project alone', () => {
    const before = newProject()
    const p = applyStyleDefaults(before, saved)
    const { style: _s, cursor: _c, webcam: _w, effects: _e, ...rest } = p
    const { style: _s2, cursor: _c2, webcam: _w2, effects: _e2, ...restBefore } = before
    expect(rest).toEqual(restBefore)
    // The input is not mutated.
    expect(before.style.padding).toBe(0.07)
  })

  it('never turns the smooth cursor on when the OS cursor is in the video', () => {
    const p = applyStyleDefaults(newProject({ capture: CHROMIUM }), saved)
    expect(p.cursor.show).toBe(false)
    // Even for a project that (wrongly) has it on.
    const odd = { ...newProject({ capture: CHROMIUM }), cursor: { ...newProject().cursor, show: true } }
    expect(applyStyleDefaults(odd, saved).cursor.show).toBe(false)
    // The other cursor settings still apply (they are used when the user records natively).
    expect(p.cursor.size).toBe(2)
  })

  it('keeps the cursor visibility the recording decided', () => {
    // Saved from a screen-capture project, where the smooth cursor is necessarily off.
    const fromChromium = { ...saved, cursor: { ...saved.cursor, show: false } }
    expect(applyStyleDefaults(newProject(), fromChromium).cursor.show).toBe(true)
    // No cursor data (window recording): stays off.
    expect(applyStyleDefaults(newProject({ cursorValid: false }), saved).cursor.show).toBe(false)
  })

  it('shows the camera exactly when the recording has one', () => {
    expect(applyStyleDefaults(newProject({ hasWebcam: false }), saved).webcam.show).toBe(false)
    const hidden = { ...saved, webcam: { ...saved.webcam, show: false } }
    expect(applyStyleDefaults(newProject({ hasWebcam: true }), hidden).webcam.show).toBe(true)
  })

  it('keeps the default gradient instead of an image background', () => {
    const withImage: StyleDefaults = { ...saved, style: { ...saved.style, background: { type: 'image', path: 'background.png' } } }
    const p = applyStyleDefaults(newProject(), withImage)
    expect(p.style.background).toEqual({ type: 'gradient', preset: 'aurora' })
    expect(p.style.padding).toBe(0)
  })

  it('applies a gradient preset', () => {
    const p = applyStyleDefaults(newProject(), { ...saved, style: { background: { type: 'gradient', preset: 'midnight' } } })
    expect(p.style.background).toEqual({ type: 'gradient', preset: 'midnight' })
    expect(p.style.padding).toBe(0.07)
  })

  it('round-trips a project look', () => {
    const edited = applyStyleDefaults(newProject({ hasWebcam: true }), saved)
    const again = applyStyleDefaults(newProject({ hasWebcam: true }), lookOf(edited))
    expect(lookOf(again)).toEqual(lookOf(edited))
  })
})

describe('sanitizeStyleDefaults', () => {
  it('rejects values that are not a look', () => {
    for (const raw of [null, undefined, 42, 'x', [], {}, { style: 3 }, { style: { padding: 'a' } }]) expect(sanitizeStyleDefaults(raw)).toBeNull()
  })

  it('clamps numbers to the editor ranges', () => {
    const d = sanitizeStyleDefaults({
      style: { padding: 5, cornerRadius: -3, shadow: 2 },
      cursor: { size: 100, smoothing: -1 },
      webcam: { size: 0 },
      effects: { motionBlur: 9, keystrokes: { size: 1 } }
    })
    expect(d).toEqual({
      style: { padding: 0.25, cornerRadius: 0, shadow: 1 },
      cursor: { size: 3, smoothing: 0 },
      webcam: { size: 0.12 },
      effects: { motionBlur: 1, keystrokes: { size: 0.07 } }
    })
  })

  it('drops invalid fields and keeps the valid ones', () => {
    const d = sanitizeStyleDefaults({
      style: { background: { type: 'gradient', preset: 'nope' }, padding: NaN, cornerRadius: 10, aspectRatio: '2:1' },
      cursor: { show: true, clickEffect: 'yes', hideWhenIdle: false },
      webcam: { show: true, corner: 'middle', shape: 'hexagon' },
      effects: { motionBlur: null, keystrokes: { position: 'left', show: true } }
    })
    expect(d).toEqual({
      style: { cornerRadius: 10 },
      cursor: { hideWhenIdle: false },
      webcam: {},
      effects: { keystrokes: { show: true } }
    })
  })

  it('accepts only #rrggbb colours and never keeps image backgrounds', () => {
    expect(sanitizeStyleDefaults({ style: { background: { type: 'color', color: '#ABCDEF' } } })?.style.background).toEqual({ type: 'color', color: '#abcdef' })
    expect(sanitizeStyleDefaults({ style: { background: { type: 'color', color: 'url(x)' } } })).toBeNull()
    expect(sanitizeStyleDefaults({ style: { background: { type: 'image', path: 'background.png' } } })).toBeNull()
  })

  it('a partial file only changes what it contains', () => {
    const p = applyStyleDefaults(newProject(), sanitizeStyleDefaults({ webcam: { shape: 'rounded' } }))
    const built = newProject()
    expect(p.webcam.shape).toBe('rounded')
    expect(p.style).toEqual(built.style)
    expect(p.cursor).toEqual(built.cursor)
    expect(p.effects).toEqual(built.effects)
  })
})

describe('cursor look in saved defaults', () => {
  const look = {
    style: 'mac',
    highlight: { enabled: true, color: '#22C55E', size: 1.5, opacity: 0.5 },
    clickStyle: 'ring',
    clickColor: '#F472B6',
    clickSound: true,
    clickSoundVolume: 0.4,
    loopHome: true,
    tilt: true,
    trail: true
  }

  it('saves and applies style, highlight, click style/colour/sound, loop, tilt and trail', () => {
    const d = sanitizeStyleDefaults({ cursor: look })
    expect(d?.cursor).toEqual({ ...look, highlight: { ...look.highlight, color: '#22c55e' }, clickColor: '#f472b6' })
    const p = applyStyleDefaults(newProject(), d)
    expect(p.cursor).toMatchObject({ style: 'mac', clickStyle: 'ring', clickSound: true, clickSoundVolume: 0.4, loopHome: true, tilt: true, trail: true })
    expect(p.cursor.highlight).toEqual({ enabled: true, color: '#22c55e', size: 1.5, opacity: 0.5 })
  })

  it('never saves a custom cursor image (it belongs to one project)', () => {
    const d = sanitizeStyleDefaults({ cursor: { style: 'custom', customImage: 'cursor.png', size: 2 } })
    expect(d?.cursor).toEqual({ size: 2 })
    const edited = { ...newProject(), cursor: { ...newProject().cursor, style: 'custom' as const, customImage: 'cursor.png' } }
    const again = applyStyleDefaults(newProject(), lookOf(edited))
    expect(again.cursor.style).toBe('auto')
    expect(again.cursor.customImage).toBeUndefined()
  })

  it('clamps and validates the new fields', () => {
    const d = sanitizeStyleDefaults({
      cursor: { style: 'neon', clickStyle: 'boom', clickColor: 'red', clickSoundVolume: 7, highlight: { enabled: 'yes', size: 9, opacity: 0, color: 'x' }, tilt: 1 }
    })
    expect(d?.cursor).toEqual({ clickSoundVolume: 1, highlight: { enabled: false, color: '#facc15', size: 2.5, opacity: 0.1 } })
  })

  it('a partial highlight takes the built-in values for the rest', () => {
    const d = sanitizeStyleDefaults({ cursor: { highlight: { enabled: true } } })
    expect(d?.cursor.highlight).toEqual({ enabled: true, color: '#facc15', size: 1, opacity: 0.35 })
    expect(sanitizeStyleDefaults({ cursor: { highlight: { nothing: 1 } } })).toBeNull()
  })
})

describe('loadStyleDefaults / saveStyleDefaults', () => {
  const file = path.join(dir, 'nested', 'style-defaults.json')

  it('returns null when nothing is saved', async () => {
    expect(await loadStyleDefaults(file)).toBeNull()
  })

  it('saves a project look and loads it back', async () => {
    const look = lookOf(applyStyleDefaults(newProject(), saved))
    const stored = await saveStyleDefaults(look, file)
    // Visibility is the recording's business; it is not stored.
    expect(stored?.cursor).not.toHaveProperty('show')
    expect(stored?.webcam).not.toHaveProperty('show')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, style: saved.style })
    expect(existsSync(`${file}.tmp`)).toBe(false)
    const loaded = await loadStyleDefaults(file)
    expect(loaded).toEqual(stored)
    expect(lookOf(applyStyleDefaults(newProject({ hasWebcam: true }), loaded))).toEqual(lookOf(applyStyleDefaults(newProject({ hasWebcam: true }), saved)))
  })

  it('does not store an image background', async () => {
    const stored = await saveStyleDefaults({ ...saved, style: { ...saved.style, background: { type: 'image', path: 'background.png' } } }, file)
    expect(stored?.style).not.toHaveProperty('background')
    expect(JSON.parse(readFileSync(file, 'utf8')).style).not.toHaveProperty('background')
  })

  it('refuses a look with nothing valid and keeps the saved one', async () => {
    await saveStyleDefaults(saved, file)
    await expect(saveStyleDefaults({ style: {}, cursor: {}, webcam: {}, effects: {} }, file)).rejects.toThrow(/cannot be saved/)
    expect(await loadStyleDefaults(file)).not.toBeNull()
  })

  it('treats a malformed or unreadable file as no defaults', async () => {
    writeFileSync(file, '{ "style": { "padding": 0.1 ')
    expect(await loadStyleDefaults(file)).toBeNull()
    writeFileSync(file, '"just a string"')
    expect(await loadStyleDefaults(file)).toBeNull()
    writeFileSync(file, JSON.stringify({ version: 1, style: { padding: 0.1, shadow: 'dark' } }))
    expect(await loadStyleDefaults(file)).toEqual({ style: { padding: 0.1 }, cursor: {}, webcam: {}, effects: {} })
    // A directory where the file should be.
    expect(await loadStyleDefaults(dir)).toBeNull()
    // Even without Electron's app (no userData path) a recording is never blocked.
    await expect(loadStyleDefaults()).resolves.toBeNull()
  })

  it('reset removes the saved defaults (and is fine when there are none)', async () => {
    await saveStyleDefaults(saved, file)
    expect(await saveStyleDefaults(null, file)).toBeNull()
    expect(existsSync(file)).toBe(false)
    expect(await loadStyleDefaults(file)).toBeNull()
    await expect(saveStyleDefaults(null, file)).resolves.toBeNull()
  })
})

describe('style pack fields in saved defaults', () => {
  it('saves and applies frames, borders, shadow styles, wallpapers, animated backgrounds and the zoom style', () => {
    const d = sanitizeStyleDefaults({
      style: {
        background: { type: 'wallpaper', id: 'dunes', blur: 0.4 },
        frame: { kind: 'laptop', theme: 'dark' },
        border: { width: 6, color: '#ABCDEF', glass: true },
        shadowStyle: 'hard',
        shadowColor: '#112233'
      },
      zoom: { defaultScale: 1.5, easing: 'snappy', transition: 0.4 }
    })
    expect(d?.style).toEqual({
      background: { type: 'wallpaper', id: 'dunes', blur: 0.4 },
      frame: { kind: 'laptop', theme: 'dark' },
      border: { width: 6, color: '#abcdef', glass: true },
      shadowStyle: 'hard',
      shadowColor: '#112233'
    })
    const p = applyStyleDefaults(newProject(), d)
    expect(p.style.frame).toEqual({ kind: 'laptop', theme: 'dark' })
    expect(p.zoomSettings).toMatchObject({ defaultScale: 1.5, easing: 'snappy', transition: 0.4 })
    // Auto zoom settings are not part of the zoom style.
    expect(p.zoomSettings?.auto).toEqual(newProject().zoomSettings?.auto)
    expect(sanitizeStyleDefaults({ style: { background: { type: 'animated', preset: 'ocean', speed: 7 } } })?.style.background).toEqual({ type: 'animated', preset: 'ocean', speed: 2 })
  })

  it('drops unknown presets, kinds and malformed values field by field', () => {
    const d = sanitizeStyleDefaults({
      style: {
        background: { type: 'wallpaper', id: 'nope' },
        frame: { kind: 'tv', theme: 'dark' },
        border: { width: 'thick' },
        shadowStyle: 'neon',
        shadowColor: 'pink',
        padding: 0.1
      },
      zoom: { defaultScale: 99, easing: 'wobbly', transition: -1 }
    })
    expect(d?.style).toEqual({ padding: 0.1 })
    expect(d?.zoom).toEqual({ defaultScale: 5, transition: 0.15 })
    expect(sanitizeStyleDefaults({ style: { background: { type: 'animated', preset: 'nope' } } })).toBeNull()
    expect(sanitizeStyleDefaults({ style: { border: { width: 999, color: 'x' } } })?.style.border).toEqual({ width: 24, color: '#ffffff', glass: false })
    expect(sanitizeStyleDefaults({ style: { frame: { kind: 'browser', theme: 'x', title: 'y'.repeat(500) } } })?.style.frame).toEqual({ kind: 'browser', theme: 'light', title: 'y'.repeat(120) })
  })

  it('keeps a valid watermark (an image one needs a watermark file name)', () => {
    const text = { show: true, kind: 'text', text: 'ACME', position: 'top-right', size: 0.05, opacity: 0.7, margin: 0.03 }
    expect(sanitizeStyleDefaults({ watermark: text })?.watermark).toEqual(text)
    expect(sanitizeStyleDefaults({ watermark: { ...text, kind: 'image', path: 'watermark.png' } })?.watermark?.path).toBe('watermark.png')
    expect(sanitizeStyleDefaults({ watermark: { ...text, kind: 'image', path: '../../etc/passwd' } })).toBeNull()
    expect(sanitizeStyleDefaults({ watermark: { ...text, kind: 'image' } })).toBeNull()
    expect(sanitizeStyleDefaults({ watermark: { ...text, position: 'middle' } })).toBeNull()
    expect(sanitizeStyleDefaults({ watermark: { ...text, size: 9, opacity: 0, text: 'x'.repeat(300) } })?.watermark).toMatchObject({ size: 0.4, opacity: 0.1, text: 'x'.repeat(80) })
    const p = applyStyleDefaults(newProject(), { style: {}, cursor: {}, webcam: {}, effects: {}, watermark: text as never })
    expect(p.watermark).toEqual(text)
    // Only a logo keeps its file name: a text watermark's leftover one belongs to another project's folder.
    expect(sanitizeStyleDefaults({ watermark: { ...text, path: 'watermark-2.png' } })?.watermark).toEqual(text)
  })

  it('lookOf carries the zoom style, the watermark and where they came from', () => {
    const p = { ...newProject(), watermark: { show: true, kind: 'text' as const, text: 'Hi', position: 'center' as const, size: 0.05, opacity: 1, margin: 0 } }
    const look = lookOf(p)
    expect(look.zoom).toEqual({ defaultScale: 2, easing: 'smooth', transition: 0.7 })
    expect(look.watermark).toBe(p.watermark)
    expect(look.source).toBe('rec-1')
  })
})
