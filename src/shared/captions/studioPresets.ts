/**
 * The Captions Studio gallery (docs/design/captions-studio.md §5 and the owner's approved looks
 * of §0.1, §0.2): the 30 built-in looks, the five legacy tiles, the themes, gradients, speaker
 * palette and line lengths. Pure data: every parameter that draws is in the look, so tuning a look
 * here in a later release never changes a project that already uses it (it holds a copy).
 *
 * Units are those of §5.1: sizes are fractions of the output's shorter side (u) in frames that
 * are not tall, multiplied by `tall` in tall frames; outline, shadow, padding, radius and glow are
 * in em. Every look passes the static contrast rule of §7.2 with its own theme
 * (tests/studioContracts.test.ts checks it); where an approved mock-up colour failed it, the look
 * says what was darkened.
 */
import type {
  CaptionMotion,
  CaptionPreset,
  CaptionStudio,
  StudioBox,
  StudioEdge,
  StudioEmphasis,
  StudioLayout,
  StudioText,
  StudioTheme,
  SpokenMark
} from '../types'

/** A built-in gallery tile. */
export interface StudioPreset {
  /** The tile id, stored as CaptionStudio.from. */
  id: string
  name: string
  /** *Long videos* or *Short clips* (§2.5 filters). */
  group: 'long' | 'short'
  /** The tile's title and the end of its accessible name (§2.5). */
  description: string
  /** The legacy look written to `captions.preset` for older builds (§4.5, §5.8). */
  fallback: CaptionPreset
  look: CaptionStudio
}

/** A look the user saved (prefs `captionPresets`, §4.6, §5.7): ids `^[a-z0-9]{1,16}$`, names at most 40 characters, at most 50. */
export interface SavedLook {
  id: string
  name: string
  look: CaptionStudio
}

/** A legacy tile (§5.2): drawn by today's code, under the *Classic* filter. */
export interface LegacyTile {
  preset: CaptionPreset
  name: string
  description: string
}

/* ---------- building a look from the values of §5 ---------- */

/** Unless a look says otherwise (§5.1): no box, but these values when one is turned on. */
export const BOX_DEFAULT: Readonly<StudioBox> = { kind: 'none', alpha: 0.75, padX: 0.42, padY: 0.12, radius: 0.32, border: 0 }

interface LookSpec {
  text: StudioText
  /** Absent fields: the text's font, 200 heavier (clamped when drawn), size ×1, no mark. */
  emphasis?: Partial<StudioEmphasis>
  /** Absent: outline and shadow #000000, box #0a0a10, glow the spoken colour. */
  theme: Pick<StudioTheme, 'text' | 'spoken' | 'emphasis'> & Partial<StudioTheme>
  edge?: Partial<StudioEdge>
  box?: Partial<StudioBox>
  spoken: SpokenMark
  layout: Pick<StudioLayout, 'chunk' | 'lines' | 'chars' | 'tallChars' | 'position'> & Partial<StudioLayout>
  motion: Pick<CaptionMotion, 'enter' | 'exit' | 'word' | 'emphasis' | 'upcoming'> & Partial<CaptionMotion>
}

/** A complete look from the values of §5, with the defaults of §5.1 for the rest. */
function look(from: string, s: LookSpec): CaptionStudio {
  const { font, ...emphasis } = s.emphasis ?? {}
  return {
    from,
    text: s.text,
    emphasis: { ...(font ? { font } : {}), weight: Math.min(1000, s.text.weight + 200), scale: 1, mark: 'none', ...emphasis },
    theme: { outline: '#000000', shadow: '#000000', box: '#0a0a10', glow: s.theme.spoken, ...s.theme },
    edge: { outline: 0, outlineAlpha: 1, glow: 0, ...s.edge },
    box: { ...BOX_DEFAULT, ...s.box },
    spoken: s.spoken,
    layout: { words: 3, avoid: true, ...s.layout },
    motion: { strength: 1, speed: 1, tilt: 0, tiltOn: 'chunk', ...s.motion }
  }
}

const cat = (id: string): string => `cat:${id}`
/** The look's Bangla font (§0.2). */
const bengali = (id: string, weight: number, width?: number): StudioText['scripts'] => ({ bengali: { font: cat(id), weight, ...(width ? { width } : {}) } })

/* ---------- §5.3 Long videos and tutorials ---------- */

/** Subtitle: the look every reader falls back to (§4.2 rule 2). */
const SUBTITLE = look('subtitle', {
  text: { font: cat('inter-tight'), weight: 600, case: 'asis', tracking: 0, lineHeight: 1.28, size: 0.05, tall: 1.07, scripts: bengali('hind-siliguri', 600) },
  emphasis: { weight: 800 },
  theme: { text: '#ffffff', spoken: '#ffe14d', emphasis: '#ffffff' },
  edge: { outline: 0.05, outlineAlpha: 0.82, shadow: { x: 0, y: 0.05, blur: 0.3, alpha: 0.7 } },
  spoken: 'none',
  layout: { chunk: 'phrase', lines: 2, chars: 42, tallChars: 26, position: 'bottom' },
  motion: { enter: 'fade', exit: 'fade', word: 'none', emphasis: 'none', upcoming: 1 }
})

/** The look readers fall back to, field by field (§4.2 rule 2): Subtitle. */
export const STUDIO_BASE: Readonly<CaptionStudio> = SUBTITLE

const LONG: StudioPreset[] = [
  { id: 'subtitle', name: 'Subtitle', group: 'long', description: 'Clean two-line subtitles in a crisp font', fallback: 'clean', look: SUBTITLE },
  {
    id: 'karaoke-fill',
    name: 'Karaoke Fill',
    group: 'long',
    description: 'Each word fills with colour as it is spoken',
    fallback: 'karaoke',
    look: look('karaoke-fill', {
      text: { font: cat('inter-tight'), weight: 700, case: 'asis', tracking: 0, lineHeight: 1.25, size: 0.052, tall: 1.23, scripts: bengali('hind-siliguri', 700) },
      emphasis: { weight: 800 },
      theme: { text: '#ffffff', spoken: '#ffe14d', emphasis: '#ffe14d' },
      edge: { outline: 0.06, outlineAlpha: 0.85, shadow: { x: 0, y: 0.04, blur: 0.15, alpha: 0.5 } },
      spoken: 'fill',
      layout: { chunk: 'phrase', lines: 2, chars: 32, tallChars: 22, position: 'bottom' },
      motion: { enter: 'fade', exit: 'fade', word: 'none', emphasis: 'pulse', upcoming: 1 }
    })
  },
  {
    id: 'glass',
    name: 'Glass Pill',
    group: 'long',
    description: 'Frosted glass behind each line',
    fallback: 'boxed',
    // Words not yet spoken at 0.8 (§5.3 has 0.78, which is 4.50:1 on the tint over white; 0.8 gives 4.63:1).
    look: look('glass', {
      text: { font: cat('inter-tight'), weight: 600, case: 'asis', tracking: 0, lineHeight: 1.25, size: 0.05, tall: 1.21, scripts: bengali('hind-siliguri', 600) },
      emphasis: { weight: 700 },
      theme: { text: '#ffffff', spoken: '#ffe14d', emphasis: '#ffe14d', box: '#0c0c12' },
      box: { kind: 'glass', alpha: 0.65, padX: 0.6, padY: 0.22, radius: 2, border: 0.02 },
      spoken: 'color',
      layout: { chunk: 'phrase', lines: 2, chars: 36, tallChars: 24, position: 'bottom' },
      motion: { enter: 'grow', exit: 'shrink', word: 'none', emphasis: 'none', upcoming: 0.8 }
    })
  },
  {
    id: 'highlighter',
    name: 'Highlighter',
    group: 'long',
    description: 'Key words marked like a highlighter pen',
    fallback: 'clean',
    look: look('highlighter', {
      text: { font: cat('inter-tight'), weight: 700, case: 'asis', tracking: 0, lineHeight: 1.25, size: 0.052, tall: 1.23, scripts: bengali('noto-sans-bengali', 700) },
      emphasis: { weight: 700, mark: 'marker' },
      theme: { text: '#ffffff', spoken: '#ffe14d', emphasis: '#ffe45c', emphasisText: '#111111' },
      edge: { outline: 0.06, outlineAlpha: 0.85, shadow: { x: 0, y: 0.04, blur: 0.15, alpha: 0.5 } },
      spoken: 'none',
      layout: { chunk: 'phrase', lines: 2, chars: 32, tallChars: 22, position: 'bottom' },
      motion: { enter: 'fade', exit: 'fade', word: 'none', emphasis: 'wipe', upcoming: 1 }
    })
  },
  {
    id: 'editorial',
    name: 'Editorial',
    group: 'long',
    description: 'Calm text with key words in a large serif',
    fallback: 'boxed',
    look: look('editorial', {
      text: { font: cat('inter-tight'), weight: 500, case: 'asis', tracking: 0, lineHeight: 1.2, size: 0.06, tall: 1.19, scripts: bengali('noto-serif-bengali', 700) },
      emphasis: { font: cat('instrument-serif-italic'), weight: 400, scale: 1.6 },
      theme: { text: '#f5f0d0', spoken: '#ffffff', emphasis: '#ffffff', box: '#0a0a10' },
      edge: { shadow: { x: 0, y: 0.03, blur: 0.2, alpha: 0.6 } },
      box: { kind: 'chunk', alpha: 0.65, padX: 0.35, padY: 0.2, radius: 0.2 },
      spoken: 'none',
      layout: { chunk: 'phrase', lines: 2, chars: 32, tallChars: 22, position: 'lower' },
      motion: { enter: 'fade', exit: 'fade', word: 'none', emphasis: 'grow', upcoming: 1 }
    })
  },
  {
    id: 'typewriter',
    name: 'Typewriter',
    group: 'long',
    description: 'Letters type on as each word is spoken',
    fallback: 'boxed',
    look: look('typewriter', {
      text: { font: cat('jetbrains-mono'), weight: 500, case: 'asis', tracking: 0, lineHeight: 1.3, size: 0.048, tall: 1.26, scripts: bengali('noto-sans-bengali', 500) },
      emphasis: { weight: 700 },
      theme: { text: '#ffffff', spoken: '#ffe14d', emphasis: '#ffe14d', box: '#000000' },
      box: { kind: 'line', alpha: 0.62, padX: 0.45, padY: 0.25, radius: 0.08 },
      spoken: 'none',
      layout: { chunk: 'phrase', lines: 2, chars: 34, tallChars: 24, position: 'bottom' },
      motion: { enter: 'none', exit: 'fade', word: 'typewriter', emphasis: 'typewriter', upcoming: 0 }
    })
  },
  {
    id: 'terminal',
    name: 'Terminal',
    group: 'long',
    description: 'Code-editor colours on a dark panel',
    fallback: 'boxed',
    // "In fade (0.2 s)": speed 0.6 stretches the 0.12 s fade to 0.2 s.
    look: look('terminal', {
      text: { font: cat('jetbrains-mono'), weight: 500, case: 'asis', tracking: 0, lineHeight: 1.3, size: 0.042, tall: 1.27, scripts: bengali('noto-sans-bengali', 500) },
      emphasis: { weight: 700, mark: 'box' },
      theme: { text: '#d4d4d4', upcoming: '#9a9a9a', spoken: '#569cd6', emphasis: '#1e3a8a', emphasisText: '#ffffff', box: '#1e1e1e' },
      box: { kind: 'line', alpha: 0.94, padX: 0.5, padY: 0.25, radius: 0.12 },
      spoken: 'color',
      layout: { chunk: 'phrase', lines: 2, chars: 40, tallChars: 28, position: 'bottom' },
      motion: { enter: 'fade', exit: 'fade', word: 'none', emphasis: 'none', upcoming: 1, speed: 0.6 }
    })
  },
  {
    id: 'news',
    name: 'News Bar',
    group: 'long',
    description: 'Capitals on a red band, like a news ticker',
    fallback: 'boxed',
    look: look('news', {
      text: { font: cat('oswald'), weight: 600, case: 'upper', tracking: 0.01, lineHeight: 1.1, size: 0.046, tall: 1.08, scripts: bengali('hind-siliguri', 600) },
      emphasis: { weight: 700, mark: 'underline' },
      theme: { text: '#ffffff', spoken: '#ffe14d', emphasis: '#ffffff', box: '#c8102e' },
      box: { kind: 'band', alpha: 1, padX: 0.5, padY: 0.5, radius: 0 },
      spoken: 'none',
      layout: { chunk: 'phrase', lines: 1, chars: 60, tallChars: 30, position: 'bottom' },
      motion: { enter: 'wipe', exit: 'rise', word: 'none', emphasis: 'none', upcoming: 1 }
    })
  }
]

/* ---------- §5.4 Short clips ---------- */

const SHORT: StudioPreset[] = [
  {
    id: 'bold-pop',
    name: 'Bold Pop',
    group: 'short',
    description: 'Big capitals, three words at a time; the spoken word turns green',
    fallback: 'bold',
    look: look('bold-pop', {
      text: { font: cat('montserrat'), weight: 900, case: 'upper', tracking: 0, lineHeight: 1.05, size: 0.085, tall: 1.26, scripts: bengali('baloo-da-2', 800) },
      emphasis: { weight: 900, scale: 1.15 },
      theme: { text: '#ffffff', spoken: '#39e508', emphasis: '#ffe14d', emphasis2: '#ff6ad5' },
      edge: { outline: 0.085, outlineAlpha: 1, shadow: { x: 0, y: 0.04, blur: 0.12, alpha: 0.55 } },
      spoken: 'color',
      layout: { chunk: 'words', words: 3, lines: 1, chars: 16, tallChars: 14, position: 'lower' },
      motion: { enter: 'pop', exit: 'fade', word: 'pulse', emphasis: 'pop', upcoming: 1, tilt: 3, tiltOn: 'emphasis', spokenScale: 1.18 }
    })
  },
  {
    id: 'clean-short',
    name: 'Clean Short',
    group: 'short',
    description: 'Calm sentence-case words with a soft shadow',
    fallback: 'clean',
    look: look('clean-short', {
      text: { font: cat('outfit'), weight: 700, case: 'asis', tracking: 0, lineHeight: 1.15, size: 0.062, tall: 1.15, scripts: bengali('noto-sans-bengali', 700) },
      emphasis: { weight: 800 },
      theme: { text: '#ffffff', spoken: '#ffd166', emphasis: '#ffd166' },
      edge: { outline: 0.04, outlineAlpha: 0.85, shadow: { x: 0, y: 0.05, blur: 0.25, alpha: 0.6 } },
      spoken: 'color',
      layout: { chunk: 'words', words: 3, lines: 2, chars: 18, tallChars: 16, position: 'lower' },
      motion: { enter: 'rise', exit: 'fade', word: 'none', emphasis: 'pulse', upcoming: 1 }
    })
  },
  {
    id: 'text-box',
    name: 'Text Box',
    group: 'short',
    description: "Dark words on white boxes, like phone apps' own text",
    fallback: 'boxed',
    // The soft shadow lifts the boxes off white video, so it is the boxes' (StudioBox.shadow), not the text's.
    look: look('text-box', {
      text: { font: cat('poppins'), weight: 600, case: 'asis', tracking: 0, lineHeight: 1.3, size: 0.05, tall: 1.2, scripts: bengali('noto-sans-bengali', 600) },
      emphasis: { weight: 700 },
      theme: { text: '#111111', spoken: '#111111', emphasis: '#c8102e', box: '#ffffff' },
      box: { kind: 'line', alpha: 1, padX: 0.35, padY: 0.16, radius: 0.25, gap: 0.06, shadow: { x: 0, y: 0.02, blur: 0.08, alpha: 0.25 } },
      spoken: 'none',
      layout: { chunk: 'words', words: 6, lines: 2, chars: 24, tallChars: 20, position: 'lower' },
      motion: { enter: 'pop', exit: 'fade', word: 'none', emphasis: 'none', upcoming: 1, strength: 0.5 }
    })
  },
  {
    id: 'weight-shift',
    name: 'Light to Bold',
    group: 'short',
    description: 'Lowercase words turn bold as they are spoken',
    fallback: 'minimal',
    look: look('weight-shift', {
      text: { font: cat('montserrat'), weight: 400, case: 'lower', tracking: -0.03, lineHeight: 1.2, size: 0.067, tall: 1.11, spokenWeight: 700, scripts: bengali('noto-sans-bengali', 400) },
      emphasis: { weight: 800 },
      theme: { text: '#ffffff', spoken: '#ffffff', emphasis: '#ffe14d' },
      edge: { outline: 0.04, outlineAlpha: 0.7, shadow: { x: 0, y: 0.03, blur: 0.14, alpha: 0.65 } },
      spoken: 'weight',
      layout: { chunk: 'words', words: 4, lines: 2, chars: 24, tallChars: 18, position: 'lower' },
      motion: { enter: 'grow', exit: 'fade', word: 'none', emphasis: 'pulse', upcoming: 1 }
    })
  },
  {
    id: 'one-word',
    name: 'One Word',
    group: 'short',
    description: 'One big word at a time',
    fallback: 'bold',
    look: look('one-word', {
      text: { font: cat('anton'), weight: 400, case: 'upper', tracking: 0.04, lineHeight: 1, size: 0.14, tall: 1.1, scripts: bengali('noto-sans-bengali', 800) },
      theme: { text: '#ffffff', spoken: '#ffd700', emphasis: '#ffd700' },
      edge: { outline: 0.04, outlineAlpha: 0.9, shadow: { x: 0, y: 0.03, blur: 0.18, alpha: 0.6 } },
      spoken: 'none',
      layout: { chunk: 'word', words: 1, lines: 1, chars: 0, tallChars: 0, position: 'middle', fit: 0.8 },
      motion: { enter: 'slam', exit: 'fade', word: 'none', emphasis: 'none', upcoming: 1 }
    })
  },
  {
    id: 'comic',
    name: 'Comic',
    group: 'short',
    description: 'Comic-book capitals with a thick outline',
    fallback: 'bold',
    look: look('comic', {
      text: { font: cat('bangers'), weight: 400, case: 'upper', tracking: 0.02, lineHeight: 1, size: 0.08, tall: 1.22, scripts: bengali('atma', 700) },
      emphasis: { scale: 1.25 },
      theme: { text: '#ffffff', spoken: '#ffd700', emphasis: '#39e508', emphasis2: '#4dd2ff' },
      edge: { outline: 0.11, outlineAlpha: 1, shadow: { x: 0.06, y: 0.08, blur: 0, alpha: 1 } },
      spoken: 'color',
      layout: { chunk: 'words', words: 3, lines: 2, chars: 15, tallChars: 13, position: 'lower' },
      motion: { enter: 'pop', exit: 'fade', word: 'pulse', emphasis: 'pop', upcoming: 1, tilt: 4, tiltOn: 'chunk' }
    })
  },
  {
    id: 'stacked',
    name: 'Stacked',
    group: 'short',
    description: 'Lines of different sizes stacked together',
    fallback: 'bold',
    look: look('stacked', {
      text: { font: cat('anton'), weight: 400, case: 'upper', tracking: 0.01, lineHeight: 0.88, size: 0.07, tall: 1.27, scripts: bengali('anek-bangla', 800, 75) },
      theme: { text: '#ffffff', spoken: '#ffe14d', emphasis: '#ffe14d' },
      edge: { outline: 0.04, outlineAlpha: 0.7, shadow: { x: 0, y: 0.03, blur: 0.15, alpha: 0.6 } },
      spoken: 'none',
      layout: { chunk: 'stack', words: 6, lines: 4, chars: 0, tallChars: 0, position: 'middle', fit: 0.7 },
      motion: { enter: 'rise', exit: 'shrink', word: 'none', emphasis: 'none', upcoming: 1 }
    })
  },
  {
    id: 'highlight-box',
    name: 'Highlight Box',
    group: 'short',
    description: 'The spoken word on a red box',
    fallback: 'karaoke',
    look: look('highlight-box', {
      text: { font: cat('montserrat'), weight: 800, case: 'upper', tracking: 0.02, lineHeight: 1.1, size: 0.074, tall: 1.08, scripts: bengali('noto-sans-bengali', 700) },
      emphasis: { weight: 900, mark: 'box' },
      theme: { text: '#ffffff', spoken: '#e0102f', spokenText: '#ffffff', emphasis: '#ffe14d', emphasisText: '#111111' },
      edge: { outline: 0.04, outlineAlpha: 0.6, shadow: { x: 0, y: 0.075, blur: 0.225, alpha: 0.45 } },
      spoken: 'box',
      layout: { chunk: 'words', words: 3, lines: 2, chars: 18, tallChars: 16, position: 'lower' },
      motion: { enter: 'pop', exit: 'fade', word: 'none', emphasis: 'pulse', upcoming: 1 }
    })
  },
  {
    id: 'neon',
    name: 'Neon',
    group: 'short',
    description: 'The spoken word glows cyan',
    fallback: 'bold',
    look: look('neon', {
      text: { font: cat('outfit'), weight: 800, case: 'upper', tracking: 0.04, lineHeight: 1.15, size: 0.08, tall: 1.11, scripts: bengali('mina', 700) },
      emphasis: { weight: 900 },
      theme: { text: '#ffffff', spoken: '#00fff0', emphasis: '#ff0099', glow: '#00fff0' },
      edge: { outline: 0.04, outlineAlpha: 1, glow: 0.94 },
      spoken: 'glow',
      layout: { chunk: 'words', words: 3, lines: 2, chars: 16, tallChars: 14, position: 'lower' },
      motion: { enter: 'fade', exit: 'fade', word: 'none', emphasis: 'pulse', upcoming: 0.92 }
    })
  },
  {
    id: 'outline',
    name: 'Outline',
    group: 'short',
    description: 'Hollow letters that fill as they are spoken',
    fallback: 'bold',
    // The shadow is the dark halo of hollow words (0, 0, 0.10) α 0.6.
    look: look('outline', {
      text: { font: cat('montserrat'), weight: 900, case: 'upper', tracking: 0.02, lineHeight: 1.05, size: 0.085, tall: 1.21, scripts: bengali('noto-sans-bengali', 800) },
      emphasis: { weight: 900 },
      theme: { text: '#ffffff', spoken: '#ffffff', emphasis: '#ffe14d' },
      edge: { outline: 0.04, outlineAlpha: 1, hollow: true, shadow: { x: 0, y: 0, blur: 0.1, alpha: 0.6 } },
      spoken: 'fill',
      layout: { chunk: 'words', words: 3, lines: 1, chars: 14, tallChars: 12, position: 'lower' },
      motion: { enter: 'pop', exit: 'fade', word: 'pulse', emphasis: 'pop', upcoming: 1 }
    })
  },
  {
    id: 'handwritten',
    name: 'Handwritten',
    group: 'short',
    description: 'Handwriting that writes itself on',
    fallback: 'clean',
    look: look('handwritten', {
      text: { font: cat('caveat'), weight: 700, case: 'asis', tracking: 0, lineHeight: 1.15, size: 0.065, tall: 1.26, scripts: bengali('galada', 400) },
      emphasis: { weight: 700, mark: 'underline' },
      theme: { text: '#ffffff', spoken: '#ffe14d', emphasis: '#ffe14d' },
      edge: { outline: 0.05, outlineAlpha: 0.7, shadow: { x: 0.02, y: 0.04, blur: 0.1, alpha: 0.5 } },
      spoken: 'none',
      layout: { chunk: 'words', words: 4, lines: 2, chars: 22, tallChars: 18, position: 'lower' },
      motion: { enter: 'fade', exit: 'fade', word: 'wipe', emphasis: 'wipe', upcoming: 0, tilt: 2, tiltOn: 'chunk' }
    })
  }
]

/* ---------- §0.1 Eleven more looks the owner approved ---------- */

const MORE_LONG: StudioPreset[] = [
  {
    id: 'bubble-speech',
    name: 'Speech Bubble',
    group: 'long',
    description: 'A speech bubble that points at your camera',
    fallback: 'boxed',
    look: look('bubble-speech', {
      text: { font: cat('inter-tight'), weight: 700, case: 'asis', tracking: 0, lineHeight: 1.3, size: 0.045, tall: 1.2, scripts: bengali('noto-sans-bengali', 700) },
      emphasis: { weight: 800 },
      theme: { text: '#15151f', spoken: '#6a3dff', emphasis: '#6a3dff', box: '#ffffff' },
      box: { kind: 'bubble', alpha: 1, padX: 0.84, padY: 0.63, radius: 0.95, border: 0, shadow: { x: 0, y: 0.3, blur: 0.6, alpha: 0.3 }, tail: 0.8 },
      spoken: 'color',
      layout: { chunk: 'phrase', lines: 2, chars: 28, tallChars: 22, position: 'lower' },
      motion: { enter: 'pop', exit: 'fade', word: 'none', emphasis: 'none', upcoming: 1 }
    })
  },
  {
    id: 'chat',
    name: 'Chat',
    group: 'long',
    description: 'Calls and interviews as chat bubbles: you on the right, others on the left',
    fallback: 'boxed',
    // The blue of "You" is #2f7bff 12% darker (#296ce0): white on #2f7bff is 3.9:1, on #296ce0 4.9:1.
    look: look('chat', {
      text: { font: cat('inter-tight'), weight: 600, case: 'asis', tracking: 0, lineHeight: 1.3, size: 0.04, tall: 1.2, scripts: bengali('noto-sans-bengali', 600) },
      emphasis: { weight: 800 },
      theme: { text: '#15151f', spoken: '#15151f', emphasis: '#15151f', box: '#e9eaf0', youBox: '#296ce0', youText: '#ffffff' },
      box: { kind: 'chat', alpha: 1, padX: 0.8, padY: 0.5, radius: 1, border: 0, gap: 0.3 },
      spoken: 'none',
      layout: { chunk: 'phrase', lines: 2, chars: 32, tallChars: 22, position: 'bottom' },
      motion: { enter: 'rise', exit: 'fade', word: 'none', emphasis: 'none', upcoming: 1 }
    })
  },
  {
    id: 'cinema',
    name: 'Cinema',
    group: 'long',
    description: 'Film-style subtitles in warm yellow, low on the frame',
    fallback: 'clean',
    // A thin dark edge (0.04 em) with the strong shadow, so the yellow passes §7.2 over white video too.
    look: look('cinema', {
      text: { font: cat('inter-tight'), weight: 600, case: 'asis', tracking: 0, lineHeight: 1.25, size: 0.045, tall: 1.1, scripts: bengali('noto-sans-bengali', 600) },
      emphasis: { weight: 800 },
      theme: { text: '#ffe680', spoken: '#ffffff', emphasis: '#ffffff' },
      edge: { outline: 0.04, outlineAlpha: 0.9, shadow: { x: 0, y: 0.1, blur: 0.4, alpha: 1 } },
      spoken: 'none',
      layout: { chunk: 'phrase', lines: 2, chars: 42, tallChars: 26, position: 'bottom' },
      motion: { enter: 'fade', exit: 'fade', word: 'none', emphasis: 'none', upcoming: 1 }
    })
  },
  {
    id: 'gold',
    name: 'Gold',
    group: 'long',
    description: 'Gold serif letters for titles and launches',
    fallback: 'clean',
    // The gradient's stops sweep from top to bottom, with the metal's band at the middle of the letters
    // (more.html: 0, 45, 55, 100%); a thin black edge keeps the darkest (#b7862b, 6.5:1) readable.
    look: look('gold', {
      text: { font: cat('playfair-display'), weight: 900, case: 'asis', tracking: 0, lineHeight: 1.15, size: 0.065, tall: 1.15, scripts: bengali('noto-serif-bengali', 700) },
      emphasis: { weight: 900 },
      theme: { text: '#f5c84c', spoken: '#ffffff', emphasis: '#fff3c4', fill: { stops: ['#fff3c4', '#f5c84c', '#b7862b', '#f9e08a'], at: [0, 0.45, 0.55, 1], axis: 'down' } },
      edge: { outline: 0.04, outlineAlpha: 1, shadow: { x: 0, y: 0.08, blur: 0.16, alpha: 0.7 } },
      spoken: 'none',
      layout: { chunk: 'phrase', lines: 2, chars: 32, tallChars: 22, position: 'lower' },
      motion: { enter: 'fade', exit: 'fade', word: 'none', emphasis: 'none', upcoming: 1 }
    })
  },
  {
    id: 'circle',
    name: 'Circle',
    group: 'long',
    description: 'A hand-drawn circle around the key words',
    fallback: 'clean',
    look: look('circle', {
      text: { font: cat('inter-tight'), weight: 800, case: 'asis', tracking: 0, lineHeight: 1.25, size: 0.052, tall: 1.2, scripts: bengali('noto-sans-bengali', 700) },
      emphasis: { weight: 800, mark: 'circle' },
      theme: { text: '#ffffff', spoken: '#ffe14d', emphasis: '#ff3d6e', emphasisText: '#ffffff', outline: '#15151f' },
      edge: { outline: 0.07, outlineAlpha: 1 },
      spoken: 'none',
      layout: { chunk: 'phrase', lines: 2, chars: 32, tallChars: 22, position: 'bottom' },
      motion: { enter: 'fade', exit: 'fade', word: 'none', emphasis: 'none', upcoming: 1 }
    })
  }
]

const MORE_SHORT: StudioPreset[] = [
  {
    id: 'gradient',
    name: 'Gradient',
    group: 'short',
    description: 'Bold capitals in a pink to orange gradient',
    fallback: 'bold',
    // The mock-up's 1 px dark edge is a 0.04 em outline in #1b1b1b (pink 5.6:1, orange 7.3:1), with its hard offset shadow.
    look: look('gradient', {
      text: { font: cat('archivo-black'), weight: 400, case: 'upper', tracking: 0.02, lineHeight: 1.05, size: 0.08, tall: 1.2, scripts: bengali('noto-sans-bengali', 800) },
      emphasis: { scale: 1.15 },
      theme: { text: '#ff3dcb', spoken: '#ffffff', emphasis: '#ffe14d', outline: '#1b1b1b', shadow: '#1b1b1b', fill: { stops: ['#ff3dcb', '#ff8a00'], axis: 'across' } },
      edge: { outline: 0.04, outlineAlpha: 1, shadow: { x: 0.06, y: 0.08, blur: 0, alpha: 1 } },
      spoken: 'none',
      layout: { chunk: 'words', words: 3, lines: 2, chars: 16, tallChars: 14, position: 'lower' },
      motion: { enter: 'pop', exit: 'fade', word: 'pulse', emphasis: 'pop', upcoming: 1 }
    })
  },
  {
    id: 'stickers',
    name: 'Stickers',
    group: 'short',
    description: 'Each word a tilted sticker; the spoken one turns yellow',
    fallback: 'boxed',
    look: look('stickers', {
      text: { font: cat('lilita-one'), weight: 400, case: 'asis', tracking: 0, lineHeight: 1.2, size: 0.065, tall: 1.2, scripts: bengali('noto-sans-bengali', 700) },
      theme: { text: '#111111', spoken: '#ffd23f', spokenText: '#111111', emphasis: '#c8102e', outline: '#111111', shadow: '#111111', box: '#ffffff', border: '#111111' },
      box: { kind: 'word', alpha: 1, padX: 0.33, padY: 0.07, radius: 0.33, border: 0.1, shadow: { x: 0.13, y: 0.13, blur: 0, alpha: 1 } },
      spoken: 'box',
      layout: { chunk: 'words', words: 3, lines: 2, chars: 16, tallChars: 14, position: 'lower' },
      motion: { enter: 'pop', exit: 'fade', word: 'none', emphasis: 'none', upcoming: 1, wordTilt: [-4, 3], spokenScale: 1.12 }
    })
  },
  {
    id: 'spotlight-word',
    name: 'Spotlight Word',
    group: 'short',
    description: 'Only the spoken word is lit',
    fallback: 'karaoke',
    // The words to come are #9a9a9a over a dark edge (6.2:1); the mock-up's white at α 0.32 is 2.7:1.
    // Words already spoken stay full white (APPROVED-LOOK.md).
    look: look('spotlight-word', {
      text: { font: cat('poppins'), weight: 800, case: 'asis', tracking: 0, lineHeight: 1.2, size: 0.06, tall: 1.2, scripts: bengali('noto-sans-bengali', 700) },
      emphasis: { weight: 800 },
      theme: { text: '#ffffff', upcoming: '#9a9a9a', spoken: '#ffffff', emphasis: '#ffe14d', glow: '#78beff' },
      edge: { outline: 0.05, outlineAlpha: 0.9, shadow: { x: 0, y: 0.1, blur: 0.28, alpha: 0.6 }, glow: 0.7 },
      spoken: 'glow',
      layout: { chunk: 'words', words: 3, lines: 2, chars: 18, tallChars: 16, position: 'lower' },
      motion: { enter: 'fade', exit: 'fade', word: 'none', emphasis: 'none', upcoming: 1, spokenScale: 1.28 }
    })
  },
  {
    id: 'retro-pixel',
    name: 'Retro Pixel',
    group: 'short',
    description: 'A pixel font with a colour split, for gaming',
    fallback: 'bold',
    // The split is 0.06 em: 3 px at this size in a 1080p frame. A dark outline keeps the letters readable over any video.
    look: look('retro-pixel', {
      text: { font: cat('press-start-2p'), weight: 400, case: 'upper', tracking: 0, lineHeight: 1.6, size: 0.045, tall: 1.2, scripts: bengali('noto-sans-bengali', 700) },
      theme: { text: '#ffffff', spoken: '#ffe14d', emphasis: '#ffe14d', split: ['#ff004c', '#00e5ff'] },
      edge: { outline: 0.05, outlineAlpha: 1, shadow: { x: 0, y: 0.2, blur: 0, alpha: 1 }, split: 0.06 },
      spoken: 'color',
      layout: { chunk: 'words', words: 3, lines: 2, chars: 14, tallChars: 12, position: 'lower' },
      motion: { enter: 'pop', exit: 'fade', word: 'none', emphasis: 'none', upcoming: 1 }
    })
  },
  {
    id: 'block-3d',
    name: '3D Block',
    group: 'short',
    description: 'Capitals with depth, for announcements',
    fallback: 'bold',
    // The extrusion and outline are #7a1b3a 30% darker (#551329): #ff5e7e on #7a1b3a is 3.5:1, on #551329 4.7:1.
    look: look('block-3d', {
      text: { font: cat('rubik'), weight: 900, case: 'upper', tracking: 0.03, lineHeight: 1.05, size: 0.08, tall: 1.2, scripts: bengali('noto-sans-bengali', 800) },
      emphasis: { weight: 900 },
      theme: { text: '#ff5e7e', spoken: '#ffd23f', emphasis: '#ffd23f', outline: '#551329', extrude: '#551329', spokenExtrude: '#8a5a00' },
      edge: { outline: 0.04, outlineAlpha: 1, extrude: { steps: 6, x: 0.026, y: 0.026 }, shadow: { x: 0.21, y: 0.24, blur: 0.37, alpha: 0.45 } },
      spoken: 'color',
      layout: { chunk: 'words', words: 3, lines: 2, chars: 14, tallChars: 12, position: 'lower' },
      motion: { enter: 'pop', exit: 'fade', word: 'pulse', emphasis: 'pop', upcoming: 1 }
    })
  },
  {
    id: 'bubble-round',
    name: 'Bubble',
    group: 'short',
    description: 'Rounded, soft and friendly',
    fallback: 'clean',
    // Against the thick white outline, the mock-up's pastel #ff8fc1 is 2.1:1 and #7c5cff 4.3:1: the
    // pink is the same hue at 45% lightness (#e50067, 4.6:1), the purple 6% darker (#7556f0, 4.8:1).
    look: look('bubble-round', {
      text: { font: cat('fredoka'), weight: 700, case: 'asis', tracking: 0, lineHeight: 1.15, size: 0.07, tall: 1.2, scripts: bengali('noto-sans-bengali', 700) },
      emphasis: { weight: 700 },
      theme: { text: '#e50067', spoken: '#7556f0', emphasis: '#7556f0', outline: '#ffffff', shadow: '#50003c' },
      edge: { outline: 0.11, outlineAlpha: 1, shadow: { x: 0, y: 0.125, blur: 0.19, alpha: 0.35 } },
      spoken: 'color',
      layout: { chunk: 'words', words: 3, lines: 2, chars: 18, tallChars: 16, position: 'lower' },
      motion: { enter: 'pop', exit: 'fade', word: 'none', emphasis: 'pulse', upcoming: 1 }
    })
  }
]

/**
 * The built-in looks: Long videos (§5.3, then §0.1's) and Short clips (§5.4, then §0.1's), in
 * gallery order.
 */
export const STUDIO_PRESETS: readonly StudioPreset[] = [...LONG, ...MORE_LONG, ...SHORT, ...MORE_SHORT]

/** The built-in look `id`, or undefined. */
export function studioPreset(id: string): StudioPreset | undefined {
  return STUDIO_PRESETS.find((p) => p.id === id)
}

/** The five legacy looks (§5.2), drawn by today's code, under *Classic*. */
export const LEGACY_TILES: readonly LegacyTile[] = [
  { preset: 'clean', name: 'Clean', description: 'White text with a soft shadow' },
  { preset: 'boxed', name: 'Boxed', description: 'Text on a dark box, like TV subtitles' },
  { preset: 'karaoke', name: 'Karaoke', description: 'Each word lights up as it is spoken' },
  { preset: 'minimal', name: 'Minimal', description: 'Light, small text with a thin outline' },
  { preset: 'bold', name: 'Bold', description: 'Big outlined capitals; the spoken word lights up' }
]

/* ---------- §7 colours ---------- */

/** A colour theme (§7.1): swapped into a look, its geometry kept. Brand is made from the brand kit (colors.ts brandTheme). */
export interface ThemeTile {
  id: string
  name: string
  theme: StudioTheme
}

const theme = (text: string, spoken: string, emphasis: string, outline: string, box: string): StudioTheme => ({ text, spoken, emphasis, outline, shadow: outline, box, glow: spoken })

/** The fixed themes of §7.1 (glow follows the spoken colour); Brand is added when the kit has colours. */
export const THEMES: readonly ThemeTile[] = [
  { id: 'classic', name: 'Classic', theme: theme('#ffffff', '#ffe14d', '#ffe14d', '#000000', '#0a0a10') },
  { id: 'lime', name: 'Lime', theme: theme('#ffffff', '#39e508', '#ffe14d', '#000000', '#0a0a10') },
  { id: 'cyan', name: 'Cyan', theme: theme('#ffffff', '#22d3ee', '#ffe14d', '#000000', '#0a0a10') },
  { id: 'sunset', name: 'Sunset', theme: theme('#ffffff', '#ff9f1c', '#ff5c8a', '#000000', '#0a0a10') },
  { id: 'candy', name: 'Candy', theme: theme('#ffffff', '#ff76ff', '#b2f7ff', '#000000', '#0a0a10') },
  { id: 'mono', name: 'Mono', theme: theme('#ffffff', '#ffffff', '#ffffff', '#000000', '#0a0a10') },
  { id: 'ink', name: 'Ink (dark on light)', theme: theme('#111111', '#1d4ed8', '#b91c1c', '#ffffff', '#ffffff') }
]

/** Gradients for the Gradient spoken mark (§7.1); Brand is made from the brand kit's colours. Every stop passes 4.5:1 against black. */
export const GRADIENTS: readonly { id: string; name: string; stops: readonly string[] }[] = [
  { id: 'sunset', name: 'Sunset', stops: ['#fe9f1b', '#f76e49', '#ff2063', '#fd56cb', '#ef7aff'] },
  { id: 'ocean', name: 'Ocean', stops: ['#22d3ee', '#38bdf8', '#818cf8'] },
  { id: 'candy', name: 'Candy', stops: ['#ff76ff', '#ffa3e5', '#b2f7ff'] }
]

/** Speaker colours in the order speakers first speak (§7.4); each at least 10:1 against black. */
export const SPEAKER_PALETTE: readonly string[] = ['#ffffff', '#ffe14d', '#5ce1e6', '#8be28b', '#ff9fb2', '#c4a7ff']

/** Layout › Line length (§2.6): characters per line, wide and tall frames. */
export const LINE_LENGTHS: Readonly<Record<'short' | 'medium' | 'long', { chars: number; tallChars: number }>> = {
  short: { chars: 24, tallChars: 16 },
  medium: { chars: 32, tallChars: 20 },
  long: { chars: 42, tallChars: 26 }
}

/** Colours › Shadow chips (§2.6). */
export const SHADOW_CHIPS: Readonly<Record<'off' | 'soft' | 'strong' | 'hard', StudioEdge['shadow'] | null>> = {
  off: null,
  soft: { x: 0, y: 0.05, blur: 0.3, alpha: 0.7 },
  strong: { x: 0, y: 0.06, blur: 0.4, alpha: 0.85 },
  hard: { x: 0.06, y: 0.08, blur: 0, alpha: 1 }
}
