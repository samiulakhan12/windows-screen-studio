import type { PickedAsset } from '../../../shared/api/projects'
import { displayTime } from '../../../shared/editor/clips'
import { createOverlay, type OverlaySource } from '../../../shared/editor/overlays'
import { MAX_OVERLAYS, OVERLAY_MAX_BYTES } from '../../../shared/engine/overlayData'
import type { ImageOverlay } from '../../../shared/types'
import { preloadOverlay } from '../render/overlayLayer'
import type { EditorServices } from './context'
import type { Selection } from './selection'

/*
 * Adding image overlays: the one code path for the Images panel (Add image…, stickers), the
 * images track of the timeline, and files dropped on or pasted into the editor
 * (docs/design/brand-kit.md §1). Each adds one overlay at the playhead as one undo step, after
 * its picture decoded, so the project never points at an image that cannot be shown.
 */

export interface AddOverlayOptions {
  /** Source time to add at (where the timeline was double-clicked); the playhead by default. */
  at?: number
  onSelect: (sel: Selection) => void
}

/** "Error invoking remote method 'x': Error: message" -> "message". */
export const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** The image extensions that can be added, for dropped files. */
export const OVERLAY_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif']
export const OVERLAY_FORMATS_TEXT = 'PNG, JPG, WebP, SVG or GIF, up to 25 MB'

function checkRoom({ store }: EditorServices): void {
  if ((store.state.overlays?.length ?? 0) >= MAX_OVERLAYS) throw new Error(`This video already has ${MAX_OVERLAYS} images.`)
}

/** Adds `source` at the playhead (or `opts.at`), selects it and moves the playhead into it when it is not shown. */
async function add(services: EditorServices, source: OverlaySource, url: string | undefined, opts: AddOverlayOptions): Promise<ImageOverlay> {
  checkRoom(services)
  const { store, player } = services
  const p = store.state
  const aspect = await preloadOverlay(p.id, source, url)
  const t = displayTime(p.clips, opts.at ?? player.time)
  const o = createOverlay(t, p.duration, source, aspect)
  store.update((q) => ({ ...q, overlays: [...(q.overlays ?? []), o] }))
  opts.onSelect({ kind: 'overlay', id: o.id })
  if (player.time < o.start || player.time >= o.end) player.seek(o.start)
  return o
}

/** Adds an image file already copied into the project. Rejects with a readable message when it cannot be shown. */
export const addPickedOverlay = (services: EditorServices, picked: PickedAsset, opts: AddOverlayOptions): Promise<ImageOverlay> =>
  add(services, { file: picked.path, name: picked.name }, picked.url, opts)

/** Adds a built-in sticker. */
export const addSticker = (services: EditorServices, sticker: string, opts: AddOverlayOptions): Promise<ImageOverlay> => add(services, { sticker }, undefined, opts)

/** "Add image…": the open dialog, then the image. Null when cancelled. */
export async function pickOverlay(services: EditorServices, opts: AddOverlayOptions): Promise<ImageOverlay | null> {
  checkRoom(services)
  const picked = await window.api.pickAsset(services.store.state.id, 'overlay').catch((err: unknown) => {
    throw new Error(ipcMessage(err))
  })
  return picked ? addPickedOverlay(services, picked, opts) : null
}

/** Whether a dropped or pasted file looks like an image that can be added (by its name or type). */
export function isOverlayFile(file: Pick<File, 'name' | 'type'>): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return OVERLAY_EXTENSIONS.includes(ext) || /^image\/(png|jpeg|webp|svg\+xml|gif)$/.test(file.type)
}

const EXT_OF_TYPE: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif' }

/**
 * Adds a file dropped on or pasted into the editor: its bytes go to main (never a path), which
 * checks and stores them. A pasted image without a usable name ("image.png" from a screenshot
 * tool) is named after its type.
 */
export async function addOverlayFile(services: EditorServices, file: File, opts: AddOverlayOptions): Promise<ImageOverlay> {
  checkRoom(services)
  if (file.size > OVERLAY_MAX_BYTES) throw new Error(`The file is too large (${Math.round(file.size / 1e6)} MB; ${Math.round(OVERLAY_MAX_BYTES / 1e6)} MB at most).`)
  const hasExt = OVERLAY_EXTENSIONS.includes(file.name.split('.').pop()?.toLowerCase() ?? '')
  const name = hasExt ? file.name : `${file.name.replace(/\.[^.]*$/, '') || 'Pasted image'}.${EXT_OF_TYPE[file.type] ?? 'png'}`
  const bytes = new Uint8Array(await file.arrayBuffer())
  const picked = await window.api.importAssetData(services.store.state.id, 'overlay', name, bytes).catch((err: unknown) => {
    throw new Error(ipcMessage(err))
  })
  return addPickedOverlay(services, picked, opts)
}
