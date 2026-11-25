import { describe, expect, it } from 'vitest'
import { burnedSegments, captionsToTranslate, maskedToTranslate, maskedWhenSent, outOfDate, withShownTrack, withTranslation } from '../src/shared/captions/captionTracks'
import { languageSubtitleFile } from '../src/shared/captions/subtitles'
import { privateBleepWord } from '../src/shared/privacy/coverData'
import { maskRequest } from '../src/shared/privacy/aiRequest'
import { trackText } from '../src/shared/privacy/spoken'
import type { AiTextRequest } from '../src/shared/api/ai'
import type { Bleep, CaptionSegment, Project } from '../src/shared/types'
import { base, words } from './autoBlurFixtures'

/*
 * A translation made before Find (docs/design/auto-blur.md §7.4, §2.13, decision 7): its captions
 * under private bleeps show as •••• "until you translate it again". Translate again is what makes
 * the new translation, so those captions must be what it sends, even though their spoken text did
 * not change; once translated again from the masked text, they show and nothing is left to send.
 */

/** A project with two captions, the first saying a card number, and a Spanish track made from them before Find. */
function translatedBeforeFind(): { project: Project; card: CaptionSegment; plain: CaptionSegment } {
  const card = words('s0', 0.5, 'My card is 4111 1111 1111 1111')
  const plain = words('s1', 4, 'Thanks for watching')
  const before: Project = {
    ...base('translate-again', 10),
    transcript: { language: 'en', provider: 'local', model: 'm', createdAt: '2026-11-20T10:00:00.000Z', segments: [card, plain] }
  }
  const sent = captionsToTranslate(before, 'es')
  const translated = withTranslation(before, {
    language: 'es',
    by: 'anthropic',
    model: 'm',
    createdAt: '2026-11-20T11:00:00.000Z',
    sent,
    masked: maskedWhenSent(before, sent),
    answer: sent.map((s) => ({ ...s, text: s.id === 's0' ? 'Mi tarjeta es 4111 1111 1111 1111' : 'Gracias por ver' }))
  })
  if (!translated) throw new Error('the translation before Find was not written')
  // Find bleeps the card number said aloud.
  const w = card.words!
  const bleep: Bleep = { id: 'p1', start: w[3].start - 0.05, end: w[6].end + 0.05, word: privateBleepWord('card', 'g1'), sound: 'tone', auto: true }
  return { project: { ...translated, bleeps: [bleep] }, card, plain }
}

describe('auto-blur: Translate again after Find replaces the masked translation', () => {
  it('sends the captions shown as •••• until translated again, though their spoken text did not change', () => {
    const { project, card } = translatedBeforeFind()
    const track = project.captionTracks![0]
    // Before Find the track was up to date; after Find its card caption shows masked.
    expect(outOfDate(project, 'es')).toEqual([])
    expect(trackText(project, track.segments[0])).not.toBe(track.segments[0].text)
    expect(trackText(project, track.segments[1])).toBe(track.segments[1].text)
    expect(maskedToTranslate(project, 'es')).toEqual(['s0'])
    expect(captionsToTranslate(project, 'es').map((s) => s.id)).toEqual([card.id])
  })

  it('the new translation, made from the masked request, shows and leaves nothing to translate again', () => {
    const { project } = translatedBeforeFind()
    const sent = captionsToTranslate(project, 'es')
    const request = maskRequest({ task: 'translate', segments: sent, targetLanguage: 'Spanish' } as AiTextRequest, project)
    expect(JSON.stringify(request)).not.toMatch(/4111|1111/)
    const next = withTranslation(project, {
      language: 'es',
      by: 'anthropic',
      model: 'm',
      createdAt: '2026-11-21T09:00:00.000Z',
      sent,
      masked: maskedWhenSent(project, sent),
      answer: request.segments.map((s) => ({ ...s, text: `[es] ${s.text}` }))
    })
    expect(next).not.toBeNull()
    const seg = next!.captionTracks![0].segments.find((s) => s.id === 's0')!
    expect(seg.text.startsWith('[es] ')).toBe(true)
    expect(trackText(next!, seg)).toBe(seg.text)
    expect(seg.text).not.toMatch(/\d/)
    expect(maskedToTranslate(next!, 'es')).toEqual([])
    expect(captionsToTranslate(next!, 'es')).toEqual([])
  })

  it('a project without private bleeps sends what it sent before', () => {
    const { project } = translatedBeforeFind()
    const { bleeps: _b, ...plain } = project
    void _b
    expect(maskedToTranslate(plain, 'es')).toEqual([])
    expect(captionsToTranslate(plain, 'es')).toEqual([])
    const ordinary: Project = { ...plain, bleeps: [{ id: 'b1', start: 0.6, end: 0.9, word: 'damn', sound: 'tone' }] }
    expect(maskedToTranslate(ordinary, 'es')).toEqual([])
    expect(captionsToTranslate(ordinary, 'es')).toEqual([])
  })
})

describe('auto-blur §7.4: a translation answered after the private bleeps over its captions changed', () => {
  const DIGITS = /4111|1111/
  /** The Spanish captions as drawn on the video and in the Spanish SRT. */
  const spanish = (p: Project): string => [...burnedSegments(withShownTrack(p, 'es')).map((s) => s.text), languageSubtitleFile(p, 'es', 'srt')].join('\n')

  it('sent before Find, answered after it: the answer, made from the words said, is not stamped as masked; the caption keeps what its track had and stays to translate', () => {
    const { project: found } = translatedBeforeFind()
    // The request leaves before Find: no private bleep yet, so nothing in it is masked.
    const { bleeps: _b, ...before } = found
    void _b
    const fresh: Project = { ...before, captionTracks: [] }
    const sent = captionsToTranslate(fresh, 'es')
    const request = maskRequest({ task: 'translate', segments: sent, targetLanguage: 'Spanish' } as AiTextRequest, fresh)
    expect(JSON.stringify(request)).toMatch(DIGITS)
    const masked = maskedWhenSent(fresh, sent)
    // Find lands while it is out: the card number said aloud gets its private bleep. Then the answer lands.
    const after: Project = { ...fresh, bleeps: found.bleeps }
    const next = withTranslation(after, { language: 'es', by: 'anthropic', model: 'm', createdAt: '2026-11-21T09:00:00.000Z', sent, masked, answer: request.segments.map((s) => ({ ...s, text: `[es] ${s.text}` })) })!
    expect(next).not.toBeNull()
    const track = next.captionTracks![0]
    // The card's caption is left untranslated (it shows masked, as said); the other is written.
    expect(track.segments.map((s) => s.id)).toEqual(['s1'])
    expect(spanish(next)).not.toMatch(DIGITS)
    expect(captionsToTranslate(next, 'es').map((s) => s.id)).toEqual(['s0'])
    // With a translation made before Find, that one stays, masked whole, and is offered again.
    const kept = withTranslation(found, { language: 'es', by: 'anthropic', model: 'm', createdAt: '2026-11-21T09:00:00.000Z', sent, masked, answer: request.segments.map((s) => ({ ...s, text: `[es] ${s.text}` })) })!
    const seg = kept.captionTracks![0].segments.find((s) => s.id === 's0')!
    expect(seg.text).toBe('Mi tarjeta es 4111 1111 1111 1111')
    expect(seg).not.toHaveProperty('maskedFor')
    expect(spanish(kept)).not.toMatch(DIGITS)
    expect(maskedToTranslate(kept, 'es')).toEqual(['s0'])
  })

  it('sent masked, its private bleep removed (Uncover) before the answer lands: the answer, made from the masked text, is not written; the caption keeps what its track had', () => {
    const { project } = translatedBeforeFind()
    const sent = captionsToTranslate(project, 'es')
    const request = maskRequest({ task: 'translate', segments: sent, targetLanguage: 'Spanish' } as AiTextRequest, project)
    expect(JSON.stringify(request)).not.toMatch(DIGITS)
    const masked = maskedWhenSent(project, sent)
    expect(masked.get('s0')).toBe('p1')
    const uncovered: Project = { ...project, bleeps: [] }
    const next = withTranslation(uncovered, { language: 'es', by: 'anthropic', model: 'm', createdAt: '2026-11-21T09:00:00.000Z', sent, masked, answer: request.segments.map((s) => ({ ...s, text: `[es] ${s.text}` })) })
    // Nothing usable: the track keeps the translation made before Find, which shows the words again.
    const seg = (next ?? uncovered).captionTracks![0].segments.find((s) => s.id === 's0')!
    expect(seg.text).toBe('Mi tarjeta es 4111 1111 1111 1111')
    expect(seg.text).not.toContain('•')
    expect(trackText(uncovered, seg)).toBe(seg.text)
  })
})
