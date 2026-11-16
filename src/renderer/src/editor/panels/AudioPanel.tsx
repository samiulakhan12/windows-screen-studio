import { useEffect, useState, useSyncExternalStore } from 'react'
import { activitySources, AUDIO_LIMITS, audioLook, recordingMix, SOURCE_FILES, STEM_KINDS, stemsOf, type StemKind } from '../../../../shared/audio/settings'
import type { AudioAnalysis } from '../../../../shared/audio/soundtrack'
import { soundDetector, type SoundDetector } from '../../../../shared/audio/voice'
import { duckingVoiceHint } from '../../../../shared/speech/speechCopy'
import { loadAudioAnalysis } from '../audioAnalysis'
import { LOUDNESS_TARGET } from '../../../../shared/audio/loudness'
import { mediaUrl } from '../../../../shared/mediaUrl'
import type { AudioSettings, AudioTrackSettings, MusicSettings, Project } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { pctFmt, Section, Slider, Toggle } from '../controls'
import { EditorIcon } from '../EditorIcon'
import { mediaDuration } from '../media'
import { VoiceSection } from './VoiceSection'
import { SoundsSection } from '../sounds/SoundsSection'
import './audioPanel.css'
import { BedMissingNotice, MusicCredit, MusicLibrarySection } from './MusicLibrarySection'
import { withOwnMusic } from '../../../../shared/audio/soundFxEdit'
import { fmt } from '../../../../shared/i18n/fmt'
import { SoundEffectsSection } from './SoundEffectsSection'
import { t } from '../../../../shared/i18n/t'

/** A recorded source's name: a section title ("Microphone"). */
const stemName = (kind: StemKind): string => t(`sound.stem.${kind}` as const)

/** "Error invoking remote method 'x': Error: message" -> "message". */
const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const secondsFmt = (v: number): string => (v <= 0 ? t('common.state.off') : t('sound.audioPanel.seconds', { n: fmt.number(v, { max: 1 }) }))
const offOrPct = (v: number): string => (v <= 0 ? t('common.state.off') : pctFmt(v))

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
      <Section title={t('sound.audioPanel.recording')}>
        {!project.hasAudio && <p className="hint">{t('sound.audioPanel.thisRecordingHasNo')}</p>}
        <Toggle label={t('sound.audioPanel.mute')} checked={look.muted} disabled={!project.hasAudio} onChange={(v) => setAudio({ muted: v })} />
        <Slider
          label={t('common.label.volume')}
          value={look.volume}
          {...AUDIO_LIMITS.volume}
          step={0.05}
          format={pctFmt}
          disabled={!project.hasAudio || look.muted}
          onChange={(v) => setAudio({ volume: v }, 'audio.volume')}
        />
        <p className="hint">{stems.length > 0 && !failed ? t('sound.audioPanel.pitchAndStems') : t('sound.audioPanel.pitch')}</p>
        {failedStems.length > 0 ? (
          <p className="callout" role="alert" data-testid="stems-missing">
            <EditorIcon name="alert" size={16} />
            <span>
              {t('sound.audioPanel.stemsMissingPreview', missingFiles(failedStems))}
            </span>
          </p>
        ) : (
          player.missingStems.length > 0 && (
            <p className="callout" role="alert" data-testid="stems-missing">
              <EditorIcon name="alert" size={16} />
              <span>
                {t('sound.audioPanel.stemsMissingMixed', { ...missingFiles(player.missingStems), set: sourceSet ? 'yes' : 'no' })}
              </span>
            </p>
          )
        )}
      </Section>

      {stems.map((kind) => (
        <Section key={kind} title={stemName(kind)}>
          <Toggle
            label={t('sound.audioPanel.muteStem', { kind })}
            checked={look[kind].muted}
            disabled={look.muted}
            onChange={(v) => setTrack(kind, { muted: v })}
          />
          <Slider
            label={t('sound.audioPanel.stemVolume', { kind })}
            value={look[kind].volume}
            {...AUDIO_LIMITS.volume}
            step={0.05}
            format={pctFmt}
            disabled={look.muted || look[kind].muted}
            onChange={(v) => setTrack(kind, { volume: v }, `audio.${kind}.volume`)}
          />
        </Section>
      ))}

      {/* The music library and sound effects (docs/design/editing-polish.md §2.6). */}
      <MusicLibrarySection project={project} />
      <MusicSection
        project={project}
        music={look.music}
        canDuck={recordingOn}
        onPicked={(path) => {
          // A new file keeps the settings of the one it replaces (and is no library bed: editing polish §2.6).
          store.update((p) => withOwnMusic(p, path))
          player.reloadMusic()
        }}
        onRemove={() => setAudio({ music: null })}
        setMusic={setMusic}
      />

      <VoiceSection project={project} />

      <SoundsSection project={project} />

      <Section title={t('sound.audioPanel.cleanUp')}>
        <Slider
          label={t('sound.audioPanel.noiseReduction')}
          value={look.noiseReduction}
          min={0}
          max={1}
          step={0.05}
          format={offOrPct}
          disabled={!recordingOn}
          onChange={(v) => setAudio({ noiseReduction: v }, 'audio.noiseReduction')}
        />
        <p className="hint">{stems.includes('mic') ? t('sound.audioPanel.noiseHintMic') : t('sound.audioPanel.noiseHint')}</p>
        <Toggle label={t('sound.audioPanel.evenOutLoudness')} checked={look.normalize} disabled={!recordingOn} onChange={(v) => setAudio({ normalize: v })} />
        <p className="hint">{t('sound.audioPanel.loudnessHint', { lufs: fmt.count(LOUDNESS_TARGET.integrated) })}</p>
      </Section>

      <Section title={t('sound.audioPanel.fades')}>
        <Slider label={t('sound.audioPanel.fadeInAtStart')} value={look.fadeIn} {...AUDIO_LIMITS.fade} step={0.1} format={secondsFmt} onChange={(v) => setAudio({ fadeIn: v }, 'audio.fadeIn')} />
        <Slider label={t('sound.audioPanel.fadeOutAtEnd')} value={look.fadeOut} {...AUDIO_LIMITS.fade} step={0.1} format={secondsFmt} onChange={(v) => setAudio({ fadeOut: v }, 'audio.fadeOut')} />
        <p className="hint">{t('sound.audioPanel.fadesTheWholeSoundtrack')}</p>
      </Section>
      <SoundEffectsSection project={project} />
    </>
  )
}

/** The stems in `kinds` for the missing-files sentences: how many, their names ("system sound") and their files ("system.m4a"). */
function missingFiles(kinds: readonly StemKind[]): { stems: number; names: string; files: string } {
  return {
    stems: kinds.length,
    names: fmt.list(kinds.map((kind) => t('sound.stem.inSentence', { kind }))),
    files: fmt.list(kinds.map((k) => SOURCE_FILES[k]))
  }
}

/* ---------- Music ---------- */

/**
 * What the music ducks under (soundDetector), once the levels the preview's ducking reads are
 * measured (shared with it through loadAudioAnalysis); null until then or when `active` is false.
 */
function useSoundDetector(project: Project, active: boolean): SoundDetector | null {
  const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null)
  const sources = activitySources(project).join(',')
  useEffect(() => {
    if (!active || !sources) return setAnalysis(null)
    let live = true
    void loadAudioAnalysis(project.id, sources.split(',') as ReturnType<typeof activitySources>).then((a) => live && setAnalysis(a))
    return () => {
      live = false
    }
  }, [active, project.id, sources])
  return analysis ? soundDetector(project, analysis) : null
}

function MusicSection(props: {
  project: Project
  music: MusicSettings | null
  canDuck: boolean
  onPicked: (path: string) => void
  onRemove: () => void
  setMusic: (patch: Partial<MusicSettings>, key?: string) => void
}): JSX.Element {
  const { project, music, setMusic } = props
  const detector = useSoundDetector(project, !!music && music.ducking > 0 && props.canDuck)
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
    <Section title={t('sound.audioPanel.music')}>
      {!music ? (
        <div className="music-empty">
          <p className="hint">{t('sound.audioPanel.aTrackUnderThe')}</p>
          <button className="btn" data-testid="music-own-file" disabled={busy} onClick={() => void pick()}>
            <MusicIcon /> {t('sound.audioPanel.yourOwnFile')}
          </button>
        </div>
      ) : (
        <>
          <div className="music-file" data-testid="music-file">
            <span className="music-file-icon">
              <MusicIcon />
            </span>
            <span className="music-file-text">
              <span>{t('sound.audioPanel.backgroundMusic')}</span>
              <span className="muted small">
                {format}
                {length !== null && ` · ${fmt.clock(length, 'whole')}`}
              </span>
            </span>
            <span className="music-file-actions">
              <button className="btn ghost small-btn" disabled={busy} onClick={() => void pick()} title={t('sound.audioPanel.chooseAnotherMusicFile')}>
                {t('sound.audioPanel.replace')}
              </button>
              <button className="btn ghost small-btn icon-only" disabled={busy} onClick={props.onRemove} title={t('sound.audioPanel.removeTheMusic')} aria-label={t('sound.audioPanel.removeMusic')}>
                <Icon name="trash" size={16} />
              </button>
            </span>
          </div>
          <MusicCredit project={project} />
          {missing &&
            (music.library ? (
              <BedMissingNotice project={project} />
            ) : (
              <p className="callout" role="alert" data-testid="music-missing">
                <EditorIcon name="alert" size={16} />
                <span>{t('sound.audioPanel.thisMusicFileIs')}</span>
              </p>
            ))}
          <Slider label={t('sound.audioPanel.musicVolume')} value={music.volume} {...AUDIO_LIMITS.volume} step={0.05} format={pctFmt} onChange={(v) => setMusic({ volume: v }, 'audio.music.volume')} />
          <Slider
            label={t('sound.audioPanel.lowerUnderSpeech')}
            value={music.ducking}
            min={0}
            max={1}
            step={0.05}
            format={offOrPct}
            disabled={!props.canDuck}
            onChange={(v) => setMusic({ ducking: v }, 'audio.music.ducking')}
          />
          <p className="hint">
            {props.canDuck
              ? detector === 'speech'
                ? duckingVoiceHint()
                : t('sound.audioPanel.howFarTheMusic')
              : t('sound.audioPanel.theRecordingIsSilent')}
          </p>
          <Toggle label={t('sound.audioPanel.loop')} title={t('sound.audioPanel.repeatTheMusicWhen')} checked={music.loop} onChange={(v) => setMusic({ loop: v })} />
          <Slider label={t('sound.audioPanel.fadeIn')} value={music.fadeIn} {...AUDIO_LIMITS.musicFade} step={0.1} format={secondsFmt} onChange={(v) => setMusic({ fadeIn: v }, 'audio.music.fadeIn')} />
          <Slider label={t('sound.audioPanel.fadeOut')} value={music.fadeOut} {...AUDIO_LIMITS.musicFade} step={0.1} format={secondsFmt} onChange={(v) => setMusic({ fadeOut: v }, 'audio.music.fadeOut')} />
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
