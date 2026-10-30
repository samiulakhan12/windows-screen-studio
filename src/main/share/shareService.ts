/**
 * Share runs (F-22, docs/design/share.md §2.7, §2.8): copies an exported file into the chosen
 * folders, one at a time, then posts to the chosen chats with where it went. Main owns the runs;
 * the page starts and cancels them and watches their views, and the "Export finished"
 * notification starts them with its buttons. Everything outside (the folders, the store, copying,
 * posting, the window, notifications) comes in as ShareDeps, so tests drive it directly.
 */
import type { ShareFolderInfo, ShareMeta, ShareRunView, ShareStepView } from '../../shared/api/share'
import { placeText } from '../../shared/share/cloudFolders'
import { cleanTitle, shareMessage, type SharePlace, type WebhookService } from '../../shared/share/webhooks'
import type { CopyResult } from './copyToFolder'

export interface ShareDeps {
  /** Folders found and added, with whether each is on. */
  folders(): Promise<ShareFolderInfo[]>
  hook(id: string): { service: WebhookService; label: string; url: string }
  hookIds(): string[]
  isExported(file: string): boolean
  copy(file: string, folder: ShareFolderInfo, signal: AbortSignal, onProgress: (fraction: number) => void): Promise<CopyResult>
  post(hook: { service: WebhookService; url: string }, lines: string[], signal: AbortSignal): Promise<void>
  /** A share link for a copy, when the cloud app offers one locally (none today). */
  link?(folder: ShareFolderInfo, dest: string): Promise<string | null>
  send(run: ShareRunView): void
  isFocused(): boolean
  notify(n: { title: string; body: string; show?: string }): void
}

export const MAX_RUNS = 4
/** Longest wait for the folders before the notification shows without them. */
export const EXTRAS_WAIT_MS = 1500
const MAX_TARGETS = 12
const MAX_OFFERS = 200

interface Run {
  view: ShareRunView
  meta: ShareMeta
  controller: AbortController
}

/** The page's meta, checked. */
export function validMeta(raw: unknown): ShareMeta {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid share request.')
  const { title, seconds } = raw as Record<string, unknown>
  if (typeof title !== 'string' || title.length > 200) throw new Error('Invalid share request.')
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new Error('Invalid share request.')
  return { title, seconds }
}

/** What a finished step says: "Saved to OneDrive › Flown", "Posted to #demos". */
export function stepDoneText(s: ShareStepView): string {
  if (s.kind === 'post') return `Posted to ${s.label}`
  return s.message ?? `Saved to ${placeText(s.label)}`
}

export class ShareService {
  private runs = new Map<string, Run>()
  private offers = new Map<string, { meta: ShareMeta; auto: boolean }>()
  /** Where each file was last copied this session, for later posts. */
  private places = new Map<string, SharePlace>()
  private counter = 0

  constructor(private readonly deps: ShareDeps) {}

  /** Remembers what a message says about `file` (and whether the page shares it itself). */
  offer(file: unknown, meta: unknown, auto: unknown): void {
    if (typeof file !== 'string' || !this.deps.isExported(file)) return
    this.offers.set(file, { meta: validMeta(meta), auto: auto === true })
    while (this.offers.size > MAX_OFFERS) this.offers.delete(this.offers.keys().next().value as string)
  }

  /** Starts a run; throws a message to show when it cannot. */
  async start(file: unknown, targets: unknown, rawMeta: unknown): Promise<ShareRunView> {
    if (typeof file !== 'string' || !this.deps.isExported(file)) throw new Error('Only files exported in this session can be shared.')
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_TARGETS || !targets.every((t) => typeof t === 'string')) throw new Error('Choose where to share it.')
    const meta = validMeta(rawMeta)
    const folders = await this.deps.folders()
    // Checked after the wait and before the run is added, with nothing awaited between: two starts
    // at once (a double click, the notification and the page) cannot both pass.
    const active = [...this.runs.values()].filter((r) => !r.view.finished)
    if (active.length >= MAX_RUNS) throw new Error('Wait for the other shares to finish.')
    const ids = [...new Set(targets as string[])]
    const steps: ShareStepView[] = []
    for (const id of ids) {
      const f = folders.find((x) => x.id === id)
      if (f) {
        if (!f.on) throw new Error(`${f.label} is turned off in Settings › Share.`)
        steps.push({ target: id, kind: 'copy', service: f.service, label: f.label, state: 'waiting' })
      }
    }
    for (const id of ids) {
      if (folders.some((x) => x.id === id)) continue
      if (id.startsWith('cf')) throw new Error('This folder is not set up any more. Look in Settings › Share.')
      const h = this.deps.hook(id)
      steps.push({ target: id, kind: 'post', service: h.service, label: h.label, state: 'waiting' })
    }
    for (const r of active) {
      const busy = steps.find((s) => r.view.file === file && r.view.steps.some((x) => x.target === s.target && (x.state === 'running' || x.state === 'waiting')))
      if (busy) throw new Error(`Already sharing to ${busy.label}.`)
    }
    const run: Run = {
      view: { id: `sr${(this.counter++).toString(36)}${Date.now().toString(36)}`, file, steps, finished: false },
      meta,
      controller: new AbortController()
    }
    this.runs.set(run.view.id, run)
    // Finished runs of other files are forgotten after a while (a session can export a lot).
    if (this.runs.size > 100) for (const [id, r] of this.runs) if (r.view.finished && this.runs.size > 100) this.runs.delete(id)
    const view = this.snapshot(run)
    void this.execute(run, folders)
    return view
  }

  cancel(id: unknown): void {
    const run = typeof id === 'string' ? this.runs.get(id) : undefined
    if (run && !run.view.finished) run.controller.abort()
  }

  runsFor(file: unknown): ShareRunView[] {
    return [...this.runs.values()].filter((r) => r.view.file === file).map((r) => this.snapshot(r))
  }

  /** Cancels every run (the app is quitting). */
  dispose(): void {
    for (const r of this.runs.values()) r.controller.abort()
  }

  /**
   * The "Export finished" notification's extra buttons for `file` (at most 3): one per folder that
   * is on and chat that can be read, when the page did not share it itself.
   */
  async extras(file: string): Promise<{ text: string; run: () => void }[]> {
    const offer = this.offers.get(file)
    if (!offer || offer.auto) return []
    // The notification never waits long for the folders (a stale look-up runs reg.exe).
    const listed = await Promise.race([this.deps.folders(), new Promise<null>((r) => setTimeout(() => r(null), EXTRAS_WAIT_MS))])
    const folders = (listed ?? []).filter((f) => f.on)
    const out: { text: string; run: () => void }[] = []
    const startOne = (id: string): void => {
      this.start(file, [id], offer.meta).catch((err: unknown) => this.deps.notify({ title: 'Could not share', body: err instanceof Error ? err.message : String(err) }))
    }
    for (const f of folders) out.push({ text: `Copy to ${cleanTitle(f.label, 30)}`, run: () => startOne(f.id) })
    for (const id of this.deps.hookIds()) {
      try {
        const h = this.deps.hook(id)
        out.push({ text: `Post to ${cleanTitle(h.label, 30)}`, run: () => startOne(id) })
      } catch {
        // A chat whose webhook cannot be read is not offered.
      }
    }
    return out.slice(0, 3)
  }

  private snapshot(run: Run): ShareRunView {
    return { ...run.view, steps: run.view.steps.map((s) => ({ ...s })) }
  }

  private emit(run: Run): void {
    this.deps.send(this.snapshot(run))
  }

  private async execute(run: Run, folders: ShareFolderInfo[]): Promise<void> {
    const { signal } = run.controller
    const file = run.view.file
    let copyFailed = false
    for (const step of run.view.steps) {
      if (signal.aborted) {
        step.state = 'cancelled'
        continue
      }
      step.state = 'running'
      this.emit(run)
      try {
        if (step.kind === 'copy') {
          const folder = folders.find((f) => f.id === step.target)!
          let lastTenth = -1
          const result = await this.deps.copy(file, folder, signal, (fraction) => {
            step.fraction = fraction
            // The page needs no more than each 1 %.
            const pct = Math.floor(fraction * 100)
            if (pct !== lastTenth) {
              lastTenth = pct
              this.emit(run)
            }
          })
          step.dest = result.dest
          step.fraction = 1
          const link = (await this.deps.link?.(folder, result.dest).catch(() => null)) ?? null
          if (link) step.link = link
          if (result.already) step.message = `Already in ${placeText(folder.label)}`
          this.places.set(file, { text: placeText(folder.label), ...(link ? { link } : {}) })
          console.info(`Share: copied 1 file to ${folder.service}${result.already ? ' (already there)' : ''}`)
        } else {
          if (copyFailed) throw new Error('Not posted: the copy failed.')
          const hook = this.deps.hook(step.target)
          await this.deps.post(hook, shareMessage(run.meta, this.places.get(file)), signal)
          console.info(`Share: posted to ${hook.service}`)
        }
        step.state = 'done'
      } catch (err) {
        if (signal.aborted) {
          step.state = 'cancelled'
        } else {
          step.state = 'failed'
          step.message = err instanceof Error ? err.message : String(err)
          if (step.kind === 'copy') copyFailed = true
          console.warn(`Share: ${step.kind} to ${step.service} failed`)
        }
      }
      this.emit(run)
    }
    run.view.finished = true
    this.emit(run)
    if (this.deps.isFocused() || signal.aborted) return
    const failed = run.view.steps.find((s) => s.state === 'failed')
    const copied = run.view.steps.find((s) => s.kind === 'copy' && s.state === 'done' && s.dest)
    if (failed) this.deps.notify({ title: 'Could not share', body: `${failed.label}: ${failed.message ?? ''}`.slice(0, 200), ...(copied?.dest ? { show: copied.dest } : {}) })
    else this.deps.notify({ title: 'Shared', body: run.view.steps.map(stepDoneText).join(' · ').slice(0, 200), ...(copied?.dest ? { show: copied.dest } : {}) })
  }
}
