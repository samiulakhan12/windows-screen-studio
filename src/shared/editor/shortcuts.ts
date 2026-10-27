/**
 * Editor keyboard shortcuts: one keymap from command ids (commands.ts) to key combinations,
 * with the default bindings, the user's changes (stored in editor-prefs.json under
 * 'shortcuts'), parsing and labels, matching KeyboardEvents, conflicts and reserved keys. Pure.
 *
 * A shortcut is written like an Electron accelerator: "Ctrl+Shift+Z", "Shift+Left", "Space",
 * "Plus". Keys are matched by the character they type (KeyboardEvent.key), as the editor always
 * did, so "Z" follows the keyboard layout; layouts without Latin letters fall back to the
 * physical key. For symbol keys Shift is part of the character: "Plus" is Shift+= on a US
 * keyboard and matches however it is typed. Ctrl and the Windows/Command key count as one.
 */
import { COMMAND_IDS, commandInfo, isCommandId, type CommandId } from './commands'

export interface Chord {
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** Canonical key name: "A".."Z", "0".."9", "F1".."F24", "Space", "Left", "Plus", "-", "?", … */
  key: string
}

/** Every command's shortcuts, as canonical accelerators (possibly none). */
export type Keymap = Record<CommandId, string[]>

/** At most this many shortcuts per command. */
export const MAX_BINDINGS = 4

export const DEFAULT_KEYMAP: Keymap = Object.freeze({
  ...(Object.fromEntries(COMMAND_IDS.map((id) => [id, []])) as unknown as Keymap),
  play: ['Space'],
  goToStart: ['Home'],
  goToEnd: ['End'],
  stepBack: ['Left'],
  stepForward: ['Right'],
  jumpBack: ['Shift+Left'],
  jumpForward: ['Shift+Right'],
  nextChapter: ['Shift+PageDown'],
  prevChapter: ['Shift+PageUp'],
  shuttleReverse: ['J'],
  shuttlePause: ['K'],
  shuttleForward: ['L'],
  previewSpeedUp: ['>'],
  previewSpeedDown: ['<'],
  undo: ['Ctrl+Z'],
  redo: ['Ctrl+Shift+Z', 'Ctrl+Y'],
  split: ['S'],
  deleteSelection: ['Delete', 'Backspace'],
  polish: ['Shift+P'],
  cropRecording: ['C'],
  addZoom: ['Z'],
  addText: ['T'],
  addTitle: ['Shift+T'],
  addChapter: ['M'],
  freezeFrame: ['F'],
  zoomLevel0: ['0'],
  zoomLevel1: ['1'],
  zoomLevel2: ['2'],
  zoomLevel3: ['3'],
  zoomLevel4: ['4'],
  timelineZoomIn: ['Plus', '='],
  timelineZoomOut: ['-', '_'],
  toggleSnapping: ['N'],
  export: ['Ctrl+E'],
  shortcuts: ['Ctrl+/'],
  about: [],
  commandPalette: ['Ctrl+K', 'Ctrl+Shift+P']
})

/* ---------- key names ---------- */

const NAMED_KEYS = [
  'Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'Up', 'Down', 'Left', 'Right', 'Escape', 'Plus',
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`)
]

/** Keys named by the character they type (Shift is part of the character). */
const SYMBOLS = new Set(['-', '=', '_', '[', ']', '{', '}', ';', ':', "'", '"', ',', '.', '<', '>', '/', '?', '\\', '|', '`', '~', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')'])

const isSymbolKey = (key: string): boolean => key === 'Plus' || SYMBOLS.has(key)

/** Names accepted when parsing, lower case → canonical. */
const KEY_ALIASES = new Map<string, string>([
  ...NAMED_KEYS.map((k) => [k.toLowerCase(), k] as [string, string]),
  ['esc', 'Escape'],
  ['return', 'Enter'],
  ['del', 'Delete'],
  ['ins', 'Insert'],
  ['spacebar', 'Space'],
  ['arrowup', 'Up'],
  ['arrowdown', 'Down'],
  ['arrowleft', 'Left'],
  ['arrowright', 'Right'],
  ['pgup', 'PageUp'],
  ['pgdn', 'PageDown'],
  ['+', 'Plus'],
  ['minus', '-'],
  ['equal', '='],
  ['slash', '/']
])

/** KeyboardEvent.key values of named keys → canonical names. */
const EVENT_KEYS: Record<string, string> = {
  ' ': 'Space',
  Spacebar: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Del: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
  Escape: 'Escape',
  Esc: 'Escape'
}

/** KeyboardEvent.code → canonical name, for keys whose character is not a Latin letter or known symbol. */
const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
  NumpadAdd: 'Plus',
  NumpadSubtract: '-',
  NumpadMultiply: '*',
  NumpadDivide: '/',
  NumpadDecimal: '.',
  NumpadEnter: 'Enter'
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS', 'Super', 'Hyper', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock'])

/** Canonical key name of a single key token ("a" → "A", "arrowleft" → "Left"), or null. */
function canonicalKey(token: string): string | null {
  if (token.length === 1) {
    if (/[a-z]/i.test(token)) return token.toUpperCase()
    if (/\d/.test(token)) return token
    if (token === '+') return 'Plus'
    if (SYMBOLS.has(token)) return token
    return null
  }
  return KEY_ALIASES.get(token.toLowerCase()) ?? null
}

/* ---------- parsing and labels ---------- */

const MODIFIER_ALIASES: Record<string, 'ctrl' | 'alt' | 'shift'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'ctrl',
  command: 'ctrl',
  cmdorctrl: 'ctrl',
  commandorcontrol: 'ctrl',
  meta: 'ctrl',
  super: 'ctrl',
  win: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift'
}

/** Parses "Ctrl+Shift+Z"; null when malformed (no key, two keys, unknown names). */
export function parseShortcut(accelerator: unknown): Chord | null {
  if (typeof accelerator !== 'string' || !accelerator.trim() || accelerator.length > 40) return null
  const parts = accelerator.split('+').map((p) => p.trim())
  // "Ctrl++" spells the plus key with a trailing empty part.
  if (parts.length >= 2 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') parts.splice(-2, 2, 'Plus')
  if (parts.some((p) => !p)) return null
  const chord: Chord = { ctrl: false, alt: false, shift: false, key: '' }
  for (let i = 0; i < parts.length; i++) {
    const mod = MODIFIER_ALIASES[parts[i].toLowerCase()]
    if (mod && i < parts.length - 1) {
      chord[mod] = true
      continue
    }
    if (i !== parts.length - 1) return null
    const key = canonicalKey(parts[i])
    if (!key) return null
    chord.key = key
  }
  if (!chord.key) return null
  if (isSymbolKey(chord.key)) chord.shift = false
  return chord
}

/** The canonical accelerator of a chord: modifiers in the order Ctrl, Alt, Shift. */
export function formatChord(c: Chord): string {
  return [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', c.key].filter(Boolean).join('+')
}

/** The canonical form of an accelerator ("shift+left" → "Shift+Left"), or null when malformed. */
export function normalizeShortcut(accelerator: unknown): string | null {
  const c = parseShortcut(accelerator)
  return c ? formatChord(c) : null
}

const KEY_LABELS: Record<string, string> = {
  Left: '←',
  Right: '→',
  Up: '↑',
  Down: '↓',
  Escape: 'Esc',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Plus: '+'
}

/** The keycaps of a shortcut: "Ctrl+Shift+Z" → ["Ctrl", "Shift", "Z"]. Malformed ones are returned whole. */
export function shortcutKeys(accelerator: string): string[] {
  const c = parseShortcut(accelerator)
  if (!c) return [accelerator]
  return [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', KEY_LABELS[c.key] ?? c.key].filter((k): k is string => !!k)
}

/** "Ctrl + Shift + Z", "Shift + ←". */
export function shortcutLabel(accelerator: string): string {
  return shortcutKeys(accelerator).join(' + ')
}

/** `text` with the first shortcut in brackets: "Split the clip at the playhead (S)". */
export function withShortcut(text: string, accelerators: readonly string[] | undefined): string {
  return accelerators?.length ? `${text} (${shortcutLabel(accelerators[0])})` : text
}

/** `text` followed by ", or press" and the first shortcut: "Double-click to add text, or press T". */
export function orPress(text: string, accelerators: readonly string[] | undefined): string {
  return accelerators?.length ? `${text}, or press ${shortcutLabel(accelerators[0])}` : text
}

/** " · Ctrl + Z to undo", for a notice after a big change; empty when Undo has no shortcut. */
export function undoHint(keymap: Keymap): string {
  return keymap.undo.length ? ` · ${shortcutLabel(keymap.undo[0])} to undo` : ''
}

/** "A", "A and B", "A, B and C". */
const listPhrase = (items: string[]): string => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

/**
 * What the zoom level keys do, for hints: "1–4 set its zoom level, 0 pulls back" with the
 * default keys, following the user's shortcuts; null when none of them has one.
 */
export function zoomLevelKeysHint(keymap: Keymap): string | null {
  const levels = (['zoomLevel1', 'zoomLevel2', 'zoomLevel3', 'zoomLevel4'] as const).flatMap((id) => keymap[id].slice(0, 1).map(shortcutLabel))
  // Three or more digits in a row read as a range.
  const run = levels.length > 2 && levels.every((l, i) => /^\d$/.test(l) && (i === 0 || Number(l) === Number(levels[i - 1]) + 1))
  const back = keymap.zoomLevel0[0]
  const parts = [
    levels.length > 0 && `${run ? `${levels[0]}–${levels[levels.length - 1]}` : listPhrase(levels)} ${levels.length === 1 ? 'sets' : 'set'} its zoom level`,
    back && `${shortcutLabel(back)} pulls back`
  ].filter((p): p is string => !!p)
  return parts.length ? parts.join(', ') : null
}

/* ---------- keyboard events ---------- */

/** The KeyboardEvent fields shortcuts use (a DOM KeyboardEvent or React's synthetic one). */
export interface KeyInput {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** Canonical name of the key pressed, or null for modifiers and keys shortcuts cannot use. */
export function eventKeyName(e: Pick<KeyInput, 'key' | 'code'>): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const named = EVENT_KEYS[e.key] ?? (/^F([1-9]|1\d|2[0-4])$/.test(e.key) ? e.key : null)
  if (named) return named
  const code = e.code ?? ''
  const letterKey = /^Key([A-Z])$/.exec(code)?.[1] ?? null
  if (e.key.length === 1) {
    // A letter of another alphabet ("я") stands for the Latin letter on the same key; other
    // characters (é, ß on a digit or symbol key) are not shortcuts, as before.
    return canonicalKey(e.key) ?? letterKey
  }
  // A dead key or an unidentified one: use the physical key.
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code)?.[1] ?? null
  return letterKey ?? digit ?? CODE_KEYS[code] ?? null
}

/** The chord a key press makes, or null when only modifiers are held. */
export function chordFromEvent(e: KeyInput): Chord | null {
  const key = eventKeyName(e)
  if (!key) return null
  return { ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey && !isSymbolKey(key), key }
}

/** What the keys held so far look like while recording a shortcut: "Ctrl + Shift + …". */
export function partialLabel(e: KeyInput): string {
  const mods = [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean)
  return mods.length ? `${mods.join(' + ')} + …` : ''
}

/** Accelerator → command, for matching key presses. */
export type ShortcutIndex = ReadonlyMap<string, CommandId>

export function shortcutIndex(keymap: Keymap): ShortcutIndex {
  const index = new Map<string, CommandId>()
  for (const id of COMMAND_IDS) for (const a of keymap[id] ?? []) if (!index.has(a)) index.set(a, id)
  return index
}

/**
 * The command a chord runs. A chord with Shift that has no shortcut of its own runs the
 * command of the same keys without Shift, as the editor always did (Shift+S splits too).
 */
export function matchShortcut(index: ShortcutIndex, chord: Chord): CommandId | null {
  const exact = index.get(formatChord(chord))
  if (exact) return exact
  return chord.shift ? (index.get(formatChord({ ...chord, shift: false })) ?? null) : null
}

/** Keys a focused slider uses itself: a shortcut on them waits until the slider loses focus. */
const SLIDER_KEYS = new Set(['Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown'])

export const isSliderKey = (c: Chord): boolean => SLIDER_KEYS.has(c.key) && !c.ctrl && !c.alt

/* ---------- validation, conflicts and editing ---------- */

const ESCAPE_REASON = 'Esc always cancels: it closes dialogs and clears the selection.'

/** Keys that keep their usual meaning and cannot be shortcuts, with the reason. */
const RESERVED: Record<string, string> = {
  Enter: 'Enter presses the focused button.',
  Tab: 'Tab moves between controls.',
  'Shift+Tab': 'Shift + Tab moves between controls.',
  'Alt+F4': 'Alt + F4 closes the window.',
  'Alt+Space': 'Alt + Space opens the window menu.',
  'Ctrl+Escape': 'Ctrl + Esc opens the Start menu.',
  'Ctrl+Shift+Escape': 'Ctrl + Shift + Esc opens the Task Manager.',
  'Alt+Escape': 'Alt + Esc switches to another window.',
  'Ctrl+W': 'Ctrl + W closes the window.',
  'Ctrl+R': 'Ctrl + R reloads the window.',
  'Ctrl+Shift+R': 'Ctrl + Shift + R reloads the window.',
  'Ctrl+Shift+I': 'Ctrl + Shift + I opens the developer tools.',
  F11: 'F11 switches full screen.',
  'Ctrl+0': 'Ctrl + 0 resets the window zoom.',
  'Ctrl+Plus': 'Ctrl + + zooms the window.',
  'Ctrl+=': 'Ctrl + = zooms the window.',
  'Ctrl+-': 'Ctrl + - zooms the window.'
}

/**
 * Why a chord cannot be a shortcut, or null. Esc is never one: with Ctrl or Alt it belongs
 * to Windows, and otherwise (Shift too) the editor reads it as Esc before any shortcut.
 */
function reservedChord(c: Chord): string | null {
  return RESERVED[formatChord(c)] ?? (c.key === 'Escape' ? ESCAPE_REASON : null)
}

/** Why `accelerator` cannot be a shortcut, or null when it can. */
export function reservedReason(accelerator: string): string | null {
  const c = parseShortcut(accelerator)
  return c ? reservedChord(c) : null
}

export type ShortcutCheck = { ok: true; accelerator: string } | { ok: false; message: string }

/** Checks that `accelerator` can run `id`: well formed, not reserved, and usable while typing when it has to be. */
export function checkShortcut(accelerator: unknown, id: CommandId): ShortcutCheck {
  const c = parseShortcut(accelerator)
  if (!c) return { ok: false, message: 'That key cannot be used for a shortcut.' }
  const normalized = formatChord(c)
  const reserved = reservedChord(c)
  if (reserved) return { ok: false, message: reserved }
  if (commandInfo(id).inText && !c.ctrl && !c.alt && !/^F\d+$/.test(c.key)) {
    return { ok: false, message: `This shortcut also works while typing, so it needs Ctrl or Alt (${shortcutLabel(normalized)} would type instead).` }
  }
  return { ok: true, accelerator: normalized }
}

/** The command `accelerator` is bound to, if any. */
export function commandForShortcut(keymap: Keymap, accelerator: string): CommandId | null {
  const n = normalizeShortcut(accelerator)
  if (!n) return null
  return COMMAND_IDS.find((id) => keymap[id].includes(n)) ?? null
}

/** Accelerators bound to more than one command, with those commands. */
export function findConflicts(keymap: Keymap): Map<string, CommandId[]> {
  const owners = new Map<string, CommandId[]>()
  for (const id of COMMAND_IDS) for (const a of keymap[id]) owners.set(a, [...(owners.get(a) ?? []), id])
  return new Map([...owners].filter(([, ids]) => ids.length > 1))
}

/** `accelerator` added to `id`, and taken away from any other command that had it. */
export function addBinding(keymap: Keymap, id: CommandId, accelerator: string): Keymap {
  const n = normalizeShortcut(accelerator)
  if (!n || keymap[id].includes(n)) return keymap
  const next = { ...keymap }
  for (const other of COMMAND_IDS) if (other !== id && next[other].includes(n)) next[other] = next[other].filter((a) => a !== n)
  next[id] = [...keymap[id], n].slice(-MAX_BINDINGS)
  return next
}

export function removeBinding(keymap: Keymap, id: CommandId, accelerator: string): Keymap {
  if (!keymap[id].includes(accelerator)) return keymap
  return { ...keymap, [id]: keymap[id].filter((a) => a !== accelerator) }
}

/** The default shortcuts of `id` that another command has now, with that command. */
export function takenDefaults(keymap: Keymap, id: CommandId): { accelerator: string; owner: CommandId }[] {
  const out: { accelerator: string; owner: CommandId }[] = []
  for (const a of DEFAULT_KEYMAP[id]) {
    const owner = commandForShortcut(keymap, a)
    if (owner && owner !== id) out.push({ accelerator: a, owner })
  }
  return out
}

/**
 * `id` back to its default shortcuts. Those another command has now (takenDefaults) stay
 * with it, unless `takeBack`, which moves them back to `id`.
 */
export function resetCommand(keymap: Keymap, id: CommandId, takeBack = false): Keymap {
  const taken = new Set(takenDefaults(keymap, id).map((t) => t.accelerator))
  const next = { ...keymap, [id]: DEFAULT_KEYMAP[id].filter((a) => takeBack || !taken.has(a)) }
  if (takeBack) for (const other of COMMAND_IDS) if (other !== id && next[other].some((a) => taken.has(a))) next[other] = next[other].filter((a) => !taken.has(a))
  return next
}

const sameBindings = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x))

export const isDefaultBinding = (keymap: Keymap, id: CommandId): boolean => sameBindings(keymap[id], DEFAULT_KEYMAP[id])

/** The commands whose shortcuts differ from the defaults (what is stored). */
export function keymapOverrides(keymap: Keymap): Partial<Keymap> {
  const out: Partial<Keymap> = {}
  for (const id of COMMAND_IDS) if (!isDefaultBinding(keymap, id)) out[id] = [...keymap[id]]
  return out
}

/**
 * The keymap for the user's `overrides`: defaults for everything else. A shortcut is never
 * bound twice: the user's own choices win over defaults, earlier commands over later ones.
 */
export function resolveKeymap(overrides: Partial<Keymap>): Keymap {
  const next = { ...DEFAULT_KEYMAP } as Keymap
  for (const id of COMMAND_IDS) if (overrides[id]) next[id] = [...overrides[id]!]
  const taken = new Set<string>()
  const order = [...COMMAND_IDS.filter((id) => overrides[id]), ...COMMAND_IDS.filter((id) => !overrides[id])]
  for (const id of order) {
    next[id] = next[id].filter((a) => !taken.has(a))
    for (const a of next[id]) taken.add(a)
  }
  return next
}

const PREFS_VERSION = 1

/** What is stored under the 'shortcuts' preference. */
export interface ShortcutPrefs {
  version: number
  bindings: Partial<Keymap>
}

export function serializeShortcuts(keymap: Keymap): ShortcutPrefs {
  return { version: PREFS_VERSION, bindings: keymapOverrides(keymap) }
}

/**
 * The user's shortcut changes read back from storage, validated: unknown commands, malformed,
 * reserved or duplicate shortcuts are dropped. Anything unreadable means "no changes".
 */
export function sanitizeShortcuts(raw: unknown): Partial<Keymap> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const { version, bindings } = raw as { version?: unknown; bindings?: unknown }
  if (version !== PREFS_VERSION || !bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return {}
  const out: Partial<Keymap> = {}
  for (const [id, list] of Object.entries(bindings as Record<string, unknown>)) {
    if (!isCommandId(id) || !Array.isArray(list)) continue
    const accels: string[] = []
    for (const a of list.slice(0, MAX_BINDINGS * 2)) {
      const check = checkShortcut(a, id)
      if (check.ok && !accels.includes(check.accelerator)) accels.push(check.accelerator)
    }
    out[id] = accels.slice(0, MAX_BINDINGS)
  }
  return out
}

/** The keymap stored in the preferences (`raw` as read back), or the defaults. */
export const keymapFromPrefs = (raw: unknown): Keymap => resolveKeymap(sanitizeShortcuts(raw))
