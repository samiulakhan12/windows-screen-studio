import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { CommandId } from '../../../shared/editor/commands'
import type { ClickRow } from '../../../shared/engine/inputData'
import type { CursorTrack, PathMode, Project, ZoomSegment } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { EditorIcon } from './EditorIcon'
import { useGroup } from './groupContext'
import { SelectionPanel } from './panels/SelectionPanel'
import type { Selection } from './selection'
import { StylePanel } from './panels/StylePanel'
import { CursorPanel } from './panels/CursorPanel'
import { ZoomPanel } from './panels/ZoomPanel'
import { ClipPanel } from './panels/ClipPanel'
import { TextPanel } from './panels/TextPanel'
import { EffectsPanel } from './panels/EffectsPanel'
import { CameraPanel } from './panels/CameraPanel'
import { AudioPanel } from './panels/AudioPanel'
import { CaptionsPanel } from './panels/CaptionsPanel'
import { ShapesPanel } from './panels/ShapesPanel'
import { ImagesPanel } from './panels/ImagesPanel'
import { useCaptionsHost } from './speechState'

export interface InspectorProps {
  project: Project
  selection: Selection
  /** Increments whenever the user selects something, to reveal its settings again. */
  revealSeq: number
  onSelect: (sel: Selection) => void
  /** The input as edited (ignored clicks left out, moves straightened): what everything shows and uses. */
  cursor: CursorTrack
  /** cursor.json as recorded, never changed: what the input edits refer to. */
  recorded: CursorTrack
  /** Every recorded in-video click with its ignore state (clickRows). */
  clickRows: ClickRow[]
  /** Edits to the recorded input; each is one undo step and shows its own notice. */
  input: InputActions
  hasWebcam: boolean
  pickFocus: boolean
  onPickFocus: (on: boolean) => void
  /** Where a cursor-following zoom currently looks, so switching it to a fixed point keeps the view. */
  focusFor: (zoom: ZoomSegment) => { x: number; y: number }
  onBackgroundImage: () => void
  /** Opens the crop tool ('edit'), or shows the whole recording again ('reset'). */
  onCrop: (action: 'edit' | 'reset') => void
  onNotice: (message: string) => void
  onAddText: () => void
  onSplit: () => void
  onDeleteClip: (id: string) => void
  onRestore: (start: number, end: number) => void
  onCutRange: (start: number, end: number) => void
  /** Increments when the smart speed command asks the Clip panel to find idle parts. */
  smartSpeedRequest?: number
  /** Increments when the camera director command asks the Camera panel to direct the camera. */
  directorRequest?: number
  /** Increments whenever several items are selected in a way that shows the Selection view (E-06). */
  groupReveal?: number
  /** Runs an editor command (the Selection view's buttons run the same handlers as the keys). */
  onCommand?: (id: CommandId) => void
}

/** Ignoring and using clicks, straightening the cursor path (shared/editor/inputEdits.ts). */
export interface InputActions {
  /** Ignores (`ignore`) or uses again the clicks with these keys. */
  setIgnored: (ms: readonly number[], ignore: boolean) => void
  /** "Find stray clicks". */
  findStray: () => void
  /** "Use all clicks". */
  useAll: () => void
  /** The "Straighten moves" option. */
  setStraighten: (on: boolean) => void
  /** Paints a cursor path range ('straight', 'recorded', or null to follow the option again). */
  setPathRange: (range: { start: number; end: number }, mode: PathMode | null) => void
  /** Selects a click and moves the playhead just past it (when it is in the video). */
  selectClick: (ms: number) => void
}

export type InspectorTab = 'style' | 'cursor' | 'zoom' | 'clip' | 'text' | 'captions' | 'shapes' | 'images' | 'effects' | 'camera' | 'audio'
type Tab = InspectorTab

const TABS: { id: Tab; label: string; icon: string; editorIcon?: boolean }[] = [
  { id: 'style', label: 'Style', icon: 'palette' },
  { id: 'cursor', label: 'Cursor', icon: 'cursor' },
  { id: 'zoom', label: 'Zoom', icon: 'zoom' },
  { id: 'clip', label: 'Clip', icon: 'scissors', editorIcon: true },
  { id: 'text', label: 'Text', icon: 'text', editorIcon: true },
  { id: 'captions', label: 'Captions', icon: 'captions', editorIcon: true },
  { id: 'shapes', label: 'Shapes', icon: 'shapes', editorIcon: true },
  { id: 'images', label: 'Images', icon: 'image', editorIcon: true },
  { id: 'effects', label: 'Effects', icon: 'sparkle', editorIcon: true },
  { id: 'camera', label: 'Camera', icon: 'camera' },
  { id: 'audio', label: 'Audio', icon: 'volume', editorIcon: true }
]

const TAB_FOR: Record<NonNullable<Selection>['kind'], Tab> = {
  zoom: 'zoom',
  annotation: 'text',
  clip: 'clip',
  gap: 'clip',
  range: 'clip',
  shape: 'shapes',
  spotlight: 'shapes',
  layout: 'camera',
  title: 'text',
  chapter: 'text',
  caption: 'captions',
  freeze: 'clip',
  overlay: 'images',
  click: 'zoom'
}

/**
 * The settings panels, one tab each. The editor owns the open tab (`tab`/`onTab`), so commands
 * can switch it; selecting something on the timeline still reveals its panel.
 */
export const Inspector = memo(function Inspector({ tab, onTab: setTab, ...props }: InspectorProps & { tab: InspectorTab; onTab: (tab: InspectorTab) => void }): JSX.Element {
  const selKind = props.selection?.kind ?? null

  // Selecting something (even the already selected item) reveals its settings.
  // Keyed on the selection counter only, so undo or deselecting never switches tabs.
  // A layout effect, so the old tab is never painted for a frame first.
  const revealKind = useRef(selKind)
  revealKind.current = selKind
  useLayoutEffect(() => {
    if (revealKind.current) setTab(TAB_FOR[revealKind.current])
  }, [props.revealSeq, setTab])

  // On a short window the rail scrolls: keep the open tab (also one opened by a selection or a
  // command) in view.
  const railRef = useRef<HTMLElement>(null)
  // Captions on this PC run for minutes: a ring on the tab while this project's download or job runs.
  const captionsBadge = useCaptionsHost(props.project.id, props.onNotice, tab === 'captions')
  useLayoutEffect(() => {
    railRef.current?.querySelector<HTMLElement>('button.active')?.scrollIntoView({ block: 'nearest' })
  }, [tab])

  // E-06: the Selection view, opened when several items are selected (not from the lists' own
  // toggles), closed by any tab; it goes away with the group.
  const group = useGroup()
  const groupSize = group.group.keys.length
  const [showGroup, setShowGroup] = useState(false)
  useLayoutEffect(() => {
    if (props.groupReveal) setShowGroup(true)
  }, [props.groupReveal])
  useLayoutEffect(() => {
    if (groupSize < 2) setShowGroup(false)
  }, [groupSize])
  const groupShown = showGroup && groupSize >= 2
  const onCommand = props.onCommand ?? group.command

  return (
    <aside className="inspector">
      <nav className="insp-tabs" aria-label="Inspector" ref={railRef}>
        {groupSize >= 2 && (
          <button
            className={`selection-tab ${groupShown ? 'active' : ''}`}
            onClick={() => setShowGroup(true)}
            aria-pressed={groupShown}
            title={`Selection (${groupSize} items)`}
            data-testid="selection-tab"
          >
            <EditorIcon name="check" size={17} />
            <span>Selection</span>
            <span className="selection-badge" aria-hidden="true">
              {groupSize}
            </span>
          </button>
        )}
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id && !groupShown ? 'active' : ''}
            onClick={() => {
              setShowGroup(false)
              setTab(t.id)
            }}
            aria-pressed={tab === t.id && !groupShown}
            title={t.label}
          >
            {t.editorIcon ? <EditorIcon name={t.icon} size={17} /> : <Icon name={t.icon} size={17} />}
            <span>{t.label}</span>
            {t.id === 'captions' && captionsBadge && <span className="captions-job-badge" data-testid="captions-job-badge" data-phase={captionsBadge.phase} title={captionsBadge.title} aria-hidden="true" />}
          </button>
        ))}
      </nav>
      <div className="insp-body" data-tab={groupShown ? 'selection' : tab}>
        {groupShown && <SelectionPanel {...props} onCommand={onCommand} />}
        {!groupShown && tab === 'style' && <StylePanel project={props.project} onBackgroundImage={props.onBackgroundImage} onNotice={props.onNotice} onCrop={props.onCrop} />}
        {!groupShown && tab === 'cursor' && <CursorPanel project={props.project} cursor={props.cursor} recorded={props.recorded} clickRows={props.clickRows} input={props.input} />}
        {!groupShown && tab === 'zoom' && <ZoomPanel {...props} />}
        {!groupShown && tab === 'clip' && <ClipPanel {...props} />}
        {!groupShown && tab === 'text' && <TextPanel {...props} />}
        {!groupShown && tab === 'captions' && <CaptionsPanel {...props} />}
        {!groupShown && tab === 'shapes' && <ShapesPanel {...props} />}
        {!groupShown && tab === 'images' && <ImagesPanel {...props} />}
        {!groupShown && tab === 'effects' && <EffectsPanel project={props.project} cursor={props.cursor} />}
        {!groupShown && tab === 'camera' && <CameraPanel {...props} />}
        {!groupShown && tab === 'audio' && <AudioPanel project={props.project} />}
      </div>
    </aside>
  )
})
