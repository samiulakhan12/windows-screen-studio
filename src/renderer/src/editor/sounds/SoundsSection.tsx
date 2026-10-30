import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { scanSources, type SoundRow } from '../../../../shared/audio/sounds'
import { actionText, foundText, lengthText, listeningText, rowName, showIgnoredText, SOUNDS_COPY, SOUND_LABELS } from '../../../../shared/audio/soundsCopy'
import { addSpans, bringBack, cutRow, ignoreRow, removeSpan, restoreCut, rowState, type RowState } from '../../../../shared/audio/soundsEdit'
import { outputTimeAt } from '../../../../shared/editor/clips'
import { editToVideo, planOf } from '../../../../shared/engine/freeze'
import { formatTime } from '../../../../shared/engine/project'
import type { Project } from '../../../../shared/types'
import { useEditor } from '../context'
import { Section } from '../controls'
import { EditorIcon } from '../EditorIcon'
import { cancelScan, checkStored, scanState, scanVersion, startScan, subscribeScan } from './soundScan'
import './sounds.css'

/** Seconds played before and after a sound by its Play button. */
const PLAY_AROUND = 0.5

/**
 * The unwanted-sound finder in the Audio panel (docs/design/sound-finder.md §5): Find, progress and
 * Cancel, then the list with Play, Mute, Duck, Cut and Ignore on each row. Every action is one
 * store update (one undo step); the list itself, Play and Show ignored are view state.
 */
export function SoundsSection({ project }: { project: Project }): JSX.Element {
  const { store, player } = useEditor()
  useSyncExternalStore(subscribeScan, scanVersion)
  const state = scanState(project.id)
  const [showIgnored, setShowIgnored] = useState(false)
  const [said, setSaid] = useState('')
  const listRef = useRef<HTMLUListElement>(null)
  const focusKey = useRef<string | null>(null)
  const stopPlay = useRef<(() => void) | null>(null)
  const hasSound = scanSources(project).length > 0
  const stemsKey = `${project.hasAudio}|${project.audioStems?.mic}|${project.audioStems?.system}`

  // Sounds found before come back without listening again.
  useEffect(() => {
    if (hasSound) void checkStored(window.api, project)
  }, [project.id, stemsKey])
  useEffect(() => () => stopPlay.current?.(), [])
  // After an action the row's buttons change: the focus goes to its first one (not to the page,
  // where Delete would remove a timeline item).
  useEffect(() => {
    const key = focusKey.current
    if (!key) return
    focusKey.current = null
    const row = listRef.current?.querySelector<HTMLElement>(`li[data-key="${key}"]`)
    ;(row?.querySelector<HTMLElement>('.sound-actions button') ?? row)?.focus({ preventScroll: true })
  })

  const timeOf = (r: SoundRow): number => editToVideo(planOf(project), outputTimeAt(project.clips, r.start))
  const name = (r: SoundRow): string => rowName(r.kind, timeOf(r))
  const act = (r: SoundRow, edit: (p: Project) => Project, message: string, failed?: string): void => {
    const before = store.state
    if (edit(before) === before) {
      if (failed) setSaid(failed)
      return
    }
    store.update(edit)
    focusKey.current = r.key
    setSaid(message)
  }

  const play = (r: SoundRow): void => {
    stopPlay.current?.()
    player.pause()
    player.seek(Math.max(0, r.start - PLAY_AROUND))
    player.play()
    const until = r.end + PLAY_AROUND
    const timer = window.setInterval(() => {
      if (!player.playing || player.time >= until) {
        stop()
        if (player.playing) player.pause()
      }
    }, 30)
    const stop = (): void => {
      window.clearInterval(timer)
      if (stopPlay.current === stop) stopPlay.current = null
    }
    stopPlay.current = stop
  }

  const rows = state.status === 'done' ? state.rows : []
  const states = new Map<string, RowState>(rows.map((r) => [r.key, rowState(project, r)]))
  const ignoredCount = rows.filter((r) => states.get(r.key) === 'ignored').length
  const shown = rows.filter((r) => showIgnored || states.get(r.key) !== 'ignored')
  const open = rows.filter((r) => states.get(r.key) === 'open')

  return (
    <Section title={SOUNDS_COPY.title}>
      <span className="sr-only" role="status" aria-live="polite">
        {said}
      </span>
      {!hasSound ? (
        <p className="hint">{SOUNDS_COPY.noSound}</p>
      ) : state.status === 'idle' ? (
        <>
          <p className="hint">{state.checking ? SOUNDS_COPY.checking : SOUNDS_COPY.intro}</p>
          <button type="button" className="btn" data-testid="sounds-find" disabled={state.checking} onClick={() => void startScan(window.api, project)}>
            <EditorIcon name="sparkle" size={14} /> {SOUNDS_COPY.find}
          </button>
        </>
      ) : state.status === 'listening' ? (
        <div className="sounds-status" data-testid="sounds-status" data-state="listening">
          <p className="hint" aria-hidden="true">
            {listeningText(state.progress)}
          </p>
          <div className="sounds-bar" role="progressbar" aria-label={SOUNDS_COPY.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.progress * 100)}>
            <span style={{ width: `${Math.round(state.progress * 100)}%` }} />
          </div>
          <button type="button" className="btn" onClick={() => cancelScan(project.id)}>
            {SOUNDS_COPY.cancel}
          </button>
        </div>
      ) : state.status === 'failed' ? (
        <div className="sounds-status" data-testid="sounds-status" data-state="failed">
          <p className="callout" role="alert">
            <EditorIcon name="alert" size={16} />
            <span>{`${SOUNDS_COPY.failed} ${state.message}`}</span>
          </p>
          <button type="button" className="btn" onClick={() => void startScan(window.api, project)}>
            {SOUNDS_COPY.tryAgain}
          </button>
        </div>
      ) : (
        <div data-testid="sounds-status" data-state="done" data-from={state.fromCache ? 'cache' : 'scan'}>
          <p className="hint">{rows.length === 0 ? SOUNDS_COPY.none : foundText(rows.length)}</p>
          {shown.length > 0 && (
            <ul className="sound-list" ref={listRef} data-testid="sound-list">
              {shown.map((r) => (
                <SoundRowItem
                  key={r.key}
                  row={r}
                  state={states.get(r.key) ?? 'open'}
                  time={timeOf(r)}
                  name={name(r)}
                  onPlay={() => play(r)}
                  onMute={() => act(r, (p) => addSpans(p, [r], 'mute'), actionText.mute(name(r)))}
                  onDuck={() => act(r, (p) => addSpans(p, [r], 'duck'), actionText.duck(name(r)))}
                  onCut={() => act(r, (p) => cutRow(p, r), actionText.cut(r.end - r.start), SOUNDS_COPY.wholeVideo)}
                  onIgnore={() => act(r, (p) => ignoreRow(p, r.key), actionText.ignore(name(r)))}
                  onRestore={() => {
                    const s = states.get(r.key)
                    if (s === 'cut') act(r, (p) => restoreCut(p, r), actionText.restore(name(r)), SOUNDS_COPY.restoreCutFailed)
                    else act(r, (p) => removeSpan(p, r.key), actionText.restore(name(r)))
                  }}
                  onBringBack={() => act(r, (p) => bringBack(p, r.key), actionText.bringBack(name(r)))}
                />
              ))}
            </ul>
          )}
          {(open.length > 1 || ignoredCount > 0) && (
            <div className="row start sound-footer">
              {open.length > 1 && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    store.update((p) => addSpans(p, open, 'mute'))
                    // The button goes with the last open row: the focus goes to the first row muted.
                    focusKey.current = open[0].key
                    setSaid(actionText.muteAll(open.length))
                  }}
                >
                  {SOUNDS_COPY.muteAll}
                </button>
              )}
              {ignoredCount > 0 && (
                <label className="sound-show-ignored">
                  <input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} />
                  {showIgnoredText(ignoredCount)}
                </label>
              )}
            </div>
          )}
        </div>
      )}
    </Section>
  )
}

function SoundRowItem(props: {
  row: SoundRow
  state: RowState
  time: number
  name: string
  onPlay: () => void
  onMute: () => void
  onDuck: () => void
  onCut: () => void
  onIgnore: () => void
  onRestore: () => void
  onBringBack: () => void
}): JSX.Element {
  const { row: r, state, name } = props
  const label = SOUND_LABELS[r.kind]
  return (
    <li className="sound-row" data-key={r.key} data-kind={r.kind} data-state={state} tabIndex={-1}>
      <button type="button" className="btn small ghost icon-only sound-play" onClick={props.onPlay} aria-label={`Play ${name}`} title="Play it">
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />
        </svg>
      </button>
      <span className="sound-text">
        <span className="sound-kind">{label}</span>
        <span className="sound-time">
          {formatTime(props.time)} · {lengthText(r.end - r.start)}
        </span>
      </span>
      <span className="sound-actions">
        {state === 'open' ? (
          <>
            <button type="button" className="btn small" onClick={props.onMute} title={SOUNDS_COPY.muteTitle} aria-label={`Mute ${name}`}>
              Mute
            </button>
            <button type="button" className="btn small" onClick={props.onDuck} title={SOUNDS_COPY.duckTitle} aria-label={`Duck ${name}`}>
              Duck
            </button>
            <button type="button" className="btn small" onClick={props.onCut} title={SOUNDS_COPY.cutTitle} aria-label={`Cut ${name}`}>
              Cut
            </button>
            <button type="button" className="btn small ghost" onClick={props.onIgnore} title={SOUNDS_COPY.ignoreTitle} aria-label={`Ignore ${name}`}>
              Ignore
            </button>
          </>
        ) : (
          <>
            <span className="sound-state">{SOUNDS_COPY.states[state]}</span>
            {state === 'ignored' ? (
              <button type="button" className="btn small ghost" onClick={props.onBringBack} title={SOUNDS_COPY.bringBackTitle} aria-label={`Bring back ${name}`}>
                Bring back
              </button>
            ) : (
              <button type="button" className="btn small ghost" onClick={props.onRestore} title={SOUNDS_COPY.restoreTitle} aria-label={`Restore ${name}`}>
                Restore
              </button>
            )}
          </>
        )}
      </span>
    </li>
  )
}
