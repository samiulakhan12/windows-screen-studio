import { describe, expect, it } from 'vitest'
import { applyBrandKit, type BrandKit } from '../src/shared/editor/brandKit'
import { EditStore } from '../src/shared/editor/editStore'
import { createProject } from '../src/shared/engine/project'
import type { Annotation, Freeze, Project, TitleCard } from '../src/shared/types'

/* New text and title cards start with the brand kit's fonts (docs/design/brand-kit.md §3, ProjectBrand). */

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
type Player = { time: number; seek(t: number): void }
type Services = { store: EditStore<Project>; player: Player }
type Select = (sel: { kind: string; id: string } | null) => void
const TITLE_ITEMS = '../src/renderer/src/editor/titleItems'
const FREEZE_ITEMS = '../src/renderer/src/editor/freezeItems'
const { addTitleAt, brandFontFor } = (await import(/* @vite-ignore */ TITLE_ITEMS)) as {
  addTitleAt(services: Services, opts: { at?: number; onSelect: Select }): TitleCard
  brandFontFor(p: Project, kind: 'text' | 'title'): { font?: string }
}
const { addTextOnFreeze } = (await import(/* @vite-ignore */ FREEZE_ITEMS)) as {
  addTextOnFreeze(services: Services, f: Freeze, onSelect: Select): void
}

function project(extra: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 20,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })
  return { ...p, ...extra }
}

const KIT: BrandKit = {
  colors: ['#123456'],
  fonts: [
    { id: 'kh', name: 'Brand Serif', file: 'font-1.ttf' },
    { id: 'kb', name: 'Brand Sans', file: 'font-2.ttf' }
  ],
  headingFont: 'kh',
  bodyFont: 'kb',
  autoApply: false
}
const FILES = { fonts: { kh: 'font-1.ttf', kb: 'font-2.ttf' } }

const services = (p: Project, time = 5): Services => ({
  store: new EditStore(p),
  player: {
    time,
    seek(t: number) {
      this.time = t
    }
  }
})

describe('fonts of new text after Apply brand kit', () => {
  it('a new title card starts with the heading font, a text with the body font', () => {
    const p = applyBrandKit(project(), KIT, FILES)
    expect(p.brand).toMatchObject({ headingFont: 'kh', bodyFont: 'kb' })
    expect(brandFontFor(p, 'title')).toEqual({ font: 'kh' })
    expect(brandFontFor(p, 'text')).toEqual({ font: 'kb' })

    const s = services(p)
    const card = addTitleAt(s, { onSelect: () => {} })
    expect(card.font).toBe('kh')
    expect(s.store.state.titles!.find((c) => c.id === card.id)!.font).toBe('kh')
  })

  it('a text added on a freeze frame starts with the body font', () => {
    const p = { ...applyBrandKit(project(), KIT, FILES), freezes: [{ id: 'f1', at: 4, length: 2, sound: 'pause' as const }] }
    const s = services(p)
    addTextOnFreeze(s, p.freezes[0], () => {})
    const added: Annotation = s.store.state.annotations.at(-1)!
    expect(added.font).toBe('kb')
  })

  it('a title card takes the body font when the kit has no heading font', () => {
    const p = applyBrandKit(project(), { ...KIT, headingFont: undefined }, FILES)
    expect(brandFontFor(p, 'title')).toEqual({ font: 'kb' })
    expect(addTitleAt(services(p), { onSelect: () => {} }).font).toBe('kb')
  })

  it('without a brand, or when its font is no longer in the project, new text uses the default font', () => {
    const plain = project()
    expect(brandFontFor(plain, 'text')).toEqual({})
    expect(brandFontFor(plain, 'title')).toEqual({})
    expect('font' in addTitleAt(services(plain), { onSelect: () => {} })).toBe(false)

    const gone = project({ fonts: [], brand: { colors: [], headingFont: 'kh', bodyFont: 'kb' } })
    expect(brandFontFor(gone, 'text')).toEqual({})
    expect(brandFontFor(gone, 'title')).toEqual({})
    // A missing heading font falls back to the body font while that one is still there.
    const noHeading = project({ fonts: [{ id: 'kb', name: 'Brand Sans', file: 'font-2.ttf' }], brand: { colors: [], headingFont: 'kh', bodyFont: 'kb' } })
    expect(brandFontFor(noHeading, 'title')).toEqual({ font: 'kb' })
  })
})
