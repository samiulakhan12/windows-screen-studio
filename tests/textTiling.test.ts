/**
 * Tests 36 and 117 (its TextTiling part) of docs/design/smart-tools.md §22.1: topic shifts score by
 * TextTiling's own depth, so a three-topic narration splits at its true boundaries and a one-topic
 * narration's shallow valleys score low (§7.3: the 0.5 of `2 × min(1, depth ÷ 0.5)`).
 */
import { describe, expect, it } from 'vitest'
import { CHAPTER_RULES, textTiling, topicCandidates, topicScore } from '../src/shared/chapters/signals'
import { sentencesOf } from '../src/shared/editor/retakes'
import { transcriptWords } from '../src/shared/editor/transcript'
import { chapterProject, oneTopic, threeTopics } from './chapterFixtures'

const wordsOf = (said: { t: number; text: string }[], duration: number) => transcriptWords(chapterProject({ duration, said }).transcript)

describe('TextTiling (test 36)', () => {
  it('finds the two boundaries of three topics of 300 words, within one sentence of the true ones, each scoring at least 1.5', () => {
    const { said, duration, boundaries } = threeTopics()
    const words = wordsOf(said, duration)
    expect(words).toHaveLength(900)
    const found = textTiling(words)
    expect(found).toHaveLength(2)
    const starts = said.map((s) => s.t)
    found.forEach((b, i) => {
      // Within one sentence of the true boundary.
      const truth = starts.indexOf(boundaries[i])
      const at = starts.findIndex((_, k) => k + 1 >= starts.length || starts[k + 1] > b.t + 1e-9)
      expect(Math.abs(at - truth)).toBeLessThanOrEqual(1)
      expect(topicScore(b.depth)).toBeGreaterThanOrEqual(1.5)
    })
    // As candidates, at sentence starts.
    const sentenceStarts = sentencesOf(words).map(([a]) => words[a].start)
    const cands = topicCandidates(words, sentenceStarts)
    expect(cands).toHaveLength(2)
    for (const c of cands) {
      expect(sentenceStarts).toContain(c.t)
      expect(c.from).toEqual(['topic'])
      expect(c.score).toBeGreaterThanOrEqual(1.5)
    }
  })

  it('the score is 2 × min(1, depth ÷ 0.5)', () => {
    expect(CHAPTER_RULES.topicDepth).toBe(0.5)
    expect(topicScore(0.25)).toBe(1)
    expect(topicScore(0.5)).toBe(2)
    expect(topicScore(1.6)).toBe(2)
    expect(topicScore(0)).toBe(0)
  })

  it('too few words for a block on each side: no boundary', () => {
    expect(textTiling([])).toEqual([])
    const { said } = threeTopics()
    expect(textTiling(wordsOf(said.slice(0, 6), 60))).toEqual([])
  })
})

describe('one topic (test 117)', () => {
  it('no valley of a one-topic narration scores above 1', () => {
    const { said, duration } = oneTopic()
    const words = wordsOf(said, duration)
    expect(said).toHaveLength(60)
    for (const b of textTiling(words)) expect(topicScore(b.depth), `at ${b.t}`).toBeLessThanOrEqual(1)
  })
})
