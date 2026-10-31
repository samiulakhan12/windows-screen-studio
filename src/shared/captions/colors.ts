/**
 * Colours of Captions Studio (docs/design/captions-studio.md §7): contrast, themes, the brand
 * theme, the contrast fix and speaker colours.
 *
 * CONTRACT (part P1): signatures are frozen; bodies are to be written.
 */
import type { CaptionStudio, StudioTheme } from '../types'

/** The body of a frozen signature part P1 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P1)`)
}

/** The WCAG contrast ratio of two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  return notImplemented('contrastRatio', a, b)
}

/** `color` at `alpha` over `under`, as #rrggbb. */
export function over(color: string, alpha: number, under: string): string {
  return notImplemented('over', color, alpha, under)
}

/** The worst contrast of the look's text against its surround over any video (§7.2). */
export function staticContrast(studio: CaptionStudio): { worst: number; colour: string; against: string } {
  return notImplemented('staticContrast', studio)
}

/** The 10th percentile contrast of the text colour against the pixels under the caption (§7.3). */
export function measuredContrast(studio: CaptionStudio, pixels: Uint8ClampedArray): number {
  return notImplemented('measuredContrast', studio, pixels)
}

/** The look with its outline or box strengthened (§7.3 Fix). */
export function contrastFix(studio: CaptionStudio): CaptionStudio {
  return notImplemented('contrastFix', studio)
}

/** The look with `theme`'s colours and its own geometry (§7.1). */
export function withTheme(studio: CaptionStudio, theme: StudioTheme): CaptionStudio {
  return notImplemented('withTheme', studio, theme)
}

/** The Brand theme from the kit's colours, lightened until they pass (§7.1); null with no usable colour. */
export function brandTheme(colors: readonly string[], studio: CaptionStudio): { theme: StudioTheme; lightened: string[] } | null {
  return notImplemented('brandTheme', colors, studio)
}

/** Text on `background`: whichever of #111111 and #ffffff contrasts more. */
export function textOn(background: string): '#111111' | '#ffffff' {
  return notImplemented('textOn', background)
}

/** A colour for each of `speakers` speakers, skipping those too close to the look's marks (§7.4). */
export function speakerColors(studio: CaptionStudio, speakers: number): string[] {
  return notImplemented('speakerColors', studio, speakers)
}
