/**
 * Fonts per word (docs/design/captions-studio.md §6.5, §6.6): the face a word draws with, the
 * fallback chain, weights clamped to what a font has, partners for missing letters, and the
 * per-script rules.
 *
 * CONTRACT (part P1): signatures are frozen; bodies are to be written.
 */
import type { CaptionStudio, ProjectFont } from '../types'
import type { StudioFace } from './studioLayout'
import type { ScriptTag } from './words'

/** The body of a frozen signature part P1 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P1)`)
}

/** The face a word of `script` draws with: the font drawing that script first, the weight clamped against it (§6.5). */
export function wordFace(
  studio: CaptionStudio,
  role: 'text' | 'emphasis',
  script: ScriptTag,
  ctx: { language?: string; scripts: Set<ScriptTag>; fonts?: readonly ProjectFont[]; downloaded: (id: string) => boolean }
): StudioFace {
  return notImplemented('wordFace', studio, role, script, ctx)
}

/** The font stack of §6.6 for the look's text or emphasis. */
export function studioFontStack(
  studio: CaptionStudio,
  role: 'text' | 'emphasis',
  ctx: { language?: string; scripts: Set<ScriptTag>; main: { script: ScriptTag; share: number }; fonts?: readonly ProjectFont[]; downloaded: (id: string) => boolean }
): string {
  return notImplemented('studioFontStack', studio, role, ctx)
}

/** `weight` clamped to the weights `font` has ('cat:<id>'): the nearest file, or the range (§6.5). */
export function clampWeight(font: string, weight: number): number {
  return notImplemented('clampWeight', font, weight)
}

/** The coverage a caption needs beyond Latin (§6.6: vi Vietnamese, ru and uk Cyrillic, …). */
export function coverageNeeded(language: string | undefined, text: string): string[] {
  return notImplemented('coverageNeeded', language, text)
}

/** The look's font, or its partner when it lacks what `needs` asks for (§6.6). */
export function partnerFor(font: string, needs: string[]): string {
  return notImplemented('partnerFor', font, needs)
}

/** The line height raised for a script (§6.6: Arabic 1.5, Bangla 1.4, Thai 1.45). */
export function scriptLineHeight(script: ScriptTag, lineHeight: number): number {
  return notImplemented('scriptLineHeight', script, lineHeight)
}

/** The letter spacing for a script (0 in joined scripts, §6.6). */
export function trackingFor(script: ScriptTag, tracking: number): number {
  return notImplemented('trackingFor', script, tracking)
}
