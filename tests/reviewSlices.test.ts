// Review mode's Remove all and Keep all on a long list (docs/design/review-mode.md §4.3): the work in
// steps (removeSteps, takeBackSteps) gives the same project as removeItems, a step a cut or
// speed-up, and inSlices takes the steps a slice of time at a time, starting over when the project
// changes under it, so the result is one edit made from the project as it is then.
import { describe, expect, it } from 'vitest'
import { EditStore } from '../src/shared/editor/editStore'
import { applySmartSpeed, planSilences } from '../src/shared/editor/smartSpeed'
import { settleDeletedWords } from '../src/shared/editor/transcript'
import { createProject, migrateProject } from '../src/shared/engine/project'
import { finish, recordAutoCuts, settleAutoCuts } from '../src/shared/review/autoCuts'
import { removeItems, removeSteps, reviewItems, reviewStatus } from '../src/shared/review/review'
import { inSlices, type Tasks } from '../src/shared/review/slices'
import type { AutoCut, AutoCutSource, Project } from '../src/shared/types'

const settle = (next: Project, prev: Project): Project => settleAutoCuts(settleDeletedWords(next, prev), prev)

/** A recording of `seconds` with a pause every 4 s, run through Remove silences then Polish (`actions`), as the editor saves it. */
function recording(seconds: number, actions: readonly AutoCut['action'][]): Project {
  const p0 = createProject({
    id: 'p',
    name: 'p',
    duration: seconds,
    width: 320,
    height: 180,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: false, region: null }
  })
  const sound = Array.from({ length: seconds / 4 }, (_, k) => ({ start: k * 4, end: k * 4 + 1.5 }))
  const store = new EditStore<Project>({ ...p0, clips: [{ id: 'c0', start: 0, end: seconds, speed: 1 }] }, 500, 800, () => 0, settle)
  let n = 0
  actions.forEach((action, i) => {
    const by: AutoCutSource = i === 0 ? 'silences' : 'polish'
    const ranges = planSilences(sound, store.state.clips, { minLength: 1, padding: [0.5, 0.25, 0.3][i] }, action).parts.flatMap((x) => x.pieces)
    store.update((p) => recordAutoCuts(p, applySmartSpeed(p.clips, ranges, action), ranges, action, by, () => `r${n++}`))
  })
  return migrateProject(JSON.parse(JSON.stringify(store.state)))
}

/** A queue of tasks run by hand and a clock that moves only when told (or, `ticking`, 1 ms each time it is read). */
function handTasks(ticking = false): Tasks & { queue: (() => void)[]; clock: { t: number }; runAll: () => number } {
  const queue: (() => void)[] = []
  const clock = { t: 0 }
  return {
    queue,
    clock,
    post: (fn) => queue.push(fn),
    now: () => (ticking ? ++clock.t : clock.t),
    runAll: () => {
      let tasks = 0
      while (queue.length) {
        queue.shift()!()
        tasks++
      }
      return tasks
    }
  }
}

describe('removeSteps', () => {
  for (const [name, actions] of [
    ['cuts', ['cut', 'cut']],
    ['speed-ups', [2, 4, 8]]
  ] as const) {
    it(`gives what removeItems gives, a step for each record taken back (${name})`, () => {
      const p = recording(400, actions)
      const items = reviewItems(p)
      const silences = items.filter((i) => i.kind === 'silence')
      expect(silences.length).toBeGreaterThan(100)
      const steps = removeSteps(p, silences)
      let yields = 0
      let r = steps.next()
      for (; !r.done; r = steps.next()) yields++
      expect(yields).toBe(silences.length)
      expect(r.value).toEqual(removeItems(p, silences))
      expect(finish(removeSteps(p, silences))).toEqual(r.value)
      // Every row it took back reads removed.
      expect(silences.every((i) => reviewStatus(r.value, i) === 'removed')).toBe(true)
    })
  }

  it('gives the project itself, with no step, when nothing is to review', () => {
    const p = recording(40, ['cut'])
    const done = removeItems(p, reviewItems(p))
    const steps = removeSteps(done, reviewItems(p))
    const r = steps.next()
    expect(r.done).toBe(true)
    expect(r.value).toBe(done)
  })
})

describe('inSlices', () => {
  /** Steps that each take `cost` ms on the hand clock; `count` of them, then `base * 10`. */
  function* work(t: ReturnType<typeof handTasks>, base: number, count: number, cost = 1): Generator<void, number, undefined> {
    for (let k = 0; k < count; k++) {
      t.clock.t += cost
      yield
    }
    return base * 10
  }

  it('takes the steps in tasks of about a slice each and gives what they give once', () => {
    const t = handTasks()
    const state = { v: 3 }
    const got: [number, number][] = []
    inSlices(() => state.v, (b) => work(t, b, 100), (b, value) => got.push([b, value]), t, 10)
    expect(got).toEqual([])
    const tasks = t.runAll()
    expect(got).toEqual([[3, 30]])
    // 100 steps of 1 ms in slices of 10 ms: about ten tasks, none of them all of it.
    expect(tasks).toBeGreaterThanOrEqual(10)
    expect(tasks).toBeLessThanOrEqual(12)
  })

  it('starts over from the new state when the state changes under it, and gives what that one makes', () => {
    const t = handTasks()
    const state = { v: 1 }
    const starts: number[] = []
    const got: [number, number][] = []
    inSlices(
      () => state.v,
      (b) => {
        starts.push(b)
        return work(t, b, 50)
      },
      (b, value) => got.push([b, value]),
      t,
      10
    )
    t.queue.shift()!()
    t.queue.shift()!()
    state.v = 2
    t.runAll()
    expect(starts).toEqual([1, 2])
    expect(got).toEqual([[2, 20]])
  })

  it('does nothing more once stopped', () => {
    const t = handTasks()
    const got: number[] = []
    const stop = inSlices(() => 1, (b) => work(t, b, 50), (_, value) => got.push(value), t, 10)
    t.queue.shift()!()
    stop()
    t.runAll()
    expect(got).toEqual([])
    expect(t.queue).toEqual([])
  })

  it('makes a long Remove all one edit, from the project as it is when it ends', () => {
    const p = recording(400, [2, 4, 8])
    const store = new EditStore<Project>(p, 200, 800, () => 0, settle)
    // A step a task.
    const t = handTasks(true)
    const kind = (q: Project) => reviewItems(q).filter((i) => i.kind === 'silence')
    let edits = 0
    store.subscribe(() => edits++)
    inSlices(
      () => store.state,
      (q) => removeSteps(q, kind(q)),
      (base, next) => store.update((q) => (q === base ? next : removeItems(q, kind(q)))),
      t,
      1
    )
    t.queue.shift()!()
    expect(edits).toBe(0)
    expect(t.runAll()).toBeGreaterThan(100)
    expect(edits).toBe(1)
    expect(store.state).toEqual(settle(removeItems(p, kind(p)), p))
    // One undo step back to where it started.
    store.undo()
    expect(store.state).toBe(p)
  })
})
