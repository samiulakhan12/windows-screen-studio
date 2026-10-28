/**
 * Clean voice's stems as the editor sees them (docs/design/clean-voice.md §4.4): where each
 * project's cleaned stem stands (by source and strength), and the preview's "Hear the original"
 * switch. The preview asks for the stem it needs (`want`), which makes a missing one at once,
 * but never again after the user stopped it or it failed; the panel's buttons and the export
 * make it whatever happened before (`prepare`).
 */
import { VOICE_CANCELLED, type VoiceApi } from '../../../shared/api/voice'
import type { VoiceSource } from '../../../shared/audio/voiceClean'
import type { VoiceStrength } from '../../../shared/types'

export type VoiceStemState =
  | { state: 'checking' }
  | { state: 'missing' }
  | { state: 'working'; progress: number }
  | { state: 'ready'; file: string }
  /** The user pressed Cancel. */
  | { state: 'stopped' }
  | { state: 'failed'; message: string }

const CHECKING: VoiceStemState = { state: 'checking' }

/** "Error invoking remote method 'x': Error: message" -> "message". */
const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const keyOf = (projectId: string, source: VoiceSource, strength: VoiceStrength): string => `${projectId}|${source}|${strength}`

export class VoiceStems {
  private readonly entries = new Map<string, VoiceStemState>()
  private readonly original = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private readonly running = new Map<string, Promise<string>>()
  /** Per project: how often its editor closed (a render that ends after that is not recorded). */
  private readonly epochs = new Map<string, number>()
  private version = 0

  constructor(private readonly api: VoiceApi) {
    api.onVoiceProgress((p) => {
      const key = keyOf(p.projectId, p.source, p.strength)
      const e = this.entries.get(key)
      // Late events of a render that ended or was replaced are ignored.
      if (e?.state === 'working' && p.progress < 1) this.set(key, { state: 'working', progress: p.progress })
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Changes whenever anything here does (a stable snapshot for useSyncExternalStore). */
  getVersion = (): number => this.version

  private emit(): void {
    this.version++
    for (const l of [...this.listeners]) l()
  }

  private set(key: string, state: VoiceStemState): void {
    this.entries.set(key, state)
    this.emit()
  }

  get(projectId: string, source: VoiceSource, strength: VoiceStrength): VoiceStemState {
    return this.entries.get(keyOf(projectId, source, strength)) ?? CHECKING
  }

  /** The stem the preview needs: checked once, and made when missing (not after Cancel or a failure). */
  want(projectId: string, source: VoiceSource, strength: VoiceStrength): void {
    const key = keyOf(projectId, source, strength)
    if (this.entries.has(key)) return
    this.entries.set(key, CHECKING)
    void this.api.voiceStatus(projectId, source, strength).then(
      (s) => {
        if (this.entries.get(key) !== CHECKING) return
        if (s.state === 'ready') this.set(key, s)
        else void this.prepare(projectId, source, strength).catch(() => undefined)
      },
      (err: unknown) => this.set(key, { state: 'failed', message: ipcMessage(err) })
    )
  }

  /** Makes the stem (or joins the render making it); resolves with its file name. */
  prepare(projectId: string, source: VoiceSource, strength: VoiceStrength): Promise<string> {
    const key = keyOf(projectId, source, strength)
    const current = this.entries.get(key)
    if (current?.state === 'ready') return Promise.resolve(current.file)
    const running = this.running.get(key)
    if (running) return running
    this.set(key, { state: 'working', progress: 0 })
    const epoch = this.epochs.get(projectId) ?? 0
    const live = (): boolean => (this.epochs.get(projectId) ?? 0) === epoch
    const run = this.api.voiceStatus(projectId, source, strength).then((s) => (s.state === 'ready' ? s.file : this.api.prepareVoice(projectId, source, strength)))
    const done = run.then(
      (file) => {
        if (live()) this.set(key, { state: 'ready', file })
        return file
      },
      (err: unknown) => {
        const message = ipcMessage(err)
        if (live()) this.set(key, message === VOICE_CANCELLED ? { state: 'stopped' } : { state: 'failed', message })
        throw new Error(message)
      }
    )
    const tracked = done.finally(() => {
      if (this.running.get(key) === tracked) this.running.delete(key)
    })
    tracked.catch(() => undefined)
    this.running.set(key, tracked)
    return tracked
  }

  /** Stops the project's render (its entry becomes `stopped` when the render ends). */
  cancel(projectId: string): Promise<void> {
    return this.api.cancelVoice(projectId)
  }

  /**
   * The stem's file is gone or unreadable (the preview could not load it): forgotten, so the next
   * `want` checks again and makes it.
   */
  forget(projectId: string, source: VoiceSource, strength: VoiceStrength): void {
    const key = keyOf(projectId, source, strength)
    if (this.entries.get(key)?.state !== 'ready') return
    this.entries.delete(key)
    this.emit()
  }

  /** Whether the preview plays the original voice (view state: never saved, never undone). */
  isOriginal(projectId: string): boolean {
    return this.original.has(projectId)
  }

  setOriginal(projectId: string, on: boolean): void {
    if (this.original.has(projectId) === on) return
    if (on) this.original.add(projectId)
    else this.original.delete(projectId)
    this.emit()
  }

  /** The editor closed: its A/B choice is dropped, and what main may have stopped is checked again next time. */
  closeProject(projectId: string): void {
    this.epochs.set(projectId, (this.epochs.get(projectId) ?? 0) + 1)
    this.original.delete(projectId)
    for (const [key, e] of this.entries) if (key.startsWith(`${projectId}|`) && e.state !== 'ready') this.entries.delete(key)
    for (const key of [...this.running.keys()]) if (key.startsWith(`${projectId}|`)) this.running.delete(key)
    this.emit()
  }
}

let shared: VoiceStems | null = null

/** The window's store (created on first use, so tests and pages without the API never touch it). */
export function voiceStems(): VoiceStems {
  shared ??= new VoiceStems(window.api)
  return shared
}
