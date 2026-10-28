import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProject, migrateProject } from '../src/shared/engine/project'
import { exportBaseName, importedSource, isImported, IMPORTED_COPY } from '../src/shared/import/imported'
import { importName } from '../src/shared/import/plan'
import { safeFileName } from '../src/shared/render/exportPresets'
import type { ImportedSource, Project } from '../src/shared/types'

const recorded = (): Project =>
  createProject({
    id: 'rec-1',
    name: 'Demo',
    duration: 10,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen', fps: 60 }
  })

const SOURCE: ImportedSource = {
  kind: 'import',
  fileName: 'phone.mov',
  bytes: 1234,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  videoCodec: 'hevc',
  audioCodec: 'aac',
  width: 1920,
  height: 1080,
  rotation: 90,
  fps: 29.97,
  hdr: true,
  importedAt: '2026-10-28T10:00:00.000Z'
}

describe('imported projects in project.json', () => {
  it('leaves a project from before NW-07 exactly as it was (no source key)', () => {
    const stored = JSON.parse(JSON.stringify(recorded()))
    const loaded = migrateProject(structuredClone(stored))
    expect('source' in loaded).toBe(false)
    expect(JSON.stringify(migrateProject(JSON.parse(JSON.stringify(loaded))))).toBe(JSON.stringify(loaded))
    expect(isImported(loaded)).toBe(false)
  })

  it('keeps the import record through a load and save', () => {
    const stored = JSON.parse(JSON.stringify({ ...recorded(), source: SOURCE }))
    const loaded = migrateProject(stored)
    expect(loaded.source).toEqual(SOURCE)
    expect(importedSource(loaded)).toEqual(SOURCE)
  })
})

describe('importedSource', () => {
  it('reads anything that is not an import record as recorded', () => {
    for (const source of [undefined, null, 5, 'import', [], {}, { kind: 'recording' }]) {
      expect(importedSource({ source } as unknown as Project)).toBeNull()
    }
    expect(importedSource(null)).toBeNull()
  })

  it('cleans a hand-edited record', () => {
    const s = importedSource({ source: { kind: 'import', fileName: 7, bytes: -1, rotation: 45, fps: 'x', width: 'a', hdr: 'yes' } } as unknown as Project)
    expect(s).toEqual({ kind: 'import', fileName: '', bytes: 0, container: '', videoCodec: '', audioCodec: null, width: 0, height: 0, rotation: 0, fps: null, importedAt: '' })
  })

  it('never offers an export under the name of the imported video', () => {
    expect(exportBaseName(recorded())).toBe('Demo')
    const imported = { ...recorded(), name: importName('C:\\Users\\me\\Videos\\demo.mp4'), source: { ...SOURCE, fileName: 'demo.mp4' } }
    expect(imported.name).toBe('demo')
    expect(`${safeFileName(exportBaseName(imported))}.mp4`).toBe('demo (edited).mp4')
    // The Export dialog offers its file under this name.
    expect(readFileSync(path.join(__dirname, '../src/renderer/src/editor/ExportDialog.tsx'), 'utf8')).toContain('safeFileName(exportBaseName(project))')
  })

  it('has plain explanations for the editor', () => {
    for (const text of Object.values(IMPORTED_COPY)) expect(text).toMatch(/^This video was imported/)
  })
})
