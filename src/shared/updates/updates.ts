/**
 * Flown's own updates (NW-15, docs/design/auto-update.md): the state Settings › About and Home
 * show, the events that move it, and its plain copy. Pure: main runs it, the tests drive it.
 */

/** First automatic check after start-up. */
export const FIRST_CHECK_MS = 30_000
/** Then one automatic check every this long. */
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000
/** Longest release notes shown (plain text). */
export const NOTES_MAX = 4000

export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdateState {
  phase: UpdatePhase
  /** This copy's version. */
  current: string
  /** The newer version found (available, downloading, ready). */
  version?: string
  /** Its release notes as plain text (notesText). */
  notes?: string
  /** Downloading: 0-100. */
  percent?: number
  /** error: what went wrong, in plain words. */
  error?: string
  /** When the last check ended (ISO time); null before the first. */
  lastCheck: string | null
  /** "Update Flown automatically". */
  auto: boolean
}

/** What the updater reports (from electron-updater, or the fake one in development and tests). */
export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string; notes?: unknown }
  | { type: 'none' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string; notes?: unknown }
  | { type: 'error'; stage: 'check' | 'download'; message: string }

export const UPDATE_COPY = {
  disabled: 'Updates are turned off in this build.',
  never: 'Flown has not looked for updates yet.',
  upToDate: 'Flown is up to date.',
  checking: 'Checking for updates…',
  checkFailed: "Couldn't check for updates. Check your internet connection and try again.",
  downloadFailed: "The update couldn't be downloaded. Flown will try again later.",
  /** The same, when automatic updates are off: nothing tries again by itself. */
  downloadFailedManual: "The update couldn't be downloaded. Try again.",
  notReady: 'There is no update ready to install.'
} as const

const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/

/** A release version Flown shows and installs: plain x.y.z (no pre-releases, nothing else). */
export const isVersion = (v: unknown): v is string => typeof v === 'string' && VERSION_RE.test(v)

/** Whether release version `a` is newer than `b` (false when either is not a plain version). */
export function isNewer(a: string, b: string): boolean {
  if (!isVersion(a) || !isVersion(b)) return false
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      // Control characters and unpaired surrogates are dropped; the rest decode.
      if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code < 32 && code !== 10 && code !== 9)) return ''
      return String.fromCodePoint(code)
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/**
 * Release notes as plain text: GitHub gives the release body as HTML (or a list of notes, one per
 * version). It is untrusted text, so it is never rendered as HTML: scripts and styles go with their
 * content, block ends become line breaks, list items get a bullet, every other tag is removed,
 * entities are decoded, spaces folded, and the result is at most NOTES_MAX characters.
 */
export function notesText(raw: unknown): string {
  let html = ''
  if (typeof raw === 'string') html = raw
  else if (Array.isArray(raw)) {
    html = raw
      .map((n) => (n && typeof n === 'object' && typeof (n as { note?: unknown }).note === 'string' ? (n as { note: string }).note : ''))
      .filter(Boolean)
      .join('\n\n')
  }
  if (!html) return ''
  const text = decodeEntities(
    html
      .slice(0, 200_000)
      .replace(/<(script|style|template|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<br\s*\/?>/gi, '\n')
      // Blocks start and end on a line of their own (list items stay on consecutive lines).
      .replace(/<\/?(p|div|ul|ol|h[1-6]|pre|blockquote|tr|table)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  )
  const lines = text
    .replace(/\r\n?/g, '\n')
    // Control and invisible formatting characters (bidi overrides included) are dropped.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
  const folded = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (folded.length <= NOTES_MAX) return folded
  const cut = folded.slice(0, NOTES_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return `${space > NOTES_MAX * 0.8 ? cut.slice(0, space) : cut}…`
}

/** The state of a copy that cannot update itself (development builds, other systems). */
export function disabledState(current: string): UpdateState {
  return { phase: 'disabled', current, lastCheck: null, auto: false }
}

/**
 * The state after the updater reported `e` (`at`: now, ISO). A check never undoes a download under
 * way, nor a finished one of the version it still offers; a downloaded release the check no longer
 * offers (it was pulled) is dropped for the one it offers now. A version that is not newer than this
 * copy's is ignored.
 */
export function reduceUpdate(s: UpdateState, e: UpdaterEvent, at: string): UpdateState {
  if (s.phase === 'disabled') return s
  const base = { current: s.current, lastCheck: s.lastCheck, auto: s.auto }
  switch (e.type) {
    case 'checking':
      return s.phase === 'downloading' || s.phase === 'ready' ? s : { ...base, phase: 'checking' }
    case 'available': {
      if (s.phase === 'downloading' || (s.phase === 'ready' && e.version === s.version)) return { ...s, lastCheck: at }
      if (!isVersion(e.version) || !isNewer(e.version, s.current)) return { ...base, phase: 'idle', lastCheck: at }
      return { ...base, phase: 'available', version: e.version, notes: notesText(e.notes), lastCheck: at }
    }
    case 'none':
      // A release pulled after it was downloaded: nothing is offered any more (main also stops
      // the downloaded copy from installing at quit).
      return { ...base, phase: 'idle', lastCheck: at }
    case 'progress':
      if (s.phase !== 'available' && s.phase !== 'downloading') return s
      return { ...base, phase: 'downloading', version: s.version, notes: s.notes, percent: Math.max(0, Math.min(100, Math.round(Number.isFinite(e.percent) ? e.percent : 0))) }
    case 'downloaded': {
      if (!isVersion(e.version) || !isNewer(e.version, s.current)) return { ...base, phase: 'idle' }
      const notes = notesText(e.notes)
      return { ...base, phase: 'ready', version: e.version, notes: notes || s.notes }
    }
    case 'error':
      if (s.phase === 'ready') return s
      if (e.stage === 'download') return { ...base, phase: 'error', version: s.version, notes: s.notes, error: UPDATE_COPY.downloadFailed }
      return { ...base, phase: 'error', error: UPDATE_COPY.checkFailed, lastCheck: at }
  }
}

/** The status line of Settings › About. */
export function statusLine(s: UpdateState): string {
  switch (s.phase) {
    case 'disabled':
      return UPDATE_COPY.disabled
    case 'idle':
      return s.lastCheck ? UPDATE_COPY.upToDate : UPDATE_COPY.never
    case 'checking':
      return UPDATE_COPY.checking
    case 'available':
      return `Flown ${s.version} is available.`
    case 'downloading':
      return `Downloading Flown ${s.version}… ${s.percent ?? 0}%`
    case 'ready':
      return `Flown ${s.version} is ready. It installs when you close Flown.`
    case 'error':
      // Only automatic updates try a failed download again by themselves (the next check).
      if (s.error === UPDATE_COPY.downloadFailed && !s.auto) return UPDATE_COPY.downloadFailedManual
      return s.error ?? UPDATE_COPY.checkFailed
  }
}

/**
 * What the status's live region says: the status line without the download's percent, which
 * changes about once a second (the progress bar gives it when asked). So a download is announced
 * once, not at every percent.
 */
export function spokenStatus(s: UpdateState): string {
  return s.phase === 'downloading' ? `Downloading Flown ${s.version}…` : statusLine(s)
}

/**
 * What keeps Restart now from running (main checks it again when it is pressed). 'processing' (a
 * recording being saved or processed) is the page's check: main cannot see that step.
 */
export type BusyKind = 'recording' | 'processing' | 'export' | 'captions' | 'analysis' | 'import' | 'voice' | 'copy'

export const BUSY_COPY: Record<BusyKind, string> = {
  recording: 'Stop the recording first.',
  processing: 'Wait for the recording to finish processing.',
  export: 'Finish or stop the export first.',
  captions: 'Wait for the captions to finish, or stop them.',
  analysis: 'Wait for the sound analysis to finish.',
  import: 'Wait for the import to finish, or cancel it.',
  voice: 'Wait for Clean voice to finish.',
  copy: 'Wait for the copy to finish, or cancel it.'
}
