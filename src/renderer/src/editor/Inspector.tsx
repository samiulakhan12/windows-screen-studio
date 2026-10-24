import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { CursorTrack, Project, ZoomSegment } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { EditorIcon } from './EditorIcon'
import type { Selection } from './selection'
import { StylePanel } from './panels/StylePanel'
import { CursorPanel } from './panels/CursorPanel'
import { ZoomPanel } from './panels/ZoomPanel'
import { ClipPanel } from './panels/ClipPanel'
import { TextPanel } from './panels/TextPanel'
import { EffectsPanel } from './panels/EffectsPanel'
import { CameraPanel } from './panels/CameraPanel'
import { AudioPanel } from './panels/AudioPanel'

export interface InspectorProps {
  project: Project
  selection: Selection
  /** Increments whenever the user selects something, to reveal its settings again. */
  revealSeq: number
  onSelect: (sel: Selection) => void
  cursor: CursorTrack
  hasWebcam: boolean
  pickFocus: boolean
  onPickFocus: (on: boolean) => void
  /** Where a cursor-following zoom currently looks, so switching it to a fixed point keeps the view. */
  focusFor: (zoom: ZoomSegment) => { x: number; y: number }
  onBackgroundImage: () => void
  onNotice: (message: string) => void
  onAddText: () => void
  onSplit: () => void
  onDeleteClip: (id: string) => void
  onRestore: (start: number, end: number) => void
  onCutRange: (start: number, end: number) => void
}

type Tab = 'style' | 'cursor' | 'zoom' | 'clip' | 'text' | 'effects' | 'camera' | 'audio'

const TABS: { id: Tab; label: string; icon: string; editorIcon?: boolean }[] = [
  { id: 'style', label: 'Style', icon: 'palette' },
  { id: 'cursor', label: 'Cursor', icon: 'cursor' },
  { id: 'zoom', label: 'Zoom', icon: 'zoom' },
  { id: 'clip', label: 'Clip', icon: 'scissors', editorIcon: true },
  { id: 'text', label: 'Text', icon: 'text', editorIcon: true },
  { id: 'effects', label: 'Effects', icon: 'sparkle', editorIcon: true },
  { id: 'camera', label: 'Camera', icon: 'camera' },
  { id: 'audio', label: 'Audio', icon: 'volume', editorIcon: true }
]

const TAB_FOR: Record<NonNullable<Selection>['kind'], Tab> = { zoom: 'zoom', annotation: 'text', clip: 'clip', gap: 'clip', range: 'clip' }


export const Inspector = memo(function Inspector(props: InspectorProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('style')
  const selKind = props.selection?.kind ?? null

  // Selecting something (even the already selected item) reveals its settings.
  // Keyed on the selection counter only, so undo or deselecting never switches tabs.
  // A layout effect, so the old tab is never painted for a frame first.
  const revealKind = useRef(selKind)
  revealKind.current = selKind
  useLayoutEffect(() => {
    if (revealKind.current) setTab(TAB_FOR[revealKind.current])
  }, [props.revealSeq])

  return (
    <aside className="inspector">
      <nav className="insp-tabs" aria-label="Inspector">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)} aria-pressed={tab === t.id} title={t.label}>
            {t.editorIcon ? <EditorIcon name={t.icon} size={17} /> : <Icon name={t.icon} size={17} />}
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      <div className="insp-body" data-tab={tab}>
        {tab === 'style' && <StylePanel project={props.project} onBackgroundImage={props.onBackgroundImage} onNotice={props.onNotice} />}
        {tab === 'cursor' && <CursorPanel project={props.project} cursor={props.cursor} />}
        {tab === 'zoom' && <ZoomPanel {...props} />}
        {tab === 'clip' && <ClipPanel {...props} />}
        {tab === 'text' && <TextPanel {...props} />}
        {tab === 'effects' && <EffectsPanel project={props.project} cursor={props.cursor} />}
        {tab === 'camera' && <CameraPanel project={props.project} hasWebcam={props.hasWebcam} />}
        {tab === 'audio' && <AudioPanel project={props.project} />}
      </div>
    </aside>
  )
})
