// A project's files and the work that reads them: the ffmpeg analyses (smart speed's still
// detection, sound levels) stop before the project is deleted and when its editor closes; a
// project whose microphone or system sound file is missing opens with its mixed sound.
import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const { registerProjectsIpc, withoutMissingStems } = await import('../src/main/projectsIpc')
const { projectDir } = await import('../src/main/projects')
const { createProject } = await import('../src/shared/engine/project')

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
  const withStems = () => ({
    ...createProject({
      id: 'rec-stems',
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

  it('opens without its stems, so the preview, the export and the ducking all use the mixed sound', async () => {
    const p = withStems()
    const opened = await withoutMissingStems(p, '/p', files(['screen.mp4', 'mic.m4a']))
    expect(opened.audioStems).toBeUndefined()
    // The settings stay (the Audio panel says they no longer apply).
    expect(opened.audio).toEqual(p.audio)
  })

  it('keeps complete stems, and leaves projects without stems alone', async () => {
    const p = withStems()
    expect(await withoutMissingStems(p, '/p', files(['mic.m4a', 'system.m4a']))).toBe(p)
    const plain = { ...p, audioStems: undefined }
    expect(await withoutMissingStems(plain, '/p', files([]))).toBe(plain)
    const silent = { ...p, hasAudio: false }
    expect(await withoutMissingStems(silent, '/p', files([]))).toBe(silent)
  })
})
