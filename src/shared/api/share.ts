import type { CloudService, FolderSource } from '../share/cloudFolders'
import type { WebhookService } from '../share/webhooks'

/** A cloud folder or a folder the user added (F-22, docs/design/share.md). */
export interface ShareFolderInfo {
  id: string
  service: CloudService
  /** "OneDrive", "OneDrive – Contoso", "Team share". */
  label: string
  /** The folder itself (the user's own; exports go into its Flown folder). */
  path: string
  source: FolderSource
  /** Offered after export (a found folder can be turned off). */
  on: boolean
}

/** A chat webhook, as the page may see it: never its URL. */
export interface ShareHookInfo {
  id: string
  service: WebhookService
  label: string
  /** "hooks.slack.com/…/AbCd" */
  masked: string
  /** False when its URL can no longer be decrypted on this PC. */
  readable: boolean
}

export interface ShareTargets {
  folders: ShareFolderInfo[]
  hooks: ShareHookInfo[]
}

/** What a chat message says about the video. */
export interface ShareMeta {
  title: string
  /** Length of the exported video. */
  seconds: number
}

export type ShareStepState = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled'

export interface ShareStepView {
  target: string
  kind: 'copy' | 'post'
  service: CloudService | WebhookService
  /** The folder's or chat's name. */
  label: string
  state: ShareStepState
  /** Copy progress 0..1. */
  fraction?: number
  /** A copy's file (for Show in folder). */
  dest?: string
  /** A copy's share link, when the cloud app gave one. */
  link?: string
  /** "Already in OneDrive › Flown", or the reason a step failed. */
  message?: string
}

export interface ShareRunView {
  id: string
  /** The exported file. */
  file: string
  steps: ShareStepView[]
  finished: boolean
}

export interface ShareApi {
  /** The folders found on this PC and added, and the chats. `refresh` looks for folders again. */
  shareTargets(refresh?: boolean): Promise<ShareTargets>
  /** Turns a found folder on or off, or removes one the user added (`on` = null). */
  shareSetFolder(id: string, on: boolean | null): Promise<ShareTargets>
  /** Asks for a folder with the system dialog and adds it; null when cancelled. */
  sharePickFolder(): Promise<ShareTargets | null>
  /** Adds a chat from its name and pasted webhook URL; throws a message to show. */
  shareAddHook(label: string, url: string): Promise<ShareTargets>
  shareRemoveHook(id: string): Promise<ShareTargets>
  /** Posts a test message; never throws. */
  shareTestHook(id: string): Promise<{ ok: boolean; message: string }>
  /**
   * Registers a file exported in this session with what a message says about it, so the "Export
   * finished" notification can offer the destinations (none when `auto`: the page shares it itself).
   */
  shareOffer(file: string, meta: ShareMeta, auto: boolean): Promise<void>
  /** Copies and posts `file` to `targets` (folders first); resolves with the run started. */
  shareStart(file: string, targets: string[], meta: ShareMeta): Promise<ShareRunView>
  shareCancel(runId: string): Promise<void>
  /** The runs of this session for `file` (the latest last). */
  shareRuns(file: string): Promise<ShareRunView[]>
  /** Run updates. */
  onShareUpdate(listener: (run: ShareRunView) => void): () => void
}
