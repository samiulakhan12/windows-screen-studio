// A project's files and the work that reads them: the ffmpeg analyses (smart speed's still
// detection, sound levels) stop before the project is deleted and when its editor closes; a
// project whose microphone or system sound file is missing opens with its mixed sound, and
// keeps its stems for when the file is back.
import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  spawned: [] as ChildProcess[]
}))
h.root = mkdtempSync(path.join(tmpdir(), 'ssw-project-files-'))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawn = (...args: Parameters<typeof actual.spawn>): ChildProcess => {
    const proc = actual.spawn(...args)
    h.spawned.push(proc)
    return proc
  }
  return { ...actual, spawn, default: { ...actual, spawn } }
})

vi.mock('electron', () => ({
  app: { getPath: (name: string) => require('node:path').join(h.root, name), on: () => undefined },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn), on: () => undefined },
  dialog: {},
  shell: {},
  protocol: {},
  BrowserWindow: class {}
}))

// An "ffmpeg" that reads nothing and never finishes: an analysis of a long recording.
const fakeFfmpeg = path.join(h.root, 'slow-ffmpeg.sh')
vi.mock('../src/main/ffmpeg', async (importOriginal) => ({ ...(await importOriginal<object>()), ffmpegPath: () => fakeFfmpeg }))

const { registerAnalysisIpc, detectStill, stopAnalyses } = await import('../src/main/analysisIpc')
const { analyzeAudio } = await import('../src/main/audioAnalysis')
const { registerProjectsIpc, missingStems } = await import('../src/main/projectsIpc')
const { projectDir } = await import('../src/main/projects')
const { createProject } = await import('../src/shared/engine/project')
const { openedWithoutStems, recordingMix, stemsOf, withRecordedStems } = await import('../src/shared/audio/settings')
type LoadedProject = import('../src/shared/api/projects').LoadedProject
type Project = import('../src/shared/types').Project

beforeAll(() => {
  writeFileSync(fakeFfmpeg, '#!/bin/sh\nexec sleep 60\n')
  chmodSync(fakeFfmpeg, 0o755)
  registerAnalysisIpc()
  registerProjectsIpc()
})

afterAll(async () => {
  for (const p of h.spawned) p.kill('SIGKILL')
  rmSync(h.root, { recursive: true, force: true })
})

function seed(id: string): string {
  const dir = projectDir(id)
  mkdirSync(dir, { recursive: true })
  for (const f of ['screen.mp4', 'mic.m4a', 'system.m4a']) writeFileSync(path.join(dir, f), 'media')
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ duration: 30 }))
  return dir
}

const running = (p: ChildProcess): boolean => p.exitCode === null && p.signalCode === null
const settled = <T>(p: Promise<T>): Promise<{ ok: boolean; error?: string }> =>
  p.then(
    () => ({ ok: true }),
    (e: Error) => ({ ok: false, error: e.message })
  )
async function spawnedSoon(count: number): Promise<void> {
  for (let i = 0; i < 200 && h.spawned.length < count; i++) await new Promise((r) => setTimeout(r, 10))
  expect(h.spawned).toHaveLength(count)
}

describe('analyses reading a project', () => {
  it('stop before the project is deleted, so no ffmpeg holds its files; other projects keep theirs', async () => {
    const dir = seed('rec-delete')
    seed('rec-other')
    const still = settled(detectStill('rec-delete', 3))
    const levels = settled(analyzeAudio('rec-delete', ['mic']))
    const other = settled(detectStill('rec-other', 3))
    await spawnedSoon(3)
    // Which process reads what (they start in whatever order their file checks finish).
    const reading = (id: string, file: string): ChildProcess => h.spawned.find((p) => p.spawnargs.includes(path.join(projectDir(id), file)))!
    const stillProc = reading('rec-delete', 'screen.mp4')
    const levelsProc = reading('rec-delete', 'mic.m4a')
    const otherProc = reading('rec-other', 'screen.mp4')
    expect(new Set([stillProc, levelsProc, otherProc]).size).toBe(3)
    await h.handlers.get('projects:delete')!(null, 'rec-delete')
    // Both analyses of the project had exited when its folder was deleted.
    expect(running(stillProc)).toBe(false)
    expect(running(levelsProc)).toBe(false)
    expect(existsSync(dir)).toBe(false)
    expect(await still).toEqual({ ok: false, error: 'the analysis was stopped' })
    expect(await levels).toEqual({ ok: false, error: 'The sound measurement was stopped.' })
    expect(running(otherProc)).toBe(true)
    await stopAnalyses('rec-other')
    expect((await other).ok).toBe(false)
  })

  it('stop when the editor closes; opening it again analyses again', async () => {
    seed('rec-close')
    const before = h.spawned.length
    const still = settled(detectStill('rec-close', 3))
    await spawnedSoon(before + 1)
    await h.handlers.get('projects:stopAnalysis')!(null, 'rec-close')
    expect(running(h.spawned[before])).toBe(false)
    expect(await still).toEqual({ ok: false, error: 'the analysis was stopped' })
    // A failed (stopped) analysis is not kept: the next request runs it again.
    const again = settled(detectStill('rec-close', 3))
    await spawnedSoon(before + 2)
    expect(running(h.spawned[before + 1])).toBe(true)
    await stopAnalyses('rec-close')
    expect((await again).ok).toBe(false)
  })

  it('a request already under way when its project stops starts no ffmpeg', async () => {
    seed('rec-race')
    const before = h.spawned.length
    // Both look at the files first (asynchronously); the stop comes in meanwhile.
    const still = settled(detectStill('rec-race', 3))
    const levels = settled(analyzeAudio('rec-race', ['mix', 'mic']))
    await stopAnalyses('rec-race')
    expect(await still).toEqual({ ok: false, error: 'the analysis was stopped' })
    expect((await levels).ok).toBe(false)
    expect(h.spawned.length).toBe(before)
  })
})

describe('a project whose microphone or system sound file is missing', () => {
  const withStems = (id = 'rec-stems'): Project => ({
    ...createProject({
      id,
      name: 'Stems',
      duration: 5,
      width: 1280,
      height: 720,
      hasWebcam: false,
      hasAudio: true,
      webcamOffset: 0,
      zooms: [],
      cursorValid: true,
      capture: { method: 'native', cursorInVideo: false, region: null }
    }),
    audioStems: { mic: true, system: true },
    audio: { volume: 1, muted: false, mic: { volume: 1, muted: true } }
  })
  const files = (present: string[]) => async (f: string) => present.includes(path.basename(f))

  it('names the missing files, and only those', async () => {
    const p = withStems()
    expect(await missingStems(p, '/p', files(['screen.mp4', 'mic.m4a']))).toEqual(['system'])
    expect(await missingStems(p, '/p', files(['screen.mp4']))).toEqual(['mic', 'system'])
    expect(await missingStems(p, '/p', files(['mic.m4a', 'system.m4a']))).toEqual([])
    // A recording that kept only the microphone has no system sound file to miss.
    expect(await missingStems({ ...p, audioStems: { mic: true, system: false } }, '/p', files([]))).toEqual(['mic'])
    expect(await missingStems({ ...p, audioStems: undefined }, '/p', files([]))).toEqual([])
    expect(await missingStems({ ...p, hasAudio: false }, '/p', files([]))).toEqual([])
  })

  it('opens with the mixed sound, keeps its stems through saves, and uses them again once the file is back', async () => {
    const id = 'rec-stems-back'
    const dir = projectDir(id)
    mkdirSync(dir, { recursive: true })
    for (const f of ['screen.mp4', 'mic.m4a']) writeFileSync(path.join(dir, f), 'media')
    writeFileSync(path.join(dir, 'project.json'), JSON.stringify(withStems(id)))
    const load = (): Promise<LoadedProject> => h.handlers.get('projects:load')!(null, id) as Promise<LoadedProject>
    const save = (p: Project): unknown => h.handlers.get('projects:save')!(null, p)
    const stored = (): Project => JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf8'))

    // system.m4a is missing (a folder still being copied): the editor opens without the stems.
    const data = await load()
    expect(data.missingStems).toEqual(['system'])
    expect(data.project.audioStems).toEqual({ mic: true, system: true })
    const opened = openedWithoutStems(data.project, data.missingStems)
    expect(stemsOf(opened)).toEqual([])
    // The preview, the export and the ducking use the mixed sound; the settings stay.
    expect(recordingMix(opened)).toEqual({ kind: 'mix', volume: 1 })
    expect(opened.audio).toEqual(data.project.audio)

    // An edit is saved as the editor saves it: with the stems the recording kept.
    const edited = { ...opened, name: 'Edited' }
    await save(withRecordedStems(edited, data.project))
    expect(stored().name).toBe('Edited')
    expect(stored().audioStems).toEqual({ mic: true, system: true })
    expect(stored().audio.mic).toEqual({ volume: 1, muted: true })

    // The file is back: the next open uses the stems again, with the microphone still muted.
    writeFileSync(path.join(dir, 'system.m4a'), 'media')
    const again = await load()
    expect(again.missingStems).toEqual([])
    const reopened = openedWithoutStems(again.project, again.missingStems)
    expect(reopened).toBe(again.project)
    expect(stemsOf(reopened)).toEqual(['mic', 'system'])
    expect(recordingMix(reopened)).toEqual({ kind: 'stems', volume: 1, stems: { system: 1 } })

    // And it goes without them again only while a file is missing.
    unlinkSync(path.join(dir, 'mic.m4a'))
    expect((await load()).missingStems).toEqual(['mic'])
  })

  it('saves what the editor opened with stems unchanged', () => {
    const p = withStems()
    expect(openedWithoutStems(p, [])).toBe(p)
    expect(withRecordedStems(p, p)).toBe(p)
    const plain = { ...p, audioStems: undefined }
    expect(openedWithoutStems(plain, ['mic'])).toBe(plain)
    expect(withRecordedStems(plain, plain)).toBe(plain)
  })
})
