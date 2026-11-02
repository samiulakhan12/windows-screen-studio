/**
 * The style gallery (docs/design/captions-studio.md §2.5, §2.15): filters, two rows and Show all,
 * Play and Delete beside the grid, a hover or focus preview on the video after 300 ms; a radio
 * group with a roving tabindex (arrows move, Home and End, Enter or Space picks). Thumbnails are
 * drawn by the real renderer (drawStudioSample) at the sample scale, once per look, frame shape,
 * tile size, language and fontGeneration(), in idle time; the hovered or focused tile plays its
 * look over a 2.4 s loop, never under reduced motion (Play plays one loop then).
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { legacyTwin } from '../../../../shared/captions/studioEdit'
import { withPreset } from '../../../../shared/captions/settings'
import type { SavedLook } from '../../../../shared/captions/studioPresets'
import type { CaptionSettings, CaptionStudio } from '../../../../shared/types'
import { fontGeneration } from '../../render/fontLoader'
import { drawStudioSample } from '../../render/studioLayer'
import { onStyleAssetsChanged } from '../../render/watermarkLayer'
import { removeLook, restoreLook } from '../captionPresets'
import { useGroup } from '../groupContext'
import { checkedTile, filtersFor, galleryTiles, MINE_PREFIX, suggestedReason, tileLabel, usableFilter, type GalleryFilter, type GalleryTile } from './captionTiles'
import './captionStudio.css'

/** localStorage key of the last filter (§2.4). */
export const FILTER_KEY = 'captions-gallery-filter'
/** A tile's full size (§2.5); smaller when the Inspector is narrower, its text still at the sample size. */
export const TILE = { w: 136, h: 96 }
/** The gap between tiles, px. */
const GAP = 6
/** Hovered or focused this long, a tile previews its look on the video (§2.5). */
export const PREVIEW_DELAY = 300
/** An animated thumbnail's loop, seconds, at 30 frames a second. */
export const LOOP_S = 2.4
/** The still thumbnail's time in the sample: the spoken mark on its third word. */
const STILL_T = 1.0

const readFilter = (): string | null => {
  try {
    return localStorage.getItem(FILTER_KEY)
  } catch {
    return null
  }
}
const writeFilter = (f: GalleryFilter): void => {
  try {
    localStorage.setItem(FILTER_KEY, f)
  } catch {
    // Remembering the filter is a convenience.
  }
}

/** Whether the PC asks for less animation. */
const reducedMotionQuery = (): MediaQueryList | null => (typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null)
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const q = reducedMotionQuery()
      q?.addEventListener?.('change', fn)
      return () => q?.removeEventListener?.('change', fn)
    },
    () => !!reducedMotionQuery()?.matches
  )
}

/* ---------- thumbnails ---------- */

const lookKeys = new WeakMap<object, string>()
/** A look's content, as a cache key. */
function lookKey(look: CaptionStudio): string {
  let k = lookKeys.get(look)
  if (!k) lookKeys.set(look, (k = JSON.stringify(look)))
  return k
}

/** Drawn thumbnails (data URLs) and the text size each drew, by look, frame shape, tile size, language and font generation. */
const thumbs = new Map<string, { url: string; textPx: number }>()
const THUMB_LIMIT = 400

/** The look a tile draws: its own, or a Classic look's Studio twin (it looks the same, §5.8). */
export function tileLook(tile: GalleryTile, value: CaptionSettings): CaptionStudio {
  return tile.look ?? legacyTwin(withPreset({ ...value, studio: undefined }, tile.preset!))
}

/** Draws `look` at `t` into a canvas `size` CSS px big (scaled for the screen); the text size the sample drew. */
export function paintSample(canvas: HTMLCanvasElement, look: CaptionStudio, frame: { w: number; h: number }, size: { w: number; h: number }, t: number, language: string | undefined): number {
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
  canvas.width = Math.round(size.w * dpr)
  canvas.height = Math.round(size.h * dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx) return 0
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return drawStudioSample(ctx, look, frame, size, t, language).textPx
}

/** The still thumbnail of a look, drawn now (or taken from the cache). */
export function thumbnail(look: CaptionStudio, frame: { w: number; h: number }, size: { w: number; h: number }, language: string | undefined): { url: string; textPx: number } {
  const key = `${lookKey(look)}|${frame.w}x${frame.h}|${size.w}x${size.h}|${language ?? ''}|${fontGeneration()}`
  let hit = thumbs.get(key)
  if (!hit) {
    const canvas = document.createElement('canvas')
    const textPx = paintSample(canvas, look, frame, size, STILL_T, language)
    hit = { url: canvas.toDataURL('image/png'), textPx }
    if (thumbs.size >= THUMB_LIMIT) thumbs.delete(thumbs.keys().next().value as string)
    thumbs.set(key, hit)
  }
  return hit
}

/** Runs `fn` when the window is idle (or soon, where it has no idle callback). */
const whenIdle = (fn: () => void): (() => void) => {
  const w = typeof window !== 'undefined' ? (window as Window & { requestIdleCallback?: (cb: () => void) => number; cancelIdleCallback?: (id: number) => void }) : null
  if (w?.requestIdleCallback) {
    const id = w.requestIdleCallback(fn)
    return () => w.cancelIdleCallback?.(id)
  }
  const id = setTimeout(fn, 0)
  return () => clearTimeout(id)
}

/** A tile's picture: the still thumbnail, or its look playing over a loop while `playing`. */
function Thumb({ look, frame, size, language, playing, onDone, fonts }: { look: CaptionStudio; frame: { w: number; h: number }; size: { w: number; h: number }; language?: string; playing: 'loop' | 'once' | null; onDone: () => void; fonts: number }): JSX.Element {
  const [still, setStill] = useState<{ url: string; textPx: number } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Drawn again when a font finishes loading (fontGeneration is part of the cache key).
  useEffect(() => whenIdle(() => setStill(thumbnail(look, frame, size, language))), [look, frame.w, frame.h, size.w, size.h, language, fonts])
  useEffect(() => {
    if (!playing) return
    const canvas = canvasRef.current
    if (!canvas || typeof requestAnimationFrame !== 'function') return
    let raf = 0
    let last = -1
    const t0 = performance.now()
    const frameStep = (now: number): void => {
      const elapsed = (now - t0) / 1000
      if (playing === 'once' && elapsed >= LOOP_S) return onDone()
      // 30 frames a second: a frame is drawn only when its time changes.
      const t = Math.floor((elapsed % LOOP_S) * 30) / 30
      if (t !== last) {
        last = t
        paintSample(canvas, look, frame, size, t, language)
      }
      raf = requestAnimationFrame(frameStep)
    }
    raf = requestAnimationFrame(frameStep)
    return () => cancelAnimationFrame(raf)
  }, [playing, look, frame.w, frame.h, size.w, size.h, language])
  return (
    <span className="tile-thumb" style={{ width: size.w, height: size.h }} data-text-px={still?.textPx}>
      {playing ? <canvas ref={canvasRef} width={size.w} height={size.h} aria-hidden="true" /> : still ? <img src={still.url} alt="" width={size.w} height={size.h} /> : null}
    </span>
  )
}

/* ---------- the gallery ---------- */

/** Caption styles… (§2.14) asks the gallery to take the focus, on its checked tile. */
let focusAsked = false
let focusExpiry: ReturnType<typeof setTimeout> | null = null
/**
 * A request no gallery takes this soon, ms, is dropped (the Selection view hid the Captions tab):
 * the focus does not jump into the gallery when it shows later.
 */
export const FOCUS_WAIT = 1000
const focusListeners = new Set<() => void>()
export function focusGallery(): void {
  focusAsked = true
  if (focusExpiry) clearTimeout(focusExpiry)
  focusExpiry = setTimeout(() => {
    focusAsked = false
    focusExpiry = null
  }, FOCUS_WAIT)
  for (const l of focusListeners) l()
}
const focusTaken = (): void => {
  focusAsked = false
  if (focusExpiry) clearTimeout(focusExpiry)
  focusExpiry = null
}

/**
 * The first `n` tiles, with each of `keep` the list has among them: a later one takes the last place
 * no kept tile holds, and the tiles stay in the filter's order.
 */
function firstRows(tiles: readonly GalleryTile[], n: number, keep: readonly (string | null)[]): GalleryTile[] {
  const rows = tiles.slice(0, n)
  for (const t of tiles.slice(n)) {
    if (!keep.includes(t.id)) continue
    let free = rows.length - 1
    while (free >= 0 && keep.includes(rows[free].id)) free--
    if (free < 0) break
    rows.splice(free, 1)
    rows.push(t)
  }
  return rows
}

export function CaptionGallery(props: {
  value: CaptionSettings
  frame: { w: number; h: number }
  saved: readonly SavedLook[]
  brand: CaptionStudio | null
  suggested: string
  onPick(tile: string): void
  /** The tile previewed on the video and how (focus: Enter picks it; pointer: a click does), or null. */
  onPreview(tile: string | null, via?: 'focus' | 'pointer'): void
  /** The captions' language: 'bn' shows Bangla sample text on the tiles (§0.2). */
  language?: string
}): JSX.Element {
  const { value, frame, saved, brand, suggested, onPick, onPreview, language } = props
  const group = useGroup()
  const reduced = useReducedMotion()
  const fonts = useSyncExternalStore(onStyleAssetsChanged, fontGeneration)
  const [wanted, setWanted] = useState<string | null>(readFilter)
  const filter = usableFilter(wanted, frame, saved, brand)
  const tiles = galleryTiles(filter, value, saved, brand)
  const checked = checkedTile(value)
  const [showAll, setShowAll] = useState(false)

  // Two tiles per row at the Inspector's default width, three when it is wider than 460 px (§2.5).
  const gridRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(TILE.w * 2 + GAP)
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const measure = (): void => setWidth(el.clientWidth || TILE.w * 2 + GAP)
    measure()
    if (typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const cols = width > 460 ? 3 : 2
  const tileW = Math.max(96, Math.min(TILE.w, Math.floor((width - GAP * (cols - 1)) / cols)))
  const size = { w: tileW, h: Math.round((tileW * TILE.h) / TILE.w) }
  // The roving tab stop: the focused tile, else the checked one, else the first.
  const [focusId, setFocusId] = useState<string | null>(null)
  // Two rows. The checked tile is always among them, so the radio group's tab stop is the checked
  // radio (§2.15), and so is the focused one, so an undo that moves the checked look never takes
  // away the tile with the focus. A later one takes the last place neither holds.
  const shown = showAll ? tiles : firstRows(tiles, cols * 2, [checked, focusId])
  const stop = shown.find((t) => t.id === focusId)?.id ?? shown.find((t) => t.id === checked)?.id ?? shown[0]?.id ?? null
  // A focused tile can still leave the filter: an undo or redo to a Studio look takes away the
  // Classic "Your current style" tile. The focus then goes to the tab stop, not to the page.
  const hadFocus = typeof document !== 'undefined' && !!gridRef.current?.contains(document.activeElement)
  useLayoutEffect(() => {
    if (hadFocus && !gridRef.current?.contains(document.activeElement)) gridRef.current?.querySelector<HTMLElement>(`[data-tile="${stop}"]`)?.focus()
  })
  // The tile playing its look: hovered or focused (not under reduced motion), or Play's one loop.
  const [active, setActive] = useState<string | null>(null)
  const [once, setOnce] = useState<string | null>(null)
  // The saved tile Delete acts on when none is checked: the one focused last.
  const [lastSaved, setLastSaved] = useState<string | null>(null)

  // The preview on the video: after PREVIEW_DELAY on a tile; leaving clears it.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewing = useRef<string | null>(null)
  const stopPreview = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (previewing.current !== null) {
      previewing.current = null
      onPreview(null)
    }
  }
  const startPreview = (id: string, via: 'focus' | 'pointer'): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      previewing.current = id
      onPreview(id, via)
    }, PREVIEW_DELAY)
  }
  useEffect(() => stopPreview, [])

  const pick = (id: string): void => {
    stopPreview()
    onPick(id)
  }
  const setFilter = (f: GalleryFilter): void => {
    setWanted(f)
    writeFilter(f)
    setShowAll(false)
  }

  const focusTile = (id: string): void => {
    setFocusId(id)
    gridRef.current?.querySelector<HTMLElement>(`[data-tile="${id}"]`)?.focus()
  }
  // Caption styles…: the focus goes to the checked tile once the gallery shows, on the checked
  // tile's filter (switched to for this, not remembered).
  const takeFocus = (): void => {
    if (!focusAsked) return
    if (checked && !tiles.some((t) => t.id === checked)) {
      const home = galleryTiles('all', value, saved, brand).find((t) => t.id === checked)?.group
      // Taken once that filter shows (the effect below runs again).
      if (home && home !== filter) return setWanted(home)
    }
    const id = shown.find((t) => t.id === checked)?.id ?? stop
    if (!id) return
    focusTaken()
    gridRef.current?.querySelector<HTMLElement>(`[data-tile="${id}"]`)?.focus()
  }
  const takeRef = useRef(takeFocus)
  takeRef.current = takeFocus
  useEffect(() => {
    const take = (): void => takeRef.current()
    focusListeners.add(take)
    return () => void focusListeners.delete(take)
  }, [])
  useEffect(() => takeRef.current(), [filter, stop])
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    const i = shown.findIndex((t) => t.id === stop)
    if (i < 0) return
    let next = -1
    if (e.key === 'ArrowRight') next = Math.min(shown.length - 1, i + 1)
    else if (e.key === 'ArrowLeft') next = Math.max(0, i - 1)
    else if (e.key === 'ArrowDown') next = Math.min(shown.length - 1, i + cols)
    else if (e.key === 'ArrowUp') next = Math.max(0, i - cols)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = shown.length - 1
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      return pick(shown[i].id)
    } else if (e.key === 'Escape' && previewing.current !== null) {
      e.preventDefault()
      e.stopPropagation()
      return stopPreview()
    } else return
    e.preventDefault()
    e.stopPropagation()
    focusTile(shown[next].id)
  }

  // Delete acts on the checked saved tile, else the saved tile focused last (§2.5).
  const savedChecked = checked?.startsWith(MINE_PREFIX) ? saved.find((s) => `${MINE_PREFIX}${s.id}` === checked) : undefined
  const deletable = savedChecked ?? saved.find((s) => `${MINE_PREFIX}${s.id}` === lastSaved)
  const showsSaved = (filter === 'mine' || filter === 'all') && saved.length > 0
  const remove = (): void => {
    if (!deletable) return
    const at = saved.indexOf(deletable)
    const entry = deletable
    removeLook(entry.id).then(
      () => group.notice(`Deleted “${entry.name}”`, { action: { label: 'Undo', run: () => void restoreLook(entry, at) } }),
      (err: unknown) => group.notice(`The style could not be deleted: ${err instanceof Error ? err.message : String(err)}`)
    )
  }
  // Play plays the tile it names: the tab stop's (the focused tile, else the checked one, §2.5).
  const playTile = stop
  const playName = shown.find((t) => t.id === stop)?.name

  return (
    <div className="caption-gallery-wrap">
      <div className="chips caption-gallery-filter" role="group" aria-label="Show styles for" data-testid="caption-gallery-filter">
        {filtersFor(saved, brand).map((f) => (
          <button key={f.id} type="button" className={`chip ${filter === f.id ? 'active' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      <div
        ref={gridRef}
        className="caption-gallery"
        role="radiogroup"
        aria-label="Caption style"
        data-testid="caption-gallery"
        style={{ gridTemplateColumns: `repeat(${cols}, ${size.w}px)` }}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          // Focus moving out of the grid restores the preview.
          const next = e.relatedTarget as Node | null
          if (!next || !gridRef.current?.contains?.(next)) {
            stopPreview()
            setActive(null)
          }
        }}
      >
        {shown.map((t) => {
          const on = t.id === checked
          // "Your current style" is said as it is shown, on its own line under the name (§2.5).
          const label = t.current ? `${tileLabel(t)}, your current style` : tileLabel(t)
          const reason = t.id === suggested ? `tile-why-${t.id}` : undefined
          return (
            <div
              key={t.id}
              role="radio"
              aria-checked={on}
              aria-label={label}
              aria-describedby={reason}
              tabIndex={t.id === stop ? 0 : -1}
              data-tile={t.id}
              className={`caption-tile ${on ? 'checked' : ''}${t.current ? ' current' : ''}`}
              title={t.description}
              onClick={() => pick(t.id)}
              onFocus={() => {
                setFocusId(t.id)
                if (t.id.startsWith(MINE_PREFIX)) setLastSaved(t.id)
                // Focus never starts an animation under reduced motion (§2.15).
                if (!reduced) setActive(t.id)
                startPreview(t.id, 'focus')
              }}
              onPointerEnter={() => {
                if (!reduced) setActive(t.id)
                startPreview(t.id, 'pointer')
              }}
              onPointerLeave={() => {
                setActive((a) => (a === t.id ? null : a))
                stopPreview()
              }}
            >
              <Thumb
                look={tileLook(t, value)}
                frame={frame}
                size={size}
                language={language}
                playing={once === t.id ? 'once' : !reduced && active === t.id ? 'loop' : null}
                onDone={() => setOnce(null)}
                fonts={fonts}
              />
              <span className="tile-name">{t.name}</span>
              {t.current && <span className="tile-current">Your current style</span>}
              {t.id === suggested && (
                <>
                  <span className="tile-badge" aria-hidden="true">
                    Suggested
                  </span>
                  <span id={reason} className="sr-only">
                    {suggestedReason(t.id, frame)}
                  </span>
                </>
              )}
            </div>
          )
        })}
      </div>
      <div className="caption-gallery-tools">
        {tiles.length > cols * 2 && (
          <button type="button" className="btn small" aria-expanded={showAll} data-testid="caption-gallery-more" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer styles' : 'Show all styles'}
          </button>
        )}
        {playTile && (
          <button type="button" className="btn small" data-testid="caption-tile-play" aria-label={`Play a preview of ${playName}`} title={`Play a preview of ${playName}`} onClick={() => setOnce(playTile)}>
            Play
          </button>
        )}
        {showsSaved && (
          <button type="button" className="btn small ghost danger" data-testid="caption-tile-delete" disabled={!deletable} onClick={remove}>
            {deletable ? `Delete “${deletable.name}”` : 'Delete'}
          </button>
        )}
      </div>
    </div>
  )
}
