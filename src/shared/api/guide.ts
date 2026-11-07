/**
 * Saving and copying a step-by-step guide or a click-through demo (docs/design/smart-tools.md §5.7,
 * §5.8). The renderer sends the format, a name and the bytes; main shows the dialog, builds every
 * path and writes: it never takes a path from the renderer. The channels are fixed here; part P1's
 * guideIpc.ts registers their handlers, each checking its sender.
 */

export type GuideFormat = 'pdf' | 'html' | 'demo' | 'markdown'

export interface GuideSavePayload {
  format: GuideFormat
  /** The file or folder name offered ("<Title> guide"): the export's file-name check, else "Guide". */
  name: string
  /** PDF (printed by main), HTML and demo. */
  html?: string
  /** Markdown: guide.md. */
  markdown?: string
  /** Markdown: images/step-01.png … in the order sent (PNG, JPEG or WebP by their first bytes). */
  images?: Uint8Array[]
  page?: 'A4' | 'Letter'
}

export interface GuideApi {
  /** Null when the dialog was cancelled. */
  saveGuide(payload: GuideSavePayload): Promise<{ path: string; bytes: number } | null>
  /** Shows a file this session's guide:save wrote in its folder. */
  showGuideFile(path: string): Promise<void>
  /** Puts the guide on the clipboard: HTML with its screenshots, and plain text. */
  copyGuide(clip: { html: string; text: string }): Promise<void>
  /** Puts one screenshot (PNG) on the clipboard. */
  copyGuideImage(png: Uint8Array): Promise<void>
}

/** What one save or copy may hold (§5.8), checked in the preload before sending and again in main. */
export const GUIDE_SAVE_LIMITS = { html: 64 << 20, markdown: 2 << 20, images: 300, image: 16 << 20, total: 256 << 20, name: 120, clipText: 2 << 20 } as const

/** The channels (§5.8). */
export const GUIDE_CHANNELS = {
  /** invoke (GuideSavePayload) → { path, bytes } | null */
  save: 'guide:save',
  /** invoke (path) → void */
  showItem: 'guide:showItem',
  /** invoke ({ html, text }) → void */
  copy: 'guide:copy',
  /** invoke (png) → void */
  copyImage: 'guide:copyImage'
} as const

/** A file's type by its first bytes: PNG, JPEG or WebP, else null. */
export function imageKind(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | null {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  return null
}

/**
 * Why `payload` cannot be sent, or null when it fits GUIDE_SAVE_LIMITS (§5.8): a known format, a
 * string name of at most 120 characters, HTML of at most 64 MB, Markdown of at most 2 MB, at most 300
 * images of at most 16 MB, each a PNG, JPEG or WebP, and at most 256 MB in all. The preload checks
 * it before sending; main checks again (part P1's checkGuidePayload).
 */
export function guidePayloadProblem(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return 'Nothing to save.'
  const p = payload as Partial<GuideSavePayload>
  if (p.format !== 'pdf' && p.format !== 'html' && p.format !== 'demo' && p.format !== 'markdown') return 'Unknown guide format.'
  if (typeof p.name !== 'string' || p.name.length > GUIDE_SAVE_LIMITS.name) return 'The guide’s name is too long.'
  let total = 0
  if (p.html !== undefined) {
    if (typeof p.html !== 'string' || p.html.length > GUIDE_SAVE_LIMITS.html) return 'This guide is too large to save.'
    total += p.html.length
  }
  if (p.markdown !== undefined) {
    if (typeof p.markdown !== 'string' || p.markdown.length > GUIDE_SAVE_LIMITS.markdown) return 'This guide is too large to save.'
    total += p.markdown.length
  }
  if (p.images !== undefined) {
    if (!Array.isArray(p.images) || p.images.length > GUIDE_SAVE_LIMITS.images) return 'This guide has too many screenshots to save.'
    for (const img of p.images) {
      if (!(img instanceof Uint8Array) || img.byteLength > GUIDE_SAVE_LIMITS.image || !imageKind(img)) return 'A screenshot of this guide cannot be saved.'
      total += img.byteLength
    }
  }
  if (p.page !== undefined && p.page !== 'A4' && p.page !== 'Letter') return 'Unknown page size.'
  if (total > GUIDE_SAVE_LIMITS.total) return 'This guide is too large to save.'
  return null
}

/** Why a copy cannot be sent, or null (§5.8): HTML of at most 64 MB, text of at most 2 MB. */
export function guideCopyProblem(clip: unknown): string | null {
  if (!clip || typeof clip !== 'object') return 'Nothing to copy.'
  const c = clip as { html?: unknown; text?: unknown }
  if (typeof c.html !== 'string' || c.html.length > GUIDE_SAVE_LIMITS.html) return 'This guide is too large to copy.'
  if (typeof c.text !== 'string' || c.text.length > GUIDE_SAVE_LIMITS.clipText) return 'This guide is too large to copy.'
  return null
}
