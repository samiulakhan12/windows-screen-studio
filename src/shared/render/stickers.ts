/**
 * The built-in stickers: flat vector drawings bundled with the app, so they look the same on
 * every PC (emoji glyphs differ between fonts) and need no file in the project. Each is drawn
 * from a data: URL on a 128 x 128 canvas.
 */

export interface Sticker {
  id: string
  name: string
  /** SVG markup, viewBox 0 0 128 128. */
  svg: string
}

const svg = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 128 128">${body}</svg>`

const FACE = '<circle cx="64" cy="64" r="58" fill="#facc15" stroke="#a16207" stroke-width="5"/>'

export const STICKERS: readonly Sticker[] = [
  {
    id: 'star',
    name: 'Star',
    svg: svg('<path d="M64 8l16.5 35.5 38.5 4.5-28.5 26.5 7.5 38L64 93.5 30 112.5l7.5-38L9 48l38.5-4.5z" fill="#facc15" stroke="#b45309" stroke-width="5" stroke-linejoin="round"/>')
  },
  {
    id: 'heart',
    name: 'Heart',
    svg: svg(
      '<path d="M64 112S12 80 12 44c0-17 13-30 29-30 10 0 18 5 23 13 5-8 13-13 23-13 16 0 29 13 29 30 0 36-52 68-52 68z" fill="#ef4444" stroke="#991b1b" stroke-width="5" stroke-linejoin="round"/>'
    )
  },
  {
    id: 'check',
    name: 'Check',
    svg: svg(
      '<circle cx="64" cy="64" r="58" fill="#22c55e" stroke="#166534" stroke-width="5"/><path d="M36 66l18 18 38-40" fill="none" stroke="#fff" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>'
    )
  },
  {
    id: 'cross',
    name: 'Cross',
    svg: svg('<circle cx="64" cy="64" r="58" fill="#ef4444" stroke="#991b1b" stroke-width="5"/><path d="M42 42l44 44M86 42L42 86" stroke="#fff" stroke-width="13" stroke-linecap="round"/>')
  },
  {
    id: 'thumbs-up',
    name: 'Thumbs up',
    svg: svg(
      '<rect x="14" y="58" width="22" height="54" rx="5" fill="#2563eb" stroke="#1e3a8a" stroke-width="5"/><path d="M44 60l20-42c10 0 15 7 13 18l-4 18h31c8 0 13 7 11 14l-9 38c-2 6-6 8-12 8H44z" fill="#fbbf24" stroke="#92400e" stroke-width="5" stroke-linejoin="round"/>'
    )
  },
  {
    id: 'smile',
    name: 'Smile',
    svg: svg(
      `${FACE}<circle cx="44" cy="52" r="7" fill="#422006"/><circle cx="84" cy="52" r="7" fill="#422006"/><path d="M38 76c14 20 38 20 52 0" fill="none" stroke="#422006" stroke-width="7" stroke-linecap="round"/>`
    )
  },
  { id: 'wow', name: 'Wow', svg: svg(`${FACE}<circle cx="44" cy="50" r="8" fill="#422006"/><circle cx="84" cy="50" r="8" fill="#422006"/><ellipse cx="64" cy="86" rx="12" ry="16" fill="#422006"/>`) },
  {
    id: 'fire',
    name: 'Fire',
    svg: svg(
      '<path d="M64 8c6 22 34 34 34 66 0 22-16 42-34 42S30 96 30 74c0-16 8-24 14-30 0 10 4 18 10 20-2-24 4-40 10-56z" fill="#f97316" stroke="#9a3412" stroke-width="5" stroke-linejoin="round"/><path d="M64 64c4 12 16 16 16 30 0 10-7 16-16 16s-16-6-16-16c0-12 12-16 16-30z" fill="#fde047"/>'
    )
  },
  {
    id: 'bulb',
    name: 'Light bulb',
    svg: svg(
      '<path d="M64 10c-24 0-40 18-40 38 0 16 10 24 16 34 3 5 4 10 4 14h40c0-4 1-9 4-14 6-10 16-18 16-34 0-20-16-38-40-38z" fill="#fde047" stroke="#a16207" stroke-width="5" stroke-linejoin="round"/><rect x="44" y="100" width="40" height="18" rx="6" fill="#94a3b8" stroke="#475569" stroke-width="5"/>'
    )
  },
  {
    id: 'warning',
    name: 'Warning',
    svg: svg(
      '<path d="M64 10l58 104H6z" fill="#facc15" stroke="#a16207" stroke-width="6" stroke-linejoin="round"/><path d="M64 46v32" stroke="#422006" stroke-width="12" stroke-linecap="round"/><circle cx="64" cy="96" r="7" fill="#422006"/>'
    )
  },
  {
    id: 'sparkles',
    name: 'Sparkles',
    svg: svg(
      '<path d="M52 12l9 29 29 9-29 9-9 29-9-29-29-9 29-9z" fill="#a78bfa" stroke="#5b21b6" stroke-width="4" stroke-linejoin="round"/><path d="M96 66l6 18 18 6-18 6-6 18-6-18-18-6 18-6z" fill="#facc15" stroke="#a16207" stroke-width="4" stroke-linejoin="round"/>'
    )
  },
  {
    id: 'new',
    name: 'New badge',
    svg: svg(
      '<path d="M64 6l13 12 17-4 5 17 17 5-4 17 12 13-12 13 4 17-17 5-5 17-17-4-13 12-13-12-17 4-5-17-17-5 4-17L6 64l12-13-4-17 17-5 5-17 17 4z" fill="#ec4899" stroke="#9d174d" stroke-width="4" stroke-linejoin="round"/><path d="M30 80V48l16 32V48M72 48H58v32h14M58 64h11M78 48l5 32 7-20 7 20 5-32" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>'
    )
  }
]

export const isSticker = (id: unknown): id is string => typeof id === 'string' && STICKERS.some((s) => s.id === id)

export const stickerOf = (id: string): Sticker | null => STICKERS.find((s) => s.id === id) ?? null

/** The sticker as a data: URL (img-src allows data:). */
export const stickerUrl = (s: Sticker): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s.svg)}`
