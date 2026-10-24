import { useEffect, useState } from 'react'
import { saveErrorMessage } from '../../../../shared/editor/autosave'
import { ASPECT_RATIOS, LOOK_LIMITS, lookOf } from '../../../../shared/editor/styleDefaults'
import { GRADIENTS, gradientCss } from '../../../../shared/engine/backgrounds'
import type { Project } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider } from '../controls'

const L = LOOK_LIMITS

/* ---------- Style ---------- */

export function StylePanel({ project, onBackgroundImage, onNotice }: { project: Project; onBackgroundImage: () => void; onNotice: (message: string) => void }): JSX.Element {
  const { store } = useEditor()
  const { style } = project
  const setStyle = (patch: Partial<Project['style']>, key?: string): void => store.update((p) => ({ ...p, style: { ...p.style, ...patch } }), key)
  return (
    <>
      <Section title="Frame">
        <Chips label="Aspect ratio" value={style.aspectRatio} onChange={(a) => setStyle({ aspectRatio: a })} options={ASPECT_RATIOS.map((a) => ({ value: a, label: a === 'auto' ? 'Auto' : a }))} />
      </Section>
      <Section title="Background">
        <div className="swatches">
          {GRADIENTS.map((g) => (
            <button
              key={g.id}
              title={g.name}
              aria-label={`${g.name} background`}
              className={`swatch ${style.background.type === 'gradient' && style.background.preset === g.id ? 'active' : ''}`}
              style={{ background: gradientCss(g) }}
              onClick={() => setStyle({ background: { type: 'gradient', preset: g.id } })}
            />
          ))}
        </div>
        <div className="row">
          <label className="color-field">
            <input
              type="color"
              value={style.background.type === 'color' ? style.background.color : '#1f2937'}
              onChange={(e) => setStyle({ background: { type: 'color', color: e.target.value } }, 'style.color')}
            />
            Solid colour
          </label>
          <button className={`btn ghost ${style.background.type === 'image' ? 'active' : ''}`} onClick={onBackgroundImage}>
            <Icon name="image" size={16} /> Image…
          </button>
        </div>
      </Section>
      <Section title="Layout">
        <Slider label="Padding" value={style.padding} {...L.padding} step={0.005} format={pctFmt} onChange={(v) => setStyle({ padding: v }, 'style.padding')} />
        <Slider label="Corner radius" value={style.cornerRadius} {...L.cornerRadius} step={1} format={(v) => `${v}px`} onChange={(v) => setStyle({ cornerRadius: v }, 'style.radius')} />
        <Slider label="Shadow" value={style.shadow} {...L.shadow} step={0.05} format={pctFmt} onChange={(v) => setStyle({ shadow: v }, 'style.shadow')} />
      </Section>
      <StyleDefaultsSection project={project} onNotice={onNotice} />
    </>
  )
}

/** Saves this project's look (style, cursor, camera, effects) as the start of every new recording. */
function StyleDefaultsSection({ project, onNotice }: { project: Project; onNotice: (message: string) => void }): JSX.Element {
  // null while unknown (the saved state is read once when the Style tab opens).
  const [saved, setSaved] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    window.api
      .getStyleDefaults()
      .then((d) => live && setSaved(!!d))
      .catch(() => live && setSaved(false))
    return () => {
      live = false
    }
  }, [])

  const run = async (action: () => Promise<string>, failure: string): Promise<void> => {
    setBusy(true)
    try {
      onNotice(await action())
    } catch (err) {
      onNotice(`${failure}: ${saveErrorMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const save = (): Promise<void> =>
    run(async () => {
      await window.api.saveStyleDefaults(lookOf(project))
      setSaved(true)
      return project.style.background.type === 'image' ? 'Saved as default (image backgrounds are not included)' : 'Saved as default for new recordings'
    }, 'Could not save the defaults')

  const reset = (): Promise<void> =>
    run(async () => {
      await window.api.resetStyleDefaults()
      setSaved(false)
      return 'Defaults reset: new recordings use the built-in look'
    }, 'Could not reset the defaults')

  return (
    <Section title="New recordings">
      <p className="hint" data-testid="style-defaults-state">
        {saved
          ? 'New recordings start with your saved look: background, layout, cursor, camera and effects.'
          : 'New recordings start with the built-in look. Save this one to use it for every new recording.'}
      </p>
      <div className="defaults-actions">
        <button className="btn" disabled={busy} onClick={() => void save()}>
          <Icon name="check" size={16} /> Save as default for new recordings
        </button>
        <button className="btn ghost" disabled={busy || !saved} onClick={() => void reset()} title={saved ? 'Go back to the built-in look for new recordings' : 'No defaults are saved'}>
          <Icon name="refresh" size={16} /> Reset defaults
        </button>
      </div>
    </Section>
  )
}
