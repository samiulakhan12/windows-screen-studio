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

  it('settles each state an edit makes, in the same undo step; undo and redo go back to settled states', () => {
    const calls: [number, number][] = []
    // A derived field that follows the edit: here, an odd value is rounded up.
    const s = new EditStore(0, 200, 800, () => 0, (next, prev) => (calls.push([next, prev]), next % 2 ? next + 1 : next))
    s.update(() => 3)
    expect(s.state).toBe(4)
    s.replace(() => 5)
    expect(s.state).toBe(6)
    expect(calls).toEqual([
      [3, 0],
      [5, 4]
    ])
    expect(s.undo()).toBe(true)
    expect(s.state).toBe(0)
    expect(s.redo()).toBe(true)
    expect(s.state).toBe(6)
    // Not called for undo, redo or an edit that changes nothing.
    s.update((v) => v)
    expect(calls.length).toBe(2)
  })

  it('settles a held gesture once, when its run closes, against the state before it, in its own undo step', () => {
    const calls: [number, number][] = []
    const s = new EditStore(0, 200, 800, () => 0, (next, prev) => (calls.push([next, prev]), next % 2 ? next + 1 : next))
    // A drag: every move made from where it started, the states in between as they are.
    s.beginGesture()
    s.update(() => 3, 'drag')
    expect(s.state).toBe(3)
    s.replace(() => 5)
    s.update(() => 7, 'drag')
    expect(s.state).toBe(7)
    expect(calls).toEqual([])
    // An edit that changes nothing leaves the run going.
    s.update((v) => v)
    expect(s.state).toBe(7)
    s.endGesture()
    expect(s.state).toBe(8)
    expect(calls.at(-1)).toEqual([7, 0])
    expect(s.undo()).toBe(true)
    expect(s.state).toBe(0)
    expect(s.redo()).toBe(true)
    expect(s.state).toBe(8)
    // Another edit, or undo, while the gesture is held closes the run first: each settled in its own step.
    s.beginGesture()
    s.update(() => 9, 'drag')
    s.update(() => 11)
    expect(s.state).toBe(12)
    s.update(() => 13, 'drag')
    expect(s.undo()).toBe(true)
    expect(s.state).toBe(12)
    s.endGesture()
    expect(s.undo()).toBe(true)
    expect(s.state).toBe(10)
    expect(s.redo()).toBe(true)
    expect(s.redo()).toBe(true)
    expect(s.state).toBe(14)
  })

  it('a new edit after undo clears redo', () => {
    const { s } = store()
    s.update(() => 1)
    s.undo()
    s.update(() => 7)
    expect(s.canRedo).toBe(false)
    expect(s.redo()).toBe(false)
  })

  // Review mode's Remove all on a long list (docs/design/review-mode.md §4.3): Ctrl+Z pressed while
  // it works undoes the Remove all, as when it was instant, never the Keep before it.
  it('holds undo and redo while held: they are done in order after the holder edits, as if asked for after it', () => {
    const { s } = store()
    s.update(() => 1) // the user's Keep
    const release = s.hold()
    expect(s.held).toBe(true)
    expect(s.undo()).toBe(true) // waits
    expect(s.state).toBe(1)
    expect(s.canUndo).toBe(true)
    s.update(() => 2) // the work's one edit, at its end
    release()
    expect(s.held).toBe(false)
    expect(s.state).toBe(1) // the undo took the work's edit back, not the Keep
    expect(s.canRedo).toBe(true)
    expect(s.redo()).toBe(true)
    expect(s.state).toBe(2)
    release() // a second call does nothing
    expect(s.undo()).toBe(true)
    expect(s.state).toBe(1)
  })

  it('a hold let go with no edit (the work stopped) does what waited on the history as it was, redo list kept', () => {
    const { s } = store()
    s.update(() => 1)
    s.update(() => 2)
    s.undo() // redo holds 2
    const release = s.hold()
    s.redo()
    s.undo()
    expect(s.state).toBe(1)
    release()
    expect(s.state).toBe(1) // redo then undo, in order
    expect(s.canRedo).toBe(true)
    expect(s.redo()).toBe(true)
    expect(s.state).toBe(2)
  })

  it('whenFree runs at once when free, else in turn with the waiting undo and redo; one that holds again keeps the rest waiting', () => {
    const { s } = store()
    const order: string[] = []
    s.whenFree(() => order.push('now'))
    expect(order).toEqual(['now'])
    s.update(() => 1)
    const first = s.hold()
    s.whenFree(() => {
      order.push('keep')
      s.update((v) => v + 10)
    })
    s.undo()
    let second: (() => void) | null = null
    s.whenFree(() => {
      order.push('hold again')
      second = s.hold()
    })
    s.whenFree(() => order.push('last'))
    s.update(() => 5) // the first holder's edit
    first()
    expect(order).toEqual(['now', 'keep', 'hold again'])
    expect(s.state).toBe(5) // 5, then 15, then undone back to 5
    expect(s.held).toBe(true)
    second!()
    expect(order).toEqual(['now', 'keep', 'hold again', 'last'])
    expect(s.held).toBe(false)
  })
})
