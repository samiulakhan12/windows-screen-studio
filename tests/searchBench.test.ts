/**
 * Search for 500 recordings (docs/design/search.md §8): build, file size, load and query times on
 * synthetic projects. The limits are generous (machine load varies); the measured numbers are
 * printed for BUILD-REPORT-search.md.
 */
import { describe, expect, it } from 'vitest'
import { SearchIndex } from '../src/shared/search/engine'
import { indexedProject } from '../src/shared/search/extract'
import { parseIndexFile, serializeIndex } from '../src/shared/search/indexFile'
import type { IndexedProject } from '../src/shared/search/types'

const RECORDINGS = 500

/** A deterministic pseudo-random sequence. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const SYLLABLES = ['ka', 'ri', 'to', 'men', 'sa', 'lo', 'vi', 'den', 'por', 'tu', 'ne', 'shi', 'ab', 'ul', 'ter', 'on']
const BANGLA = ['আমি', 'বাংলায়', 'কথা', 'বলি', 'ভিডিও', 'রেকর্ড', 'সেটিংস', 'খুলুন', 'তারপর', 'ক্লিক', 'করুন', 'দেখুন', 'নতুন', 'ফাইল', 'সংরক্ষণ']

/** 6,000 words: mostly made-up English-like words, some Bangla, Zipf-like use. */
function vocabulary(next: () => number): string[] {
  const words = new Set<string>(['settings', 'open', 'click', 'save', 'export', 'record', 'project', 'customer', 'invoice', 'dashboard'])
  while (words.size < 5900) {
    let w = ''
    const n = 1 + Math.floor(next() * 4)
    for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(next() * SYLLABLES.length)]
    words.add(w)
  }
  for (const b of BANGLA) words.add(b)
  for (let i = 0; words.size < 6000; i++) words.add(`${BANGLA[i % BANGLA.length]}${SYLLABLES[i % SYLLABLES.length]}`)
  return [...words]
}

function syntheticProject(i: number, words: string[], next: () => number): Record<string, unknown> {
  const word = (): string => words[Math.floor(words.length * next() ** 2.2)]
  const sentence = (n: number): string => Array.from({ length: n }, word).join(' ')
  const segments = Array.from({ length: 70 }, (_, k) => ({ id: `s${k}`, start: k * 4.3, end: k * 4.3 + 4, text: `${sentence(11)}.` }))
  return {
    version: 2,
    id: `rec-${i}`,
    name: `Recording ${i} ${sentence(2)}`,
    createdAt: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
    duration: 300,
    clips: [{ id: 'c', start: 0, end: 300, speed: 1 }],
    chapters: Array.from({ length: 5 }, (_, k) => ({ id: `c${k}`, t: k * 60, title: sentence(3) })),
    titles: Array.from({ length: 3 }, (_, k) => ({ id: `t${k}`, start: k * 100, end: k * 100 + 4, title: sentence(3), subtitle: sentence(4), style: 'centered', background: 'blur' })),
    annotations: Array.from({ length: 4 }, (_, k) => ({ id: `a${k}`, start: k * 70, end: k * 70 + 5, text: sentence(4) })),
    transcript: { provider: 'local', model: 'x', createdAt: '', segments },
    script: { text: Array.from({ length: 8 }, () => sentence(14)).join('\n') }
  }
}

const ms = (start: number): number => Math.round((performance.now() - start) * 10) / 10

describe('search with 500 recordings', () => {
  it('builds, stores, loads and answers within the limits', () => {
    const next = rng(42)
    const words = vocabulary(next)
    const projects = Array.from({ length: RECORDINGS }, (_, i) => syntheticProject(i, words, next))
    const json = projects.map((p) => JSON.stringify(p))
    const projectBytes = json.reduce((n, s) => n + Buffer.byteLength(s), 0)

    // Parse + extract + index, as the first build does (reading the files aside).
    let t = performance.now()
    const index = new SearchIndex()
    const entries = new Map<string, IndexedProject>()
    let slowest = 0
    json.forEach((text, i) => {
      const one = performance.now()
      const entry = indexedProject(JSON.parse(text), `${i}:1`)
      if (!entry) throw new Error('not a project')
      entries.set(`rec-${i}`, entry)
      index.add(`rec-${i}`, entry)
      slowest = Math.max(slowest, performance.now() - one)
    })
    const buildMs = ms(t)

    t = performance.now()
    const file = serializeIndex(entries)
    const writeMs = ms(t)
    const fileBytes = Buffer.byteLength(file)

    // Load: parse the file and make the terms again.
    const gc = (globalThis as { gc?: () => void }).gc
    gc?.()
    const heapBefore = process.memoryUsage().heapUsed
    t = performance.now()
    const loaded = parseIndexFile(JSON.parse(file))
    const again = new SearchIndex()
    for (const [id, e] of loaded) again.add(id, e)
    const loadMs = ms(t)
    expect(again.size).toBe(RECORDINGS)
    gc?.()
    // The loaded index's own memory (only with node --expose-gc; else the heap as a whole).
    const indexMB = gc ? Math.round((process.memoryUsage().heapUsed - heapBefore) / 1e6) : null

    const queries = ['settings', 'setings', 'open settings', 'sett', 'customer invoice', 'বাংলা', 'ভিডিও রেকর্ড', 'kariton', 'dashbord export', 'zzzzqqq']
    const times: Record<string, number> = {}
    for (const q of queries) {
      again.search(q) // warm
      const start = performance.now()
      const runs = 5
      for (let r = 0; r < runs; r++) again.search(q)
      times[q] = Math.round(((performance.now() - start) / runs) * 10) / 10
    }

    console.log(
      JSON.stringify(
        {
          recordings: RECORDINGS,
          projectJsonMB: +(projectBytes / 1e6).toFixed(1),
          buildMs,
          slowestProjectMs: Math.round(slowest * 10) / 10,
          serializeMs: writeMs,
          indexFileMB: +(fileBytes / 1e6).toFixed(2),
          loadMs,
          queryMs: times,
          indexHeapMB: indexMB
        },
        null,
        1
      )
    )

    expect(again.search('settings').length).toBeGreaterThan(0)
    expect(again.search('বাংলা').length).toBeGreaterThan(0)
    expect(buildMs).toBeLessThan(10_000)
    expect(loadMs).toBeLessThan(10_000)
    expect(fileBytes).toBeLessThan(15e6)
    for (const q of queries) expect(times[q]).toBeLessThan(200)
  }, 60_000)
})
