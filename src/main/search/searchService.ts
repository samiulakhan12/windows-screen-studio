/**
 * The search index's owner in the main process (docs/design/search.md §2.1, §2.9): loads the index
 * file, reconciles it with the project folders in the background (a slice of work at a time),
 * takes the editor's saves, answers queries and writes the file back, at most every few seconds.
 * Everything that touches the disk or the clock is injected, so tests run it on a fake.
 *
 * Privacy (§6): log lines carry counts and times only, never a query or indexed text.
 */
import path from 'node:path'
import { SearchIndex } from '../../shared/search/engine'
import { indexedProject } from '../../shared/search/extract'
import { parseIndexFile, serializeIndex } from '../../shared/search/indexFile'
import { SEARCH_LIMITS, type IndexedProject, type SearchResponse, type SearchStatus } from '../../shared/search/types'

/** Folder names a project can have (the rule of projects.ts). */
const ID_RE = /^[a-zA-Z0-9_-]+$/

/** Timings of §4. */
export const SEARCH_TIMING = {
  saveDebounceMs: 1500,
  writeDebounceMs: 3000,
  reconcileAfterMs: 2000,
  /** How long a query waits for a reconcile it started before answering from what is there. */
  queryWaitMs: 300,
  sliceMs: 8
} as const

/** Largest project.json or index file read (§4). */
export const MAX_READ_BYTES = 64 * 1024 * 1024

export interface SearchDisk {
  /** Folder names in `dir`; [] when it cannot be read. */
  listDirs(dir: string): Promise<string[]>
  /** mtimeMs and size of a file; null when it is missing. */
  stat(file: string): Promise<{ mtimeMs: number; size: number } | null>
  /** A file's text; null when missing or bigger than `max` bytes. */
  readText(file: string, max: number): Promise<string | null>
  /** Writes the index file whole (atomically). Throws on failure. */
  writeText(file: string, text: string): void
}

export interface SearchServiceDeps {
  disk: SearchDisk
  /** The project folders' roots, the current one first (it wins when an id is in two). */
  roots: () => readonly string[]
  /** userData/search/index.json */
  indexFile: string
  now?: () => number
  /** Gives the event loop a turn between slices. */
  yieldTurn?: () => Promise<void>
  log?: (line: string) => void
  onStatus?: (status: SearchStatus) => void
}

const stampOf = (s: { mtimeMs: number; size: number }): string => `${s.mtimeMs}:${s.size}`

export class SearchService {
  readonly index = new SearchIndex()
  private queue: Promise<void> = Promise.resolve()
  private started: Promise<void> | null = null
  private reconciling: Promise<void> | null = null
  private lastReconcile = -Infinity
  private status: SearchStatus = { state: 'idle', indexed: 0, total: 0 }
  private dirty = false
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly pendingSaves = new Map<string, { project: unknown; timer: ReturnType<typeof setTimeout> }>()
  /** Where each indexed project's file is (for the stamp after a save). */
  private readonly files = new Map<string, string>()
  private disposed = false

  constructor(private readonly deps: SearchServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private log(line: string): void {
    ;(this.deps.log ?? console.info)(line)
  }

  private setStatus(next: SearchStatus): void {
    const s = this.status
    if (s.state === next.state && s.indexed === next.indexed && s.total === next.total) return
    this.status = next
    this.deps.onStatus?.({ ...next })
  }

  getStatus(): SearchStatus {
    return { ...this.status }
  }

  /** Runs `fn` after every change queued before it: one change to the index at a time. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async yieldTurn(): Promise<void> {
    await (this.deps.yieldTurn?.() ?? new Promise<void>((resolve) => setImmediate(resolve)))
  }

  /** Loads the index file, then reconciles it with the folders. Once; later calls return the same promise. */
  start(): Promise<void> {
    this.started ??= (async () => {
      const began = this.now()
      this.setStatus({ state: 'building', indexed: 0, total: 0 })
      await this.run(() => this.load())
      await this.reconcile()
      this.setStatus({ state: 'ready', indexed: this.index.size, total: this.index.size })
      this.log(`Search index ready: ${this.index.size} recording(s) in ${Math.round(this.now() - began)} ms`)
    })()
    return this.started
  }

  private async load(): Promise<void> {
    let raw: unknown = null
    try {
      const text = await this.deps.disk.readText(this.deps.indexFile, MAX_READ_BYTES)
      raw = text === null ? null : JSON.parse(text)
    } catch (err) {
      this.log(`Search index unreadable, building it again (${err instanceof Error ? err.name : 'error'})`)
    }
    const stored = parseIndexFile(raw)
    if (raw !== null && stored.size === 0) this.dirty = true
    let slice = this.now()
    for (const [id, entry] of stored) {
      this.index.add(id, entry)
      if (this.now() - slice >= SEARCH_TIMING.sliceMs) {
        await this.yieldTurn()
        slice = this.now()
      }
    }
  }

  /** The project folders: id → project.json path, the first root winning. */
  private async folders(): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const root of this.deps.roots()) {
      for (const name of await this.deps.disk.listDirs(root)) {
        if (ID_RE.test(name) && !out.has(name)) out.set(name, path.join(root, name, 'project.json'))
      }
    }
    return out
  }

  /**
   * Indexes new and changed projects (by project.json's stamp) and drops those whose folder or
   * project.json is gone. A reconcile already running is joined.
   */
  reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling
    const run = this.run(async () => {
      const folders = await this.folders()
      let removed = 0
      for (const id of this.index.ids()) {
        if (!folders.has(id)) {
          this.index.remove(id)
          this.files.delete(id)
          removed++
        }
      }
      const building = this.status.state === 'building'
      let done = 0
      let read = 0
      let slice = this.now()
      for (const [id, file] of folders) {
        this.files.set(id, file)
        const st = await this.deps.disk.stat(file).catch(() => null)
        if (!st) {
          // An unfinished recording, or a folder that is not a project.
          if (this.index.has(id)) {
            this.index.remove(id)
            removed++
          }
        } else if (this.index.get(id)?.stamp !== stampOf(st) && !this.pendingSaves.has(id)) {
          read++
          const entry = await this.readEntry(file, st)
          if (entry) this.index.add(id, entry)
          else if (this.index.has(id)) this.index.remove(id)
        }
        done++
        if (building) this.setStatus({ state: 'building', indexed: done, total: folders.size })
        if (this.now() - slice >= SEARCH_TIMING.sliceMs) {
          await this.yieldTurn()
          slice = this.now()
        }
      }
      if (read || removed) {
        this.dirty = true
        this.scheduleWrite()
      }
      this.lastReconcile = this.now()
    })
    this.reconciling = run.finally(() => {
      this.reconciling = null
    })
    return this.reconciling
  }

  private async readEntry(file: string, st: { mtimeMs: number; size: number }): Promise<IndexedProject | null> {
    if (st.size > MAX_READ_BYTES) return null
    try {
      const text = await this.deps.disk.readText(file, MAX_READ_BYTES)
      return text === null ? null : indexedProject(JSON.parse(text), stampOf(st))
    } catch {
      return null
    }
  }

  /**
   * The editor saved `project` (already written): index it from the object in hand, debounced per
   * project, stamped with its file's stat taken then (so a later reconcile does not read it again).
   */
  noteSaved(project: unknown, file: string): void {
    if (this.disposed || !project || typeof project !== 'object') return
    const id = (project as { id?: unknown }).id
    if (typeof id !== 'string' || !ID_RE.test(id)) return
    const pending = this.pendingSaves.get(id)
    if (pending) clearTimeout(pending.timer)
    const timer = setTimeout(() => {
      const latest = this.pendingSaves.get(id)
      void this.run(async () => {
        // A newer save came in meanwhile: its own timer indexes it.
        if (!latest || this.pendingSaves.get(id) !== latest) return
        this.pendingSaves.delete(id)
        const st = await this.deps.disk.stat(file).catch(() => null)
        if (!st) return
        const entry = indexedProject(latest.project, stampOf(st))
        if (!entry) return
        this.index.add(id, entry)
        this.files.set(id, file)
        this.dirty = true
        this.scheduleWrite()
      })
    }, SEARCH_TIMING.saveDebounceMs)
    this.pendingSaves.set(id, { project, timer })
  }

  private scheduleWrite(): void {
    if (this.disposed || this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.writeNow()
    }, SEARCH_TIMING.writeDebounceMs)
  }

  /** Writes the index file when something changed; a failure is logged and tried again later. */
  writeNow(): void {
    if (!this.dirty) return
    const entries = new Map<string, IndexedProject>()
    for (const id of this.index.ids()) {
      const e = this.index.get(id)
      if (e) entries.set(id, e)
    }
    try {
      this.deps.disk.writeText(this.deps.indexFile, serializeIndex(entries))
      this.dirty = false
    } catch (err) {
      this.log(`Could not write the search index (${err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : 'error'}); trying again later`)
      this.scheduleWrite()
    }
  }

  /**
   * Answers a query. Starts the index if needed; reconciles first when the last one is older than
   * 2 s, waiting for it at most 300 ms (then the answer is from what is indexed so far).
   */
  async query(query: unknown): Promise<SearchResponse> {
    const q = typeof query === 'string' ? query.slice(0, SEARCH_LIMITS.queryChars).trim() : ''
    void this.start()
    if (this.status.state === 'ready' && this.now() - this.lastReconcile > SEARCH_TIMING.reconcileAfterMs) {
      let timer: ReturnType<typeof setTimeout> | null = null
      await Promise.race([
        this.reconcile(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SEARCH_TIMING.queryWaitMs)
        })
      ])
      if (timer) clearTimeout(timer)
    }
    const hits = q ? this.index.search(q) : []
    return { query: q, hits, status: this.getStatus(), withoutTranscript: this.index.withoutTranscript() }
  }

  /** Writes what is pending (quitting); no more timers after this. */
  dispose(): void {
    this.disposed = true
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = null
    for (const p of this.pendingSaves.values()) clearTimeout(p.timer)
    // Saves still waiting are indexed from the object in hand; their stamp is unknown, so the next start reads them again.
    for (const [id, p] of this.pendingSaves) {
      const entry = indexedProject(p.project, '')
      if (entry) {
        this.index.add(id, entry)
        this.dirty = true
      }
    }
    this.pendingSaves.clear()
    this.writeNow()
  }
}
