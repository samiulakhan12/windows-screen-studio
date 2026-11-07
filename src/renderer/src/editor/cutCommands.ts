/**
 * The cut commands (docs/design/editing-polish.md §2.1, §2.8): Smooth all cuts, Use hard cuts
 * everywhere, Go to next cut, Go to previous cut, Play this cut. The palette, the Clip tab's
 * buttons and the timeline's markers run the same handlers. Each edit is one store.update.
 */
import { ALREADY_SMOOTH, cutOf, HARD_EVERYWHERE, NO_CUT_AFTER, NO_CUT_BEFORE, NO_CUTS, smoothedNotice } from '../../../shared/editor/cutsCopy'
import type { EditStore } from '../../../shared/editor/editStore'
import { cutAt, cutCount, cutNumber, hardCutsEverywhere, nextCutAfter, prevCutBefore, smoothAllCuts } from '../../../shared/editor/joinsEdit'
import type { Project } from '../../../shared/types'
import type { Selection } from './selection'

export interface CutCommandDeps {
  store: Pick<EditStore<Project>, 'state' | 'update'>
  player: { readonly time: number; seek(t: number): void; playCut(video: number): void }
  /** Shows the Clip tab. */
  reveal(): void
  /** Selects a cut (its Cut style section opens). */
  select(sel: Selection): void
  selection(): Selection
  /** The transport's live region. */
  notice(message: string): void
  /** " · Ctrl + Z to undo" (undoHint), or ''. */
  undo(): string
}

/** Every cut set to Smooth, in one update, with its notice ("Smoothed 34 cuts · 3 keep their own style · Ctrl + Z to undo"). */
export function runSmoothAllCuts(store: CutCommandDeps['store'], notice: (m: string) => void, undo: string): void {
  if (cutCount(store.state) === 0) return notice(NO_CUTS)
  const r = smoothAllCuts(store.state)
  if (r.project === store.state) return notice(ALREADY_SMOOTH)
  store.update((p) => smoothAllCuts(p).project)
  notice(smoothedNotice(r.changed, r.kept, undo))
}

/** Moves the playhead to the cut `gap` (B's start) and selects it, which opens its Cut style; announced as "Cut 6 of 37". */
export function goToCut(d: CutCommandDeps, gap: { start: number; end: number }): void {
  d.player.seek(gap.end)
  d.select({ kind: 'gap', start: gap.start, end: gap.end })
  d.reveal()
  const n = cutNumber(d.store.state, gap.end)
  if (n) d.notice(cutOf(n.n, n.of))
}

/** Where the cut commands start from: the selected cut, else the playhead. */
function from(d: CutCommandDeps): number {
  const sel = d.selection()
  return sel?.kind === 'gap' && cutAt(d.store.state, sel.end) ? sel.end : d.player.time
}

/** The handlers of the five cut commands. */
export function cutCommands(d: CutCommandDeps): Record<'smoothAllCuts' | 'hardCutsEverywhere' | 'nextCut' | 'previousCut' | 'playCut', () => void> {
  return {
    smoothAllCuts: () => {
      d.reveal()
      runSmoothAllCuts(d.store, d.notice, d.undo())
    },
    hardCutsEverywhere: () => {
      d.reveal()
      if (cutCount(d.store.state) === 0) return d.notice('This video has no cuts')
      const before = d.store.state
      d.store.update(hardCutsEverywhere)
      d.notice(d.store.state === before ? HARD_EVERYWHERE : `${HARD_EVERYWHERE}${d.undo()}`)
    },
    nextCut: () => {
      const gap = nextCutAfter(d.store.state, from(d))
      if (!gap) return d.notice(NO_CUT_AFTER)
      goToCut(d, gap)
    },
    previousCut: () => {
      const gap = prevCutBefore(d.store.state, from(d))
      if (!gap) return d.notice(NO_CUT_BEFORE)
      goToCut(d, gap)
    },
    playCut: () => {
      const project = d.store.state
      const sel = d.selection()
      // The selected cut, else the one at or after the playhead, else the last one before it.
      const gap = sel?.kind === 'gap' && cutAt(project, sel.end) ? sel : (nextCutAfter(project, d.player.time - 2e-6) ?? prevCutBefore(project, d.player.time))
      const cut = gap ? cutAt(project, gap.end) : null
      if (!cut) return d.notice('This video has no cuts')
      d.player.playCut(cut.video)
    }
  }
}
