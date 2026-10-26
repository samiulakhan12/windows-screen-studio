/**
 * The speaker notes window's page (`#/notes`, its own window: see src/main/notes/notesWindow.ts
 * and docs/design/teleprompter.md, "Notes window"). It loads styles.css like every route, so it
 * uses the design tokens directly; its own rules go in NotesWindow.css, scoped to .notes-window.
 *
 * The text column moves with one `transform` written by NotesScroller, outside React: a step
 * waits exactly one device pixel's time at the current block's speed (at most 30 a second),
 * writes only when the snapped position changed, and no timer runs while still. React renders
 * the blocks and the strip only when the text, the settings or the state shown change.
 *
 * While recording the window never takes focus (it is not focusable; nothing here calls
 * focus()); while rehearsing it is focusable and fully usable from the keyboard.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { NotesCommand, NotesLookPatch, NotesMode, NotesReport, NotesView } from '../../../shared/api/notes'
import { splitBlocks, type NotesBlock } from '../../../shared/notes/blocks'
import { NOTES_FONT, NOTES_HEIGHT, NOTES_WIDTH, NOTES_WPM, hasNotesText } from '../../../shared/notes/notes'
import { NOTES_COPY, notesButtonTitles, notesStatus, speedShort } from '../../../shared/notes/notesCopy'
import { applyView, choosePlaying, reachedEnd, type Playback } from '../../../shared/notes/playback'
import { ScrollClock, SCROLL, blockAt, endPosition, rateAt, snap, stepDelayMs, stepTarget, type BlockBox } from '../../../shared/notes/scroll'
import { installFocusRelease } from '../editor/focus'
import { RecIcon } from './recordingIcons'
import './NotesWindow.css'

const LINE_HEIGHT = 1.45
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** What the page shows about the scrolling (React state: changes a few times a minute at most). */
interface ScrollState {
  playing: boolean
  ended: boolean
}

/**
 * Moves the text column. Owns the clock and the one step timer; tells the page when playing,
 * ended or the block on the reading line change (and only then).
 */
class NotesScroller {
  readonly clock = new ScrollClock()
  private boxes: BlockBox[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private written = Number.NaN
  private block = -1
  private wpm: number = NOTES_WPM.default
  private lineHeight = 46
  private glide: { from: number; start: number } | null = null
  private last: NotesReport = { playing: false, ended: false, block: 0 }

  constructor(
    private readonly column: HTMLElement,
    private readonly root: HTMLElement,
    private readonly onChange: (report: NotesReport) => void
  ) {}

  private now(): number {
    return performance.now()
  }

  setLayout(boxes: BlockBox[], lineHeight: number): void {
    this.boxes = boxes
    this.lineHeight = lineHeight
    this.clock.setLayout(boxes, this.now())
    this.render()
  }

  setWpm(wpm: number): void {
    if (wpm === this.wpm) return
    this.wpm = wpm
    this.clock.setWpm(wpm, this.now())
    this.render()
  }

  get empty(): boolean {
    return this.boxes.length === 0
  }

  setPlaying(playing: boolean): void {
    const now = this.now()
    if (playing) this.clock.play(now)
    else this.clock.pause(now)
    this.render()
  }

  /** Moves to `y`; `glide` animates over SCROLL.glideMs on the step timer (never under reduced motion). */
  moveTo(y: number, glide = false): void {
    const now = this.now()
    const from = this.clock.positionAt(now)
    this.clock.jump(y, now)
    this.glide = glide && !reducedMotion() && SCROLL.glideMs > 0 ? { from, start: now } : null
    this.render()
  }

  moveBy(dy: number): void {
    this.moveTo(this.clock.positionAt(this.now()) + dy)
  }

  step(dir: 'back' | 'forward'): void {
    const y = this.clock.positionAt(this.now())
    this.moveTo(stepTarget(this.boxes, y, dir, this.lineHeight), true)
  }

  toEnd(): void {
    this.moveTo(endPosition(this.boxes))
  }

  get position(): number {
    return this.clock.positionAt(this.now())
  }

  /** Writes the position now and schedules the next step if anything moves. */
  private render(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const now = this.now()
    const dpr = window.devicePixelRatio || 1
    let y = this.clock.positionAt(now)
    let gliding = false
    if (this.glide) {
      const k = (now - this.glide.start) / SCROLL.glideMs
      if (k < 1) {
        const eased = 1 - (1 - k) * (1 - k)
        y = this.glide.from + (y - this.glide.from) * eased
        gliding = true
      } else this.glide = null
    }
    const snapped = snap(y, dpr)
    if (snapped !== this.written) {
      this.written = snapped
      this.column.style.transform = `translate3d(0, ${-snapped}px, 0)`
    }
    const block = blockAt(this.boxes, y)
    if (block !== this.block) {
      this.block = block
      this.root.dataset.block = String(block)
    }
    const ended = this.clock.endedAt(now)
    // The end stops the clock itself, so a later move (Home, Back, the wheel) leaves it still.
    if (ended && this.clock.playing) this.clock.pause(now)
    this.report({ playing: this.clock.playing && !ended && !this.empty, ended, block })
    if (gliding) {
      this.timer = setTimeout(() => this.render(), 1000 / SCROLL.maxWritesPerSecond)
      return
    }
    if (!this.clock.playing || ended || this.empty) return
    this.timer = setTimeout(() => this.render(), stepDelayMs(rateAt(this.boxes, y, this.wpm), dpr))
  }

  private report(r: NotesReport): void {
    const l = this.last
    if (l.playing === r.playing && l.ended === r.ended && l.block === r.block) return
    this.last = r
    this.onChange(r)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

/** The text: one element per block, rendered as text nodes only (never markup). */
const NotesText = memo(function NotesText({ blocks }: { blocks: NotesBlock[] }): JSX.Element {
  return (
    <>
      {blocks.map((b) => (
        <p key={b.index} className={`nw-block ${b.kind} ${b.gapBefore ? 'gap' : ''}`} data-index={b.index}>
          {b.kind === 'bullet' && (
            <span className="nw-marker" aria-hidden="true">
              {b.marker === '-' || b.marker === '*' ? '•' : b.marker}
            </span>
          )}
          {b.runs.map((r, i) =>
            r.cue ? (
              <span key={i} className="nw-cue">
                [{r.text}]
              </span>
            ) : (
              <span key={i}>{r.text}</span>
            )
          )}
        </p>
      ))}
    </>
  )
})

/** The resize grip: pointer capture, at most one size change per animation frame while dragging. */
function ResizeGrip({ onResize }: { onResize: (size: { width: number; height: number }) => void }): JSX.Element {
  const drag = useRef<{ x: number; y: number; width: number; height: number; frame: number; next: { width: number; height: number } | null } | null>(null)
  const move = (e: ReactPointerEvent<HTMLSpanElement>): void => {
    const d = drag.current
    if (!d) return
    d.next = {
      width: Math.round(clamp(d.width + e.screenX - d.x, NOTES_WIDTH.min, NOTES_WIDTH.max)),
      height: Math.round(clamp(d.height + e.screenY - d.y, NOTES_HEIGHT.min, NOTES_HEIGHT.max))
    }
    if (d.frame) return
    d.frame = requestAnimationFrame(() => {
      if (!drag.current) return
      drag.current.frame = 0
      if (drag.current.next) onResize(drag.current.next)
      drag.current.next = null
    })
  }
  const end = (e: ReactPointerEvent<HTMLSpanElement>): void => {
    const d = drag.current
    if (!d) return
    if (d.frame) cancelAnimationFrame(d.frame)
    if (d.next) onResize(d.next)
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }
  return (
    <span
      className="nw-grip"
      title={NOTES_COPY.resize}
      aria-hidden="true"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture?.(e.pointerId)
        drag.current = { x: e.screenX, y: e.screenY, width: window.innerWidth, height: window.innerHeight, frame: 0, next: null }
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <RecIcon name="resize" size={14} />
    </span>
  )
}

export function NotesWindow(): JSX.Element {
  const [view, setView] = useState<NotesView | null>(null)
  /** Changes made here (speed, text size) shown at once, until main sends them back in a view. */
  const [look, setLook] = useState<NotesLookPatch>({})
  const [scroll, setScroll] = useState<ScrollState>({ playing: false, ended: false })
  /** Whether the presenter wants it to scroll (shown during the countdown: it starts with the recording or not). */
  const [want, setWant] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const scroller = useRef<NotesScroller | null>(null)
  const playback = useRef<Playback | null>(null)
  const viewRef = useRef<NotesView | null>(null)
  viewRef.current = view

  const settings = view?.settings
  const wpm = look.wpm ?? settings?.wpm ?? NOTES_WPM.default
  const fontSize = look.fontSize ?? settings?.fontSize ?? NOTES_FONT.default
  const text = settings?.text ?? ''
  const blocks = useMemo(() => splitBlocks(text), [text])
  const mode: NotesMode = view?.mode ?? 'rehearse'

  const applyPlaying = useCallback((p: Playback) => {
    playback.current = p
    setWant(p.want)
    scroller.current?.setPlaying(p.playing)
  }, [])

  // The scroller lives as long as the page; it reports changes to main and to this page.
  useLayoutEffect(() => {
    const column = columnRef.current
    const root = rootRef.current
    if (!column || !root) return
    const s = new NotesScroller(column, root, (r) => {
      if (r.ended && playback.current?.playing) playback.current = reachedEnd(playback.current)
      setScroll((prev) => (prev.playing === r.playing && prev.ended === r.ended ? prev : { playing: r.playing, ended: r.ended }))
      try {
        window.api.reportNotes(r)
      } catch (err) {
        console.warn('Could not report the notes state:', err)
      }
    })
    scroller.current = s
    return () => {
      s.dispose()
      scroller.current = null
    }
  }, [])

  // The view from main: now and on every change.
  useEffect(() => {
    let live = true
    const receive = (v: NotesView): void => {
      if (!live || !v) return
      setView(v)
      setLook({})
    }
    const off = window.api.onNotesView(receive)
    window.api.getNotesView().then(
      (v) => v && receive(v),
      (err: unknown) => console.warn('Could not read the notes view:', err)
    )
    return () => {
      live = false
      off()
    }
  }, [])

  // How the text follows the recording: after each view (playback.ts).
  useEffect(() => {
    if (!view) return
    const { state, toTop } = applyView(playback.current, {
      mode: view.mode,
      recording: view.recording,
      take: view.take,
      shown: view.shown,
      autoStart: view.settings.autoStart
    })
    if (toTop) scroller.current?.moveTo(0)
    applyPlaying(state)
  }, [view, applyPlaying])

  useEffect(() => {
    scroller.current?.setWpm(wpm)
  }, [wpm])

  // Measures the blocks after the text, the size or the width changed.
  const measure = useCallback(() => {
    const column = columnRef.current
    const s = scroller.current
    if (!column || !s) return
    const top = column.getBoundingClientRect().top
    const els = Array.from(column.querySelectorAll<HTMLElement>('.nw-block'))
    const tops = els.map((el) => el.getBoundingClientRect().top - top)
    const boxes: BlockBox[] = els.map((el, i) => {
      const next = i + 1 < els.length ? tops[i + 1] : tops[i] + el.getBoundingClientRect().height
      return { top: tops[i], height: Math.max(0, next - tops[i]), words: blocks[i]?.words ?? 0 }
    })
    s.setLayout(boxes, parseFloat(getComputedStyle(column).fontSize) * LINE_HEIGHT || 46)
  }, [blocks])

  useLayoutEffect(() => {
    measure()
  }, [measure, fontSize])

  useEffect(() => {
    const column = columnRef.current
    if (!column || typeof ResizeObserver === 'undefined') return
    let width = column.clientWidth
    const observer = new ResizeObserver(() => {
      // Only a new width rewraps the text (the height follows from it).
      if (column.clientWidth === width) return
      width = column.clientWidth
      measure()
    })
    observer.observe(column)
    return () => observer.disconnect()
  }, [measure])

  const sendLook = useCallback((patch: NotesLookPatch) => {
    setLook((l) => ({ ...l, ...patch }))
    window.api.setNotesLook(patch)
  }, [])

  const changeWpm = useCallback(
    (delta: number) => {
      const next = clamp(wpm + delta, NOTES_WPM.min, NOTES_WPM.max)
      if (next !== wpm) sendLook({ wpm: next })
    },
    [wpm, sendLook]
  )
  const changeFont = useCallback(
    (delta: number) => {
      const next = clamp(fontSize + delta, NOTES_FONT.min, NOTES_FONT.max)
      if (next !== fontSize) sendLook({ fontSize: next })
    },
    [fontSize, sendLook]
  )

  const toggle = useCallback(() => {
    const p = playback.current
    const s = scroller.current
    if (!p || !s) return
    // Held by the countdown or hidden: the choice applies once it is not; else it acts now.
    const play = p.recording === 'countdown' || !p.shown ? !p.want : !p.playing
    // Play at the end starts over from the top.
    if (play && s.clock.endedAt(performance.now())) s.moveTo(0)
    applyPlaying(choosePlaying(p, play))
  }, [applyPlaying])

  const command = useCallback(
    (c: NotesCommand) => {
      if (c === 'toggle') toggle()
      else scroller.current?.step(c)
    },
    [toggle]
  )

  useEffect(() => window.api.onNotesCommand(command), [command])

  // Mouse wheel over the text: moves the text (passive); Ctrl + wheel: text size (not passive).
  const fontRef = useRef(changeFont)
  fontRef.current = changeFont
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    let lastFont = 0
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) return
      // deltaY in pixels: lines are text lines, pages are the text area's height.
      const unit = e.deltaMode === 1 ? parseFloat(getComputedStyle(area).fontSize) * LINE_HEIGHT : e.deltaMode === 2 ? area.clientHeight : 1
      if (e.deltaY) scroller.current?.moveBy(e.deltaY * (unit || 1))
    }
    const onCtrlWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      if (!e.deltaY || e.timeStamp - lastFont < 80) return
      lastFont = e.timeStamp
      fontRef.current(e.deltaY < 0 ? NOTES_FONT.step : -NOTES_FONT.step)
    }
    area.addEventListener('wheel', onWheel, { passive: true })
    area.addEventListener('wheel', onCtrlWheel, { passive: false })
    return () => {
      area.removeEventListener('wheel', onWheel)
      area.removeEventListener('wheel', onCtrlWheel)
    }
  }, [])

  // A button pressed with the mouse gives the focus back, so Space stays play / pause (a button
  // reached with Tab keeps it).
  useEffect(() => (mode === 'rehearse' ? installFocusRelease() : undefined), [mode])

  // The rehearsal keyboard (the recording window never has focus).
  useEffect(() => {
    if (mode !== 'rehearse') return
    const onKey = (e: KeyboardEvent): void => {
      const s = scroller.current
      if (!s || e.altKey || e.metaKey) return
      const onButton = e.target instanceof HTMLElement && e.target.closest('button')
      const area = areaRef.current?.clientHeight ?? 0
      // The characters, so − and + work on every keyboard layout (a dead key is 'Dead').
      const minus = e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract'
      const plus = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd'
      let handled = true
      if (e.ctrlKey) {
        if (minus) changeFont(-NOTES_FONT.step)
        else if (plus) changeFont(NOTES_FONT.step)
        else handled = false
      } else if (e.key === ' ' || e.code === 'Space') {
        if (onButton) return
        if (!e.repeat) toggle()
      } else if (e.key === 'ArrowUp') s.step('back')
      else if (e.key === 'ArrowDown') s.step('forward')
      else if (e.key === 'PageUp') s.moveBy((-2 / 3) * area)
      else if (e.key === 'PageDown') s.moveBy((2 / 3) * area)
      else if (e.key === 'Home') s.moveTo(0)
      else if (e.key === 'End') s.toEnd()
      else if (minus) changeWpm(-NOTES_WPM.step)
      else if (plus) changeWpm(NOTES_WPM.step)
      else if (e.key === 'Escape') window.api.dismissNotes()
      else handled = false
      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, toggle, changeFont, changeWpm])

  const empty = !hasNotesText(text)
  const recording = view?.mode === 'record' ? view.recording : null
  const status = notesStatus({ mode, recording, playing: scroll.playing, ended: scroll.ended, want })
  // During the countdown the button shows what happens when the recording starts.
  const on = recording === 'countdown' ? want : scroll.playing
  const titles = notesButtonTitles(view?.hotkeys ?? {}, mode, on)
  const problems = view?.problems ?? []
  const locked = view?.locked === true

  return (
    <main
      ref={rootRef}
      className={`notes-window ${mode}`}
      aria-label={NOTES_COPY.windowLabel}
      data-mode={mode}
      data-playing={scroll.playing ? 'true' : 'false'}
      data-ended={scroll.ended ? 'true' : 'false'}
      data-block="0"
    >
      <div ref={areaRef} className="nw-text" role="document" aria-label={NOTES_COPY.windowLabel} style={{ fontSize }}>
        <div ref={columnRef} className="nw-column">
          <NotesText blocks={blocks} />
        </div>
        <div className="nw-dim" aria-hidden="true" />
        <div className="nw-line" aria-hidden="true">
          <span className="nw-line-marker">▸</span>
        </div>
        {empty && view && <p className="nw-empty">{NOTES_COPY.emptyRehearsal}</p>}
        {scroll.ended && !empty && (
          <button type="button" className="nw-restart" onClick={() => scroller.current?.moveTo(0)}>
            {NOTES_COPY.backToStart}
          </button>
        )}
      </div>
      <div className="nw-strip" role="toolbar" aria-label="Notes controls">
        <div className="nw-controls">
          <button type="button" className="nw-btn" aria-label="Back" title={titles.back} disabled={empty} onClick={() => scroller.current?.step('back')}>
            <RecIcon name="step-back" size={14} />
          </button>
          <button
            type="button"
            className="nw-btn nw-play"
            aria-label={on ? 'Pause scrolling' : 'Start scrolling'}
            aria-pressed={on}
            title={titles.toggle}
            disabled={empty}
            onClick={toggle}
          >
            <RecIcon name={on ? 'pause' : 'play'} size={14} />
          </button>
          <button type="button" className="nw-btn" aria-label="Forward" title={titles.forward} disabled={empty} onClick={() => scroller.current?.step('forward')}>
            <RecIcon name="step-forward" size={14} />
          </button>
          <span className="nw-sep" aria-hidden="true" />
          <button type="button" className="nw-btn" aria-label="Slower" title={titles.slower} disabled={wpm <= NOTES_WPM.min} onClick={() => changeWpm(-NOTES_WPM.step)}>
            <RecIcon name="minus" size={12} />
          </button>
          <span className="nw-speed" aria-label={`Speed ${wpm} words a minute`}>
            {speedShort(wpm)}
          </span>
          <button type="button" className="nw-btn" aria-label="Faster" title={titles.faster} disabled={wpm >= NOTES_WPM.max} onClick={() => changeWpm(NOTES_WPM.step)}>
            <RecIcon name="plus" size={12} />
          </button>
          <span className="nw-sep" aria-hidden="true" />
          <button type="button" className="nw-btn nw-font" aria-label="Smaller text" title={titles.smaller} disabled={fontSize <= NOTES_FONT.min} onClick={() => changeFont(-NOTES_FONT.step)}>
            A<span className="nw-font-sign">−</span>
          </button>
          <button type="button" className="nw-btn nw-font" aria-label="Larger text" title={titles.larger} disabled={fontSize >= NOTES_FONT.max} onClick={() => changeFont(NOTES_FONT.step)}>
            A<span className="nw-font-sign">+</span>
          </button>
        </div>
        <span className="nw-status" aria-live="polite">
          {status}
        </span>
        {problems.length > 0 && (
          <span className="nw-warn" role="img" aria-label={NOTES_COPY.hotkeyProblem} title={problems.join('\n')}>
            !
          </span>
        )}
        <button type="button" className="nw-btn nw-close" aria-label={mode === 'record' ? 'Hide notes' : 'Close'} title={titles.close} onClick={() => window.api.dismissNotes()}>
          <RecIcon name="x" size={14} />
        </button>
        {locked ? (
          <span className="nw-lock" role="img" aria-label={NOTES_COPY.locked} title={NOTES_COPY.locked}>
            <RecIcon name="lock" size={13} />
          </span>
        ) : (
          <ResizeGrip onResize={(size) => window.api.setNotesLook(size)} />
        )}
      </div>
    </main>
  )
}
