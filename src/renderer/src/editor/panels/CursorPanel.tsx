import { LOOK_LIMITS } from '../../../../shared/editor/styleDefaults'
import type { CursorTrack, Project } from '../../../../shared/types'
import { useEditor } from '../context'
import { pctFmt, Section, Slider, Toggle } from '../controls'
import { EditorIcon } from '../EditorIcon'

const L = LOOK_LIMITS

/* ---------- Cursor ---------- */

export function CursorPanel({ project, cursor: track }: { project: Project; cursor: CursorTrack }): JSX.Element {
  const { store } = useEditor()
  const { cursor } = project
  const set = (patch: Partial<Project['cursor']>, key?: string): void => store.update((p) => ({ ...p, cursor: { ...p.cursor, ...patch } }), key)
  const inVideo = project.capture.cursorInVideo
  const isWindow = project.capture.target === 'window'
  // A drawn cursor only makes sense when the real one is not already in the pixels.
  const smoothAvailable = track.valid && !inVideo
  const smoothOn = smoothAvailable && cursor.show
  return (
    <>
      {!track.valid ? (
        <p className="callout" data-testid="cursor-not-recorded">
          <EditorIcon name="alert" size={16} />
          <span>
            {isWindow
              ? 'Cursor movement was not recorded for this window (its position on screen could not be followed), so cursor effects are not available.'
              : 'Cursor movement was not recorded for this capture, so cursor effects are not available.'}
          </span>
        </p>
      ) : inVideo ? (
        <p className="callout" data-testid="cursor-in-video">
          <EditorIcon name="alert" size={16} />
          <span>
            {isWindow
              ? 'The Windows cursor is part of this video (the window was recorded with standard capture, which includes it), so a smooth cursor would show up as a second cursor. '
              : 'The Windows cursor is part of this video (it was recorded with screen capture), so a smooth cursor would show up as a second cursor. '}
            Smooth cursor and hide-when-idle are therefore off. Click highlights {isWindow ? 'and auto zoom still work' : 'still work on top of the recorded cursor'}.
          </span>
        </p>
      ) : null}
      <Section title="Click highlight">
        <Toggle label="Click effect" checked={track.valid && cursor.clickEffect} disabled={!track.valid} onChange={(v) => set({ clickEffect: v })} />
      </Section>
      <Section title="Smooth cursor">
        <Toggle
          label="Show smooth cursor"
          checked={smoothOn}
          disabled={!smoothAvailable}
          title={smoothAvailable ? undefined : 'Not available: the recorded cursor is in the video'}
          onChange={(v) => set({ show: v })}
        />
        <Slider label="Size" value={cursor.size} {...L.cursorSize} step={0.05} format={(v) => `${v.toFixed(2)}×`} disabled={!smoothOn} onChange={(v) => set({ size: v }, 'cursor.size')} />
        <Slider label="Smoothing" value={cursor.smoothing} {...L.smoothing} step={0.05} format={pctFmt} disabled={!smoothOn} onChange={(v) => set({ smoothing: v }, 'cursor.smoothing')} />
        <Toggle label="Hide when idle" checked={smoothOn && cursor.hideWhenIdle} disabled={!smoothOn} onChange={(v) => set({ hideWhenIdle: v })} />
      </Section>
    </>
  )
}
