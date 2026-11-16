import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { DuplicateProgress } from '../../../shared/api/projects'
import { canCopyAs, type CopyKind } from '../../../shared/editor/duplicate'
import type { Project } from '../../../shared/types'
import { fmt } from '../../../shared/i18n/fmt'
import { t, type MessageKey } from '../../../shared/i18n/t'
import { useModalFocus } from './modalFocus'
import './copy.css'

/*
 * The title bar's copy menu and the progress of a copy being made (X-04, NW-05,
 * docs/design/vertical-video.md §2.2, §2.3). The editor mounts CopyMenu in its title bar and
 * CopyProgress while a copy runs; duplicateFlow.ts makes the copy.
 */

/** The button's label, tooltip and menu name (smart-tools.md §2.4: the copies now include short clips). */
const label = (): string => t('review.copyMenu.label')

/** Smart tools' two items after Make a square version (smart-tools.md §2.4), shown when the editor gives their actions. */
const CLIPS_ITEM = { testId: 'copy-clips', title: 'review.copyMenu.clips', hint: 'review.copyMenu.clipsHint' } as const
const SHORT_ITEM = { testId: 'copy-short', title: 'review.copyMenu.short', hint: 'review.copyMenu.shortHint' } as const
/** Why Make a shorter version cannot run: it keeps sentences, so it needs captions. */
export const shortNeedsCaptions = (): string => t('review.copyMenu.shortNeedsCaptions')

/** The menu's items in order, with their two lines as message keys (§2.2). */
const ITEMS: readonly { kind: CopyKind; testId: string; title: MessageKey; hint: MessageKey }[] = [
  { kind: 'vertical', testId: 'copy-vertical', title: 'review.copyMenu.vertical', hint: 'review.copyMenu.verticalHint' },
  { kind: 'square', testId: 'copy-square', title: 'review.copyMenu.square', hint: 'review.copyMenu.squareHint' },
  { kind: 'copy', testId: 'copy-duplicate', title: 'review.copyMenu.duplicate', hint: 'review.copyMenu.duplicateHint' }
]

/** Title of the progress modal for each kind of copy. */
const COPY_TITLES: Record<CopyKind, MessageKey> = { vertical: 'review.copyProgress.vertical', square: 'review.copyProgress.square', copy: 'review.copyProgress.copy' }

/** Two overlapping pages, stroked like EditorIcon. */
function CopyIcon(): JSX.Element {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d="M9 9h11v11H9zM5 15H4V4h11v1" />
    </svg>
  )
}

/**
 * The copy button right of the name field and its menu: Make a vertical version, Make a square version, Duplicate.
 * A menu button: Enter, Space or a click opens it, Up and Down move between the items (Home and
 * End to the ends), Enter runs one, Esc or Tab closes it and gives the focus back to the button.
 * An item that cannot run says why in its second line and stays focusable (aria-disabled).
 */
export function CopyMenu(props: {
  project: Project
  vw: number
  vh: number
  run(kind: CopyKind): void
  /** Find short clips… (smart-tools.md §2.4): opens the Short clips panel. */
  onClips?(): void
  /** Make a shorter version…: opens its dialog. */
  onShort?(): void
}): JSX.Element {
  const { project, vw, vh, run, onClips, onShort } = props
  const [open, setOpen] = useState(false)
  /** The focused item, or -1 for the menu itself (just opened by a click or Enter). */
  const [active, setActive] = useState(-1)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  type Item = { key: string; testId: string; title: string; hint: string; can: { ok: true } | { ok: false; reason: string }; act(): void }
  const copies: Item[] = ITEMS.map((item) => ({ key: item.kind, testId: item.testId, title: t(item.title), hint: t(item.hint), can: canCopyAs(project, item.kind, vw, vh), act: () => run(item.kind) }))
  const smart: Item[] = [
    ...(onClips ? [{ key: 'clips', testId: CLIPS_ITEM.testId, title: t(CLIPS_ITEM.title), hint: t(CLIPS_ITEM.hint), can: { ok: true as const }, act: onClips }] : []),
    ...(onShort
      ? [
          {
            key: 'short',
            testId: SHORT_ITEM.testId,
            title: t(SHORT_ITEM.title),
            hint: t(SHORT_ITEM.hint),
            can: project.transcript?.segments.length ? { ok: true as const } : { ok: false as const, reason: shortNeedsCaptions() },
            act: onShort
          }
        ]
      : [])
  ]
  // After Make a square version, before Duplicate.
  const items: Item[] = [...copies.slice(0, 2), ...smart, ...copies.slice(2)]

  const close = (refocus: boolean): void => {
    setOpen(false)
    setActive(-1)
    if (refocus) buttonRef.current?.focus()
  }
  const choose = (i: number): void => {
    const item = items[i]
    if (!item?.can.ok) return
    close(true)
    item.act()
  }

  useEffect(() => {
    if (!open) return
    ;(active >= 0 ? itemRefs.current[active] : menuRef.current)?.focus()
  }, [open, active])

  // A press anywhere else closes the menu (the focus goes where the press puts it).
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node | null
      if (target && (menuRef.current?.contains(target) || buttonRef.current?.contains(target))) return
      close(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    e.stopPropagation()
    setOpen(true)
    setActive(e.key === 'ArrowDown' ? 0 : items.length - 1)
  }

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const last = items.length - 1
    let next: number | null = null
    if (e.key === 'ArrowDown') next = active < 0 || active >= last ? 0 : active + 1
    else if (e.key === 'ArrowUp') next = active <= 0 ? last : active - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    else if (e.key === 'Enter' || e.key === ' ') {
      if (active >= 0) choose(active)
    } else if (e.key === 'Escape' || e.key === 'Tab') close(true)
    else if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    // The menu's keys are its own: never the editor's shortcuts (Esc clears the selection there,
    // Left and Right move the selected items).
    e.preventDefault()
    e.stopPropagation()
    if (next !== null) setActive(next)
  }

  return (
    <div className="copy-menu-anchor">
      <button
        ref={buttonRef}
        className="btn ghost icon-btn"
        data-testid="copy-menu"
        title={label()}
        aria-label={label()}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? 'copy-menu-list' : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={onButtonKey}
      >
        <CopyIcon /> <span className="tb-label">{t('review.copyMenu.button')}</span>
      </button>
      {open && (
        <div ref={menuRef} id="copy-menu-list" className="copy-menu" role="menu" aria-label={label()} tabIndex={-1} onKeyDown={onMenuKey}>
          {items.map((item, i) => (
            <button
              key={item.key}
              ref={(el) => {
                itemRefs.current[i] = el
              }}
              type="button"
              role="menuitem"
              className="copy-menu-item"
              data-testid={item.testId}
              tabIndex={i === active ? 0 : -1}
              aria-disabled={item.can.ok ? undefined : true}
              onClick={() => choose(i)}
              onMouseEnter={() => setActive(i)}
            >
              <span className="copy-menu-title">{item.title}</span>
              <span className="copy-menu-hint">{item.can.ok ? item.hint : item.can.reason}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** How long a copy runs before its progress is shown: links and small files are done by then. */
const SHOW_AFTER_MS = 500

/** The modal shown while a copy takes longer than 0.5 s: what is copied, a progress bar and Cancel. */
export function CopyProgress(props: { kind: CopyKind; name: string; progress: DuplicateProgress | null; onCancel(): void }): JSX.Element {
  // Mounted when the copy starts; nothing shows (nor takes the focus or Esc) until 0.5 s have passed.
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), SHOW_AFTER_MS)
    return () => clearTimeout(timer)
  }, [])
  return shown ? <ProgressDialog {...props} /> : <></>
}

function ProgressDialog(props: { kind: CopyKind; name: string; progress: DuplicateProgress | null; onCancel(): void }): JSX.Element {
  const { kind, name, progress, onCancel } = props
  const boxRef = useRef<HTMLDivElement>(null)
  // Esc cancels, as the button does; the focus stays inside and goes back where it was.
  useModalFocus(boxRef, onCancel)
  const total = progress && progress.total > 0 ? progress.total : 0
  const done = total > 0 ? Math.min(Math.max(0, progress!.done), total) : 0
  const share = total > 0 ? done / total : 0
  return createPortal(
    <div className="overlay modal-backdrop">
      <div className="modal copy-progress" data-testid="copy-progress" role="dialog" aria-modal="true" aria-labelledby="copy-progress-title" aria-describedby="copy-progress-body" ref={boxRef} tabIndex={-1}>
        <header className="modal-head">
          <h2 id="copy-progress-title">{t(COPY_TITLES[kind])}</h2>
        </header>
        <p id="copy-progress-body" className="copy-progress-body">
          {total > 0 ? t('review.copyProgress.copyingSize', { name, size: fmt.bytes(total, 'coarse') }) : t('review.copyProgress.copying', { name })}
        </p>
        <div
          className={total > 0 ? 'progress' : 'progress copy-progress-waiting'}
          role="progressbar"
          aria-label={t('review.copyProgress.copied')}
          aria-valuemin={0}
          aria-valuemax={total > 0 ? total : undefined}
          aria-valuenow={total > 0 ? done : undefined}
          aria-valuetext={total > 0 ? fmt.percent(share) : undefined}
        >
          <div className="progress-bar" style={{ width: `${share * 100}%` }} />
        </div>
        <footer className="modal-foot">
          <button className="btn" autoFocus onClick={onCancel}>
            {t('common.action.cancel')}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}
