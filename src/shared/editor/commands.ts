/**
 * The editor's commands: one registry for the command palette, the keyboard shortcuts
 * (shortcuts.ts) and the shortcuts editor, plus the palette's fuzzy search and ranking.
 * Pure: what a command does lives in the editor (views/Editor.tsx), which runs them by id.
 */

export type CommandCategory = 'Playback' | 'Edit' | 'Add' | 'Zoom' | 'Effects' | 'Camera' | 'Captions' | 'Panels' | 'Timeline' | 'General'

/** Categories in the order the palette and the shortcuts editor list them. */
export const COMMAND_CATEGORIES: readonly CommandCategory[] = ['Playback', 'Edit', 'Add', 'Zoom', 'Effects', 'Camera', 'Captions', 'Panels', 'Timeline', 'General']

interface CommandSpec {
  id: string
  title: string
  category: CommandCategory
  /** Other words the palette search finds the command by. */
  keywords?: string
  /** Runs again while its key is held down (auto-repeat). */
  repeat?: boolean
  /** Its shortcut also works while typing in a text field (so it must use Ctrl or Alt). */
  inText?: boolean
  /** Turns a setting on or off; the palette shows its state. */
  toggle?: boolean
  /** Left out of the palette (opening the palette from the palette). */
  hidden?: boolean
}

export interface CommandInfo extends CommandSpec {
  id: CommandId
}

const COMMAND_LIST = [
  { id: 'play', title: 'Play / pause', category: 'Playback', keywords: 'start stop playback preview' },
  { id: 'goToStart', title: 'Go to start', category: 'Playback', keywords: 'beginning first frame home', repeat: true },
  { id: 'goToEnd', title: 'Go to end', category: 'Playback', keywords: 'last frame', repeat: true },
  { id: 'stepBack', title: 'Step back one frame', category: 'Playback', keywords: 'previous frame left', repeat: true },
  { id: 'stepForward', title: 'Step forward one frame', category: 'Playback', keywords: 'next frame right', repeat: true },
  { id: 'jumpBack', title: 'Back one second', category: 'Playback', keywords: 'rewind skip', repeat: true },
  { id: 'jumpForward', title: 'Forward one second', category: 'Playback', keywords: 'skip ahead', repeat: true },
  { id: 'nextChapter', title: 'Go to next chapter', category: 'Playback', keywords: 'chapter marker section skip jump forward', repeat: true },
  { id: 'prevChapter', title: 'Go to previous chapter', category: 'Playback', keywords: 'chapter marker section skip jump back', repeat: true },
  { id: 'shuttleReverse', title: 'Play backwards (again: faster)', category: 'Playback', keywords: 'reverse rewind backwards shuttle j' },
  { id: 'shuttlePause', title: 'Pause', category: 'Playback', keywords: 'stop hold shuttle k' },
  { id: 'shuttleForward', title: 'Play forward (again: faster)', category: 'Playback', keywords: 'fast forward shuttle speed l' },
  { id: 'previewSpeedUp', title: 'Faster preview speed', category: 'Playback', keywords: 'playback rate review quick 1.5x 2x' },
  { id: 'previewSpeedDown', title: 'Slower preview speed', category: 'Playback', keywords: 'playback rate slow motion 0.5x' },

  { id: 'undo', title: 'Undo', category: 'Edit', keywords: 'revert back', repeat: true },
  { id: 'redo', title: 'Redo', category: 'Edit', keywords: 'again', repeat: true },
  { id: 'split', title: 'Split clip at playhead', category: 'Edit', keywords: 'cut divide razor' },
  { id: 'deleteSelection', title: 'Delete selection', category: 'Edit', keywords: 'remove erase clip zoom text', repeat: true },
  { id: 'cutRange', title: 'Cut selected range', category: 'Edit', keywords: 'remove delete trim range' },
  { id: 'restoreAll', title: 'Restore the whole recording', category: 'Edit', keywords: 'undo cuts trims speed reset uncut' },
  { id: 'smartSpeed', title: 'Smart speed: find idle parts', category: 'Edit', keywords: 'speed up skip pauses still inactivity fast forward silence auto cut' },
  { id: 'polish', title: 'Polish in one click…', category: 'Edit', keywords: 'auto magic clean up remove silences auto zoom camera director captions subtitles style preset one click' },
  { id: 'straightenRange', title: 'Straighten cursor in selected range', category: 'Edit', keywords: 'cursor path straight line glide smooth wobble mouse range' },
  { id: 'recordedPathRange', title: 'Keep recorded cursor path in selected range', category: 'Edit', keywords: 'cursor path as recorded original wobble mouse range' },
  { id: 'cropRecording', title: 'Crop the recording…', category: 'Edit', keywords: 'crop trim edge taskbar tabs hide area frame region cut' },
  { id: 'resetCrop', title: 'Show the whole recording (reset crop)', category: 'Edit', keywords: 'crop uncrop full frame reset' },
  { id: 'cropTaskbar', title: 'Crop out the taskbar', category: 'Edit', keywords: 'crop hide taskbar bottom windows' },
  { id: 'toggleFreezeSound', title: 'Freeze frame: pause or keep the sound', category: 'Edit', keywords: 'freeze hold audio continue silence voice' },
  // E-06 select several items (docs/design/multi-select.md §6): Ctrl+A/C/X/V are standard keys (shortcuts.ts STANDARD_EDIT_KEYS).
  { id: 'selectAll', title: 'Select all items on the track (again: every item)', category: 'Edit', keywords: 'multi several group many select all track box' },
  { id: 'copyItems', title: 'Copy selected items', category: 'Edit', keywords: 'multi several group many clipboard duplicate' },
  { id: 'cutItems', title: 'Cut selected items', category: 'Edit', keywords: 'multi several group many clipboard remove move' },
  { id: 'pasteItems', title: 'Paste items at playhead', category: 'Edit', keywords: 'multi several group many clipboard insert' },
  { id: 'duplicateItems', title: 'Duplicate selected items', category: 'Edit', keywords: 'multi several group many copy clone repeat series' },
  { id: 'copyLook', title: 'Copy look of the selected item', category: 'Edit', keywords: 'multi several group many style format painter appearance' },
  { id: 'pasteLook', title: 'Paste look onto selected items', category: 'Edit', keywords: 'multi several group many style format painter appearance apply' },

  { id: 'addZoom', title: 'Add zoom at playhead', category: 'Add', keywords: 'magnify scale camera' },
  { id: 'addText', title: 'Add text at playhead', category: 'Add', keywords: 'annotation title caption label' },
  { id: 'addArrow', title: 'Add arrow', category: 'Add', keywords: 'shape pointer annotate' },
  { id: 'addLine', title: 'Add line', category: 'Add', keywords: 'shape stroke annotate' },
  { id: 'addRect', title: 'Add rectangle', category: 'Add', keywords: 'shape box square frame' },
  { id: 'addEllipse', title: 'Add ellipse', category: 'Add', keywords: 'shape circle oval' },
  { id: 'addHighlight', title: 'Add highlight', category: 'Add', keywords: 'shape marker emphasis' },
  { id: 'addBlur', title: 'Add blur', category: 'Add', keywords: 'privacy hide redact secret password' },
  { id: 'addPixelate', title: 'Add pixelate', category: 'Add', keywords: 'privacy mosaic censor redact hide' },
  { id: 'addSpotlight', title: 'Add spotlight', category: 'Add', keywords: 'focus dim darken region area' },
  { id: 'addCursorSpotlight', title: 'Add cursor spotlight', category: 'Add', keywords: 'focus dim darken follow pointer mouse' },
  { id: 'addTitle', title: 'Add title card at playhead', category: 'Add', keywords: 'intro heading lower third slide caption text' },
  { id: 'addChapter', title: 'Add chapter at playhead', category: 'Add', keywords: 'marker section bookmark youtube timestamps' },
  { id: 'freezeFrame', title: 'Freeze frame at playhead', category: 'Add', keywords: 'hold still pause picture extend frame read freeze' },

  { id: 'zoomLevel0', title: 'Pull back selected zoom (0.75×)', category: 'Zoom', keywords: 'level scale out background' },
  { id: 'zoomLevel1', title: 'Zoom level 1.25×', category: 'Zoom', keywords: 'level scale selected' },
  { id: 'zoomLevel2', title: 'Zoom level 1.5×', category: 'Zoom', keywords: 'level scale selected' },
  { id: 'zoomLevel3', title: 'Zoom level 2×', category: 'Zoom', keywords: 'level scale selected' },
  { id: 'zoomLevel4', title: 'Zoom level 3×', category: 'Zoom', keywords: 'level scale selected' },
  { id: 'toggleClickAtPlayhead', title: 'Ignore or use the click at the playhead', category: 'Zoom', keywords: 'click stray skip auto zoom ripple sound mouse' },
  { id: 'findStrayClicks', title: 'Find stray clicks', category: 'Zoom', keywords: 'click ignore skip accidental auto zoom mouse' },
  { id: 'useAllClicks', title: 'Use all ignored clicks again', category: 'Zoom', keywords: 'click restore unignore auto zoom mouse' },
  // NW-05 vertical video (docs/design/vertical-video.md §2.11): the view that follows the action.
  { id: 'toggleFollow', title: 'Follow the action', category: 'Zoom', keywords: 'vertical portrait tall square 9:16 1:1 crop pan reframe framing cursor short reels tiktok', toggle: true },
  { id: 'holdView', title: 'Hold the view here', category: 'Zoom', keywords: 'vertical follow framing pan stop keep still aim point' },

  { id: 'toggleCursor', title: 'Smooth cursor', category: 'Effects', keywords: 'show hide pointer mouse toggle', toggle: true },
  { id: 'toggleClickEffects', title: 'Click effects', category: 'Effects', keywords: 'ripple ring pulse toggle', toggle: true },
  { id: 'toggleStraighten', title: 'Straighten cursor moves', category: 'Effects', keywords: 'cursor path straight line glide smooth wobble mouse toggle', toggle: true },
  { id: 'toggleMotionBlur', title: 'Motion blur', category: 'Effects', keywords: 'toggle smooth camera', toggle: true },
  { id: 'toggleKeystrokes', title: 'Keystroke overlay', category: 'Effects', keywords: 'keyboard shortcuts keys toggle show hide', toggle: true },
  { id: 'toggleWebcam', title: 'Camera bubble', category: 'Effects', keywords: 'webcam face show hide toggle', toggle: true },

  { id: 'layoutDefault', title: 'Camera layout: screen with camera bubble', category: 'Camera', keywords: 'webcam layout default picture in picture pip' },
  { id: 'layoutCameraOnly', title: 'Camera layout: camera only', category: 'Camera', keywords: 'webcam layout full face talking head fullscreen' },
  { id: 'layoutScreenOnly', title: 'Camera layout: screen only', category: 'Camera', keywords: 'webcam layout hide no camera' },
  { id: 'layoutSideBySide', title: 'Camera layout: side by side', category: 'Camera', keywords: 'webcam layout split two columns' },
  { id: 'layoutCameraLarge', title: 'Camera layout: large camera', category: 'Camera', keywords: 'webcam layout big presenter' },
  { id: 'directCamera', title: 'Direct the camera automatically', category: 'Camera', keywords: 'auto director webcam layout intro outro bubble corner move hide silence face centre framing' },

  { id: 'generateCaptions', title: 'Generate captions', category: 'Captions', keywords: 'transcribe transcript subtitles speech text auto ai' },
  { id: 'toggleCaptions', title: 'Show or hide captions', category: 'Captions', keywords: 'subtitles transcript on off toggle burn', toggle: true },
  { id: 'exportCaptions', title: 'Export captions…', category: 'Captions', keywords: 'subtitles srt vtt transcript text save file' },

  { id: 'showStyle', title: 'Open Style settings', category: 'Panels', keywords: 'background padding corners shadow aspect inspector tab' },
  { id: 'showCursor', title: 'Open Cursor settings', category: 'Panels', keywords: 'pointer clicks inspector tab' },
  { id: 'showZoom', title: 'Open Zoom settings', category: 'Panels', keywords: 'auto zoom inspector tab' },
  { id: 'showClip', title: 'Open Clip settings', category: 'Panels', keywords: 'cuts speed trim inspector tab' },
  { id: 'showText', title: 'Open Text settings', category: 'Panels', keywords: 'annotations titles chapters inspector tab' },
  { id: 'showCaptions', title: 'Open Captions settings', category: 'Panels', keywords: 'subtitles transcript inspector tab' },
  { id: 'showShapes', title: 'Open Shapes settings', category: 'Panels', keywords: 'arrows blur spotlight inspector tab' },
  { id: 'showEffects', title: 'Open Effects settings', category: 'Panels', keywords: 'motion blur keystrokes inspector tab' },
  { id: 'showCamera', title: 'Open Camera settings', category: 'Panels', keywords: 'webcam inspector tab' },
  { id: 'showAudio', title: 'Open Audio settings', category: 'Panels', keywords: 'volume mute music inspector tab' },

  { id: 'timelineZoomIn', title: 'Zoom timeline in', category: 'Timeline', keywords: 'magnify scale wider', repeat: true },
  { id: 'timelineZoomOut', title: 'Zoom timeline out', category: 'Timeline', keywords: 'shrink scale narrower', repeat: true },
  { id: 'timelineFit', title: 'Fit timeline to window', category: 'Timeline', keywords: 'whole recording all reset zoom' },
  { id: 'toggleWaveform', title: 'Audio waveform on the timeline', category: 'Timeline', keywords: 'sound wave levels audio pauses silence talk show hide', toggle: true },
  { id: 'toggleSnapping', title: 'Snapping', category: 'Timeline', keywords: 'snap magnet align edges cuts clicks chapters playhead stick toggle', toggle: true },

  // NW-05 vertical video and X-04 duplicate (docs/design/vertical-video.md §2.11): copies, and the safe-zone preview.
  { id: 'makeVertical', title: 'Make a vertical version', category: 'General', keywords: 'duplicate copy portrait tall 9:16 short shorts reels tiktok follow' },
  { id: 'makeSquare', title: 'Make a square version', category: 'General', keywords: 'duplicate copy 1:1 post instagram follow' },
  { id: 'duplicateVideo', title: 'Duplicate this video', category: 'General', keywords: 'copy clone project version' },
  { id: 'toggleSafeZones', title: 'Show safe zones', category: 'General', keywords: 'vertical tiktok reels shorts buttons captions phone app overlay', toggle: true },
  { id: 'export', title: 'Export…', category: 'General', keywords: 'render save mp4 gif video share' },
  { id: 'shortcuts', title: 'Keyboard shortcuts…', category: 'General', keywords: 'keys hotkeys bindings rebind customize keymap' },
  { id: 'about', title: 'About Flown', category: 'General', keywords: 'version qbexel website credits info' },
  { id: 'commandPalette', title: 'Command palette', category: 'General', keywords: 'search commands', inText: true, hidden: true }
] as const satisfies readonly CommandSpec[]

export type CommandId = (typeof COMMAND_LIST)[number]['id']

export const COMMANDS: readonly CommandInfo[] = COMMAND_LIST
export const COMMAND_IDS: readonly CommandId[] = COMMANDS.map((c) => c.id)

const BY_ID = new Map<string, CommandInfo>(COMMANDS.map((c) => [c.id, c]))

export const isCommandId = (v: unknown): v is CommandId => typeof v === 'string' && BY_ID.has(v)

export function commandInfo(id: CommandId): CommandInfo {
  return BY_ID.get(id)!
}

/** Commands the palette offers. */
export const PALETTE_COMMANDS: readonly CommandInfo[] = COMMANDS.filter((c) => !c.hidden)

/* ---------- fuzzy search ---------- */

export interface FuzzyMatch {
  score: number
  /** Indices of the matched characters in the text, ascending (for highlighting). */
  indices: number[]
}

const SEPARATOR = /[\s\-_/().,:·…×]/

/** True when text[j] starts a word: the first character, after a separator, or a lower→upper or letter→digit step. */
function wordStart(text: string, j: number): boolean {
  if (j === 0) return true
  const prev = text[j - 1]
  const ch = text[j]
  if (SEPARATOR.test(prev)) return true
  if (prev >= 'a' && prev <= 'z' && ch >= 'A' && ch <= 'Z') return true
  return /\d/.test(ch) && !/\d/.test(prev)
}

const WORD_START_BONUS = 6
const FIRST_CHAR_BONUS = 2
const CONSECUTIVE_BONUS = 5
const GAP_PENALTY = 1

/**
 * Best subsequence match of `query` in `text`, ignoring case: every query character must
 * appear in order. Matches at word starts and runs of consecutive characters score higher,
 * so "spl" finds "Split clip" before "Smart speed: find idle parts". Null when it does not match.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const n = q.length
  const m = t.length
  if (n === 0) return { score: 0, indices: [] }
  if (n > m) return null
  const charScore = (j: number): number => 1 + (wordStart(text, j) ? WORD_START_BONUS : 0) + (j === 0 ? FIRST_CHAR_BONUS : 0)
  // score[i][j]: best score with q[i] matched at t[j]; from[i][j]: where q[i-1] was matched.
  const NONE = -Infinity
  let prev: number[] = new Array<number>(m).fill(NONE)
  const from: Int16Array[] = []
  for (let j = 0; j < m; j++) if (t[j] === q[0]) prev[j] = charScore(j)
  from.push(new Int16Array(m).fill(-1))
  for (let i = 1; i < n; i++) {
    const cur = new Array<number>(m).fill(NONE)
    const back = new Int16Array(m).fill(-1)
    // Best earlier match (index < j - 1) for a non-consecutive step.
    let runBest = NONE
    let runAt = -1
    for (let j = i; j < m; j++) {
      const k = j - 2
      if (k >= 0 && prev[k] > runBest) {
        runBest = prev[k]
        runAt = k
      }
      if (t[j] !== q[i]) continue
      const consecutive = prev[j - 1] === NONE ? NONE : prev[j - 1] + CONSECUTIVE_BONUS
      const gapped = runBest === NONE ? NONE : runBest - GAP_PENALTY
      if (consecutive === NONE && gapped === NONE) continue
      if (consecutive >= gapped) {
        cur[j] = charScore(j) + consecutive
        back[j] = j - 1
      } else {
        cur[j] = charScore(j) + gapped
        back[j] = runAt
      }
    }
    prev = cur
    from.push(back)
  }
  let best = NONE
  let at = -1
  for (let j = 0; j < m; j++) {
    if (prev[j] > best) {
      best = prev[j]
      at = j
    }
  }
  if (at < 0) return null
  const indices: number[] = new Array<number>(n)
  for (let i = n - 1; i >= 0; i--) {
    indices[i] = at
    at = from[i][at]
  }
  // A query that is the start of the text (or of one of its words, uninterrupted) wins clearly.
  const prefix = t.startsWith(q) ? 4 : 0
  return { score: best + prefix, indices }
}

export interface RankedCommand {
  command: CommandInfo
  score: number
  /** Matched characters of the title. */
  indices: number[]
  recent: boolean
}

/** How much a recently used command is lifted (the most recent one the most). */
const RECENT_BOOST = 3
/** Base score of a word found in a command's category or keywords. */
const KEYWORD_SCORE = 2

/**
 * Commands matching `query`, best first. Every word of the query must match the title, or
 * failing that start a word of the category or keywords (scoring less, without highlights). Recently used
 * commands rank higher; with an empty query they come first, in the order they were used,
 * followed by the rest in registry order.
 */
export function searchCommands(commands: readonly CommandInfo[], query: string, recent: readonly CommandId[] = []): RankedCommand[] {
  const words = query.trim().split(/\s+/).filter(Boolean)
  const recentRank = new Map(recent.map((id, i) => [id, i]))
  if (words.length === 0) {
    const first = recent.map((id) => commands.find((c) => c.id === id)).filter((c): c is CommandInfo => !!c)
    const rest = commands.filter((c) => !recentRank.has(c.id))
    return [...first.map((c) => ({ command: c, score: 0, indices: [], recent: true })), ...rest.map((c) => ({ command: c, score: 0, indices: [], recent: false }))]
  }
  const out: { ranked: RankedCommand; order: number }[] = []
  commands.forEach((command, order) => {
    const extra = `${command.category} ${command.keywords ?? ''}`.toLowerCase().split(/\s+/)
    let score = 0
    const indices = new Set<number>()
    for (const word of words) {
      const inTitle = fuzzyMatch(word, command.title)
      if (inTitle) {
        score += inTitle.score
        for (const i of inTitle.indices) indices.add(i)
        continue
      }
      // Category and keywords match by the start of a word only, and score below the title.
      const w = word.toLowerCase()
      if (!extra.some((k) => k.startsWith(w))) return
      score += KEYWORD_SCORE + w.length
    }
    // On a tie, the title the query covers more of ("export": "Export…" before "Export captions…").
    if (indices.size) score += indices.size / command.title.length
    const r = recentRank.get(command.id)
    const recentHit = r !== undefined
    if (recentHit) score += RECENT_BOOST * (1 - r / Math.max(1, recent.length))
    out.push({ ranked: { command, score, indices: [...indices].sort((a, b) => a - b), recent: recentHit }, order })
  })
  out.sort((a, b) => b.ranked.score - a.ranked.score || a.order - b.order)
  return out.map((o) => o.ranked)
}

/* ---------- recently used ---------- */

export const MAX_RECENT = 6

/** `recent` with `id` moved to the front. */
export function pushRecent(recent: readonly CommandId[], id: CommandId, max = MAX_RECENT): CommandId[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, max)
}

/** Recently used commands read back from storage: known, distinct ids only. */
export function sanitizeRecent(raw: unknown, max = MAX_RECENT): CommandId[] {
  if (!Array.isArray(raw)) return []
  const out: CommandId[] = []
  for (const v of raw) if (isCommandId(v) && !out.includes(v)) out.push(v)
  return out.slice(0, max)
}
