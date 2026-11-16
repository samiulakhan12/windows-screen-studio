// Part X2's extras (docs/design/output-and-languages.md §10.5 row X2, §21.8): the names the panels
// show from tables that stay English in main's import graph (shapes, title styles, zoom levels, style
// presets, the sound library's moods and effects), wave 10's cut-style names, the corners (§9.5,
// test 72's camera.corner.* part) and the three number fields that move to NumberField. In English
// every name is today's.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORNER_NAMES } from '../src/shared/recording/cameraBubble'
import { cornerName } from '../src/shared/editor/layouts'
import { SHAPE_KINDS } from '../src/shared/editor/shapes'
import { TITLE_BACKGROUNDS, TITLE_STYLES } from '../src/shared/editor/titles'
import { ZOOM_LEVEL_PRESETS } from '../src/shared/editor/zoomEdit'
import { BUILT_IN_PRESETS } from '../src/shared/editor/stylePresets'
import { presetLabel } from '../src/shared/editor/stylePresetNames'
import { shapeKinds, shapeName, TITLE_BACKGROUND_CHOICES, TITLE_STYLE_CHOICES, titleStyleName, zoomLevelPresets } from '../src/shared/editor/itemNames'
import { joinName } from '../src/shared/editor/joinsEdit'
import { MOODS, SOUND_EFFECTS } from '../src/shared/audio/soundLibrary'
import { moodName, sfxGroupName, sfxName } from '../src/shared/audio/soundNames'
import { ORIGINAL_SOUNDS, sfxGroups, sfxGroupsFor } from '../src/shared/audio/sfxChoices'
import type { ShapeKind } from '../src/shared/types'

const source = (file: string): string => readFileSync(path.join(__dirname, '..', file), 'utf8')

describe('X2: names from tables that stay English for main', () => {
  it('camera.corner.* in English equals CORNER_NAMES', () => {
    for (const [corner, name] of Object.entries(CORNER_NAMES)) expect(cornerName(corner as keyof typeof CORNER_NAMES)).toBe(name)
  })

  it('shape names and tooltips equal SHAPE_KINDS', () => {
    expect(shapeKinds()).toEqual(SHAPE_KINDS.map((k) => ({ kind: k.kind, label: k.label, title: k.title })))
    for (const k of SHAPE_KINDS) expect(shapeName(k.kind)).toBe(k.label)
    // An unknown kind was 'Shape' (shapes.ts's shapeLabel, gone now that every display reads shapeName).
    expect(shapeName('nothing' as ShapeKind)).toBe('Shape')
  })

  it('title card styles and backgrounds equal TITLE_STYLES and TITLE_BACKGROUNDS', () => {
    expect(TITLE_STYLE_CHOICES.map((c) => ({ value: c.value, label: c.label, title: c.title }))).toEqual(TITLE_STYLES.map((s) => ({ value: s.value, label: s.label, title: s.title })))
    expect(TITLE_BACKGROUND_CHOICES.map((c) => ({ value: c.value, label: c.label, title: c.title }))).toEqual(TITLE_BACKGROUNDS.map((b) => ({ value: b.value, label: b.label, title: b.title })))
    for (const s of TITLE_STYLES) expect(titleStyleName(s.value)).toBe(s.label)
  })

  it('zoom level presets equal ZOOM_LEVEL_PRESETS', () => {
    expect(zoomLevelPresets()).toEqual(ZOOM_LEVEL_PRESETS)
  })

  it('built-in style presets keep their names; the user’s own keep what they typed', () => {
    for (const p of BUILT_IN_PRESETS) expect(presetLabel(p, true)).toBe(p.name)
    expect(presetLabel({ id: 'studio', name: 'My studio' }, false)).toBe('My studio')
  })
})

describe('X2: wave 10’s moods, cut styles and sound effects', () => {
  it('the moods are today’s words', () => {
    for (const m of MOODS) expect(moodName(m.id)).toBe(m.label)
  })

  it('the cut styles are today’s names', () => {
    expect([joinName('cut'), joinName(null), joinName('smooth'), joinName('crossfade'), joinName('dip'), joinName('slide'), joinName('punch')]).toEqual([
      'Hard cut',
      'Hard cut',
      'Smooth',
      'Crossfade',
      'Dip to colour',
      'Slide',
      'Punch-in'
    ])
  })

  it('every library effect is named as its catalogue title, and the selects group them as before', () => {
    for (const e of SOUND_EFFECTS) expect(sfxName(e.id)).toBe(e.title)
    expect(sfxName('no-such-effect')).toBe('Sound effect')
    expect(sfxGroups().map((g) => g.label)).toEqual(['Whooshes', 'Pops', 'Clicks', 'Chimes'])
    expect((['whoosh', 'pop', 'click', 'chime'] as const).map(sfxGroupName)).toEqual(['Whooshes', 'Pops', 'Clicks', 'Chimes'])
    expect(sfxGroupsFor('pop-ups')[0].label).toBe('Suggested')
    expect(sfxGroupsFor('pop-ups').flatMap((g) => g.options).map((o) => o.label)).toEqual(sfxGroupsFor('pop-ups').flatMap((g) => g.options).map((o) => SOUND_EFFECTS.find((e) => `sfx:${e.id}` === o.value)!.title))
    expect(ORIGINAL_SOUNDS.map((s) => [s.value, s.label])).toEqual([
      ['pop', 'Original pop'],
      ['ding', 'Original ding']
    ])
  })
})

describe('X2: the three number fields (§10.5)', () => {
  it('use NumberField, and keep today’s number input in English', () => {
    const graphics = source('src/renderer/src/editor/panels/GraphicsPanel.tsx')
    expect(graphics).toMatch(/import \{ NumberField \} from '\.\.\/\.\.\/i18n\/NumberField'/)
    expect(graphics).toMatch(/<NumberField\s[^>]*aria-label=\{label\}/)
    for (const file of ['src/renderer/src/editor/panels/ShapesPanel.tsx', 'src/renderer/src/editor/mixedControls.tsx']) {
      const text = source(file)
      expect(text).toMatch(/import \{ NumberField \} from '[./]+i18n\/NumberField'/)
      expect(text).toMatch(/uiLanguage\(\) (===|!==) 'en'/)
      expect(text).toMatch(/type="number"/)
    }
  })
})
