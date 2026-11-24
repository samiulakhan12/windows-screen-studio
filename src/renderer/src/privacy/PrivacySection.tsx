import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { coversFromShapes, type CoverLength } from '../../../shared/editor/coverEdit'
import { itemKey } from '../../../shared/editor/multiSelect'
import { withShortcut } from '../../../shared/editor/shortcuts'
import { privateItems, readPrivacyPrefs } from '../../../shared/privacy/coverData'
import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { fmt } from '../../../shared/i18n/fmt'
import { t, type MessageKey } from '../../../shared/i18n/t'
import type { Shape } from '../../../shared/types'
import type { EditorServices } from '../editor/context'
import { Section } from '../editor/controls'
import { useGroup } from '../editor/groupContext'
import { useKeymap } from '../editor/keymapContext'
import { coverLength, setCoverLength } from './coverCommands'
import { ringColourAt } from './coverPick'
import { showCoverMarks, usePeek } from './peek'
import { FindResultLine, useResultLineShown } from './FindLine'
import { CopiesOffer } from './CopiesOffer'
import { FindProgressLine, useFindProgress, useReaderState } from './readerState'
import { openPrivateReview } from './reviewRequest'
import './covers.css'

/** The lengths *Add cover*'s menu offers (§2.1). */
const LENGTHS: readonly { value: CoverLength; label: MessageKey }[] = [
  { value: 'three', label: PRIVACY_COPY.cover.lengthThree },
  { value: 'toEnd', label: PRIVACY_COPY.cover.lengthToEnd },
  { value: 'whole', label: PRIVACY_COPY.cover.lengthWhole }
]

/** What Find does not see (§2.9), in the order the list shows it. */
export const NOT_SEE: readonly MessageKey[] = [
  PRIVACY_COPY.notSee.scripts,
  PRIVACY_COPY.notSee.small,
  PRIVACY_COPY.notSee.names,
  PRIVACY_COPY.notSee.brief,
  PRIVACY_COPY.notSee.unlabelled,
  PRIVACY_COPY.notSee.pictures,
  PRIVACY_COPY.notSee.added,
  PRIVACY_COPY.notSee.off,
  PRIVACY_COPY.notSee.said,
  PRIVACY_COPY.notSee.length,
  PRIVACY_COPY.notSee.folder,
  PRIVACY_COPY.notSee.check
]

/** The keys the length menu keeps (never the editor's shortcuts while it is open). */
const MENU_KEYS = new Set(['Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

const isWeak = (s: Shape): boolean => s.kind === 'blur' || s.kind === 'pixelate'

/** Writes *Show where covers are* to the `privacy` preference: absent when on, `false` when off (§4.5). */
async function writeShowCovers(on: boolean): Promise<void> {
  const prefs = readPrivacyPrefs(await window.api.getPref('privacy')) ?? {}
  const { showCovers: _old, ...rest } = prefs
  void _old
  await window.api.setPref('privacy', on ? rest : { ...rest, showCovers: false })
}

/**
 * The Shapes tab's *Private info* section (docs/design/auto-blur.md §2.1): *Add cover* with its
 * length menu, *Find private info…* (or Find's progress line while it runs, and once it ended its
 * result line, §2.6), the count of private
 * items and of those to check with *Review*, the reader line, *Show where covers are*, the blur and
 * pixelate line with *Turn them all into covers*, and the *What Find does not see* disclosure.
 */
export function PrivacySection(props: { services: EditorServices; onFind: () => void; flush?: () => unknown }): JSX.Element | null {
  const { store } = props.services
  const group = useGroup()
  const keymap = useKeymap()
  const project = useSyncExternalStore(store.subscribe, () => store.state)
  const reader = useReaderState()
  const progress = useFindProgress(project.id)
  const resultShown = useResultLineShown(project.id, 'section')
  const peek = usePeek()
  const [menu, setMenu] = useState(false)
  const [length, setLength] = useState<CoverLength>(coverLength)
  const [notSee, setNotSee] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const ids = `privacy-${useId().replace(/:/g, '')}`

  // *Show where covers are* is remembered in the preferences (on unless turned off).
  useEffect(() => {
    let live = true
    void window.api
      .getPref('privacy')
      .then((raw) => live && showCoverMarks(readPrivacyPrefs(raw)?.showCovers !== false))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus()
  }, [menu])

  const items = privateItems(project)
  const weak = (project.shapes ?? []).filter(isWeak)

  const add = (chosen?: CoverLength): void => {
    if (chosen) {
      setCoverLength(chosen)
      setLength(chosen)
    }
    group.command('addCover')
  }
  const closeMenu = (refocus: boolean): void => {
    setMenu(false)
    if (refocus) menuButton.current?.focus()
  }
  const onMenuKey = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Tab') return closeMenu(false)
    if (!MENU_KEYS.has(e.key)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') return closeMenu(true)
    const list = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]
    if (!list.length) return
    const i = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus()
    else if (e.key === 'Home' || e.key === 'End') list[e.key === 'Home' ? 0 : list.length - 1]?.focus()
  }

  const turnAll = async (): Promise<void> => {
    const shapes = (store.state.shapes ?? []).filter(isWeak)
    if (!shapes.length) return
    const colours: Record<string, string> = {}
    for (const s of shapes) {
      const box = { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) }
      colours[s.id] = await ringColourAt(store.state.id, (s.start + s.end) / 2, box)
    }
    let made: string[] = []
    store.update((p) => {
      const r = coversFromShapes(p, shapes.map((s) => s.id), colours)
      made = r.ids
      return r.project
    })
    if (made.length) group.select(made.map((id) => itemKey('cover', id)), itemKey('cover', made[0]))
  }

  const toggleMarks = (on: boolean): void => {
    showCoverMarks(on)
    void writeShowCovers(on).catch(() => undefined)
  }

  return (
    <Section title={t(PRIVACY_COPY.section.title)}>
      <div className="cover-section-body" data-testid="privacy-section">
        <div className="cover-add">
          <button type="button" className="btn" title={withShortcut(t(PRIVACY_COPY.shape.coverTitle), keymap.addCover)} onClick={() => add()} data-testid="privacy-add-cover">
            {t(PRIVACY_COPY.section.addCover)}
          </button>
          <button
            ref={menuButton}
            type="button"
            className="btn cover-add-more"
            aria-haspopup="menu"
            aria-expanded={menu}
            aria-label={t(PRIVACY_COPY.section.addCoverMenu)}
            title={t(PRIVACY_COPY.section.addCoverMenu)}
            onClick={() => setMenu((m) => !m)}
            data-testid="privacy-add-cover-menu"
          >
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {menu && (
            <div ref={menuRef} className="cover-add-menu" role="menu" aria-label={t(PRIVACY_COPY.section.addCoverMenu)} onKeyDown={onMenuKey}>
              {LENGTHS.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={l.value === length}
                  tabIndex={-1}
                  data-testid={`privacy-length-${l.value}`}
                  onClick={() => {
                    closeMenu(false)
                    add(l.value)
                  }}
                >
                  {t(l.label)}
                </button>
              ))}
            </div>
          )}
        </div>

        {progress ? (
          <FindProgressLine projectId={project.id} onReview={() => openPrivateReview(group.command)} />
        ) : (
          <>
            <button type="button" className="btn ghost" onClick={props.onFind} data-testid="privacy-find">
              {t(PRIVACY_COPY.section.find)}
            </button>
            {/* Once Find ended, its result line (§2.6), here as in Review's header, with Review. */}
            <FindResultLine projectId={project.id} onReview={() => openPrivateReview(group.command)} />
            {/* With the result line, on a project with copies: Also cover the copies (§2.12); the editor writes the project first. */}
            {resultShown && <CopiesOffer services={props.services} {...(props.flush ? { flush: props.flush } : {})} />}
          </>
        )}
        {reader?.status === 'none' && (
          <p className="hint" data-testid="privacy-reader-missing">
            {t(PRIVACY_COPY.section.readerMissing)}
          </p>
        )}

        {items.items > 0 && (
          <p className="cover-count" data-testid="privacy-count">
            <span>{t(PRIVACY_COPY.section.count, { count: items.items, n: fmt.count(items.items) })}</span>
            {items.check > 0 && <span> {t(PRIVACY_COPY.section.toCheck, { count: items.check, n: fmt.count(items.check) })}</span>}{' '}
            <button type="button" className="link" onClick={() => openPrivateReview(group.command)} data-testid="privacy-review">
              {t(PRIVACY_COPY.section.review)}
            </button>
          </p>
        )}

        <label className="toggle" data-testid="privacy-show-covers">
          <span>{t(PRIVACY_COPY.section.showCovers)}</span>
          <input type="checkbox" aria-label={t(PRIVACY_COPY.section.showCovers)} aria-describedby={`${ids}-marks`} checked={peek.marks} onChange={(e) => toggleMarks(e.target.checked)} />
        </label>
        <p className="hint" id={`${ids}-marks`}>
          {t(PRIVACY_COPY.section.showCoversHint)}
        </p>

        {weak.length > 0 && (
          <p className="cover-weak-line" data-testid="privacy-weak">
            <span>{t(PRIVACY_COPY.section.weak, { count: weak.length, n: fmt.count(weak.length) })}</span>{' '}
            <button type="button" className="link" onClick={() => void turnAll()} data-testid="privacy-weak-turn">
              {t(PRIVACY_COPY.section.weakTurn)}
            </button>
          </p>
        )}

        <button type="button" className="cover-not-see-head link" aria-expanded={notSee} aria-controls={`${ids}-not-see`} onClick={() => setNotSee((o) => !o)} data-testid="privacy-not-see">
          {t(PRIVACY_COPY.section.notSee)}
        </button>
        {notSee && (
          <ul className="cover-not-see" id={`${ids}-not-see`} data-testid="privacy-not-see-list">
            {NOT_SEE.map((k) => (
              <li key={k}>{t(k)}</li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}
