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
    expect(p.cursor).toEqual({ show: true, size: 2, smoothing: 0.9, clickEffect: false, hideWhenIdle: false })
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
      webcam: { show: true, corner: 'middle', shape: 'square' },
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
