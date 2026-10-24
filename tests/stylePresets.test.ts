import { describe, expect, it } from 'vitest'
import {
  addUserPreset,
  applyPreset,
  BUILT_IN_PRESETS,
  deleteUserPreset,
  MAX_USER_PRESETS,
  parseUserPresets,
  presetLookOf,
  presetMatches,
  presetName,
  renameUserPreset,
  sanitizePresetLook,
  type StylePreset
} from '../src/shared/editor/stylePresets'
import { isKnownBackground } from '../src/shared/engine/backgrounds'
import { createProject } from '../src/shared/engine/project'
import { zoomSettingsOf } from '../src/shared/engine/zoom'
import type { Project } from '../src/shared/types'

const newProject = (): Project =>
  createProject({
    id: 'p1',
    name: 'Demo',
    duration: 10,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [{ id: 'z', start: 1, end: 3, scale: 2, focus: { mode: 'cursor' }, auto: true, easing: 'linear' }],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })

describe('built-in presets', () => {
  it('has at least 6 complete presets with unique ids and names', () => {
    expect(BUILT_IN_PRESETS.length).toBeGreaterThanOrEqual(6)
    expect(new Set(BUILT_IN_PRESETS.map((p) => p.id)).size).toBe(BUILT_IN_PRESETS.length)
    expect(new Set(BUILT_IN_PRESETS.map((p) => p.name)).size).toBe(BUILT_IN_PRESETS.length)
    for (const p of BUILT_IN_PRESETS) {
      const s = p.look.style
      for (const k of ['background', 'padding', 'cornerRadius', 'shadow', 'shadowStyle', 'border', 'frame'] as const) expect(s[k], `${p.id}.${k}`).toBeDefined()
      expect(isKnownBackground(s.background!)).toBe(true)
      expect(p.look.zoom).toMatchObject({ defaultScale: expect.any(Number), easing: expect.any(String), transition: expect.any(Number) })
      expect(p.look.cursor.size).toBeDefined()
      // They survive validation unchanged (nothing out of range).
      expect(sanitizePresetLook(p.look)).toEqual(p.look)
    }
  })

  it('looks different from each other', () => {
    const looks = BUILT_IN_PRESETS.map((p) => JSON.stringify(p.look.style))
    expect(new Set(looks).size).toBe(looks.length)
  })
})

describe('applyPreset', () => {
  it('sets background, card, frame, cursor look and zoom style in one new project value', () => {
    const before = newProject()
    const pop = BUILT_IN_PRESETS.find((p) => p.id === 'pop')!
    const after = applyPreset(before, pop.look)
    expect(after).not.toBe(before)
    expect(after.style).toMatchObject({ background: { type: 'color', color: '#fde68a' }, shadowStyle: 'hard', border: { width: 3, color: '#111827', glass: false }, frame: { kind: 'none' } })
    expect(after.cursor.style).toBe('black')
    expect(zoomSettingsOf(after)).toMatchObject({ defaultScale: 1.75, easing: 'snappy', transition: 0.5 })
    // Kept: aspect ratio, cursor visibility, auto zoom settings, the zooms themselves.
    expect(after.style.aspectRatio).toBe(before.style.aspectRatio)
    expect(after.cursor.show).toBe(before.cursor.show)
    expect(zoomSettingsOf(after).auto).toEqual(zoomSettingsOf(before).auto)
    expect(after.zooms).toBe(before.zooms)
    // The input is not mutated.
    expect(before.style.shadowStyle).toBeUndefined()
  })

  it('switching presets removes the previous frame and border', () => {
    const p = applyPreset(newProject(), BUILT_IN_PRESETS.find((x) => x.id === 'showcase')!.look)
    expect(p.style.frame?.kind).toBe('laptop')
    const q = applyPreset(p, BUILT_IN_PRESETS.find((x) => x.id === 'studio')!.look)
    expect(q.style.frame?.kind).toBe('none')
    expect(q.style.border?.width).toBe(0)
  })

  it('ignores an unusable look', () => {
    const p = newProject()
    expect(applyPreset(p, { style: {}, cursor: {}, zoom: {} })).toBe(p)
    expect(applyPreset(p, null as never)).toBe(p)
  })
})

describe('presetMatches', () => {
  it('recognises the applied preset, and no other', () => {
    for (const preset of BUILT_IN_PRESETS) {
      const p = applyPreset(newProject(), preset.look)
      expect(presetMatches(p, preset.look)).toBe(true)
      const others = BUILT_IN_PRESETS.filter((x) => x.id !== preset.id && presetMatches(p, x.look))
      expect(others.map((x) => x.id)).toEqual([])
    }
  })

  it('treats absent fields as what they render as', () => {
    const p = newProject()
    const look = presetLookOf(p)
    expect(presetMatches(p, look)).toBe(true)
    // An explicit "no frame / no border / soft" preset matches a project that never set them.
    expect(presetMatches(p, { ...look, style: { ...look.style, frame: { kind: 'none', theme: 'light' }, border: { width: 0, color: '#ffffff', glass: false }, shadowStyle: 'soft' } })).toBe(true)
    expect(presetMatches(p, { ...look, style: { ...look.style, padding: 0.2 } })).toBe(false)
  })
})

describe('presetLookOf', () => {
  it('captures the look, without image backgrounds or custom cursor images', () => {
    const p = newProject()
    p.style = { ...p.style, background: { type: 'image', path: 'background.png' }, frame: { kind: 'phone', theme: 'dark' }, shadowStyle: 'glow', shadowColor: '#FF00FF' }
    p.cursor = { ...p.cursor, style: 'custom', customImage: 'cursor.png', size: 2 }
    const look = presetLookOf(p)
    expect(look.style.background).toBeUndefined()
    expect(look.style.frame).toEqual({ kind: 'phone', theme: 'dark' })
    expect(look.style.shadowColor).toBe('#ff00ff')
    expect(look.cursor).not.toHaveProperty('style')
    expect(look.cursor).not.toHaveProperty('customImage')
    expect(look.cursor.size).toBe(2)
    expect(look.zoom).toEqual({ defaultScale: 2, easing: 'smooth', transition: 0.7 })
    // Applying it elsewhere keeps that project's own background.
    const other = newProject()
    expect(applyPreset(other, look).style.background).toEqual(other.style.background)
  })

  it('writes what unset fields render as, so the saved look comes back over any other look', () => {
    const fresh = newProject()
    expect(fresh.style.frame).toBeUndefined()
    expect(fresh.style.border).toBeUndefined()
    expect(fresh.style.shadowStyle).toBeUndefined()
    const mine = presetLookOf(fresh)
    expect(mine.style).toMatchObject({ frame: { kind: 'none', theme: 'light' }, border: { width: 0 }, shadowStyle: 'soft' })
    // A soft shadow's colour does not show, so it is not part of the look.
    expect(mine.style).not.toHaveProperty('shadowColor')
    for (const id of ['showcase', 'neon', 'pop', 'midnight-browser']) {
      const other = applyPreset(newProject(), BUILT_IN_PRESETS.find((x) => x.id === id)!.look)
      const back = applyPreset(other, mine)
      expect(back.style.frame?.kind ?? 'none', id).toBe('none')
      expect(back.style.border?.width ?? 0, id).toBe(0)
      expect(back.style.shadowStyle ?? 'soft', id).toBe('soft')
      expect(back.cursor.style, id).toBe(fresh.cursor.style)
      expect(back.cursor.highlight, id).toEqual(fresh.cursor.highlight)
      expect(back.cursor.clickStyle, id).toBe(fresh.cursor.clickStyle)
      expect(presetMatches(back, mine), id).toBe(true)
      // Before applying it, the other look is not mistaken for the saved one.
      expect(presetMatches(other, mine), id).toBe(false)
    }
  })

  it('fills the cursor look of an older project that never set it', () => {
    const p = newProject()
    p.cursor = { show: true, size: 1.2, smoothing: 0.5, clickEffect: true, hideWhenIdle: false }
    const look = presetLookOf(p)
    expect(look.cursor).toMatchObject({ size: 1.2, style: expect.any(String), clickStyle: expect.any(String), clickColor: expect.any(String), highlight: { enabled: false } })
    const neon = applyPreset(newProject(), BUILT_IN_PRESETS.find((x) => x.id === 'neon')!.look)
    expect(applyPreset(neon, look).cursor.highlight?.enabled).toBe(false)
  })

  it('keeps the hard or glow shadow colour', () => {
    const p = applyPreset(newProject(), BUILT_IN_PRESETS.find((x) => x.id === 'pop')!.look)
    expect(presetLookOf(p).style).toMatchObject({ shadowStyle: 'hard', shadowColor: '#111827', border: { width: 3, color: '#111827' } })
    const glow = { ...newProject(), style: { ...newProject().style, shadowStyle: 'glow' as const } }
    // No colour of its own: the glow's default colour is what shows.
    expect(presetLookOf(glow).style.shadowColor).toBe('#8b5cf6')
  })
})

describe('user presets', () => {
  const look = BUILT_IN_PRESETS[0].look

  it('validates names', () => {
    expect(presetName('  My   look  ')).toBe('My look')
    expect(presetName('')).toBeNull()
    expect(presetName('   ')).toBeNull()
    expect(presetName(42)).toBeNull()
    expect(presetName('x'.repeat(100))!.length).toBe(40)
  })

  it('adds newest first with unique names, renames and deletes', () => {
    let list: StylePreset[] = []
    list = addUserPreset(list, 'Launch', look, 'a').list
    list = addUserPreset(list, 'launch', look, 'b').list
    expect(list.map((p) => [p.id, p.name])).toEqual([
      ['b', 'launch (2)'],
      ['a', 'Launch']
    ])
    list = renameUserPreset(list, 'b', 'Docs')
    expect(list[0].name).toBe('Docs')
    // Renaming to its own name keeps it.
    expect(renameUserPreset(list, 'a', 'Launch')[1].name).toBe('Launch')
    expect(renameUserPreset(list, 'a', 'docs')[1].name).toBe('docs (2)')
    expect(() => renameUserPreset(list, 'a', ' ')).toThrow(/name/)
    list = deleteUserPreset(list, 'b')
    expect(list.map((p) => p.id)).toEqual(['a'])
  })

  it('refuses an empty name, an empty look and a full list', () => {
    expect(() => addUserPreset([], '', look)).toThrow(/name/)
    expect(() => addUserPreset([], 'x', { style: {}, cursor: {}, zoom: {} })).toThrow(/cannot be saved/)
    const full = Array.from({ length: MAX_USER_PRESETS }, (_, i) => ({ id: `p${i}`, name: `P${i}`, look }))
    expect(() => addUserPreset(full, 'one more', look)).toThrow(/up to/)
  })

  it('reads back only well-formed presets from the preferences file', () => {
    const raw = [
      { id: 'ok', name: 'Fine', look },
      { id: 'ok', name: 'Duplicate id', look },
      { id: 'bad id!', name: 'Bad id', look },
      { name: 'No id', look },
      { id: 'noname', name: '  ', look },
      { id: 'nolook', name: 'No look', look: { style: { padding: 'wide' } } },
      { id: 'partial', name: 'Partial', look: { style: { padding: 9, frame: { kind: 'tv' } }, cursor: { style: 'custom' }, zoom: { easing: 'boing', transition: 0.5 } } },
      null,
      'text'
    ]
    const list = parseUserPresets(raw)
    expect(list.map((p) => p.id)).toEqual(['ok', 'partial'])
    expect(list[1].look).toEqual({ style: { padding: 0.25 }, cursor: {}, zoom: { transition: 0.5 } })
    expect(parseUserPresets(null)).toEqual([])
    expect(parseUserPresets({ presets: [] })).toEqual([])
  })

  it('round-trips through JSON', () => {
    const { list } = addUserPreset([], 'Saved', presetLookOf(applyPreset(newProject(), BUILT_IN_PRESETS[3].look)), 'x1')
    expect(parseUserPresets(JSON.parse(JSON.stringify(list)))).toEqual(list)
  })
})
