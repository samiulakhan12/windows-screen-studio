/**
 * Speaker notes (teleprompter, docs/design/teleprompter.md): the one script the presenter reads
 * while recording, how its floating window looks and scrolls, and where it sits. Stored in
 * userData/notes.json by the main process (src/main/notes/notesStore.ts); a copy of the text goes
 * into each recording made with it (`script.txt`, then `Project.script`).
 *
 * Pure validation shared by the main process, the renderer and tests, so a hand-edited or older
 * file can never produce an invalid value. FROZEN after the contracts commit.
 */
import { DEFAULT_NOTES_HOTKEYS, sanitizeNotesHotkeys, type NotesHotkeys } from '../recording/hotkeys'
import type { ProjectScript } from '../types'

/** The script's length in UTF-16 code units (about 8,000 words, an hour at 130 words a minute). */
export const NOTES_TEXT_MAX = 50_000
/** Reading speed, in spoken words per minute. */
export const NOTES_WPM = { min: 60, max: 220, step: 10, default: 130 } as const
/** Text size in CSS px (= DIP, so it scales with each monitor). */
export const NOTES_FONT = { min: 20, max: 72, step: 2, default: 32 } as const
/** Window size in DIP; always clamped to fit one display's work area too. */
export const NOTES_WIDTH = { min: 320, max: 1200, default: 560 } as const
export const NOTES_HEIGHT = { min: 140, max: 720, default: 240 } as const
/** The reading line: this fraction of the text area's height from its top. */
export const READING_LINE = 0.3
/** The default window's gap below the top of the work area (DIP): just under a typical webcam. */
export const NOTES_TOP_MARGIN = 8
/** Height of the window's control strip (DIP), at the bottom so the text stays nearest the lens. */
export const NOTES_STRIP_HEIGHT = 32

/**
 * Where the window was left: its display and its top-left corner as a share (0..1) of the room
 * the window has to move in on that display's work area (0 = left/top edge, 1 = right/bottom
 * edge), so it stays in the same place when the resolution or the window size changes.
 */
export interface NotesPlacement {
  displayId: string
  x: number
  y: number
}

export interface NotesSettings {
  /** The script or bullet points: plain text, LF line ends, at most NOTES_TEXT_MAX. */
  text: string
  /** Show the notes while recording (when there is text). */
  showWhileRecording: boolean
  /** Start scrolling when the recording starts (off: step through bullet notes with Forward). */
  autoStart: boolean
  /** Copy the text into each recording made with the notes (Project.script). */
  keepWithRecording: boolean
  /** Words per minute, NOTES_WPM. */
  wpm: number
  /** CSS px, NOTES_FONT. */
  fontSize: number
  /** Window size in DIP. */
  width: number
  height: number
  /** null: top centre of the primary display's work area. */
  placement: NotesPlacement | null
  hotkeys: NotesHotkeys
}

/** A change to the notes settings; hotkeys may be given one at a time, placement null resets it. */
export type NotesSettingsPatch = Partial<Omit<NotesSettings, 'hotkeys'>> & { hotkeys?: Partial<NotesHotkeys> }

/** What the notes window itself may change (its buttons, Ctrl + wheel and resize grip). */
export type NotesLookPatch = Partial<Pick<NotesSettings, 'wpm' | 'fontSize' | 'width' | 'height'>>

export const DEFAULT_NOTES: NotesSettings = {
  text: '',
  showWhileRecording: true,
  autoStart: true,
  keepWithRecording: true,
  wpm: NOTES_WPM.default,
  fontSize: NOTES_FONT.default,
  width: NOTES_WIDTH.default,
  height: NOTES_HEIGHT.default,
  placement: null,
  hotkeys: { ...DEFAULT_NOTES_HOTKEYS }
}

export function defaultNotes(): NotesSettings {
  return { ...DEFAULT_NOTES, hotkeys: { ...DEFAULT_NOTES_HOTKEYS } }
}

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

/** `v` clamped to [min, max] and rounded to a multiple of `step` from `min`; `fallback` when not a number. */
function stepped(v: unknown, range: { min: number; max: number; step?: number }, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  const step = range.step ?? 1
  const n = range.min + Math.round((v - range.min) / step) * step
  return Math.min(range.max, Math.max(range.min, n))
}

/**
 * The script as stored: CR LF and CR become LF, control characters other than tab and line feed
 * are removed, and it is cut to NOTES_TEXT_MAX without splitting a surrogate pair.
 */
export function cleanNotesText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  let text = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  if (text.length > NOTES_TEXT_MAX) {
    text = text.slice(0, NOTES_TEXT_MAX)
    const last = text.charCodeAt(text.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
  }
  return text
}

/** Whether the script has anything to show (the notes are used for a recording only then). */
export const hasNotesText = (text: string): boolean => text.trim().length > 0

/** A saved placement, or null (the default place) when malformed. */
export function sanitizePlacement(raw: unknown): NotesPlacement | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Partial<Record<keyof NotesPlacement, unknown>>
  if (typeof p.displayId !== 'string' || !p.displayId || p.displayId.length > 64) return null
  const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
  if (!unit(p.x) || !unit(p.y)) return null
  return { displayId: p.displayId, x: p.x, y: p.y }
}

/**
 * Valid notes settings from anything (a missing or hand-edited file: defaults field by field).
 * `taken`: the recording hotkeys, which a notes hotkey may never equal.
 */
export function sanitizeNotesSettings(raw: unknown, taken: readonly string[] = []): NotesSettings {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Partial<Record<keyof NotesSettings, unknown>>
  const d = DEFAULT_NOTES
  return {
    text: cleanNotesText(r.text),
    showWhileRecording: bool(r.showWhileRecording, d.showWhileRecording),
    autoStart: bool(r.autoStart, d.autoStart),
    keepWithRecording: bool(r.keepWithRecording, d.keepWithRecording),
    wpm: stepped(r.wpm, NOTES_WPM, d.wpm),
    fontSize: stepped(r.fontSize, NOTES_FONT, d.fontSize),
    width: stepped(r.width, NOTES_WIDTH, d.width),
    height: stepped(r.height, NOTES_HEIGHT, d.height),
    placement: sanitizePlacement(r.placement),
    hotkeys: sanitizeNotesHotkeys(r.hotkeys, taken)
  }
}

/** `current` with `patch` applied, validated (hotkeys merged one by one). */
export function applyNotesPatch(current: NotesSettings, patch: unknown, taken: readonly string[] = []): NotesSettings {
  const p = (patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}) as NotesSettingsPatch
  const hotkeys = p.hotkeys && typeof p.hotkeys === 'object' ? p.hotkeys : {}
  return sanitizeNotesSettings({ ...current, ...p, hotkeys: { ...current.hotkeys, ...hotkeys } }, taken)
}

/** Only the fields the notes window may change; anything else in `raw` is dropped. */
export function sanitizeLookPatch(raw: unknown): NotesLookPatch {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const out: NotesLookPatch = {}
  for (const key of ['wpm', 'fontSize', 'width', 'height'] as const) {
    if (typeof r[key] === 'number' && Number.isFinite(r[key])) out[key] = r[key] as number
  }
  return out
}

/** The script kept with a recording, cleaned; undefined when absent or empty (older projects have none). */
export function readProjectScript(raw: unknown): ProjectScript | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const text = cleanNotesText((raw as { text?: unknown }).text)
  return hasNotesText(text) ? { text } : undefined
}
