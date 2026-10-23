// windows-4: recording.json writes retry while Windows briefly locks the file.
import fs, { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const root = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => root.dir } }))

import * as projects from '../src/main/projects'

afterEach(() => vi.restoreAllMocks())

function manifest(id: string): projects.RecordingManifest {
  return {
    version: 1,
    id,
    createdAt: new Date(0).toISOString(),
    status: 'recording',
    error: null,
    method: 'chromium',
    sourceKind: 'screen',
    region: null,
    startedAt: null,
    width: 0,
    height: 0,
    hasAudio: false,
    hasWebcam: false,
    webcamFps: 30,
    webcamOffset: 0,
    audioOffset: 0,
    duration: null
  }
}

const locked = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code })

describe('writeManifest', () => {
  it('retries a rename blocked by a transient Windows lock', async () => {
    root.dir = mkdtempSync(path.join(tmpdir(), 'ssw-manifest-'))
    const { id, dir } = await projects.createProjectDir()
    await projects.writeManifest(manifest(id))
    const real = fs.renameSync
    let failures = 2
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (failures-- > 0) throw locked('EPERM')
      return real(from, to)
    })
    const m = { ...manifest(id), status: 'processing' as const }
    await projects.writeManifest(m)
    expect(rename).toHaveBeenCalledTimes(3)
    expect(JSON.parse(readFileSync(path.join(dir, 'recording.json'), 'utf8')).status).toBe('processing')
    expect(fs.existsSync(path.join(dir, 'recording.json.tmp'))).toBe(false)
  })

  it('gives up on a lasting lock without leaving a temporary file', async () => {
    root.dir = mkdtempSync(path.join(tmpdir(), 'ssw-manifest-'))
    const { id, dir } = await projects.createProjectDir()
    await projects.writeManifest(manifest(id))
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw locked('EBUSY')
    })
    await expect(projects.writeManifest({ ...manifest(id), status: 'failed' })).rejects.toThrow(/EBUSY/)
    expect(JSON.parse(readFileSync(path.join(dir, 'recording.json'), 'utf8')).status).toBe('recording')
    expect(fs.existsSync(path.join(dir, 'recording.json.tmp'))).toBe(false)
  })
})
