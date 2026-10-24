/**
 * "Hide desktop icons while recording" (Windows). The native helper hides the desktop's icon
 * view (`desktop-icons hide`) and shows it again (`desktop-icons show`); it never changes the
 * "Show desktop icons" setting, so restarting Explorer brings the icons back whatever happens.
 *
 * Restoring is what matters: the icons come back when the recording stops, is cancelled or
 * crashes and when the app quits. Before hiding, the fact that they are hidden is saved in the
 * app settings, so the next app start restores them if the app itself died meanwhile. Icons
 * that were already hidden (by the user's own setting) are left alone and never "restored".
 */
import type { DesktopIconsAction, DesktopIconsResult } from '../nativeCapture'

export interface DesktopIconsDeps {
  platform: NodeJS.Platform
  run(action: DesktopIconsAction): Promise<DesktopIconsResult>
  runSync(action: DesktopIconsAction): DesktopIconsResult
  /** Persistent "hidden by us" flag (AppSettingsStore). */
  state: { readonly desktopIconsHidden: boolean; setDesktopIconsHidden(hidden: boolean): void }
}

export class DesktopIcons {
  /** Operations run one after another (a hide still running when the recording is cancelled). */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: DesktopIconsDeps) {}

  private get supported(): boolean {
    return this.deps.platform === 'win32'
  }

  private remember(hidden: boolean): boolean {
    try {
      this.deps.state.setDesktopIconsHidden(hidden)
      return true
    } catch (err) {
      console.warn('Could not save the desktop icon state:', err)
      return false
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Hides the icons; true when they are hidden by this call. A no-op off Windows. */
  hide(): Promise<boolean> {
    if (!this.supported) return Promise.resolve(false)
    return this.enqueue(async () => {
      // Saved first: if the app dies right after hiding, the next start still restores them.
      // Unsaved, hiding would risk icons that stay hidden: do not hide then.
      if (!this.remember(true)) return false
      const r = await this.deps.run('hide')
      const ours = r.ok && r.changed
      if (!r.ok) console.warn('Could not hide the desktop icons:', r.message)
      // Already hidden (the user's own setting) or failed: nothing to restore later.
      if (!ours) this.remember(false)
      return ours
    })
  }

  /** Shows the icons again if a recording hid them (also after a crash). Never rejects. */
  restore(): Promise<void> {
    if (!this.supported) return Promise.resolve()
    return this.enqueue(async () => {
      if (!this.deps.state.desktopIconsHidden) return
      const r = await this.deps.run('show')
      if (r.ok) this.remember(false)
      // Kept as hidden otherwise: the next stop or app start tries again.
      else console.warn('Could not show the desktop icons again:', r.message)
    })
  }

  /** restore() for quitting: synchronous (the app no longer waits for promises). */
  restoreSync(): void {
    if (!this.supported || !this.deps.state.desktopIconsHidden) return
    const r = this.deps.runSync('show')
    if (r.ok) this.remember(false)
    else console.warn('Could not show the desktop icons again:', r.message)
  }
}
