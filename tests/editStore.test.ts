import { describe, expect, it } from 'vitest'
import { EditStore } from '../src/shared/editor/editStore'

function store(initial = 0): { s: EditStore<number>; tick: (ms: number) => void } {
  let now = 0
  const s = new EditStore(initial, 200, 800, () => now)
  return { s, tick: (ms) => (now += ms) }
}

describe('EditStore', () => {
  it('records each unkeyed edit as an undo step and notifies subscribers', () => {
    const { s } = store()
    let calls = 0
    s.subscribe(() => calls++)
    s.update((v) => v + 1)
    s.update((v) => v + 1)
    expect(s.state).toBe(2)
    expect(s.undo()).toBe(true)
    expect(s.state).toBe(1)
    expect(s.redo()).toBe(true)
    expect(s.state).toBe(2)
    expect(calls).toBe(4)
    expect(s.revision).toBe(4)
  })

  it('ignores no-op updates', () => {
    const { s } = store()
    s.update((v) => v)
    expect(s.canUndo).toBe(false)
    expect(s.revision).toBe(0)
  })

  it('merges same-key edits inside the window (typing, arrow keys)', () => {
    const { s, tick } = store()
    s.update(() => 1, 'name')
    tick(200)
    s.update(() => 2, 'name')
    tick(2000)
    s.update(() => 3, 'name')
    s.undo()
    expect(s.state).toBe(2)
    s.undo()
    expect(s.state).toBe(0)
  })

  it('keeps one step for a held gesture however long the pause, and ends it on release', () => {
    const { s, tick } = store()
    s.beginGesture()
    s.update(() => 1, 'drag')
    tick(5000)
    s.update(() => 2, 'drag')
    s.endGesture()
    s.update(() => 3, 'drag')
    expect(s.undo()).toBe(true)
    expect(s.state).toBe(2)
    expect(s.undo()).toBe(true)
    expect(s.state).toBe(0)
    expect(s.canUndo).toBe(false)
  })

  it('replace changes the present without an undo step', () => {
    const { s } = store()
    s.update(() => 1)
    s.replace(() => 5)
    expect(s.state).toBe(5)
    s.undo()
    expect(s.state).toBe(0)
  })

  it('a new edit after undo clears redo', () => {
    const { s } = store()
    s.update(() => 1)
    s.undo()
    s.update(() => 7)
    expect(s.canRedo).toBe(false)
    expect(s.redo()).toBe(false)
  })
})
