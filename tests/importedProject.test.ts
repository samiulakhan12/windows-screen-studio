import { describe, expect, it } from 'vitest'
import { createProject, migrateProject } from '../src/shared/engine/project'
import { importedSource, isImported, IMPORTED_COPY } from '../src/shared/import/imported'
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

  it('has plain explanations for the editor', () => {
    for (const text of Object.values(IMPORTED_COPY)) expect(text).toMatch(/^This video was imported/)
  })
})
