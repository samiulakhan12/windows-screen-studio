import { describe, expect, it } from 'vitest'
import { createProject, migrateCursor, migrateProject } from '../src/shared/engine/project'

const base = {
  id: 'rec-1',
  name: 'Test',
  duration: 10,
  width: 1920,
  height: 1080,
  hasWebcam: false,
  hasAudio: true,
  webcamOffset: 0,
  zooms: [],
  cursorValid: true
}

describe('createProject', () => {
  it('creates a v2 project with one full clip', () => {
    const p = createProject({ ...base, capture: { method: 'native', cursorInVideo: false, region: null } })
    expect(p.version).toBe(2)
    expect(p.clips).toHaveLength(1)
    expect(p.clips[0]).toMatchObject({ start: 0, end: 10, speed: 1 })
    expect(p.cursor.show).toBe(true)
  })

  it('keeps the synthetic cursor off when the OS cursor is in the video', () => {
    const p = createProject({ ...base, capture: { method: 'chromium', cursorInVideo: true, region: null } })
    expect(p.cursor.show).toBe(false)
  })
})

describe('migrateProject', () => {
  it('upgrades a v1 project (trim -> clips, new sections)', () => {
    const v1 = { ...createProject({ ...base, capture: { method: 'chromium', cursorInVideo: true, region: null } }) } as Record<string, unknown>
    v1.version = 1
    delete v1.clips
    delete v1.capture
    delete v1.annotations
    delete v1.effects
    delete v1.audio
    v1.trim = { start: 1, end: 9 }
    const p = migrateProject(v1)
    expect(p.version).toBe(2)
    expect(p.clips.map((c) => [c.start, c.end, c.speed])).toEqual([[1, 9, 1]])
    expect('trim' in p).toBe(false)
    expect(p.capture.cursorInVideo).toBe(true)
    expect(p.annotations).toEqual([])
    expect(p.effects.keystrokes.show).toBe(true)
    expect(p.audio.volume).toBe(1)
  })

  it('rejects garbage', () => {
    expect(() => migrateProject(null)).toThrow()
    expect(() => migrateProject({})).toThrow()
  })

  it('migrates cursor tracks', () => {
    expect(migrateCursor({ samples: [], clicks: [], valid: true })).toEqual({ samples: [], clicks: [], keys: [], shapes: [], valid: true })
    expect(migrateCursor(undefined).valid).toBe(false)
  })
})
