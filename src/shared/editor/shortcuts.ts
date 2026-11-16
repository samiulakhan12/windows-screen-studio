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
import { fmt } from '../i18n/fmt'
import { t, uiLanguage, type MessageKey } from '../i18n/t'

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
  review: ['Shift+R'],
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
  duplicateItems: ['Ctrl+D'],
  copyLook: ['Ctrl+Shift+C'],
  pasteLook: ['Ctrl+Shift+V'],
  holdView: ['R'],
  toggleSafeZones: ['G'],
  export: ['Ctrl+E'],
  shortcuts: ['Ctrl+/'],
  about: [],
  commandPalette: ['Ctrl+K', 'Ctrl+Shift+P'],
  // E-12 versions (docs/design/versions.md §2.7).
  saveVersion: ['Ctrl+Shift+S'],
  // Editing polish (docs/design/editing-polish.md §2.8): no default keys, so no one's keys change.
  smoothAllCuts: [],
  hardCutsEverywhere: [],
  nextCut: [],
  previousCut: [],
  playCut: [],
  addMagnifier: [],
  addMagnifierCursor: [],
  addStepBadge: [],
  addSpeechBubble: [],
  toggleProgressBar: [],
  compareColour: [],
  autoColour: [],
  musicLibrary: []
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

/** Key names in aria-keyshortcuts' syntax (KeyboardEvent key values; "Space" for the space bar), where they differ from ours. */
const ARIA_KEYS: Record<string, string> = { Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown' }

/**
 * Shortcuts as aria-keyshortcuts writes them (docs/design/output-and-languages.md §14.2): each in
 * its fixed syntax, never translated ("Control+Shift+Z Control+Y"), or undefined for none. For
 * controls whose tooltip does not name the shortcut already. The plus key, which that syntax uses
 * between keys, stays "Plus".
 */
export function ariaKeys(accelerators: readonly string[] | undefined): string | undefined {
  const out: string[] = []
  for (const a of accelerators ?? []) {
    const c = parseShortcut(a)
    if (c) out.push([c.ctrl && 'Control', c.alt && 'Alt', c.shift && 'Shift', ARIA_KEYS[c.key] ?? c.key].filter(Boolean).join('+'))
  }
  return out.length ? out.join(' ') : undefined
}

/*
 * The sentences around keycaps are messages (keys.*, docs/design/output-and-languages.md §14.1);
 * the keycaps stay as shortcutLabel writes them in every language.
 */

/** `text` with the first shortcut in brackets: "Split the clip at the playhead (S)". */
export function withShortcut(text: string, accelerators: readonly string[] | undefined): string {
  return accelerators?.length ? t('keys.withShortcut', { text, keys: shortcutLabel(accelerators[0]) }) : text
}

/** `text` followed by ", or press" and the first shortcut: "Double-click to add text, or press T". */
export function orPress(text: string, accelerators: readonly string[] | undefined): string {
  return accelerators?.length ? t('keys.orPress', { text, keys: shortcutLabel(accelerators[0]) }) : text
}

/**
 * ". Review (Shift + R)", for a notice after automatic changes Review mode lists (Captions Studio
 * §2.8), with the user's key; ". Review mode lists them" when Review has none.
 */
export function reviewHint(keymap: Keymap): string {
  return keymap.review.length ? t('keys.reviewHint', { keys: shortcutLabel(keymap.review[0]) }) : t('keys.reviewHintNoKey')
}

/**
 * " · Ctrl + Z to undo", for a notice after a big change; empty when Undo has no shortcut. Other
 * messages take it as their {undo} placeholder. English keeps today's piece (merge group,
 * output-and-languages §9.3); other languages say the hint as a phrase of its own, after the same
 * separator.
 */
export function undoHint(keymap: Keymap): string {
  if (!keymap.undo.length) return ''
  const keys = shortcutLabel(keymap.undo[0])
  return uiLanguage() === 'en' ? t('keys.undoHint.lead', { keys }) : ` · ${t('keys.undoHint.whole', { keys })}`
}

/**
 * What the zoom level keys do, for hints: "1–4 set its zoom level, 0 pulls back" with the
 * default keys, following the user's shortcuts; null when none of them has one.
 */
export function zoomLevelKeysHint(keymap: Keymap): string | null {
  const levels = (['zoomLevel1', 'zoomLevel2', 'zoomLevel3', 'zoomLevel4'] as const).flatMap((id) => keymap[id].slice(0, 1).map(shortcutLabel))
  // Three or more digits in a row read as a range.
  const run = levels.length > 2 && levels.every((l, i) => /^\d$/.test(l) && (i === 0 || Number(l) === Number(levels[i - 1]) + 1))
  const back = keymap.zoomLevel0[0]
  const keys = run ? t('keys.zoomLevels.range', { first: levels[0], last: levels[levels.length - 1] }) : fmt.list(levels)
  // `count` chooses "sets" or "set": how many level keys there are.
  if (levels.length && back) return t('keys.zoomLevels.both', { levels: keys, count: levels.length, back: shortcutLabel(back) })
  if (levels.length) return t('keys.zoomLevels.levels', { levels: keys, count: levels.length })
  return back ? t('keys.zoomLevels.back', { back: shortcutLabel(back) }) : null
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

/*
 * Standard edit keys (E-06, docs/design/multi-select.md §6): Ctrl+A, C, X and V keep the meaning
 * every Windows user knows, for timeline items. They are not keymap bindings: the editor runs them
 * only when the keymap has nothing for the chord, so a user who binds one of them to another
 * command takes it over, and matchShortcut never returns them.
 */

/** Edit keys every Windows user knows; matched only when the keymap has nothing for the chord. */
export const STANDARD_EDIT_KEYS: Readonly<Record<'Ctrl+A' | 'Ctrl+C' | 'Ctrl+X' | 'Ctrl+V', CommandId>> = Object.freeze({
  'Ctrl+A': 'selectAll',
  'Ctrl+C': 'copyItems',
  'Ctrl+X': 'cutItems',
  'Ctrl+V': 'pasteItems'
})

/** The standard command of a chord: exact match only (Ctrl+Shift+C is never Ctrl+C). */
export function standardEditCommand(chord: Chord): CommandId | null {
  const key = formatChord(chord)
  return Object.prototype.hasOwnProperty.call(STANDARD_EDIT_KEYS, key) ? STANDARD_EDIT_KEYS[key as keyof typeof STANDARD_EDIT_KEYS] : null
}

/** The standard key of command `id` ("Ctrl+C" for copyItems), or null. */
export function standardKeyOf(id: CommandId): string | null {
  return (Object.keys(STANDARD_EDIT_KEYS) as (keyof typeof STANDARD_EDIT_KEYS)[]).find((k) => STANDARD_EDIT_KEYS[k] === id) ?? null
}

/*
 * Nudge (E-09, docs/design/versions.md §4.1): while items are selected, the keys of the frame and
 * second steps move them one and ten frames instead. Not keymap bindings: the nudges follow
 * whatever keys the step commands have, and a key a user gives a nudge itself works always.
 */

export type NudgeCommand = 'nudgeBack' | 'nudgeForward' | 'nudgeBackTen' | 'nudgeForwardTen'

/** The step command whose keys each nudge borrows, and how many frames it moves. */
export const NUDGE_STEPS: Readonly<Record<NudgeCommand, { step: CommandId; frames: number }>> = Object.freeze({
  nudgeBack: { step: 'stepBack', frames: -1 },
  nudgeForward: { step: 'stepForward', frames: 1 },
  nudgeBackTen: { step: 'jumpBack', frames: -10 },
  nudgeForwardTen: { step: 'jumpForward', frames: 10 }
})

const NUDGE_OF_STEP = new Map<CommandId, NudgeCommand>(Object.entries(NUDGE_STEPS).map(([nudge, { step }]) => [step, nudge as NudgeCommand]))

/** What a key that runs `run` does: its nudge when items are selected and `run` is a step, else `run`. */
export function nudgeInstead(run: CommandId, itemsSelected: boolean): CommandId {
  return (itemsSelected && NUDGE_OF_STEP.get(run)) || run
}

/** A command's keys for labels: its keymap bindings, then its standard key (if any). */
export function commandKeys(keymap: Keymap, id: CommandId): string[] {
  const own = keymap[id] ?? []
  const nudge = (NUDGE_STEPS as Partial<Record<CommandId, { step: CommandId }>>)[id]
  // A nudge also has its step's keys (while items are selected).
  if (nudge) return [...own, ...keymap[nudge.step].filter((k) => !own.includes(k))]
  const standard = standardKeyOf(id)
  // The standard key works only while no command has it in the keymap.
  return standard && !own.includes(standard) && !commandForShortcut(keymap, standard) ? [...own, standard] : [...own]
}

/** Keys a focused slider uses itself: a shortcut on them waits until the slider loses focus. */
const SLIDER_KEYS = new Set(['Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown'])

export const isSliderKey = (c: Chord): boolean => SLIDER_KEYS.has(c.key) && !c.ctrl && !c.alt

/* ---------- validation, conflicts and editing ---------- */

/**
 * Keys that keep their usual meaning and cannot be shortcuts, with the reason: a message whose
 * {keys} is the key's label ("Shift + Tab moves between controls.").
 */
const RESERVED: Record<string, MessageKey> = {
  Enter: 'keys.reserved.pressesButton',
  Tab: 'keys.reserved.movesBetweenControls',
  'Shift+Tab': 'keys.reserved.movesBetweenControls',
  'Alt+F4': 'keys.reserved.closesWindow',
  'Alt+Space': 'keys.reserved.windowMenu',
  'Ctrl+Escape': 'keys.reserved.startMenu',
  'Ctrl+Shift+Escape': 'keys.reserved.taskManager',
  'Alt+Escape': 'keys.reserved.switchesWindow',
  'Ctrl+W': 'keys.reserved.closesWindow',
  'Ctrl+R': 'keys.reserved.reloads',
  'Ctrl+Shift+R': 'keys.reserved.reloads',
  'Ctrl+Shift+I': 'keys.reserved.developerTools',
  F11: 'keys.reserved.fullScreen',
  'Ctrl+0': 'keys.reserved.resetsZoom',
  'Ctrl+Plus': 'keys.reserved.zooms',
  'Ctrl+=': 'keys.reserved.zooms',
  'Ctrl+-': 'keys.reserved.zooms'
}

/**
 * Why a chord cannot be a shortcut, or null. Esc is never one: with Ctrl or Alt it belongs
 * to Windows, and otherwise (Shift too) the editor reads it as Esc before any shortcut.
 */
function reservedChord(c: Chord): string | null {
  const accelerator = formatChord(c)
  const reason = RESERVED[accelerator]
  if (reason) return t(reason, { keys: shortcutLabel(accelerator) })
  return c.key === 'Escape' ? t('keys.reserved.escape', { keys: shortcutLabel('Escape') }) : null
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
  if (!c) return { ok: false, message: t('keys.check.unusable') }
  const normalized = formatChord(c)
  const reserved = reservedChord(c)
  if (reserved) return { ok: false, message: reserved }
  if (commandInfo(id).inText && !c.ctrl && !c.alt && !/^F\d+$/.test(c.key)) {
    return { ok: false, message: t('keys.check.needsModifier', { keys: shortcutLabel(normalized) }) }
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
