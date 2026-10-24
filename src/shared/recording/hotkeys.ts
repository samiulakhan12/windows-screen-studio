/**
 * Recording hotkeys (stop, pause/resume, "zoom here"): Electron accelerators such as
 * "Ctrl+Shift+2", parsed, validated, checked for conflicts, labelled like the keystroke
 * overlay ("Ctrl + Shift + 2", so the app never records its own hotkeys) and captured
 * from a KeyboardEvent on Home. Pure: used by the main process and the renderer.
 */

export type HotkeyAction = 'stop' | 'pause' | 'mark'

export type Hotkeys = Record<HotkeyAction, string>

export const HOTKEY_ACTIONS: readonly HotkeyAction[] = ['stop', 'pause', 'mark']

/** Hotkeys are taken from every app while recording, so the defaults avoid what apps use (see COMMON). */
export const DEFAULT_HOTKEYS: Hotkeys = { stop: 'Ctrl+Shift+2', pause: 'Ctrl+Shift+F9', mark: 'Ctrl+Shift+F10' }

export const HOTKEY_NAMES: Record<HotkeyAction, string> = { stop: 'Stop', pause: 'Pause / resume', mark: 'Zoom here' }

type Modifier = 'Ctrl' | 'Alt' | 'Shift' | 'Super'
const MODIFIER_ORDER: readonly Modifier[] = ['Ctrl', 'Alt', 'Shift', 'Super']
/** How the keystroke overlay (src/main/recording/keystrokes.ts) names each modifier. */
const MODIFIER_LABEL: Record<Modifier, string> = { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Super: 'Win' }

const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  win: 'Super'
}

interface KeyDef {
  /** KeyboardEvent.code (layout independent). */
  code: string
  /** Electron accelerator key name. */
  accel: string
  /** Name in the keystroke overlay. */
  label: string
}

const KEYS: KeyDef[] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => ({ code: `Key${c}`, accel: c, label: c })),
  ...'0123456789'.split('').map((d) => ({ code: `Digit${d}`, accel: d, label: d })),
  ...Array.from({ length: 24 }, (_, i) => ({ code: `F${i + 1}`, accel: `F${i + 1}`, label: `F${i + 1}` })),
  ...'0123456789'.split('').map((d) => ({ code: `Numpad${d}`, accel: `num${d}`, label: `Num ${d}` })),
  { code: 'NumpadAdd', accel: 'numadd', label: 'Num +' },
  { code: 'NumpadSubtract', accel: 'numsub', label: 'Num -' },
  { code: 'NumpadMultiply', accel: 'nummult', label: 'Num *' },
  { code: 'NumpadDivide', accel: 'numdiv', label: 'Num /' },
  { code: 'NumpadDecimal', accel: 'numdec', label: 'Num .' },
  { code: 'Space', accel: 'Space', label: 'Space' },
  { code: 'Enter', accel: 'Enter', label: 'Enter' },
  { code: 'Tab', accel: 'Tab', label: 'Tab' },
  { code: 'Backspace', accel: 'Backspace', label: 'Backspace' },
  { code: 'Delete', accel: 'Delete', label: 'Delete' },
  { code: 'Insert', accel: 'Insert', label: 'Insert' },
  { code: 'Home', accel: 'Home', label: 'Home' },
  { code: 'End', accel: 'End', label: 'End' },
  { code: 'PageUp', accel: 'PageUp', label: 'Page Up' },
  { code: 'PageDown', accel: 'PageDown', label: 'Page Down' },
  { code: 'ArrowUp', accel: 'Up', label: '↑' },
  { code: 'ArrowDown', accel: 'Down', label: '↓' },
  { code: 'ArrowLeft', accel: 'Left', label: '←' },
  { code: 'ArrowRight', accel: 'Right', label: '→' },
  { code: 'Escape', accel: 'Escape', label: 'Esc' },
  { code: 'Minus', accel: '-', label: '-' },
  { code: 'Equal', accel: '=', label: '=' },
  { code: 'BracketLeft', accel: '[', label: '[' },
  { code: 'BracketRight', accel: ']', label: ']' },
  { code: 'Backslash', accel: '\\', label: '\\' },
  { code: 'Semicolon', accel: ';', label: ';' },
  { code: 'Quote', accel: "'", label: "'" },
  { code: 'Comma', accel: ',', label: ',' },
  { code: 'Period', accel: '.', label: '.' },
  { code: 'Slash', accel: '/', label: '/' },
  { code: 'Backquote', accel: '`', label: '`' }
]

const BY_CODE = new Map(KEYS.map((k) => [k.code, k]))
const BY_ACCEL = new Map(KEYS.map((k) => [k.accel.toLowerCase(), k]))
const KEY_ALIASES: Record<string, string> = { return: 'enter', esc: 'escape', pageup: 'pageup', pagedown: 'pagedown' }

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'])

export interface ParsedHotkey {
  modifiers: Modifier[]
  key: KeyDef | null
}

/** Parses an accelerator ("Ctrl+Shift+2", "CommandOrControl+Alt+F5"); null when malformed. */
export function parseHotkey(accelerator: unknown): ParsedHotkey | null {
  if (typeof accelerator !== 'string' || !accelerator.trim() || accelerator.length > 64) return null
  // "+" separates parts; a trailing "++" means the key "+" itself, which Electron spells "Plus" (not offered).
  const parts = accelerator.split('+').map((p) => p.trim())
  if (parts.some((p) => !p)) return null
  const modifiers = new Set<Modifier>()
  let key: KeyDef | null = null
  for (const part of parts) {
    const lower = part.toLowerCase()
    const mod = MODIFIER_ALIASES[lower]
    if (mod) {
      if (key) return null
      modifiers.add(mod)
      continue
    }
    if (key) return null
    const def = BY_ACCEL.get(KEY_ALIASES[lower] ?? lower)
    if (!def) return null
    key = def
  }
  return { modifiers: MODIFIER_ORDER.filter((m) => modifiers.has(m)), key }
}

/** The canonical accelerator ("Ctrl+Shift+2"), or null when it has no key or is malformed. */
export function normalizeHotkey(accelerator: unknown): string | null {
  const p = parseHotkey(accelerator)
  return p?.key ? [...p.modifiers, p.key.accel].join('+') : null
}

/**
 * The label the keystroke overlay would record for this hotkey ("Ctrl + Shift + 2"), also
 * used to show it. Malformed accelerators are returned as they are.
 */
export function hotkeyLabel(accelerator: string): string {
  const p = parseHotkey(accelerator)
  if (!p?.key) return accelerator
  return [...p.modifiers.map((m) => MODIFIER_LABEL[m]), p.key.label].join(' + ')
}

const isFunctionKey = (k: KeyDef): boolean => /^F\d+$/.test(k.accel)

/** Combinations Windows keeps for itself (they never reach an app, or must not be taken from the user). */
const RESERVED = new Set(
  [
    'Ctrl+Alt+Delete',
    'Ctrl+Shift+Escape',
    'Ctrl+Escape',
    'Alt+Tab',
    'Alt+Shift+Tab',
    'Alt+Escape',
    'Alt+F4',
    'Alt+Space',
    'Super+L',
    'Super+D',
    'Super+E',
    'Super+R',
    'Super+I',
    'Super+Tab',
    'Super+Shift+S',
    'Ctrl+Super+D'
  ].map((a) => normalizeHotkey(a)!)
)

/** Shortcuts every app relies on: taking them while recording would break them in the recorded app. */
const COMMON: Record<string, string> = {
  'Ctrl+C': 'Copy',
  'Ctrl+V': 'Paste',
  'Ctrl+X': 'Cut',
  'Ctrl+Z': 'Undo',
  'Ctrl+Y': 'Redo',
  'Ctrl+Shift+Z': 'Redo',
  'Ctrl+Shift+P': 'the command palette',
  'Ctrl+A': 'Select all',
  'Ctrl+S': 'Save',
  'Ctrl+F': 'Find'
}

export type HotkeyCheck = { ok: true; accelerator: string } | { ok: false; message: string }

/**
 * Checks that `accelerator` can be a recording hotkey: a key plus Ctrl, Alt or Win (or a
 * function key), not reserved by Windows and not a shortcut every app uses.
 */
export function validateHotkey(accelerator: unknown): HotkeyCheck {
  const p = parseHotkey(accelerator)
  if (!p) return { ok: false, message: 'That is not a shortcut this app can use.' }
  if (!p.key) return { ok: false, message: 'Add a key to the modifiers (for example Ctrl + Shift + 2).' }
  const normalized = [...p.modifiers, p.key.accel].join('+')
  const label = hotkeyLabel(normalized)
  const command = p.modifiers.some((m) => m !== 'Shift')
  if (!command && !isFunctionKey(p.key)) return { ok: false, message: `${label} would fire while you type: add Ctrl, Alt or Win.` }
  if (RESERVED.has(normalized)) return { ok: false, message: `${label} is reserved by Windows.` }
  const common = COMMON[normalized]
  if (common) return { ok: false, message: `${label} is ${common} in most apps; it would stop working there while you record.` }
  return { ok: true, accelerator: normalized }
}

/** Actions whose hotkey is the same as an earlier action's, with a message for each. */
export function hotkeyConflicts(hotkeys: Hotkeys): Partial<Record<HotkeyAction, string>> {
  const out: Partial<Record<HotkeyAction, string>> = {}
  const seen = new Map<string, HotkeyAction>()
  for (const action of HOTKEY_ACTIONS) {
    const n = normalizeHotkey(hotkeys[action])
    if (!n) continue
    const first = seen.get(n)
    if (first) out[action] = `Already used for ${HOTKEY_NAMES[first]}.`
    else seen.set(n, action)
  }
  return out
}

/**
 * Valid, distinct hotkeys. '' means "no hotkey" for that action (the toolbar still has the
 * button). Anything invalid, or taken by an earlier action, falls back to the default, or to
 * no hotkey when the default is taken too.
 */
export function sanitizeHotkeys(raw: unknown): Hotkeys {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<HotkeyAction, unknown>>
  const out = { ...DEFAULT_HOTKEYS }
  const used = new Set<string>()
  for (const action of HOTKEY_ACTIONS) {
    const v = value[action]
    if (v === '') {
      out[action] = ''
      continue
    }
    const check = validateHotkey(v)
    let wanted = check.ok ? check.accelerator : DEFAULT_HOTKEYS[action]
    if (used.has(wanted)) wanted = DEFAULT_HOTKEYS[action]
    if (used.has(wanted)) wanted = ''
    out[action] = wanted
    if (wanted) used.add(wanted)
  }
  return out
}

export interface KeyComboInput {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/**
 * What a key press on the hotkey field means: the combo so far (only modifiers held), or a
 * complete accelerator. `label` shows it either way ("Ctrl + Shift + …").
 */
export function comboFromKeyEvent(e: KeyComboInput): { accelerator: string | null; label: string } {
  const modifiers: Modifier[] = []
  if (e.ctrlKey) modifiers.push('Ctrl')
  if (e.altKey) modifiers.push('Alt')
  if (e.shiftKey) modifiers.push('Shift')
  if (e.metaKey) modifiers.push('Super')
  const mods = modifiers.map((m) => MODIFIER_LABEL[m])
  const key = MODIFIER_CODES.has(e.code) ? null : (BY_CODE.get(e.code) ?? null)
  if (!key) return { accelerator: null, label: mods.length ? `${mods.join(' + ')} + …` : '' }
  return { accelerator: [...modifiers, key.accel].join('+'), label: [...mods, key.label].join(' + ') }
}
