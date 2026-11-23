import { OPEN_SETTINGS_EVENT, SettingsButton } from '../settings/SettingsButton'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { LoadedProject } from '../../../shared/api'
import type { DuplicateProgress } from '../../../shared/api/projects'
import { openedWithoutStems, withRecordedStems } from '../../../shared/audio/settings'
import { captionsOf } from '../../../shared/captions/settings'
import { createAnnotation } from '../../../shared/editor/annotations'
import { Autosaver } from '../../../shared/editor/autosave'
import { canSplitAt, clipAt, correctProjectMedia, displayTime, restoreRange, stepOutput } from '../../../shared/editor/clips'
import { commandInfo, commandTitle, paletteCommands, type CommandId } from '../../../shared/editor/commands'
import { currentUiInfo, noteProjectLanguages, showLanguageSection } from '../i18n/boot'
import { cropNotice, setCrop, setZoomLevelInView, snapCrop, taskbarCrop, type CropDraft } from '../../../shared/editor/cropEdit'
import { directUnavailable } from '../../../shared/editor/directorCopy'
import { FREEZE_REFUSAL_TEXT, freezeRefusal, removeFreeze } from '../../../shared/editor/freezeEdit'
import { canCopyAs, type CopyKind } from '../../../shared/editor/duplicate'
import { editorFrame, followsAction, holdViewAt, withFollowing } from '../../../shared/editor/followEdit'
import { clickAtPlayhead, ignoreStrayClicks, pathSummary, setClicksIgnored, setPathRange, setStraighten, useAllClicks, type PathSummary } from '../../../shared/editor/inputEdits'
import { EditStore } from '../../../shared/editor/editStore'
import { copyItems as copyGroupItems, duplicateItems as duplicateGroupItems, pasteItems as pasteGroupItems, pasteNotice, type PasteResult } from '../../../shared/editor/groupClipboard'
import { applyField, copyLook, deleteItems, GROUP_FIELDS, LOOK_CLASS_WORDS, lookClassOf, pasteLook, type FieldCtx } from '../../../shared/editor/groupEdit'
import { NO_GROUP, parseItemKey, projectItems, selectAllStep, trackOfKind, validGroup, type ItemGroup, type ItemKey, type ItemTrack } from '../../../shared/editor/multiSelect'
import { copyLookFirst, nothingCopiedNotice, removedNotice, selectAllNotice } from '../../../shared/editor/multiSelectCopy'
import { layoutRefusal, setLayoutAt } from '../../../shared/editor/layoutCommands'
import { removeLayout } from '../../../shared/editor/layouts'
import { mediaLength } from '../../../shared/editor/mediaLength'
import { polishButtonTitle, polishNotice } from '../../../shared/editor/polishCopy'
import { UNTITLED, withSavedName } from '../../../shared/editor/projectName'
import {
  chordFromEvent,
  commandKeys,
  DEFAULT_KEYMAP,
  isSliderKey,
  keymapFromPrefs,
  keymapOverrides,
  matchShortcut,
  serializeShortcuts,
  shortcutIndex,
  shortcutLabel,
  standardEditCommand,
  withShortcut,
  zoomLevelKeysHint,
  reviewHint,
  undoHint,
  type Keymap
} from '../../../shared/editor/shortcuts'
import { atOutputStart, nextPreviewSpeed, type ShuttleKey } from '../../../shared/editor/shuttle'
import { clampIntoCrop, cropOf, cropView, fromCrop, FULL_FRAME, type CropView } from '../../../shared/engine/crop'
import { privateView } from '../../../shared/privacy/spoken'
import { coverCommands } from '../privacy/coverCommands'
import { FindDialog } from '../privacy/FindDialog'
import { confirmLeaveFind } from '../privacy/readerState'
import { SmoothedTrack } from '../../../shared/engine/cursor'
import { clamp } from '../../../shared/engine/math'
import { NO_PATHS, planCursorPath } from '../../../shared/engine/cursorPath'
import { clickRows } from '../../../shared/engine/inputData'
import { frameView } from '../../../shared/engine/frameView'
import { outputSize } from '../../../shared/engine/layout'
import { canFollow, isTall, withoutFollow } from '../../../shared/engine/reframeData'
import { DEFAULT_EFFECTS } from '../../../shared/engine/project'
import { scrollBreaks } from '../../../shared/engine/scroll'
import { openedWithoutCamera, withRecordedCamera } from '../../../shared/engine/webcamData'
import { cutRange, keptBounds, outputDuration, removeClip, splitAt } from '../../../shared/engine/timeline'
import { nextChapter, previousChapter } from '../../../shared/editor/titles'
import { settleDeletedWords } from '../../../shared/editor/transcript'
import { ZOOM_LEVEL_PRESETS } from '../../../shared/editor/zoomEdit'
import { effectiveTrack } from '../../../shared/engine/inputTrack'
import { focusPathFor, insertZoom, zoomAt, zoomSettingsOf, zoomStyleOf } from '../../../shared/engine/zoom'
import type { CameraLayout, NormRect, PathMode, Project, ShapeKind, Spotlight, ZoomFocus, ZoomSegment } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { CommandPalette, SearchIcon, type PaletteEntry } from '../editor/CommandPalette'
import { CopyMenu, CopyProgress } from '../editor/CopyMenu'
import { cancelCaptionsGreatFor } from '../editor/captionsGreat'
import { EditorContext, type EditorServices } from '../editor/context'
import { CropBar, type CropTool } from '../editor/CropEditor'
import { EditorIcon } from '../editor/EditorIcon'
import { runDuplicate } from '../editor/duplicateFlow'
import { ExportDialog } from '../editor/ExportDialog'
import { blurActiveControl, installFocusRelease, isKeyboardToggle, isRangeInput, isTextEntry, releaseFocus } from '../editor/focus'
import { keepInspectorFocus } from '../editor/inspectorFocus'
import { addFreezeAt, freezeTarget, toggleFreezeSound } from '../editor/freezeItems'
import { itemClipboard, lookClipboard } from '../editor/itemClipboard'
import { Inspector, type InputActions, type InspectorTab } from '../editor/Inspector'
import { KeymapContext } from '../editor/keymapContext'
import { showLayout } from '../editor/LayoutTrack'
import { createVideo, loadImage } from '../editor/media'
import { PreviewPlayer } from '../editor/player'
import { releaseContrastSource, setContrastSource, type ContrastSource } from '../render/contrastProbe'
import { addMagnifierAt, addShapeAt, addSpotlightAt } from '../editor/playheadItems'
import { withChapterBar } from '../../../shared/render/chapterBar'
import { FollowEnvContext, type FollowEnv } from '../editor/panels/FollowSection'
import { PolishDialog } from '../editor/PolishDialog'
import { ReviewButton } from '../review/ReviewButton'
import { settleAutoCuts } from '../../../shared/review/autoCuts'
import { settleJoins } from '../../../shared/editor/joinsEdit'
import { cutCommands } from '../editor/cutCommands'
import { calloutCommands } from '../editor/calloutCommands'
import { settleGrade } from '../../../shared/editor/colourEdit'
import { autoColourBusy, startAutoColour, stopAutoColour } from '../editor/autoColourRun'
import { toggleCompare } from '../editor/compareColour'
import { ReviewPanel } from '../review/ReviewPanel'
import { PreviewStage } from '../editor/PreviewStage'
import { SaveIndicator } from '../editor/SaveIndicator'
import { groupKeyOf, selectionOfKey, validSelection, type Selection } from '../editor/selection'
import { GroupContext, type GroupApi } from '../editor/groupContext'
import { ShortcutKeys } from '../editor/ShortcutKeys'
import { ShortcutsDialog } from '../editor/ShortcutsDialog'
import { snapPref } from '../editor/snapControl'
import { addChapterAt, addTitleAt, brandFontFor } from '../editor/titleItems'
import { OverlayDropZone } from '../editor/OverlayDropZone'
import { ipcMessage, noteItemCopy, pasteClipboardImage } from '../editor/overlayItems'
import { requestCaptions, type CaptionsAiTask } from '../editor/captionItems'
import { aiCaptionCommands, captionCommands } from '../editor/captionCommands'
import { usePreviewLook } from '../editor/previewLook'
import { settleCaptionAuto } from '../../../shared/captions/captionAutoSettle'
import { Timeline, type TimelineHandle } from '../editor/Timeline'
import { Transport } from '../editor/Transport'
import { videoTrackDuration } from '../editor/videoTrack'
import { safeZoneChoice, toggleSafeZones as toggleSafeZoneChoice } from '../editor/safeZonePref'
import { setWaveformShown, waveformShown } from '../editor/waveformPref'
// E-12 versions, E-07 filmstrip, E-09 nudge (docs/design/versions.md).
import { filmstripShown, setFilmstripShown } from '../editor/filmstripPref'
import { nudgeSelected } from '../editor/nudgeCommand'
import { restoreVersion } from '../../../shared/editor/versions'
import { changedFilesNotice, missingFilesNotice } from '../../../shared/editor/versionWords'
import { NUDGE_STEPS, nudgeInstead } from '../../../shared/editor/shortcuts'
import type { ReadVersion } from '../../../shared/api/versions'
import { keepVersionBefore } from '../versions/autoVersion'
import { VersionsDialog } from '../versions/VersionsDialog'
import { VersionsIcon } from '../versions/VersionsIcon'
import type { RenderScene } from '../render/compositor'
import { noCursorText } from '../../../shared/import/imported'
import '../editor/editor.css'
import { PublishDialog } from '../publish/PublishDialog'
import { GuidePanel } from '../guide/GuidePanel'
import { ShortClipsPanel } from '../clips/ShortClipsPanel'
import { ShortVersionDialog } from '../clips/ShortVersionDialog'
import { settleChapters } from '../../../shared/chapters/chapterAuto'
import { fmt } from '../../../shared/i18n/fmt'
import { t, type MessageKey } from '../../../shared/i18n/t'
import { askConfirm } from '../i18n/askConfirm'
import { requestFindChapters } from '../editor/smartRequests'
import type { PublishKind } from '../../../shared/publish/pack'
import { useSearchMoment } from '../search/useSearchMoment'

interface Session {
  data: LoadedProject
  store: EditStore<Project>
  saver: Autosaver<Project>
  player: PreviewPlayer
  /** The preview's frame for the contrast meter (Captions Studio §7.3), registered while the session is open. */
  contrast: ContrastSource
}

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; session: Session }

const METADATA_TIMEOUT_MS = 20000

/** How a reason a cursor move keeps its recorded path is counted: a plural message on `count`. */
const KEPT_NOUN: Record<keyof PathSummary['kept'], MessageKey> = {
  drag: 'editor.path.kept.drag',
  'drag-guess': 'editor.path.kept.dragGuess',
  click: 'editor.path.kept.click',
  scroll: 'editor.path.kept.scroll',
  'off-frame': 'editor.path.kept.offFrame',
  short: 'editor.path.kept.short',
  long: 'editor.path.kept.long',
  small: 'editor.path.kept.small',
  wobbly: 'editor.path.kept.wobbly',
  gesture: 'editor.path.kept.gesture'
}

/** "No cursor move here can be straightened (1 drag, 1 move across a click)", without the brackets when no move was kept for a reason. */
function nothingToStraighten(summary: PathSummary): string {
  const parts = (Object.keys(KEPT_NOUN) as (keyof PathSummary['kept'])[])
    .filter((k) => (summary.kept[k] ?? 0) > 0)
    .map((k) => {
      const n = summary.kept[k]!
      return t(KEPT_NOUN[k], { count: n, n: fmt.count(n) })
    })
  return parts.length ? t('editor.path.nothingToStraightenWhy', { reasons: parts.join(', ') }) : t('editor.path.nothingToStraighten')
}

/** Resolves once the video's duration and size are known (or after a timeout); rejects if it cannot load. */
function whenMetadata(v: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (v.readyState >= 1) return resolve()
    const timer = window.setTimeout(done, METADATA_TIMEOUT_MS)
    function done(): void {
      window.clearTimeout(timer)
      v.removeEventListener('loadedmetadata', done)
      v.removeEventListener('error', fail)
      resolve()
    }
    function fail(): void {
      window.clearTimeout(timer)
      v.removeEventListener('loadedmetadata', done)
      v.removeEventListener('error', fail)
      reject(new Error(t('editor.open.videoNotLoaded', { detail: v.error?.message || t('editor.open.unsupported') })))
    }
    v.addEventListener('loadedmetadata', done)
    v.addEventListener('error', fail)
  })
}

async function openSession(projectId: string): Promise<Session> {
  const data = await window.api.loadProject(projectId)
  const screen = createVideo(data.screenUrl)
  const webcam = data.webcamUrl ? createVideo(data.webcamUrl) : null
  // Read in parallel with the element's metadata; never rejects.
  const videoLength = videoTrackDuration(data.screenUrl)
  try {
    await whenMetadata(screen)
  } catch (err) {
    for (const v of [screen, webcam]) v?.removeAttribute('src')
    throw err
  }
  // Correct duration and size from the file before anything (or any undo step) depends on them.
  // The video track's length, not screen.duration: that is the container's, which includes a longer audio track.
  const duration = mediaLength(data.project.duration, await videoLength, screen.duration)
  // Without its stems when one of their files is missing; saves keep them, so they are used again once the file is back.
  // Likewise without its camera when the camera file is missing (its layouts then leave the screen be).
  const opened = openedWithoutCamera(openedWithoutStems(data.project, data.missingStems), !data.webcamUrl)
  const project = correctProjectMedia(opened, { duration, width: screen.videoWidth, height: screen.videoHeight })
  // A project with captions or a transcript in a shipped language tells Home's offer what the user works in (output-and-languages §2.7).
  noteProjectLanguages(project)
  // Words deleted in the Transcript tab keep their mark only while they are cut (edit-by-text.md §4.2);
  // then automatic caption changes become the user's when edited by hand, and marks, word anchors and
  // per-caption places follow their words (Captions Studio §11.8). Review mode (E-02): records of
  // automatic cuts whose change is gone are dropped. Each is part of the edit's undo step.
  // Editing polish's settle steps last (docs/design/editing-polish.md §11), then smart tools' found
  // chapters (docs/design/smart-tools.md §13.2): each returns `next` itself when nothing applies.
  const store = new EditStore(project, undefined, undefined, undefined, (next: Project, prev: Project) =>
    settleChapters(settleGrade(settleJoins(settleAutoCuts(settleCaptionAuto(settleDeletedWords(next, prev), prev), prev), prev), prev), prev)
  )
  const recorded = (p: Project): Project => withRecordedCamera(withRecordedStems(withSavedName(p), data.project), data.project)
  const saver = new Autosaver(store, {
    save: (p, meta) => window.api.saveProject(recorded(p), meta),
    saveSync: (p, meta) => window.api.saveProjectSync(recorded(p), meta)
  })
  if (project !== opened) saver.markDirty()
  const player = new PreviewPlayer(screen, webcam, project, data.missingStems)
  const contrast: ContrastSource = () => player.pausedFrame()
  setContrastSource(contrast)
  return { data, store, saver, player, contrast }
}

function closeSession(s: Session): void {
  // A Make my captions great run on this project stops with it (its provider's request too).
  cancelCaptionsGreatFor(s.store)
  // So does Auto colour (it changes nothing then).
  stopAutoColour()
  // Work still holding the project (Review mode's Remove all) makes its edit now, to be saved, and
  // what waits for it is done (before the player goes: a waiting Keep stops the panel's stretch).
  try {
    s.store.finish()
  } finally {
    releaseContrastSource(s.contrast)
    s.player.dispose()
    // Normally already flushed by Back; this covers any other way the editor goes away.
    if (s.saver.dirty) void s.saver.flush().finally(() => s.saver.dispose())
    else s.saver.dispose()
  }
}

export function Editor({
  projectId,
  onClose,
  onOpenProject,
  notice
}: {
  projectId: string
  onClose: () => void
  /** Opens another project in place of this one (a copy just made, or its original), with a notice to show there (docs/design/vertical-video.md §9.3). */
  onOpenProject?: (id: string, notice?: string) => void
  /** A notice to show once the project is open (after Make a vertical version or Duplicate). */
  notice?: string
}): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  // Storage manager (F-26): an open recording counts as used and is never cleaned up.
  useEffect(() => (window.api.storageNoteOpened(projectId), () => window.api.storageNoteClosed(projectId)), [projectId])

  useEffect(() => {
    let disposed = false
    let session: Session | null = null
    setState({ kind: 'loading' })
    openSession(projectId)
      .then((s) => {
        if (disposed) return closeSession(s)
        session = s
        setState({ kind: 'ready', session: s })
      })
      .catch((err: unknown) => {
        if (!disposed) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      disposed = true
      if (session) closeSession(session)
    }
  }, [projectId])

  if (state.kind === 'error') {
    return (
      <div className="app">
        <header className="titlebar">
          <button className="btn ghost" onClick={onClose}>
            <Icon name="back" /> {t('common.action.back')}
          </button>
        </header>
        <div className="center-message error">{t('editor.open.failed', { reason: state.message })}</div>
      </div>
    )
  }

  if (state.kind === 'loading') {
    return (
      <div className="app">
        <div className="overlay">
          <div className="spinner" />
          <p>{t('editor.open.loading')}</p>
        </div>
      </div>
    )
  }

  return <EditorSession session={state.session} onClose={onClose} onOpenProject={onOpenProject} openingNotice={notice} />
}

/**
 * What the editor's components read from context: the session's services, the current shortcuts,
 * the selected group and what the Vertical framing section needs besides the project.
 */
function EditorProviders({
  services,
  keymap,
  group,
  follow,
  children
}: {
  services: EditorServices
  keymap: Keymap
  group: GroupApi
  follow: FollowEnv
  children: ReactNode
}): JSX.Element {
  return (
    <EditorContext.Provider value={services}>
      <KeymapContext.Provider value={keymap}>
        <GroupContext.Provider value={group}>
          <FollowEnvContext.Provider value={follow}>{children}</FollowEnvContext.Provider>
        </GroupContext.Provider>
      </KeymapContext.Provider>
    </EditorContext.Provider>
  )
}

/** Following works only in a frame narrower than the recording (docs/design/vertical-video.md §2.11). */
const FOLLOW_UNAVAILABLE: MessageKey = 'editor.follow.unavailable'
/** Hold the view here while the frame could follow but does not. */
const FOLLOW_OFF: MessageKey = 'editor.follow.off'
/** The safe zones are shown over tall frames only (§2.8). */
const SAFE_ZONES_TALL: MessageKey = 'editor.notice.safeZonesTall'
/** Every copy error starts so (§2.3): "Could not make the copy: …". */
const copyFailed = (reason: string): string => t('editor.copy.failed', { reason })

/** A notice in the transport: its text, a button in it (Open original), and whether it is an error (role alert). */
interface Notice {
  text: string
  action?: { label: string; run: () => void }
  alert?: boolean
}

function EditorSession({
  session,
  onClose,
  onOpenProject,
  openingNotice
}: {
  session: Session
  onClose: () => void
  onOpenProject?: (id: string, notice?: string) => void
  /** Shown once when the editor opens (a copy just made). */
  openingNotice?: string
}): JSX.Element {
  const { data, store, saver, player } = session
  const project = useSyncExternalStore(store.subscribe, store.getSnapshot)
  // Undo and Redo for the title bar's buttons: also while work holds the project (Review mode's
  // Remove all), when they wait for its edit (docs/design/review-mode.md §4.3).
  const canUndo = useSyncExternalStore(store.subscribeHistory, () => store.canUndo)
  const canRedo = useSyncExternalStore(store.subscribeHistory, () => store.canRedo)
  const services = useMemo<EditorServices>(() => ({ store, player }), [store, player])
  // cursor.json as recorded; never changed. Everything that shows or uses input reads `cursor`:
  // the recording with the project's input edits (ignored clicks, straightened moves) applied.
  const recorded = data.cursor
  const { inputEdits, capture, width, height } = project
  const cursor = useMemo(() => effectiveTrack(recorded, { inputEdits, capture, width, height }), [recorded, inputEdits, capture, width, height])
  // Every recorded click, with its ignore state: the timeline markers and the click lists.
  const rows = useMemo(() => clickRows(recorded, inputEdits), [recorded, inputEdits])
  // What the timeline explains: the straightened moves (only when Flown draws the cursor) and the
  // long scrolls auto zoom zooms out for.
  const straighten = !!inputEdits?.straighten
  const paths = inputEdits?.paths
  const pathBars = useMemo(
    () => (recorded.valid && !capture.cursorInVideo && (straighten || paths) ? planCursorPath(recorded, { aspect: width / height, straighten, paths: paths ?? NO_PATHS }).straightened : []),
    [recorded, capture.cursorInVideo, straighten, paths, width, height]
  )
  const { zoomSettings, autoZoom } = project
  const autoSettings = useMemo(() => zoomSettingsOf({ zoomSettings, autoZoom }).auto, [zoomSettings, autoZoom])
  const scrollBands = useMemo(() => scrollBreaks(cursor, autoSettings), [cursor, autoSettings])

  const [rawSelection, setRawSelection] = useState<Selection>(null)
  const [revealSeq, setRevealSeq] = useState(0)
  // E-06: several items selected together (docs/design/multi-select.md §4.1, §8). Two or more keys,
  // only while there is no single selection; items that are gone (undo, delete) drop out.
  const [rawGroup, setRawGroup] = useState<ItemGroup>(NO_GROUP)
  const [groupReveal, setGroupReveal] = useState(0)
  const groupStamp = useRef(0)
  const g0 = useMemo(() => validGroup(rawGroup, project), [rawGroup, project])
  const collapsed = useMemo(() => (g0.keys.length === 1 ? selectionOfKey(g0.keys[0]) : null), [g0])
  const selection = collapsed ?? validSelection(rawSelection, project)
  const group = g0.keys.length >= 2 ? g0 : NO_GROUP
  // Every selection made the way it always was ends a group.
  const setSelection = useCallback((sel: Selection) => {
    setRawSelection(sel)
    setRawGroup(NO_GROUP)
    if (sel) setRevealSeq((n) => n + 1)
  }, [])
  /** Selects items by key: none clears, one is the single selection, two or more a group (shown in the Inspector unless `reveal` is false). */
  const selectKeys = useCallback(
    (keys: readonly ItemKey[], anchor: ItemKey | null, opts?: { reveal?: boolean }) => {
      const unique = [...new Set(keys)]
      if (unique.length === 0) return setSelection(null)
      if (unique.length === 1) {
        if (opts?.reveal !== false) return setSelection(selectionOfKey(unique[0]))
        setRawSelection(selectionOfKey(unique[0]))
        setRawGroup(NO_GROUP)
        return
      }
      setRawSelection(null)
      setRawGroup({ keys: unique, anchor: anchor && unique.includes(anchor) ? anchor : unique[unique.length - 1], stamp: ++groupStamp.current })
      if (opts?.reveal !== false) setGroupReveal((n) => n + 1)
    },
    [setSelection]
  )
  const [pickFocus, setPickFocus] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [background, setBackground] = useState<HTMLImageElement | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const timelineRef = useRef<TimelineHandle>(null)
  const [tab, setTab] = useState<InspectorTab>('style')
  const [dialog, setDialog] = useState<'palette' | 'shortcuts' | 'polish' | 'publish' | 'versions' | 'saveVersion' | 'shortVersion' | 'findPrivate' | null>(null)
  // NW-13: the item a palette command asked the Publish dialog to write.
  const [publishRequest, setPublishRequest] = useState<{ kind: PublishKind; n: number } | null>(null)
  const [smartSpeedRequest, setSmartSpeedRequest] = useState(0)
  // E-02 Review mode (docs/design/review-mode.md): the panel over the Inspector, and its button.
  const [reviewOpen, setReviewOpen] = useState(false)
  /**
   * Smart tools' docked panels (docs/design/smart-tools.md §2.1, §2.4), in Review mode's place: at
   * most one panel is open, so opening one closes Review and the other.
   */
  const [smartPanel, setSmartPanel] = useState<{ kind: 'guide'; start: 'guide' | 'demo' | 'bug' } | { kind: 'clips' } | null>(null)
  const guideButton = useRef<HTMLButtonElement>(null)
  const openGuide = useCallback((start: 'guide' | 'demo' | 'bug'): void => {
    setReviewOpen(false)
    setSmartPanel({ kind: 'guide', start })
  }, [])
  const openClips = useCallback((): void => {
    setReviewOpen(false)
    setSmartPanel({ kind: 'clips' })
  }, [])
  const reviewButton = useRef<HTMLButtonElement>(null)
  // When the panel closes under the focus (a command that shows an Inspector tab), the focus goes to
  // its button, as Esc does. Run after the unmount cleanups: a palette closing with it has given the
  // focus back to where it was, which then keeps it.
  const reviewWasOpen = useRef(false)
  useEffect(() => {
    const active = document.activeElement
    if (reviewWasOpen.current && !reviewOpen && (!active || active === document.body)) reviewButton.current?.focus()
    reviewWasOpen.current = reviewOpen
  }, [reviewOpen])
  const [directorRequest, setDirectorRequest] = useState(0)

  // The background image always follows the project state, including undo/redo.
  // `backgroundVersion` reloads it when a newly picked file reuses the same name.
  const [backgroundVersion, setBackgroundVersion] = useState(0)
  const backgroundPath = project.style.background.type === 'image' ? project.style.background.path : null
  useEffect(() => {
    if (!backgroundPath) {
      setBackground(null)
      return
    }
    let cancelled = false
    window.api
      .backgroundUrl(store.state.id, backgroundPath)
      .then((url) => (url ? loadImage(url) : null))
      .then((img) => !cancelled && setBackground(img))
      .catch(() => !cancelled && setBackground(null))
    return () => {
      cancelled = true
    }
  }, [store, backgroundPath, backgroundVersion])

  /* ---------- scene + preview ---------- */

  // The crop being edited (the crop tool is open); Done applies it as one undo step.
  const [cropDraft, setCropDraft] = useState<CropDraft | null>(null)
  const cropping = !!cropDraft
  // What is drawn: the project and input as shown (cropView: positions relative to the crop, its
  // pixel size). While the crop tool is open, the whole recording without the camera (nor camera
  // layouts) and without following the action; setNoZoom below leaves zooms and the tilt out.
  // Texts made from captions are drawn from the private view (auto-blur §7.5): the stored project itself without private bleeps.
  const drawn = useMemo((): CropView<Project> => {
    if (!cropping) return cropView(privateView(project), cursor)
    const { crop: _crop, ...whole } = privateView(project)
    return { project: withoutFollow({ ...whole, webcam: { ...project.webcam, show: false } }), cursor, crop: null }
  }, [cropping, project, cursor])
  const cursorPath = useMemo(() => new SmoothedTrack(drawn.cursor.samples, project.duration, project.cursor.smoothing), [drawn.cursor.samples, project.duration, project.cursor.smoothing])
  const focusPath = useMemo(() => focusPathFor(drawn.cursor.samples, project.duration), [drawn.cursor.samples, project.duration])
  const scene: RenderScene = useMemo(
    () => ({ project: drawn.project, cursor: drawn.cursor, cursorPath, focusPath, ...(drawn.crop ? { crop: drawn.crop } : {}) }),
    [drawn, cursorPath, focusPath]
  )
  // The scene new step badges and speech bubbles are placed in (calloutCommands, editing polish §2.3).
  const calloutScene = useRef(scene)
  calloutScene.current = scene
  // A caption look hovered or focused in the gallery shows on the preview only (Captions Studio
  // §2.5): the export, the project and the undo stack never see it.
  const previewLook = usePreviewLook()
  const previewScene: RenderScene = useMemo(() => (previewLook ? { ...scene, project: { ...scene.project, captions: previewLook.captions } } : scene), [scene, previewLook])

  useEffect(() => player.setProject(project), [player, project])
  useEffect(() => player.setScene(previewScene, background), [player, previewScene, background])
  const sceneRef = useRef(scene)
  sceneRef.current = scene
  // The frame as drawn: a tall one gets the safe-zone toggle (docs/design/vertical-video.md §2.8).
  const drawnOut = outputSize(drawn.project.style.aspectRatio, drawn.project.width, drawn.project.height, 1080)
  const tall = isTall(drawnOut.width, drawnOut.height)

  const pickZoom =
    pickFocus && selection?.kind === 'zoom' ? (project.zooms.find((z) => z.id === selection.id && z.focus.mode !== 'cursor') ?? null) : null
  useEffect(() => {
    player.setNoZoom(!!pickZoom || cropping)
    if (pickFocus && !pickZoom) setPickFocus(false)
  }, [player, pickFocus, pickZoom, cropping])
  // Picking applies to the zoom it was started for; selecting anything else ends it.
  const selectedZoomId = selection?.kind === 'zoom' ? selection.id : null
  useEffect(() => setPickFocus(false), [selectedZoomId])

  const selectedAnnotation = selection?.kind === 'annotation' ? (project.annotations.find((a) => a.id === selection.id) ?? null) : null

  /* ---------- notices ---------- */

  const noticeTimer = useRef(0)
  const noticeMs = useRef(4000)
  /** Shows `message` for a few seconds; `opts`: a button in it, an error (role alert), a longer time. */
  const showNotice = useCallback((message: string, opts?: { action?: Notice['action']; alert?: boolean; ms?: number }) => {
    setNotice({ text: message, ...(opts?.action ? { action: opts.action } : {}), ...(opts?.alert ? { alert: true } : {}) })
    noticeMs.current = opts?.ms ?? 4000
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), noticeMs.current)
  }, [])
  /** A notice with a button (Open original) stays while the pointer is over it or focus is in it, then shows for its time again. */
  const holdNotice = useCallback((held: boolean) => {
    window.clearTimeout(noticeTimer.current)
    if (!held) noticeTimer.current = window.setTimeout(() => setNotice(null), noticeMs.current)
  }, [])
  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])
  // Opened from a search result on Home: start at its moment (docs/design/search.md §2.10).
  useSearchMoment(store, player, showNotice)

  /* ---------- leaving, copies and the original (docs/design/vertical-video.md §2.3) ---------- */

  const leavingRef = useRef(false)
  /** Leaves the editor the way Back does: pauses, waits for the save (asking when it failed), then `then`. */
  const leave = useCallback(
    async (then: () => void): Promise<void> => {
      if (leavingRef.current) return
      leavingRef.current = true
      setLeaving(true)
      player.pause()
      // Work still holding the project (Review mode's Remove all, docs/design/review-mode.md §4.3)
      // makes its edit first, and what waits for it is done; then the save, so the library shows
      // the latest name and nothing is lost.
      await new Promise<void>((done) => store.whenFree(done))
      // Find private info, while it runs, asks first and applies what it found (auto-blur §2.6).
      if (!(await confirmLeaveFind(services))) {
        leavingRef.current = false
        setLeaving(false)
        return
      }
      const saved = await saver.flush()
      const status = saver.status
      // Asked through askConfirm (output-and-languages §9.6): window.confirm in English, main's message box in another language.
      const question = status.state === 'error' ? t('editor.leave.unsavedWhy', { reason: status.message }) : t('editor.leave.unsaved')
      if (!saved && !(await askConfirm(question, 'editor.leave.action'))) {
        leavingRef.current = false
        setLeaving(false)
        return
      }
      then()
    },
    [player, saver, store, services]
  )

  /** Opens the project this one was copied from, unless it is gone from the library. */
  const openOriginal = useCallback(async (): Promise<void> => {
    const original = store.state.copyOf
    if (!original || !onOpenProject) return
    const list = await window.api.listProjects().catch(() => null)
    if (list && !list.some((p) => p.id === original.id)) return showNotice(t('editor.notice.originalGone'))
    await leave(() => onOpenProject(original.id))
  }, [store, onOpenProject, showNotice, leave])

  // A copy just made opens with its notice and Open original; a vertical or square one shows
  // Style › Vertical framing (§2.1).
  const [followReveal, setFollowReveal] = useState(0)
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || !openingNotice) return
    opened.current = true
    const original = store.state.copyOf
    showNotice(openingNotice, { ms: 12000, ...(original && onOpenProject ? { action: { label: t('editor.notice.openOriginal'), run: () => void openOriginal() } } : {}) })
    if (original && store.state.reframe?.mode === 'follow') {
      setTab('style')
      setFollowReveal((n) => n + 1)
    }
  }, [openingNotice, store, onOpenProject, openOriginal, showNotice])

  // The copy being made: its kind and progress (the progress window shows after 0.5 s), and how to stop it.
  const [copy, setCopy] = useState<{ kind: CopyKind; progress: DuplicateProgress | null } | null>(null)
  const copyAbort = useRef<AbortController | null>(null)
  /** Duplicate, Make a vertical version, Make a square version: the copy is made, then opened in place of this project. */
  const makeCopy = useCallback(
    async (kind: CopyKind): Promise<void> => {
      if (copyAbort.current) return showNotice(t('editor.copy.busy'), { alert: true })
      // The copy is of the project with the edit of work still holding it (Review mode's Remove all), made now.
      store.finish()
      const p = store.state
      const { vw, vh } = editorFrame(p)
      const can = canCopyAs(p, kind, vw, vh)
      if (!can.ok) return showNotice(can.reason)
      player.pause()
      const abort = new AbortController()
      copyAbort.current = abort
      setCopy({ kind, progress: null })
      // When the save failed, the question is asked here, through askConfirm (output-and-languages §9.6),
      // so a translated UI can wait for main's message box; runDuplicate's own question, which must
      // answer at once, then passes that answer on.
      let makeAnyway = true
      try {
        const made = await runDuplicate(kind, {
          project: store.state,
          stored: data.project,
          flush: async () => {
            if (await saver.flush()) return true
            if (!abort.signal.aborted) makeAnyway = await askConfirm(t('editor.copy.unsaved'), 'editor.copy.makeAnyway')
            return false
          },
          confirm: () => makeAnyway,
          onProgress: (progress) => setCopy((c) => (c ? { ...c, progress } : c)),
          signal: abort.signal
        })
        // Cancelled, or not confirmed: nothing to say.
        if (!made) return
        // E-12: the edit the copy was made from (`p`) is kept as a version, once there is a copy
        // (docs/design/versions.md §2.4): a cancelled or failed copy never takes an automatic slot.
        if (kind !== 'copy') void keepVersionBefore(p, kind)
        if (onOpenProject) onOpenProject(made.id, made.notice)
        else showNotice(made.notice)
      } catch (err) {
        const message = ipcMessage(err)
        showNotice(message.startsWith(copyFailed('')) ? message : copyFailed(message), { alert: true, ms: 8000 })
      } finally {
        copyAbort.current = null
        setCopy(null)
      }
    },
    [data, store, player, saver, showNotice, onOpenProject]
  )

  /* ---------- shortcuts (stored in the editor preferences) ---------- */

  const [keymap, setKeymap] = useState<Keymap>(DEFAULT_KEYMAP)
  const shortcuts = useMemo(() => shortcutIndex(keymap), [keymap])
  useEffect(() => {
    let cancelled = false
    window.api
      .getPref('shortcuts')
      .then((raw) => !cancelled && setKeymap(keymapFromPrefs(raw)))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  const changeKeymap = useCallback(
    (next: Keymap) => {
      setKeymap(next)
      const stored = Object.keys(keymapOverrides(next)).length ? serializeShortcuts(next) : null
      window.api.setPref('shortcuts', stored).catch((err: unknown) => {
        showNotice(t('editor.notice.shortcutsNotSaved', { reason: (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }))
      })
    },
    [showNotice]
  )

  /* ---------- edit actions (stable; they read the store, not render-time values) ---------- */

  const latest = useRef({ selection, group, tab, pickFocus, exporting, dialog, keymap, shortcuts, copying: false, reviewOpen })
  latest.current = { selection, group, tab, pickFocus, exporting, dialog, keymap, shortcuts, copying: !!copy, reviewOpen }


  /** Edits to the recorded input: each one store.update (one undo step), with its notice. */
  const input = useMemo((): InputActions => {
    const at = (ms: number): string => fmt.clock(ms / 1000)
    const range = (r: { start: number; end: number }): string => t('timeline.range', { start: fmt.clock(r.start), end: fmt.clock(r.end) })
    const undo = (): string => undoHint(latest.current.keymap)
    return {
      setIgnored: (keys, ignore) => {
        const before = store.state
        store.update((p) => setClicksIgnored(p, recorded, ignore ? { ignore: keys.map((ms) => ({ ms })) } : { use: keys }))
        if (store.state === before || keys.length === 0) return
        const count = { count: keys.length, n: fmt.count(keys.length) }
        if (keys.length > 1) showNotice(ignore ? `${t('editor.clicks.ignored', count)}${undo()}` : t('editor.clicks.usedAgain', count))
        else showNotice(ignore ? `${t('editor.clicks.oneIgnored', { time: at(keys[0]) })}${undo()}` : t('editor.clicks.oneUsedAgain', { time: at(keys[0]) }))
      },
      findStray: () => {
        let added = 0
        store.update((p) => {
          const r = ignoreStrayClicks(p, recorded)
          added = r.added.length
          return r.project
        })
        showNotice(added ? `${t('editor.clicks.strayIgnored', { count: added, n: fmt.count(added) })}${undo()}` : t('editor.clicks.noStray'))
      },
      useAll: () => {
        const n = clickRows(recorded, store.state.inputEdits).filter((r) => r.ignored).length
        if (!n) return showNotice(t('editor.clicks.noneIgnored'))
        store.update((p) => useAllClicks(p, recorded))
        showNotice(t('editor.clicks.allUsedAgain', { count: n, n: fmt.count(n) }))
      },
      setStraighten: (on) => store.update((p) => setStraighten(p, on)),
      setPathRange: (r, mode) => {
        if (mode === 'straight') {
          // Painting a range that straightens nothing would only add an undo step: say why instead.
          const next = setPathRange(store.state, r, 'straight')
          const summary = pathSummary(recorded, next, r)
          if (!summary.straightened) return showNotice(nothingToStraighten(summary))
          store.update((p) => setPathRange(p, r, 'straight'))
          return showNotice(t('editor.path.straightened', { count: summary.straightened, n: fmt.count(summary.straightened), range: range(r) }))
        }
        store.update((p) => setPathRange(p, r, mode))
        showNotice(mode === 'recorded' ? t('editor.path.keptRecorded', { range: range(r) }) : t('editor.path.followsStraighten', { range: range(r) }))
      },
      selectClick: (ms) => {
        setSelection({ kind: 'click', ms })
        // Just past the click, so its effect shows on the preview (never into a cut).
        const t = ms / 1000 + 0.15
        if (clipAt(store.state.clips, t)) player.seek(t)
      }
    }
  }, [recorded, store, player, showNotice, setSelection])

  const actions = useMemo(() => {
    const newZoomFocus = (): ZoomFocus => {
      if (cursor.valid) return { mode: 'cursor' }
      // The centre of the part of the recording that is shown, stored in the whole frame.
      const at = fromCrop(cropOf(store.state), { x: 0.5, y: 0.5 })
      return { mode: 'fixed', x: at.x, y: at.y }
    }

    // Zooms and text go on the frame the preview shows at `t` (in a cut, the next kept one), like
    // shapes (playheadItems.ts): placed at a cut's source time they would never be seen.
    const addZoomAt = (at: number, lead: number): void => {
      const p = store.state
      const r = insertZoom(p.zooms, displayTime(p.clips, at), p.duration, { lead, focus: newZoomFocus(), scale: zoomSettingsOf(p).defaultScale })
      if (r.ok) {
        store.update((q) => ({ ...q, zooms: r.zooms }))
        setSelection({ kind: 'zoom', id: r.id })
      } else if (r.reason === 'inside') {
        setSelection({ kind: 'zoom', id: r.id })
        showNotice(t('editor.notice.zoomHere'))
      } else {
        showNotice(t('editor.notice.noRoomToAddZoom'))
      }
    }

    const addTextAt = (t: number): void => {
      const p = store.state
      const a = createAnnotation(displayTime(p.clips, t), p.duration, brandFontFor(p, 'text'))
      store.update((q) => ({ ...q, annotations: [...q.annotations, a] }))
      setSelection({ kind: 'annotation', id: a.id })
      if (player.time < a.start || player.time >= a.end) player.seek(a.start)
    }

    // Placed and shown exactly as from the Shapes panel and the timeline.
    const addShape = (kind: ShapeKind): void => void addShapeAt({ store, player }, kind, cursor, { onSelect: setSelection })
    const addSpotlight = (mode: Spotlight['mode']): void => void addSpotlightAt({ store, player }, mode, { onSelect: setSelection })

    const deleteClip = (id: string): void => {
      if (store.state.clips.length <= 1) {
        showNotice(t('editor.notice.lastClip'))
        return
      }
      store.update((p) => ({ ...p, clips: removeClip(p.clips, id) }))
      setSelection(null)
    }

    const cut = (start: number, end: number): void => {
      const p = store.state
      const next = cutRange(p.clips, start, end)
      if (next === p.clips) {
        showNotice(t('editor.notice.keepSome'))
        return
      }
      if (Math.abs(outputDuration(next) - outputDuration(p.clips)) < 1e-6) {
        showNotice(t('editor.notice.alreadyCut'))
        return
      }
      store.update((q) => ({ ...q, clips: next }))
      setSelection(null)
    }

    /** Zoom level commands: level of the selected zoom (else the zoom under the playhead). */
    const setZoomLevelKey = (level: number): void => {
      const group = latest.current.group
      if (group.keys.length >= 2) {
        // E-06: every selected zoom (made yours, as one edit).
        const zooms = group.keys.filter((k) => k.startsWith('zoom:'))
        if (!zooms.length) return showNotice(t('editor.notice.noZoomSelected'))
        const ctx: FieldCtx = { crop: cropOf(store.state), cursorValid: cursor.valid, style: zoomStyleOf(store.state), background: store.state.style.background }
        store.update((q) => applyField(q, GROUP_FIELDS.find((f) => f.id === 'zoom.level')!, zooms, level, ctx).project)
        return showNotice(t('editor.notice.zoomLevelFor', { level: fmt.factor(level), count: zooms.length, n: fmt.count(zooms.length) }))
      }
      const sel = latest.current.selection
      const p = store.state
      const z = sel?.kind === 'zoom' ? p.zooms.find((x) => x.id === sel.id) : zoomAt(p.zooms, player.time)
      if (!z) {
        const keys = zoomLevelKeysHint(latest.current.keymap)
        showNotice(keys ? t('editor.notice.selectZoomKeys', { keys }) : t('editor.reason.selectZoom'))
        return
      }
      store.update((q) => ({ ...q, zooms: q.zooms.map((x) => (x.id === z.id ? setZoomLevelInView(cropOf(q), x, level) : x)) }))
      if (sel?.kind !== 'zoom') setSelection({ kind: 'zoom', id: z.id })
    }

    /** Chapter commands: moves the playhead to the next (or previous) chapter. */
    const goToChapter = (next: boolean): void => {
      const { chapters = [], clips } = store.state
      const c = next ? nextChapter(chapters, player.time, clips) : previousChapter(chapters, player.time, clips)
      if (c) return player.seek(c.t)
      const key = latest.current.keymap.addChapter[0]
      if (chapters.length) showNotice(next ? t('editor.notice.noChapterAfter') : t('editor.notice.noChapterBefore'))
      else showNotice(key ? t('editor.notice.noChaptersKey', { keys: shortcutLabel(key) }) : t('editor.notice.noChapters'))
    }

    /** Camera layout commands: the layout at the playhead (a new layout segment, or the one there changes). */
    const setLayout = (layout: CameraLayout): void => {
      if (!data.webcamUrl) return showNotice(t('editor.reason.noCamera'))
      const r = setLayoutAt(store.state, layout, player.time)
      if (!r.ok) {
        if (r.id) setSelection({ kind: 'layout', id: r.id })
        showNotice(layoutRefusal(r.reason, layout))
        return
      }
      store.update((q) => ({ ...q, layouts: r.layouts }))
      setSelection({ kind: 'layout', id: r.id })
      // A new change starts at the playhead, where it has not changed anything yet: show it.
      if (r.added) showLayout(player, store.state, r.id)
    }

    return {
      togglePlay: (): void => player.toggle(),
      addShape,
      addSpotlight,
      addZoomAt,
      addZoom: (): void => addZoomAt(player.time, zoomSettingsOf(store.state).transition),
      setZoomLevelKey,
      addZoomFromTrack: (t: number): void => addZoomAt(t, 0),
      addTextAt,
      addText: (): void => addTextAt(player.time),
      addTitle: (): void => void addTitleAt({ store, player }, { onSelect: setSelection }),
      addChapter: (): void => void addChapterAt({ store, player }, { onSelect: setSelection, onNotice: showNotice }),
      freezeFrame: (): void => addFreezeAt({ store, player }, { onSelect: setSelection, onNotice: showNotice }),
      toggleFreezeSound: (): void => toggleFreezeSound({ store, player }, latest.current.selection, { onSelect: setSelection, onNotice: showNotice }),
      goToChapter,
      setLayout,
      split: (): void => {
        const at = player.time
        const clips = store.state.clips
        if (!canSplitAt(clips, at)) {
          showNotice(clipAt(clips, at) ? t('editor.reason.splitEdge') : t('editor.notice.splitInCut'))
          return
        }
        store.update((p) => ({ ...p, clips: splitAt(p.clips, at) }))
      },
      deleteClip,
      cut,
      restore: (start: number, end: number): void => {
        store.update((p) => ({ ...p, clips: restoreRange(p.clips, start, end, p.duration) }))
        setSelection(null)
      },
      restoreAll: (): void => {
        const before = store.state
        store.update((p) => {
          const c = p.clips
          if (c.length === 1 && c[0].start === 0 && c[0].end === p.duration && c[0].speed === 1) return p
          return { ...p, clips: [{ id: c[0].id, start: 0, end: p.duration, speed: 1 }] }
        })
        if (store.state === before) showNotice(t('editor.reason.nothingCut'))
        else setSelection(null)
      },
      cutSelectedRange: (): void => {
        const sel = latest.current.selection
        if (sel?.kind === 'range') cut(sel.start, sel.end)
        else showNotice(t('editor.reason.selectRange'))
      },
      deleteSelection: (): void => {
        // The panel that had the keyboard may go with what it showed (§5.2).
        keepInspectorFocus()
        const group = latest.current.group
        if (group.keys.length >= 2) {
          // E-06: every selected item, in one undo step.
          const keys = group.keys
          store.update((p) => deleteItems(p, keys))
          setSelection(null)
          return showNotice(removedNotice('Deleted', keys.length, undoHint(latest.current.keymap)))
        }
        const sel = latest.current.selection
        if (!sel) return
        if (sel.kind === 'zoom') store.update((p) => ({ ...p, zooms: p.zooms.filter((z) => z.id !== sel.id) }))
        else if (sel.kind === 'annotation') store.update((p) => ({ ...p, annotations: p.annotations.filter((a) => a.id !== sel.id) }))
        else if (sel.kind === 'shape') store.update((p) => ({ ...p, shapes: (p.shapes ?? []).filter((s) => s.id !== sel.id) }))
        else if (sel.kind === 'spotlight') store.update((p) => ({ ...p, spotlights: (p.spotlights ?? []).filter((s) => s.id !== sel.id) }))
        else if (sel.kind === 'layout') store.update((p) => ({ ...p, layouts: removeLayout(p.layouts, sel.id) }))
        else if (sel.kind === 'title') store.update((p) => ({ ...p, titles: (p.titles ?? []).filter((s) => s.id !== sel.id) }))
        else if (sel.kind === 'chapter') store.update((p) => ({ ...p, chapters: (p.chapters ?? []).filter((s) => s.id !== sel.id) }))
        else if (sel.kind === 'caption')
          store.update((p) => (p.transcript ? { ...p, transcript: { ...p.transcript, segments: p.transcript.segments.filter((s) => s.id !== sel.id) } } : p))
        else if (sel.kind === 'freeze') store.update((p) => removeFreeze(p, sel.id))
        else if (sel.kind === 'overlay') store.update((p) => ({ ...p, overlays: (p.overlays ?? []).filter((o) => o.id !== sel.id) }))
        else if (sel.kind === 'clip') return deleteClip(sel.id)
        else if (sel.kind === 'range') return cut(sel.start, sel.end)
        else if (sel.kind === 'click') {
          // Delete on a click ignores it; the click stays selected, so the Zoom panel shows its new state.
          const row = clickRows(recorded, store.state.inputEdits).find((r) => r.ms === sel.ms)
          if (row?.ignored) return showNotice(t('editor.clicks.alreadyIgnored'))
          return input.setIgnored([sel.ms], true)
        } else return
        setSelection(null)
      },
      undo: (): void => {
        setCropDraft(null)
        if (!store.undo()) showNotice(t('editor.reason.nothingToUndo'))
      },
      redo: (): void => {
        setCropDraft(null)
        if (!store.redo()) showNotice(t('editor.reason.nothingToRedo'))
      },
      step: (delta: number): void => player.seek(stepOutput(store.state.clips, player.time, delta)),
      goToStart: (): void => player.seek(keptBounds(store.state.clips).start),
      goToEnd: (): void => player.seek(keptBounds(store.state.clips).end)
    }
  }, [cursor, recorded, input, data.webcamUrl, player, store, showNotice, setSelection])

  const focusFor = useCallback(
    (zoom: ZoomSegment) => {
      // An auto zoom's own click, else where the camera would be in its middle (the focus path is
      // in the crop's view; without cursor data, its centre), inside the part of the recording that
      // is shown.
      const c = scene.crop ?? null
      // The stored crop, not the scene's: the crop tool shows the whole frame while it is open.
      if (!cursor.valid) return fromCrop(cropOf(project), { x: 0.5, y: 0.5 })
      const p = clampIntoCrop(c, zoom.anchor ?? fromCrop(c, focusPath.at((zoom.start + zoom.end) / 2)))
      return { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) }
    },
    [cursor.valid, focusPath, scene.crop, project]
  )

  const onBackgroundImage = useCallback(async () => {
    const picked = await window.api.pickBackgroundImage(store.state.id).catch((err: unknown) => {
      showNotice((err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      return null
    })
    if (!picked) return
    store.update((p) => ({ ...p, style: { ...p.style, background: { type: 'image', path: picked.path } } }))
    setBackgroundVersion((v) => v + 1)
  }, [store, showNotice])

  const exitPick = useCallback(() => setPickFocus(false), [])

  const openExport = useCallback((): void => {
    // The export is of the project with the edit of work still holding it (Review mode's Remove all), made now.
    store.finish()
    player.pause()
    releaseFocus()
    setPickFocus(false)
    setCropDraft(null)
    setExporting(true)
  }, [player, store])

  /* ---------- crop ---------- */

  const cropActions = useMemo(() => {
    /** Applies `rect` (null: the whole recording) as one undo step, rebasing the automatic zooms; false when nothing changes. */
    const apply = (rect: NormRect | null): boolean => {
      const p = store.state
      const outcome = setCrop(p, rect, effectiveTrack(recorded, p))
      if (outcome.project === p) return false
      store.update(() => outcome.project)
      showNotice(cropNotice(outcome))
      return true
    }
    /** The draft (or, without one, the crop) with the taskbar cut off; null when the recording does not show it. */
    const withoutTaskbar = (r: NormRect): NormRect | null => {
      const p = store.state
      const cut = taskbarCrop(r, p, recorded.scale)
      return cut && snapCrop(cut, p, { x: 0, y: 0 }, null)
    }
    return {
      /** Opens the crop tool on the current crop. */
      open: (): void => {
        setSelection(null)
        setPickFocus(false)
        setCropDraft((d) => d ?? { rect: cropOf(store.state) ?? { ...FULL_FRAME }, aspect: 'free' })
      },
      cancel: (): void => setCropDraft(null),
      /** Applies the draft (Done, Enter, a double-click on the box). */
      done: (draft: CropDraft | null): void => {
        setCropDraft(null)
        if (draft) apply(draft.rect)
      },
      reset: (): void => {
        if (!cropOf(store.state)) return showNotice(t('editor.reason.notCropped'))
        apply(null)
      },
      taskbar: (): void => {
        const r = withoutTaskbar(cropOf(store.state) ?? FULL_FRAME)
        if (!r) return showNotice(t('editor.reason.noTaskbar'))
        if (!apply(r)) showNotice(t('editor.notice.taskbarCropped'))
      },
      withoutTaskbar
    }
  }, [store, recorded, showNotice, setSelection])
  // The draft and its actions, for the keyboard and the stage.
  const cropRef = useRef(cropDraft)
  cropRef.current = cropDraft
  const applyCrop = useCallback(() => cropActions.done(cropRef.current), [cropActions])
  const applyCropRef = useRef(applyCrop)
  applyCropRef.current = applyCrop
  // A draft counts only while the tool is open: nothing late (a drag still held) opens it again.
  const editCropDraft = useCallback((d: CropDraft) => setCropDraft((cur) => (cur ? d : cur)), [])
  const cropTool = useMemo((): CropTool | null => (cropDraft ? { draft: cropDraft, onDraft: editCropDraft, onDone: applyCrop } : null), [cropDraft, editCropDraft, applyCrop])
  // Reset (the panel's or the palette's): while the tool is open it changes the draft, as its bar
  // does, and Done applies it.
  const resetCrop = useCallback(() => {
    if (cropRef.current) setCropDraft({ rect: { ...FULL_FRAME }, aspect: 'free' })
    else cropActions.reset()
  }, [cropActions])
  const onCrop = useCallback((action: 'edit' | 'reset') => (action === 'edit' ? cropActions.open() : resetCrop()), [cropActions, resetCrop])

  /* ---------- commands (palette and shortcuts) ---------- */

  const lastMotionBlur = useRef(store.state.effects.motionBlur || DEFAULT_EFFECTS.motionBlur)
  /** The `code` of the pause key (K) while it is held down: J and L then step one frame. */
  const pauseHeld = useRef<string | null>(null)
  /** What the Paste items key (Ctrl+V) runs: a newer clipboard image first (set with the commands). */
  const pasteKeyRef = useRef<() => void>(() => {})
  const commands = useMemo((): Record<CommandId, () => void> => {
    const turned = (what: string, on: boolean): void => showNotice(t(on ? 'editor.notice.turnedOn' : 'editor.notice.turnedOff', { what }))
    const level = (key: string) => (): void => actions.setZoomLevelKey(ZOOM_LEVEL_PRESETS.find((p) => p.key === key)!.value)
    /** Shows an Inspector tab. Review covers the Inspector, so it closes first (the focus, when it goes with it, then goes to its button). */
    const reveal = (t: InspectorTab): void => {
      if (latest.current.reviewOpen) setReviewOpen(false)
      setTab(t)
    }
    const showTab = (t: InspectorTab) => (): void => reveal(t)
    const aiTool = (task: CaptionsAiTask) => (): void => {
      if (!store.state.transcript?.segments.length) return showNotice(t('editor.notice.noCaptions'))
      reveal('captions')
      requestCaptions({ kind: 'ai', task })
    }
    const aiToolCommands = {
      aiChapters: aiTool('chapters'),
      aiTitle: aiTool('title'),
      aiSummary: aiTool('summary'),
      // Captions Studio §2.14: these two open Languages › Add a language and Clean up's AI fix.
      ...aiCaptionCommands({ store, setTab: reveal, notice: showNotice })
    }
    const writeInPublish = (kind: PublishKind): void => {
      setPublishRequest((was) => ({ kind, n: (was?.n ?? 0) + 1 }))
      setDialog('publish')
    }
    /** The cursor path range commands: the selected range straightened, or kept as recorded. */
    const pathRangeCommand = (mode: PathMode): void => {
      const sel = latest.current.selection
      if (!cursor.valid) return showNotice(noCursorText(store.state))
      if (store.state.capture.cursorInVideo) return showNotice(t('editor.reason.cursorInVideo'))
      if (sel?.kind !== 'range') return showNotice(t('editor.reason.selectRange'))
      input.setPathRange(sel, mode)
    }
    /** J, K and L: a frame step instead while K is held. */
    const shuttle = (key: ShuttleKey): void => {
      const held = pauseHeld.current !== null
      if (key === 'reverse' && !held && !player.reversing && atOutputStart(store.state.clips, player.time)) return showNotice(t('editor.notice.atStart'))
      const { frameStep } = player.shuttle(key, held)
      if (frameStep) actions.step(frameStep / 30)
    }
    /* E-06: several items (docs/design/multi-select.md §4.4, §4.10-4.13). */
    const fieldCtx = (): FieldCtx => ({ crop: cropOf(store.state), cursorValid: cursor.valid, style: zoomStyleOf(store.state), background: store.state.style.background, focusFor })
    /** The selected items: the group, or the single selection when it can join one. */
    const selectedKeys = (): ItemKey[] => {
      const L = latest.current
      if (L.group.keys.length >= 2) return [...L.group.keys]
      const k = groupKeyOf(L.selection)
      return k ? [k] : []
    }
    const undo = (): string => undoHint(latest.current.keymap)
    const keyLabel = (id: CommandId): string => {
      const k = commandKeys(latest.current.keymap, id)[0]
      return k ? shortcutLabel(k) : ''
    }
    /** The open tab's track, for Ctrl+A before anything was pressed on the timeline. */
    const TAB_TRACK: Partial<Record<InspectorTab, ItemTrack>> = { zoom: 'zoom', text: 'text', shapes: 'shapes', images: 'images', clip: 'freezes' }
    const pasted = (r: PasteResult, total: number, verb?: string): void => {
      if (r.keys.length) selectKeys(r.keys, r.keys[0])
      showNotice(pasteNotice(r, total, verb))
    }
    const selectAll = (): void => {
      if (cropRef.current) return showNotice(t('editor.reason.closeCrop'))
      const L = latest.current
      const items = projectItems(store.state)
      const anchor = L.group.anchor ?? groupKeyOf(L.selection)
      const parsed = anchor ? parseItemKey(anchor) : null
      const track = parsed ? trackOfKind(parsed.kind) : (timelineRef.current?.lastTrack() ?? TAB_TRACK[L.tab] ?? null)
      const r = selectAllStep(items, selectedKeys(), track)
      if (r.scope !== 'none') {
        // The Selection view opens in place of the panel that may have the keyboard (§5.2).
        keepInspectorFocus()
        selectKeys(r.keys, anchor && r.keys.includes(anchor) ? anchor : r.keys[0])
      }
      showNotice(selectAllNotice(r.scope, r.keys, keyLabel('selectAll') || null))
    }
    const copySelected = (): ItemKey[] | null => {
      const keys = selectedKeys()
      if (!keys.length) {
        showNotice(latest.current.selection ? t('editor.items.copyWhat') : t('editor.reason.selectToCopy'))
        return null
      }
      const clip = copyGroupItems(store.state, keys)
      if (!clip) return null
      itemClipboard.set(clip)
      noteItemCopy()
      return keys
    }
    const copySelectedItems = (): void => {
      const keys = copySelected()
      if (keys) showNotice(t('editor.items.copied', { count: keys.length, n: fmt.count(keys.length) }))
    }
    const cutSelectedItems = (): void => {
      const sel = latest.current.selection
      if (!selectedKeys().length) {
        // The Delete key's name when the command has no shortcut: a keycap, as shortcutLabel writes it.
        if (sel?.kind === 'clip' || sel?.kind === 'gap' || sel?.kind === 'range') return showNotice(t('editor.items.cutRecording', { keys: keyLabel('deleteSelection') || shortcutLabel('Delete') }))
        return showNotice(sel ? t('editor.items.cutWhat') : t('editor.reason.selectToCut'))
      }
      const keys = copySelected()
      if (!keys) return
      keepInspectorFocus()
      store.update((p) => deleteItems(p, keys))
      setSelection(null)
      showNotice(removedNotice('Cut', keys.length, undo()))
    }
    const pasteItemsNow = (): void => {
      if (cropRef.current) return showNotice(t('editor.reason.closeCrop'))
      const clip = itemClipboard.get()
      if (!clip) return showNotice(nothingCopiedNotice(keyLabel('copyItems') || null))
      let r: PasteResult | null = null
      store.update((p) => (r = pasteGroupItems(p, clip, player.time)).project)
      if (r) pasted(r, clip.items.length)
    }
    // The key only: an image on the system clipboard that is newer than the copied items is added as
    // an image (brand kit, NW-12). The palette's "Paste items at playhead" always pastes the items.
    const pasteClipboard = (): void => {
      if (cropRef.current) return showNotice(t('editor.reason.closeCrop'))
      void pasteClipboardImage({ store, player }, { onSelect: setSelection }, !!itemClipboard.get()).then(
        (o) => (o ? showNotice(o.name !== undefined ? t('editor.items.addedNamed', { name: o.name }) : t('editor.items.addedImage')) : pasteItemsNow()),
        (err: unknown) => showNotice(ipcMessage(err))
      )
    }
    pasteKeyRef.current = pasteClipboard
    const duplicateSelected = (): void => {
      if (cropRef.current) return showNotice(t('editor.reason.closeCrop'))
      const keys = selectedKeys()
      if (!keys.length) return showNotice(latest.current.selection ? t('editor.items.duplicateWhat') : t('editor.reason.selectToDuplicate'))
      let r: PasteResult | null = null
      store.update((p) => (r = duplicateGroupItems(p, keys)).project)
      if (r) pasted(r, keys.length, 'Duplicated')
    }
    const copyItemLook = (): void => {
      const L = latest.current
      if (L.group.keys.length >= 2) return showNotice(t('editor.reason.copyLookOne'))
      const k = groupKeyOf(L.selection)
      if (!k) return showNotice(L.selection ? t('editor.copyLook.none') : t('editor.reason.copyLookSelect'))
      if (k.startsWith('chapter:')) return showNotice(t('editor.copyLook.chapters'))
      const look = copyLook(store.state, k, fieldCtx())
      if (!look) return
      lookClipboard.set(look)
      showNotice(t('editor.copyLook.copied', { name: fmt.inSentence(look.label) }))
    }
    const pasteItemLook = (): void => {
      if (cropRef.current) return showNotice(t('editor.reason.closeCrop'))
      const look = lookClipboard.get()
      if (!look) return showNotice(copyLookFirst(keyLabel('copyLook') || null))
      const keys = selectedKeys()
      const name = fmt.inSentence(look.label)
      if (!keys.length) return showNotice(t('editor.pasteLook.select', { name }))
      const before = store.state
      let r: ReturnType<typeof pasteLook> | null = null
      store.update((p) => (r = pasteLook(p, keys, look, fieldCtx())).project)
      const done = r as ReturnType<typeof pasteLook> | null
      if (!done || done.applied === 0) return showNotice(t('editor.pasteLook.nothing', { name }))
      if (store.state === before) return showNotice(t('editor.pasteLook.already'))
      const [one, many] = LOOK_CLASS_WORDS[look.cls]
      const pasted = { name, one, many, count: done.applied, n: fmt.count(done.applied) }
      showNotice(done.other ? t('editor.pasteLook.pastedOthers', { ...pasted, others: done.other, o: fmt.count(done.other) }) : t('editor.pasteLook.pasted', pasted))
    }
    /** Freeze sound on a group: every selected freeze goes to the opposite of the anchor's (or the first one's). */
    const toggleGroupFreezeSound = (): void => {
      const group = latest.current.group
      if (group.keys.length < 2) return actions.toggleFreezeSound()
      const freezes = group.keys.filter((k) => k.startsWith('freeze:'))
      if (!freezes.length) return showNotice(t('editor.freeze.noneSelected'))
      const lead = group.anchor?.startsWith('freeze:') ? group.anchor : freezes[0]
      const f = store.state.freezes?.find((x) => `freeze:${x.id}` === lead)
      if (!f) return
      const sound = f.sound === 'pause' ? 'continue' : 'pause'
      let refused = 0
      store.update((p) => {
        const r = applyField(p, GROUP_FIELDS.find((x) => x.id === 'freeze.sound')!, freezes, sound, fieldCtx())
        refused = r.refused
        return r.project
      })
      const n = { count: freezes.length, n: fmt.count(freezes.length) }
      if (sound === 'pause') showNotice(t('editor.freeze.paused', n))
      else showNotice(refused ? t('editor.freeze.playingSomeKept', { ...n, refused, r: fmt.count(refused) }) : t('editor.freeze.playing', n))
    }

    /** > and <: the next preview speed (nothing is written to the project). */
    const previewSpeed = (step: 1 | -1): void => {
      const next = nextPreviewSpeed(player.previewSpeed, step)
      if (next === null) return showNotice(t(step > 0 ? 'editor.speed.fastest' : 'editor.speed.slowest', { speed: fmt.factor(player.previewSpeed) }))
      player.setPreviewSpeed(next)
      showNotice(t('editor.speed.set', { speed: fmt.factor(next) }))
    }
    /** E-09: the selected items by `frames` frames (one undo step per run of presses). */
    const nudge = (frames: number): void => {
      if (cropRef.current) return showNotice(t('editor.reason.closeCrop'))
      const keys = selectedKeys()
      if (!keys.length) return showNotice(t('editor.items.selectToMove'))
      nudgeSelected(store, keys, frames, showNotice)
    }
    return {
      play: actions.togglePlay,
      goToStart: actions.goToStart,
      goToEnd: actions.goToEnd,
      stepBack: () => actions.step(-1 / 30),
      stepForward: () => actions.step(1 / 30),
      jumpBack: () => actions.step(-1),
      jumpForward: () => actions.step(1),
      nextChapter: () => actions.goToChapter(true),
      prevChapter: () => actions.goToChapter(false),
      undo: actions.undo,
      redo: actions.redo,
      split: actions.split,
      deleteSelection: actions.deleteSelection,
      cutRange: actions.cutSelectedRange,
      restoreAll: actions.restoreAll,
      smartSpeed: () => {
        reveal('clip')
        setSmartSpeedRequest((n) => n + 1)
      },
      addZoom: actions.addZoom,
      addText: actions.addText,
      addArrow: () => actions.addShape('arrow'),
      addLine: () => actions.addShape('line'),
      addRect: () => actions.addShape('rect'),
      addEllipse: () => actions.addShape('ellipse'),
      addHighlight: () => actions.addShape('highlight'),
      addBlur: () => actions.addShape('blur'),
      addPixelate: () => actions.addShape('pixelate'),
      addSpotlight: () => actions.addSpotlight('region'),
      addCursorSpotlight: () => {
        if (cursor.valid) actions.addSpotlight('cursor')
        else showNotice(t('editor.notice.noCursorSpotlight', { reason: noCursorText(store.state) }))
      },
      addTitle: actions.addTitle,
      addChapter: actions.addChapter,
      layoutDefault: () => actions.setLayout('default'),
      layoutCameraOnly: () => actions.setLayout('camera-only'),
      layoutScreenOnly: () => actions.setLayout('screen-only'),
      layoutSideBySide: () => actions.setLayout('side-by-side'),
      layoutCameraLarge: () => actions.setLayout('camera-large'),
      directCamera: () => {
        const why = directUnavailable(!!data.webcamUrl, store.state.webcam.show)
        if (why) return showNotice(why)
        reveal('camera')
        setDirectorRequest((n) => n + 1)
      },
      zoomLevel0: level('0'),
      zoomLevel1: level('1'),
      zoomLevel2: level('2'),
      zoomLevel3: level('3'),
      zoomLevel4: level('4'),
      toggleCursor: () => {
        const p = store.state
        if (!cursor.valid || p.capture.cursorInVideo) return showNotice(cursor.valid ? t('editor.reason.cursorAlreadyInVideo') : noCursorText(store.state))
        store.update((q) => ({ ...q, cursor: { ...q.cursor, show: !p.cursor.show } }))
        turned(commandTitle('toggleCursor'), !p.cursor.show)
      },
      toggleClickEffects: () => {
        const p = store.state
        if (!cursor.valid) return showNotice(noCursorText(store.state))
        store.update((q) => ({ ...q, cursor: { ...q.cursor, clickEffect: !p.cursor.clickEffect } }))
        turned(commandTitle('toggleClickEffects'), !p.cursor.clickEffect)
      },
      toggleStraighten: () => {
        const p = store.state
        if (!cursor.valid || p.capture.cursorInVideo) return showNotice(cursor.valid ? t('editor.reason.cursorInVideo') : noCursorText(store.state))
        const on = !p.inputEdits?.straighten
        input.setStraighten(on)
        turned(t('editor.toggle.straighten'), on)
      },
      straightenRange: () => pathRangeCommand('straight'),
      recordedPathRange: () => pathRangeCommand('recorded'),
      toggleClickAtPlayhead: () => {
        if (!recorded.valid) return showNotice(noCursorText(store.state))
        const p = store.state
        const row = clickAtPlayhead(clickRows(recorded, p.inputEdits), p.zooms, player.time)
        if (!row) return showNotice(t('editor.clicks.noneNear'))
        input.setIgnored([row.ms], !row.ignored)
      },
      findStrayClicks: () => {
        if (!recorded.valid) return showNotice(noCursorText(store.state))
        input.findStray()
      },
      useAllClicks: () => {
        if (!recorded.valid) return showNotice(noCursorText(store.state))
        input.useAll()
      },
      toggleMotionBlur: () => {
        const was = store.state.effects.motionBlur
        if (was > 0) lastMotionBlur.current = was
        const next = was > 0 ? 0 : lastMotionBlur.current
        store.update((q) => ({ ...q, effects: { ...q.effects, motionBlur: next } }))
        turned(commandTitle('toggleMotionBlur'), next > 0)
      },
      toggleKeystrokes: () => {
        const on = !store.state.effects.keystrokes.show
        store.update((q) => ({ ...q, effects: { ...q.effects, keystrokes: { ...q.effects.keystrokes, show: on } } }))
        turned(commandTitle('toggleKeystrokes'), on)
      },
      toggleWebcam: () => {
        if (!data.webcamUrl) return showNotice(t('editor.reason.noCamera'))
        const on = !store.state.webcam.show
        store.update((q) => ({ ...q, webcam: { ...q.webcam, show: on } }))
        turned(t('common.label.camera'), on)
      },
      generateCaptions: () => {
        reveal('captions')
        requestCaptions({ kind: 'generate' })
      },
      toggleCaptions: () => {
        if (!store.state.transcript?.segments.length) return showNotice(t('editor.notice.noCaptions'))
        const on = !captionsOf(store.state).show
        store.update((q) => ({ ...q, captions: { ...captionsOf(q), show: on } }))
        turned(t('common.label.captions'), on)
      },
      exportCaptions: () => {
        if (!store.state.transcript?.segments.length) return showNotice(t('editor.notice.noCaptions'))
        reveal('captions')
        requestCaptions({ kind: 'export' })
      },
      // Captions Studio (docs/design/captions-studio.md §2.14): each opens its tab and does what its button does.
      ...captionCommands({
        store,
        // Review covers the Inspector: it closes before the tab shows (reveal).
        setTab: reveal,
        notice: showNotice,
        frame: () => {
          const f = editorFrame(store.state)
          return { w: f.outW, h: f.outH }
        },
        undo: () => undoHint(latest.current.keymap),
        review: () => reviewHint(latest.current.keymap)
      }),
      showCaptions: showTab('captions'),
      showStyle: showTab('style'),
      showCursor: showTab('cursor'),
      showZoom: showTab('zoom'),
      showClip: showTab('clip'),
      showText: showTab('text'),
      showShapes: showTab('shapes'),
      showEffects: showTab('effects'),
      showCamera: showTab('camera'),
      showAudio: showTab('audio'),
      timelineZoomIn: () => timelineRef.current?.zoomIn(),
      timelineZoomOut: () => timelineRef.current?.zoomOut(),
      timelineFit: () => timelineRef.current?.fit(),
      export: openExport,
      shortcuts: () => setDialog('shortcuts'),
      about: () => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'about' } })),
      commandPalette: () => setDialog('palette'),

      // E-01 polish
      polish: () => setDialog('polish'),
      // E-02 review mode (it takes the place of smart tools' panels)
      review: () => {
        setSmartPanel(null)
        setReviewOpen(true)
      },

      // Smart tools (docs/design/smart-tools.md §2.8)
      guide: () => openGuide('guide'),
      demo: () => openGuide('demo'),
      bugReport: () => openGuide('bug'),
      findChapters: () => {
        setSmartPanel(null)
        reveal('text')
        requestFindChapters()
      },
      shortClips: () => openClips(),
      shortVersion: () => setDialog('shortVersion'),
      localAi: () => void window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'localAi' } })),
      language: () => void window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'language' } })),
      aiService: () => void window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'ai' } })),

      // E-09 nudge, E-07 filmstrip, E-12 versions (docs/design/versions.md)
      nudgeBack: () => nudge(NUDGE_STEPS.nudgeBack.frames),
      nudgeForward: () => nudge(NUDGE_STEPS.nudgeForward.frames),
      nudgeBackTen: () => nudge(NUDGE_STEPS.nudgeBackTen.frames),
      nudgeForwardTen: () => nudge(NUDGE_STEPS.nudgeForwardTen.frames),
      toggleFilmstrip: () => {
        const on = !filmstripShown()
        setFilmstripShown(on)
        turned(commandTitle('toggleFilmstrip'), on)
      },
      saveVersion: () => setDialog('saveVersion'),
      versions: () => setDialog('versions'),

      // Editing polish (docs/design/editing-polish.md §2.8): each opens its tab until its part wires it.
      // Smooth cuts (§2.1): the Clip tab's buttons and the timeline's markers run the same handlers.
      ...cutCommands({
        store,
        player,
        reveal: () => reveal('clip'),
        select: setSelection,
        selection: () => latest.current.selection,
        notice: showNotice,
        undo: () => undoHint(latest.current.keymap)
      }),
      // The magnifier (part P2, §2.2): added at the playhead, its panel shown in the Shapes tab.
      addMagnifier: () => {
        addMagnifierAt({ store, player }, 'region', cursor, { onSelect: setSelection })
        reveal('shapes')
      },
      addMagnifierCursor: () => {
        if (!cursor.valid) return showNotice(t('editor.notice.noCursorMagnifier', { reason: noCursorText(store.state) }))
        addMagnifierAt({ store, player }, 'cursor', cursor, { onSelect: setSelection })
        reveal('shapes')
      },
      // Step badges and speech bubbles (part P3, §2.3): placed by the cursor, selected, a bubble's text focused.
      ...calloutCommands({ store, player, cursor, scene: () => calloutScene.current, select: setSelection, reveal: () => reveal('text') }),
      // The progress bar (part P2, §2.4): one undo step.
      toggleProgressBar: () => {
        const on = store.state.chapterBar?.show !== true
        store.update((p) => withChapterBar(p, { show: on }))
        turned(t('editor.toggle.progressBar'), on)
      },
      // Part P4, colour (§2.5): Compare is the preview's alone (never saved, never exported); Auto colour is one update.
      compareColour: () => turned(commandTitle('compareColour'), toggleCompare(player)),
      autoColour: () => {
        reveal('camera')
        void startAutoColour({ store, webcamUrl: data.webcamUrl, notice: showNotice })
      },
      musicLibrary: showTab('audio'),

      // E-04 waveform: a view preference, so not an undo step (like the timeline zoom)
      toggleWaveform: () => {
        if (!store.state.hasAudio) return showNotice(t('editor.reason.noSound'))
        const on = !waveformShown()
        setWaveformShown(on)
        turned(t('editor.toggle.waveform'), on)
      },

      // E-05 snapping: an editor preference, not an edit (no undo step)
      toggleSnapping: () => turned(commandTitle('toggleSnapping'), snapPref.toggle()),

      // E-08 shuttle and preview speed
      shuttleReverse: () => shuttle('reverse'),
      shuttlePause: () => shuttle('pause'),
      shuttleForward: () => shuttle('forward'),
      previewSpeedUp: () => previewSpeed(1),
      previewSpeedDown: () => previewSpeed(-1),

      // E-10 crop: while the tool is open, Reset and the taskbar preset change the draft, as its bar does.
      cropRecording: cropActions.open,
      resetCrop,
      cropTaskbar: () => {
        const draft = cropRef.current
        if (!draft) return cropActions.taskbar()
        const rect = cropActions.withoutTaskbar(draft.rect)
        if (rect) setCropDraft({ rect, aspect: 'free' })
        else showNotice(t('editor.reason.noTaskbar'))
      },

      // E-11 freeze frame
      freezeFrame: actions.freezeFrame,
      toggleFreezeSound: toggleGroupFreezeSound,

      // E-06 select several items (docs/design/multi-select.md §6)
      selectAll,
      copyItems: copySelectedItems,
      cutItems: cutSelectedItems,
      pasteItems: pasteItemsNow,
      duplicateItems: duplicateSelected,
      copyLook: copyItemLook,
      pasteLook: pasteItemLook,

      // NW-05 vertical video and X-04 duplicate (docs/design/vertical-video.md §2.11)
      makeVertical: () => void makeCopy('vertical'),
      makeSquare: () => void makeCopy('square'),
      duplicateVideo: () => void makeCopy('copy'),
      // Following and the safe zones change the view, not what is recorded: the toggle is one undo step, the zones a view preference.
      toggleFollow: () => {
        const p = store.state
        const { vw, vh } = editorFrame(p)
        if (!canFollow(p.style.aspectRatio, vw, vh)) return showNotice(t(FOLLOW_UNAVAILABLE))
        const on = p.reframe?.mode !== 'follow'
        store.update((q) => withFollowing(q, on, vw, vh))
        turned(commandTitle('toggleFollow'), on)
      },
      // A 1× zoom with a fixed point where the view is now (or the zoom there fixed), selected (§2.6).
      holdView: () => {
        const p = store.state
        const { vw, vh } = editorFrame(p)
        if (!followsAction(p)) return showNotice(t(canFollow(p.style.aspectRatio, vw, vh) ? FOLLOW_OFF : FOLLOW_UNAVAILABLE))
        if (cropRef.current) return showNotice(t('editor.reason.closeCrop'))
        const sc = sceneRef.current
        const at = displayTime(p.clips, player.time)
        const frame = outputSize(sc.project.style.aspectRatio, sc.project.width, sc.project.height, 1080)
        const { cam } = frameView(sc, frame.width, frame.height, sc.project.width, sc.project.height, at)
        const r = holdViewAt(p, at, { x: cam.cx, y: cam.cy }, cropOf(p))
        if (!r.project) return showNotice(t('editor.notice.noRoomForZoom'))
        const next = r.project
        store.update(() => next)
        // Selecting the zoom shows the Zoom tab: focus on the Style tab's button or toggle goes to the tab rail, not the page.
        keepInspectorFocus()
        setSelection({ kind: 'zoom', id: r.zoomId })
      },
      toggleSafeZones: () => {
        const { outW, outH } = editorFrame(store.state)
        if (!isTall(outW, outH)) return showNotice(t(SAFE_ZONES_TALL))
        toggleSafeZoneChoice()
        turned(t('timeline.safeZones.button'), safeZoneChoice() !== 'off')
      },

      // NW-13 publishing copy pack: the Captions tab's AI tools run there; the pack's items open Publish.
      ...aiToolCommands,
      publishPack: () => {
        setPublishRequest(null)
        setDialog('publish')
      },
      publishYoutube: () => writeInPublish('youtube'),
      publishLinkedin: () => writeInPublish('linkedin'),
      publishX: () => writeInPublish('xpost'),
      publishArticle: () => writeInPublish('article'),
      publishReleaseNotes: () => writeInPublish('releaseNotes'),

      // Auto-blur (docs/design/auto-blur.md §2.15, §12.3): the cover commands (part P1's) and Find private info (part P5's dialog).
      ...coverCommands({ services, cursor, scene: () => calloutScene.current, selection: () => latest.current.selection, select: setSelection, reveal: () => reveal('shapes'), notice: showNotice }),
      findPrivate: () => setDialog('findPrivate')
    }
  }, [actions, input, cursor.valid, recorded, player, data.webcamUrl, openExport, showNotice, store, cropActions, resetCrop, focusFor, selectKeys, setSelection, makeCopy, services])
  const commandsRef = useRef(commands)
  commandsRef.current = commands
  const runCommand = useCallback((id: CommandId) => commandsRef.current[id](), [])

  // What the timeline, the Inspector and the preview read about the group (E-06).
  const groupKeys = useMemo(() => new Set<string>(group.keys), [group])
  const singleKey = groupKeyOf(selection)
  const groupApi = useMemo(
    (): GroupApi => ({ group, keys: groupKeys, single: singleKey, select: selectKeys, notice: showNotice, command: runCommand }),
    [group, groupKeys, singleKey, selectKeys, showNotice, runCommand]
  )

  const closeDialog = useCallback(() => setDialog(null), [])
  /** E-12: puts a version in place as one undo step (the edit before it is already kept as a version). */
  const openVersion = useCallback(
    ({ meta, project: version, missing, changed }: ReadVersion) => {
      // Work still holding the edit (Review mode's Remove all, made already when the edit was kept)
      // makes its edit before the version takes its place, never on top of it.
      store.finish()
      store.seal()
      store.update((p) => restoreVersion(p, version))
      store.seal()
      setSelection(null)
      setDialog(null)
      // Review mode's list was read from the edit before (its reviewed rows stay until it closes):
      // it closes, and lists the version's automatic changes when opened again.
      setReviewOpen(false)
      // Files gone, and images a later pick wrote over (the version shows today's).
      const gone = [missingFilesNotice(missing), changedFilesNotice(changed)].filter(Boolean).join(' ')
      showNotice(`${t('editor.notice.versionOpened', { name: meta.name })}${undoHint(keymap)}${gone ? ` · ${gone}` : ''}`, { ms: 8000 })
    },
    [store, setSelection, showNotice, keymap]
  )
  const runFromPalette = useCallback((id: CommandId) => {
    setDialog(null)
    commandsRef.current[id]()
  }, [])

  // What the palette shows: worked out only while it is open, from the moment it opened.
  const paletteEntries = useMemo((): PaletteEntry[] => {
    if (dialog !== 'palette') return []
    const p = project
    const at = player.time
    const noCursor = noCursorText(p)
    const smoothCursor = cursor.valid && !p.capture.cursorInVideo
    const zoomTarget = selection?.kind === 'zoom' || !!zoomAt(p.zooms, at)
    const edited = p.clips.length > 1 || p.clips[0].start > 0 || p.clips[0].end < p.duration || p.clips[0].speed !== 1
    const freezeRefused = freezeRefusal(p, at)?.refused
    const noCaptions = p.transcript?.segments.length ? null : t('editor.reason.noCaptions')
    const unavailable: Partial<Record<CommandId, string | null>> = {
      undo: store.canUndo ? null : t('editor.reason.nothingToUndo'),
      redo: store.canRedo ? null : t('editor.reason.nothingToRedo'),
      split: canSplitAt(p.clips, at) ? null : clipAt(p.clips, at) ? t('editor.reason.splitEdge') : t('editor.reason.inCut'),
      deleteSelection: (selection && selection.kind !== 'gap') || group.keys.length >= 2 ? null : t('editor.reason.selectSomething'),
      cutRange: selection?.kind === 'range' ? null : t('editor.reason.selectRange'),
      restoreAll: edited ? null : t('editor.reason.nothingCut'),
      addCursorSpotlight: cursor.valid ? null : noCursor,
      addMagnifierCursor: cursor.valid ? null : noCursor,
      toggleCursor: smoothCursor ? null : cursor.valid ? t('editor.reason.cursorAlreadyInVideo') : noCursor,
      toggleClickEffects: cursor.valid ? null : noCursor,
      toggleWebcam: data.webcamUrl ? null : t('editor.reason.noCamera'),
      directCamera: directUnavailable(!!data.webcamUrl, p.webcam.show),
      nextChapter: nextChapter(p.chapters ?? [], at, p.clips) ? null : p.chapters?.length ? t('editor.reason.noChapterAfter') : t('editor.reason.noChapters'),
      prevChapter: previousChapter(p.chapters ?? [], at, p.clips) ? null : p.chapters?.length ? t('editor.reason.noChapterBefore') : t('editor.reason.noChapters'),
      toggleCaptions: noCaptions,
      exportCaptions: noCaptions,
      // NW-13: the Captions tab's AI tools need captions (the Publish dialog says what to do without them).
      ...Object.fromEntries((['aiCleanup', 'aiTranslate', 'aiChapters', 'aiTitle', 'aiSummary'] as const).map((k) => [k, noCaptions])),
      captionsGreat: noCaptions,
      captionStyles: noCaptions,
      captionEmphasis: noCaptions,
      captionGraphics: noCaptions,
      captionTidy: noCaptions,
      captionLanguage: noCaptions,
      saveCaptionStyle: noCaptions,
      toggleClickAtPlayhead: cursor.valid ? null : noCursor,
      findStrayClicks: cursor.valid ? null : noCursor,
      useAllClicks: !cursor.valid ? noCursor : rows.some((r) => r.ignored) ? null : t('editor.clicks.noneIgnored'),
      toggleStraighten: smoothCursor ? null : cursor.valid ? t('editor.reason.cursorInVideo') : noCursor,
      freezeFrame: freezeRefused ? FREEZE_REFUSAL_TEXT[freezeRefused] : null,
      toggleFreezeSound: (group.keys.length >= 2 ? group.keys.some((k) => k.startsWith('freeze:')) : !!freezeTarget(p, selection, at)) ? null : t('editor.reason.selectFreeze'),
      resetCrop: cropOf(p) || cropDraft ? null : t('editor.reason.notCropped'),
      cropTaskbar: taskbarCrop(cropDraft?.rect ?? cropOf(p) ?? FULL_FRAME, p, recorded.scale) ? null : t('editor.reason.noTaskbar')
    }
    for (const k of ['straightenRange', 'recordedPathRange'] as const) {
      unavailable[k] = !cursor.valid
        ? noCursor
        : p.capture.cursorInVideo
          ? t('editor.reason.cursorInVideo')
          : selection?.kind === 'range'
            ? null
            : t('editor.reason.selectRange')
    }
    for (const k of ['layoutDefault', 'layoutCameraOnly', 'layoutScreenOnly', 'layoutSideBySide', 'layoutCameraLarge'] as const) {
      unavailable[k] = data.webcamUrl ? null : t('editor.reason.noCamera')
    }
    for (const k of ['zoomLevel0', 'zoomLevel1', 'zoomLevel2', 'zoomLevel3', 'zoomLevel4'] as const)
      unavailable[k] = (group.keys.length >= 2 ? group.keys.some((x) => x.startsWith('zoom:')) : zoomTarget) ? null : t('editor.reason.selectZoom')
    // E-06: the selection commands.
    const picked = group.keys.length >= 2 ? group.keys : groupKeyOf(selection) ? [groupKeyOf(selection)!] : []
    const look = lookClipboard.get()
    unavailable.selectAll = cropDraft ? t('editor.reason.closeCrop') : projectItems(p).length ? null : t('editor.multiSelect.selectNone')
    unavailable.copyItems = picked.length ? null : t('editor.reason.selectToCopy')
    unavailable.cutItems = picked.length ? null : t('editor.reason.selectToCut')
    unavailable.duplicateItems = picked.length ? null : t('editor.reason.selectToDuplicate')
    unavailable.pasteItems = itemClipboard.get() ? null : t('editor.reason.nothingCopied')
    unavailable.copyLook =
      group.keys.length >= 2 ? t('editor.reason.copyLookOne') : picked.length && lookClassOf(p, picked[0]) ? null : t('editor.reason.copyLookSelect')
    unavailable.pasteLook = !look ? t('editor.reason.copyLookFirst') : picked.some((k) => lookClassOf(p, k) === look.cls) ? null : t('editor.reason.lookIsFor', { many: LOOK_CLASS_WORDS[look.cls][1] })
    unavailable.toggleWaveform = p.hasAudio ? null : t('editor.reason.noSound')
    if (nextPreviewSpeed(player.previewSpeed, 1) === null) unavailable.previewSpeedUp = t('editor.reason.fastestSpeed', { speed: fmt.factor(player.previewSpeed) })
    if (nextPreviewSpeed(player.previewSpeed, -1) === null) unavailable.previewSpeedDown = t('editor.reason.slowestSpeed', { speed: fmt.factor(player.previewSpeed) })
    const on: Partial<Record<CommandId, boolean>> = {
      toggleSnapping: snapPref.get(),
      toggleCursor: smoothCursor && p.cursor.show,
      toggleClickEffects: cursor.valid && p.cursor.clickEffect,
      toggleStraighten: smoothCursor && !!p.inputEdits?.straighten,
      toggleMotionBlur: p.effects.motionBlur > 0,
      toggleKeystrokes: p.effects.keystrokes.show,
      toggleWebcam: !!data.webcamUrl && p.webcam.show,
      toggleCaptions: !!p.transcript?.segments.length && captionsOf(p).show
    }
    on.toggleWaveform = p.hasAudio && waveformShown()
    on.toggleFilmstrip = filmstripShown()
    // Editing polish's toggles (§2.8): the progress bar; Compare is the preview's (part P4 wires it).
    on.toggleProgressBar = !!p.chapterBar?.show
    on.compareColour = player.comparing
    unavailable.autoColour = data.webcamUrl && p.hasWebcam ? (autoColourBusy() ? t('editor.reason.autoColourRunning') : null) : t('editor.reason.noCamera')
    for (const k of ['nudgeBack', 'nudgeForward', 'nudgeBackTen', 'nudgeForwardTen'] as const) unavailable[k] = picked.length ? null : t('editor.reason.selectToMove')
    // NW-05 and X-04: the copies (with the menu's reasons), following and the safe zones.
    const frame = editorFrame(p)
    const followable = canFollow(p.style.aspectRatio, frame.vw, frame.vh)
    const copyReason = (kind: CopyKind): string | null => {
      if (copy) return t('editor.reason.copyBusy')
      const c = canCopyAs(p, kind, frame.vw, frame.vh)
      return c.ok ? null : c.reason
    }
    unavailable.makeVertical = copyReason('vertical')
    unavailable.makeSquare = copyReason('square')
    unavailable.duplicateVideo = copyReason('copy')
    unavailable.toggleFollow = followable ? null : t(FOLLOW_UNAVAILABLE)
    unavailable.holdView = !followsAction(p) ? t(followable ? FOLLOW_OFF : FOLLOW_UNAVAILABLE) : cropDraft ? t('editor.reason.closeCrop') : null
    unavailable.toggleSafeZones = isTall(frame.outW, frame.outH) ? null : t(SAFE_ZONES_TALL)
    on.toggleFollow = followable && p.reframe?.mode === 'follow'
    on.toggleSafeZones = isTall(frame.outW, frame.outH) && safeZoneChoice() !== 'off'
    // Language… exists only while Settings has a Language section (output-and-languages §2.5).
    const listed = paletteCommands(showLanguageSection(currentUiInfo()))
    return listed.map((info) => ({ info, shortcuts: commandKeys(keymap, info.id), unavailable: unavailable[info.id] ?? null, on: info.toggle ? !!on[info.id] : undefined }))
    // Recomputed when the palette opens or something it shows changes, not on every playhead move.
  }, [dialog, project, selection, group, keymap, cursor.valid, rows, data.webcamUrl, store, player, cropDraft, recorded.scale, copy])

  const goBack = (): Promise<void> => leave(onClose)

  /* ---------- keyboard ---------- */

  useEffect(() => installFocusRelease(), [])

  useEffect(() => {
    let spaceDown = false
    const onKeyDown = (e: KeyboardEvent): void => {
      const L = latest.current
      if (L.exporting) {
        // Editor shortcuts are off behind the export dialog. Escape acts as its own close
        // button, which the dialog only offers while no export is running.
        if (e.key === 'Escape') {
          const close = document.querySelector<HTMLButtonElement>('.modal .modal-head button[title="Close"]')
          if (close) {
            e.preventDefault()
            close.click()
          }
        }
        return
      }
      // The palette and the shortcuts dialog handle their own keys (Esc closes them); the window of a
      // copy being made keeps the keyboard to itself, and so does any other modal dialog open over the
      // editor (the link check's confirm in the Captions tab, Settings): Space presses its focused
      // button, and nothing behind it plays, is deleted or is unselected.
      if (L.dialog || L.copying || document.querySelector('[aria-modal="true"]')) return
      const target = e.target instanceof Element ? e.target : null
      const chord = chordFromEvent(e)
      const id = chord ? matchShortcut(L.shortcuts, chord) : null
      if (isTextEntry(target)) {
        // Typing: only leave the field (Ctrl+Z stays the field's own undo), or open the palette.
        // Enter in a field of a form submits the form (e.g. naming a style preset) instead.
        if (id && commandInfo(id).inText) {
          e.preventDefault()
          if (!e.repeat) commandsRef.current[id]()
        } else if (e.key === 'Escape' || (e.key === 'Enter' && target instanceof HTMLInputElement && !target.form)) {
          e.preventDefault()
          ;(target as HTMLElement).blur()
        }
        return
      }
      // The crop tool: Esc closes it without applying, Enter applies it (a focused button takes Enter itself).
      if (cropRef.current && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && !(target instanceof HTMLButtonElement)))) {
        e.preventDefault()
        if (e.key === 'Escape') setCropDraft(null)
        else if (!e.repeat) applyCropRef.current()
        return
      }
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (L.pickFocus) setPickFocus(false)
        else {
          keepInspectorFocus()
          setSelection(null)
        }
        return
      }
      // E-06: Ctrl+A/C/X/V run their standard commands when the keymap has nothing for them; Ctrl+C
      // and Ctrl+X leave text selected on the page to the system (a hint's text can still be copied).
      const matched = id ?? (chord ? standardEditCommand(chord) : null)
      // E-09: the step keys move the selected items while items are selected (docs/design/versions.md §4.1).
      const run = matched && nudgeInstead(matched, L.group.keys.length >= 2 || !!groupKeyOf(L.selection))
      if (!chord || !run) return
      if (!id && (run === 'copyItems' || run === 'cutItems')) {
        const text = window.getSelection()
        if (text && !text.isCollapsed) return
      }
      // A focused slider keeps its own arrow, Home and End keys.
      if (isRangeInput(target) && isSliderKey(chord)) return
      // A toggle reached with the keyboard keeps Space, its only key (Follow the action is turned on
      // so, docs/design/vertical-video.md §11.3); one the pointer left focused does not: Space plays.
      if (chord.key === 'Space' && !chord.ctrl && !chord.alt && !chord.shift && isKeyboardToggle(target)) return
      e.preventDefault()
      if (chord.key === 'Space') {
        // A focused toggle or button must not also react to Space (on key up).
        blurActiveControl()
        spaceDown = true
      }
      if (run === 'shuttlePause' && !e.repeat) pauseHeld.current = e.code
      if (e.repeat && !commandInfo(run).repeat) return
      if (run === 'pasteItems') pasteKeyRef.current()
      else commandsRef.current[run]()
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === pauseHeld.current) pauseHeld.current = null
      if (spaceDown && (e.code === 'Space' || e.key === ' ')) {
        e.preventDefault()
        spaceDown = false
      }
    }
    // A key up lost to another window (Alt+Tab) must not leave the pause key held.
    const onBlur = (): void => {
      pauseHeld.current = null
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [setSelection])

  /* ---------- saving on close ---------- */

  useEffect(() => {
    // Closing the window or quitting tears the page down without unmounting React; save synchronously.
    // Work still holding the project (Review mode's Remove all) makes its edit first, and what waits for it is done.
    const flush = (): void => {
      try {
        store.finish()
      } finally {
        saver.flushSync()
      }
    }
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [saver, store])

  // What the Vertical framing section reads besides the project, and the recording as cropped for the copy menu.
  const followEnv = useMemo<FollowEnv>(() => ({ cursorValid: cursor.valid, reveal: followReveal }), [cursor.valid, followReveal])
  const shown = editorFrame(project)

  return (
    <EditorProviders services={services} keymap={keymap} group={groupApi} follow={followEnv}>
      <div className="app editor">
        <header className="titlebar">
          <button className="btn ghost" onClick={() => void goBack()} disabled={leaving} title={t('editor.titlebar.back')} aria-label={t('editor.titlebar.back')}>
            <Icon name="back" />
          </button>
          <input
            className="title-input"
            aria-label={t('editor.titlebar.name')}
            value={project.name}
            onChange={(e) => {
              const name = e.target.value
              store.update((p) => ({ ...p, name }), 'name')
            }}
            onBlur={() => {
              // Saves never store an empty name (withSavedName); the field shows what they store.
              if (!store.state.name.trim()) store.update((p) => ({ ...p, name: UNTITLED }), 'name')
            }}
          />
          <CopyMenu project={project} vw={shown.vw} vh={shown.vh} run={(kind) => void makeCopy(kind)} onClips={openClips} onShort={() => setDialog('shortVersion')} />
          <div className="history-buttons">
            <button className="btn ghost icon-btn" onClick={actions.undo} disabled={!canUndo} title={withShortcut(commandTitle('undo'), keymap.undo)} aria-label={commandTitle('undo')}>
              <EditorIcon name="undo" />
            </button>
            <button className="btn ghost icon-btn" onClick={actions.redo} disabled={!canRedo} title={withShortcut(commandTitle('redo'), keymap.redo)} aria-label={commandTitle('redo')}>
              <EditorIcon name="redo" />
            </button>
          </div>
          <button className="btn ghost versions-button" onClick={() => setDialog('versions')} title={withShortcut(t('editor.titlebar.versionsTitle'), keymap.saveVersion)} data-testid="versions-open">
            <VersionsIcon size={16} /> <span className="tb-label">{t('editor.titlebar.versions')}</span>
          </button>
          <SaveIndicator saver={saver} />
          <div className="tb-spacer" />
          <SettingsButton />
          <button className="btn command-button" onClick={() => setDialog('palette')} title={withShortcut(t('editor.titlebar.commandsTitle'), keymap.commandPalette)} aria-label={t('commands.palette.label')}>
            <SearchIcon size={14} />
            <span>{t('editor.titlebar.commands')}</span>
            {keymap.commandPalette[0] && <ShortcutKeys accelerator={keymap.commandPalette[0]} />}
          </button>
          <button className="btn ghost icon-btn" onClick={() => setDialog('shortcuts')} title={withShortcut(t('common.label.keyboardShortcuts'), keymap.shortcuts)} aria-label={t('common.label.keyboardShortcuts')}>
            <EditorIcon name="keyboard" />
          </button>
          <ReviewButton
            ref={reviewButton}
            project={project}
            shortcuts={keymap.review}
            open={reviewOpen}
            onToggle={() => {
              setSmartPanel(null)
              setReviewOpen((o) => !o)
            }}
          />
          <button className="btn" data-testid="polish-open" onClick={() => setDialog('polish')} title={withShortcut(polishButtonTitle(), keymap.polish)}>
            <EditorIcon name="sparkle" size={16} /> <span className="tb-label">{t('editor.titlebar.polish')}</span>
          </button>
          <button className="btn" data-testid="publish-open" onClick={() => commandsRef.current.publishPack()} title={withShortcut(t('editor.titlebar.publishTitle'), keymap.publishPack)}>
            <EditorIcon name="transcript" size={16} /> <span className="tb-label">{t('editor.titlebar.publish')}</span>
          </button>
          <button
            ref={guideButton}
            className="btn"
            data-testid="guide-open"
            aria-pressed={smartPanel?.kind === 'guide'}
            onClick={() => (smartPanel?.kind === 'guide' ? setSmartPanel(null) : openGuide('guide'))}
            title={withShortcut(t('editor.titlebar.guideTitle'), keymap.guide)}
          >
            <EditorIcon name="steps" size={16} /> <span className="tb-label">{t('editor.titlebar.guide')}</span>
          </button>
          <button className="btn primary" onClick={openExport} title={withShortcut(t('editor.titlebar.exportTitle'), keymap.export)}>
            <Icon name="download" size={16} /> {t('editor.titlebar.export')}
          </button>
        </header>

        <div className="editor-body">
          <div className="stage">
            <PreviewStage
              project={project}
              pickZoom={pickZoom}
              selectedAnnotation={selectedAnnotation}
              onTogglePlay={actions.togglePlay}
              onExitPick={exitPick}
              scene={previewScene}
              selection={selection}
              onSelect={setSelection}
              cropTool={cropTool}
            />
            {cropDraft && (
              <CropBar
                recorded={{ width: project.width, height: project.height }}
                draft={cropDraft}
                capture={project.capture}
                scale={recorded.scale}
                onDraft={editCropDraft}
                onDone={applyCrop}
                onCancel={cropActions.cancel}
              />
            )}
            <Transport
              clips={project.clips}
              freezes={project.freezes}
              notice={notice?.text ?? null}
              noticeAction={notice?.action ?? null}
              noticeAlert={!!notice?.alert}
              onNoticeHold={holdNotice}
              tall={tall}
              onTogglePlay={actions.togglePlay}
              onSplit={actions.split}
              onAddZoom={actions.addZoom}
              onAddText={actions.addText}
            />
          </div>
          <Inspector
            tab={tab}
            onTab={setTab}
            smartSpeedRequest={smartSpeedRequest}
            directorRequest={directorRequest}
            project={project}
            selection={selection}
            revealSeq={revealSeq}
            groupReveal={groupReveal}
            onCommand={runCommand}
            onSelect={setSelection}
            cursor={cursor}
            recorded={recorded}
            clickRows={rows}
            input={input}
            hasWebcam={!!data.webcamUrl}
            pickFocus={pickFocus}
            onPickFocus={setPickFocus}
            focusFor={focusFor}
            onBackgroundImage={onBackgroundImage}
            onCrop={onCrop}
            onNotice={showNotice}
            onAddText={actions.addText}
            onSplit={actions.split}
            onDeleteClip={actions.deleteClip}
            onRestore={actions.restore}
            onCutRange={actions.cut}
          />
          {reviewOpen && (
            <ReviewPanel
              onClose={() => {
                setReviewOpen(false)
                reviewButton.current?.focus()
              }}
              onNotice={showNotice}
            />
          )}
          {smartPanel?.kind === 'guide' && (
            <GuidePanel
              project={project}
              cursor={recorded}
              start={smartPanel.start}
              onClose={() => {
                setSmartPanel(null)
                guideButton.current?.focus()
              }}
              onNotice={showNotice}
            />
          )}
          {smartPanel?.kind === 'clips' && (
            <ShortClipsPanel
              project={project}
              cursor={recorded}
              vw={shown.vw}
              vh={shown.vh}
              onClose={() => setSmartPanel(null)}
              onOpen={(id) => void leave(() => onOpenProject?.(id))}
            />
          )}
        </div>

        <Timeline
          ref={timelineRef}
          duration={project.duration}
          clips={project.clips}
          zooms={project.zooms}
          zoomStyle={zoomStyleOf(project)}
          annotations={project.annotations}
          clickRows={rows}
          pathBars={pathBars}
          scrollBands={scrollBands}
          onSelectClick={input.selectClick}
          cursor={cursor}
          selection={selection}
          onSelect={setSelection}
          onAddZoom={actions.addZoomFromTrack}
          onAddText={actions.addTextAt}
          onRestore={actions.restore}
          onCutRange={actions.cut}
        />

        {exporting && (
          <ExportDialog
            project={project}
            scene={scene}
            screenUrl={data.screenUrl}
            webcamUrl={data.webcamUrl}
            background={background}
            onClose={() => setExporting(false)}
            flush={() => saver.flushSync()}
            onShortClips={() => {
              setExporting(false)
              openClips()
            }}
          />
        )}
        <OverlayDropZone onSelect={setSelection} onNotice={showNotice} />
        {dialog === 'palette' && <CommandPalette entries={paletteEntries} onRun={runFromPalette} onClose={closeDialog} />}
        {dialog === 'shortcuts' && <ShortcutsDialog keymap={keymap} onChange={changeKeymap} onClose={closeDialog} />}
        {(dialog === 'versions' || dialog === 'saveVersion') && (
          <VersionsDialog getProject={() => store.state} settle={store.finish} focusName={dialog === 'saveVersion'} onOpen={openVersion} onNotice={showNotice} onClose={closeDialog} />
        )}
        {copy && <CopyProgress kind={copy.kind} name={project.name} progress={copy.progress} onCancel={() => copyAbort.current?.abort()} />}
        {dialog === 'publish' && (
          <PublishDialog
            project={project}
            request={publishRequest}
            onClose={() => {
              // A palette request is written once: reopening the dialog never sends it again.
              setPublishRequest(null)
              closeDialog()
            }}
            onGenerateCaptions={() => {
              setPublishRequest(null)
              setDialog(null)
              // Review covers the Inspector: it closes so the Captions tab shows.
              setReviewOpen(false)
              setTab('captions')
              requestCaptions({ kind: 'generate' })
            }}
            onFindChapters={() => {
              setPublishRequest(null)
              setDialog(null)
              setReviewOpen(false)
              setSmartPanel(null)
              setTab('text')
            }}
            onShortClips={() => {
              setPublishRequest(null)
              setDialog(null)
              openClips()
            }}
          />
        )}
        {dialog === 'shortVersion' && (
          <ShortVersionDialog project={project} cursor={recorded} vw={shown.vw} vh={shown.vh} onClose={closeDialog} onOpen={(id) => void leave(() => onOpenProject?.(id))} />
        )}
        {dialog === 'findPrivate' && <FindDialog services={services} mode="find" onClose={closeDialog} />}
        {dialog === 'polish' && (
          <PolishDialog
            recorded={recorded}
            hasCameraFile={!!data.webcamUrl}
            onClose={(message) => {
              setDialog(null)
              if (message) showNotice(message)
            }}
            onDone={({ changed, clipsChanged, summary }) => {
              setDialog(null)
              showNotice(polishNotice(summary, changed, undoHint(keymap)))
              if (clipsChanged) setSelection(null)
            }}
          />
        )}
      </div>
    </EditorProviders>
  )
}
