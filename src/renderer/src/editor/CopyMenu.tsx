import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { DuplicateProgress } from '../../../shared/api/projects'
import { canCopyAs, type CopyKind } from '../../../shared/editor/duplicate'
import type { Project } from '../../../shared/types'
import { useModalFocus } from './modalFocus'
import './copy.css'

/*
 * The title bar's copy menu and the progress of a copy being made (X-04, NW-05,
 * docs/design/vertical-video.md §2.2, §2.3). The editor mounts CopyMenu in its title bar and
 * CopyProgress while a copy runs; duplicateFlow.ts makes the copy.
 */

const LABEL = 'Duplicate or make a vertical version'

/** The menu's items in order, with their two lines (§2.2). */
const ITEMS: readonly { kind: CopyKind; testId: string; title: string; hint: string }[] = [
  { kind: 'vertical', testId: 'copy-vertical', title: 'Make a vertical version', hint: 'A 9:16 copy that follows your cursor, for TikTok, Reels and Shorts' },
  { kind: 'square', testId: 'copy-square', title: 'Make a square version', hint: 'A 1:1 copy that follows your cursor' },
  { kind: 'copy', testId: 'copy-duplicate', title: 'Duplicate', hint: 'A copy you can edit separately' }
]

/** Title of the progress modal for each kind of copy. */
const COPY_TITLES: Record<CopyKind, string> = { vertical: 'Making a vertical version', square: 'Making a square version', copy: 'Making a copy' }

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
export function CopyMenu(props: { project: Project; vw: number; vh: number; run(kind: CopyKind): void }): JSX.Element {
  const { project, vw, vh, run } = props
  const [open, setOpen] = useState(false)
  /** The focused item, or -1 for the menu itself (just opened by a click or Enter). */
  const [active, setActive] = useState(-1)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const items = ITEMS.map((item) => ({ ...item, can: canCopyAs(project, item.kind, vw, vh) }))

  const close = (refocus: boolean): void => {
    setOpen(false)
    setActive(-1)
    if (refocus) buttonRef.current?.focus()
  }
  const choose = (i: number): void => {
    const item = items[i]
    if (!item?.can.ok) return
    close(true)
    run(item.kind)
  }

  useEffect(() => {
    if (!open) return
    ;(active >= 0 ? itemRefs.current[active] : menuRef.current)?.focus()
  }, [open, active])

  // A press anywhere else closes the menu (the focus goes where the press puts it).
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null
      if (t && (menuRef.current?.contains(t) || buttonRef.current?.contains(t))) return
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
    else return
    // The menu's keys are its own: never the editor's shortcuts (Esc clears the selection there).
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
        title={LABEL}
        aria-label={LABEL}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? 'copy-menu-list' : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={onButtonKey}
      >
        <CopyIcon />
      </button>
      {open && (
        <div ref={menuRef} id="copy-menu-list" className="copy-menu" role="menu" aria-label={LABEL} tabIndex={-1} onKeyDown={onMenuKey}>
          {items.map((item, i) => (
            <button
              key={item.kind}
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

/** "1.4 GB", "350 MB": the size of what is copied, as the library shows sizes. */
function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
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
          <h2 id="copy-progress-title">{COPY_TITLES[kind]}</h2>
        </header>
        <p id="copy-progress-body" className="copy-progress-body">
          Copying “{name}”{total > 0 ? ` (${size(total)})` : ''}. Your original stays as it is.
        </p>
        <div
          className={total > 0 ? 'progress' : 'progress copy-progress-waiting'}
          role="progressbar"
          aria-label="Copied"
          aria-valuemin={0}
          aria-valuemax={total > 0 ? total : undefined}
          aria-valuenow={total > 0 ? done : undefined}
          aria-valuetext={total > 0 ? `${Math.round(share * 100)}%` : undefined}
        >
          <div className="progress-bar" style={{ width: `${share * 100}%` }} />
        </div>
        <footer className="modal-foot">
          <button className="btn" autoFocus onClick={onCancel}>
            Cancel
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}
