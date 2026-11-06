/**
 * The Captions commands of the palette (docs/design/captions-studio.md §2.14): each opens its tab
 * and does what its section's button does, with the same undo step and notice.
 */
import { readGreatOptions, resolveGreatOptions } from '../../../shared/captions/great'
import { readCleanupChoices, tidyCaptions } from '../../../shared/captions/cleanup'
import { readWordList } from '../../../shared/captions/captionPrefs'
import { pickEmphasis } from '../../../shared/captions/emphasis'
import { withAutoTwin } from '../../../shared/captions/marks'
import { planGraphics } from '../../../shared/captions/graphicRules'
import { captionsOf } from '../../../shared/captions/settings'
import { legacyTwin } from '../../../shared/captions/studioEdit'
import type { EditStore } from '../../../shared/editor/editStore'
import type { Project } from '../../../shared/types'
import { requestCaptions, type CaptionsRequest } from './captionItems'
import { loadSavedLooks, nextLookName, saveLook } from './captionPresets'
import { startCaptionsGreat } from './captionsGreat'
import { addedNotice, madeCount } from './panels/GraphicsPanel'
import { focusGallery } from './panels/CaptionGallery'

export type CaptionCommandId = 'captionsGreat' | 'captionStyles' | 'captionEmphasis' | 'captionGraphics' | 'captionTidy' | 'captionLanguage' | 'saveCaptionStyle'

export interface CaptionCommandDeps {
  store: EditStore<Project>
  setTab(tab: 'captions' | 'graphics'): void
  notice(message: string): void
  /** The project's output frame now. */
  frame(): { w: number; h: number }
  /** " · Ctrl + Z to undo" with the user's keys (undoHint), for a notice after a big change. */
  undo?(): string
  /** ". Review (Shift + R)" with the user's keys (reviewHint), for a notice after automatic changes. */
  review?(): string
}

const words = (n: number): string => `${n} ${n === 1 ? 'word' : 'words'}`
/** Words marked by `marks`. */
const marked = (marks: Project['captionMarks']): number => (marks ?? []).reduce((n, m) => n + (m.to - m.from + 1), 0)

/**
 * Find important words (§2.7): the offline picks for captions without emphasis, one undo step; on
 * a Classic look its Studio twin in the same step (emphasis buttons do not set `picked`), recorded
 * so Review's Remove of the picks takes it away again (withAutoTwin).
 */
export function findImportantWords(store: EditStore<Project>, notice: (message: string) => void): void {
  let added = 0
  store.update((p) => {
    const marks = pickEmphasis(p)
    added = marked(marks)
    if (!marks.length) return p
    return withAutoTwin({ ...p, captionMarks: [...(p.captionMarks ?? []), ...marks] })
  })
  notice(added ? `Emphasised ${words(added)}` : 'No words stood out')
}

/** Add pop-ups from captions with Make my captions great's options as they resolve for the project (§2.11): one undo step. */
export async function generatePopUps(deps: CaptionCommandDeps): Promise<void> {
  const options = readGreatOptions(await window.api.getPref('captionsGreat').catch(() => null))
  const before = deps.store.state
  const o = resolveGreatOptions(options, before, deps.frame())
  deps.store.seal()
  deps.store.update((p) => planGraphics(p, { keywords: o.keywords, emoji: o.emoji, counters: o.counters, lists: o.lists, speakers: o.speakers, chapters: o.chapters, quotes: false, sound: o.sound }))
  deps.store.seal()
  deps.notice(addedNotice(madeCount(before, deps.store.state)))
}

/** Tidy captions (§2.9) with the saved Clean up choices and the word list, without the AI fix: one undo step. */
export async function tidyFromCommand(deps: CaptionCommandDeps): Promise<void> {
  const [choices, list] = await Promise.all([window.api.getPref('captionCleanup').catch(() => null), window.api.getPref('captionWordList').catch(() => null)])
  // The AI fix stays off here (it waits for a provider); tidyCaptions's options type joins the
  // choices' `ai: boolean` with the fix's answer `ai?: TextResult`, so the choices go in as they are.
  const opts = { ...readCleanupChoices(choices), ai: false, words: readWordList(list) } as unknown as Parameters<typeof tidyCaptions>[1]
  let changed = 0
  let bleeped = 0
  deps.store.update((p) => {
    const r = tidyCaptions(p, opts)
    changed = r.changed
    bleeped = r.bleeped
    return r.project
  })
  deps.notice(changed || bleeped ? `Tidied ${changed} ${changed === 1 ? 'caption' : 'captions'}${bleeped ? `, bleeped ${words(bleeped)}` : ''}` : 'Nothing to tidy')
}

/** Save caption style as mine (§2.14): the current look (a Classic look's twin) as the next "My style n". */
export async function saveCurrentLook(deps: CaptionCommandDeps): Promise<void> {
  const saved = await loadSavedLooks()
  const c = captionsOf(deps.store.state)
  try {
    const entry = await saveLook(nextLookName(saved), c.studio ?? legacyTwin(c))
    deps.notice(`Saved “${entry.name}” to your styles`)
  } catch (err) {
    deps.notice(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Whether Languages offers translating on this PC (§2.10): only once the owner approves the
 * licences of offline translation (§18 decision 1).
 * TODO(phase B): offline translation (part P4's translator and its catalogue) answers this.
 */
export const localTranslationOffered = (): boolean => false

/**
 * The publishing pack's two caption commands (NW-13), retargeted to Captions Studio's sections
 * (§2.14; ids, titles and keywords unchanged): Translate captions with AI… opens Languages › Add a
 * language with the first AI provider chosen and the language select focused; Fix captions with AI
 * opens Clean up with Also fix spelling and misheard words with AI ticked and focused. Without
 * captions they say so, as the AI tools do.
 */
export function aiCaptionCommands(deps: Pick<CaptionCommandDeps, 'store' | 'setTab' | 'notice'>): Record<'aiTranslate' | 'aiCleanup', () => void> {
  const open = (request: CaptionsRequest) => (): void => {
    if (!deps.store.state.transcript?.segments.length) return deps.notice('This video has no captions yet: generate them in the Captions tab')
    deps.setTab('captions')
    requestCaptions(request)
  }
  return { aiTranslate: open({ kind: 'language', via: 'ai' }), aiCleanup: open({ kind: 'cleanup', ai: true }) }
}

/** The seven commands, by id. */
export function captionCommands(deps: CaptionCommandDeps): Record<CaptionCommandId, () => void> {
  return {
    captionsGreat: () => {
      deps.setTab('captions')
      void startCaptionsGreat({ store: deps.store, frame: deps.frame(), notice: deps.notice, undo: deps.undo?.() ?? '', review: deps.review?.() ?? '' })
    },
    captionStyles: () => {
      deps.setTab('captions')
      focusGallery()
    },
    captionEmphasis: () => {
      deps.setTab('captions')
      findImportantWords(deps.store, deps.notice)
    },
    captionGraphics: () => {
      deps.setTab('graphics')
      void generatePopUps(deps)
    },
    captionTidy: () => {
      deps.setTab('captions')
      void tidyFromCommand(deps)
    },
    captionLanguage: () => {
      deps.setTab('captions')
      // Add a language with On this PC chosen when it is offered, else the first AI provider (§2.14).
      requestCaptions({ kind: 'language', via: localTranslationOffered() ? 'local' : 'ai' })
    },
    saveCaptionStyle: () => {
      deps.setTab('captions')
      void saveCurrentLook(deps)
    }
  }
}
