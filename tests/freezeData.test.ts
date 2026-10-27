// Freeze frames as stored (E-11, docs/design/freeze-frame.md §3). readFreezes and clampFreezes are
// frozen contracts with their own cases in editingWinsContracts.test.ts; this file covers how the
// editor applies them when the media's real length differs from the project's.
import { describe, expect, it } from 'vitest'
import { correctProjectMedia } from '../src/shared/editor/clips'
import { createProject } from '../src/shared/engine/project'
import type { Freeze, Project } from '../src/shared/types'

const project = (freezes?: Freeze[]): Project => ({
  ...createProject({
    id: 'p',
    name: 'Media',
    duration: 10,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  }),
  ...(freezes && { freezes })
})
const freeze = (id: string, at: number, sound: Freeze['sound'] = 'pause'): Freeze => ({ id, at, length: 3, sound })

describe('correctProjectMedia', () => {
  it('keeps freezes inside a shorter recording, once per frame', () => {
    const p = project([freeze('a', 2), freeze('b', 8.5), freeze('c', 9, 'continue')])
    const next = correctProjectMedia(p, { duration: 8, width: 1280, height: 720 })
    expect(next.freezes).toEqual([freeze('a', 2), freeze('b', 8)])
  })

  it('keeps the same list when the media only grows, and adds no key to a project without freezes', () => {
    const list = [freeze('a', 2)]
    expect(correctProjectMedia(project(list), { duration: 12, width: 1280, height: 720 }).freezes).toBe(list)
    const plain = correctProjectMedia(project(), { duration: 8, width: 1280, height: 720 })
    expect('freezes' in plain).toBe(false)
  })
})
