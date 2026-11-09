/**
 * The Guide panel (docs/design/smart-tools.md §2.1, §14): a step per click, double-click, drag,
 * shortcut and stretch of typing, each with its screenshot (made by the export's own drawing, with
 * every blur and pixelate shape), title and note; titles and notes from what was said, or written
 * by an AI the user picks; saving as PDF, HTML, Markdown or a click-through demo, as a guide or a
 * bug report, and copying. Docked in Review mode's place: the preview, transport and timeline stay
 * usable beside it. Every edit is one store update (one undo step). Esc closes it.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { AiTextRequest, TextChoice } from '../../../shared/api/ai'
import type { GuideFormat } from '../../../shared/api/guide'
import type { SceneScan } from '../../../shared/api/projects'
import { cropOf } from '../../../shared/engine/crop'
import { editToVideo, planOf } from '../../../shared/engine/freeze'
import { effectiveTrack } from '../../../shared/engine/inputTrack'
import { formatTime } from '../../../shared/engine/project'
import { viewAt } from '../../../shared/captions/layout'
import { GUIDE_LIMITS } from '../../../shared/guide/guideData'
import { ACTUAL_KEY, defaultDetails, stepNumbers, type GuideImage } from '../../../shared/guide/guideDoc'
import { withAddedStep, withGuideFields, withoutAiTitles, withStepEdit } from '../../../shared/guide/guideEdit'
import { guideLanguage } from '../../../shared/guide/guideWords'
import { planActual, planFrame, planShot, visibleRect, type ShotPlan } from '../../../shared/guide/shots'
import { pointFromShown, pointInShown, rectFromShown, rectInShown } from '../../../shared/guide/adjust'
import { autoBadgeCount, findSteps, STEP_RULES, typedBefore, typingRuns, type GuideStep } from '../../../shared/guide/steps'
import { namesRequestForSteps, needsTitle, shownTitles, stepIncluded, stepText, type ShownTitle } from '../../../shared/guide/stepTitles'
import { notedPieces } from '../../../shared/publish/check'
import { pathLike } from '../../../shared/smart/privateText'
import { itemKey } from '../../../shared/editor/multiSelect'
import type { GuidePref } from '../../../shared/smart/smartPrefs'
import type { CursorTrack, GuideStepEdit, Project } from '../../../shared/types'
import { CostLine } from '../ai/CostLine'
import { confirmCost } from '../ai/costConfirm'
import { estimateFor, useCostData } from '../ai/useCost'
import { costLineText } from '../../../shared/ai/cost'
import { LocalProgress } from '../ai/LocalProgress'
import { useTextChoices } from '../ai/textChoices'
import { useEditor } from '../editor/context'
import { useModalFocus } from '../editor/modalFocus'
import { useGroup } from '../editor/groupContext'
import { keepArrows } from '../editor/panels/JoinOptions'
import { projectSaid } from '../publish/checkNote'
import { BIG_FILE, blurArea, blurTypedText, copyGuide, saveGuide, tidyNotes, writeStepTitles } from './guideRun'
import { ShotViewer, type ViewerShot } from './ShotViewer'
import { shotsFor, useGuideShots } from './useGuideShots'
import { namesWithPictures, pictureImage, pictureSteps, picturesToSend } from './visionTitles'
import '../review/review.css'
import './guide.css'

/** Rows drawn at a time as the list scrolls (§2.1). */
export const ROWS_AT_A_TIME = 20
/** The note under the panel's top (§2.1). */
export const GUIDE_NOTE =
  'Each click, shortcut and stretch of typing is a step. Check each screenshot at full size before you share the guide: it shows what was on screen. Areas you blurred or pixelated stay hidden.'
export const NO_CLICKS_NOTE = 'No clicks were recorded, so a change of screen is a step too. Add or hide steps as you need.'
export const NOTHING_NOTE = 'This recording has no clicks, key presses or changes of screen to make steps from. Add steps at the playhead.'
export const MAKE_CAPTIONS_NOTE = 'Make captions first: step titles and notes come from what you say.'
export const TOO_MANY_NOTE = 'Only the first 200 steps are listed. Hide the ones you do not need or cut the video into parts.'
export const NOTHING_SAID = 'Nothing was said near these steps.'
export const LINK_QUESTION = 'This guide has a link, address or file name nobody said. Save anyway?'
export const OUTSIDE_NOTE = 'The click was outside the recorded area.'
export const TYPED_HINT = 'Later screenshots can still show what you typed.'
export const BLUR_HINT = 'Drag the box over what to hide. The guide and the video both hide it.'
/** Titles from the screenshots (§5.3.1): the checkbox, and why Write titles waits. */
export const SEND_SHOTS_LABEL = 'Also send the screenshots'
export const PREPARING_PICTURES = 'Getting the screenshots ready to send…'
export const NO_PICTURES = 'No screenshot is ready to send.'

const FORMATS: readonly { id: GuideFormat; label: string; save: string }[] = [
  { id: 'pdf', label: 'PDF', save: 'Save PDF…' },
  { id: 'html', label: 'HTML', save: 'Save HTML…' },
  { id: 'markdown', label: 'Markdown', save: 'Save Markdown…' },
  { id: 'demo', label: 'Click-through demo', save: 'Save demo…' }
]

/** A4, or Letter where Windows' region is the US, Canada, Mexico or the Philippines (§2.1). */
export function defaultPage(locale = typeof navigator !== 'undefined' ? navigator.language : 'en-GB'): 'A4' | 'Letter' {
  const region = /[-_]([A-Za-z]{2})\b/.exec(locale)?.[1]?.toUpperCase()
  return region && ['US', 'CA', 'MX', 'PH'].includes(region) ? 'Letter' : 'A4'
}

/** "30 steps · 4 hidden · 12 need a title · 3 may show typing", each part only when not zero (§2.1). */
export function stepsLine(c: { steps: number; hidden: number; untitled: number; typed: number }): string {
  const parts = [`${c.steps} ${c.steps === 1 ? 'step' : 'steps'}`]
  if (c.hidden) parts.push(`${c.hidden} hidden`)
  if (c.untitled) parts.push(`${c.untitled} ${c.untitled === 1 ? 'needs' : 'need'} a title`)
  if (c.typed) parts.push(`${c.typed} may show typing`)
  return parts.join(' · ')
}

/** The question before the first Save or Copy with shots not checked at full size (§2.1.2), or null when all are. */
export function checkQuestion(c: { unchecked: number; typed: number; whole: number }): string | null {
  if (!c.unchecked) return null
  const parts = [`${c.unchecked} ${c.unchecked === 1 ? 'screenshot has' : 'screenshots have'} not been checked at full size.`]
  const more: string[] = []
  if (c.typed) more.push(`${c.typed} may show what you typed`)
  if (c.whole) more.push(`${c.whole} show${c.whole === 1 ? 's' : ''} the whole screen`)
  if (more.length) parts.push(`${more.join('; ')}.`)
  parts.push('Check them now?')
  return parts.join(' ')
}

/** The order *Check screenshots* walks (§2.1.2): steps that may show typing, then whole-screen shots, then the rest. */
export function checkOrder(keys: readonly string[], typed: ReadonlySet<string>, whole: ReadonlySet<string>): string[] {
  const rank = (k: string): number => (typed.has(k) ? 0 : whole.has(k) ? 1 : 2)
  return [...keys].sort((a, b) => rank(a) - rank(b) || keys.indexOf(a) - keys.indexOf(b))
}

/** The chip of a shot that may show typing (§5.5.7): "May show what you typed in step 4", without the number when that typing is no listed step (cut, or too short). */
export function typedNote(n: string): string {
  return n ? `May show what you typed in step ${n}` : 'May show what you typed'
}

/** The next step needing a title after `from` (wrapping), or null (§2.1). */
export function nextUntitled(keys: readonly string[], untitled: ReadonlySet<string>, from: string | null): string | null {
  if (!untitled.size) return null
  const start = from ? keys.indexOf(from) : -1
  for (let i = 1; i <= keys.length; i++) {
    const k = keys[(start + i + keys.length) % keys.length]
    if (untitled.has(k)) return k
  }
  return null
}

/** The texts of the guide the link check reads (§12 rule 3): its title, intro, bug report texts, and each included step's title, note and *What to type*. */
export function guideTexts(project: Project, rows: readonly { title: { title: string }; note: string; edit?: GuideStepEdit }[]): string[] {
  const g = project.guide ?? {}
  return [g.title ?? '', g.intro ?? '', g.expected ?? '', g.actual ?? '', ...rows.flatMap((r) => [r.title.title, r.note, r.edit?.type ?? ''])].filter((t) => t.trim())
}

/** Whether any of `texts` holds a link, address or file name nobody said (the link check and the path rule). */
export function hasPrivateText(texts: readonly string[], said: ReturnType<typeof projectSaid>): boolean {
  return texts.some((t) => notedPieces(t, said).length > 0 || pathLike(t))
}

/** A shot as Check screenshots counts it: its key and what its picture depends on (`ShotPlan.sig`). */
const seenId = (key: string, sigs: ReadonlyMap<string, string>): string => `${key}\n${sigs.get(key) ?? ''}`

interface Row {
  step: GuideStep
  index: number
  n: string
  title: ShownTitle
  note: string
  edit: GuideStepEdit | undefined
  included: boolean
  typedIn: string | null
  /** The guide's shot. */
  plan: ShotPlan
  /** The shot the chosen format saves: the demo's in the demo format (the whole screen unless *Zoom to the click in the demo*), else the guide's. */
  shot: ShotPlan
}

let requestSeq = 0

export function GuidePanel(props: { project: Project; cursor: CursorTrack; start: 'guide' | 'demo' | 'bug'; onClose(): void; onNotice(message: string): void }): JSX.Element {
  const services = useEditor()
  const { store, player } = services
  const group = useGroup()
  const { project, onClose } = props
  const ids = useId()
  const scale = props.cursor.scale && props.cursor.scale > 0 ? props.cursor.scale : 1
  const frame = useMemo(() => ({ w: project.width, h: project.height }), [project.width, project.height])
  const guide = project.guide ?? {}
  const language = guideLanguage(project)

  // The track as the edit uses it (ignored and stray clicks gone) and the screen's changes.
  const track = useMemo(() => effectiveTrack(props.cursor, project), [props.cursor, project])
  // The crop as Find chapters, Short clips and Polish send it (snapped to pixels, null for the whole
  // frame): main keeps one scan per crop, so all four read the screen once.
  const sceneCrop = useMemo(() => cropOf(project), [project.crop, project.width, project.height])
  const [scan, setScan] = useState<SceneScan | null>(null)
  useEffect(() => {
    let live = true
    window.api.detectScenes(project.id, sceneCrop).then(
      (s) => {
        if (live) setScan(s)
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [project.id, sceneCrop])
  const steps = useMemo(() => findSteps({ track, project, scan }), [track, project, scan])
  // Every stretch of typing, the ones whose step was cut or too short too: later shots can show it.
  const runs = useMemo(() => typingRuns({ track, project }, steps), [track, project, steps])

  // Choices remembered between sessions (pref 'guide').
  const [format, setFormat] = useState<GuideFormat>(props.start === 'demo' ? 'demo' : 'pdf')
  const [page, setPage] = useState<'A4' | 'Letter'>(() => defaultPage())
  const [titleSource, setTitleSource] = useState<string>('offline')
  const [notesSource, setNotesSource] = useState<string>('')
  useEffect(() => {
    window.api.getPref('guide').then(
      (raw) => {
        const p = (raw ?? {}) as GuidePref
        if (p.format && props.start !== 'demo') setFormat(p.format)
        if (p.page) setPage(p.page)
        if (p.titles) setTitleSource(p.titles)
        if (p.notes) setNotesSource(p.notes)
      },
      () => undefined
    )
  }, [props.start])
  const remember = (patch: Partial<GuidePref>): void => {
    window.api
      .getPref('guide')
      .then((raw) => window.api.setPref('guide', { ...((raw ?? {}) as GuidePref), ...patch }))
      .catch(() => undefined)
  }

  // Opened as "Write a bug report": the kind is a bug report.
  useEffect(() => {
    if (props.start === 'bug' && store.state.guide?.kind !== 'bug') store.update((p) => withGuideFields(p, { kind: 'bug' }))
  }, [props.start, store])

  // Rows: numbers, titles, notes, shots, typing marks.
  const edits = useMemo(() => new Map((guide.steps ?? []).map((e) => [e.key, e])), [guide.steps])
  const ns = useMemo(() => stepNumbers(project, steps), [project, steps])
  const titles = useMemo(() => shownTitles(project, steps, ns, { scale }), [project, steps, ns, scale])
  const plans = useMemo(() => steps.map((s) => planShot(s, project, edits.get(s.key), scale, 'guide')), [steps, project, edits, scale])
  // The demo saves its own view of each step: the rows, the marks, Check screenshots and the question before a Save are about it.
  const demoAll = useMemo(() => (format === 'demo' ? steps.map((s) => planShot(s, project, edits.get(s.key), scale, 'demo')) : null), [format, steps, project, edits, scale])
  const actualPlan = useMemo(() => (guide.kind === 'bug' && guide.actualAt !== undefined ? planActual(project, guide.actualAt) : null), [guide.kind, guide.actualAt, project])
  // Shots that may show typing: the guide's (the pictures §5.3.1 sends), and the ones the format saves.
  const typed = useMemo(() => typedBefore(steps, new Map(plans.map((p) => [p.key, p])), scan, frame, runs), [steps, plans, scan, frame, runs])
  const typedShown = useMemo(() => (demoAll ? typedBefore(steps, new Map(demoAll.map((p) => [p.key, p])), scan, frame, runs) : typed), [demoAll, typed, steps, scan, frame, runs])
  const rows: Row[] = useMemo(
    () =>
      steps.map((step, index) => {
        const edit = edits.get(step.key)
        const added = guide.added?.find((a) => a.key === step.key)
        return {
          step,
          index,
          n: ns[index],
          title: titles[index],
          note: edit?.text ?? added?.text ?? stepText(steps, index, project, !!edit?.full),
          edit,
          included: stepIncluded(step, edit),
          typedIn: typedShown.get(step.key) ?? null,
          plan: plans[index],
          shot: demoAll?.[index] ?? plans[index]
        }
      }),
    [steps, edits, guide.added, ns, titles, project, typedShown, plans, demoAll]
  )
  const included = rows.filter((r) => r.included)
  const untitled = new Set(included.filter((r) => !r.title.own && needsTitle(r.title.from)).map((r) => r.step.key))
  const typedKeys = new Set(included.filter((r) => r.typedIn).map((r) => r.step.key))
  // The bug report's Actual is a whole-screen shot too.
  const wholeKeys = new Set([...included.filter((r) => r.shot.whole).map((r) => r.step.key), ...(actualPlan ? [ACTUAL_KEY] : [])])
  const said = useMemo(() => projectSaid(project), [project])

  // Screenshots: the guide's view, the demo's when the format is the demo, and the bug report's Actual.
  const guidePlans = useMemo(() => [...plans, ...(actualPlan ? [actualPlan] : [])], [plans, actualPlan])
  const shots = useGuideShots(project, track, guidePlans)
  const demoPlans = useMemo(() => (demoAll ? rows.filter((r) => r.included).map((r) => r.shot) : []), [demoAll, rows])
  const demoShots = useGuideShots(project, track, demoPlans, format === 'demo')
  /** The shots the chosen format saves: what the rows and the viewer show. */
  const viewImages = format === 'demo' ? demoShots.images : shots.images
  /** Every shot a Save or Copy shares, in the document's order: each included step's, then the bug report's Actual. */
  const shared = [...included.map((r) => r.step.key), ...(actualPlan ? [ACTUAL_KEY] : [])]
  const imageOf = (key: string): GuideImage | undefined => (key === ACTUAL_KEY ? shots.images : viewImages).get(key)

  // The live region: each message a new node, so the same words twice are read twice.
  const [saying, setSaying] = useState({ text: '', n: 0 })
  const say = useCallback((text: string) => setSaying((s) => ({ text, n: s.n + 1 })), [])
  const shotsDone = shots.total > 0 && shots.ready === shots.total
  // The progress the rows wait on: the demo's shots in the demo format.
  const pass = format === 'demo' ? demoShots : shots
  const passDone = pass.total > 0 && pass.ready === pass.total
  const wasDone = useRef(false)
  useEffect(() => {
    if (passDone && !wasDone.current) say('Screenshots ready')
    wasDone.current = passDone
  }, [passDone, say])

  // Rows drawn 20 at a time as the list scrolls.
  const [shown, setShown] = useState(ROWS_AT_A_TIME)
  const scrollRef = useRef<HTMLDivElement>(null)
  const onScroll = (): void => {
    const el = scrollRef.current
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 600 && shown < rows.length) setShown((n) => Math.min(rows.length, n + ROWS_AT_A_TIME))
  }

  // The full-size viewer and what was seen at 100% this session: each shot by what its picture
  // depends on, so the demo's whole-screen shot, or a shot made again differently, is not checked
  // by having seen another picture of the step.
  const [viewer, setViewer] = useState<{ keys: string[]; index: number; mode: 'view' | 'check' } | null>(null)
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())
  const sigs = useRef(new Map<string, string>())
  sigs.current = new Map([...rows.map((r) => [r.step.key, r.shot.sig] as const), ...(actualPlan ? [[ACTUAL_KEY, actualPlan.sig] as const] : [])])
  const isChecked = (key: string): boolean => checked.has(seenId(key, sigs.current))
  const markChecked = useCallback((key: string) => {
    const id = seenId(key, sigs.current)
    setChecked((c) => (c.has(id) ? c : new Set([...c, id])))
  }, [])
  // Adjust's picture of the whole shown frame (§5.5.3), made for the step the viewer is on.
  const [viewing, setViewing] = useState<string | null>(null)
  const framePlans = useMemo(() => {
    const r = viewer && viewing ? rows.find((x) => x.step.key === viewing) : undefined
    return r ? [planFrame(r.step, project, r.edit)] : []
  }, [viewer, viewing, rows, project])
  const frames = useGuideShots(project, track, framePlans, framePlans.length > 0)
  /** The part of the recorded frame Adjust's picture shows (pixels): its crop and ring are drawn as fractions of it. */
  const shownPart = visibleRect(frame, project.crop ?? null)

  // AI titles and notes.
  const choices = useTextChoices('names')
  const costData = useCostData()
  const titleChoice: TextChoice | null = choices.find((c) => c.id === titleSource) ?? null
  const notesChoice: TextChoice | null = choices.find((c) => c.id === notesSource) ?? choices[0] ?? null
  // Titles from the screenshots (§5.3.1, part P6): offered only with a choice that sends pictures
  // (a service or built-in provider, never On this PC), off until ticked, never remembered, and off
  // again after a run. Once the shots are made, the pictures that would go are made from them (the
  // JPEGs the send viewer shows and Send sends); the cost line counts the ones ticked at the start.
  const canSendShots = !!titleChoice?.pictures && titleChoice.kind !== 'local'
  const [sendShots, setSendShots] = useState(false)
  const shotsOn = sendShots && canSendShots
  // A choice that cannot send them (On this PC) takes the box away; it comes back off.
  useEffect(() => {
    if (!canSendShots) setSendShots(false)
  }, [canSendShots])
  const pictureList = useMemo(() => pictureSteps(project, steps), [project, steps])
  const pictureSig = pictureList.map((s) => s.key).join('|')
  // The pictures sent are the guide's shots: their marks are the guide's.
  const typedOf = typed
  const typedSig = [...typedOf].map(([k, v]) => `${k}>${v}`).join('|')
  const latestPictures = useRef({ pictureList, typedOf })
  latestPictures.current = { pictureList, typedOf }
  const shotsSettled = shotsDone || !!shots.failed
  const [pictures, setPictures] = useState<{ key: string; jpeg: Uint8Array; ticked: boolean }[] | null>(null)
  useEffect(() => {
    setPictures(null)
    if (!shotsOn || !shotsSettled) return
    let live = true
    const { pictureList: list, typedOf: typed } = latestPictures.current
    picturesToSend(list, shots.images, typed).then(
      (made) => {
        if (live) setPictures(made)
      },
      () => {
        if (live) setPictures([])
      }
    )
    return () => {
      live = false
    }
  }, [shotsOn, shotsSettled, shots.images, pictureSig, typedSig])
  const preparing = shotsOn && !pictures
  const titleRequest = useMemo(() => {
    const ticked = shotsOn && pictures ? new Map(pictures.filter((p) => p.ticked).map((p) => [p.key, p.jpeg])) : null
    const names = ticked?.size ? namesWithPictures(project, steps, ticked) : namesRequestForSteps(project, steps, 'step')
    return names.items.length ? { task: 'names' as const, segments: [], names } : null
  }, [project, steps, shotsOn, pictures])
  /** The send viewer (§5.3.1): every picture that would go, the ones ticked at the start, and their bytes. */
  const [sending, setSending] = useState<{ shots: { key: string; label: string; image: GuideImage; note?: string }[]; ticked: ReadonlySet<string>; jpegs: ReadonlyMap<string, Uint8Array> } | null>(null)
  const notesRequest = useMemo(() => {
    const names = namesRequestForSteps(project, steps, 'note')
    return names.items.length ? { task: 'names' as const, segments: [], names } : null
  }, [project, steps])
  const [busy, setBusy] = useState<{ what: 'titles' | 'notes'; requestId: string; ac: AbortController } | null>(null)
  // The question before a run (§11.5) is the cost line's: it holds a click on the buttons it names
  // and lets it through after Run, so the run itself never asks again.
  const runAi = async (what: 'titles' | 'notes', sent: ReadonlyMap<string, Uint8Array> | null = null): Promise<void> => {
    const choice = what === 'titles' ? titleChoice : notesChoice
    if (!choice || busy) return
    // Pictures only to a choice that sends them, and only those the send viewer let through.
    const pictures = what === 'titles' && sent?.size && choice.pictures && choice.kind !== 'local' ? sent : null
    const requestId = `guide-${what}-${++requestSeq}`
    const ac = new AbortController()
    setBusy({ what, requestId, ac })
    try {
      const deps = { store, steps, choice, signal: ac.signal, requestId }
      const { notice } = what === 'titles' ? await writeStepTitles({ ...deps, pictures }) : await tidyNotes(deps)
      say(notice)
    } catch (err) {
      say(ac.signal.aborted ? 'Stopped. Nothing was changed.' : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  /**
   * Write titles: with the screenshots, first the send viewer (nothing goes before Send); else, or
   * when no picture could be made, the run with the words alone (what the cost line then counts).
   */
  const writeTitles = (): void => {
    if (busy) return
    if (!shotsOn) return void runAi('titles')
    if (!pictures) return
    if (!pictures.length) return void runAi('titles')
    const byKey = new Map(rows.map((r) => [r.step.key, r]))
    setSending({
      shots: pictures.map((p) => {
        const r = byKey.get(p.key)
        const typedIn = typedOf.get(p.key)
        return { key: p.key, label: `step ${r?.n ?? ''}`, image: pictureImage(p.jpeg), ...(typedIn ? { note: typedNote(typedN(typedIn)) } : {}) }
      }),
      ticked: new Set(pictures.filter((p) => p.ticked).map((p) => p.key)),
      jpegs: new Map(pictures.map((p) => [p.key, p.jpeg]))
    })
  }
  /** Write titles' request with the pictures of `keys` (what the send viewer has ticked). */
  const requestWith = (jpegs: ReadonlyMap<string, Uint8Array>): AiTextRequest => ({ task: 'names', segments: [], names: namesWithPictures(store.state, steps, jpegs) })
  const jpegsOf = (open: NonNullable<typeof sending>, keys: readonly string[]): Map<string, Uint8Array> => new Map(keys.flatMap((k) => (open.jpegs.has(k) ? [[k, open.jpegs.get(k)!] as const] : [])))
  /** The send viewer's cost line: what the pictures still ticked would cost (§5.3.1). */
  const sendCost = (keys: readonly string[]): string => {
    const estimate = sending && titleChoice ? estimateFor(titleChoice, requestWith(jpegsOf(sending, keys)), costData) : null
    return estimate && titleChoice ? costLineText([{ label: 'Titles', estimate }], titleChoice.place, "the steps' narration", titleChoice.model, true) : ''
  }
  /**
   * The send viewer closed: Send runs with the pictures still ticked (and the box is off again);
   * Cancel sends nothing. Ticking more than the line counted asks the question before a run again
   * for the larger cost (§11.5), as the click asked it for the line's.
   */
  const sendClosed = async (result?: { send: readonly string[] }): Promise<void> => {
    const open = sending
    setSending(null)
    if (!open || !result?.send.length || !titleChoice) return
    const sent = jpegsOf(open, result.send)
    const chosen = estimateFor(titleChoice, requestWith(sent), costData)
    const counted = estimateFor(titleChoice, titleRequest, costData)
    if (chosen && (chosen.usd?.[1] ?? 0) > (counted?.usd?.[1] ?? 0) && !(await confirmCost(chosen, titleChoice))) return
    setSendShots(false)
    void runAi('titles', sent)
  }
  const stopAi = (): void => {
    if (!busy) return
    window.api.cancelAiText(busy.requestId).catch(() => undefined)
    busy.ac.abort()
  }

  // Saving and copying.
  const [saving, setSaving] = useState<'save' | 'copy' | null>(null)
  const [saved, setSaved] = useState<{ path: string; bytes: number; format: GuideFormat } | null>(null)
  const [askedCheck, setAskedCheck] = useState(false)
  const [question, setQuestion] = useState<{ kind: 'check' | 'link'; text: string; go(): void } | null>(null)
  const saveAc = useRef<AbortController | null>(null)
  useEffect(() => () => saveAc.current?.abort(), [])
  /**
   * The pictures a Save or Copy in `fmt` shares (§5.5.6): each included step's in that format's view
   * (the demo's, else the guide's) and the bug report's Actual, any not made yet made now; `missing`:
   * how many still could not be, and why.
   */
  const docImages = async (fmt: GuideFormat, signal: AbortSignal): Promise<{ images: Map<string, GuideImage>; missing: number; failed: string | null }> => {
    const demo = fmt === 'demo'
    const want = [...included.map((r) => (demo ? r.shot : r.plan)), ...(actualPlan ? [actualPlan] : [])]
    const made = new Map<string, GuideImage>()
    for (const p of want) {
      const image = (demo && p.key !== ACTUAL_KEY ? demoShots : shots).images.get(p.key)
      if (image) made.set(p.key, image)
    }
    const { images, failed } = await shotsFor(project, track, want, made, signal)
    return { images, missing: want.length - images.size, failed }
  }
  /** " 2 screenshots could not be made: …" after a Save or Copy that lacks some, else nothing. */
  const missingNote = (missing: number, failed: string | null): string => (missing ? ` ${missing} ${missing === 1 ? 'screenshot' : 'screenshots'} could not be made${failed ? `: ${failed}` : '.'}` : '')
  /** The project the document is built from: a bug report's default details with the recording's real scale. */
  const docProject = (): Project => {
    const p = store.state
    return p.guide?.kind === 'bug' && !p.guide.details ? { ...p, guide: { ...p.guide, details: defaultDetails(p, scale).map((text) => ({ text })) } } : p
  }
  /** Asks what must be asked before a Save or Copy (§2.1.2, §12 rule 3), then runs it. */
  const guarded = (run: () => void): void => {
    const unchecked = shared.filter((k) => !isChecked(k))
    const ask = askedCheck ? null : checkQuestion({ unchecked: unchecked.length, typed: unchecked.filter((k) => typedKeys.has(k)).length, whole: unchecked.filter((k) => wholeKeys.has(k)).length })
    const linkStep = (): void => {
      if (hasPrivateText(guideTexts(store.state, included), said)) setQuestion({ kind: 'link', text: LINK_QUESTION, go: run })
      else run()
    }
    if (ask) {
      setAskedCheck(true)
      setQuestion({ kind: 'check', text: ask, go: linkStep })
    } else linkStep()
  }
  const message = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
  const doSave = async (smaller = false): Promise<void> => {
    setSaving('save')
    const ac = new AbortController()
    saveAc.current = ac
    try {
      const { images, missing, failed } = await docImages(format, ac.signal)
      if (ac.signal.aborted) return
      const result = await saveGuide(format, { project: docProject(), steps, images, scale, page, signal: ac.signal, smaller })
      if (!result) return
      setSaved({ ...result, format })
      say(`Saved “${result.path.split(/[\\/]/).pop() ?? result.path}”.${missingNote(missing, failed)}`)
    } catch (err) {
      say(message(err))
    } finally {
      setSaving(null)
    }
  }
  const doCopy = async (): Promise<void> => {
    setSaving('copy')
    const ac = new AbortController()
    saveAc.current = ac
    try {
      const pictures = await docImages('html', ac.signal)
      if (ac.signal.aborted) return
      const { images } = await copyGuide({ project: docProject(), steps, images: pictures.images })
      say(`Copied the guide with ${images} ${images === 1 ? 'screenshot' : 'screenshots'}.${missingNote(pictures.missing, pictures.failed)}`)
    } catch (err) {
      say(message(err))
    } finally {
      setSaving(null)
    }
  }

  const close = (): void => {
    busy?.ac.abort()
    onClose()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Escape' || viewer || sending || question) return
    e.preventDefault()
    e.stopPropagation()
    close()
  }

  // Edits, each one update; typing in a field merges by its gesture key (§17).
  const edit = (key: string, patch: Partial<Omit<GuideStepEdit, 'key'>> | null, gesture?: string): void => store.update((p) => withStepEdit(p, key, patch), gesture)
  const field = (patch: Parameters<typeof withGuideFields>[1], gesture?: string): void => store.update((p) => withGuideFields(p, patch), gesture)
  const addStep = (): void => {
    const t = player.time
    store.update((p) => withAddedStep(p, t, 'Step'))
    say('Added a step at the playhead.')
  }
  const lastTitle = useRef<string | null>(null)
  const nextNeedingTitle = (): void => {
    const key = nextUntitled(
      included.map((r) => r.step.key),
      untitled,
      lastTitle.current
    )
    if (!key) return say('Every step has a title.')
    lastTitle.current = key
    const i = rows.findIndex((r) => r.step.key === key)
    if (i >= shown) setShown(Math.min(rows.length, i + ROWS_AT_A_TIME))
    setTimeout(() => document.getElementById(`${ids}-title-${key}`)?.focus(), 0)
    say(`Step ${rows[i].n} needs a title`)
  }
  const checkShots = (): void => {
    const order = checkOrder(
      shared.filter((k) => imageOf(k)),
      typedKeys,
      wholeKeys
    )
    if (!order.length) return say('The screenshots are not ready yet.')
    const first = Math.max(0, order.findIndex((k) => !isChecked(k)))
    setViewer({ keys: order, index: first, mode: 'check' })
  }
  const viewShot = (key: string): void => {
    const keys = shared.filter((k) => imageOf(k))
    const index = keys.indexOf(key)
    if (index >= 0) setViewer({ keys, index, mode: 'view' })
  }
  const blurStep = (r: Row): void => blurAt(r.step, !!r.edit?.after)
  /** *Blur an area…* at a step's shot (or the Actual's, as a step at its time). */
  const blurAt = (step: GuideStep, after: boolean): void => {
    blurArea(services, step, {
      after,
      scale,
      onSelect: (sel) => {
        if (sel?.kind === 'shape') group.select([itemKey('shape', sel.id)], itemKey('shape', sel.id))
      }
    })
    say(BLUR_HINT)
  }
  const blurTyped = (r: Row): void => {
    // The typing as a step (its own step may be cut or too short to be listed): the blur starts with it.
    const run = runs.find((x) => x.key === r.typedIn)
    if (!run) return
    const source: GuideStep = { key: run.key, t: run.t, kind: 'type', typing: { t: run.t, end: run.end, place: run.place } }
    blurTypedText(store, source, { t: r.plan.t }, scan, scale)
    say('Blurred the typed text.')
  }
  const copyShot = async (key: string): Promise<void> => {
    const img = viewImages.get(key)
    if (!img) return
    try {
      const png = img.mime === 'image/png' ? img.bytes : null
      if (!png) return
      await window.api.copyGuideImage(png)
      say('Copied the screenshot.')
    } catch (err) {
      say(message(err))
    }
  }

  // Why Write titles cannot run now: nothing said (unless the screenshots go), or their pictures not ready.
  const writeWhy = preparing ? PREPARING_PICTURES : shotsOn ? (pictures!.length || titleRequest ? null : NO_PICTURES) : titleRequest ? null : NOTHING_SAID
  const heading = props.start === 'demo' ? 'Click-through demo' : props.start === 'bug' ? 'Bug report' : 'Step-by-step guide'
  const usable = track.valid && track.clicks.length > 0
  const nothing = steps.length === 0
  const badgeCount = autoBadgeCount(project)
  const hasAiTitles = (guide.steps ?? []).some((e) => e.ai)
  const saveLabel = FORMATS.find((f) => f.id === format)!.save
  const plan = planOf(project)
  const vt = (t: number): string => formatTime(editToVideo(plan, viewAt(project.clips, t)), false)
  const brandExists = !!project.brand?.colors?.length
  const typedN = (key: string | null): string => (key ? (rows.find((x) => x.step.key === key)?.n ?? '') : '')

  return (
    <aside className="review-panel guide-panel" role="region" aria-labelledby={`${ids}-heading`} data-testid="guide-panel" onKeyDown={onKeyDown}>
      <div className="review-head">
        <h2 id={`${ids}-heading`}>{heading}</h2>
        <button type="button" className="btn ghost" onClick={close} data-testid="guide-close">
          Close
        </button>
      </div>
      <div className="guide-scroll" ref={scrollRef} onScroll={onScroll}>
        <section className="guide-top">
          <label className="guide-field">
            <span>Title</span>
            <input
              type="text"
              value={guide.title ?? project.name}
              maxLength={GUIDE_LIMITS.title}
              data-testid="guide-title"
              onChange={(e) => field({ title: e.target.value === project.name ? undefined : e.target.value }, 'guide-title')}
            />
          </label>
          <label className="guide-field">
            <span>Intro (optional)</span>
            <textarea value={guide.intro ?? ''} maxLength={GUIDE_LIMITS.intro} rows={2} data-testid="guide-intro" onChange={(e) => field({ intro: e.target.value || undefined }, 'guide-intro')} />
          </label>
          <div className="guide-radios" role="radiogroup" aria-label="Kind" onKeyDown={keepArrows}>
            <span className="field-label" aria-hidden="true">
              Kind
            </span>
            {(['guide', 'bug'] as const).map((k) => (
              <label key={k} className={`chip ${(guide.kind ?? 'guide') === k ? 'active' : ''}`}>
                <input type="radio" name={`${ids}-kind`} checked={(guide.kind ?? 'guide') === k} onChange={() => field({ kind: k === 'bug' ? 'bug' : undefined })} />
                {k === 'bug' ? 'Bug report' : 'Guide'}
              </label>
            ))}
          </div>
          <div className="guide-radios" role="radiogroup" aria-label="Language" onKeyDown={keepArrows}>
            <span className="field-label" aria-hidden="true">
              Language
            </span>
            {(['en', 'bn'] as const).map((l) => (
              <label key={l} className={`chip ${language === l ? 'active' : ''}`} lang={l}>
                <input type="radio" name={`${ids}-lang`} checked={language === l} onChange={() => field({ language: l })} />
                {l === 'bn' ? 'বাংলা' : 'English'}
              </label>
            ))}
          </div>
          {badgeCount > 0 && (
            <div className="guide-radios" role="radiogroup" aria-label="Steps" onKeyDown={keepArrows} data-testid="guide-from">
              <span className="field-label" aria-hidden="true">
                Steps
              </span>
              <label className={`chip ${guide.from === 'badges' ? 'active' : ''}`}>
                <input type="radio" name={`${ids}-from`} checked={guide.from === 'badges'} onChange={() => field({ from: 'badges' })} />
                {`From your step badges (${badgeCount})`}
              </label>
              <label className={`chip ${guide.from !== 'badges' ? 'active' : ''}`}>
                <input type="radio" name={`${ids}-from`} checked={guide.from !== 'badges'} onChange={() => field({ from: undefined })} />
                From every click
              </label>
            </div>
          )}
          <p className="hint">{GUIDE_NOTE}</p>
          {!usable && !nothing && (
            <p className="hint" data-testid="guide-no-clicks">
              {NO_CLICKS_NOTE}
            </p>
          )}
          {nothing && (
            <p className="hint" data-testid="guide-nothing">
              {NOTHING_NOTE}
            </p>
          )}
          {!project.transcript && project.hasAudio && <CaptionsFirst onMake={() => group.command('generateCaptions')} />}
          {steps.length >= STEP_RULES.maxSteps && <p className="hint">{TOO_MANY_NOTE}</p>}
        </section>

        {guide.kind === 'bug' && (
          <BugFields project={project} scale={scale} image={shots.images.get(ACTUAL_KEY) ?? null} onField={field} onActual={() => field({ actualAt: player.time })} onView={() => viewShot(ACTUAL_KEY)} />
        )}

        <ol className="guide-steps" aria-label="Steps" data-testid="guide-steps">
          {rows.slice(0, shown).map((r) => (
            <StepRow
              key={r.step.key}
              row={r}
              ids={ids}
              time={vt(r.step.t)}
              image={viewImages.get(r.step.key) ?? null}
              demo={format === 'demo'}
              said={said}
              typedN={typedN(r.typedIn)}
              onEdit={(patch, gesture) => edit(r.step.key, patch, gesture)}
              onGo={() => player.seek(r.plan.t)}
              onView={() => viewShot(r.step.key)}
              onBlur={() => blurStep(r)}
              onBlurTyped={() => blurTyped(r)}
              onCopy={() => void copyShot(r.step.key)}
              onFull={() => edit(r.step.key, { full: true, text: undefined })}
            />
          ))}
        </ol>

        <section className="guide-under">
          <button type="button" className="btn" onClick={addStep} data-testid="guide-add">
            Add a step at the playhead
          </button>
          <p className="guide-count" data-testid="guide-count">
            {stepsLine({ steps: rows.length, hidden: rows.length - included.length, untitled: untitled.size, typed: typedKeys.size })}
          </p>
          {pass.total > 0 && (
            <div className="guide-progress" role="progressbar" aria-label="Making screenshots" aria-valuemin={0} aria-valuemax={pass.total} aria-valuenow={pass.ready} aria-valuetext={`${pass.ready} of ${pass.total}`}>
              <div style={{ width: `${(100 * pass.ready) / Math.max(1, pass.total)}%` }} />
            </div>
          )}
          {pass.failed && <p className="hint guide-error">{`Could not make the screenshots: ${pass.failed}`}</p>}
          <div className="guide-buttons">
            <button type="button" className="btn ghost" onClick={nextNeedingTitle} data-testid="guide-next-untitled">
              Next step without a title
            </button>
            <button type="button" className="btn ghost" onClick={checkShots} data-testid="guide-check">
              Check screenshots
            </button>
          </div>
        </section>

        <section className="guide-ai" aria-label="Titles and notes">
          <div className="guide-radios" role="radiogroup" aria-label="Titles" onKeyDown={keepArrows}>
            <span className="field-label" aria-hidden="true">
              Titles
            </span>
            <label className={`chip ${!titleChoice ? 'active' : ''}`}>
              <input
                type="radio"
                name={`${ids}-titles`}
                checked={!titleChoice}
                onChange={() => {
                  setTitleSource('offline')
                  remember({ titles: 'offline' })
                }}
                data-testid="guide-titles-offline"
              />
              From what you said (offline)
            </label>
            {choices.length > 0 && (
              <label className={`chip ${titleChoice ? 'active' : ''}`}>
                <input
                  type="radio"
                  name={`${ids}-titles`}
                  checked={!!titleChoice}
                  onChange={() => {
                    setTitleSource(choices[0].id)
                    remember({ titles: choices[0].id })
                  }}
                  data-testid="guide-titles-ai"
                />
                Write them with
              </label>
            )}
          </div>
          {titleChoice && (
            <div className="guide-ai-row">
              <select
                aria-label="Write titles with"
                value={titleChoice.id}
                onChange={(e) => {
                  setTitleSource(e.target.value)
                  remember({ titles: e.target.value })
                }}
              >
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn"
                id={`${ids}-write`}
                disabled={!!busy || !!writeWhy}
                aria-describedby={writeWhy ? `${ids}-write-why` : `${ids}-titles-cost-titles`}
                onClick={writeTitles}
                data-testid="guide-write-titles"
              >
                {busy?.what === 'titles' ? 'Writing…' : 'Write titles'}
              </button>
              <LocalProgress requestId={busy?.what === 'titles' ? busy.requestId : null} onStop={stopAi} returnFocus={`${ids}-write`} />
            </div>
          )}
          {canSendShots && (
            <label className="guide-check">
              <input type="checkbox" checked={shotsOn} disabled={!!busy} onChange={(e) => setSendShots(e.target.checked)} data-testid="guide-send-shots" />
              {SEND_SHOTS_LABEL}
            </label>
          )}
          {titleChoice && writeWhy && (
            <p className="hint" id={`${ids}-write-why`} data-testid="guide-write-why">
              {writeWhy}
            </p>
          )}
          {titleChoice && <CostLine id={`${ids}-titles-cost`} choice={titleChoice} actions={[{ key: 'titles', label: 'Titles', buttonId: `${ids}-write`, request: titleRequest }]} />}
          {hasAiTitles && (
            <button type="button" className="btn ghost" onClick={() => store.update(withoutAiTitles)} data-testid="guide-offline-titles">
              Use offline titles
            </button>
          )}
          {notesChoice && (
            <>
              <div className="guide-ai-row">
                <button
                  type="button"
                  className="btn"
                  id={`${ids}-tidy`}
                  disabled={!notesRequest || !!busy}
                  aria-describedby={`${ids}-notes-cost-notes`}
                  onClick={() => void runAi('notes')}
                  data-testid="guide-tidy"
                >
                  {busy?.what === 'notes' ? 'Tidying…' : 'Tidy notes with'}
                </button>
                <select
                  aria-label="Tidy notes with"
                  value={notesChoice.id}
                  onChange={(e) => {
                    setNotesSource(e.target.value)
                    remember({ notes: e.target.value })
                  }}
                >
                  {choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <LocalProgress requestId={busy?.what === 'notes' ? busy.requestId : null} onStop={stopAi} returnFocus={`${ids}-tidy`} />
              </div>
              <CostLine id={`${ids}-notes-cost`} choice={notesChoice} actions={[{ key: 'notes', label: 'Notes', buttonId: `${ids}-tidy`, request: notesRequest }]} />
            </>
          )}
        </section>

        <section className="guide-format">
          <div className="guide-radios" role="radiogroup" aria-label="Format" onKeyDown={keepArrows} data-testid="guide-format">
            <span className="field-label" aria-hidden="true">
              Format
            </span>
            {FORMATS.map((f) => (
              <label key={f.id} className={`chip ${format === f.id ? 'active' : ''}`}>
                <input
                  type="radio"
                  name={`${ids}-format`}
                  checked={format === f.id}
                  onChange={() => {
                    setFormat(f.id)
                    remember({ format: f.id })
                  }}
                />
                {f.label}
              </label>
            ))}
          </div>
          {format === 'pdf' && (
            <label className="guide-field">
              <span>Page size</span>
              <select
                value={page}
                onChange={(e) => {
                  const v = e.target.value === 'Letter' ? 'Letter' : 'A4'
                  setPage(v)
                  remember({ page: v })
                }}
                data-testid="guide-page"
              >
                <option value="A4">A4</option>
                <option value="Letter">Letter</option>
              </select>
            </label>
          )}
          {brandExists && (
            <label className="guide-check">
              <input type="checkbox" checked={guide.brand !== false} onChange={(e) => field({ brand: e.target.checked ? undefined : false })} />
              Use the brand kit
            </label>
          )}
          {format === 'demo' && <EndScreen project={project} onField={field} />}
        </section>

        <p className="guide-said" role="status" aria-live="polite" aria-atomic="true" data-testid="guide-said">
          <span key={saying.n}>{saying.text}</span>
        </p>
        {saved && (
          <div className="guide-saved" data-testid="guide-saved">
            <button type="button" className="btn ghost" onClick={() => void window.api.showGuideFile(saved.path).catch(() => undefined)}>
              Show in folder
            </button>
            {(saved.format === 'html' || saved.format === 'demo') && saved.bytes > BIG_FILE && (
              <p className="hint">
                {`This file is ${Math.round(saved.bytes / 1e6)} MB: too big for some email. `}
                <button type="button" className="btn ghost small" onClick={() => void doSave(true)}>
                  Make it smaller
                </button>
              </p>
            )}
          </div>
        )}
      </div>
      <div className="guide-foot">
        <button type="button" className="btn primary" disabled={!!saving || nothing} onClick={() => guarded(() => void doSave())} data-testid="guide-save">
          {saving === 'save' ? 'Saving…' : saveLabel}
        </button>
        <button type="button" className="btn" disabled={!!saving || nothing} onClick={() => guarded(() => void doCopy())} data-testid="guide-copy">
          Copy guide
        </button>
        <button type="button" className="btn ghost" onClick={close}>
          Close
        </button>
      </div>
      {viewer && (
        <ShotViewer
          shots={viewer.keys.flatMap((k): ViewerShot[] => {
            if (k === ACTUAL_KEY) return actualPlan ? [{ key: k, label: 'Actual', title: 'The Actual screenshot', image: shots.images.get(k) ?? null }] : []
            const r = rows.find((x) => x.step.key === k)
            if (!r) return []
            // A shot being made again after an edit keeps its place in the list (the viewer says so).
            const image = viewImages.get(k) ?? null
            const whole = frames.images.get(k)
            const point = r.step.x !== undefined && r.step.y !== undefined ? { x: r.step.x, y: r.step.y } : (r.step.place ?? null)
            const ring = r.edit?.ring ?? (r.plan.ring ? point : null)
            return [
              {
                key: k,
                label: `step ${r.n}`,
                image,
                ...(whole
                  ? {
                      adjust: {
                        frame: whole,
                        rect: rectInShown(r.edit?.rect ?? { x: r.plan.rect.x / frame.w, y: r.plan.rect.y / frame.h, w: r.plan.rect.w / frame.w, h: r.plan.rect.h / frame.h }, frame, shownPart),
                        ring: ring ? pointInShown(ring, frame, shownPart) : null
                      }
                    }
                  : {})
              }
            ]
          })}
          index={viewer.index}
          mode={viewer.mode}
          total={shared.length}
          checked={shared.filter(isChecked).length}
          onShown={markChecked}
          onAt={setViewing}
          onClose={() => setViewer(null)}
          onBlur={(key) => {
            setViewer(null)
            const r = rows.find((x) => x.step.key === key)
            if (r) blurStep(r)
            else if (key === ACTUAL_KEY && actualPlan) blurAt({ key, t: actualPlan.t, kind: 'added' }, false)
          }}
          onAdjust={(key, e) => {
            edit(key, e ? { rect: e.rect ? rectFromShown(e.rect, frame, shownPart) : undefined, ring: e.ring ? pointFromShown(e.ring, frame, shownPart) : undefined } : { rect: undefined, ring: undefined })
            say(e ? 'Adjusted the screenshot.' : 'The screenshot is zoomed to the click again.')
          }}
        />
      )}
      {sending && (
        <ShotViewer
          shots={sending.shots}
          index={0}
          mode="send"
          place={titleChoice?.place}
          ticked={sending.ticked}
          onClose={(result) => void sendClosed(result)}
          sendCost={sendCost}
          onBlur={() => undefined}
          onAdjust={() => undefined}
        />
      )}
      {question && (
        // The link question after Save anyway is a new dialog: it opens on its own Go back, never on
        // the Save anyway the first one left focused.
        <GuideQuestion
          key={question.kind}
          question={question}
          onClose={() => setQuestion(null)}
          onCheck={() => {
            setQuestion(null)
            checkShots()
          }}
        />
      )}
    </aside>
  )
}

/** "Make captions first" with Make captions and Use clicks only (§2.1). */
function CaptionsFirst({ onMake }: { onMake(): void }): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  return (
    <div className="hint guide-captions-first" data-testid="guide-captions-first">
      <p>{MAKE_CAPTIONS_NOTE}</p>
      <button type="button" className="btn small" onClick={onMake}>
        Make captions
      </button>
      <button type="button" className="btn small ghost" onClick={() => setDismissed(true)}>
        Use clicks only
      </button>
    </div>
  )
}

/** One step's row (§2.1.1, §14). */
function StepRow(props: {
  row: Row
  ids: string
  time: string
  image: GuideImage | null
  demo: boolean
  said: ReturnType<typeof projectSaid>
  typedN: string
  onEdit(patch: Partial<Omit<GuideStepEdit, 'key'>> | null, gesture?: string): void
  onGo(): void
  onView(): void
  onBlur(): void
  onBlurTyped(): void
  onCopy(): void
  onFull(): void
}): JSX.Element {
  const { row: r, ids, onEdit } = props
  const key = r.step.key
  const url = useMemo(
    () => (props.image && typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(new Blob([new Uint8Array(props.image.bytes)], { type: props.image.mime })) : null),
    [props.image]
  )
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])
  const n = r.n || String(r.index + 1)
  const untitled = !r.title.own && needsTitle(r.title.from)
  const typingStep = !!r.step.typing
  const ai = !!(r.title.ai || r.edit?.textAi)
  const typedChip = r.typedIn ? typedNote(props.typedN) : ''
  const chips = [untitled ? 'needs a title' : '', typedChip && `m${typedChip.slice(1)}`, ai ? 'written by AI' : '', r.shot.whole ? 'whole screen' : ''].filter(Boolean)
  const name = [`Step ${n}`, props.time, ...(r.included ? [] : ['left out']), ...chips].join(', ')
  const flagged = (text: string): boolean => !!text && (notedPieces(text, props.said).length > 0 || pathLike(text))
  const linkNote = flagged(r.title.title) || flagged(r.note) || flagged(r.edit?.type ?? '') ? `${ids}-link-${key}` : undefined
  return (
    <li className={`guide-step ${r.included ? '' : 'left-out'}`} role="group" aria-label={name} data-step={key} data-testid="guide-step">
      <div className="guide-step-head">
        <label className="guide-check">
          <input
            type="checkbox"
            checked={r.included}
            aria-label={`Include step ${n}`}
            onChange={(e) => onEdit(r.step.hiddenByDefault ? { shown: e.target.checked ? true : undefined, hidden: undefined } : { hidden: e.target.checked ? undefined : true })}
            data-testid="guide-include"
          />
          <span className="guide-num" aria-hidden="true">
            {r.n}
          </span>
        </label>
        <button type="button" className="btn ghost small" onClick={props.onGo} data-testid="guide-goto">
          {`Go to ${props.time}`}
        </button>
      </div>
      <button type="button" className="guide-shot" aria-label={`View screenshot for step ${n} full size`} aria-busy={!url} disabled={!url} onClick={props.onView} data-testid="guide-shot">
        {url ? <img src={url} alt={`Screenshot for step ${n}`} /> : <span className="guide-shot-wait">Making the screenshot…</span>}
      </button>
      {r.plan.outside && <p className="hint">{OUTSIDE_NOTE}</p>}
      {chips.length > 0 && (
        <p className="guide-chips" aria-hidden="true">
          {untitled && <span className="guide-chip warn">Needs a title</span>}
          {r.typedIn && <span className="guide-chip warn">{typedChip}</span>}
          {ai && <span className="guide-chip">AI</span>}
          {r.shot.whole && <span className="guide-chip">Whole screen</span>}
        </p>
      )}
      <input
        id={`${ids}-title-${key}`}
        className="guide-input"
        type="text"
        aria-label={`Title of step ${n}`}
        aria-describedby={linkNote}
        maxLength={GUIDE_LIMITS.stepTitle}
        value={r.title.title}
        onChange={(e) => onEdit({ title: e.target.value }, `guide-title:${key}`)}
        data-testid="guide-step-title"
      />
      {typingStep && (
        <input
          className="guide-input"
          type="text"
          aria-label={`What to type in step ${n} (optional)`}
          aria-describedby={linkNote}
          maxLength={GUIDE_LIMITS.stepType}
          value={r.edit?.type ?? ''}
          onChange={(e) => onEdit({ type: e.target.value || undefined }, `guide-type:${key}`)}
          data-testid="guide-step-type"
        />
      )}
      <textarea
        className="guide-input"
        aria-label={`What to know about step ${n} (optional)`}
        aria-describedby={linkNote}
        maxLength={GUIDE_LIMITS.stepText}
        rows={2}
        value={r.note}
        onChange={(e) => onEdit({ text: e.target.value }, `guide-text:${key}`)}
        data-testid="guide-step-note"
      />
      {linkNote && (
        <p className="hint guide-link-note" id={linkNote} role="note">
          This step has a link, address or file name nobody said. Check it before you share the guide.
        </p>
      )}
      <div className="guide-step-buttons">
        <button type="button" className="btn ghost small" onClick={props.onFull} data-testid="guide-full">
          Use everything I said
        </button>
        <button type="button" className="btn ghost small" aria-pressed={!!r.edit?.whole} onClick={() => onEdit({ whole: r.edit?.whole ? undefined : true })} data-testid="guide-whole">
          Whole screen
        </button>
        {props.demo && (
          <button type="button" className="btn ghost small" aria-pressed={!!r.edit?.demoZoom} onClick={() => onEdit({ demoZoom: r.edit?.demoZoom ? undefined : true })}>
            Zoom to the click in the demo
          </button>
        )}
        {typingStep && (
          <button
            type="button"
            className="btn ghost small"
            aria-pressed={!!r.edit?.after}
            aria-describedby={`${ids}-typed-hint-${key}`}
            onClick={() => onEdit({ after: r.edit?.after ? undefined : true })}
            data-testid="guide-after"
          >
            Show the screen after typing
          </button>
        )}
        {typingStep && (
          <span className="hint" id={`${ids}-typed-hint-${key}`}>
            {TYPED_HINT}
          </span>
        )}
        <button type="button" className="btn ghost small" onClick={props.onBlur} data-testid="guide-blur">
          Blur an area…
        </button>
        {r.typedIn && (
          <button type="button" className="btn ghost small" onClick={props.onBlurTyped} data-testid="guide-blur-typed">
            Blur the typed text
          </button>
        )}
        <button type="button" className="btn ghost small" disabled={!props.image} onClick={props.onCopy} data-testid="guide-copy-shot">
          Copy screenshot
        </button>
      </div>
    </li>
  )
}

/** The bug report's fields (§2.1): Expected, Actual, the Actual screenshot and the details. */
function BugFields(props: {
  project: Project
  scale: number
  image: GuideImage | null
  onField(patch: Parameters<typeof withGuideFields>[1], gesture?: string): void
  onActual(): void
  onView(): void
}): JSX.Element {
  const g = props.project.guide ?? {}
  const url = useMemo(
    () => (props.image && typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(new Blob([new Uint8Array(props.image.bytes)], { type: props.image.mime })) : null),
    [props.image]
  )
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])
  const details: { text: string; off?: true }[] = g.details ?? defaultDetails(props.project, props.scale).map((text) => ({ text }))
  const setDetail = (i: number, next: { text: string; off?: true }, gesture?: string): void => props.onField({ details: details.map((d, k) => (k === i ? next : d)) }, gesture)
  return (
    <section className="guide-bug" aria-label="Bug report" data-testid="guide-bug">
      <label className="guide-field">
        <span>Expected</span>
        <textarea placeholder="What should happen" value={g.expected ?? ''} maxLength={GUIDE_LIMITS.expected} rows={2} onChange={(e) => props.onField({ expected: e.target.value || undefined }, 'guide-expected')} data-testid="guide-expected" />
      </label>
      <label className="guide-field">
        <span>Actual</span>
        <textarea placeholder="What happens instead" value={g.actual ?? ''} maxLength={GUIDE_LIMITS.actual} rows={2} onChange={(e) => props.onField({ actual: e.target.value || undefined }, 'guide-actual-text')} data-testid="guide-actual-text" />
      </label>
      <div className="guide-step-buttons">
        <button type="button" className="btn small" onClick={props.onActual} data-testid="guide-actual">
          Show the screen at the playhead as Actual
        </button>
        {g.actualAt !== undefined && (
          <button type="button" className="btn ghost small" onClick={() => props.onField({ actualAt: undefined })} data-testid="guide-actual-remove">
            Remove
          </button>
        )}
      </div>
      {g.actualAt !== undefined && (
        <button type="button" className="guide-shot" aria-label="View the Actual screenshot full size, whole screen" aria-busy={!url} disabled={!url} onClick={props.onView} data-testid="guide-actual-shot">
          {url ? <img src={url} alt="Actual screenshot" /> : <span className="guide-shot-wait">Making the screenshot…</span>}
        </button>
      )}
      <div className="guide-details" role="group" aria-label="Details">
        <span className="field-label" aria-hidden="true">
          Details
        </span>
        {details.map((d, i) => (
          <div key={i} className="guide-detail">
            <input type="checkbox" aria-label={`Include detail ${i + 1}`} checked={!d.off} onChange={(e) => setDetail(i, { text: d.text, ...(e.target.checked ? {} : { off: true as const }) })} data-testid="guide-detail-on" />
            <input type="text" className="guide-input" aria-label={`Detail ${i + 1}`} value={d.text} maxLength={GUIDE_LIMITS.detail} onChange={(e) => setDetail(i, { text: e.target.value, ...(d.off ? { off: true as const } : {}) }, `guide-detail:${i}`)} data-testid="guide-detail" />
          </div>
        ))}
      </div>
    </section>
  )
}

/** The demo's end screen (§6.1): a disclosure with its heading, button label and https link. */
function EndScreen(props: { project: Project; onField(patch: Parameters<typeof withGuideFields>[1], gesture?: string): void }): JSX.Element {
  const end = props.project.guide?.end
  const [open, setOpen] = useState(!!end)
  const [url, setUrl] = useState(end?.url ?? '')
  const set = (patch: Partial<{ heading: string; label: string; url: string }>, gesture?: string): void => {
    // The link as the field shows it: one typed before the heading is not stored yet.
    const next = { heading: end?.heading ?? '', ...(end?.label ? { label: end.label } : {}), ...(url.trim() ? { url: url.trim() } : {}), ...patch }
    if (!next.label) delete (next as { label?: string }).label
    if (!next.url) delete (next as { url?: string }).url
    props.onField({ end: next.heading.trim() ? next : undefined }, gesture)
  }
  const bad = url.trim() !== '' && !/^https:\/\/\S+$/i.test(url.trim())
  return (
    <div className="guide-end">
      <button type="button" className="btn ghost small" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="guide-end-toggle">
        End screen
      </button>
      {open && (
        <div className="guide-end-fields">
          <label className="guide-field">
            <span>Heading</span>
            <input type="text" value={end?.heading ?? ''} maxLength={GUIDE_LIMITS.endHeading} onChange={(e) => set({ heading: e.target.value }, 'guide-end-heading')} data-testid="guide-end-heading" />
          </label>
          <label className="guide-field">
            <span>Button label</span>
            <input type="text" value={end?.label ?? ''} maxLength={GUIDE_LIMITS.endLabel} onChange={(e) => set({ label: e.target.value }, 'guide-end-label')} data-testid="guide-end-label" />
          </label>
          <label className="guide-field">
            <span>Link</span>
            <input
              type="url"
              value={url}
              placeholder="https://"
              aria-invalid={bad}
              onChange={(e) => {
                setUrl(e.target.value)
                set({ url: e.target.value.trim() }, 'guide-end-url')
              }}
              data-testid="guide-end-url"
            />
          </label>
          {bad && <p className="hint guide-error">Use an https:// link.</p>}
        </div>
      )}
    </div>
  )
}

/** The questions before Save or Copy (§2.1.2, §12 rule 3): an alert dialog with the safe choice focused. */
function GuideQuestion(props: { question: { kind: 'check' | 'link'; text: string; go(): void }; onClose(): void; onCheck(): void }): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const safeRef = useRef<HTMLButtonElement>(null)
  // Tab stays inside, Esc goes back, and the focus returns to Save or Copy when it closes.
  useModalFocus(boxRef, props.onClose)
  useEffect(() => {
    safeRef.current?.focus()
  }, [])
  const { question } = props
  const anyway = (): void => {
    props.onClose()
    question.go()
  }
  return (
    <div className="overlay modal-backdrop">
      <div
        className="modal guide-question"
        role="alertdialog"
        aria-modal="true"
        aria-label={question.kind === 'check' ? 'Check the screenshots' : 'Check the guide'}
        aria-describedby="guide-question-text"
        ref={boxRef}
        data-testid="guide-question"
      >
        <p id="guide-question-text">{question.text}</p>
        <footer className="modal-foot">
          {question.kind === 'check' ? (
            <>
              <button type="button" className="btn primary" ref={safeRef} onClick={props.onCheck} data-testid="guide-check-now">
                Check now
              </button>
              <button type="button" className="btn" onClick={anyway} data-testid="guide-save-anyway">
                Save anyway
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn primary" ref={safeRef} onClick={props.onClose} data-testid="guide-go-back">
                Go back
              </button>
              <button type="button" className="btn" onClick={anyway} data-testid="guide-link-anyway">
                Save anyway
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
