import { describe, expect, it } from 'vitest'
import { burnedSegments, maskedWhenSent, withTranslation } from '../src/shared/captions/captionTracks'
import { maskBleeped, maskedSegments } from '../src/shared/captions/cleanup'
import { languageSubtitleFile, spokenSegments } from '../src/shared/captions/subtitles'
import { trackCues } from '../src/shared/captions/trackCues'
import { readCaptionTracks } from '../src/shared/captions/studioData'
import { textPrompts } from '../src/shared/captions/transcriptText'
import { namesRequestForChapters } from '../src/shared/chapters/names'
import { outputChapters, youtubeChapters } from '../src/shared/render/chapters'
import { descriptionText } from '../src/shared/render/exportBundle'
import { publishSegments } from '../src/shared/publish/pack'
import { guideSegments, namesRequestForSteps } from '../src/shared/guide/stepTitles'
import { projectUnits } from '../src/shared/search/extract'
import { captionReviewItems, captionPendingCount } from '../src/shared/review/captionReview'
import { reviewItems } from '../src/shared/review/review'
import { privateBleepWord } from '../src/shared/privacy/coverData'
import { maskRequest } from '../src/shared/privacy/aiRequest'
import { PRIVATE_TEXT_FIELDS, maskChars, maskPrivate, maskedForOf, privateView, spokenForms } from '../src/shared/privacy/spoken'
import type { AiTextRequest } from '../src/shared/api/ai'
import type { Bleep, CaptionSegment, Project } from '../src/shared/types'
import { base, oldFixtures, words } from './autoBlurFixtures'
import { migrateProject } from '../src/shared/engine/project'

/*
 * Secrets said aloud in every text made from captions (docs/design/auto-blur.md §7; §17.1 tests 18,
 * 19, 21-24, 191 and 192): captions and translations masked by time, the spoken forms taken from each
 * hit's own words, privateView at every output, and every AI request masked.
 */

/** A private bleep over words from..to (indexes) of `seg`, widened 0.05 s as said.ts widens them. */
function bleepOver(seg: CaptionSegment, from: number, to: number, kind: Parameters<typeof privateBleepWord>[0], group: string, id: string): Bleep {
  const w = seg.words!
  return { id, start: w[from].start - 0.05, end: w[to].end + 0.05, word: privateBleepWord(kind, group), sound: 'tone', auto: true }
}

/** A project where a card is said across two captions, and other texts hold its written forms. */
function cardProject(): Project {
  const k1 = words('k1', 1, 'My card is 4917 6123 4567')
  const k2 = words('k2', 4, 'eight nine zero four and that is it')
  const k3 = words('k3', 8, 'Four ways to save weight and fourteen tips')
  const bleeps: Bleep[] = [bleepOver(k1, 3, 5, 'card', 'k3v9q2m8xa', 'p1'), bleepOver(k2, 0, 3, 'card', 'k3v9q2m8xa', 'p2')]
  return {
    ...base('masking', 30),
    transcript: { language: 'en', provider: 'local', model: 'm', createdAt: '2026-11-20T10:00:00.000Z', segments: [k1, k2, k3] },
    bleeps,
    chapters: [
      { id: 'c1', t: 0, title: 'Billing 4917-6123-4567-8904' },
      { id: 'c2', t: 8, title: 'Saving tips' }
    ],
    titles: [{ id: 't1', start: 0.5, end: 2, title: 'Card 4917 6123 4567 8904', subtitle: 'Four ways', style: 'centered', background: 'blur' }],
    publish: { description: 'Pay with 4917 6123 4567 8904 today.' } as Project['publish'],
    guide: { title: 'Card 4917612345678904', intro: 'Four ways to save', steps: [{ key: 'c1000', title: 'Type 4917 6123 4567 8904', text: 'then save' }], added: [{ key: 'a5000', t: 5, title: 'Check 4917-6123-4567-8904' }], details: [{ text: 'card 4917 6123 4567 8904' }] }
  }
}

const FORM = /4917|6123|4567|8904/

describe('auto-blur contracts: captions and texts made from captions', () => {
  it('18. Captions: maskedSegments masks the words under a private bleep with • by time; a caption whose words and times do not line up is masked from the first to the last word touching it; one with no word times whole; ordinary bleeps as before', () => {
    const p = cardProject()
    const out = maskedSegments(p.transcript!.segments, p.bleeps)
    expect(out[0].text).toBe('My card is •••• •••• ••••')
    expect(out[1].text).toBe('••••• •••• •••• •••• and that is it')
    expect(out[0].words!.map((w) => w.text)).toEqual(['My', 'card', 'is', '••••', '••••', '••••'])
    expect(out[2]).toBe(p.transcript!.segments[2])
    // Words that do not line up with the text (one deleted from the text): the span touching the bleep is masked.
    const k1 = p.transcript!.segments[0]
    const edited: CaptionSegment = { ...k1, text: 'My card is 4917 6123' }
    const [m] = maskedSegments([edited], p.bleeps)
    expect(m.text).not.toMatch(FORM)
    expect(m.text.startsWith('My card')).toBe(true)
    // No word times: the whole caption.
    const bare: CaptionSegment = { id: 'b', start: 1, end: 3.5, text: 'card 4917 6123 4567' }
    expect(maskedSegments([bare], p.bleeps)[0].text).toBe('•••• •••• •••• ••••')
    // Ordinary bleeps: today's output, first letter kept, a misaligned caption left as it is.
    const ordinary: Bleep[] = [{ id: 'o', start: k1.words![1].start - 0.05, end: k1.words![1].end + 0.05, word: 'card', sound: 'tone' }]
    expect(maskedSegments([k1], ordinary)[0].text).toBe('My c*** is 4917 6123 4567')
  })

  it('19. Translations: a track segment over a private bleep reads •••• unless its maskedFor matches; readCaptionTracks keeps maskedFor; burnedSegments, trackCues and the SRT and VTT files are masked', () => {
    const p0 = cardProject()
    const track = { language: 'es', by: 'local' as const, model: 'm', createdAt: '2026-11-20T11:00:00.000Z', segments: p0.transcript!.segments.map((s) => ({ id: s.id, text: `es ${s.text}`, src: 'x' })) }
    const p: Project = { ...p0, captionTracks: [track], captions: { ...p0.captions!, track: 'es' } }
    const burned = burnedSegments(p)
    expect(burned[0].text).toBe(maskChars(`es ${p0.transcript!.segments[0].text}`))
    expect(burned[2].text).toBe(`es ${p0.transcript!.segments[2].text}`)
    for (const f of ['srt', 'vtt'] as const) expect(languageSubtitleFile(p, 'es', f)).not.toMatch(FORM)
    expect(trackCues(p, 'es').some((c) => FORM.test(c.text))).toBe(false)
    // Translated again from the masked text: shown.
    const masked = { ...track, segments: track.segments.map((s) => ({ ...s, text: s.id === 'k1' ? 'es Mi tarjeta es •••• •••• ••••' : s.text, maskedFor: maskedForOf(p, s.id) })) }
    expect(maskedForOf(p, 'k1')).toBe('p1')
    const again: Project = { ...p, captionTracks: [masked] }
    expect(burnedSegments(again)[0].text).toBe('es Mi tarjeta es •••• •••• ••••')
    // The reader keeps it (at most 2,048 characters).
    const read = readCaptionTracks(JSON.parse(JSON.stringify([masked, { ...masked, language: 'fr', segments: masked.segments.map((s) => ({ ...s, maskedFor: 'x'.repeat(2049) })) }])), p.transcript)!
    expect(read[0].segments[0].maskedFor).toBe('p1')
    expect(read[1].segments.every((s) => !('maskedFor' in s))).toBe(true)
    // A translation answered for a masked request carries maskedFor.
    const sent = p0.transcript!.segments
    const fresh = withTranslation(p0, { language: 'de', by: 'local', model: 'm', createdAt: '2026-11-20T12:00:00.000Z', sent, masked: maskedWhenSent(p0, sent), answer: sent.map((s) => ({ id: s.id, start: s.start, end: s.end, text: `de ${s.id}` })) })!
    const de = fresh.captionTracks!.find((x) => x.language === 'de')!
    expect(de.segments.find((s) => s.id === 'k1')!.maskedFor).toBe('p1')
    expect(de.segments.find((s) => s.id === 'k3')!).not.toHaveProperty('maskedFor')
  })

  it('21. Spoken forms: a card said "4917 6123 4567 eight nine zero four" gives the digit string and its groupings; maskPrivate masks both written forms in a chapter title; a form of 3 characters masks only a whole word; without private bleeps it returns its input', () => {
    const p = cardProject()
    const forms = spokenForms(p)!
    expect(forms.digits).toContain('4917612345678904')
    expect(forms.digits).toContain('4917 6123 4567 8904')
    expect(forms.digits).toContain('4917-6123-4567-8904')
    expect(forms.phrases).toEqual([])
    expect(maskPrivate('Billing 4917-6123-4567-8904', forms)).toBe('Billing ••••-••••-••••-••••')
    expect(maskPrivate('Billing 4917 6123 4567 8904', forms)).toBe('Billing •••• •••• •••• ••••')
    // Part of a longer run: not masked.
    expect(maskPrivate('ID 14917612345678904', forms)).toBe('ID 14917612345678904')
    const short = { phrases: ['Joe'], digits: ['123'] }
    expect(maskPrivate('Joe and Joey met at 123 or 1234', short)).toBe('••• and Joey met at ••• or 1234')
    const plain = { ...p, bleeps: [{ id: 'o', start: 1, end: 2, word: 'damn', sound: 'tone' as const }] }
    expect(spokenForms(plain)).toBeNull()
    const text = 'Billing 4917 6123 4567 8904'
    expect(maskPrivate(text, null)).toBe(text)
  })

  it('22. privateView at every output: the chapter bar and title cards, chapter metadata, the chapters and description files, the pack, the guide and the timeline markers hold no form; the stored texts are unchanged', () => {
    const p = cardProject()
    const before = JSON.stringify(p)
    const v = privateView(p)
    expect(v).not.toBe(p)
    const texts = [
      ...v.chapters!.map((c) => c.title),
      ...v.titles!.flatMap((c) => [c.title, c.subtitle ?? '']),
      v.publish!.description,
      v.guide!.title!,
      v.guide!.steps![0].title!,
      v.guide!.added![0].title,
      v.guide!.details![0].text
    ]
    for (const s of texts) expect(s, s).not.toMatch(FORM)
    // The file's chapter metadata and the chapters and description sidecars are made from the view.
    const chapters = outputChapters(v.chapters!, v.clips)
    expect(JSON.stringify(chapters)).not.toMatch(FORM)
    expect(JSON.stringify(youtubeChapters(chapters, 30))).not.toMatch(FORM)
    expect(descriptionText(v.publish!.description ?? '', 30, chapters)).not.toMatch(FORM)
    // Step keys are identifiers, never masked; words the forms do not match stay.
    expect(v.guide!.steps![0].key).toBe('c1000')
    expect(v.titles![0].subtitle).toBe('Four ways')
    expect(JSON.stringify(p)).toBe(before)
  })

  it('23. maskRequest walks every string, masks segments by time, returns the same object without private bleeps, and for each request shape a spoken secret leaves no form', () => {
    const p = cardProject()
    const segs = p.transcript!.segments
    const requests: AiTextRequest[] = [
      { task: 'cleanup', segments: [...segs] },
      { task: 'translate', segments: [...segs], targetLanguage: 'Spanish' },
      { task: 'chapters', segments: [...spokenSegments(p)] },
      { task: 'marks', segments: [...segs], marks: { language: 'en', captions: segs.map((s) => ({ id: s.id, w: s.text.split(' ') })) } },
      { task: 'names', segments: [], names: namesRequestForChapters(p, [0, 8]) },
      { task: 'title', segments: [...segs] },
      { task: 'summary', segments: [...segs] },
      { task: 'youtube', segments: publishSegments(p), tone: 'friendly', length: 'normal', context: { title: 'Pay 4917 6123 4567 8904', chapters: ['Billing 4917-6123-4567-8904'] } },
      { task: 'linkedin', segments: guideSegments(p), tone: 'friendly', length: 'short' },
      { task: 'names', segments: [], names: namesRequestForSteps(p, [], 'step') }
    ]
    for (const r of requests) {
      const m = maskRequest(r, p)
      expect(JSON.stringify(m), r.task).not.toMatch(FORM)
      expect(JSON.stringify(textPrompts(m)), r.task).not.toMatch(FORM)
    }
    // A form inside an unknown nested field is masked too.
    const odd = maskRequest({ task: 'cleanup', segments: [], extra: { deep: ['call 4917 6123 4567 8904'] } } as unknown as AiTextRequest, p) as unknown as { extra: { deep: string[] } }
    expect(odd.extra.deep[0]).toBe('call •••• •••• •••• ••••')
    const plain = { ...p, bleeps: undefined }
    for (const r of requests) expect(maskRequest(r, plain)).toBe(r)
  })

  it('24. Other texts: the search index, Review\'s caption titles and the transcript text hold no form; private bleeps are not listed as Bleep rows', () => {
    const p = cardProject()
    const units = projectUnits(JSON.parse(JSON.stringify(p)))
    expect(JSON.stringify(units)).not.toMatch(FORM)
    expect(captionReviewItems(p).some((i) => i.kind === 'bleep')).toBe(false)
    expect(captionPendingCount(p)).toBe(0)
    expect(reviewItems(p).some((i) => i.kind === 'bleep')).toBe(false)
    for (const f of ['srt', 'vtt', 'txt'] as const) expect(languageSubtitleFile(p, null, f)).not.toMatch(FORM)
    expect(maskBleeped('Card 4917 6123 4567 8904 is mine', p.bleeps, spokenForms(p))).not.toMatch(FORM)
    // An ordinary bleep is still a Bleep row.
    const both = { ...p, bleeps: [...p.bleeps!, { id: 'o', start: 20, end: 20.4, word: 'damn', sound: 'tone' as const, auto: true as const }] }
    expect(captionReviewItems(both).filter((i) => i.kind === 'bleep').map((i) => i.key)).toEqual(['bleep:o'])
  })

  it('191. privateView masks every field of PRIVATE_TEXT_FIELDS; returns the project itself without private bleeps or without a form; the same object for the same project; removing the private bleep gives the stored texts back', () => {
    expect(PRIVATE_TEXT_FIELDS).toEqual(['name', 'chapters[].title', 'titles[].title', 'titles[].subtitle', 'publish.description', 'guide.title', 'guide.intro', 'guide.expected', 'guide.actual', 'guide.details[].text', 'guide.steps[]', 'guide.added[]'])
    const p = cardProject()
    const v = privateView(p)
    expect(privateView(p)).toBe(v)
    const bug: Project = { ...p, guide: { kind: 'bug', expected: 'saved 4917 6123 4567 8904', actual: 'shows 4917-6123-4567-8904' } }
    const bv = privateView(bug)
    expect(bv.guide!.expected).toBe('saved •••• •••• •••• ••••')
    expect(bv.guide!.actual).toBe('shows ••••-••••-••••-••••')
    const plain = { ...p, bleeps: undefined }
    expect(privateView(plain)).toBe(plain)
    const noForm: Project = { ...p, chapters: [{ id: 'c', t: 0, title: 'Intro' }], titles: [], publish: undefined, guide: undefined }
    expect(privateView(noForm)).toBe(noForm)
    for (const f of oldFixtures()) {
      const o = migrateProject(structuredClone(f.raw))
      expect(privateView(o), f.name).toBe(o)
    }
    expect(privateView({ ...p, bleeps: [] }).chapters).toBe(p.chapters)
  })

  it('192. Spoken forms come from the own words: "four nine one seven …" gives its digits and no number word; "weight", "fourteen" and "Four ways to save" stay; a padded neighbour ("is") is not a form; a multi-word hit masks only as a whole phrase', () => {
    const k1 = words('k1', 1, 'the card is four nine one seven six one two three')
    const k2 = words('k2', 6, 'four five six seven eight nine zero four')
    // The bleep padded so its edge just reaches "is" (whose middle stays outside the shrunk span).
    const b1: Bleep = { id: 'p1', start: k1.words![3].start - 0.05, end: k1.words![10].end + 0.05, word: privateBleepWord('card', 'g1'), sound: 'tone', auto: true }
    const b2: Bleep = { id: 'p2', start: k2.words![0].start - 0.05, end: k2.words![7].end + 0.05, word: privateBleepWord('card', 'g1'), sound: 'tone', auto: true }
    const name = words('k3', 12, 'ask Priya Raman about it')
    const b3: Bleep = { id: 'p3', start: name.words![1].start - 0.05, end: name.words![2].end + 0.05, word: privateBleepWord('name', 'g2'), sound: 'tone', auto: true }
    const p: Project = { ...base('own', 30), transcript: { language: 'en', provider: 'local', model: 'm', createdAt: '2026-11-20T10:00:00.000Z', segments: [k1, name, k2] }, bleeps: [b1, b3, b2] }
    const forms = spokenForms(p)!
    expect(forms.digits).toContain('4917612345678904')
    expect(forms.phrases).toContain('Priya Raman')
    for (const f of forms.phrases) expect(f.split(' ')).not.toContain('is')
    expect(forms.phrases.some((f) => /^(four|nine|one|seven)$/i.test(f))).toBe(false)
    const text = 'Four ways to save weight, fourteen tips; is this it?'
    expect(maskPrivate(text, forms)).toBe(text)
    expect(maskPrivate('Priya called. Priya Raman too, and Raman.', forms)).toBe('Priya called. ••••• ••••• too, and Raman.')
  })
})
