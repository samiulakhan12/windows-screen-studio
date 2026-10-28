/**
 * Ties an export the export dialog runs to the long-jobs registry in main (F-12,
 * docs/design/hands-off.md): progress for the taskbar button, Pause / Resume / Stop from its
 * thumbnail buttons and from sleep, and the notification when it ends. When main cannot register
 * the job, the export simply runs without it.
 */
import { useEffect, useMemo, useState } from 'react'
import type { JobOutcome } from '../../../shared/jobs/longJobs'
import { PauseGate } from './pauseGate'

/** Most progress messages per second (the taskbar needs no more). */
const UPDATE_EVERY_MS = 250

export interface ExportJobHooks {
  gate: PauseGate
  /** Stop from the taskbar: the dialog's Cancel. */
  onStop: () => void
  /** Paused (true) or resumed (false) because the PC went to sleep or woke up. */
  onSleep: (paused: boolean) => void
}

export class ExportJobLink {
  private fraction: number | null = 0
  private pausable = true
  private lastSent = 0
  private ended = false
  private readonly unsubscribe: (() => void)[] = []

  private constructor(
    private readonly id: string,
    private readonly hooks: ExportJobHooks
  ) {
    this.unsubscribe.push(
      window.api.onJobCommand((cmd) => {
        if (cmd.id !== this.id || this.ended) return
        if (cmd.action === 'stop') hooks.onStop()
        else if (cmd.action === 'pause') {
          hooks.gate.pause()
          if (cmd.sleep) hooks.onSleep(true)
        } else {
          hooks.gate.resume()
          if (cmd.sleep) hooks.onSleep(false)
        }
      }),
      hooks.gate.subscribe(() => this.send(true))
    )
  }

  /** Registers the export; null when main could not (the export runs anyway). */
  static async begin(hooks: ExportJobHooks): Promise<ExportJobLink | null> {
    try {
      const id = await window.api.jobBegin('export', { pausable: true })
      return typeof id === 'string' ? new ExportJobLink(id, hooks) : null
    } catch {
      return null
    }
  }

  /** The share done (null: unknown, e.g. finalizing) and whether Pause can be offered now. */
  progress(fraction: number | null, pausable: boolean): void {
    const changed = pausable !== this.pausable || (fraction === null) !== (this.fraction === null)
    this.fraction = fraction
    this.pausable = pausable
    this.send(changed)
  }

  private send(force: boolean): void {
    if (this.ended) return
    const now = performance.now()
    if (!force && now - this.lastSent < UPDATE_EVERY_MS) return
    this.lastSent = now
    window.api.jobUpdate(this.id, { fraction: this.fraction, paused: this.hooks.gate.paused, pausable: this.pausable })
  }

  /** Ends the job (once); a done export lists the files it wrote, for the notification. */
  async end(outcome: JobOutcome): Promise<void> {
    if (this.ended) return
    this.ended = true
    this.unsubscribe.forEach((u) => u())
    await window.api.jobEnd(this.id, outcome).catch(() => undefined)
  }
}

export interface LongJob {
  gate: PauseGate
  /** The export waits between frames. */
  paused: boolean
  /** Paused because the PC went to sleep (resumed by itself when it wakes). */
  slept: boolean
  /** Registers an export about to run; Stop from the taskbar aborts `controller`. */
  begin(controller: AbortController): Promise<ExportJobLink | null>
  /** The dialog's Pause / Resume. */
  toggle(): void
}

/** The export dialog's pause gate and its link to the taskbar (F-12). */
export function useLongJob(): LongJob {
  const gate = useMemo(() => new PauseGate(), [])
  const [paused, setPaused] = useState(false)
  const [slept, setSlept] = useState(false)
  useEffect(() => gate.subscribe(setPaused), [gate])
  return {
    gate,
    paused,
    slept,
    begin: (controller) => {
      gate.resume()
      setSlept(false)
      return ExportJobLink.begin({ gate, onStop: () => controller.abort(), onSleep: setSlept })
    },
    toggle: () => {
      if (gate.paused) {
        setSlept(false)
        gate.resume()
      } else gate.pause()
    }
  }
}

/** The taskbar share of an export's progress: frames while rendering, unknown while finalizing. */
export function progressShare(p: { phase: 'preparing' | 'rendering' | 'finalizing'; frame: number; frames: number } | null): { fraction: number | null; pausable: boolean } {
  if (!p || p.phase === 'preparing') return { fraction: 0, pausable: false }
  if (p.phase === 'finalizing') return { fraction: null, pausable: false }
  return { fraction: p.frames > 0 ? p.frame / p.frames : 0, pausable: true }
}
