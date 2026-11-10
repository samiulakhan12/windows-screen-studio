/**
 * The reviewers' overlay (docs/design/output-and-languages.md §15.4): over a review build's UI it
 * shows which message each text is. Hovering a text shows its key and state, Ctrl+Alt+K copies the
 * key, strings still in draft get a dotted underline, and in the review pack's screenshots every
 * text has its key drawn beside it.
 *
 * It exists only where its catalogue is: `npm run i18n:pack` writes a review catalogue only when
 * FLOWN_I18N_REVIEW=1, and an unpackaged build alone reads a catalogue from outside the app
 * (SSW_I18N_CATALOGUE_DIR). Each message of that catalogue starts with an invisible mark (Unicode
 * tag characters: the mode, the state and the key). A packaged build ships only built catalogues,
 * whose checks refuse tag characters, so it never carries a mark and this renders nothing; so does
 * every UI whose catalogue was not written for review. It adds no element, listener or observer then.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { t, type MessageKey } from '../../../shared/i18n/t'

/** A review mark: U+E0001, the tag characters of "<mode><state>:<key>", U+E007F. */
const MARK_START = '\u{e0001}'
const MARK_END = '\u{e007f}'
const TAG_BASE = 0xe0000

export type ReviewState = 'draft' | 'reviewed' | 'approved' | 'english' | 'stale'
export interface ReviewMark {
  key: string
  state: ReviewState
  /** The review pack's screenshots: every key drawn beside its text. */
  labels: boolean
}
const STATES: Record<string, ReviewState> = { d: 'draft', r: 'reviewed', a: 'approved', e: 'english', s: 'stale' }

/** The review marks a text carries, in order. */
export function readMarks(text: string): ReviewMark[] {
  const out: ReviewMark[] = []
  let at = text.indexOf(MARK_START)
  while (at !== -1) {
    const end = text.indexOf(MARK_END, at)
    if (end === -1) break
    const body = [...text.slice(at + MARK_START.length, end)].map((c) => String.fromCharCode((c.codePointAt(0) ?? TAG_BASE) - TAG_BASE)).join('')
    const m = /^([hl])([dreas]):([A-Za-z0-9_.-]+)$/.exec(body)
    if (m) out.push({ key: m[3], state: STATES[m[2]], labels: m[1] === 'l' })
    at = text.indexOf(MARK_START, end)
  }
  return out
}

/** Keys main and the renderer always have, read to learn whether the catalogue is a review catalogue. */
const PROBES: readonly MessageKey[] = ['main.confirm.cancel', 'errors.feature.notReady']

/** The review mode of the catalogue in use (from the marks of its messages), or null: no overlay. */
export function reviewMode(): ReviewMark | null {
  for (const key of PROBES) {
    try {
      const mark = readMarks(t(key))[0]
      if (mark) return mark
    } catch {
      // A key the catalogue lacks says nothing about review.
    }
  }
  return null
}

/** One marked text on screen. */
interface Box {
  x: number
  y: number
  w: number
  h: number
  key: string
  state: ReviewState
}

/** Every marked text and attribute on the page, with its boxes; the overlay's own nodes left out. */
function collectBoxes(root: HTMLElement, own: Node | null): Box[] {
  const boxes: Box[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (own?.contains(node) || !node.nodeValue?.includes(MARK_START)) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    const rect = range.getBoundingClientRect()
    if (!rect.width && !rect.height) continue
    for (const mark of readMarks(node.nodeValue)) boxes.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height, key: mark.key, state: mark.state })
  }
  for (const el of root.querySelectorAll<HTMLElement>('[title], [aria-label], [placeholder], [alt]')) {
    if (own?.contains(el)) continue
    const text = ['title', 'aria-label', 'placeholder', 'alt'].map((a) => el.getAttribute(a) ?? '').join(' ')
    if (!text.includes(MARK_START)) continue
    const rect = el.getBoundingClientRect()
    if (!rect.width && !rect.height) continue
    for (const mark of readMarks(text)) boxes.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height, key: mark.key, state: mark.state })
  }
  return boxes
}

const LAYER: React.CSSProperties = { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 2147483647 }
const LABEL: React.CSSProperties = { position: 'absolute', font: '600 10px/14px ui-monospace, monospace', padding: '0 3px', borderRadius: 3, background: 'var(--surface-overlay)', color: 'var(--text-1)', whiteSpace: 'nowrap' }

/** The layer drawn over a review build. */
function ReviewLayer({ labels }: { labels: boolean }): JSX.Element {
  const own = useRef<HTMLDivElement>(null)
  const [boxes, setBoxes] = useState<Box[]>([])
  const [hover, setHover] = useState<Box | null>(null)
  const hoverRef = useRef<Box | null>(null)
  hoverRef.current = hover

  useEffect(() => {
    let frame = 0
    const update = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setBoxes(collectBoxes(document.body, own.current)))
    }
    const observer = new MutationObserver((records) => {
      if (records.some((r) => !own.current?.contains(r.target))) update()
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder', 'alt'] })
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    update()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const under = boxes.filter((b) => e.clientX >= b.x && e.clientX <= b.x + b.w && e.clientY >= b.y && e.clientY <= b.y + b.h)
      setHover(under.sort((a, b) => a.w * a.h - b.w * b.h)[0] ?? null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.altKey && e.code === 'KeyK' && hoverRef.current) {
        e.preventDefault()
        void navigator.clipboard?.writeText(hoverRef.current.key)
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [boxes])

  return (
    <div ref={own} className="i18n-review-overlay" aria-hidden="true" style={LAYER}>
      {boxes.map((b, i) =>
        b.state === 'draft' ? <div key={`u${i}`} style={{ position: 'absolute', left: b.x, top: b.y + b.h - 1, width: b.w, borderBottom: '1px dotted var(--warning)' }} /> : null
      )}
      {labels ? boxes.map((b, i) => <div key={`l${i}`} style={{ ...LABEL, left: b.x + b.w + 2, top: b.y }}>{b.key}</div>) : null}
      {hover ? (
        <div style={{ ...LABEL, left: hover.x, top: Math.max(0, hover.y - 16), outline: '1px solid var(--accent-500)' }}>
          {hover.key} · {hover.state}
        </div>
      ) : null}
    </div>
  )
}

/** The overlay in a review build; nothing (no element, listener or observer) anywhere else. */
export function ReviewOverlay(): JSX.Element | null {
  const mode = useMemo(reviewMode, [])
  return mode ? <ReviewLayer labels={mode.labels} /> : null
}
