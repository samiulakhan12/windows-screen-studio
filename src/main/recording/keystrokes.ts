/**
 * Turns global key events (libuiohook key codes) into keystroke-overlay labels such
 * as "Ctrl + Shift + S". Only shortcut-style keystrokes are kept: combinations with
 * Ctrl, Alt or Win held, or special keys on their own. Plain typing, including
 * Shift + letter and AltGr characters, is never recorded.
 */

const LETTERS: Record<number, string> = {
  30: 'A', 48: 'B', 46: 'C', 32: 'D', 18: 'E', 33: 'F', 34: 'G', 35: 'H', 23: 'I', 36: 'J', 37: 'K', 38: 'L', 50: 'M',
  49: 'N', 24: 'O', 25: 'P', 16: 'Q', 19: 'R', 31: 'S', 20: 'T', 22: 'U', 47: 'V', 17: 'W', 45: 'X', 21: 'Y', 44: 'Z'
}

const CHARACTERS: Record<number, string> = {
  ...LETTERS,
  11: '0', 2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9',
  39: ';', 13: '=', 51: ',', 12: '-', 52: '.', 53: '/', 41: '`', 26: '[', 43: '\\', 27: ']', 40: "'",
  82: 'Num 0', 79: 'Num 1', 80: 'Num 2', 81: 'Num 3', 75: 'Num 4', 76: 'Num 5', 77: 'Num 6', 71: 'Num 7', 72: 'Num 8',
  73: 'Num 9', 55: 'Num *', 78: 'Num +', 74: 'Num -', 83: 'Num .', 3637: 'Num /',
  57: 'Space', 3666: 'Insert'
}

/** Keys worth showing even without a modifier. */
const SPECIAL: Record<number, string> = {
  1: 'Esc', 14: 'Backspace', 15: 'Tab', 28: 'Enter', 3612: 'Enter', 3667: 'Delete',
  3655: 'Home', 3663: 'End', 3657: 'Page Up', 3665: 'Page Down',
  57416: '↑', 57424: '↓', 57419: '←', 57421: '→',
  59: 'F1', 60: 'F2', 61: 'F3', 62: 'F4', 63: 'F5', 64: 'F6', 65: 'F7', 66: 'F8', 67: 'F9', 68: 'F10', 87: 'F11', 88: 'F12'
}

const MODIFIERS = new Set([29, 3613, 56, 3640, 42, 54, 3675, 3676, 58, 69, 70])
const LEFT_CTRL = 29
/** Right Alt; it is AltGr only on layouts that have one (see KeystrokeFilter). */
const ALT_GR = 3640

/** The event flag that is set while each modifier key is down. */
const MODIFIER_FLAG: Partial<Record<number, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>> = {
  29: 'ctrlKey',
  3613: 'ctrlKey',
  56: 'altKey',
  3640: 'altKey',
  42: 'shiftKey',
  54: 'shiftKey',
  3675: 'metaKey',
  3676: 'metaKey'
}

/**
 * Longest gap between auto-repeated keydowns of a held key. Windows' longest initial
 * repeat delay is 1 s and repeats then come at least every ~400 ms, so a keydown later
 * than this is a new press whose keyup the hook missed (secure desktop, Win+L, UAC).
 */
export const REPEAT_WINDOW_MS = 1100

/** Windows sends a fake left Ctrl together with Right Alt on AltGr layouts (same timestamp). */
const ALT_GR_PAIR_MS = 50

export interface KeyInput {
  keycode: number
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** Label for one key press, or null when it is typing (or not a key we show). */
export function shortcutLabel(e: KeyInput, altGrDown = false): string | null {
  if (MODIFIERS.has(e.keycode)) return null
  const special = SPECIAL[e.keycode]
  const character = CHARACTERS[e.keycode]
  if (!special && !character) return null
  const command = e.ctrlKey || e.altKey || e.metaKey
  // AltGr reports Ctrl+Alt on Windows; what it produces is a typed character.
  if (altGrDown && !special) return null
  if (!special && !command) return null
  const parts: string[] = []
  if (e.ctrlKey && !altGrDown) parts.push('Ctrl')
  if (e.altKey && !altGrDown) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Win')
  parts.push(special ?? character)
  return parts.join(' + ')
}

/**
 * Tracks held keys so auto-repeat produces one label per physical press.
 *
 * A key whose keyup the hook never saw (it happened on the secure desktop: Win+L,
 * Ctrl+Alt+Del, UAC) must not stay "held" forever, or its later presses would all be
 * taken for auto-repeat. So a held key expires after REPEAT_WINDOW_MS without a
 * repeat, a held modifier whose flag is off in a later event is dropped, pressing
 * another non-modifier key releases the previous one (Windows stops repeating it), and
 * reset() forgets everything (on pause).
 *
 * Right Alt counts as AltGr only when Windows reports it as AltGr: together with a fake
 * left Ctrl pressed at the same instant. On layouts without AltGr (US, UK) it is Alt.
 */
export class KeystrokeFilter {
  /** Keys currently down → time (ms) of their last keydown. */
  private held = new Map<number, number>()
  private ctrlDownAt: number | null = null
  private altGr = false

  constructor(private readonly ignore: ReadonlySet<string> = new Set()) {}

  /** `at`: event time in ms (the hook's own clock; any monotonic ms clock works). */
  keydown(e: KeyInput, at: number = Date.now()): string | null {
    this.dropReleasedModifiers(e)
    const last = this.held.get(e.keycode)
    this.held.set(e.keycode, at)
    if (last !== undefined && at >= last && at - last <= REPEAT_WINDOW_MS) return null
    if (e.keycode === LEFT_CTRL) this.ctrlDownAt = at
    if (e.keycode === ALT_GR) {
      this.altGr = e.ctrlKey && this.held.has(LEFT_CTRL) && this.ctrlDownAt !== null && Math.abs(at - this.ctrlDownAt) <= ALT_GR_PAIR_MS
    }
    if (!MODIFIERS.has(e.keycode)) {
      for (const k of [...this.held.keys()]) if (k !== e.keycode && !MODIFIERS.has(k)) this.held.delete(k)
    }
    const label = shortcutLabel(e, this.altGr && this.held.has(ALT_GR))
    return label && !this.ignore.has(label) ? label : null
  }

  keyup(e: Pick<KeyInput, 'keycode'>): void {
    this.release(e.keycode)
  }

  /** Forgets every held key (recording paused, or input may have been missed). */
  reset(): void {
    this.held.clear()
    this.ctrlDownAt = null
    this.altGr = false
  }

  private release(keycode: number): void {
    this.held.delete(keycode)
    if (keycode === ALT_GR) this.altGr = false
    if (keycode === LEFT_CTRL) this.ctrlDownAt = null
  }

  /** A held modifier whose flag is off in this event was released without a keyup we saw. */
  private dropReleasedModifiers(e: KeyInput): void {
    for (const k of [...this.held.keys()]) {
      const flag = MODIFIER_FLAG[k]
      if (flag && k !== e.keycode && !e[flag]) this.release(k)
    }
  }
}
