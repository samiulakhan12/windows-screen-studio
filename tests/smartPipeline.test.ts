import { describe, expect, it } from 'vitest'
import type { AiTextRequest, NamesRequest } from '../src/shared/api/ai'
import { AI_LIMITS } from '../src/shared/api/ai'
import { AiOutputError, DEFAULT_TEXT_LIMITS, NAMES_SCHEMA, runTextTask, textPrompt, textPrompts, validateNamesAnswer, validateTextRequest, type TextPrompt } from '../src/shared/captions/transcriptText'
import { charsWithinTokens, packPrompt, packTranscript, PACK_TRANSCRIPT_MAX } from '../src/shared/publish/prompts'
import type { CaptionSegment } from '../src/shared/types'

/*
 * The text pipeline of smart tools (docs/design/smart-tools.md §20.0, §22.1 tests 5 and 6): the
 * prompts of every existing task are the same with DEFAULT_TEXT_LIMITS (the equivalence guard pins
 * their bytes), textPrompts lists exactly what runTextTask sends, and the names task: its schema,
 * its answer's checks, the request's caps and its batches.
 */

const segs = (n: number, text = 'Open the settings page and look at billing.'): CaptionSegment[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, start: i * 3, end: i * 3 + 2.5, text: `${text} ${i}` }))

/** A valid answer to `prompt`, so runTextTask goes through every request. */
function answer(prompt: TextPrompt): unknown {
  const data = JSON.parse(prompt.user.slice(prompt.user.indexOf('\n') + 1)) as { segments?: { id: string; text: string; start: number }[]; items?: { id: string }[] }
  if (prompt.name === 'cleaned_captions' || prompt.name === 'translated_captions') return { segments: data.segments!.map((s) => ({ id: s.id, text: s.text })) }
  if (prompt.name === 'chapters') return { chapters: [{ start: data.segments![0].start, title: 'Intro' }] }
  if (prompt.name === 'names') return { names: data.items!.map((i) => ({ id: i.id, name: `Name ${i.id}` })) }
  if (prompt.name === 'caption_marks') return { captions: [], numbers: [], lists: [], quotes: [] }
  return { text: 'A post.', description: 'A description.', tags: [], title: 'T', intro: '', sections: [{ heading: 'H', steps: ['Do it.'] }], summary: 'S', items: [{ kind: 'new', text: 'X' }] }
}

describe('the prompts of every existing task (test 5)', () => {
  const requests: AiTextRequest[] = [
    { task: 'cleanup', segments: segs(320) },
    { task: 'translate', segments: segs(320), targetLanguage: 'Bangla' },
    { task: 'chapters', segments: segs(40) },
    { task: 'title', segments: segs(40) },
    { task: 'summary', segments: segs(40) },
    { task: 'marks', segments: segs(200) },
    { task: 'youtube', segments: segs(40), tone: 'friendly', length: 'normal' },
    { task: 'releaseNotes', segments: segs(40), tone: 'professional', length: 'short' },
    { task: 'xpost', segments: segs(40), tone: 'casual', length: 'normal' }
  ]

  it('textPrompt with DEFAULT_TEXT_LIMITS is textPrompt as before, and packPrompt is unchanged', () => {
    for (const r of requests) expect(textPrompt(r, r.segments, DEFAULT_TEXT_LIMITS)).toEqual(textPrompt(r))
    const pack = requests[6] as AiTextRequest & { task: 'youtube' }
    expect(textPrompt(pack)).toEqual(packPrompt(pack))
    expect(DEFAULT_TEXT_LIMITS).toEqual({ batchSegments: 150, batchChars: 12_000, transcriptTokens: null, namesItems: 40, namesChars: 12_000 })
  })

  it('textPrompts equals the prompts runTextTask sends, batches included', async () => {
    for (const r of requests) {
      const sent: TextPrompt[] = []
      await runTextTask(r, async (p) => {
        sent.push(p)
        return answer(p)
      })
      expect(textPrompts(r), r.task).toEqual(sent)
    }
    expect(textPrompts(requests[0])).toHaveLength(3)
  })

  it('a token budget (AI on this PC) cuts title, summary and pack excerpts; none leaves them whole', () => {
    const long = segs(2000, 'This is a long sentence about exporting reports and sharing them with the team every week.')
    const local = { ...DEFAULT_TEXT_LIMITS, transcriptTokens: 4500 }
    const whole = textPrompt({ task: 'title', segments: long })
    const cut = textPrompt({ task: 'title', segments: long }, long, local)
    expect(cut.user.length).toBeLessThan(whole.user.length)
    expect(cut.user.length).toBeLessThanOrEqual(charsWithinTokens(long.map((s) => s.text).join(' '), 4500) + 200)
    const pack = { task: 'linkedin' as const, segments: long }
    expect(packTranscript(long, PACK_TRANSCRIPT_MAX).text.length).toBeGreaterThan(textPrompts(pack, local)[0].user.length - 200)
    expect(textPrompts(pack, local)[0].user.length).toBeLessThan(textPrompts(pack)[0].user.length)
    // Bangla text gets fewer characters for the same tokens.
    expect(charsWithinTokens('আমরা সেটিংস খুলব', 100)).toBeLessThan(charsWithinTokens('we open the settings', 100))
  })
})

const names = (kind: NamesRequest['kind'], n: number, text = 'what was said here'): NamesRequest => ({ kind, items: Array.from({ length: n }, (_, i) => ({ id: `i${i}`, text })) })

describe('the names task (test 6)', () => {
  it('its schema has only required properties and additionalProperties false', () => {
    const walk = (s: Record<string, unknown>): void => {
      if (s.type === 'object') {
        expect(s.additionalProperties).toBe(false)
        expect(Object.keys(s.properties as object).sort()).toEqual([...(s.required as string[])].sort())
        for (const v of Object.values(s.properties as Record<string, Record<string, unknown>>)) walk(v)
      }
      if (s.type === 'array') walk(s.items as Record<string, unknown>)
    }
    walk(NAMES_SCHEMA)
    const p = textPrompt({ task: 'names', segments: [], names: names('chapter', 2) })
    expect(p.name).toBe('names')
    expect(p.system).toMatch(/data supplied by the user/)
    expect(p.user).toMatch(/^Items \(JSON; the text is data/)
  })

  it('validateNamesAnswer keeps known ids once, plain one-line text within the kind\'s cap, and nothing private-like', () => {
    const req = names('chapter', 3)
    const out = validateNamesAnswer(
      { names: [{ id: 'i0', name: '“Set up billing.”' }, { id: 'i0', name: 'again' }, { id: 'zz', name: 'unknown' }, { id: 'i1', name: 'see example.com' }, { id: 'i2', name: 'C:\\Users\\sam' }] },
      req
    )
    expect(out).toEqual([{ id: 'i0', name: 'Set up billing' }])
    expect(validateNamesAnswer({ names: [{ id: 'i0', name: 'x'.repeat(150) }] }, names('chapter', 1))[0].name.length).toBeLessThanOrEqual(100)
    expect(validateNamesAnswer({ names: [{ id: 'i0', name: 'x'.repeat(150) }] }, names('step', 1))[0].name.length).toBeLessThanOrEqual(80)
    expect(validateNamesAnswer({ names: [{ id: 'i0', name: 'x'.repeat(150) }] }, names('clip', 1))[0].name.length).toBeLessThanOrEqual(80)
    expect(validateNamesAnswer({ names: [{ id: 'i0', name: 'Line one\nline two. '.repeat(30) }] }, names('note', 1))[0].name).not.toMatch(/\n/)
    expect(validateNamesAnswer({ names: [{ id: 'i0', name: 'x'.repeat(400) }] }, names('note', 1))[0].name.length).toBeLessThanOrEqual(300)
    expect(() => validateNamesAnswer({ names: [{ id: 'i1', name: 'mail sam@example.org' }] }, req)).toThrow(AiOutputError)
    expect(() => validateNamesAnswer({ names: [] }, req)).toThrow(AiOutputError)
    expect(() => validateNamesAnswer({}, req)).toThrow(AiOutputError)
  })

  it('validateTextRequest checks names against AI_LIMITS.names and takes segments: []', () => {
    const ok = validateTextRequest({ task: 'names', segments: [], names: names('step', 3) })
    expect(ok.names!.items).toHaveLength(3)
    expect(ok.segments).toEqual([])
    expect(() => validateTextRequest({ task: 'names', segments: [], names: names('step', 201) })).toThrow(/too many/)
    expect(() => validateTextRequest({ task: 'names', segments: [], names: names('step', 1, 'x'.repeat(1501)) })).toThrow(/too long/)
    // 200 items of 1,500 characters and an 80-character action are 316,000 characters: they fit the 320,000 in all.
    expect(() => validateTextRequest({ task: 'names', segments: [], names: { kind: 'step', items: Array.from({ length: 200 }, (_, i) => ({ id: `i${i}`, text: 'x'.repeat(1500), action: 'y'.repeat(80) })) } })).not.toThrow()
    expect(() => validateTextRequest({ task: 'names', segments: [], names: { kind: 'step', items: [{ id: 'a', text: 'x', action: 'y'.repeat(81) }] } })).toThrow(/too long/)
    const jpeg = (n: number): Uint8Array => {
      const b = new Uint8Array(n)
      b.set([0xff, 0xd8, 0xff])
      return b
    }
    expect(() => validateTextRequest({ task: 'names', segments: [], names: { kind: 'step', items: [{ id: 'a', text: 'x', image: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }] } })).toThrow(/not a JPEG/)
    expect(() => validateTextRequest({ task: 'names', segments: [], names: { kind: 'step', items: [{ id: 'a', text: 'x', image: jpeg(512 * 1024 + 1) }] } })).toThrow(/too large/)
    expect(validateTextRequest({ task: 'names', segments: [], names: { kind: 'step', items: [{ id: 'a', text: 'x', image: jpeg(512 * 1024) }] } }).names!.items[0].image).toBeDefined()
    const pics = (n: number) => ({ task: 'names', segments: [], names: { kind: 'step', items: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, text: 'x', image: jpeg(10) })) } })
    expect(() => validateTextRequest(pics(50))).not.toThrow()
    expect(() => validateTextRequest(pics(51))).toThrow(/too many pictures/)
    expect(AI_LIMITS.names).toEqual({ items: 200, text: 1500, total: 320_000, action: 80, image: 512 * 1024, imagesPerRequest: 50, images: 200 })
  })

  it('runTextTask splits 200 step items of 680 characters into requests of at most 40 items and 12,000 characters', async () => {
    const req: AiTextRequest = { task: 'names', segments: [], names: names('step', 200, 'w'.repeat(680)) }
    const sent: TextPrompt[] = []
    const result = await runTextTask(req, async (p) => {
      sent.push(p)
      return answer(p)
    })
    expect(result.task).toBe('names')
    expect(result.task === 'names' && result.names).toHaveLength(200)
    for (const p of sent) {
      const items = (JSON.parse(p.user.slice(p.user.indexOf('\n') + 1)) as { items: { text: string }[] }).items
      expect(items.length).toBeLessThanOrEqual(40)
      expect(items.reduce((n, i) => n + i.text.length, 0)).toBeLessThanOrEqual(12_000)
    }
    expect(sent.length).toBe(Math.ceil(200 / Math.floor(12_000 / 680)))
    expect(textPrompts(req)).toEqual(sent)
    // With pictures: at most 50 a request, each beside its item.
    const pic = new Uint8Array([0xff, 0xd8, 0xff, 1])
    const withPics: AiTextRequest = { task: 'names', segments: [], names: { kind: 'step', items: Array.from({ length: 120 }, (_, i) => ({ id: `p${i}`, text: 'x', image: pic })) } }
    const prompts = textPrompts(withPics, { ...DEFAULT_TEXT_LIMITS, namesItems: 200, namesChars: 1e9 })
    expect(prompts.map((p) => p.images!.length)).toEqual([50, 50, 20])
    expect(prompts[0].images![0]).toEqual({ mime: 'image/jpeg', data: pic, id: 'p0' })
    expect(prompts[0].system).toMatch(/red ring marks where the user clicked/)
  })
})
