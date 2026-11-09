/**
 * Recordings for the chapter tests (docs/design/smart-tools.md §7, §22.1 tests 35-48 and 115-121):
 * projects with a transcript laid out sentence by sentence, scans with page changes, and the
 * narrated fixtures of tests 36 and 117 (three topics; one topic with cue words after pauses).
 */
import type { SceneScan } from '../src/shared/api/projects'
import { createProject } from '../src/shared/engine/project'
import type { CaptionSegment, Chapter, CursorTrack, Project, TitleCard } from '../src/shared/types'

/** Seconds a word lasts, and between two words of a sentence. */
export const WORD = 0.3
export const WORD_GAP = 0.05

/** A sentence said at `t`: its words one after another, 0.35 s apart. */
export interface Said {
  t: number
  text: string
}

/** One caption per sentence, with word timings. */
export function segmentsOf(said: readonly Said[]): CaptionSegment[] {
  return said.map((s, i) => {
    const texts = s.text.split(/\s+/).filter(Boolean)
    const words = texts.map((text, k) => ({ text, start: +(s.t + k * (WORD + WORD_GAP)).toFixed(4), end: +(s.t + k * (WORD + WORD_GAP) + WORD).toFixed(4) }))
    return { id: `s${i + 1}`, start: s.t, end: words[words.length - 1].end, text: s.text, words }
  })
}

/** When a sentence of `text` said at `t` ends. */
export const endOf = (t: number, text: string): number => t + text.split(/\s+/).filter(Boolean).length * (WORD + WORD_GAP) - WORD_GAP

/** A project `duration` seconds long, with a transcript when `said` is given. */
export function chapterProject(opts: { duration: number; said?: readonly Said[]; language?: string; chapters?: Chapter[]; titles?: TitleCard[]; fps?: number }): Project {
  const p = createProject({
    id: 'chap',
    name: 'Billing walkthrough',
    duration: opts.duration,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: opts.fps ?? 30 }
  })
  return {
    ...p,
    createdAt: '2026-11-01T00:00:00.000Z',
    chapters: opts.chapters ?? [],
    titles: opts.titles ?? [],
    ...(opts.said ? { transcript: { language: opts.language ?? 'en', provider: 'local' as const, model: 'test', createdAt: '2026-11-01T00:00:00.000Z', segments: segmentsOf(opts.said) } } : {})
  }
}

/** A scan at 0.25 s over `seconds`, nothing changing but `at` (time → changed share). */
export function scanOf(seconds: number, at: Record<number, number> = {}, step = 0.25): SceneScan {
  const t: number[] = []
  const changed: number[] = []
  for (let i = 1; i * step <= seconds + 1e-9; i++) {
    const time = +(i * step).toFixed(3)
    t.push(time)
    changed.push(at[time] ?? 0)
  }
  return { step, t, changed, stills: [] }
}

/** A track with input at each of `busy` (clicks) and nothing else: idle between them. */
export function trackOf(busy: readonly number[]): CursorTrack {
  return { samples: [], clicks: busy.map((t) => ({ t, x: 0.5, y: 0.5, button: 'left' as const })), keys: [], typing: [], scrolls: [], valid: true }
}

/** A seeded random number generator (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Sentences about one thing: setting up billing in an app. */
const BILLING = [
  'open the billing page from the account menu',
  'the billing page shows your plan and your invoices',
  'each invoice lists the plan the seats and the total',
  'you can download an invoice as a file for your records',
  'the payment method sits under the plan on the billing page',
  'change the payment method when your card expires',
  'the plan decides how many seats your team can use',
  'add seats to the plan when your team grows',
  'every invoice is sent to the billing email of the account',
  'the billing email can be changed on the same page',
  'taxes are added to each invoice from your billing address',
  'keep the billing address right so invoices show the right tax',
  'the next invoice date is shown beside the plan',
  'a yearly plan gives a lower price for each seat',
  'switching the plan changes the next invoice',
  'the invoice history keeps every invoice of the account',
  'a failed payment shows a notice on the billing page',
  'retry the payment once the card is fixed',
  'the billing page also shows credits on the account',
  'credits are taken off the next invoice first'
]

/**
 * Test 117: a 5-minute narration of one topic, 60 sentences; every third starts with "Now", "So" or
 * "Let's" after a 2.2 s pause (the others 0.5 s after the one before). No screen change.
 */
export function oneTopic(): { said: Said[]; duration: number } {
  const said: Said[] = []
  const leads = ['Now', 'So', "Let's"]
  let t = 1
  for (let i = 0; i < 60; i++) {
    const body = BILLING[i % BILLING.length]
    const cue = i > 0 && i % 3 === 0
    if (i > 0) t += cue ? 2.2 : 0.5
    const sentence = cue ? `${leads[(i / 3) % 3]} ${body}.` : `${body.charAt(0).toUpperCase()}${body.slice(1)}.`
    said.push({ t: +t.toFixed(3), text: sentence })
    t = endOf(t, sentence)
  }
  return { said, duration: 300 }
}

const GARDEN = ['tomatoes', 'soil', 'compost', 'seedlings', 'watering', 'roots', 'leaves', 'garden', 'mulch', 'pruning', 'sunlight', 'harvest', 'beds', 'weeds', 'fertiliser']
const STARS = ['telescope', 'galaxy', 'planets', 'orbit', 'nebula', 'comet', 'jupiter', 'saturn', 'eclipse', 'lens', 'astronomy', 'meteor', 'constellation', 'asteroid', 'starlight']
const MONEY = ['invoice', 'billing', 'payment', 'seats', 'plan', 'credits', 'taxes', 'refund', 'receipt', 'subscription', 'pricing', 'discount', 'account', 'statement', 'charges']
const GLUE = ['the', 'and', 'with', 'of', 'for', 'in', 'to', 'we', 'is', 'a']

/**
 * Test 36: three topics of 300 words each (sentences of 10 words: 6 of the topic's own words among
 * stop words), with the sentence starts where each topic begins.
 */
export function threeTopics(): { said: Said[]; duration: number; boundaries: number[] } {
  const rand = seeded(36)
  const said: Said[] = []
  const boundaries: number[] = []
  let t = 1
  ;[MONEY, GARDEN, STARS].forEach((topic, k) => {
    for (let s = 0; s < 30; s++) {
      if (s === 0 && k > 0) boundaries.push(+t.toFixed(3))
      const words: string[] = []
      for (let w = 0; w < 10; w++) words.push(w % 5 === 1 || w % 5 === 3 ? GLUE[Math.floor(rand() * GLUE.length)] : topic[Math.floor(rand() * topic.length)])
      const text = `${words.join(' ')}.`
      said.push({ t: +t.toFixed(3), text })
      t = endOf(t, text) + 0.5
    }
  })
  return { said, duration: Math.ceil(t + 2), boundaries }
}
