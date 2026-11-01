/**
 * Review mode: what the user chose in the panel for an automatic cut or speed-up is recorded in the
 * project (Project.autoCutOutcomes, docs/design/review-mode.md §2.3, §2.4), in the same edit as the
 * change, so each row reads that choice after undo, redo, reopening and later tool runs. Histories
 * are replayed through the editor's store (one store.update per action, the editor's settle step)
 * with the panel's list kept as the panel keeps it.
 *
 * A history is a script of steps separated by ';':
 *   tool a-b[,c-d] <2|4|8|cut> [by]   an automatic run over [a, b] (and [c, d]; Polish unless `by` is given), records r0, r1, ...
 *   hand speed a-b <s> | hand cut a-b | hand restore a-b   an edit by hand
 *   undo | redo | open | close  Ctrl+Z, Ctrl+Y, the panel opened (Shift+R) and closed (Esc)
 *   K <id> | R <id>             Keep or Remove on that row (the panel opens first if it is closed)
 *   K all | R all [id]          Keep all; Remove all of the kind of row `id` (else of the first row to review)
 */
import { describe, expect, it } from 'vitest'
import { restoreRange, setRangeSpeed } from '../src/shared/editor/clips'
import { EditStore } from '../src/shared/editor/editStore'
import { applySmartSpeed } from '../src/shared/editor/smartSpeed'
import { settleDeletedWords } from '../src/shared/editor/transcript'
import { createProject } from '../src/shared/engine/project'
import { cutRange } from '../src/shared/engine/timeline'
import { recordAutoCuts, settleAutoCuts } from '../src/shared/review/autoCuts'
import { keepItems, mergeSnapshot, pendingCount, removeItems, reviewItems, reviewStatus, type ReviewItem, type ReviewStatus } from '../src/shared/review/review'
import type { AutoCut, AutoCutSource, Clip, Project } from '../src/shared/types'

type Choice = 'kept' | 'removed'

function base(): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 20,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: false, region: null }
  })
  return { ...p, clips: [{ id: 'c0', start: 0, end: 20, speed: 1 }] }
}

/** How the video plays: touching clips at one speed joined, as `[a,b]@speed`. */
function plays(clips: readonly Clip[]): string {
  const out: [number, number, number][] = []
  for (const c of clips) {
    const last = out[out.length - 1]
    if (last && Math.abs(last[1] - c.start) < 1e-6 && last[2] === c.speed) last[1] = c.end
    else out.push([c.start, c.end, c.speed])
  }
  return out.map(([a, b, s]) => `[${+a.toFixed(3)},${+b.toFixed(3)}]@${s}`).join(' ')
}

const span = (s: string): [number, number] => s.split('-').map(Number) as [number, number]

/** The editor's store and the Review panel over it, driven by a script (see the top of this file). */
class Session {
  readonly store: EditStore<Project>
  /** The panel's list while it is open (ReviewPanel's `shown`), else null. */
  shown: ReviewItem[] | null = null
  /** What the user chose, by row, for each state the store has had: undo and redo bring it back with the state. */
  private readonly chosen = new WeakMap<Project, ReadonlyMap<string, Choice>>()
  /** How each row read in each state the store has had: undo and redo back to it read the same. */
  private readonly seen = new WeakMap<Project, Map<string, ReviewStatus>>()
  private n = 0

  constructor(start: Project = base()) {
    // As the editor builds its store (views/Editor.tsx).
    this.store = new EditStore(start, 500, 800, () => 0, (next: Project, prev: Project) => settleAutoCuts(settleDeletedWords(next, prev), prev))
    this.chosen.set(start, new Map())
  }

  get p(): Project {
    return this.store.state
  }

  get choices(): ReadonlyMap<string, Choice> {
    return this.chosen.get(this.p)!
  }

  /** The panel's list now: what it showed, plus what is pending now (ReviewPanel). */
  get list(): ReviewItem[] {
    return this.shown ? mergeSnapshot(this.shown, this.p) : []
  }

  status(item: ReviewItem): ReviewStatus {
    return reviewStatus(this.p, item)
  }

  item(id: string): ReviewItem {
    const found = this.list.find((i) => i.cut?.id === id)
    if (!found) throw new Error(`no row ${id} in the list`)
    return found
  }

  /** Each row of the list as `<id>:<status>`, in list order. */
  rows(): string[] {
    return this.list.map((i) => `${i.cut?.id ?? i.key}:${this.status(i)}`)
  }

  run(script: string): this {
    for (const raw of script.split(';').map((s) => s.trim()).filter(Boolean)) {
      this.step(raw)
      this.check(raw)
    }
    return this
  }

  step(raw: string): void {
    const w = raw.split(/\s+/)
    if (w[0] === 'tool') {
      const action = (w[2] === 'cut' ? 'cut' : Number(w[2])) as AutoCut['action']
      const ranges = w[1].split(',').map((r) => {
        const [a, b] = span(r)
        return { start: a, end: b }
      })
      // As the Clip panel's apply and Polish do: the run and its record in one update.
      this.edit((p) => recordAutoCuts(p, applySmartSpeed(p.clips, ranges, action), ranges, action, (w[3] ?? 'polish') as AutoCutSource, () => `r${this.n++}`))
    } else if (w[0] === 'hand') {
      const [a, b] = span(w[2])
      if (w[1] === 'speed') this.edit((p) => ({ ...p, clips: setRangeSpeed(p.clips, a, b, Number(w[3])) }))
      else if (w[1] === 'cut') this.edit((p) => ({ ...p, clips: cutRange(p.clips, a, b) }))
      else this.edit((p) => ({ ...p, clips: restoreRange(p.clips, a, b, p.duration) }))
    } else if (w[0] === 'undo' || w[0] === 'redo') {
      expect(w[0] === 'undo' ? this.store.undo() : this.store.redo(), raw).toBe(true)
      this.follow()
    } else if (w[0] === 'open') this.shown = reviewItems(this.p)
    else if (w[0] === 'close') this.shown = null
    else if (w[0] === 'K' || w[0] === 'R') {
      this.shown ??= reviewItems(this.p)
      const list = this.list
      const pending = list.filter((i) => this.status(i) === 'pending')
      let items: ReviewItem[]
      if (w[1] !== 'all') {
        const one = this.item(w[1])
        expect(this.status(one), `${raw}: the row is to review`).toBe('pending')
        items = [one]
      } else if (w[0] === 'K') items = list
      else {
        const kind = w[2] ? this.item(w[2]).kind : pending[0]?.kind
        items = pending.filter((i) => i.kind === kind)
      }
      const todo = items.filter((i) => pending.some((x) => x.key === i.key))
      expect(todo.length, `${raw}: something to act on`).toBeGreaterThan(0)
      const outcome: Choice = w[0] === 'K' ? 'kept' : 'removed'
      // As ReviewPanel's act, keepAll and removeKind: one update.
      this.edit((p) => (w[0] === 'K' ? keepItems(p, items) : removeItems(p, items)), todo, outcome)
      // Acting on rows leaves every other row to review.
      for (const i of pending) if (!todo.some((x) => x.key === i.key)) expect(this.status(i), `${i.key} after "${raw}"`).toBe('pending')
    } else throw new Error(`unknown step ${raw}`)
  }

  /** Every row the user chose reads that choice, in the panel and in the project; every row still automatic reads pending; a state the store comes back to reads as before. */
  check(after: string): void {
    const now = new Set(reviewItems(this.p).map((i) => i.key))
    for (const i of this.list) {
      const want = this.choices.get(i.key)
      const got = this.status(i)
      if (want) expect(got, `${i.key} after "${after}"`).toBe(want)
      else if (now.has(i.key)) expect(got, `${i.key} after "${after}"`).toBe('pending')
      else expect(got, `${i.key} after "${after}"`).not.toBe('pending')
    }
    const recorded = new Map((this.p.autoCutOutcomes ?? []).map((o) => [`cut:${o.id}`, o.outcome]))
    expect(recorded, `the project's choices after "${after}"`).toEqual(new Map(this.choices))
    const seen = this.seen.get(this.p) ?? new Map<string, ReviewStatus>()
    for (const i of this.list) {
      const got = this.status(i)
      const was = seen.get(i.key)
      if (was) expect(got, `${i.key} back in a state after "${after}"`).toBe(was)
      seen.set(i.key, got)
    }
    this.seen.set(this.p, seen)
  }

  private edit(f: (p: Project) => Project, items: readonly ReviewItem[] = [], outcome?: Choice): void {
    const before = this.p
    this.store.update(f)
    if (this.p !== before) {
      const map = new Map(this.chosen.get(before))
      for (const i of items) map.set(i.key, outcome!)
      this.chosen.set(this.p, map)
    }
    this.follow()
  }

  /** The panel follows the project while it is open (ReviewPanel's effect). */
  private follow(): void {
    if (this.shown) this.shown = mergeSnapshot(this.shown, this.p)
  }
}

const replay = (script: string, start?: Project): Session => new Session(start).run(script)

describe('the choice made in the panel is what a row reads (scenarios of earlier review rounds)', () => {
  it('a cut removed inside a sped-up idle part, then the speed-up removed', () => {
    const s = replay('tool 5-9 2 smart-speed; tool 6-7 cut silences; open; R r1; R r0')
    expect(plays(s.p.clips)).toBe('[0,20]@1')
    expect(s.rows()).toEqual(['r0:removed', 'r1:removed'])
  })

  it('a cut inside a 4x inside a 2x: removed from the inside out, or with the 2x kept last', () => {
    const removed = replay('tool 5-15 2 smart-speed; tool 7-12 4 silences; tool 9-10 cut silences; open; R r2; R r1; R r0')
    expect(plays(removed.p.clips)).toBe('[0,20]@1')
    expect(removed.rows()).toEqual(['r0:removed', 'r1:removed', 'r2:removed'])
    const kept = replay('tool 5-15 2 smart-speed; tool 7-12 4 silences; tool 9-10 cut silences; open; R r2; R r1; K r0')
    expect(plays(kept.p.clips)).toBe('[0,5]@1 [5,15]@2 [15,20]@1')
    expect(kept.rows()).toEqual(['r0:kept', 'r1:removed', 'r2:removed'])
  })

  it('a third speed-up inside two others: the 8x kept, then the 2x and the 4x removed', () => {
    const s = replay('tool 5-15 2 smart-speed; tool 7-12 4 silences; tool 9-10 8 silences; open; K r2; R r0; R r1')
    expect(plays(s.p.clips)).toBe('[0,9]@1 [9,10]@8 [10,20]@1')
    expect(s.rows()).toEqual(['r0:removed', 'r1:removed', 'r2:kept'])
  })

  it('a speed-up made again with the panel open after one over the same footage was removed', () => {
    expect(replay('tool 5-9 2; open; R r0; tool 5-9 2; K r1').rows()).toEqual(['r0:removed', 'r1:kept'])
    expect(replay('tool 3-15 2 smart-speed; open; R r0; tool 5-9 2; K r1').rows()).toEqual(['r0:removed', 'r1:kept'])
    expect(replay('tool 5-9 4; open; R r0; tool 5-9 4; R r1').rows()).toEqual(['r0:removed', 'r1:removed'])
  })

  it('a 2x kept inside a 4x removed before, and a 4x run again over both', () => {
    const s = replay('tool 12-18 4; open; R r0; tool 14-16 2 smart-speed; K r1; tool 10-18 4')
    expect(plays(s.p.clips)).toBe('[0,10]@1 [10,18]@4 [18,20]@1')
    expect(s.rows()).toEqual(['r2:pending', 'r0:removed', 'r1:kept'])
    s.run('R r2')
    expect(plays(s.p.clips)).toBe('[0,14]@1 [14,16]@2 [16,20]@1')
    expect(s.rows()).toEqual(['r2:removed', 'r0:removed', 'r1:kept'])
    // All Polish, and the control without the 4x removed first.
    expect(replay('tool 12-18 4; open; R r0; tool 14-16 2; K r1; tool 10-18 4').rows()).toEqual(['r2:pending', 'r0:removed', 'r1:kept'])
    expect(replay('tool 14-16 2; open; K r0; tool 10-18 4').rows()).toEqual(['r1:pending', 'r0:kept'])
  })

  it('Smart speed 2x, Polish 4x inside it, Keep all, Polish 8x inside that kept: the 4x still reads kept', () => {
    const s = replay('tool 3-9 2 smart-speed; tool 4-5.5 4; open; K all; tool 4-5.5 8; K r2')
    expect(plays(s.p.clips)).toBe('[0,3]@1 [3,4]@2 [4,5.5]@8 [5.5,9]@2 [9,20]@1')
    expect(s.rows()).toEqual(['r0:kept', 'r1:kept', 'r2:kept'])
  })

  it('Polish 2x, Polish 4x over it, Ctrl+Z, K the 2x, Polish 8x over it kept: the 2x still reads kept', () => {
    const s = replay('open; tool 16.5-18.5 2; tool 13-19 4; undo; K r0; tool 16-19.5 8; K r2')
    expect(plays(s.p.clips)).toBe('[0,16]@1 [16,19.5]@8 [19.5,20]@1')
    expect(s.choices.get('cut:r0')).toBe('kept')
    expect(s.status(s.item('r0'))).toBe('kept')
    expect(s.status(s.item('r2'))).toBe('kept')
  })

  it('a speed-up an undo brings back after the panel reopened reads removed once removed', () => {
    const s = replay('tool 3-15 2 smart-speed; tool 5.5-10.5 4; open; K r0; close; open')
    expect(s.list.map((i) => i.key)).toEqual(['cut:r1'])
    s.run('undo; R r0; K r1')
    expect(plays(s.p.clips)).toBe('[0,5.5]@1 [5.5,10.5]@4 [10.5,20]@1')
    expect(s.rows()).toEqual(['r0:removed', 'r1:kept'])
    // With Polish run somewhere else after reopening and undone first (two Ctrl+Z).
    const two = replay('tool 3-15 2 smart-speed; tool 5.5-10.5 4; open; K r0; close; open; tool 16-18 2; undo; undo; R r0; K r1')
    expect(plays(two.p.clips)).toBe(plays(s.p.clips))
    expect(two.rows().filter((r) => !r.startsWith('r2'))).toEqual(['r0:removed', 'r1:kept'])
    // The same after an edit by hand that took the 2x away was undone, and with the panel never closed.
    const hand = replay('tool 3-15 2 smart-speed; tool 5.5-10.5 4; hand speed 12-14 1; open; undo; R r0; K r1')
    expect(hand.rows()).toEqual(['r0:removed', 'r1:kept'])
    expect(replay('tool 3-15 2 smart-speed; tool 5.5-10.5 4; open; R r0; K r1').rows()).toEqual(['r0:removed', 'r1:kept'])
  })

  it('Polish 4x removed, Polish 2x kept, Polish 4x over both and 8x inside that, the 8x and the second 4x removed', () => {
    const s = replay('open; tool 7-13.5 4; R r0; tool 10.5-16.5 2; K r1; tool 7-13 4; tool 9.5-11 8; R r3; R r2')
    expect(plays(s.p.clips)).toBe('[0,10.5]@1 [10.5,16.5]@2 [16.5,20]@1')
    expect(s.rows()).toEqual(['r0:removed', 'r2:removed', 'r3:removed', 'r1:kept'])
    // The second 4x removed first, then the 8x.
    const other = replay('open; tool 7-13.5 4; R r0; tool 10.5-16.5 2 smart-speed; K r1; tool 7-13 4; tool 9.5-11 8; R r2; R r3')
    expect(plays(other.p.clips)).toBe(plays(s.p.clips))
    expect(other.rows()).toEqual(['r0:removed', 'r2:removed', 'r3:removed', 'r1:kept'])
    // Without the 2x kept: it stays to review.
    const control = replay('open; tool 7-13.5 4; R r0; tool 10.5-16.5 2 smart-speed; tool 7-13 4; tool 9.5-11 8; R r3; R r2')
    expect(control.rows()).toEqual(['r0:removed', 'r2:removed', 'r3:removed', 'r1:pending'])
  })

  it('a speed-up kept after a run over it was undone, then runs at other speeds over it', () => {
    const one = replay('open; tool 16.5-18.5 2; tool 13-19 4; undo; K r0; tool 17-19.5 8; K r2; tool 16-17 4')
    expect(plays(one.p.clips)).toBe('[0,16]@1 [16,17]@4 [17,19.5]@8 [19.5,20]@1')
    expect(['r0', 'r2', 'r3'].map((id) => one.status(one.item(id)))).toEqual(['kept', 'kept', 'pending'])
    const two = replay('tool 12-17 2; open; R r0; tool 16.5-18.5 8; undo; undo; K r0; tool 11.5-17 8; K r2')
    expect(plays(two.p.clips)).toBe('[0,11.5]@1 [11.5,17]@8 [17,20]@1')
    expect(['r0', 'r2'].map((id) => two.status(two.item(id)))).toEqual(['kept', 'kept'])
  })

  it('a 4x removed, a 4x over it, an 8x over its end kept, the 4x kept, an 8x over the rest kept', () => {
    const removed = replay('open; tool 9-15.5 4; R r0; tool 8.5-15.5 4; tool 14.5-15.5 8; K r2; K r1; tool 8.5-14.5 8; K r3')
    expect(plays(removed.p.clips)).toBe('[0,8.5]@1 [8.5,15.5]@8 [15.5,20]@1')
    expect(removed.rows().sort()).toEqual(['r0:removed', 'r1:kept', 'r2:kept', 'r3:kept'])
    // The same with the first 4x kept.
    const kept = replay('open; tool 9-15.5 4; K r0; tool 8.5-15.5 4; tool 14.5-15.5 8; K r2; K r1; tool 8.5-14.5 8; K r3')
    expect(kept.rows().sort()).toEqual(['r0:kept', 'r1:kept', 'r2:kept', 'r3:kept'])
    // A 4x removed, a 4x over most of it, an 8x over its end kept, then the 4x kept.
    const other = replay('tool 9-16 4; open; R r0; tool 8.5-15.5 4; tool 14.5-16 8; K r2; K r1')
    expect(plays(other.p.clips)).toBe('[0,8.5]@1 [8.5,14.5]@4 [14.5,16]@8 [16,20]@1')
    expect(other.rows().sort()).toEqual(['r0:removed', 'r1:kept', 'r2:kept'])
  })

  it('a speed-up removed still reads removed after one made over it at its speed has a faster one kept inside', () => {
    const s = replay('tool 5.5-12.5 2; open; R r0; tool 11-16.5 2 smart-speed; tool 11-11.5 4; K r2')
    expect(plays(s.p.clips)).toBe('[0,11]@1 [11,11.5]@4 [11.5,16.5]@2 [16.5,20]@1')
    expect(s.rows()).toEqual(['r0:removed', 'r2:kept', 'r1:pending'])
  })

  it('an 8x over a 4x kept earlier and a 2x: the 8x and then the 2x removed', () => {
    const s = replay('tool 7.5-13.5 4; open; K all; tool 14.5-18.5 2 smart-speed; tool 10-15.5 8; R r2; R r1')
    expect(plays(s.p.clips)).toBe('[0,7.5]@1 [7.5,13.5]@4 [13.5,20]@1')
    expect(s.rows()).toEqual(['r0:kept', 'r2:removed', 'r1:removed'])
  })

  it('silences at 4x and 8x inside an idle part at 2x, removed a kind at a time; a cut in place of the 8x, removed one by one', () => {
    const all = replay('tool 3-15 2 smart-speed; tool 5.25-10.75 4 silences; tool 5.5-10.5 8 silences; open; R all r0; R all r1')
    expect(plays(all.p.clips)).toBe('[0,20]@1')
    expect(all.rows()).toEqual(['r0:removed', 'r1:removed', 'r2:removed'])
    expect(pendingCount(all.p)).toBe(0)
    const cut = replay('tool 3-15 2 smart-speed; tool 5.25-10.75 4 silences; tool 5.5-10.5 cut silences; open; R r2; R r1; R r0')
    expect(plays(cut.p.clips)).toBe('[0,20]@1')
    expect(cut.rows()).toEqual(['r0:removed', 'r1:removed', 'r2:removed'])
  })

  it('two histories that leave the same footage and records read what each user chose', () => {
    // Polish 2x removed, then a 4x over it removed; or Polish 2x, a 4x over it undone, the 2x kept.
    // Then the same runs and a Keep: clips and records come out the same, the choices do not.
    const removed = replay('open; tool 11.5-12.5 2; R r0; tool 10-15.5 4; R r1; tool 10.5-15 2; tool 11-13.5 4; K r3')
    const kept = replay('open; tool 11.5-12.5 2; tool 10-15.5 4; undo; K r0; tool 10.5-15 2; tool 11-13.5 4; K r3')
    expect(plays(kept.p.clips)).toBe(plays(removed.p.clips))
    expect(kept.p.autoCuts).toEqual(removed.p.autoCuts)
    expect(removed.status(removed.item('r0'))).toBe('removed')
    expect(kept.status(kept.item('r0'))).toBe('kept')
    expect(removed.status(removed.item('r3'))).toBe('kept')
    expect(kept.status(kept.item('r3'))).toBe('kept')
  })
})

describe('undo and redo of each action', () => {
  /** Smart speed at 2x over [3,15], Polish at 4x inside it and a Polish cut after it; the panel open. */
  const start = 'tool 3-15 2 smart-speed; tool 5.5-10.5 4; tool 16-17 cut; open'

  it.each([
    ['Keep', 'K r1', ['r0:pending', 'r1:kept', 'r2:pending']],
    ['Remove', 'R r1', ['r0:pending', 'r1:removed', 'r2:pending']],
    ['Keep on a cut', 'K r2', ['r0:pending', 'r1:pending', 'r2:kept']],
    ['Remove on a cut', 'R r2', ['r0:pending', 'r1:pending', 'r2:removed']],
    ['Keep all', 'K all', ['r0:kept', 'r1:kept', 'r2:kept']],
    ['Remove all of a kind', 'R all r1', ['r0:pending', 'r1:removed', 'r2:removed']],
    ['Remove all of another kind', 'R all r0', ['r0:removed', 'r1:pending', 'r2:pending']]
  ])('%s is one undo step: the rows go back to pending, and forward again', (_name, action, after) => {
    const s = replay(start)
    const before = s.p
    s.run(action)
    const done = s.p
    expect(s.rows()).toEqual(after)
    s.run('undo')
    expect(s.p).toBe(before)
    expect('autoCutOutcomes' in s.p).toBe(false)
    expect(s.rows()).toEqual(['r0:pending', 'r1:pending', 'r2:pending'])
    s.run('redo')
    expect(s.p).toBe(done)
    expect(s.rows()).toEqual(after)
    // Undone and done again by hand: the same rows.
    s.run('undo')
    s.run(action)
    expect(s.rows()).toEqual(after)
  })

  it('several choices are undone one at a time, the latest first', () => {
    const s = replay(`${start}; K r2; R r1; K r0`)
    expect(s.rows()).toEqual(['r0:kept', 'r1:removed', 'r2:kept'])
    s.run('undo')
    expect(s.rows()).toEqual(['r0:pending', 'r1:removed', 'r2:kept'])
    s.run('undo')
    expect(s.rows()).toEqual(['r0:pending', 'r1:pending', 'r2:kept'])
    s.run('redo; redo')
    expect(s.rows()).toEqual(['r0:kept', 'r1:removed', 'r2:kept'])
    // A different choice after an undo replaces the one undone.
    s.run('undo; R r0')
    expect(s.rows()).toEqual(['r0:removed', 'r1:removed', 'r2:kept'])
    expect(s.p.autoCutOutcomes).toEqual([
      { id: 'r2', outcome: 'kept' },
      { id: 'r1', outcome: 'removed' },
      { id: 'r0', outcome: 'removed' }
    ])
  })
})

describe('reopening the panel', () => {
  it('lists only what is still automatic; an undo brings a row back to review', () => {
    const s = replay('tool 3-15 2 smart-speed; tool 5.5-10.5 4; tool 16-17 cut; open; K r1; R r2; close; open')
    expect(s.list.map((i) => i.key)).toEqual(['cut:r0'])
    expect(pendingCount(s.p)).toBe(1)
    s.run('undo')
    expect(s.rows()).toEqual(['r0:pending', 'r2:pending'])
    s.run('undo')
    expect(s.rows()).toEqual(['r0:pending', 'r1:pending', 'r2:pending'])
    s.run('redo')
    expect(s.rows()).toEqual(['r0:pending', 'r1:kept', 'r2:pending'])
    s.run('R r2; K r0')
    expect(s.rows()).toEqual(['r0:kept', 'r1:kept', 'r2:removed'])
    s.run('close; open')
    expect(s.list).toEqual([])
  })
})

describe('edits by hand after a choice', () => {
  it('a cut kept and then put back by hand still reads kept; one removed and cut again by hand still reads removed', () => {
    const kept = replay('tool 5-9 cut; open; K r0; hand restore 5-9')
    expect(plays(kept.p.clips)).toBe('[0,20]@1')
    expect(kept.rows()).toEqual(['r0:kept'])
    const removed = replay('tool 5-9 cut; open; R r0; hand cut 5-9')
    expect(plays(removed.p.clips)).toBe('[0,5]@1 [9,20]@1')
    expect(removed.rows()).toEqual(['r0:removed'])
  })

  it('a speed-up removed and then sped up again by hand still reads removed; one kept and slowed by hand still reads kept', () => {
    expect(replay('tool 5-9 2; open; R r0; hand speed 5-9 2').rows()).toEqual(['r0:removed'])
    expect(replay('tool 5-9 2; open; K r0; hand speed 5-9 1').rows()).toEqual(['r0:kept'])
    // Nor does a later run over the same footage change it: it is listed as a new row.
    expect(replay('tool 5-9 2; open; K r0; tool 4-10 4').rows()).toEqual(['r1:pending', 'r0:kept'])
  })

  it('a choice in a project file wins over a record still there: not listed, not acted on again', () => {
    const p = base()
    const rec: AutoCut = { id: 'x', by: 'silences', action: 'cut', start: 5, end: 9, was: [{ start: 5, end: 9, speed: 1 }] }
    const opened = { ...p, clips: [{ id: 'a', start: 0, end: 5, speed: 1 }, { id: 'b', start: 9, end: 20, speed: 1 }], autoCuts: [rec], autoCutOutcomes: [{ id: 'x', outcome: 'removed' as const }] }
    expect(reviewItems(opened)).toEqual([])
    const item = reviewItems({ ...opened, autoCutOutcomes: undefined })[0]
    expect(reviewStatus(opened, item)).toBe('removed')
    expect(keepItems(opened, [item])).toBe(opened)
    expect(removeItems(opened, [item])).toBe(opened)
  })
})

describe('with no choice made, a row whose record went reads removed when its change was gone from the video then', () => {
  it('an undone run: removed, and pending again after redo', () => {
    const cut = replay('open; tool 5-9 cut; undo')
    expect(cut.rows()).toEqual(['r0:removed'])
    expect(cut.run('redo').rows()).toEqual(['r0:pending'])
    expect(replay('open; tool 5-9 2; undo').rows()).toEqual(['r0:removed'])
  })

  it('runs undone from the inside out: a cut and a speed-up inside an idle part both read removed', () => {
    expect(replay('open; tool 3-15 2 smart-speed; tool 6-7 cut; undo; undo').rows()).toEqual(['r0:removed', 'r1:removed'])
    expect(replay('open; tool 3-15 2 smart-speed; tool 5.5-10.5 4; undo; undo').rows()).toEqual(['r0:removed', 'r1:removed'])
    // Only the inner one undone: the idle part is still to review.
    expect(replay('open; tool 3-15 2 smart-speed; tool 5.5-10.5 4; undo').rows()).toEqual(['r0:pending', 'r1:removed'])
  })

  it('a cut put back by hand: removed when all of it plays again, at any speed; kept when part of it is still cut', () => {
    expect(replay('tool 5-9 cut; open; hand restore 5-9').rows()).toEqual(['r0:removed'])
    expect(replay('tool 5-9 cut; open; hand restore 5-7').rows()).toEqual(['r0:kept'])
    // A trim or cut by hand that takes in an automatic cut makes it the user's.
    const trimmed = replay('tool 17-18 cut; open; hand cut 16-17')
    expect(trimmed.p.autoCuts).toBeUndefined()
    expect(trimmed.rows()).toEqual(['r0:kept'])
  })

  it('a speed-up edited by hand: removed when none of it plays at its speed, kept while some still does', () => {
    expect(replay('tool 5-9 2; open; hand speed 5-9 1').rows()).toEqual(['r0:removed'])
    expect(replay('tool 5-9 2; open; hand speed 5-9 4').rows()).toEqual(['r0:removed'])
    expect(replay('tool 5-9 2; open; hand cut 4-10').rows()).toEqual(['r0:removed'])
    expect(replay('tool 5-9 2; open; hand speed 6-7 1').rows()).toEqual(['r0:kept'])
    // Undone, the edit by hand gives the row back to review.
    expect(replay('tool 5-9 2; open; hand speed 5-9 1; undo').rows()).toEqual(['r0:pending'])
  })

  it('a speed-up a later run took over reads removed, whatever is chosen for the new one', () => {
    const s = replay('tool 5-9 2; open; tool 4-10 4')
    expect(s.p.autoCuts?.map((c) => c.id)).toEqual(['r1'])
    expect(s.rows()).toEqual(['r1:pending', 'r0:removed'])
    expect(replay('tool 5-9 2; open; tool 4-10 4; R r1').rows()).toEqual(['r1:removed', 'r0:removed'])
    expect(replay('tool 5-9 2; open; tool 4-10 4; K r1').rows()).toEqual(['r1:kept', 'r0:removed'])
    // Taken over by a cut, the same.
    expect(replay('tool 5-9 2; open; tool 4-10 cut').rows()).toEqual(['r1:pending', 'r0:removed'])
  })

  it('Polish undone and run again with the panel open: the rows of the first run still read removed', () => {
    // Two silences sped up at 4x, Ctrl+Z, the same Polish again: each silence is listed twice.
    const same = replay('open; tool 2-4,8-10 4; undo; tool 2-4,8-10 4')
    expect(plays(same.p.clips)).toBe('[0,2]@1 [2,4]@4 [4,8]@1 [8,10]@4 [10,20]@1')
    expect(same.rows()).toEqual(['r0:removed', 'r2:pending', 'r1:removed', 'r3:pending'])
    expect(replay('open; tool 2-4,8-10 cut; undo; tool 2-4,8-10 cut').rows()).toEqual(['r0:removed', 'r2:pending', 'r1:removed', 'r3:pending'])
    // With the padding a little wider or narrower, or over part of the same footage.
    expect(replay('open; tool 2-4,8-10 4; undo; tool 1.9-4.1,7.9-10.1 4').rows()).toEqual(['r2:pending', 'r0:removed', 'r3:pending', 'r1:removed'])
    expect(replay('open; tool 2-4,8-10 4; undo; tool 2.1-3.9,8.1-9.9 4').rows()).toEqual(['r0:removed', 'r2:pending', 'r1:removed', 'r3:pending'])
    expect(replay('open; tool 17.5-20 4; undo; tool 19.5-20 4').rows()).toEqual(['r0:removed', 'r1:pending'])
    // Keep or Remove on the new rows, undo and redo leave the first run's rows as they read.
    const acted = replay('open; tool 2-4,8-10 4; undo; tool 2-4,8-10 4; K r2; R r3; undo; undo; redo')
    expect(acted.rows()).toEqual(['r0:removed', 'r2:kept', 'r1:removed', 'r3:pending'])
    // Run again and undone in turn: removed too; redo makes them pending again.
    const twice = replay('open; tool 2-4,8-10 4; undo; tool 2-4,8-10 4; undo')
    expect(twice.rows()).toEqual(['r0:removed', 'r2:removed', 'r1:removed', 'r3:removed'])
    expect(twice.run('redo').rows()).toEqual(['r0:removed', 'r2:pending', 'r1:removed', 'r3:pending'])
  })

  it('a row whose record went reads what it read then while the panel stays open, as a choice does', () => {
    // Made the user's by hand (part slowed, part put back), then a later run over it or more by hand.
    expect(replay('tool 5-9 2; open; hand speed 6-7 1; tool 4-10 4').rows()).toEqual(['r1:pending', 'r0:kept'])
    expect(replay('tool 5-9 cut; open; hand restore 5-7; hand restore 7-9').rows()).toEqual(['r0:kept'])
    // Undone, it is to review again; done again, it reads the same.
    expect(replay('tool 5-9 cut; open; hand restore 5-7; hand restore 7-9; undo; undo').rows()).toEqual(['r0:pending'])
    expect(replay('tool 5-9 cut; open; hand restore 5-7; hand restore 7-9; undo; undo; redo; redo').rows()).toEqual(['r0:kept'])
    // Reopened, the panel lists only what is still automatic.
    expect(replay('open; tool 2-4 4; undo; close; open').rows()).toEqual([])
  })
})

describe('a speed-up that goes with no choice made leaves the records inside it as its row reads', () => {
  // Polish 2x over [10,20], Smart speed 4x over [12,14] inside it, a retake cut over [13,15].
  const nested = 'tool 10-20 2; tool 12-14 4 smart-speed; tool 13-15 cut retake; open'

  it('the 4x set back to 2x by hand reads removed: removing the cut brings its footage back at 2x and the 2x stays to review', () => {
    const s = replay(`${nested}; hand speed 12-13 2`)
    expect(s.p.autoCuts?.map((c) => c.id)).toEqual(['r0', 'r2'])
    expect(s.rows()).toEqual(['r0:pending', 'r1:removed', 'r2:pending'])
    s.run('R r2')
    expect(plays(s.p.clips)).toBe('[0,10]@1 [10,20]@2')
    expect(s.rows()).toEqual(['r0:pending', 'r1:removed', 'r2:removed'])
    // As if the 4x had been removed in the panel.
    const panel = replay(`${nested}; R r1; R r2`)
    expect(plays(panel.p.clips)).toBe(plays(s.p.clips))
    // Undone, the 4x is back and the cut holds its footage at 4x again.
    s.run('undo; undo')
    expect(s.rows()).toEqual(['r0:pending', 'r1:pending', 'r2:pending'])
    s.run('R r2')
    expect(plays(s.p.clips)).toBe('[0,10]@1 [10,12]@2 [12,14]@4 [14,20]@2')
  })

  it('a 4x that still plays at 4x outside the 2x reads kept: the 2x gives up its part, as Keep does, and stays to review', () => {
    // Polish 2x over [5,15], Smart speed 4x over [10,20], a retake cut over [11,13]; the part of the
    // 4x inside the 2x set to 2x by hand.
    const s = replay('tool 5-15 2; tool 10-20 4 smart-speed; tool 11-13 cut retake; open; hand speed 10-15 2')
    expect(s.rows()).toEqual(['r0:pending', 'r1:kept', 'r2:pending'])
    s.run('R r2')
    expect(plays(s.p.clips)).toBe('[0,5]@1 [5,11]@2 [11,13]@4 [13,15]@2 [15,20]@4')
    expect(s.rows()).toEqual(['r0:pending', 'r1:kept', 'r2:removed'])
    s.run('R r0')
    expect(plays(s.p.clips)).toBe('[0,10]@1 [10,11]@2 [11,13]@4 [13,15]@2 [15,20]@4')
  })

  it('a 4x part of which is slowed by hand reads kept: a cut inside it still comes back at 4x', () => {
    const s = replay('tool 5-15 4; tool 8-9 cut filler; open; hand speed 5-6 1; R r1')
    expect(plays(s.p.clips)).toBe('[0,6]@1 [6,15]@4 [15,20]@1')
    expect(s.rows()).toEqual(['r0:kept', 'r1:removed'])
  })
})

describe('every reviewed row reads what was chosen, in any order (nested runs)', () => {
  type Layer = [number, number, AutoCut['action'], AutoCutSource]
  /** The clips when only the layers of `keep` stay: the innermost (latest) kept layer over a part wins. */
  function expected(layers: Layer[], keep: boolean[]): string {
    const xs = [...new Set([0, 20, ...layers.flatMap(([a, b]) => [a, b])])].sort((x, y) => x - y)
    const clips: Clip[] = []
    for (let i = 0; i + 1 < xs.length; i++) {
      const mid = (xs[i] + xs[i + 1]) / 2
      let speed: AutoCut['action'] | 1 = 1
      for (let k = 0; k < layers.length; k++) {
        const [a, b, action] = layers[k]
        if (keep[k] && mid > a && mid < b) speed = action
      }
      if (speed !== 'cut') clips.push({ id: 'x', start: xs[i], end: xs[i + 1], speed })
    }
    return plays(clips)
  }
  const orders = (n: number): number[][] =>
    n <= 1 ? [[0]] : orders(n - 1).flatMap((o) => Array.from({ length: n }, (_, k) => [...o.slice(0, k), n - 1, ...o.slice(k)]))
  const sets: [string, Layer[]][] = [
    ['2x and 4x inside', [[5, 15, 2, 'smart-speed'], [7, 12, 4, 'silences']]],
    ['2x, 4x and 8x', [[5, 15, 2, 'smart-speed'], [7, 12, 4, 'silences'], [9, 10, 8, 'polish']]],
    ['a cut inside the 4x', [[5, 15, 2, 'smart-speed'], [7, 12, 4, 'silences'], [9, 10, 'cut', 'filler']]],
    ['a cut in the 2x beside the 4x', [[5, 15, 2, 'smart-speed'], [7, 9, 4, 'silences'], [12, 13, 'cut', 'filler']]],
    ['siblings', [[3, 17, 2, 'smart-speed'], [5, 8, 4, 'silences'], [10, 14, 8, 'silences']]],
    ['straddling out', [[5, 12, 2, 'smart-speed'], [10, 15, 4, 'silences'], [11, 14, 8, 'polish']]],
    ['an 8x across the 4x', [[3, 17, 2, 'smart-speed'], [6, 10, 4, 'silences'], [9, 12, 8, 'polish']]],
    ['four levels', [[3, 17, 1.5 as AutoCut['action'], 'smart-speed'], [5, 15, 2, 'silences'], [7, 13, 4, 'polish'], [9, 11, 8, 'silences']]],
    ['three levels and a cut', [[5, 15, 2, 'smart-speed'], [7, 12, 4, 'silences'], [8, 11, 8, 'polish'], [9, 10, 'cut', 'filler']]]
  ]

  it.each(sets)('%s: one at a time in every order, or the removed ones and then Keep all', (_name, layers) => {
    const setup = layers.map(([a, b, action, by]) => `tool ${a}-${b} ${action} ${by}`).join('; ')
    const made = replay(`${setup}; open`)
    expect(made.list).toHaveLength(layers.length)
    const n = layers.length
    let runs = 0
    for (let mask = 0; mask < 1 << n; mask++) {
      const keep = layers.map((_, k) => !!(mask & (1 << k)))
      const how = (k: number): string => (keep[k] ? 'K' : 'R')
      const kept = (k: number): string => (keep[k] ? 'kept' : 'removed')
      for (const order of orders(n)) {
        const s = replay(`${setup}; open; ${order.map((k) => `${how(k)} r${k}`).join('; ')}`)
        expect(plays(s.p.clips)).toBe(expected(layers, keep))
        expect(s.rows().sort()).toEqual(layers.map((_, k) => `r${k}:${kept(k)}`).sort())
        expect(pendingCount(s.p)).toBe(0)
        expect(s.p.autoCuts).toBeUndefined()
        runs++
      }
      const removed = layers.flatMap((_, k) => (keep[k] ? [] : [`R r${k}`]))
      const s = replay([setup, 'open', ...removed, ...(removed.length < n ? ['K all'] : [])].join('; '))
      expect(plays(s.p.clips)).toBe(expected(layers, keep))
      expect(s.rows().sort()).toEqual(layers.map((_, k) => `r${k}:${kept(k)}`).sort())
      expect(s.p.autoCuts).toBeUndefined()
    }
    expect(runs).toBe((1 << n) * orders(n).length)
  })
})

describe('random histories', () => {
  // Tool runs over random and nested ranges, Keep and Remove (one row, Keep all, Remove all), undo,
  // redo, closing and reopening the panel and edits by hand: after every step each row the user
  // chose reads that choice (Session.check), and the project holds exactly those choices.
  function history(seed: number, steps: number, actions: AutoCut['action'][], hand: boolean): void {
    let x = seed
    const rnd = (): number => {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      return ((x >>> 0) % 1000000) / 1000000
    }
    const half = (t: number): number => Math.round(t * 2) / 2
    const s = new Session()
    const range = (): [number, number] => {
      const recs = [...(s.p.autoCuts ?? []), ...s.list.flatMap((i) => (i.cut ? [i.cut] : []))]
      if (recs.length && rnd() < 0.6) {
        const c = recs[Math.floor(rnd() * recs.length)]
        const a = Math.max(0, half(c.start + rnd() * (c.end - c.start) - (rnd() < 0.2 ? 1 : 0)))
        const b = Math.min(20, Math.max(half(a + 0.5 + rnd() * (c.end - a) + (rnd() < 0.2 ? 1.5 : 0)), a + 0.5))
        return [a, b]
      }
      const a = Math.floor(rnd() * 38) / 2
      return [a, Math.min(20, a + 0.5 + Math.floor(rnd() * 16) / 2)]
    }
    const script: string[] = []
    for (let k = 0; k < steps; k++) {
      const r = rnd()
      let raw = ''
      if (r < 0.4) {
        const [a, b] = range()
        raw = `tool ${a}-${b} ${actions[Math.floor(rnd() * actions.length)]}`
      } else if (r < 0.49) raw = s.store.canUndo ? 'undo' : ''
      else if (r < 0.53) raw = s.store.canRedo ? 'redo' : ''
      else if (r < 0.59) raw = s.shown ? 'close' : 'open'
      else if (hand && r < 0.65) {
        const [a, b] = range()
        raw = rnd() < 0.6 ? `hand speed ${a}-${b} ${[1, 1, 2, 4][Math.floor(rnd() * 4)]}` : `hand cut ${a}-${b}`
      } else {
        if (!s.shown) {
          s.step('open')
          script.push('open')
        }
        const pending = s.list.filter((i) => s.status(i) === 'pending')
        if (pending.length) {
          const how = rnd() < 0.5 ? 'K' : 'R'
          raw = rnd() < 0.15 ? `${how} all` : `${how} ${pending[Math.floor(rnd() * pending.length)].cut!.id}`
        }
      }
      if (!raw) continue
      script.push(raw)
      try {
        s.step(raw)
        s.check(raw)
      } catch (e) {
        throw new Error(`${(e as Error).message}\n  history: ${script.join('; ')}`)
      }
    }
  }

  it.each([
    ['speed-ups', 1, [2, 4, 8], false],
    ['speed-ups and cuts', 2, [2, 4, 8, 'cut'], false],
    ['speed-ups and edits by hand', 3, [2, 4, 8], true],
    ['speed-ups, cuts and edits by hand', 4, [2, 4, 8, 'cut'], true]
  ] as const)('%s', (_name, seed, actions, hand) => {
    for (let k = 0; k < 120; k++) history(seed * 7919 + k * 104729, 16, [...actions], hand)
  })
})
