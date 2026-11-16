/**
 * The editor's commands: one registry for the command palette, the keyboard shortcuts
 * (shortcuts.ts) and the shortcuts editor, plus the palette's fuzzy search and ranking.
 * Pure: what a command does lives in the editor (views/Editor.tsx), which runs them by id.
 *
 * Titles and category names are messages (docs/design/output-and-languages.md §9.1, §21.8): a
 * command's title is `commands.title.<id>` and a category's name `commands.category.<id>`, shown
 * through commandTitle and categoryLabel. The registry keeps each command's English title as data,
 * read from the English catalogue, because the palette finds a command by its English title and
 * its English keywords in every UI language.
 */
import commandsEn from '../i18n/messages/en/commands.json'
import { t } from '../i18n/t'

/** A category's id; its name in the UI language is categoryLabel(id). */
export type CommandCategory = 'Playback' | 'Edit' | 'Add' | 'Zoom' | 'Effects' | 'Camera' | 'Captions' | 'Panels' | 'Timeline' | 'General' | 'Publish'

/** Categories in the order the palette and the shortcuts editor list them. */
export const COMMAND_CATEGORIES: readonly CommandCategory[] = ['Playback', 'Edit', 'Add', 'Zoom', 'Effects', 'Camera', 'Captions', 'Panels', 'Timeline', 'General', 'Publish']

interface CommandSpec {
  id: string
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
  /** The English title (`commands.title.<id>` in English); the UI shows commandTitle(). */
  title: string
}

const COMMAND_LIST = [
  { id: 'play', category: 'Playback', keywords: 'start stop playback preview' },
  { id: 'goToStart', category: 'Playback', keywords: 'beginning first frame home', repeat: true },
  { id: 'goToEnd', category: 'Playback', keywords: 'last frame', repeat: true },
  { id: 'stepBack', category: 'Playback', keywords: 'previous frame left', repeat: true },
  { id: 'stepForward', category: 'Playback', keywords: 'next frame right', repeat: true },
  { id: 'jumpBack', category: 'Playback', keywords: 'rewind skip', repeat: true },
  { id: 'jumpForward', category: 'Playback', keywords: 'skip ahead', repeat: true },
  { id: 'nextChapter', category: 'Playback', keywords: 'chapter marker section skip jump forward', repeat: true },
  { id: 'prevChapter', category: 'Playback', keywords: 'chapter marker section skip jump back', repeat: true },
  { id: 'shuttleReverse', category: 'Playback', keywords: 'reverse rewind backwards shuttle j' },
  { id: 'shuttlePause', category: 'Playback', keywords: 'stop hold shuttle k' },
  { id: 'shuttleForward', category: 'Playback', keywords: 'fast forward shuttle speed l' },
  { id: 'previewSpeedUp', category: 'Playback', keywords: 'playback rate review quick 1.5x 2x' },
  { id: 'previewSpeedDown', category: 'Playback', keywords: 'playback rate slow motion 0.5x' },

  { id: 'undo', category: 'Edit', keywords: 'revert back', repeat: true },
  { id: 'redo', category: 'Edit', keywords: 'again', repeat: true },
  { id: 'split', category: 'Edit', keywords: 'cut divide razor' },
  { id: 'deleteSelection', category: 'Edit', keywords: 'remove erase clip zoom text', repeat: true },
  { id: 'cutRange', category: 'Edit', keywords: 'remove delete trim range' },
  { id: 'restoreAll', category: 'Edit', keywords: 'undo cuts trims speed reset uncut' },
  { id: 'smartSpeed', category: 'Edit', keywords: 'speed up skip pauses still inactivity fast forward silence auto cut' },
  { id: 'polish', category: 'Edit', keywords: 'auto magic clean up remove silences auto zoom camera director captions subtitles style preset one click' },
  // E-02 review mode (docs/design/review-mode.md §5).
  { id: 'review', category: 'Edit', keywords: 'tracked changes auto zoom silence cut camera director filler undo keep remove accept reject' },
  { id: 'straightenRange', category: 'Edit', keywords: 'cursor path straight line glide smooth wobble mouse range' },
  { id: 'recordedPathRange', category: 'Edit', keywords: 'cursor path as recorded original wobble mouse range' },
  { id: 'cropRecording', category: 'Edit', keywords: 'crop trim edge taskbar tabs hide area frame region cut' },
  { id: 'resetCrop', category: 'Edit', keywords: 'crop uncrop full frame reset' },
  { id: 'cropTaskbar', category: 'Edit', keywords: 'crop hide taskbar bottom windows' },
  { id: 'toggleFreezeSound', category: 'Edit', keywords: 'freeze hold audio continue silence voice' },
  // E-06 select several items (docs/design/multi-select.md §6): Ctrl+A/C/X/V are standard keys (shortcuts.ts STANDARD_EDIT_KEYS).
  { id: 'selectAll', category: 'Edit', keywords: 'multi several group many select all track box' },
  { id: 'copyItems', category: 'Edit', keywords: 'multi several group many clipboard duplicate' },
  { id: 'cutItems', category: 'Edit', keywords: 'multi several group many clipboard remove move' },
  { id: 'pasteItems', category: 'Edit', keywords: 'multi several group many clipboard insert' },
  { id: 'duplicateItems', category: 'Edit', keywords: 'multi several group many copy clone repeat series' },
  { id: 'copyLook', category: 'Edit', keywords: 'multi several group many style format painter appearance' },
  { id: 'pasteLook', category: 'Edit', keywords: 'multi several group many style format painter appearance apply' },

  { id: 'addZoom', category: 'Add', keywords: 'magnify scale camera' },
  { id: 'addText', category: 'Add', keywords: 'annotation title caption label' },
  { id: 'addArrow', category: 'Add', keywords: 'shape pointer annotate' },
  { id: 'addLine', category: 'Add', keywords: 'shape stroke annotate' },
  { id: 'addRect', category: 'Add', keywords: 'shape box square frame' },
  { id: 'addEllipse', category: 'Add', keywords: 'shape circle oval' },
  { id: 'addHighlight', category: 'Add', keywords: 'shape marker emphasis' },
  { id: 'addBlur', category: 'Add', keywords: 'privacy hide redact secret password' },
  { id: 'addPixelate', category: 'Add', keywords: 'privacy mosaic censor redact hide' },
  { id: 'addSpotlight', category: 'Add', keywords: 'focus dim darken region area' },
  { id: 'addCursorSpotlight', category: 'Add', keywords: 'focus dim darken follow pointer mouse' },
  { id: 'addTitle', category: 'Add', keywords: 'intro heading lower third slide caption text' },
  { id: 'addChapter', category: 'Add', keywords: 'marker section bookmark youtube timestamps' },
  { id: 'freezeFrame', category: 'Add', keywords: 'hold still pause picture extend frame read freeze' },

  { id: 'zoomLevel0', category: 'Zoom', keywords: 'level scale out background' },
  { id: 'zoomLevel1', category: 'Zoom', keywords: 'level scale selected' },
  { id: 'zoomLevel2', category: 'Zoom', keywords: 'level scale selected' },
  { id: 'zoomLevel3', category: 'Zoom', keywords: 'level scale selected' },
  { id: 'zoomLevel4', category: 'Zoom', keywords: 'level scale selected' },
  { id: 'toggleClickAtPlayhead', category: 'Zoom', keywords: 'click stray skip auto zoom ripple sound mouse' },
  { id: 'findStrayClicks', category: 'Zoom', keywords: 'click ignore skip accidental auto zoom mouse' },
  { id: 'useAllClicks', category: 'Zoom', keywords: 'click restore unignore auto zoom mouse' },
  // NW-05 vertical video (docs/design/vertical-video.md §2.11): the view that follows the action.
  { id: 'toggleFollow', category: 'Zoom', keywords: 'vertical portrait tall square 9:16 1:1 crop pan reframe framing cursor short reels tiktok', toggle: true },
  { id: 'holdView', category: 'Zoom', keywords: 'vertical follow framing pan stop keep still aim point' },

  { id: 'toggleCursor', category: 'Effects', keywords: 'show hide pointer mouse toggle', toggle: true },
  { id: 'toggleClickEffects', category: 'Effects', keywords: 'ripple ring pulse toggle', toggle: true },
  { id: 'toggleStraighten', category: 'Effects', keywords: 'cursor path straight line glide smooth wobble mouse toggle', toggle: true },
  { id: 'toggleMotionBlur', category: 'Effects', keywords: 'toggle smooth camera', toggle: true },
  { id: 'toggleKeystrokes', category: 'Effects', keywords: 'keyboard shortcuts keys toggle show hide', toggle: true },
  { id: 'toggleWebcam', category: 'Effects', keywords: 'webcam face show hide toggle', toggle: true },

  { id: 'layoutDefault', category: 'Camera', keywords: 'webcam layout default picture in picture pip' },
  { id: 'layoutCameraOnly', category: 'Camera', keywords: 'webcam layout full face talking head fullscreen' },
  { id: 'layoutScreenOnly', category: 'Camera', keywords: 'webcam layout hide no camera' },
  { id: 'layoutSideBySide', category: 'Camera', keywords: 'webcam layout split two columns' },
  { id: 'layoutCameraLarge', category: 'Camera', keywords: 'webcam layout big presenter' },
  { id: 'directCamera', category: 'Camera', keywords: 'auto director webcam layout intro outro bubble corner move hide silence face centre framing' },

  { id: 'generateCaptions', category: 'Captions', keywords: 'transcribe transcript subtitles speech text auto ai' },
  { id: 'toggleCaptions', category: 'Captions', keywords: 'subtitles transcript on off toggle burn', toggle: true },
  { id: 'exportCaptions', category: 'Captions', keywords: 'subtitles srt vtt transcript text save file' },
  // Captions Studio (docs/design/captions-studio.md §2.14): no default keys.
  { id: 'captionsGreat', category: 'Captions', keywords: 'auto style emphasis emoji pop-ups motion graphics magic' },
  { id: 'captionStyles', category: 'Captions', keywords: 'gallery look preset font theme' },
  { id: 'captionEmphasis', category: 'Captions', keywords: 'emphasis highlight bold key words' },
  { id: 'captionGraphics', category: 'Captions', keywords: 'keyword emoji counter number list graphics' },
  { id: 'captionTidy', category: 'Captions', keywords: 'clean capital punctuation digits bleep' },
  { id: 'captionLanguage', category: 'Captions', keywords: 'translate subtitles track' },
  { id: 'saveCaptionStyle', category: 'Captions', keywords: 'preset save' },

  { id: 'showStyle', category: 'Panels', keywords: 'background padding corners shadow aspect inspector tab' },
  { id: 'showCursor', category: 'Panels', keywords: 'pointer clicks inspector tab' },
  { id: 'showZoom', category: 'Panels', keywords: 'auto zoom inspector tab' },
  { id: 'showClip', category: 'Panels', keywords: 'cuts speed trim inspector tab' },
  { id: 'showText', category: 'Panels', keywords: 'annotations titles chapters inspector tab' },
  { id: 'showCaptions', category: 'Panels', keywords: 'subtitles transcript inspector tab' },
  { id: 'showShapes', category: 'Panels', keywords: 'arrows blur spotlight inspector tab' },
  { id: 'showEffects', category: 'Panels', keywords: 'motion blur keystrokes inspector tab' },
  { id: 'showCamera', category: 'Panels', keywords: 'webcam inspector tab' },
  { id: 'showAudio', category: 'Panels', keywords: 'volume mute music inspector tab' },

  { id: 'timelineZoomIn', category: 'Timeline', keywords: 'magnify scale wider', repeat: true },
  { id: 'timelineZoomOut', category: 'Timeline', keywords: 'shrink scale narrower', repeat: true },
  { id: 'timelineFit', category: 'Timeline', keywords: 'whole recording all reset zoom' },
  { id: 'toggleWaveform', category: 'Timeline', keywords: 'sound wave levels audio pauses silence talk show hide', toggle: true },
  { id: 'toggleSnapping', category: 'Timeline', keywords: 'snap magnet align edges cuts clicks chapters playhead stick toggle', toggle: true },

  // NW-05 vertical video and X-04 duplicate (docs/design/vertical-video.md §2.11): copies, and the safe-zone preview.
  { id: 'makeVertical', category: 'General', keywords: 'duplicate copy portrait tall 9:16 short shorts reels tiktok follow' },
  { id: 'makeSquare', category: 'General', keywords: 'duplicate copy 1:1 post instagram follow' },
  { id: 'duplicateVideo', category: 'General', keywords: 'copy clone project version' },
  { id: 'toggleSafeZones', category: 'General', keywords: 'vertical tiktok reels shorts buttons captions phone app overlay', toggle: true },
  { id: 'export', category: 'General', keywords: 'render save mp4 gif video share' },
  { id: 'shortcuts', category: 'General', keywords: 'keys hotkeys bindings rebind customize keymap' },
  { id: 'about', category: 'General', keywords: 'version qbexel website credits info' },
  { id: 'commandPalette', category: 'General', keywords: 'search commands', inText: true, hidden: true },

  // NW-13 publishing copy pack (docs/design/publish-pack.md §2.8): every AI text tool, and the pack's items.
  { id: 'aiCleanup', category: 'Captions', keywords: 'ai clean up correct spelling punctuation misheard transcript' },
  { id: 'aiTranslate', category: 'Captions', keywords: 'ai language subtitles transcript other' },
  { id: 'aiChapters', category: 'Captions', keywords: 'ai chapter markers sections youtube timestamps' },
  { id: 'aiTitle', category: 'Captions', keywords: 'ai name rename recording heading' },
  { id: 'aiSummary', category: 'Captions', keywords: 'ai summary summarise description overview' },
  { id: 'publishPack', category: 'Publish', keywords: 'ai copy pack text description post social share all tone length' },
  { id: 'publishYoutube', category: 'Publish', keywords: 'ai copy description chapters timestamps tags video upload' },
  { id: 'publishLinkedin', category: 'Publish', keywords: 'ai copy social share post' },
  { id: 'publishX', category: 'Publish', keywords: 'ai copy twitter tweet social share post' },
  { id: 'publishArticle', category: 'Publish', keywords: 'ai copy help center knowledge base docs how to steps guide' },
  { id: 'publishReleaseNotes', category: 'Publish', keywords: 'ai copy changelog what changed update new fixed improved product' },

  // Output and languages (docs/design/output-and-languages.md §2.5): listed only while Settings has a Language section.
  { id: 'language', category: 'General', keywords: 'language ভাষা bangla বাংলা english español हिन्दी' },

  // E-09 nudge, E-07 filmstrip, E-12 versions (docs/design/versions.md): the step keys nudge while items are selected (shortcuts.ts NUDGE_STEPS).
  { id: 'nudgeBack', category: 'Edit', keywords: 'nudge shift left arrow frame item selection earlier', repeat: true },
  { id: 'nudgeForward', category: 'Edit', keywords: 'nudge shift right arrow frame item selection later', repeat: true },
  { id: 'nudgeBackTen', category: 'Edit', keywords: 'nudge shift left arrow frames item selection earlier', repeat: true },
  { id: 'nudgeForwardTen', category: 'Edit', keywords: 'nudge shift right arrow frames item selection later', repeat: true },
  { id: 'toggleFilmstrip', category: 'Timeline', keywords: 'filmstrip thumbnails pictures preview video frames show hide', toggle: true },
  { id: 'saveVersion', category: 'General', keywords: 'snapshot history checkpoint backup keep edit restore' },
  { id: 'versions', category: 'General', keywords: 'history snapshot restore go back compare checkpoint earlier edit' },

  // Editing polish (docs/design/editing-polish.md §2.8): no default keys (users give them keys in the shortcuts editor).
  { id: 'smoothAllCuts', category: 'Playback', keywords: 'cut style crossfade transition punch-in jump cut soften every' },
  { id: 'hardCutsEverywhere', category: 'Playback', keywords: 'cut style no transition plain jump every' },
  { id: 'nextCut', category: 'Playback', keywords: 'cut jump skip forward following transition style' },
  { id: 'previousCut', category: 'Playback', keywords: 'cut jump skip back earlier transition style' },
  { id: 'playCut', category: 'Playback', keywords: 'cut preview listen watch transition around' },
  { id: 'addMagnifier', category: 'Add', keywords: 'magnify loupe zoom lens detail larger bigger glass' },
  { id: 'addMagnifierCursor', category: 'Add', keywords: 'magnify loupe zoom lens pointer mouse follow glass' },
  { id: 'addStepBadge', category: 'Add', keywords: 'number step badge callout 1 2 3 sequence marker' },
  { id: 'addSpeechBubble', category: 'Add', keywords: 'callout bubble balloon tail comment note text' },
  { id: 'toggleProgressBar', category: 'Effects', keywords: 'progress chapter bar chapters timeline played', toggle: true },
  { id: 'compareColour', category: 'Effects', keywords: 'color colour grade look before after original lut', toggle: true },
  { id: 'autoColour', category: 'Camera', keywords: 'color colour white balance auto correct webcam exposure' },
  { id: 'musicLibrary', category: 'Panels', keywords: 'music bed background song track library sound audio' },

  // Smart tools (docs/design/smart-tools.md §2.8): no default keys. The existing aiChapters keeps its id and title and runs Suggest chapters (§7.6.1).
  { id: 'guide', category: 'Publish', keywords: 'how to steps screenshots pdf markdown html instructions document tutorial copy paste' },
  { id: 'demo', category: 'Publish', keywords: 'interactive walkthrough hotspot offline html tour' },
  { id: 'bugReport', category: 'Publish', keywords: 'steps to reproduce issue ticket expected actual jira' },
  { id: 'findChapters', category: 'Add', keywords: 'chapter markers sections youtube timestamps split auto scenes pauses' },
  { id: 'shortClips', category: 'General', keywords: 'highlights moments shorts reels tiktok best parts copy vertical' },
  { id: 'shortVersion', category: 'General', keywords: 'short summary cut down highlights 30 60 90 seconds copy' },
  { id: 'localAi', category: 'General', keywords: 'offline local model no key download private gemma qwen' },
  { id: 'aiService', category: 'General', keywords: 'openrouter groq together azure ollama lm studio openai compatible api key provider model' }
] as const satisfies readonly CommandSpec[]

export type CommandId = (typeof COMMAND_LIST)[number]['id']

export const COMMANDS: readonly CommandInfo[] = COMMAND_LIST.map((c) => ({ ...c, title: commandsEn[`title.${c.id}`] }))
export const COMMAND_IDS: readonly CommandId[] = COMMANDS.map((c) => c.id)

const BY_ID = new Map<string, CommandInfo>(COMMANDS.map((c) => [c.id, c]))

export const isCommandId = (v: unknown): v is CommandId => typeof v === 'string' && BY_ID.has(v)

export function commandInfo(id: CommandId): CommandInfo {
  return BY_ID.get(id)!
}

/** A command's title in the UI language: "Split clip at playhead". */
export function commandTitle(command: CommandId | Pick<CommandInfo, 'id'>): string {
  const id: CommandId = typeof command === 'string' ? command : command.id
  return t(`commands.title.${id}`)
}

/** A category's name in the UI language; in English it is the id itself ("Playback"). */
export function categoryLabel(category: CommandCategory): string {
  return t(`commands.category.${category.toLowerCase() as Lowercase<CommandCategory>}`)
}

/** Commands that exist only while a language other than English ships (output-and-languages §2.5): left out of the palette and the shortcuts editor until then. */
export const LANGUAGE_COMMANDS: readonly CommandId[] = ['language']

/** Commands the palette offers. */
export const PALETTE_COMMANDS: readonly CommandInfo[] = COMMANDS.filter((c) => !c.hidden && !LANGUAGE_COMMANDS.includes(c.id))

/** The palette's commands, with Language… only while Settings has a Language section (§2.5). */
export function paletteCommands(languageSection: boolean): readonly CommandInfo[] {
  return languageSection ? [...PALETTE_COMMANDS, commandInfo('language')] : PALETTE_COMMANDS
}

/** The commands the shortcuts editor lists: every one, with Language… only while Settings has a Language section. */
export function listedCommands(languageSection: boolean): readonly CommandInfo[] {
  return languageSection ? COMMANDS : COMMANDS.filter((c) => !LANGUAGE_COMMANDS.includes(c.id))
}

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
  /** Matched characters of the title the palette shows (commandTitle, in NFC). */
  indices: number[]
  recent: boolean
}

/** How much a recently used command is lifted (the most recent one the most). */
const RECENT_BOOST = 3
/** Base score of a word found in a command's category or keywords. */
const KEYWORD_SCORE = 2

/**
 * Commands matching `query`, best first. Every word of the query must match the title shown
 * (`titleOf`, the UI language's), or failing that the English title (without highlights), or
 * failing that start a word of the category or keywords (scoring less, without highlights).
 * Query, titles and keywords are compared in NFC, so a letter typed precomposed or as its parts
 * (য়) finds the same commands (output-and-languages §21.8). Recently used commands rank higher;
 * with an empty query they come first, in the order they were used, followed by the rest in
 * registry order.
 */
export function searchCommands(commands: readonly CommandInfo[], query: string, recent: readonly CommandId[] = [], titleOf: (command: CommandInfo) => string = commandTitle): RankedCommand[] {
  const words = query.normalize('NFC').trim().split(/\s+/).filter(Boolean)
  const recentRank = new Map(recent.map((id, i) => [id, i]))
  if (words.length === 0) {
    const first = recent.map((id) => commands.find((c) => c.id === id)).filter((c): c is CommandInfo => !!c)
    const rest = commands.filter((c) => !recentRank.has(c.id))
    return [...first.map((c) => ({ command: c, score: 0, indices: [], recent: true })), ...rest.map((c) => ({ command: c, score: 0, indices: [], recent: false }))]
  }
  const out: { ranked: RankedCommand; order: number }[] = []
  commands.forEach((command, order) => {
    const title = titleOf(command).normalize('NFC')
    const english = command.title.normalize('NFC')
    const label = categoryLabel(command.category)
    // The category by its name in the UI language and by its English id (the same word in English).
    const category = label === command.category ? command.category : `${label} ${command.category}`
    const extra = `${category} ${command.keywords ?? ''}`.normalize('NFC').toLowerCase().split(/\s+/)
    let score = 0
    const indices = new Set<number>()
    for (const word of words) {
      const inTitle = fuzzyMatch(word, title)
      if (inTitle) {
        score += inTitle.score
        for (const i of inTitle.indices) indices.add(i)
        continue
      }
      // The English title, in another UI language: as good a match, but nothing to highlight.
      const inEnglish = english !== title ? fuzzyMatch(word, english) : null
      if (inEnglish) {
        score += inEnglish.score
        continue
      }
      // Category and keywords match by the start of a word only, and score below the title.
      const w = word.toLowerCase()
      if (!extra.some((k) => k.startsWith(w))) return
      score += KEYWORD_SCORE + w.length
    }
    // On a tie, the title the query covers more of ("export": "Export…" before "Export captions…").
    if (indices.size) score += indices.size / title.length
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
