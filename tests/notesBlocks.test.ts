import { describe, expect, it } from 'vitest'
import { countWords, readingLabel, readingSeconds, splitBlocks } from '../src/shared/notes/blocks'

describe('splitBlocks', () => {
  const text = 'Intro to the dashboard\n\n- Open Settings\n- Click Add user [wait]\n'

  it('makes paragraphs and bullets with words, gaps and cues', () => {
    const blocks = splitBlocks(text)
    expect(blocks).toHaveLength(3)
    expect(blocks.map((b) => b.kind)).toEqual(['para', 'bullet', 'bullet'])
    expect(blocks.map((b) => b.words)).toEqual([4, 2, 3])
    expect(blocks.map((b) => b.gapBefore)).toEqual([false, true, false])
    expect(blocks.map((b) => b.firstWord)).toEqual([0, 4, 6])
    expect(blocks.map((b) => b.index)).toEqual([0, 1, 2])
    expect(blocks[1].marker).toBe('-')
    expect(blocks[0].marker).toBe('')
    expect(blocks[2].runs).toContainEqual({ text: 'wait', cue: true })
    expect(blocks[2].runs.filter((r) => !r.cue).map((r) => r.text.trim())).toEqual(['Click Add user'])
  })

  it('reads CR LF and CR the same as LF', () => {
    expect(splitBlocks(text.replace(/\n/g, '\r\n'))).toEqual(splitBlocks(text))
    expect(splitBlocks(text.replace(/\n/g, '\r'))).toEqual(splitBlocks(text))
  })

  it('has no blocks for white space only', () => {
    expect(splitBlocks('   \n\n')).toEqual([])
    expect(splitBlocks('')).toEqual([])
  })

  it('knows every bullet marker and keeps it as typed', () => {
    const blocks = splitBlocks('* one\n• two\n2. three\n3) four\n-not a bullet\n12.5 percent')
    expect(blocks.map((b) => b.kind)).toEqual(['bullet', 'bullet', 'bullet', 'bullet', 'para', 'para'])
    expect(blocks.map((b) => b.marker)).toEqual(['*', '•', '2.', '3)', '', ''])
    expect(blocks.slice(0, 4).map((b) => b.words)).toEqual([1, 1, 1, 1])
  })

  it('counts a cue-only line as no words and keeps an unclosed bracket as text', () => {
    const [cue, open] = splitBlocks('[click Export]\nPress [ to start')
    expect(cue.words).toBe(0)
    expect(cue.runs).toEqual([{ text: 'click Export', cue: true }])
    expect(open.runs).toEqual([{ text: 'Press [ to start', cue: false }])
    expect(open.words).toBe(3)
  })

  it('keeps markup as literal text', () => {
    const [b] = splitBlocks('<b>x</b>')
    expect(b.runs).toEqual([{ text: '<b>x</b>', cue: false }])
  })

  it('splits 50,000 characters quickly', () => {
    const line = 'Open the settings and click Add user. [pause]\n'
    const big = line.repeat(Math.ceil(50_000 / line.length)).slice(0, 50_000)
    splitBlocks(big.slice(0, 1000))
    const t = performance.now()
    const blocks = splitBlocks(big)
    const ms = performance.now() - t
    expect(blocks.length).toBeGreaterThan(1000)
    expect(ms).toBeLessThan(30)
  })
})

describe('countWords', () => {
  it('counts languages written without spaces', () => {
    expect(countWords('設定を開きます')).toBeGreaterThan(1)
  })

  it('leaves out cues and bullet markers', () => {
    expect(countWords('- Open Settings [wait]\n1. Click Save')).toBe(4)
    expect(countWords('Intro to the dashboard\n\n- Open Settings\n- Click Add user [wait]\n')).toBe(9)
  })
})

describe('reading time', () => {
  it('is words over speed', () => {
    expect(readingSeconds(312, 130)).toBe(144)
    expect(readingSeconds(0, 130)).toBe(0)
  })

  it('reads as a rounded label', () => {
    expect(readingLabel(144)).toBe('about 2 min 24 s')
    expect(readingLabel(45)).toBe('about 45 s')
    expect(readingLabel(3900)).toBe('about 1 h 5 min')
    expect(readingLabel(120)).toBe('about 2 min')
    expect(readingLabel(44.6)).toBe('about 45 s')
  })
})
