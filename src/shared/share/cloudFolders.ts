/**
 * Finding the cloud folders on this PC (F-22, docs/design/share.md §2.2): OneDrive, Dropbox and
 * Google Drive, from what their apps report (the registry, Dropbox's info.json, environment
 * variables) and then their usual places, each with where it came from. Pure: main reads the
 * registry and the files, checks every folder exists, and passes the text here.
 */

export type CloudService = 'onedrive' | 'dropbox' | 'gdrive' | 'folder'
/** Where a folder came from: its app's own settings, its usual place, or the user. */
export type FolderSource = 'app' | 'usual' | 'picked'

export const SERVICE_LABELS: Record<CloudService, string> = { onedrive: 'OneDrive', dropbox: 'Dropbox', gdrive: 'Google Drive', folder: 'Folder' }

/** Shown next to each folder, so nothing is used without the user seeing where it came from. */
export function sourceText(service: CloudService, source: FolderSource): string {
  if (source === 'picked') return 'Added by you'
  if (source === 'usual') return 'Found at the usual place'
  return `Found in ${SERVICE_LABELS[service]}'s settings`
}

/** The subfolder exports are copied into. */
export const SHARE_SUBFOLDER = 'Flown'

/** "OneDrive › Flown" */
export const placeText = (label: string): string => `${label} › ${SHARE_SUBFOLDER}`

export interface CloudCandidate {
  service: Exclude<CloudService, 'folder'>
  label: string
  path: string
  source: FolderSource
}

/** Registry keys read (with reg.exe query; the first with /s). */
export const REGISTRY_KEYS = {
  onedrive: 'HKCU\\Software\\Microsoft\\OneDrive\\Accounts',
  drivefs: 'HKCU\\Software\\Google\\DriveFS',
  drivefsMachine: 'HKLM\\Software\\Google\\DriveFS'
} as const

/** Values by key, keys and names in lower case: `reg query` output parsed. */
export type RegistryValues = Record<string, Record<string, string>>

const HIVES: Record<string, string> = { hkey_current_user: 'hkcu', hkey_local_machine: 'hklm' }
const shortKey = (key: string): string => {
  const parts = key.trim().split('\\')
  const hive = HIVES[parts[0].toLowerCase()] ?? parts[0].toLowerCase()
  return [hive, ...parts.slice(1)].join('\\').toLowerCase()
}

/**
 * `reg query <key> [/s]` output: key lines ("HKEY_CURRENT_USER\Software\…") followed by value
 * lines ("    UserFolder    REG_SZ    C:\Users\me\OneDrive"). Only string values are kept.
 */
export function parseRegQuery(stdout: string): RegistryValues {
  const out: RegistryValues = {}
  let key: string | null = null
  for (const line of stdout.split(/\r?\n/)) {
    if (/^HKEY_[A-Z_]+(\\|$)/.test(line)) {
      key = shortKey(line)
      out[key] ??= {}
      continue
    }
    const m = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line)
    if (!m || !key) continue
    if (m[2] !== 'REG_SZ' && m[2] !== 'REG_EXPAND_SZ') continue
    out[key][m[1].toLowerCase()] = (m[3] ?? '').trim()
  }
  return out
}

/** Merges several parsed outputs. */
export const mergeRegistry = (...parts: RegistryValues[]): RegistryValues => Object.assign({}, ...parts)

/** What detection reads. `join` builds paths (path.join of the platform). */
export interface CloudInput {
  env: Readonly<Record<string, string | undefined>>
  registry: RegistryValues
  /** Contents of Dropbox's info.json files, in the order read (Roaming, then Local). */
  dropboxInfo: readonly string[]
  /** Whether drive-letter places (G:\My Drive) apply (Windows). */
  driveLetters: boolean
  join: (...parts: string[]) => string
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const label = (s: string): string => s.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

/** Every mount_point_path in Google Drive's per-account preferences (JSON text). */
function driveMounts(json: string | undefined): string[] {
  if (!json) return []
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return []
  }
  const found: string[] = []
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || found.length >= 8) return
    if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1))
    else if (isObject(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'mount_point_path' && typeof x === 'string') found.push(x)
        else walk(x, depth + 1)
      }
    }
  }
  walk(data, 0)
  return found
}

/** A Google Drive mount ("G", "G:", "G:\\" or a folder) as a folder path. */
function mountRoot(mount: string, driveLetters: boolean): string | null {
  const m = /^([A-Za-z]):?\\?$/.exec(mount.trim())
  if (m) return driveLetters ? `${m[1].toUpperCase()}:\\` : null
  return str(mount)
}

/**
 * The cloud folders worth checking, the apps' own reports first, then the usual places; the same
 * folder (any case, either separator) only once, with its best source. Main keeps those that exist.
 */
export function cloudCandidates(input: CloudInput): CloudCandidate[] {
  const { env, registry, join } = input
  const list: CloudCandidate[] = []
  const add = (service: CloudCandidate['service'], name: string, p: string | null, source: FolderSource): void => {
    if (p) list.push({ service, label: label(name) || SERVICE_LABELS[service], path: p, source })
  }

  // OneDrive: its accounts in the registry, then the variables its app sets.
  const od = REGISTRY_KEYS.onedrive.toLowerCase()
  add('onedrive', 'OneDrive', str(registry[`${od}\\personal`]?.userfolder), 'app')
  for (let i = 1; i <= 9; i++) {
    const v = registry[`${od}\\business${i}`]
    const org = str(v?.displayname)
    add('onedrive', org ? `OneDrive – ${org}` : 'OneDrive (work or school)', str(v?.userfolder), 'app')
  }
  add('onedrive', 'OneDrive', str(env.OneDriveConsumer), 'app')
  add('onedrive', 'OneDrive (work or school)', str(env.OneDriveCommercial), 'app')
  add('onedrive', 'OneDrive', str(env.OneDrive), 'app')

  // Dropbox: info.json (personal and business), then the usual place.
  for (const text of input.dropboxInfo) {
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      continue
    }
    if (!isObject(data)) continue
    if (isObject(data.personal)) add('dropbox', 'Dropbox', str(data.personal.path), 'app')
    if (isObject(data.business)) add('dropbox', 'Dropbox (work)', str(data.business.path), 'app')
  }
  const home = str(env.USERPROFILE)
  if (home) add('dropbox', 'Dropbox', join(home, 'Dropbox'), 'usual')

  // Google Drive for desktop: its mounts, then its usual places.
  const gd = registry[REGISTRY_KEYS.drivefs.toLowerCase()]
  const gdm = registry[REGISTRY_KEYS.drivefsMachine.toLowerCase()]
  for (const mount of [...driveMounts(gd?.peraccountpreferences), ...(gdm?.defaultmountpoint ? [gdm.defaultmountpoint] : [])]) {
    const root = mountRoot(mount, input.driveLetters)
    if (root) add('gdrive', 'Google Drive', join(root, 'My Drive'), 'app')
  }
  if (input.driveLetters) add('gdrive', 'Google Drive', 'G:\\My Drive', 'usual')
  if (home) {
    add('gdrive', 'Google Drive', join(home, 'My Drive'), 'usual')
    add('gdrive', 'Google Drive', join(home, 'Google Drive'), 'usual')
  }

  const seen = new Set<string>()
  return list.filter((c) => {
    const key = normalizeFolderPath(c.path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** A path compared as Windows does: any case, either separator, no trailing separator. */
export function normalizeFolderPath(p: string): string {
  const s = p.replace(/[\\/]+/g, '\\').toLowerCase()
  return s.length > 3 ? s.replace(/\\+$/, '') : s
}

/** A folder's stable id: "cf" and 10 hex characters of a hash of its normalised path. */
export function folderId(p: string): string {
  const s = normalizeFolderPath(p)
  // Two FNV-1a 32-bit hashes with different seeds.
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x01000193) >>> 0
  }
  return `cf${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0').slice(0, 2)}`
}

/** How to get a share link for a copy, per service (none of the apps makes one locally). */
export function linkHint(service: CloudService): string {
  if (service === 'onedrive') return 'To share a link, right-click the file and choose Share.'
  if (service === 'dropbox') return 'To share a link, right-click the file and choose Copy Dropbox link.'
  if (service === 'gdrive') return 'To share a link, right-click the file and choose Share › Copy link.'
  return 'People with access to this folder can open it there.'
}
