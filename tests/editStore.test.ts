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

  it('a hold let go without its edit (the work stopped) does what waited as if it had been made: an undo for it does nothing, the step before and the redo list stay', () => {
    // Ctrl+Z while it works, then the panel closed: the user's Keep (1) stays, and the redo list (2).
    const { s } = store()
    s.update(() => 1)
    s.update(() => 2)
    s.undo() // redo holds 2
    let release = s.hold()
    expect(s.undo()).toBe(true) // waits
    release(false)
    expect(s.held).toBe(false)
    expect(s.state).toBe(1)
    expect(s.canRedo).toBe(true)
    // A redo that waited finds nothing above the edit (it would have emptied the redo list); the list stays.
    release = s.hold()
    s.redo()
    release(false)
    expect(s.state).toBe(1)
    expect(s.redo()).toBe(true)
    expect(s.state).toBe(2)
    s.undo()
    // Undo, then redo: the edit taken back and brought back, nothing changes.
    release = s.hold()
    s.undo()
    s.redo()
    release(false)
    expect(s.state).toBe(1)
    expect(s.canRedo).toBe(true)
    // Two undos: the edit, then the step before it (the Keep), which redo brings back.
    release = s.hold()
    s.undo()
    s.undo()
    release(false)
    expect(s.state).toBe(0)
    expect(s.redo()).toBe(true)
    expect(s.state).toBe(1)
    // Two undos then two redos: the step before back, then the edit (nothing), and no more.
    release = s.hold()
    s.undo()
    s.undo()
    s.redo()
    s.redo()
    s.redo()
    release(false)
    expect(s.state).toBe(1)
    expect(s.canRedo).toBe(true) // 2, which the edit would have taken: no waiting redo reached it
  })

  it('stopped, a Keep that waited is made and an undo after it takes that Keep back; one before it does nothing', () => {
    const { s } = store()
    s.update(() => 1) // the user's Keep
    let release = s.hold()
    s.whenFree(() => s.update((v) => v + 10)) // a Keep that waits
    s.undo()
    release(false)
    expect(s.state).toBe(1) // the waiting Keep, then undone
    expect(s.canRedo).toBe(true)
    expect(s.redo()).toBe(true)
    expect(s.state).toBe(11)
    release = s.hold()
    s.undo()
    s.whenFree(() => s.update((v) => v + 100))
    release(false)
    expect(s.state).toBe(111) // the undo was for the edit not made; the Keep after it is made
    s.undo()
    expect(s.state).toBe(11)
  })

  it('while held, an undo takes back at once an edit made meanwhile after the last thing that waits, and a redo brings it back; else both wait', () => {
    const { s } = store()
    s.update(() => 1) // the user's Keep
    let edits = 0
    s.subscribe(() => edits++)
    const release = s.hold()
    s.update(() => 5) // a zoom added on the timeline meanwhile
    expect(s.undo()).toBe(true)
    expect(s.state).toBe(1) // at once
    expect(s.redo()).toBe(true)
    expect(s.state).toBe(5) // at once
    expect(s.undo()).toBe(true)
    expect(s.state).toBe(1)
    expect(edits).toBe(4)
    // No edit of its own left to take back: the next undo waits for the work's edit.
    expect(s.undo()).toBe(true)
    expect(s.state).toBe(1)
    // Then a redo waits too (done in turn after it), the zoom's redo being before what waits.
    expect(s.redo()).toBe(true)
    expect(s.state).toBe(1)
    s.update(() => 7) // the work's edit, on top
    release()
    expect(s.state).toBe(7) // undone, then redone, in turn
    s.undo()
    expect(s.state).toBe(1) // the Keep stays below
    // In the order asked for, as if after the work's edit: a Keep that waits, then an edit, then
    // undo: the edit is taken back at once and the Keep made after the work.
    const { s: t } = store()
    let free = t.hold()
    t.whenFree(() => t.update((v) => v + 10))
    t.update(() => 2)
    t.undo()
    expect(t.state).toBe(0)
    t.update(() => 3) // the work's edit
    free()
    expect(t.state).toBe(13)
    // An edit, then a Keep that waits, then undo: the undo waits, and takes back the Keep.
    free = t.hold()
    t.update(() => 20)
    t.whenFree(() => t.update((v) => v + 100))
    t.undo()
    expect(t.state).toBe(20)
    t.update(() => 30) // the work's edit
    free()
    expect(t.state).toBe(30)
    t.undo()
    expect(t.state).toBe(20)
  })

  // The palette's Undo and the title bar's buttons ask canUndo and canRedo (§4.3): Remove all as the
  // first edit since the project opened still has an undo, which waits for it.
  it('while held, an undo is always there (it waits for the edit); a redo only for an edit made meanwhile or after an undo that waits, else refused at once', () => {
    const { s } = store()
    let heard = 0
    s.subscribeHistory(() => heard++)
    expect(s.canUndo).toBe(false)
    let release = s.hold()
    expect(heard).toBe(1)
    expect(s.canUndo).toBe(true)
    expect(s.canRedo).toBe(false)
    expect(s.redo()).toBe(false) // nothing to bring back after the work's edit: refused at once
    expect(s.undo()).toBe(true) // waits
    expect(heard).toBe(2)
    expect(s.canRedo).toBe(true) // after the undo that waits
    expect(s.redo()).toBe(true) // waits
    expect(s.canRedo).toBe(false)
    expect(s.redo()).toBe(false)
    s.update(() => 1) // the work's edit
    release()
    expect(s.held).toBe(false)
    expect(s.state).toBe(1) // undone, then redone
    expect(s.canRedo).toBe(false)
    expect(heard).toBeGreaterThanOrEqual(6) // the edit, the undo, the redo, the release
    // A redo list from before the work: its edit empties it, so a redo meanwhile is refused.
    s.undo()
    expect(s.canRedo).toBe(true)
    release = s.hold()
    expect(s.canRedo).toBe(false)
    expect(s.redo()).toBe(false)
    // An undo, then a Keep that waits (an edit): no redo after it either.
    s.undo()
    expect(s.canRedo).toBe(true)
    s.whenFree(() => s.update((v) => v + 10))
    expect(s.canRedo).toBe(false)
    expect(s.redo()).toBe(false)
    // An edit made meanwhile and taken back at once comes back at once.
    s.update(() => 5)
    s.undo()
    expect(s.canRedo).toBe(true)
    expect(s.redo()).toBe(true)
    expect(s.state).toBe(5)
    s.update(() => 7) // the work's edit
    release()
    expect(s.state).toBe(15) // the undo took the work's edit back (to the edit made meanwhile), then the Keep was made
    expect(s.canRedo).toBe(false)
  })

  it('finish has each work holding the store make its edit and let go at once', () => {
    const { s } = store()
    s.update(() => 1)
    const release = s.hold(() => {
      s.update(() => 9)
      release()
    })
    s.undo()
    s.finish()
    expect(s.held).toBe(false)
    expect(s.state).toBe(1) // the edit made, then the waiting undo took it back
    s.finish() // nothing holds it: nothing to do
    expect(s.redo()).toBe(true)
    expect(s.state).toBe(9)
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
