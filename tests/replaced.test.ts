import { describe, expect, it } from 'vitest'
import { replacedAt } from '../src/shared/captions/replaced'
import { DEFAULT_CAPTIONS } from '../src/shared/captions/settings'
import { createProject } from '../src/shared/engine/project'
import type { KeywordGraphic, Project, TitleCard } from '../src/shared/types'

/* What a card replaces while it shows (docs/design/captions-studio.md §10.1, §14.1): nothing is read twice. */

const base = (): Project => ({
  ...createProject({ id: 'p', name: 'p', duration: 20, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } as Project['capture'] }),
  transcript: { language: 'en', provider: 'local', model: 'm', createdAt: '2026-10-31T00:00:00Z', segments: [{ id: 'c1', start: 0, end: 3, text: 'Sales grew three hundred percent' }] }
})
const keyword = (extra: Partial<KeywordGraphic> = {}): KeywordGraphic => ({
  id: 'k',
  kind: 'keyword',
  start: 1,
  end: 2,
  place: 'auto',
  size: 0.09,
  enter: { kind: 'pop', duration: 0.24, strength: 1 },
  exit: { kind: 'fade', duration: 0.18, strength: 1 },
  text: 'three hundred percent',
  look: 'card',
  anchor: { caption: 'c1', from: 2, to: 4, text: 'three hundred percent' },
  ...extra
})
const quote = (extra: Partial<TitleCard> = {}): TitleCard => ({ id: 'q', start: 0.5, end: 3.5, title: 'Sales grew', style: 'quote', background: 'style', auto: { by: 'quote', via: 'gemini', caption: 'c1' }, ...extra })

describe('replacedAt', () => {
  it('is the same empty value without anchored keywords and automatic quote cards', () => {
    const p = base()
    const nothing = replacedAt(p, 1.5)
    expect(nothing.captions.size).toBe(0)
    expect(nothing.chunks).toEqual([])
    expect(replacedAt({ ...p, graphics: [keyword({ anchor: undefined })], titles: [quote({ auto: undefined })] }, 1.5)).toBe(nothing)
    expect(replacedAt({ ...p, graphics: [keyword({ replace: false })] }, 1.5)).toBe(nothing)
  })

  it('names the chunk holding an anchored keyword’s first word while the keyword shows', () => {
    const p = { ...base(), graphics: [keyword()] }
    expect(replacedAt(p, 1.5).chunks).toEqual([{ caption: 'c1', word: 2 }])
    expect(replacedAt(p, 0.5).chunks).toEqual([])
    expect(replacedAt(p, 2).chunks).toEqual([])
    expect(replacedAt(p, 1.5).captions.size).toBe(0)
  })

  it('a keyword in another language than the burned-in captions replaces nothing', () => {
    const p = { ...base(), graphics: [keyword({ lang: 'bn' })] }
    expect(replacedAt(p, 1.5).chunks).toEqual([])
    expect(replacedAt({ ...p, captions: { ...DEFAULT_CAPTIONS, track: 'bn' } }, 1.5).chunks).toEqual([{ caption: 'c1', word: 2 }])
    expect(replacedAt({ ...p, graphics: [keyword({ lang: 'en' })] }, 1.5).chunks.length).toBe(1)
  })

  it('names the caption of an automatic quote card while it shows', () => {
    const p = { ...base(), titles: [quote()] }
    expect([...replacedAt(p, 1).captions]).toEqual(['c1'])
    expect(replacedAt(p, 3.6).captions.size).toBe(0)
  })
})
