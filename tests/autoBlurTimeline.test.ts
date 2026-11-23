import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { TimelineRequest } from '../src/shared/api/export'
import type { Project } from '../src/shared/types'
import { t } from '../src/shared/i18n/t'
import { recordingsTimeline } from '../src/shared/interchange/timelinePlan'
import { normalizeBundle } from '../src/shared/render/exportBundle'
import { normalizeOptions } from '../src/shared/render/exportPresets'
import { base, coverOf, key } from './autoBlurFixtures'

/*
 * The raw recordings never leave through a timeline while the video hides part of them
 * (docs/design/auto-blur.md §9 row 10, §0 decision 4; §17.1 test 25), in main and in the renderer.
 */

const h = vi.hoisted(() => ({ exported: new Set<string>(), projects: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: () => undefined }, app: { getPath: () => tmpdir(), on: vi.fn() } }))
vi.mock('../src/main/exportIpc', () => ({ isExportedFile: (f: string) => h.exported.has(f), onExportCancel: () => undefined }))
vi.mock('../src/main/projects', async (orig) => ({ ...(await orig<object>()), projectDir: (id: string) => path.join(h.projects, id) }))
vi.mock('../src/main/voice/voiceIpc', () => ({ voiceCleaner: { ensure: vi.fn() } }))

const { writeTimeline } = await import('../src/main/timelineIpc')
const { projectFileText } = await import('../src/main/projectFile')

const root = mkdtempSync(path.join(tmpdir(), 'flown-autoblur-timeline-'))
h.projects = path.join(root, 'projects')
afterAll(() => rmSync(root, { recursive: true, force: true }))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const RUN = '../src/renderer/src/editor/timelineRun'
const BUNDLE = '../src/renderer/src/editor/exportBundleRun'
const OPTIONS = '../src/renderer/src/editor/ExportBundleOptions'

const blur = { id: 'h', start: 1, end: 3, kind: 'blur' as const, x: 0.5, y: 0.5, w: 0.2, h: 0.1, color: '#000000', strokeWidth: 4, fill: true, opacity: 1, strength: 0.5 }
const SCREEN = { fps: 30, frames: 60, width: 320, height: 240, audio: false, video: true }

function request(p: Project): TimelineRequest {
  const video = path.join(root, 'out', `${p.id}.mp4`)
  h.exported.add(video)
  return { projectId: p.id, videoPath: video, editors: ['premiere'], media: 'recordings', stems: [], plan: recordingsTimeline(p, 30, { screen: SCREEN }) }
}

/** Main's deps that fail the test if anything past the refusal runs (a probe, a copy). */
const untouched = {
  probe: async () => {
    throw new Error('probed')
  },
  ffmpeg: async () => {
    throw new Error('copied')
  }
}

describe('auto-blur contracts: the timeline', () => {
  it("25. The timeline refusal: writeTimeline in recordings mode reads project.json with a cover, a blur shape or a bleep and refuses with errors.timeline.hidden, writing nothing, whatever the request says; 'recordings' choices normalise unchanged; writeTimelineStep skips the step and says so; the chip is disabled with its description; the dialog's flush runs before writeTimeline", async () => {
    const plain = { ...base('p25plain', 2), createdAt: '2026-11-20T10:00:00.000Z' }
    const hiding: Project[] = [
      { ...plain, id: 'p25cover', covers: [coverOf('c', 0.5, 1.5, [key(0.5, 0.1, 0.1, 0.2, 0.1)])] },
      { ...plain, id: 'p25blur', shapes: [blur] },
      { ...plain, id: 'p25bleep', bleeps: [{ id: 'b', start: 0.5, end: 0.9, word: 'x', sound: 'tone' }] }
    ]
    for (const p of hiding) {
      // Main reads the project.json beside the recordings itself; the request carries no say in it.
      mkdirSync(path.join(h.projects, p.id), { recursive: true })
      writeFileSync(path.join(h.projects, p.id, 'project.json'), projectFileText(p))
      const result = await writeTimeline(request(p), untouched as never)
      expect(result, p.id).toEqual({ files: [], problem: t('errors.timeline.hidden') })
    }
    // The question 18 default (b): a crop or a muted part alone hides nothing, so the request goes on (to the media checks).
    for (const p of [{ ...plain, id: 'p25crop', crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }, { ...plain, id: 'p25muted', audio: { ...plain.audio, muted: true } }]) {
      mkdirSync(path.join(h.projects, p.id), { recursive: true })
      writeFileSync(path.join(h.projects, p.id, 'project.json'), projectFileText(p))
      expect((await writeTimeline(request(p), untouched as never)).problem, p.id).not.toBe(t('errors.timeline.hidden'))
    }
    // An unreadable project.json is refused too.
    expect((await writeTimeline(request({ ...plain, id: 'p25gone' }), untouched as never)).problem).toBe(t('errors.timeline.media'))
    // Saved choices of the recordings read as they were.
    const bundle = { srt: false, vtt: false, chapters: false, thumbnail: false, description: false, perChapter: false, timelines: ['premiere'], timelineMedia: 'recordings' }
    expect(normalizeBundle(structuredClone(bundle))).toEqual(bundle)
    // A preset's bundle reads through normalizeBundle too (userPresets.ts presetBundle): read again, still the recordings.
    expect(normalizeBundle(normalizeBundle(structuredClone(bundle)))).toEqual(bundle)

    // The renderer: the step is skipped and says so, and main is never asked.
    const { writeTimelineStep } = (await import(/* @vite-ignore */ RUN)) as { writeTimelineStep(p: Project, r: Omit<TimelineRequest, 'plan'>, e: unknown, d?: unknown): Promise<{ files: unknown[]; problem?: string }> }
    const asked: unknown[] = []
    const write = async (r: unknown) => (asked.push(r), { files: [] })
    const { plan: _plan, ...asking } = request(hiding[0])
    void _plan
    expect(await writeTimelineStep(hiding[0], asking, { fps: 30, frames: 60, width: 320, height: 240 }, { write })).toEqual({ files: [], problem: t('privacy.export.recordingsSkipped') })
    expect(asked).toEqual([])

    // The chip: disabled, described by why.
    const { ExportBundleOptions } = (await import(/* @vite-ignore */ OPTIONS)) as { ExportBundleOptions: (props: Record<string, unknown>) => JSX.Element }
    const props = (hides: boolean): Record<string, unknown> => ({
      value: bundle,
      onChange: () => undefined,
      format: 'mp4',
      has: { captions: false, chapters: false },
      mode: 'single',
      chapterCount: 0,
      alsoSave: { options: normalizeOptions({}), hasSound: true, stems: [], seconds: 2, notEvened: false, hides }
    })
    const off = renderToStaticMarkup(React.createElement(ExportBundleOptions as never, props(true)))
    expect(off).toMatch(/<input[^>]*value="recordings"[^>]*disabled=""[^>]*aria-describedby="export-recordings-off"|<input[^>]*disabled=""[^>]*aria-describedby="export-recordings-off"[^>]*value="recordings"|<input[^>]*aria-describedby="export-recordings-off"[^>]*disabled=""/)
    expect(off).toContain('id="export-recordings-off"')
    const on = renderToStaticMarkup(React.createElement(ExportBundleOptions as never, props(false)))
    expect(on).not.toContain('export-recordings-off')

    // The export dialog's flush writes project.json before main is asked for the timeline.
    const order: string[] = []
    const g = globalThis as unknown as { window?: unknown }
    const had = g.window
    g.window = { api: { writeTimeline: async () => (order.push('writeTimeline'), { files: [] }), exportCancel: () => undefined, writeSidecar: async () => '' } }
    try {
      const { writeBundle } = (await import(/* @vite-ignore */ BUNDLE)) as { writeBundle(anchor: string, req: unknown): Promise<unknown> }
      await writeBundle(path.join(root, 'out', 'x.mp4'), {
        project: plain,
        kinds: [],
        title: 'x',
        thumbnail: async () => new Uint8Array(),
        timeline: { request: { projectId: plain.id, videoPath: path.join(root, 'out', 'x.mp4'), editors: ['premiere'], media: 'export', stems: [] }, exported: { fps: 30, frames: 60, width: 320, height: 240 } },
        flush: () => order.push('flush')
      })
    } finally {
      g.window = had
    }
    expect(order).toEqual(['flush', 'writeTimeline'])
  })
})
