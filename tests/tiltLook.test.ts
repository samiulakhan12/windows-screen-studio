import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadStyleDefaults, saveStyleDefaults } from '../src/main/styleDefaults'
import { applyStyleDefaults, lookOf, sanitizeStyleDefaults, sanitizeTiltLook } from '../src/shared/editor/styleDefaults'
import { applyPreset, BUILT_IN_PRESETS, parseUserPresets, presetLookOf, presetMatches, sanitizePresetLook } from '../src/shared/editor/stylePresets'
import { createProject, migrateProject } from '../src/shared/engine/project'
import { DEFAULT_TILT, tiltOf } from '../src/shared/engine/tilt'
import type { Project, TiltSettings } from '../src/shared/types'

const dir = mkdtempSync(path.join(tmpdir(), 'ssw-tilt-look-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const newProject = (): Project =>
  createProject({
    id: 'rec-tilt',
    name: 'Tilt',
    duration: 10,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })

const HERO: TiltSettings = { enabled: true, rotateX: 16, rotateY: -14, perspective: 0.7, animate: 'cursor' }

describe('migrateProject: tilt', () => {
  it('opens older projects without a tilt (nothing added)', () => {
    const { tilt: _none, ...old } = newProject()
    void _none
    const p = migrateProject(JSON.parse(JSON.stringify(old)))
    expect(p.tilt).toBeUndefined()
    expect(tiltOf(p)).toBeNull()
    expect(JSON.parse(JSON.stringify(p))).not.toHaveProperty('tilt')
  })

  it('keeps a valid tilt and repairs a hand-edited one', () => {
    expect(migrateProject({ ...newProject(), tilt: HERO }).tilt).toEqual(HERO)
    expect(migrateProject({ ...newProject(), tilt: { enabled: true, rotateX: 999, rotateY: 'left', perspective: -2, animate: 'wobble' } }).tilt).toEqual({
      enabled: true,
      rotateX: 30,
      rotateY: DEFAULT_TILT.rotateY,
      perspective: 0,
      animate: 'none'
    })
    for (const bad of [null, 42, 'on', [HERO]]) expect(migrateProject({ ...newProject(), tilt: bad }).tilt).toBeUndefined()
  })
})

describe('saved default look: tilt', () => {
  it('saves the project tilt and applies it to new recordings', () => {
    const look = lookOf({ ...newProject(), tilt: HERO })
    expect(look.tilt).toEqual(HERO)
    const applied = applyStyleDefaults(newProject(), look)
    expect(applied.tilt).toEqual(HERO)
  })

  it('leaves new recordings flat when the look has no tilt', () => {
    const look = lookOf(newProject())
    expect(look.tilt).toBeUndefined()
    expect(applyStyleDefaults(newProject(), look).tilt).toBeUndefined()
  })

  it('validates the tilt field by field (a partly broken one still applies what is valid)', () => {
    expect(sanitizeTiltLook({ enabled: true, rotateX: 50, rotateY: 'x', perspective: 0.3, animate: 'spin' })).toEqual({ enabled: true, rotateX: 30, perspective: 0.3 })
    expect(sanitizeTiltLook('tilt')).toEqual({})
    const d = sanitizeStyleDefaults({ tilt: { enabled: true, rotateY: 12 } })
    expect(d).toEqual({ style: {}, cursor: {}, webcam: {}, effects: {}, tilt: { enabled: true, rotateY: 12 } })
    // Merged over the defaults: a tilt with only some fields still draws.
    expect(applyStyleDefaults(newProject(), d).tilt).toEqual({ ...DEFAULT_TILT, enabled: true, rotateY: 12 })
    // Junk alone is not a look.
    expect(sanitizeStyleDefaults({ tilt: { rotateX: 'a' } })).toBeNull()
  })

  it('round-trips through the saved file', async () => {
    const file = path.join(dir, 'style-defaults.json')
    const stored = await saveStyleDefaults({ ...lookOf({ ...newProject(), tilt: HERO }) }, file)
    expect(stored?.tilt).toEqual(HERO)
    expect(JSON.parse(readFileSync(file, 'utf8')).tilt).toEqual(HERO)
    expect((await loadStyleDefaults(file))?.tilt).toEqual(HERO)
    // A hand-edited file is clamped on load.
    writeFileSync(file, JSON.stringify({ version: 1, tilt: { enabled: true, rotateX: -90, perspective: 3 } }))
    expect((await loadStyleDefaults(file))?.tilt).toEqual({ enabled: true, rotateX: -30, perspective: 1 })
  })
})

describe('style presets: tilt', () => {
  it('some built-in presets tilt the card, the others switch the tilt off', () => {
    const tilted = BUILT_IN_PRESETS.filter((p) => p.look.tilt?.enabled)
    expect(tilted.map((p) => p.id)).toEqual(['midnight-browser', 'showcase'])
    for (const p of BUILT_IN_PRESETS) expect(p.look.tilt).toBeDefined()
    // Complete tilts that survive validation unchanged.
    for (const p of tilted) {
      expect(Object.keys(p.look.tilt!).sort()).toEqual(['animate', 'enabled', 'perspective', 'rotateX', 'rotateY'])
      expect(sanitizePresetLook(p.look)?.tilt).toEqual(p.look.tilt)
    }
  })

  it('applies a tilted preset, and a flat one switches it off but keeps the angles', () => {
    for (const preset of BUILT_IN_PRESETS.filter((p) => p.look.tilt?.enabled)) {
      const tilted = applyPreset({ ...newProject(), tilt: { ...HERO, enabled: false } }, preset.look)
      expect(tiltOf(tilted), preset.id).toEqual(preset.look.tilt)
      expect(presetMatches(tilted, preset.look), preset.id).toBe(true)
    }
    const studio = BUILT_IN_PRESETS.find((p) => p.id === 'studio')!
    const flat = applyPreset({ ...newProject(), tilt: HERO }, studio.look)
    expect(flat.tilt).toEqual({ ...HERO, enabled: false })
    expect(tiltOf(flat)).toBeNull()
  })

  it('captures the project tilt in a preset of your own and brings it back', () => {
    const source = { ...newProject(), tilt: HERO }
    const look = presetLookOf(source)
    expect(look.tilt).toEqual(HERO)
    const other = applyPreset({ ...newProject(), tilt: { ...HERO, rotateX: -5, animate: 'none' } }, look)
    expect(other.tilt).toEqual(HERO)
    expect(presetMatches(source, look)).toBe(true)
    // A flat project's preset only says "off".
    expect(presetLookOf(newProject()).tilt).toEqual({ enabled: false })
  })

  it('tells tilted and flat looks apart, but not the angles of a tilt that is off', () => {
    const look = presetLookOf({ ...newProject(), tilt: HERO })
    expect(presetMatches({ ...newProject(), tilt: { ...HERO, rotateY: 10 } }, look)).toBe(false)
    expect(presetMatches(newProject(), look)).toBe(false)
    const flatLook = presetLookOf(newProject())
    expect(presetMatches({ ...newProject(), tilt: { ...HERO, enabled: false } }, flatLook)).toBe(true)
  })

  it('reads presets saved before tilts existed, which leave the tilt alone', () => {
    const [p] = parseUserPresets([{ id: 'old', name: 'Old look', look: { style: { padding: 0.1 }, cursor: {}, zoom: {} } }])
    expect(p.look.tilt).toBeUndefined()
    expect(applyPreset({ ...newProject(), tilt: HERO }, p.look).tilt).toEqual(HERO)
    // A preset of only a tilt is a look too; a broken tilt is dropped field by field.
    expect(sanitizePresetLook({ tilt: { enabled: true, rotateX: 45, animate: 1 } })).toEqual({ style: {}, cursor: {}, zoom: {}, tilt: { enabled: true, rotateX: 30 } })
  })
})
