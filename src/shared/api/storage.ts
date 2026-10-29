import type { CleanupAction, CleanupItem, RecordingUsage, StorageRules } from '../storage/rules'

/** The projects folder's use of the disk (F-26). */
export interface StorageOverview {
  /** The projects folder. */
  root: string
  /** Free and total bytes of its drive; null when unknown. */
  free: number | null
  total: number | null
  /** Every recording's bytes together (a file recordings share counted once). */
  bytes: number
  /** Largest first. */
  recordings: RecordingUsage[]
  rules: StorageRules
  /** Main's clock when scanned (epoch ms), for "used 12 days ago". */
  now: number
}

export interface StorageCleanupResult {
  moved: CleanupItem[]
  failed: { item: CleanupItem; reason: string }[]
  freed: number
}

export interface StorageApi {
  storageScan(): Promise<StorageOverview>
  storageSetRules(rules: StorageRules): Promise<StorageRules>
  /** What the rules would move to the Recycle Bin now. */
  storagePlan(): Promise<CleanupItem[]>
  /** Moves the ticked items to the Recycle Bin (main checks them against the rules again). */
  storageClean(items: { id: string; action: CleanupAction }[]): Promise<StorageCleanupResult>
  /** The editor opened / closed recording `id` (it counts as used, and is never cleaned while open). */
  storageNoteOpened(id: string): void
  storageNoteClosed(id: string): void
}
