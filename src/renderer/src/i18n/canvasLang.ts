/**
 * Drawn frames never follow the UI language (docs/design/output-and-languages.md §9.7). A canvas
 * context's `lang` inherits the document's, so in a translated UI caption text would pick its
 * fallback fonts and shaping by the UI language. pinCanvasLanguage wraps getContext once: every
 * canvas gets `lang="en"` when it has none, and every 2D context (an OffscreenCanvas's too)
 * `lang = 'en'` where the property exists, so frames are drawn exactly as in English. bootLanguage
 * installs it in a translated UI only; English installs nothing.
 */

let pinned = false

type GetContext<T> = (this: T, type: string, ...rest: unknown[]) => unknown

/** Sets an English `lang` on a 2D context that has the property. */
function pinContext(type: string, ctx: unknown): void {
  if (type === '2d' && ctx && typeof ctx === 'object' && 'lang' in ctx) (ctx as { lang: string }).lang = 'en'
}

/** Pins every canvas's language to English (once; later calls do nothing). */
export function pinCanvasLanguage(): void {
  if (pinned) return
  pinned = true
  if (typeof HTMLCanvasElement !== 'undefined') {
    const proto = HTMLCanvasElement.prototype as unknown as { getContext: GetContext<HTMLCanvasElement> }
    const original = proto.getContext
    proto.getContext = function getContext(this: HTMLCanvasElement, type: string, ...rest: unknown[]): unknown {
      if (!this.hasAttribute('lang')) this.setAttribute('lang', 'en')
      const ctx = original.call(this, type, ...rest)
      pinContext(type, ctx)
      return ctx
    }
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    const proto = OffscreenCanvas.prototype as unknown as { getContext: GetContext<OffscreenCanvas> }
    const original = proto.getContext
    proto.getContext = function getContext(this: OffscreenCanvas, type: string, ...rest: unknown[]): unknown {
      const ctx = original.call(this, type, ...rest)
      pinContext(type, ctx)
      return ctx
    }
  }
}

/** Whether the pin is installed (tests). */
export const canvasLanguagePinned = (): boolean => pinned
