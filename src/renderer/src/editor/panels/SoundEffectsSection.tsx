/**
 * Audio tab: Sound effects (docs/design/editing-polish.md §2.6, §10.6, §12). The effects' Volume;
 * four rules (Zooming in, Zooming out, Title cards appear, Texts and shapes appear), each a select
 * of None then the effects that fit it first, with a Play toggle and how often it plays ("Plays 24
 * times"); a link that sets Soft whoosh when zooming in. A rule's sound plays at most once every
 * 3 s (sfxJob); an item's own sound always plays. Each change is one undo step.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { sfxGroupsFor } from '../../../../shared/audio/sfxChoices'
import { withSfxVolume, withSoundRule } from '../../../../shared/audio/soundFxEdit'
import { soundEffect, type SfxUse } from '../../../../shared/audio/soundLibrary'
import { readSfxRef } from '../../../../shared/audio/soundFxData'
import { sfxCounts, SFX_VOLUME, type SfxRule } from '../../../../shared/render/sfxJob'
import type { Project, SfxRef } from '../../../../shared/types'
import { useEditor } from '../context'
import { Slider } from '../controls'
import { createAudio } from '../media'
import { librarySoundUrl } from './MusicLibrarySection'
import './soundLibrary.css'

const RULES: readonly { rule: SfxRule; label: string; use: SfxUse }[] = [
  { rule: 'zoomIn', label: 'Zooming in', use: 'zoom-in' },
  { rule: 'zoomOut', label: 'Zooming out', use: 'zoom-out' },
  { rule: 'titles', label: 'Title cards appear', use: 'titles' },
  { rule: 'callouts', label: 'Texts and shapes appear', use: 'callouts' }
]

const pct = (v: number): string => `${Math.round(v * 100)} %`
/** "Plays 24 times", "Plays once", "Does not play yet". */
export const playsText = (n: number): string => (n === 0 ? 'Does not play yet' : n === 1 ? 'Plays once' : `Plays ${n} times`)

export function SoundEffectsSection(props: { project: Project }): JSX.Element {
  const { project } = props
  const { store } = useEditor()
  const fx = project.soundFx
  const counts = useMemo(() => sfxCounts(project), [project])
  const [playing, setPlaying] = useState<SfxRule | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  useEffect(
    () => () => {
      audio.current?.pause()
      audio.current = null
    },
    []
  )

  const play = (rule: SfxRule, ref: SfxRef | undefined): void => {
    audio.current?.pause()
    audio.current = null
    if (playing === rule || !ref) return setPlaying(null)
    const e = soundEffect(ref.slice(4))
    if (!e) return
    const a = createAudio(librarySoundUrl(e.prepared.file))
    a.volume = Math.min(1, fx?.volume ?? SFX_VOLUME)
    a.onended = () => {
      if (audio.current !== a) return
      audio.current = null
      setPlaying(null)
    }
    audio.current = a
    void a.play().catch(() => undefined)
    setPlaying(rule)
  }
  const setRule = (rule: SfxRule, value: string): void => store.update((p) => withSoundRule(p, rule, readSfxRef(value) ?? null))

  return (
    <section className="insp-section sfx-section" data-testid="sfx-section">
      <h3>
        <span>Sound effects</span>
      </h3>
      <div data-testid="sfx-volume">
        <Slider label="Volume" value={fx?.volume ?? SFX_VOLUME} min={0} max={1} step={0.05} format={pct} onChange={(v) => store.update((p) => withSfxVolume(p, v), 'soundFx.volume')} />
      </div>
      {RULES.map(({ rule, label, use }) => {
        const ref = fx?.[rule]
        const title = ref ? (soundEffect(ref.slice(4))?.title ?? '') : ''
        return (
          <div key={rule} className="sfx-rule">
            <label className="field">
              <span>{label}</span>
              <select data-testid={`sfx-rule-${rule}`} aria-label={label} value={ref ?? 'none'} onChange={(e) => setRule(rule, e.target.value)}>
                <option value="none">None</option>
                {sfxGroupsFor(use).map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <span className="sfx-rule-actions">
              <button
                type="button"
                className="btn ghost small-btn"
                data-testid={`sfx-play-${rule}`}
                aria-pressed={playing === rule}
                aria-label={ref ? `Play ${title}` : `Play the sound for ${label.toLowerCase()}`}
                disabled={!ref}
                onClick={() => play(rule, ref)}
              >
                {playing === rule ? 'Stop' : 'Play'}
              </button>
              {ref && (
                <span className="hint sfx-count" data-testid={`sfx-count-${rule}`}>
                  {playsText(counts[rule])}
                </span>
              )}
            </span>
          </div>
        )
      })}
      <button type="button" className="link sfx-soft-whoosh" data-testid="sfx-soft-whoosh" onClick={() => setRule('zoomIn', 'sfx:whoosh-soft')}>
        Soft whoosh when zooming in
      </button>
      <p className="hint">A sound set here plays at most once every 3 seconds. A sound set on one item always plays.</p>
    </section>
  )
}
