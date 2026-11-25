import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { chapterNames } from '../src/shared/chapters/names'
import { planOf, videoDuration } from '../src/shared/engine/freeze'
import { exportBaseName } from '../src/shared/import/imported'
import { NO_NAMES } from '../src/shared/privacy/detect/names'
import { detectSaid, saidBleeps } from '../src/shared/privacy/detect/said'
import { SAID_KINDS } from '../src/shared/privacy/kinds'
import { privateView } from '../src/shared/privacy/spoken'
import { outputChapters, youtubeChapters } from '../src/shared/render/chapters'
import { chapterParts, partFileNames } from '../src/shared/render/exportBundle'
import { batchFileNames, safeFileName } from '../src/shared/render/exportPresets'
import type { Project } from '../src/shared/types'
import { base, words } from './autoBlurFixtures'

/*
 * Auto-blur §7.5: what leaves Flown is named from the private view, as it is written from it. Review
 * findings [1], [9] and [19] of the second review: the export dialog's Copy chapters, the names of
 * one file per chapter (and so their thumbnails' and sidecars'), the batch's file names, the name
 * the save dialog suggests and the guide's file name came from the stored project, so a chapter
 * named before Find (Polish names chapters before its privacy step) or a name holding a code said
 * aloud left Flown as said.
 */

const saved: Record<string, unknown>[] = []
vi.stubGlobal('window', {
  api: {
    saveGuide: async (payload: Record<string, unknown>) => (saved.push(payload), { path: `/out/${String(payload.name)}.md`, bytes: 100 }),
    getBrandKit: async () => ({ colors: [], fonts: [], autoApply: false }),
    brandFile: async () => null
  }
})
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const GUIDE_RUN = '../src/renderer/src/guide/guideRun'
const { saveGuide } = (await import(/* @vite-ignore */ GUIDE_RUN)) as {
  saveGuide: (format: 'markdown', deps: { project: Project; steps: readonly unknown[]; images: ReadonlyMap<string, unknown>; scale: number; page: 'A4'; signal: AbortSignal }) => Promise<{ path: string } | null>
}

const CODE = /629153|629|153/

/** Captions where a login code is said, and the chapters Find chapters names from them before Find private info. */
function project(): Project {
  const s0 = words('s0', 0.5, 'Welcome to the setup of the new account.')
  const s1 = words('s1', 20.5, 'Your login code is 629153 so type it in now.')
  const p: Project = { ...base('codes', 40), transcript: { language: 'en', provider: 'local', model: 'm', createdAt: '2026-11-20T10:00:00.000Z', segments: [s0, s1] } }
  const names = chapterNames(p, [{ t: 0 }, { t: 20 }])
  return { ...p, chapters: names.map((n, i) => ({ id: `ch${i}`, t: i === 0 ? 0 : 20, title: n.title })) }
}

/** The project after Find private info listened: the code said aloud under a private bleep. */
function found(p: Project): Project {
  const hits = detectSaid(p.transcript, { kinds: SAID_KINDS, regions: ['US'], names: NO_NAMES })
  return { ...p, bleeps: saidBleeps(hits, p.bleeps, () => 0.42).bleeps }
}

describe('auto-blur §7.5: output names and Copy chapters from the private view', () => {
  it('Copy chapters, the files of one file per chapter, the batch files and the save dialog name hold no digit of a code said aloud; the parts keep their ranges', () => {
    const before = project()
    expect(before.chapters!.map((c) => c.title).join(' ')).toMatch(/629153/)
    const after = { ...found(before), name: 'Login code 629153 setup' }
    expect(after.bleeps!.length).toBeGreaterThan(0)
    const view = privateView(after)
    const plan = planOf(view)
    // Copy chapters: the YouTube timestamps the dialog copies.
    const copied = youtubeChapters(outputChapters(view.chapters ?? [], view.clips, plan), videoDuration(view.clips, plan)).text
    expect(copied).toContain('0:20 Your login code is •••••• so type it in')
    expect(copied).not.toMatch(CODE)
    // One file per chapter: the parts' names, and the same ranges as the stored chapters give.
    const parts = chapterParts(view)
    expect(parts.map((p) => [p.start, p.end, p.editStart])).toEqual(chapterParts(after).map((p) => [p.start, p.end, p.editStart]))
    const names = partFileNames(parts, 'mp4')
    expect(names).toHaveLength(2)
    for (const n of names) expect(n).not.toMatch(CODE)
    // The batch's file names and the name the save dialog suggests.
    expect(batchFileNames(view.name, [{ fileLabel: '1080p', options: { format: 'mp4' } as never }])[0]).toBe('Login code •••••• setup - 1080p.mp4')
    expect(safeFileName(exportBaseName(view))).toBe('Login code •••••• setup')
    // The stored texts stay as they were.
    expect(after.name).toBe('Login code 629153 setup')
    expect(after.chapters!.map((c) => c.title).join(' ')).toMatch(/629153/)
  })

  it('the export dialog takes Copy chapters, the parts, the batch names and the save name from the private view', () => {
    const dialog = fs.readFileSync(path.join(__dirname, '../src/renderer/src/editor/ExportDialog.tsx'), 'utf8')
    expect(dialog).toContain('const view = privateView(project)')
    expect(dialog).toContain('const chapters = useMemo(() => outputChapters(view.chapters ?? [], clips, plan), [view.chapters, clips, plan])')
    expect(dialog).toContain('const parts = useMemo(() => chapterParts(view), [view])')
    expect(dialog).toContain('const baseName = safeFileName(exportBaseName(view))')
    expect(dialog).toContain('const shownName = view.name')
    expect(dialog.match(/batchFileNames\(shownName, items\)/g)).toHaveLength(2)
    // Nothing named or copied from the stored texts.
    for (const stored of ['outputChapters(project.chapters', 'chapterParts(project)', 'exportBaseName(project)', 'batchFileNames(project.name']) expect(dialog).not.toContain(stored)
  })

  it("the guide is saved under the name of the private view: its title holding a code said aloud is masked, the stored title is not", async () => {
    const after = { ...found(project()), guide: { title: 'Enter code 629153', steps: [] } as unknown as Project['guide'] }
    saved.length = 0
    await saveGuide('markdown', { project: after, steps: [], images: new Map(), scale: 1, page: 'A4', signal: new AbortController().signal })
    expect(saved).toHaveLength(1)
    expect(saved[0].name).toBe('Enter code •••••• guide')
    expect(String(saved[0].markdown)).not.toMatch(CODE)
    expect(after.guide!.title).toBe('Enter code 629153')
  })
})
