/**
 * Captions › Look (docs/design/captions-studio.md §2.4–2.7): Show captions, Make my captions
 * great with its options and its hint, the gallery, the name line with Reset, Save as my style,
 * and the collapsible Text, Colours, Layout, Motion, Emphasis and Speakers sections. On a Classic
 * look today's controls come first and write today's fields; the first change below them turns the
 * look into its Studio twin in the same undo step. Every change of the look sets `picked`; Show
 * captions does not.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { BrandKit } from '../../../../shared/editor/brandKit'
import { readGreatOptions, greatHint, resolveGreatOptions, DEFAULT_GREAT_OPTIONS, type GreatOptions } from '../../../../shared/captions/great'
import { suggestedTile } from '../../../../shared/captions/autoStyle'
import { CAPTION_COLORS, CAPTION_SIZE, captionsOf, HIGHLIGHT_COLORS } from '../../../../shared/captions/settings'
import { legacyTwin } from '../../../../shared/captions/studioEdit'
import type { SavedLook } from '../../../../shared/captions/studioPresets'
import { outputSize } from '../../../../shared/engine/layout'
import type { CaptionSettings, CaptionStudio, Project } from '../../../../shared/types'
import { BRAND_KIT_CHANGED_EVENT } from '../../settings/brandKitEvents'
import { nextLookName, saveLook, useSavedLooks } from '../captionPresets'
import { useEditor } from '../context'
import { Chips, Slider, Toggle } from '../controls'
import { EditorIcon } from '../EditorIcon'
import { useGroup } from '../groupContext'
import { setPreviewLook } from '../previewLook'
import { CaptionGallery } from './CaptionGallery'
import { lookName, pickTile, resetTile, tileName } from './captionTiles'
import { FontPicker } from './FontPicker'
import { GreatOptionsPopover } from './GreatOptions'
import { ShowSpeakerToggle } from './SpeakersSection'
import { ColourControls, EmphasisControls, LayoutControls, MotionControls, SpeakerControls, TextControls } from './StudioControls'
import './captionStudio.css'

/** localStorage key of the open sub-sections (§2.4). */
export const OPEN_KEY = 'captions-look-open'
type Part = 'text' | 'colours' | 'layout' | 'motion' | 'emphasis' | 'speakers'
/** Text and Layout start open: Size, Position and Words on screen are changed most after the look (§2.4). */
const FIRST_OPEN: Readonly<Record<Part, boolean>> = { text: true, colours: false, layout: true, motion: false, emphasis: false, speakers: false }

function readOpen(): Record<Part, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_KEY) ?? 'null') as unknown
    if (raw && typeof raw === 'object') {
      const out = { ...FIRST_OPEN }
      for (const k of Object.keys(FIRST_OPEN) as Part[]) if (typeof (raw as Record<string, unknown>)[k] === 'boolean') out[k] = (raw as Record<Part, boolean>)[k]
      return out
    }
  } catch {
    // A convenience: the first state then.
  }
  return { ...FIRST_OPEN }
}

/** The captions are Bangla: the transcript says so, or most letters of its first captions are Bengali (§0.2, §8.1). */
export function captionsAreBangla(project: Project): boolean {
  const t = project.transcript
  if (!t) return false
  if (t.language?.toLowerCase().split('-')[0] === 'bn') return true
  let letters = 0
  let bengali = 0
  for (const s of t.segments.slice(0, 50)) {
    for (const ch of s.text) {
      if (!/\p{L}/u.test(ch)) continue
      letters++
      if (/\p{Script=Bengali}/u.test(ch)) bengali++
    }
  }
  return letters > 0 && bengali / letters > 0.5
}

/** The brand kit's caption look (the Brand tile and filter), read when the kit changes. */
function useBrandLook(): { look: CaptionStudio; name: string } | null {
  const [brand, setBrand] = useState<{ look: CaptionStudio; name: string } | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void =>
      void window.api.getBrandKit().then(
        (kit: BrandKit) => live && setBrand(kit.captionStyle ? { look: kit.captionStyle.look, name: kit.captionStyle.name } : null),
        () => live && setBrand(null)
      )
    read()
    window.addEventListener(BRAND_KIT_CHANGED_EVENT, read)
    return () => {
      live = false
      window.removeEventListener(BRAND_KIT_CHANGED_EVENT, read)
    }
  }, [])
  return brand
}

/** Make my captions great's saved options (prefs `captionsGreat`), for the button's hint. */
function useGreat(): GreatOptions {
  const [options, setOptions] = useState<GreatOptions>(DEFAULT_GREAT_OPTIONS)
  useEffect(() => {
    let live = true
    const read = (): void =>
      void window.api.getPref('captionsGreat').then(
        (raw) => live && setOptions(readGreatOptions(raw)),
        () => undefined
      )
    read()
    // The options popover saves them; the window's focus coming back is when they may have changed.
    window.addEventListener('focus', read)
    return () => {
      live = false
      window.removeEventListener('focus', read)
    }
  }, [])
  return options
}

/** A collapsible sub-section (§2.4): a heading button with aria-expanded. */
function Part({ id, title, open, onToggle, children }: { id: string; title: string; open: boolean; onToggle: () => void; children: ReactNode }): JSX.Element {
  return (
    <section className="caption-part" data-testid={id}>
      <h4>
        <button type="button" className="caption-part-head" aria-expanded={open} aria-controls={`${id}-body`} onClick={onToggle}>
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" className={`caption-part-chevron ${open ? 'open' : ''}`}>
            <path d="M9 6l6 6-6 6" />
          </svg>
          <span>{title}</span>
        </button>
      </h4>
      {open && (
        <div className="caption-part-body" id={`${id}-body`}>
          {children}
        </div>
      )}
    </section>
  )
}

/** Today's controls of a Classic look (§2.6): they write today's fields, so the look stays on today's code; each sets `picked`. */
function ClassicControls({ project }: { project: Project }): JSX.Element {
  const { store } = useEditor()
  const s = captionsOf(project)
  const set = (patch: Partial<CaptionSettings>, key?: string): void => store.update((p) => ({ ...p, captions: { ...captionsOf(p), ...patch, picked: true } }), key)
  return (
    <div className="caption-classic">
      <div className="field">
        <span className="field-label">Position</span>
        <Chips<CaptionSettings['position']>
          label="Position"
          value={s.position}
          onChange={(position) => set({ position })}
          options={[
            { value: 'bottom', label: 'Bottom' },
            { value: 'middle', label: 'Middle' },
            { value: 'top', label: 'Top' }
          ]}
        />
      </div>
      <FontPicker project={project} value={s.font} apply={(p, font) => ({ ...p, captions: { ...captionsOf(p), font, picked: true } })} />
      <Slider label="Size" value={s.size} min={CAPTION_SIZE.min} max={CAPTION_SIZE.max} step={0.001} format={(v) => `${Math.round(v * 1000) / 10}%`} onChange={(size) => set({ size }, 'caption-size')} />
      <ClassicColor label="Text colour" value={s.color} presets={CAPTION_COLORS} mergeKey="caption-color" onChange={(color, key) => set({ color }, key)} />
      <ClassicColor label="Highlight colour" value={s.highlightColor} presets={HIGHLIGHT_COLORS} mergeKey="caption-highlight" onChange={(highlightColor, key) => set({ highlightColor }, key)} />
      <div className="field">
        <span className="field-label">Background</span>
        <Chips<CaptionSettings['background']>
          label="Background"
          value={s.background}
          onChange={(background) => set({ background })}
          options={[
            { value: 'none', label: 'None', title: 'Text with a thin outline' },
            { value: 'box', label: 'Box', title: 'A dark box behind each line' },
            { value: 'shadow', label: 'Shadow', title: 'A soft shadow behind the text' }
          ]}
        />
      </div>
      <div className="field">
        <span className="field-label">Lines</span>
        <Chips<CaptionSettings['maxLines']>
          label="Lines"
          value={s.maxLines}
          onChange={(maxLines) => set({ maxLines })}
          options={[
            { value: 1, label: 'One line' },
            { value: 2, label: 'Up to two lines' }
          ]}
        />
      </div>
      <ShowSpeakerToggle project={project} />
    </div>
  )
}

function ClassicColor({ label, value, presets, mergeKey, onChange }: { label: string; value: string; presets: string[]; mergeKey: string; onChange: (color: string, key?: string) => void }): JSX.Element {
  const v = value.toLowerCase()
  const custom = !presets.includes(v)
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="shape-colors" role="group" aria-label={label}>
        {presets.map((c) => (
          <button key={c} type="button" className={`shape-color ${v === c ? 'active' : ''}`} style={{ background: c }} title={c} aria-label={`${label} ${c}`} aria-pressed={v === c} onClick={() => onChange(c)} />
        ))}
        <label className={`shape-color custom ${custom ? 'active' : ''}`} title="Pick any colour" style={custom ? { background: value } : undefined}>
          <input type="color" aria-label={`${label} (any colour)`} value={value} onChange={(e) => onChange(e.target.value.toLowerCase(), mergeKey)} />
        </label>
      </div>
    </div>
  )
}

/** Save as my style (§2.4): a name field, Save and Cancel; at most 50 saved looks. */
function SaveStyle({ settings, saved, onSaved }: { settings: CaptionSettings; saved: readonly SavedLook[]; onSaved: (name: string) => void }): JSX.Element {
  const [name, setName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (name === null) {
    return (
      <button
        type="button"
        className="btn small"
        data-testid="caption-style-save"
        onClick={() => {
          setError(null)
          setName(nextLookName(saved))
        }}
      >
        Save as my style
      </button>
    )
  }
  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      // A Classic look is saved as its twin, which draws it the same way (§5.8).
      const entry = await saveLook(name, settings.studio ?? legacyTwin(settings))
      setName(null)
      onSaved(entry.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="caption-save"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label className="field">
        <span>Name</span>
        <input className="tc-input" data-testid="caption-style-name-input" aria-label="Name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="row start">
        <button type="submit" className="btn small primary" disabled={busy || !name.trim()}>
          Save
        </button>
        <button type="button" className="btn small" onClick={() => setName(null)}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="callout" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

export function CaptionLookSection(props: { project: Project; vw: number; vh: number; onGreat(): void; greatBusy: boolean; onGreatCancel(): void }): JSX.Element {
  const { project, vw, vh, onGreat, greatBusy, onGreatCancel } = props
  const { store } = useEditor()
  const group = useGroup()
  const settings = captionsOf(project)
  const size = outputSize(project.style.aspectRatio, vw, vh, 1080)
  const frame = useMemo(() => ({ w: size.width, h: size.height }), [size.width, size.height])
  const { looks: saved } = useSavedLooks()
  const brand = useBrandLook()
  const great = useGreat()
  const hint = useMemo(() => greatHint(resolveGreatOptions(great, project, frame)), [great, project, frame])
  const suggested = useMemo(() => suggestedTile(project, frame), [project, frame])
  const language = captionsAreBangla(project) ? 'bn' : project.transcript?.language
  const name = lookName(settings, saved, brand?.name)
  const reset = resetTile(settings, saved, brand?.look ?? null)
  const [open, setOpenState] = useState(readOpen)
  const toggle = (part: Part): void =>
    setOpenState((o) => {
      const next = { ...o, [part]: !o[part] }
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next))
      } catch {
        // A convenience.
      }
      return next
    })
  // The preview of a hovered tile goes when the section does.
  useEffect(() => () => setPreviewLook(null), [])

  const pick = (tile: string): void => {
    setPreviewLook(null)
    store.update((p) => ({ ...p, captions: pickTile(captionsOf(p), tile, frame, saved, brand?.look ?? null) }))
    group.notice(`Caption style: ${tile === 'brand' && brand ? brand.name : tileName(tile, saved)}`)
  }
  const preview = (tile: string | null): void =>
    setPreviewLook(tile ? { tile, name: tile === 'brand' && brand ? brand.name : tileName(tile, saved), captions: pickTile(captionsOf(store.state), tile, frame, saved, brand?.look ?? null) } : null)
  const classic = !settings.studio
  const speakers = !!project.transcript?.segments.some((s) => s.speaker)

  return (
    <section className="insp-section caption-look" data-testid="caption-look">
      <h3>
        <span>Look</span>
      </h3>
      <div data-testid="captions-show">
        <Toggle
          label="Show captions"
          checked={settings.show}
          onChange={(show) => store.update((p) => ({ ...p, captions: { ...captionsOf(p), show } }))}
          title="Draw the captions on the video (preview and export)"
        />
      </div>
      <div className="caption-great">
        <div className="caption-great-row">
          <button type="button" className="btn primary" data-testid="captions-great" disabled={greatBusy} onClick={onGreat}>
            <EditorIcon name="sparkle" size={16} /> {greatBusy ? 'Working…' : 'Make my captions great'}
          </button>
          {greatBusy && (
            <button type="button" className="btn" onClick={onGreatCancel}>
              Cancel
            </button>
          )}
          <GreatOptionsPopover project={project} />
        </div>
        <p className="hint" data-testid="captions-great-hint">
          {hint}
        </p>
      </div>
      <CaptionGallery value={settings} frame={frame} saved={saved} brand={brand?.look ?? null} suggested={suggested} onPick={pick} onPreview={preview} language={language} />
      <div className="caption-style-line">
        <span data-testid="caption-style-name">{name.edited ? `${name.name} (edited)` : name.name}</span>
        {name.edited && reset && (
          <button type="button" className="btn small" data-testid="caption-style-reset" title={`Go back to ${name.name} as it comes`} onClick={() => pick(reset)}>
            Reset
          </button>
        )}
      </div>
      <SaveStyle settings={settings} saved={saved} onSaved={(n) => group.notice(`Saved “${n}” to your styles`)} />
      {classic && <ClassicControls project={project} />}
      {classic && <p className="hint">{`Changing these makes your own version of ${name.name}. It looks the same.`}</p>}
      <Part id="caption-text" title="Text" open={open.text} onToggle={() => toggle('text')}>
        <TextControls project={project} />
      </Part>
      <Part id="caption-colours" title="Colours" open={open.colours} onToggle={() => toggle('colours')}>
        <ColourControls project={project} />
      </Part>
      <Part id="caption-layout" title="Layout" open={open.layout} onToggle={() => toggle('layout')}>
        <LayoutControls project={project} />
      </Part>
      <Part id="caption-motion" title="Motion" open={open.motion} onToggle={() => toggle('motion')}>
        <MotionControls project={project} />
      </Part>
      <Part id="caption-emphasis" title="Emphasis" open={open.emphasis} onToggle={() => toggle('emphasis')}>
        <EmphasisControls project={project} />
      </Part>
      {speakers && (
        <Part id="caption-speakers" title="Speakers" open={open.speakers} onToggle={() => toggle('speakers')}>
          <SpeakerControls project={project} />
        </Part>
      )}
      <p className="hint">The preview shows the captions exactly as the export draws them.</p>
    </section>
  )
}
