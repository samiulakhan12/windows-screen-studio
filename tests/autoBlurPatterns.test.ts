import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detectFrame } from '../src/shared/privacy/detect/detect'
import { compileNames } from '../src/shared/privacy/detect/names'
import { everyPattern } from '../src/shared/privacy/detect/tables'
import { lineWindows, WINDOW, WINDOW_STEP } from '../src/shared/privacy/detect/windows'
import { PRIVATE_KINDS } from '../src/shared/privacy/kinds'
import { line, ROOT } from './autoBlurRulesFixtures'

/*
 * Auto-blur P3: the patterns of the text rules cannot run away (docs/design/auto-blur.md §10.3,
 * tests 104 and 224). The rules worker's time limit is the guarantee; these keep the patterns from
 * needing it.
 */

/** 64 KB built from a repeated unit: runs that make a backtracking pattern slow. */
const fill = (unit: string): string => unit.repeat(Math.ceil(65536 / unit.length)).slice(0, 65536)
const ADVERSARIAL = [
  'a', '0', ' ', 'a ', '1 ', '1-', 'a.', 'a@', '@a.', 'aA0_-', 'eyJa.', 'sk-', 'sk-proj-a', 'a/', '?token=a', 'password: ', 'code 1 ', 'ক', '•', 'x=', 'A-', '+1 ',
  'a-1 ', 'https://a.b/', 'Ab1/+=', 'aa.aa.', 'a,', 'gh_', 'AKIA', '1.1.', 'BEGIN ', 'API key ', '00', 'xoxb-', 'a\t', '(1) ', 'Recovery codes '
].map(fill)

describe('auto-blur P3: patterns', () => {
  it('104. every pattern runs in under 50 ms on 64 KB adversarial strings; lines are matched in windows of 512 characters overlapping by 256', () => {
    // The windows: 512 characters, starting every 256, the last reaching the end; a short line is one window.
    const windows = lineWindows(ADVERSARIAL[0])
    expect(WINDOW).toBe(512)
    expect(WINDOW_STEP).toBe(256)
    expect(windows.every((w, i) => w.start === i * 256 && w.text.length <= 512)).toBe(true)
    expect(windows[windows.length - 1].start + windows[windows.length - 1].text.length).toBe(65536)
    expect(windows.length).toBe(255)
    expect(lineWindows('short')).toEqual([{ start: 0, text: 'short' }])
    const patterns = everyPattern()
    expect(patterns.length).toBeGreaterThan(150)
    const slow: string[] = []
    for (const s of ADVERSARIAL) {
      const ws = lineWindows(s)
      for (const { name, pattern } of patterns) {
        const t0 = performance.now()
        for (const w of ws) {
          if (pattern.global) for (const m of w.text.matchAll(pattern)) void m
          else pattern.test(w.text)
        }
        const ms = performance.now() - t0
        if (ms >= 50) slow.push(`${name} on ${JSON.stringify(s.slice(0, 8))}: ${ms.toFixed(1)} ms`)
      }
    }
    expect(slow).toEqual([])
    // A whole frame of one such line stays far inside the rules worker's 2 s a read (§10.3).
    const names = compileNames(['Riad Hasan', 'Acme*'], ['Flown'])
    for (const s of ADVERSARIAL.slice(0, 12)) {
      const t0 = performance.now()
      detectFrame([line(s, 0, 0, { charW: 0.02 })], [], { kinds: PRIVATE_KINDS, regions: ['US', 'BD'], names, frame: { width: 1920, height: 1080 } })
      expect(performance.now() - t0, JSON.stringify(s.slice(0, 8))).toBeLessThan(2000)
    }
  }, 120_000)

  it('224. regexCheck.mjs refuses (a+)+, (a|a)* and (\\w+\\s?)* and passes every pattern of detect/tables.ts', async () => {
    const { checkPattern } = (await import(pathToFileURL(path.join(ROOT, 'scripts', 'privacy', 'regexCheck.mjs')).href)) as { checkPattern(p: RegExp | string, flags?: string): string[] }
    expect(checkPattern('(a+)+')).toEqual(['nested unbounded quantifiers'])
    expect(checkPattern('(a|a)*')).toEqual(['a quantified alternation whose branches can match the same text'])
    expect(checkPattern('(\\w+\\s?)*')).toEqual(['nested unbounded quantifiers'])
    // Overlap is judged on the branches' first characters, and an empty branch overlaps everything.
    expect(checkPattern('(?:ab|ac)+')).toEqual(['a quantified alternation whose branches can match the same text'])
    expect(checkPattern('(?:a|)*')).toEqual(['a quantified alternation whose branches can match the same text'])
    expect(checkPattern(/(?:\d+[,.])+$/)).toEqual(['nested unbounded quantifiers'])
    // Bounded repetition, separated groups and distinct branches pass.
    for (const ok of ['(?:[A-Z0-9]{1,12}\\s{1,4}){0,3}', '(?:ab|cd)*', '[a-z]+@[a-z]+', '(?:[^;\\\\]|\\\\.){1,512}', '^(?:x|y)$']) expect(checkPattern(ok), ok).toEqual([])
    const bad = everyPattern()
      .map(({ name, pattern }) => ({ name, problems: checkPattern(pattern) }))
      .filter((x) => x.problems.length)
    expect(bad).toEqual([])
  })
})
