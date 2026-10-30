/**
 * The storage manager's scan and clean-up (F-26, docs/design/hands-off.md §2.7). Only the current
 * projects folder is listed (legacy roots are only read for the names of shared files); links and
 * junctions are never followed; whatever a clean-up removes goes
 * to the Recycle Bin (shell.trashItem), never deleted for good, and only after main has scanned
 * again and found it still matches the rules.
 */
import { promises as fs, type Dirent, type Stats } from 'node:fs'
import path from 'node:path'
import { VERSIONS_DIR } from './versions'
import { cleanupPlan, freedBytes, lastUsed, type CleanupAction, type CleanupItem, type RecordingUsage, type SharedFile, type StorageRules } from '../shared/storage/rules'

/** How far one recording's folder is walked. */
export const SCAN = { maxDepth: 8, maxEntries: 20_000 } as const

const ID_RE = /^[a-zA-Z0-9_-]+$/
export const CACHE_DIR = '.cache'

export interface FsDeps {
  lstat(p: string): Promise<Stats>
  readdir(p: string): Promise<Dirent[]>
  readFile(p: string): Promise<string>
  realpath(p: string): Promise<string>
  /** A file's identity on its drive ("<dev>:<ino>"), asked for files with more than one name. */
  fileId?(p: string): Promise<string>
}

export const nodeFs: FsDeps = {
  lstat: (p) => fs.lstat(p),
  readdir: (p) => fs.readdir(p, { withFileTypes: true }),
  readFile: (p) => fs.readFile(p, 'utf8'),
  realpath: (p) => fs.realpath(p),
  // As bigints: NTFS file ids do not fit a double.
  fileId: async (p) => {
    const st = await fs.lstat(p, { bigint: true })
    return `${st.dev}:${st.ino}`
  }
}

/**
 * Bytes under `dir` (itself not followed when it is a link), at most SCAN deep and wide. A file with
 * several names (Duplicate hard-links media into a copy) counts once, and is listed in `shared` when
 * a name of it is outside `dir`.
 */
export async function folderSize(
  dir: string,
  deps: FsDeps = nodeFs,
  limits: { maxDepth: number; maxEntries: number } = SCAN
): Promise<{ bytes: number; capped: boolean; shared: SharedFile[] }> {
  let bytes = 0
  let entries = 0
  let capped = false
  const linked = new Map<string, SharedFile>()
  const result = (): { bytes: number; capped: boolean; shared: SharedFile[] } => ({ bytes, capped, shared: [...linked.values()].filter((f) => f.here < f.links) })
  const stack: { dir: string; depth: number }[] = [{ dir, depth: 0 }]
  while (stack.length) {
    const { dir: d, depth } = stack.pop()!
    let list: Dirent[]
    try {
      list = await deps.readdir(d)
    } catch {
      continue
    }
    for (const e of list) {
      if (++entries > limits.maxEntries) {
        capped = true
        return result()
      }
      const p = path.join(d, e.name)
      let st: Stats
      try {
        st = await deps.lstat(p)
      } catch {
        continue
      }
      // A link counts as itself; what it points to may be anywhere.
      if (st.isSymbolicLink()) bytes += st.size
      else if (st.isDirectory()) {
        if (depth + 1 >= limits.maxDepth) capped = true
        else stack.push({ dir: p, depth: depth + 1 })
      } else if (st.nlink > 1 && deps.fileId) {
        const id = await deps.fileId(p).catch(() => null)
        const known = id === null ? undefined : linked.get(id)
        if (known) known.here++
        else {
          bytes += st.size
          if (id !== null) linked.set(id, { id, bytes: st.size, links: st.nlink, here: 1 })
        }
      } else bytes += st.size
    }
  }
  return result()
}

/**
 * Every recording folder directly in `root`: name, dates, sizes, and whether it is finished.
 * `used` holds the times the editor opened a recording (storage.json). `holders` are the other
 * folders of recordings the library lists (legacy roots): never listed or cleaned, only read for
 * the names they give a shared file.
 */
export async function scanProjects(
  root: string,
  used: Readonly<Record<string, string>>,
  deps: FsDeps = nodeFs,
  holders: readonly string[] = []
): Promise<RecordingUsage[]> {
  let list: Dirent[]
  try {
    list = await deps.readdir(root)
  } catch {
    return []
  }
  const out: RecordingUsage[] = []
  for (const e of list) {
    if (!e.isDirectory() || !ID_RE.test(e.name)) continue
    const dir = path.join(root, e.name)
    let st: Stats
    try {
      st = await deps.lstat(dir)
    } catch {
      continue
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue
    let name = e.name
    let createdAt = new Date(st.mtimeMs).toISOString()
    let projectTime: number | null = null
    let finished = false
    try {
      const pst = await deps.lstat(path.join(dir, 'project.json'))
      const raw = JSON.parse(await deps.readFile(path.join(dir, 'project.json'))) as { name?: unknown; createdAt?: unknown }
      if (typeof raw.name === 'string' && raw.name.trim()) name = raw.name.trim().slice(0, 200)
      if (typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt))) createdAt = raw.createdAt
      projectTime = pst.mtimeMs
      finished = true
    } catch {
      // No project yet: an unfinished recording.
    }
    // A manifest means a recording is being made, processed or waits for recovery.
    if (finished) finished = !(await deps.lstat(path.join(dir, 'recording.json')).then(() => true, () => false))
    const size = await folderSize(dir, deps)
    const cacheStat = await deps.lstat(path.join(dir, CACHE_DIR)).catch(() => null)
    const cache = cacheStat?.isDirectory() && !cacheStat.isSymbolicLink() ? await folderSize(path.join(dir, CACHE_DIR), deps) : { bytes: 0, capped: false }
    // Kept versions of the edit (docs/design/versions.md §2.6): counted apart, never cleaned as a cache.
    const versionsStat = await deps.lstat(path.join(dir, VERSIONS_DIR)).catch(() => null)
    const versions = versionsStat?.isDirectory() && !versionsStat.isSymbolicLink() ? (await folderSize(path.join(dir, VERSIONS_DIR), deps)).bytes : 0
    out.push({
      id: e.name,
      name,
      createdAt,
      lastUsed: lastUsed([projectTime, used[e.name]]),
      bytes: size.bytes,
      cacheBytes: cache.bytes,
      finished,
      capped: size.capped,
      ...(size.shared.length ? { shared: size.shared } : {}),
      ...(versions > 0 ? { versionBytes: versions } : {})
    })
  }
  // Only names in recordings hold a file: one in the Recycle Bin (a removed original) or anywhere
  // else outside the library keeps no recording's bytes.
  const held = new Map<string, number>()
  for (const r of out) for (const f of r.shared ?? []) held.set(f.id, (held.get(f.id) ?? 0) + f.here)
  // A recording in a legacy root (a copy's original Duplicate linked from there) still holds its names.
  if (out.some((r) => r.shared?.some((f) => (held.get(f.id) ?? 0) < f.links))) {
    for (const extra of holders) {
      for (const e of await deps.readdir(extra).catch(() => [] as Dirent[])) {
        const dir = path.join(extra, e.name)
        if (!e.isDirectory() || !ID_RE.test(e.name) || !(await deps.lstat(dir).then((st) => st.isDirectory() && !st.isSymbolicLink(), () => false))) continue
        for (const f of (await folderSize(dir, deps)).shared) if (held.has(f.id)) held.set(f.id, held.get(f.id)! + f.here)
      }
    }
  }
  for (const r of out) {
    const shared = r.shared?.map((f) => ({ ...f, links: held.get(f.id) ?? f.here })).filter((f) => f.here < f.links)
    if (shared?.length) r.shared = shared
    else delete r.shared
  }
  return out.sort((a, b) => b.bytes - a.bytes)
}

/**
 * The folder `action` removes for recording `id`, after checking it is a real folder directly in
 * the real projects folder with no link on the way. Throws otherwise.
 */
export async function cleanupTarget(root: string, id: string, action: CleanupAction, deps: FsDeps = nodeFs): Promise<string> {
  if (!ID_RE.test(id)) throw new Error('Invalid recording')
  const realRoot = await deps.realpath(root)
  const dir = path.join(root, id)
  const target = action === 'caches' ? path.join(dir, CACHE_DIR) : dir
  for (const p of action === 'caches' ? [dir, target] : [dir]) {
    const st = await deps.lstat(p)
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Not a folder of the projects folder')
  }
  const real = await deps.realpath(target)
  const want = action === 'caches' ? path.join(realRoot, id, CACHE_DIR) : path.join(realRoot, id)
  const same = process.platform === 'win32' ? real.toLowerCase() === want.toLowerCase() : real === want
  if (!same) throw new Error('Not a folder of the projects folder')
  return target
}

export interface CleanupResult {
  moved: CleanupItem[]
  failed: { item: CleanupItem; reason: string }[]
  freed: number
}

export interface CleanupDeps {
  fs?: FsDeps
  /** shell.trashItem: the only way anything is removed. */
  trash: (file: string) => Promise<void>
  /** Called before a whole recording goes (stops analyses holding its files open). */
  beforeRemove?: (id: string) => Promise<void>
  /** Asked again right before each move: a recording opened during the clean-up is skipped. */
  isOpen?: (id: string) => boolean
  /** Legacy roots, read for the names they hold (scanProjects). */
  holders?: readonly string[]
}

/**
 * Moves the requested items to the Recycle Bin: the folder is scanned again and only requests that
 * are still in the rules' plan are acted on; a failure is reported and nothing else is tried.
 */
export async function runCleanup(
  root: string,
  requests: readonly { id: string; action: CleanupAction }[],
  rules: StorageRules,
  used: Readonly<Record<string, string>>,
  open: ReadonlySet<string>,
  now: number,
  deps: CleanupDeps
): Promise<CleanupResult> {
  const fsd = deps.fs ?? nodeFs
  const plan = cleanupPlan(await scanProjects(root, used, fsd, deps.holders), rules, now, open)
  const result: CleanupResult = { moved: [], failed: [], freed: 0 }
  const seen = new Set<string>()
  for (const req of requests) {
    const key = `${req?.action}:${req?.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const item = plan.find((p) => p.id === req.id && p.action === req.action)
    if (!item) continue
    try {
      const target = await cleanupTarget(root, item.id, item.action, fsd)
      if (deps.isOpen?.(item.id)) throw new Error('It is open in the editor')
      if (item.action === 'remove') await deps.beforeRemove?.(item.id)
      if (deps.isOpen?.(item.id)) throw new Error('It is open in the editor')
      await deps.trash(target)
      result.moved.push(item)
      // A file shared with a recording that stays is not freed.
      result.freed = freedBytes(result.moved)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      result.failed.push({ item, reason })
      console.warn(`Could not move ${item.action === 'caches' ? 'the caches of' : ''} ${item.id} to the Recycle Bin: ${reason}`)
    }
  }
  return result
}

/** Free and total bytes of the drive holding `dir`, or null when unknown. */
export async function diskSpace(dir: string): Promise<{ free: number; total: number } | null> {
  try {
    const s = await fs.statfs(dir)
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
  } catch {
    return null
  }
}
