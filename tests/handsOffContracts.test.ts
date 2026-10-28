import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateProject } from '../src/shared/engine/project'
import { normalizeBundle, NO_BUNDLE } from '../src/shared/render/exportBundle'
import { DEFAULT_RULES, sanitizeRules } from '../src/shared/storage/rules'

const src = (file: string): string => readFileSync(path.join(__dirname, '..', file), 'utf8')

describe('hands-off contracts (docs/design/hands-off.md)', () => {
  it('leaves projects as they were: no field is added or read from project.json', () => {
    const old = {
      version: 2,
      id: 'rec-1',
      name: 'Old',
      createdAt: '2025-01-01T00:00:00.000Z',
      duration: 4,
      width: 1280,
      height: 720,
      hasWebcam: false,
      hasAudio: false,
      webcamOffset: 0,
      capture: { method: 'chromium', cursorInVideo: true, region: null },
      clips: [{ id: 'c0', start: 0, end: 4, speed: 1 }],
      zooms: [],
      autoZoom: true,
      annotations: [],
      chapters: [{ id: 'k', t: 1, title: 'One' }]
    }
    const before = JSON.stringify(old)
    migrateProject(JSON.parse(before))
    expect(JSON.stringify(old)).toBe(before)
    for (const file of ['src/shared/types.ts', 'src/shared/engine/project.ts']) expect(src(file)).not.toMatch(/hands-off|lastOpened|lastExport/)
  })

  it('starts with every new option off or at its safe default', () => {
    expect(normalizeBundle(undefined)).toEqual(NO_BUNDLE)
    expect(sanitizeRules(undefined)).toEqual(DEFAULT_RULES)
    expect(DEFAULT_RULES.removeDays).toBeNull()
    expect(DEFAULT_RULES.autoCaches).toBe(false)
  })

  it('is wired in: IPC registered, Settings sections, the editor notes the open recording, the export loop pauses', () => {
    const index = src('src/main/index.ts')
    for (const call of ['startAppLog(', 'setTaskbarPort(electronTaskbarPort())', 'registerJobsIpc()', 'registerExportBundleIpc()', 'registerDiagnosticsIpc()', 'registerStorageIpc()', 'disposeJobs()', 'appLog()?.flushSync()']) {
      expect(index).toContain(call)
    }
    expect(src('src/renderer/src/settings/SettingsDialog.tsx')).toContain('<HealthSections />')
    expect(src('src/renderer/src/views/Editor.tsx')).toContain('window.api.storageNoteOpened(projectId)')
    expect(src('src/renderer/src/editor/exporter.ts')).toContain('await input.pause?.wait(signal)')
    expect(src('src/main/aiIpc.ts')).toContain("beginJob({\n      kind: 'captions'")
  })

  it('removes files only through the Recycle Bin', () => {
    for (const file of ['src/main/storage.ts', 'src/main/storageIpc.ts']) expect(src(file)).not.toMatch(/fs\.rm\(|rmSync|unlink|rmdir/)
    expect(src('src/main/storageIpc.ts')).toContain('shell.trashItem(file)')
  })
})
