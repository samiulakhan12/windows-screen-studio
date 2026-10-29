import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ root: '' }))
h.root = mkdtempSync(path.join(os.tmpdir(), 'ssw-diagnostics-'))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, app: { getPath: () => h.root, isPackaged: false }, clipboard: {}, screen: {}, shell: {} }))
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

import { collectDiagnostics, diagnosticsText, lastRecordedCapture, partOf, type DiagnosticsDeps } from '../src/main/diagnostics'
import type { ProbeResult } from '../src/main/nativeCapture'
import { projectDir, projectsRoot } from '../src/main/projects'
import { createProject } from '../src/shared/engine/project'
import type { Project } from '../src/shared/types'

const PROBE: ProbeResult = { supported: true, windowCapture: true, cursorToggle: true, borderToggle: false, hardwareEncoders: ['h264_nvenc'], reason: null }

const deps = (patch: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps => ({
  app: () => ({ name: 'Flown', version: '0.7.0', electron: '44.9.3', chrome: '140', node: '22', packaged: true }),
  system: async () => ({ os: 'Windows', build: '10.0.26100', arch: 'x64', cpu: 'Test CPU', cores: 8, memoryGB: 16 }),
  displays: async () => [{ width: 2560, height: 1440, scale: 1.5, hz: 144, primary: true }],
  gpu: async () => ({ devices: [{ vendorId: 0x10de, deviceId: 0x2684, active: true, driverVersion: '31.0.15.5222', machineModelName: 'secret' }], features: { video_encode: 'enabled' } }),
  encoders: async () => ['h264_nvenc', 'libx264'],
  probe: async () => PROBE,
  lastCapture: async () => ({ capture: { method: 'native', cursorInVideo: false, region: { x: 0, y: 0, w: 0.5, h: 0.5 } }, createdAt: '2026-10-27T10:00:00.000Z' }),
  recordings: async () => 3,
  jobs: () => ['export 42%'],
  log: async () => ['2026-10-28T12:00:00.000Z WARN Could not open C:\\Users\\Jane Doe\\Desktop\\a.mp4'],
  roots: { userData: 'C:\\Users\\Jane Doe\\AppData\\Roaming\\Flown' },
  now: () => new Date('2026-10-28T12:00:00.000Z'),
  ...patch
})

describe('diagnostics', () => {
  it('reports the system, graphics, encoders, capture and recent messages', async () => {
    const d = deps()
    const text = diagnosticsText(await collectDiagnostics(d), d.roots)
    expect(text).toContain('Flown diagnostics · 2026-10-28T12:00:00.000Z')
    expect(text).toContain('Windows 10.0.26100 (x64)')
    expect(text).toContain('2560×1440 at 150% · 144 Hz · primary')
    expect(text).toContain('GPU 0x10de:0x2684 (active) · driver 31.0.15.5222')
    expect(text).not.toContain('secret')
    expect(text).toContain('h264_nvenc, libx264')
    expect(text).toContain('Native capture: yes · window capture: yes · cursor toggle: yes · border toggle: no')
    expect(text).toContain('2026-10-27T10:00:00.000Z · native capture · area · cursor in video: no')
    expect(text).toContain('export 42%')
    expect(text).toContain('WARN Could not open <path>')
    expect(text).not.toMatch(/Jane|Doe/)
  })

  it('says why a part is missing, and never waits forever', async () => {
    const d = deps({
      encoders: async () => {
        throw new Error('ffmpeg missing')
      },
      probe: () => new Promise(() => undefined),
      lastCapture: async () => null
    })
    const text = diagnosticsText(await collectDiagnostics(d, 50), d.roots)
    expect(text).toContain('== Video encoders\n  unavailable (ffmpeg missing)')
    expect(text).toContain('== Capture helper\n  unavailable (timed out)')
    expect(text).toContain('No recordings yet')
  })

  it('times out a slow part', async () => {
    expect(await partOf(() => new Promise(() => undefined), 10)).toEqual({ ok: false, reason: 'timed out' })
    expect(await partOf(async () => 5)).toEqual({ ok: true, value: 5 })
  })
})

describe('the last recording', () => {
  const save = (id: string, createdAt: string, over: Partial<Project> = {}): void => {
    const p: Project = {
      ...createProject({
        id,
        name: id,
        duration: 5,
        width: 1920,
        height: 1080,
        hasWebcam: false,
        hasAudio: true,
        webcamOffset: 0,
        zooms: [],
        cursorValid: true,
        capture: { method: 'native', cursorInVideo: false, region: null, target: 'window' }
      }),
      createdAt,
      ...over
    }
    mkdirSync(projectDir(id), { recursive: true })
    writeFileSync(path.join(projectDir(id), 'project.json'), JSON.stringify(p))
  }

  it('is the newest project recorded in Flown, never an imported video or a copy', async () => {
    rmSync(projectsRoot(), { recursive: true, force: true })
    expect(await lastRecordedCapture()).toBeNull()
    save('rec-20261001-100000', '2026-10-01T10:00:00.000Z')
    // An import's capture is a placeholder: it was never captured.
    save('rec-20261020-100000', '2026-10-20T10:00:00.000Z', {
      capture: { method: 'chromium', cursorInVideo: true, region: null, target: 'screen' },
      source: { kind: 'import', fileName: 'phone.mp4', bytes: 1000, container: 'mov,mp4', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, rotation: 0, fps: 30, importedAt: '2026-10-20T10:00:00.000Z' }
    })
    // A copy keeps the recording's capture, but its date is when it was made.
    save('rec-20261025-100000', '2026-10-25T10:00:00.000Z', { copyOf: { id: 'rec-20261001-100000', name: 'rec-20261001-100000' } })
    expect(await lastRecordedCapture()).toEqual({ capture: { method: 'native', cursorInVideo: false, region: null, target: 'window' }, createdAt: '2026-10-01T10:00:00.000Z' })

    rmSync(projectDir('rec-20261001-100000'), { recursive: true, force: true })
    expect(await lastRecordedCapture()).toBeNull()
  })
})
