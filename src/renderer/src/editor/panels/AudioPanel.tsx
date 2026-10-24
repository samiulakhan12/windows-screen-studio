import { useEffect, useState, useSyncExternalStore } from 'react'
import { AUDIO_LIMITS, audioLook, DEFAULT_MUSIC, recordingMix, SOURCE_FILES, STEM_KINDS, stemsOf, type StemKind } from '../../../../shared/audio/settings'
import { LOUDNESS_TARGET } from '../../../../shared/audio/loudness'
import { formatTime } from '../../../../shared/engine/project'
import { mediaUrl } from '../../../../shared/mediaUrl'
import type { AudioSettings, AudioTrackSettings, MusicSettings, Project } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { pctFmt, Section, Slider, Toggle } from '../controls'
import { EditorIcon } from '../EditorIcon'
import { mediaDuration } from '../media'
import './audioPanel.css'

const STEM_NAMES: Record<StemKind, string> = { mic: 'Microphone', system: 'System sound' }

/** "Error invoking remote method 'x': Error: message" -> "message". */
const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const secondsFmt = (v: number): string => (v <= 0 ? 'Off' : `${v.toFixed(1)} s`)
const offOrPct = (v: number): string => (v <= 0 ? 'Off' : pctFmt(v))

/* ---------- Audio ---------- */

export function AudioPanel({ project }: { project: Project }): JSX.Element {
  const { store, player } = useEditor()
  const look = audioLook(project.audio)
  const stems = stemsOf(project)
  const recordingOn = recordingMix(project).kind !== 'none'
  // Stem files found missing while editing (the preview plays the mixed sound), or when the
  // project was opened (it opened without its stems: a source's own mute or volume no longer
  // applies). Either way the mixed sound has every source.
  const failed = useSyncExternalStore(player.subscribe, player.getFailedStems)
  const failedStems = failed ? (failed.split(',') as StemKind[]) : []
  const sourceSet = STEM_KINDS.some((k) => look[k].muted || look[k].volume !== 1)
  const setAudio = (patch: Partial<AudioSettings>, key?: string): void => store.update((p) => ({ ...p, audio: { ...p.audio, ...patch } }), key)
  const setTrack = (kind: StemKind, patch: Partial<AudioTrackSettings>, key?: string): void =>
    store.update((p) => ({ ...p, audio: { ...p.audio, [kind]: { ...audioLook(p.audio)[kind], ...patch } } }), key)
  const setMusic = (patch: Partial<MusicSettings>, key?: string): void =>
    store.update((p) => {
      const music = audioLook(p.audio).music
      return music ? { ...p, audio: { ...p.audio, music: { ...music, ...patch } } } : p
    }, key)

  return (
    <>
      <Section title="Recording">
        {!project.hasAudio && <p className="hint">This recording has no sound. You can still add music below.</p>}
        <Toggle label="Mute" checked={look.muted} disabled={!project.hasAudio} onChange={(v) => setAudio({ muted: v })} />
        <Slider
          label="Volume"
          value={look.volume}
          {...AUDIO_LIMITS.volume}
          step={0.05}
          format={pctFmt}
          disabled={!project.hasAudio || look.muted}
          onChange={(v) => setAudio({ volume: v }, 'audio.volume')}
        />
        <p className="hint">
          Sped-up clips keep their pitch.
          {stems.length > 0 && !failed && ' The microphone and the system sound were also kept apart: balance them below.'}
        </p>
        {failedStems.length > 0 ? (
          <p className="callout" role="alert" data-testid="stems-missing">
            <EditorIcon name="alert" size={16} />
            <span>
              {missingFiles(failedStems)} missing, so the preview plays the mixed sound, with every source, whatever is set below. Open the recording again to export it that
              way.
            </span>
          </p>
        ) : (
          player.missingStems.length > 0 && (
            <p className="callout" role="alert" data-testid="stems-missing">
              <EditorIcon name="alert" size={16} />
              <span>
                {missingFiles(player.missingStems)} missing, so a source can no longer be muted or turned down on its own: the preview and the export play the mixed sound,
                with every source{sourceSet ? ', including one you muted or turned down' : ''}. Put the {player.missingStems.length > 1 ? 'files' : 'file'} back in the
                recording's folder and open the recording again to set the sources apart.
              </span>
            </p>
          )
        )}
      </Section>

      {stems.map((kind) => (
        <Section key={kind} title={STEM_NAMES[kind]}>
          <Toggle
            label={`Mute ${STEM_NAMES[kind].toLowerCase()}`}
            checked={look[kind].muted}
            disabled={look.muted}
            onChange={(v) => setTrack(kind, { muted: v })}
          />
          <Slider
            label={`${STEM_NAMES[kind]} volume`}
            value={look[kind].volume}
            {...AUDIO_LIMITS.volume}
            step={0.05}
            format={pctFmt}
            disabled={look.muted || look[kind].muted}
            onChange={(v) => setTrack(kind, { volume: v }, `audio.${kind}.volume`)}
          />
        </Section>
      ))}

      <MusicSection
        project={project}
        music={look.music}
        canDuck={recordingOn}
        onPicked={(path) => {
          // A new file keeps the settings of the one it replaces.
          store.update((p) => ({ ...p, audio: { ...p.audio, music: { ...DEFAULT_MUSIC, ...audioLook(p.audio).music, path } } }))
          player.reloadMusic()
        }}
        onRemove={() => setAudio({ music: null })}
        setMusic={setMusic}
      />

      <Section title="Clean up">
        <Slider
          label="Noise reduction"
          value={look.noiseReduction}
          min={0}
          max={1}
          step={0.05}
          format={offOrPct}
          disabled={!recordingOn}
          onChange={(v) => setAudio({ noiseReduction: v }, 'audio.noiseReduction')}
        />
        <p className="hint">
          Removes steady hiss and hum{stems.includes('mic') ? ' from the microphone' : ''} when exporting; the preview plays the original. Strong settings can thin out quiet speech.
        </p>
        <Toggle label="Even out loudness" checked={look.normalize} disabled={!recordingOn} onChange={(v) => setAudio({ normalize: v })} />
        <p className="hint">A standard loudness ({LOUDNESS_TARGET.integrated} LUFS) for YouTube and social apps. The preview approximates it; the export measures it exactly.</p>
      </Section>

      <Section title="Fades">
        <Slider label="Fade in at start" value={look.fadeIn} {...AUDIO_LIMITS.fade} step={0.1} format={secondsFmt} onChange={(v) => setAudio({ fadeIn: v }, 'audio.fadeIn')} />
        <Slider label="Fade out at end" value={look.fadeOut} {...AUDIO_LIMITS.fade} step={0.1} format={secondsFmt} onChange={(v) => setAudio({ fadeOut: v }, 'audio.fadeOut')} />
        <p className="hint">Fades the whole soundtrack, music and click sounds included.</p>
      </Section>
    </>
  )
}

/** "The system sound file of this recording (system.m4a) is", for the stems in `kinds`. */
function missingFiles(kinds: readonly StemKind[]): string {
  const names = kinds.map((k) => STEM_NAMES[k].toLowerCase()).join(' and ')
  const files = kinds.map((k) => SOURCE_FILES[k]).join(' and ')
  return kinds.length > 1 ? `The ${names} files of this recording (${files}) are` : `The ${names} file of this recording (${files}) is`
}

/* ---------- Music ---------- */

function MusicSection(props: {
  project: Project
  music: MusicSettings | null
  canDuck: boolean
  onPicked: (path: string) => void
  onRemove: () => void
  setMusic: (patch: Partial<MusicSettings>, key?: string) => void
}): JSX.Element {
  const { project, music, setMusic } = props
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(() => Date.now())
  const [length, setLength] = useState<number | null>(null)
  const [missing, setMissing] = useState(false)
  const path = music?.path ?? null

  useEffect(() => {
    setLength(null)
    setMissing(false)
    if (!path) return
    let live = true
    void mediaDuration(mediaUrl(project.id, path, version)).then(async (d) => {
      if (!live) return
      setLength(d)
      // Undo far back can return to a track the folder no longer keeps (only the latest few picks are).
      if (d === null && !(await window.api.assetUrl(project.id, path)) && live) setMissing(true)
    })
    return () => {
      live = false
    }
  }, [project.id, path, version])

  const pick = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const picked = await window.api.pickAsset(project.id, 'music')
      if (!picked) return
      setVersion(Date.now())
      props.onPicked(picked.path)
    } catch (err) {
      setError(ipcMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const format = path ? path.slice(path.lastIndexOf('.') + 1).toUpperCase() : ''
  return (
    <Section title="Music">
      {!music ? (
        <div className="music-empty">
          <p className="hint">A track under the whole video. It runs on through cuts and dips automatically while the recording has sound.</p>
          <button className="btn" disabled={busy} onClick={() => void pick()}>
            <MusicIcon /> Choose music…
          </button>
        </div>
      ) : (
        <>
          <div className="music-file" data-testid="music-file">
            <span className="music-file-icon">
              <MusicIcon />
            </span>
            <span className="music-file-text">
              <span>Background music</span>
              <span className="muted small">
                {format}
                {length !== null && ` · ${formatTime(length, false)}`}
              </span>
            </span>
            <span className="music-file-actions">
              <button className="btn ghost small-btn" disabled={busy} onClick={() => void pick()} title="Choose another music file">
                Replace…
              </button>
              <button className="btn ghost small-btn icon-only" disabled={busy} onClick={props.onRemove} title="Remove the music" aria-label="Remove music">
                <Icon name="trash" size={16} />
              </button>
            </span>
          </div>
          {missing && (
            <p className="callout" role="alert" data-testid="music-missing">
              <EditorIcon name="alert" size={16} />
              <span>This music file is no longer in the recording's folder, so it cannot play or be exported. Choose it again with Replace…</span>
            </p>
          )}
          <Slider label="Music volume" value={music.volume} {...AUDIO_LIMITS.volume} step={0.05} format={pctFmt} onChange={(v) => setMusic({ volume: v }, 'audio.music.volume')} />
          <Slider
            label="Lower under speech"
            value={music.ducking}
            min={0}
            max={1}
            step={0.05}
            format={offOrPct}
            disabled={!props.canDuck}
            onChange={(v) => setMusic({ ducking: v }, 'audio.music.ducking')}
          />
          <p className="hint">
            {props.canDuck ? 'How far the music dips while the recording has sound.' : 'The recording is silent, so the music keeps its volume throughout.'}
          </p>
          <Toggle label="Loop" title="Repeat the music when it is shorter than the video" checked={music.loop} onChange={(v) => setMusic({ loop: v })} />
          <Slider label="Fade in" value={music.fadeIn} {...AUDIO_LIMITS.musicFade} step={0.1} format={secondsFmt} onChange={(v) => setMusic({ fadeIn: v }, 'audio.music.fadeIn')} />
          <Slider label="Fade out" value={music.fadeOut} {...AUDIO_LIMITS.musicFade} step={0.1} format={secondsFmt} onChange={(v) => setMusic({ fadeOut: v }, 'audio.music.fadeOut')} />
        </>
      )}
      {error && (
        <p className="callout" role="alert" data-testid="music-error">
          <EditorIcon name="alert" size={16} />
          <span>{error}</span>
        </p>
      )}
    </Section>
  )
}

function MusicIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d="M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
    </svg>
  )
}
