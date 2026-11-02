/**
 * Stand-ins for Captions Studio part P1's functions in part P4's tests (docs/design/captions-studio.md
 * §14.5: P1 merges before P4). Each wraps the real function and is used only while that function is
 * still the contracts' stub (it throws "not implemented (Captions Studio part P1)"); once P1 has
 * merged, the tests run on P1's code. They follow P1's rules closely enough for P4's rules:
 *
 *   vi.mock('../src/shared/captions/words', async (o) => (await import('./p1Fillins')).fillWords(await o()))
 *
 * This file imports no module that imports words.ts at its top, so the mock factories never wait
 * on each other.
 */
import { studioPreset } from '../src/shared/captions/studioPresets'
import type { CaptionSegment, CaptionSettings, CaptionStudio, Project } from '../src/shared/types'
import type * as Words from '../src/shared/captions/words'
import type * as Layout from '../src/shared/captions/studioLayout'
import type * as Edit from '../src/shared/captions/studioEdit'
import type * as Marks from '../src/shared/captions/marks'

const P1_STUB = /not implemented \(Captions Studio part P1\)/

/** `real`, or `stand` while `real` is P1's stub. */
function filled<F extends (...args: never[]) => unknown>(real: F, stand: F): F {
  let stub: boolean | null = null
  return ((...args: Parameters<F>) => {
    if (stub === false) return real(...args)
    if (stub === true) return stand(...args)
    try {
      const out = real(...args)
      stub = false
      return out
    } catch (e) {
      if (!(e instanceof Error) || !P1_STUB.test(e.message)) throw e
      stub = true
      return stand(...args)
    }
  }) as F
}

const graphemes = (s: string): number => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length

export function fillWords(m: typeof Words): typeof Words {
  const studioTokens: typeof Words.studioTokens = (seg, language) => {
    const words = m.studioWords(seg.text, language)
    const provider = seg.words ?? []
    const weights = words.map((w) => graphemes(w.text) + 1)
    const total = weights.reduce((a, b) => a + b, 0) || 1
    let acc = 0
    return words.map((w, i) => {
      const a = seg.start + (acc / total) * (seg.end - seg.start)
      acc += weights[i]
      const b = seg.start + (acc / total) * (seg.end - seg.start)
      const p = provider.length === words.length ? provider[i] : null
      return {
        text: w.text,
        start: p ? p.start : a,
        end: p ? p.end : b,
        word: i,
        gap: w.gap,
        ...(!p || p.estimated ? { estimated: true as const } : {}),
        dir: 'l' as const,
        script: 'latin' as const
      }
    })
  }
  return { ...m, studioTokens: filled(m.studioTokens, studioTokens) }
}

export function fillLayout(m: typeof Layout, words: typeof Words): typeof Layout {
  const studioLayout: typeof Layout.studioLayout = (seg: CaptionSegment, studio: CaptionStudio, _w, _h, _measure, opts) => {
    const tokens = words.studioTokens(seg, opts.language)
    const size = studio.layout.chunk === 'word' ? 1 : studio.layout.chunk === 'phrase' ? Infinity : Math.max(1, studio.layout.words)
    const chunks: Layout.StudioChunk[] = []
    let first = 0
    tokens.forEach((t, i) => {
      const end = i === tokens.length - 1 || i - first + 1 >= size || /[.!?]$/.test(t.text)
      if (!end) return
      chunks.push({ start: tokens[first].start, end: t.end, lines: [], first, last: i, width: 0, height: 0 })
      first = i + 1
    })
    if (chunks.length) {
      chunks[0].start = seg.start
      chunks[chunks.length - 1].end = seg.end
      for (let i = 1; i < chunks.length; i++) chunks[i].start = chunks[i - 1].end
    }
    return { tokens, chunks, px: 10, lineHeight: 12, rtl: false, dirs: tokens.map(() => 'l'), emphasis: tokens.map(() => 0), caption: seg.id }
  }
  return { ...m, studioLayout: filled(m.studioLayout, studioLayout) }
}

export function fillEdit(m: typeof Edit): typeof Edit {
  const legacyTwin: typeof Edit.legacyTwin = (settings: CaptionSettings) => {
    const look = structuredClone(studioPreset('subtitle')!.look)
    return { ...look, from: settings.preset, layout: { ...look.layout, legacyAnchor: true } }
  }
  return { ...m, legacyTwin: filled(m.legacyTwin, legacyTwin) }
}

export async function fillMarks(m: typeof Marks): Promise<typeof Marks> {
  const { checkAnchor } = await import('../src/shared/captions/studioData')
  const remapAnchors: typeof Marks.remapAnchors = (next: Project, prev: Project) => {
    if (next.transcript === prev.transcript || !next.captionMarks?.length) return next
    const marks = next.captionMarks.map((x) => checkAnchor(x, next.transcript)).filter((x): x is NonNullable<typeof x> => !!x)
    const same = marks.length === next.captionMarks.length && marks.every((x, i) => x === next.captionMarks![i])
    if (same) return next
    const { captionMarks: _gone, ...rest } = next
    void _gone
    return marks.length ? { ...rest, captionMarks: marks } : rest
  }
  return { ...m, remapAnchors: filled(m.remapAnchors, remapAnchors) }
}
