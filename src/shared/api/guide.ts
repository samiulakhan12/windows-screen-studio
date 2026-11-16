/**
 * Saving and copying a step-by-step guide or a click-through demo (docs/design/smart-tools.md §5.7,
 * §5.8). The renderer sends the format, a name and the bytes; main shows the dialog, builds every
 * path and writes: it never takes a path from the renderer. The channels are fixed here; part P1's
 * guideIpc.ts registers their handlers, each checking its sender.
 */
import type { MessageKey } from '../i18n/keys'

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

/** Why a save or a copy cannot be sent (§5.8), as an id: its words are GUIDE_PROBLEM_KEYS' messages. */
export type GuideProblem = 'nothing-to-save' | 'unknown-format' | 'name-too-long' | 'too-large' | 'too-many-shots' | 'bad-shot' | 'unknown-page' | 'nothing-to-copy' | 'too-large-to-copy'

/**
 * The errors message that says each problem (docs/design/output-and-languages.md §9.6). Plain keys:
 * the preload imports this file and carries no messages (test 86), so main and the renderer say
 * them, each in its own process.
 */
export const GUIDE_PROBLEM_KEYS: Readonly<Record<GuideProblem, MessageKey>> = {
  'nothing-to-save': 'errors.writeGuide.nothingToSave',
  'unknown-format': 'errors.guide.unknownFormat',
  'name-too-long': 'errors.guide.nameTooLong',
  'too-large': 'errors.guide.tooLargeToSave',
  'too-many-shots': 'errors.guide.tooManyShots',
  'bad-shot': 'errors.writeGuide.aScreenshotOfThis',
  'unknown-page': 'errors.guide.unknownPage',
  'nothing-to-copy': 'errors.guide.nothingToCopy',
  'too-large-to-copy': 'errors.guide.tooLargeToCopy'
}

/**
 * Why `payload` cannot be sent, or null when it fits GUIDE_SAVE_LIMITS (§5.8): a known format, a
 * string name of at most 120 characters, HTML of at most 64 MB, Markdown of at most 2 MB, at most 300
 * images of at most 16 MB, each a PNG, JPEG or WebP, and at most 256 MB in all. The renderer checks
 * it and says why before sending, the preload checks it again and refuses with the id, and main
 * checks a third time (part P1's checkGuidePayload).
 */
export function guidePayloadProblem(payload: unknown): GuideProblem | null {
  if (!payload || typeof payload !== 'object') return 'nothing-to-save'
  const p = payload as Partial<GuideSavePayload>
  if (p.format !== 'pdf' && p.format !== 'html' && p.format !== 'demo' && p.format !== 'markdown') return 'unknown-format'
  if (typeof p.name !== 'string' || p.name.length > GUIDE_SAVE_LIMITS.name) return 'name-too-long'
  let total = 0
  if (p.html !== undefined) {
    if (typeof p.html !== 'string' || p.html.length > GUIDE_SAVE_LIMITS.html) return 'too-large'
    total += p.html.length
  }
  if (p.markdown !== undefined) {
    if (typeof p.markdown !== 'string' || p.markdown.length > GUIDE_SAVE_LIMITS.markdown) return 'too-large'
    total += p.markdown.length
  }
  if (p.images !== undefined) {
    if (!Array.isArray(p.images) || p.images.length > GUIDE_SAVE_LIMITS.images) return 'too-many-shots'
    for (const img of p.images) {
      if (!(img instanceof Uint8Array) || img.byteLength > GUIDE_SAVE_LIMITS.image || !imageKind(img)) return 'bad-shot'
      total += img.byteLength
    }
  }
  if (p.page !== undefined && p.page !== 'A4' && p.page !== 'Letter') return 'unknown-page'
  if (total > GUIDE_SAVE_LIMITS.total) return 'too-large'
  return null
}

/** Why a copy cannot be sent, or null (§5.8): HTML of at most 64 MB, text of at most 2 MB. */
export function guideCopyProblem(clip: unknown): GuideProblem | null {
  if (!clip || typeof clip !== 'object') return 'nothing-to-copy'
  const c = clip as { html?: unknown; text?: unknown }
  if (typeof c.html !== 'string' || c.html.length > GUIDE_SAVE_LIMITS.html) return 'too-large-to-copy'
  if (typeof c.text !== 'string' || c.text.length > GUIDE_SAVE_LIMITS.clipText) return 'too-large-to-copy'
  return null
}
