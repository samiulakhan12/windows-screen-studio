/**
 * The full-size screenshot viewer (docs/design/smart-tools.md §2.1.2, §5.5.3): a modal dialog
 * showing a step's shot at 100% (one image pixel per device pixel) in a scrolling area that keeps
 * the keyboard (arrows pan 40 px, Page Up and Down a screen, Home and End to the edges), Fit,
 * Previous and Next, *Blur an area…*, and *Adjust*: the crop as a rectangle with 8 handles and the
 * ring as a movable circle over the whole frame, moved by the keyboard (arrows 1%, Shift 10%, Alt
 * resizes the crop, Enter is Done) or the pointer. In *Check screenshots* a line counts the shots
 * seen at 100%. Esc closes it and the focus goes back to the screenshot button that opened it.
 *
 * The send form (`mode: 'send'`, part P6, §5.3.1): titled "These screenshots go to OpenAI", every
 * picture that would go, one at a time, as the very bytes that go, with Previous, Next and a checkbox
 * "Send step 3's screenshot" on each (the ones `ticked` names start ticked); **Send 12 screenshots**
 * closes it with the keys still ticked, **Cancel** (focused at the start) or Esc with nothing, and
 * nothing is sent before Send. Seeing a picture here does not count as checking its shot.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { cropName, cropOk, fitCrop, nudgeCrop, nudgeRing, ringName, snapCrop } from '../../../shared/guide/adjust'
import type { GuideImage } from '../../../shared/guide/guideDoc'
import type { GuideStepEdit, NormRect } from '../../../shared/types'
import { useModalFocus } from '../editor/modalFocus'
import './guide.css'

/** What Adjust works on: the whole frame's picture, and the crop and ring as stored or as found. */
export interface ShotAdjust {
  frame: GuideImage
  rect: NormRect
  ring: { x: number; y: number } | null
}

/** A shot the viewer shows. */
export interface ViewerShot {
  key: string
  label: string
  title?: string
  image: GuideImage | null
  adjust?: ShotAdjust
  note?: string
}

const PAN = 40
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
type Handle = (typeof HANDLES)[number]

/** An object URL for an image's bytes, freed when it changes. */
function useImageUrl(image: GuideImage | null | undefined): string | null {
  const url = useMemo(() => (image && typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(new Blob([new Uint8Array(image.bytes)], { type: image.mime })) : null), [image])
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])
  return url
}

export function ShotViewer(props: {
  /**
   * Each shot in the order Previous and Next walk; `image` is null while it is made again (after an
   * edit). `note`: a line shown with it (in the send form: that it may show what was typed). `title`:
   * the dialog's title for a shot that is not a step's (the bug report's Actual).
   */
  shots: readonly ViewerShot[]
  index: number
  mode: 'view' | 'check' | 'send'
  /**
   * The send form: where the pictures go (the choice's place, "OpenAI"), the keys ticked at the start,
   * and the cost line of what the ticked ones would send.
   */
  place?: string
  ticked?: ReadonlySet<string>
  sendCost?(keys: readonly string[]): string
  /** How many steps the guide has, for the title ("Screenshot for step 3 of 30"). */
  total?: number
  /** In Check screenshots: how many have been seen at 100%, and that a shot was. */
  checked?: number
  onShown?(key: string): void
  /** The shot now shown (the panel makes Adjust's picture of the whole frame for it). */
  onAt?(key: string): void
  onClose(result?: { send: readonly string[] }): void
  onBlur(key: string): void
  onAdjust(key: string, edit: Pick<GuideStepEdit, 'rect' | 'ring'> | null): void
}): JSX.Element {
  const { shots, onClose, onShown } = props
  const sending = props.mode === 'send'
  const [at, setAt] = useState(() => Math.min(Math.max(0, props.index), Math.max(0, shots.length - 1)))
  const [fit, setFit] = useState(false)
  const [adjusting, setAdjusting] = useState<{ rect: NormRect; ring: { x: number; y: number } | null } | null>(null)
  const [said, setSaid] = useState('')
  // The send form's ticks: what goes on Send.
  const [ticks, setTicks] = useState<ReadonlySet<string>>(() => new Set(props.ticked ?? []))
  const boxRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  useModalFocus(boxRef, () => onClose())
  const shot = shots[at] ?? null
  const url = useImageUrl(shot?.image)
  const frameUrl = useImageUrl(adjusting ? shot?.adjust?.frame : null)
  // A shot counts as checked once shown at 100% (not a picture in the send form: it is smaller).
  const shown = shot?.image && !sending ? shot.key : null
  useEffect(() => {
    if (shown && !fit && !adjusting) onShown?.(shown)
  }, [shown, fit, adjusting, onShown])
  const onAt = props.onAt
  const atKey = shot?.key ?? null
  useEffect(() => {
    if (atKey) onAt?.(atKey)
  }, [atKey, onAt])
  const first = useRef(true)
  useEffect(() => {
    const opening = first.current
    first.current = false
    // The send form opens on Cancel; later, the picture takes the focus only from a button Previous or Next disabled.
    if (sending && (opening || !(document.activeElement as HTMLButtonElement | null)?.disabled)) return
    areaRef.current?.focus()
  }, [at, sending])

  if (!shot) return <></>
  const total = props.total ?? shots.length
  const title = sending ? `These screenshots go to ${props.place ?? 'the AI service'}` : (shot.title ?? `Screenshot for ${shot.label} of ${total}`)
  const sendKeys = shots.map((s) => s.key).filter((k) => ticks.has(k))
  const tick = (on: boolean): void => {
    setTicks((t) => {
      const next = new Set(t)
      if (on) next.add(shot.key)
      else next.delete(shot.key)
      return next
    })
    setSaid(`${cap(shot.label)}'s screenshot ${on ? 'will be sent' : 'will not be sent'}.`)
  }

  const pan = (e: KeyboardEvent<HTMLDivElement>): void => {
    const el = areaRef.current as (HTMLDivElement & { scrollBy?: (x: number, y: number) => void }) | null
    if (!el) return
    const page = { x: el.clientWidth || 400, y: el.clientHeight || 300 }
    const moves: Record<string, () => void> = {
      ArrowLeft: () => el.scrollBy?.(-PAN, 0),
      ArrowRight: () => el.scrollBy?.(PAN, 0),
      ArrowUp: () => el.scrollBy?.(0, -PAN),
      ArrowDown: () => el.scrollBy?.(0, PAN),
      PageUp: () => el.scrollBy?.(0, -page.y),
      PageDown: () => el.scrollBy?.(0, page.y),
      Home: () => {
        el.scrollLeft = 0
        el.scrollTop = 0
      },
      End: () => {
        el.scrollLeft = el.scrollWidth
        el.scrollTop = el.scrollHeight
      }
    }
    const move = moves[e.key]
    if (!move || e.altKey || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    e.stopPropagation()
    move()
  }

  const startAdjust = (): void => {
    if (!shot.adjust) return
    setAdjusting({ rect: shot.adjust.rect, ring: shot.adjust.ring })
  }
  const done = (): void => {
    if (!adjusting) return
    if (!cropOk(adjusting.rect)) return setSaid('The crop is too small: at least 5% of the screen.')
    props.onAdjust(shot.key, { rect: fitCrop(adjusting.rect), ...(adjusting.ring ? { ring: adjusting.ring } : {}) })
    setAdjusting(null)
  }
  const reset = (): void => {
    props.onAdjust(shot.key, null)
    setAdjusting(null)
  }
  const cropKeys = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (!adjusting) return
    if (e.key === 'Enter') {
      e.preventDefault()
      return done()
    }
    const next = nudgeCrop(adjusting.rect, e.key, e.shiftKey, e.altKey)
    if (!next) return
    e.preventDefault()
    e.stopPropagation()
    setAdjusting({ ...adjusting, rect: next })
    setSaid(cropName(next))
  }
  const ringKeys = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (!adjusting?.ring) return
    if (e.key === 'Enter') {
      e.preventDefault()
      return done()
    }
    const next = nudgeRing(adjusting.ring, e.key, e.shiftKey)
    if (!next) return
    e.preventDefault()
    e.stopPropagation()
    setAdjusting({ ...adjusting, ring: next })
    setSaid(ringName(next))
  }
  /** A pointer drag of the crop (a handle resizes it) or of the ring, in fractions of the frame shown. */
  const drag = (what: 'ring' | 'crop' | Handle) => (e: ReactPointerEvent<HTMLElement>): void => {
    if (!adjusting || !shot.adjust) return
    const box = (e.currentTarget.closest('.guide-adjust-frame') as HTMLElement | null)?.getBoundingClientRect()
    if (!box || !box.width || !box.height) return
    e.preventDefault()
    e.stopPropagation()
    const start = { x: e.clientX, y: e.clientY, rect: adjusting.rect, ring: adjusting.ring }
    const frame = { w: shot.adjust.frame.width, h: shot.adjust.frame.height }
    const move = (ev: PointerEvent): void => {
      const dx = (ev.clientX - start.x) / box.width
      const dy = (ev.clientY - start.y) / box.height
      if (what === 'ring') {
        if (!start.ring) return
        setAdjusting((a) => (a ? { ...a, ring: { x: Math.min(1, Math.max(0, start.ring!.x + dx)), y: Math.min(1, Math.max(0, start.ring!.y + dy)) } } : a))
        return
      }
      const r = start.rect
      let { x, y, w, h } = r
      if (what === 'crop') {
        x += dx
        y += dy
      } else {
        if (what.includes('w')) {
          x += dx
          w -= dx
        }
        if (what.includes('e')) w += dx
        if (what.includes('n')) {
          y += dy
          h -= dy
        }
        if (what.includes('s')) h += dy
      }
      setAdjusting((a) => (a ? { ...a, rect: snapCrop(fitCrop({ x, y, w, h }), frame) } : a))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const pct = (v: number): string => `${(v * 100).toFixed(3)}%`
  return (
    <div className="overlay modal-backdrop guide-viewer-backdrop">
      <div className="modal guide-viewer" role="dialog" aria-modal="true" aria-labelledby="guide-viewer-title" ref={boxRef} data-testid="guide-viewer">
        <header className="modal-head">
          <h2 id="guide-viewer-title">{title}</h2>
        </header>
        {props.mode === 'check' && (
          <p className="guide-viewer-checked" role="status" aria-live="polite" data-testid="guide-checked">
            Checked {props.checked ?? 0} of {total}
          </p>
        )}
        {sending && (
          <div className="guide-send-head">
            <p className="guide-viewer-checked" role="status" aria-live="polite" data-testid="guide-send-where">
              {`Picture ${at + 1} of ${shots.length}: ${shot.label}`}
            </p>
            {shot.note && (
              <p className="guide-chip warn" data-testid="guide-send-note">
                {shot.note}
              </p>
            )}
            <label className="guide-check">
              <input type="checkbox" checked={ticks.has(shot.key)} onChange={(e) => tick(e.target.checked)} data-testid="guide-send-tick" />
              {`Send ${shot.label}'s screenshot`}
            </label>
            {props.sendCost && (
              <p className="guide-viewer-checked guide-send-cost" id="guide-send-cost" data-testid="guide-send-cost">
                {props.sendCost(sendKeys)}
              </p>
            )}
          </div>
        )}
        {adjusting && shot.adjust ? (
          <div className="guide-adjust">
            <p className="hint">Move the crop and the ring with the arrow keys (Shift: further, Alt: resize the crop), or drag them. Enter is Done.</p>
            <div className="guide-adjust-frame">
              {frameUrl && <img src={frameUrl} alt={`The whole screen for ${shot.label}`} width={shot.adjust.frame.width} height={shot.adjust.frame.height} draggable={false} />}
              <button
                type="button"
                className="guide-adjust-crop"
                aria-label={cropName(adjusting.rect)}
                data-testid="guide-adjust-crop"
                style={{ left: pct(adjusting.rect.x), top: pct(adjusting.rect.y), width: pct(adjusting.rect.w), height: pct(adjusting.rect.h) }}
                onKeyDown={cropKeys}
                onPointerDown={drag('crop')}
              >
                {HANDLES.map((h) => (
                  <span key={h} className="guide-adjust-handle" data-handle={h} aria-hidden="true" onPointerDown={drag(h)} />
                ))}
              </button>
              {adjusting.ring && (
                <button
                  type="button"
                  className="guide-adjust-ring"
                  aria-label={ringName(adjusting.ring)}
                  data-testid="guide-adjust-ring"
                  style={{ left: pct(adjusting.ring.x), top: pct(adjusting.ring.y) }}
                  onKeyDown={ringKeys}
                  onPointerDown={drag('ring')}
                />
              )}
            </div>
          </div>
        ) : (
          <div
            ref={areaRef}
            className={`guide-viewer-area ${fit ? 'fit' : ''}`}
            role="group"
            aria-label={fit ? 'Screenshot, fitted' : 'Screenshot, 100%'}
            tabIndex={0}
            onKeyDown={pan}
            data-testid="guide-viewer-area"
          >
            {url && shot.image ? (
              <img src={url} alt={sending ? `The screenshot for ${shot.label} as it would be sent` : `Screenshot for ${shot.label}`} width={shot.image.width} height={shot.image.height} data-testid="guide-viewer-image" />
            ) : (
              <span className="guide-shot-wait">Making the screenshot…</span>
            )}
          </div>
        )}
        <p className="guide-viewer-said" role="status" aria-live="polite">
          {said}
        </p>
        <footer className="modal-foot guide-viewer-foot">
          {sending ? (
            <>
              <button type="button" className="btn ghost" disabled={at === 0} onClick={() => setAt(at - 1)} data-testid="guide-viewer-prev">
                Previous
              </button>
              <button type="button" className="btn ghost" disabled={at >= shots.length - 1} onClick={() => setAt(at + 1)} data-testid="guide-viewer-next">
                Next
              </button>
              <button type="button" className="btn primary" disabled={!sendKeys.length} aria-describedby={props.sendCost ? 'guide-send-cost' : undefined} onClick={() => onClose({ send: sendKeys })} data-testid="guide-send">
                {`Send ${sendKeys.length} ${sendKeys.length === 1 ? 'screenshot' : 'screenshots'}`}
              </button>
              {/* The send form opens on Cancel (§5.3.1): nothing goes by a stray Enter. */}
              <button type="button" className="btn" autoFocus onClick={() => onClose()} data-testid="guide-send-cancel">
                Cancel
              </button>
            </>
          ) : adjusting ? (
            <>
              <button type="button" className="btn ghost" onClick={reset} data-testid="guide-adjust-reset">
                Reset
              </button>
              <button type="button" className="btn ghost" onClick={() => setAdjusting(null)}>
                Cancel
              </button>
              <button type="button" className="btn primary" onClick={done} data-testid="guide-adjust-done">
                Done
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn ghost" disabled={at === 0} onClick={() => setAt(at - 1)} data-testid="guide-viewer-prev">
                Previous
              </button>
              <button type="button" className="btn ghost" disabled={at >= shots.length - 1} onClick={() => setAt(at + 1)} data-testid="guide-viewer-next">
                Next
              </button>
              <button type="button" className="btn ghost" aria-pressed={fit} onClick={() => setFit(!fit)} data-testid="guide-viewer-fit">
                Fit
              </button>
              <button type="button" className="btn ghost" onClick={() => props.onBlur(shot.key)} data-testid="guide-viewer-blur">
                Blur an area…
              </button>
              {shot.adjust && (
                <button type="button" className="btn ghost" onClick={startAdjust} data-testid="guide-viewer-adjust">
                  Adjust
                </button>
              )}
              <button type="button" className="btn" onClick={() => onClose()} data-testid="guide-viewer-close">
                Close
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
