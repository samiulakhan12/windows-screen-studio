import { displayTime } from '../../../shared/editor/clips'
import { chapterNear, createChapter, createTitleCard, nextChapterName, titleTimesAt } from '../../../shared/editor/titles'
import { chapterInVideo } from '../../../shared/render/chapters'
import { speedAt } from '../../../shared/render/overlays'
import { TITLE_FADE } from '../../../shared/render/titleCards'
import type { Chapter, Clip, TitleCard } from '../../../shared/types'
import type { EditorServices } from './context'
import type { PreviewPlayer } from './player'
import type { Selection } from './selection'

/*
 * Adding title cards and chapters at the playhead: the one code path for the Text panel, the
 * title track of the timeline and the editor's commands (palette and shortcuts).
 */

interface AddOptions {
  /** Source time to add at (where the timeline was double-clicked); the playhead by default. */
  at?: number
  onSelect: (sel: Selection) => void
  /** Says why nothing was added. */
  onNotice?: (message: string) => void
}

/** Moves the playhead into `card`, just past its fade-in, unless the preview already shows it fully. */
export function showTitle(player: PreviewPlayer, clips: Clip[], card: { start: number; end: number }): void {
  const fade = Math.min(TITLE_FADE * speedAt(clips, card.start), (card.end - card.start) / 2)
  const lo = card.start + fade + 0.01
  const hi = card.end - fade - 0.01
  if (player.time >= lo && player.time <= hi) return
  player.seek(lo <= hi ? lo : (card.start + card.end) / 2)
}

/**
 * Adds a title card starting at the playhead (on the frame the preview shows there: in a cut,
 * the next kept one), inside the kept part of the recording, selects it and shows it.
 */
export function addTitleAt({ store, player }: EditorServices, opts: AddOptions): TitleCard {
  const p = store.state
  const t = displayTime(p.clips, opts.at ?? player.time)
  const card = createTitleCard(t, p.duration, titleTimesAt(t, p))
  store.update((q) => ({ ...q, titles: [...(q.titles ?? []), card] }))
  opts.onSelect({ kind: 'title', id: card.id })
  showTitle(player, p.clips, card)
  return card
}

/**
 * Adds a chapter at the playhead (on the frame the preview shows) and selects it. Where there is
 * one already, that one is selected instead; at the very end of the video nothing is added.
 */
export function addChapterAt({ store, player }: EditorServices, opts: AddOptions): Chapter | null {
  const p = store.state
  const chapters = p.chapters ?? []
  const t = displayTime(p.clips, opts.at ?? player.time)
  const near = chapterNear(chapters, t)
  if (near) {
    opts.onSelect({ kind: 'chapter', id: near.id })
    opts.onNotice?.(`"${near.title}" already starts here, so it is selected instead`)
    return near
  }
  if (!chapterInVideo(p.clips, t)) {
    opts.onNotice?.('A chapter needs some video after it: move the playhead back from the end')
    return null
  }
  const chapter = createChapter(t, nextChapterName(chapters))
  store.update((q) => ({ ...q, chapters: [...(q.chapters ?? []), chapter] }))
  opts.onSelect({ kind: 'chapter', id: chapter.id })
  return chapter
}
