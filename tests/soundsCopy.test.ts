// The sound finder's words and colours (docs/design/sound-finder.md §5): the sentences, and the
// text colours of its rows passing WCAG AA on the row's background.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SOUND_KIND_ORDER } from '../src/shared/audio/sounds'
import { actionText, foundText, lengthText, listeningText, rowName, showIgnoredText, SOUND_LABELS } from '../src/shared/audio/soundsCopy'

const css = (file: string): string => readFileSync(path.join(__dirname, '..', file), 'utf8')

/** The hex value of `--name` in styles.css (the dark theme the app uses). */
function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css('src/renderer/src/styles.css'))
  if (!m) throw new Error(`no --${name}`)
  return m[1]
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

describe('the sound finder copy', () => {
  it('names every kind and says what happened', () => {
    expect(SOUND_KIND_ORDER.every((k) => SOUND_LABELS[k].length > 0)).toBe(true)
    expect(listeningText(0.424)).toBe('Listening to the recording… 42%')
    expect(listeningText(2)).toBe('Listening to the recording… 100%')
    expect(foundText(3)).toBe('3 found. Nothing changes until you choose.')
    expect(showIgnoredText(2)).toBe('Show ignored (2)')
    expect(lengthText(0.43)).toBe('0.4 s')
    expect(lengthText(0.01)).toBe('0.1 s')
    expect(rowName('ping', 12.4)).toBe('the notification sound at 0:12.4')
    expect(actionText.mute(rowName('cough', 3))).toBe('Muted the cough at 0:03.0')
    expect(actionText.bringBack(rowName('dog', 61))).toBe('The dog at 1:01.0 is back on the list')
    expect(actionText.muteAll(1)).toBe('Muted 1 sound')
    expect(actionText.muteAll(4)).toBe('Muted 4 sounds')
  })

  it('uses text colours that pass AA on the row background', () => {
    const rules = css('src/renderer/src/editor/sounds/sounds.css')
    expect(rules).toMatch(/\.sound-row \{[^}]*background: var\(--surface-2\)/)
    expect(rules).toMatch(/\.sound-time,\s*\.sound-state \{[^}]*color: var\(--text-2\)/)
    expect(contrast(token('text-2'), token('surface-2'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('text-1'), token('surface-2'))).toBeGreaterThanOrEqual(4.5)
    // The progress fill against its track (non-text contrast, 3:1).
    expect(contrast(token('accent-text'), token('surface-sunken'))).toBeGreaterThanOrEqual(3)
  })
})
