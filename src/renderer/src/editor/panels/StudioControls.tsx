/**
 * Look › Text, Colours, Layout, Motion, Emphasis and Speakers (docs/design/captions-studio.md
 * §2.6, §2.7). Every change is one undo step (a slider gesture or typing: one per merge key) and
 * goes through editStudio, which sets `picked` and, on a Classic look, makes its Studio twin in
 * the same step. Show speaker names and the emphasis buttons do not set `picked`.
 */
import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { captionLanguage } from '../../../../shared/captions/captionTracks'
import { brandTheme, speakerColors, withTheme } from '../../../../shared/captions/colors'
import { clearEmphasis } from '../../../../shared/captions/marks'
import { catalogFont, catalogId } from '../../../../shared/captions/fontCatalog'
import { captionsOf } from '../../../../shared/captions/settings'
import { speakersOf } from '../../../../shared/captions/speakers'
import { speakerCopy } from '../captionWords'
import { editStudio, legacyTwin, lineLengthOf, setStudioSize, studioSize, withLineLength, withSpeakerNames } from '../../../../shared/captions/studioEdit'
import { STUDIO_LIMITS } from '../../../../shared/captions/studioData'
import { GRADIENTS, SHADOW_CHIPS, THEMES } from '../../../../shared/captions/studioPresets'
import { estimatedShare } from '../../../../shared/captions/transcriptTiming'
import { editorFrame } from '../../../../shared/editor/followEdit'
import { DEFAULT_REFRAME, isTall } from '../../../../shared/engine/reframeData'
import type { CaptionMotion, CaptionSettings, CaptionStudio, ChunkEnter, ChunkExit, EmphasisMark, Project, SpokenMark, StudioBoxKind, StudioCase, StudioChunk, StudioPosition, StudioTheme, WordMotion } from '../../../../shared/types'
import { useEditor, holdGesture } from '../context'
import { Toggle } from '../controls'
import { useGroup } from '../groupContext'
import { findImportantWords } from '../captionCommands'
import { FontPicker } from './FontPicker'
import { ContrastMeter } from './ContrastMeter'
import './captionStudio.css'
import { fmt } from '../../../../shared/i18n/fmt'
import { t, type MessageKey } from '../../../../shared/i18n/t'

/* ---------- the look and its edits ---------- */

/** The look the controls show: the Studio look, or a Classic look's twin (what the first change makes, §5.8). */
function useLook(project: Project): { settings: CaptionSettings; studio: CaptionStudio; edit: (patch: (s: CaptionStudio) => CaptionStudio, key?: string) => void } {
  const { store } = useEditor()
  const settings = captionsOf(project)
  const studio = useMemo(() => settings.studio ?? legacyTwin(settings), [settings])
  const edit = (patch: (s: CaptionStudio) => CaptionStudio, key?: string): void => store.update((p) => ({ ...p, captions: editStudio(captionsOf(p), patch) }), key)
  return { settings, studio, edit }
}

/** The output frame of the project (sizes in tall frames show `size × tall`, §4.1). */
const frameOf = (project: Project): { w: number; h: number } => {
  const f = editorFrame(project)
  return { w: f.outW, h: f.outH }
}

/** Languages whose captions have no capital letters (Case is hidden, §2.6, §0.2). */
const CASELESS = new Set(['bn', 'hi', 'mr', 'ar', 'ur', 'he', 'th', 'ta', 'te', 'zh', 'ja', 'ko'])
/** Languages of joined letters: letter spacing is off (§6.6). */
const JOINED: Readonly<Record<string, MessageKey>> = { ar: 'captions.studio.script.arabic', ur: 'captions.studio.script.urdu' }
/** Languages with digits of their own (the Digits choice, §0.2). */
export const NATIVE_DIGITS: Readonly<Record<string, MessageKey>> = {
  bn: 'captions.studio.digits.native.bangla',
  hi: 'captions.studio.digits.native.devanagari',
  mr: 'captions.studio.digits.native.devanagari',
  ar: 'captions.studio.digits.native.arabic',
  ur: 'captions.studio.digits.native.urdu'
}
const base = (language: string | undefined): string => (language ?? '').split('-')[0].toLowerCase()

/* ---------- small controls ---------- */

/** A labelled slider whose value is spoken with its unit (§2.15); a gesture is one undo step (merge key). */
function StudioSlider(props: { id: string; label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; spoken: (v: number) => string; onChange: (v: number) => void; disabled?: boolean }): JSX.Element {
  const { store } = useEditor()
  return (
    <label className={`slider ${props.disabled ? 'disabled' : ''}`}>
      <span className="slider-head">
        <span>{props.label}</span>
        <span className="muted">{props.format(props.value)}</span>
      </span>
      <input
        type="range"
        data-testid={props.id}
        aria-label={props.label}
        aria-valuetext={props.spoken(props.value)}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onPointerDown={() => holdGesture(store)}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  )
}

/** A field with a visible label above chips (every control has a visible label, §2.15). */
function ChipField<T extends string | number>(props: { id: string; label: string; value: T | null; options: readonly { value: T; label: string; title?: string }[]; onChange: (v: T) => void; hint?: ReactNode }): JSX.Element {
  return (
    <div className="field">
      <span className="field-label">{props.label}</span>
      <div className="chips" role="group" aria-label={props.label} data-testid={props.id}>
        {props.options.map((o) => (
          <button key={String(o.value)} type="button" className={`chip ${o.value === props.value ? 'active' : ''}`} title={o.title} aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
      {props.hint}
    </div>
  )
}

function SelectField<T extends string>(props: { id: string; label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; hint?: string }): JSX.Element {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select data-testid={props.id} value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {props.hint && <span className="hint">{props.hint}</span>}
    </label>
  )
}

/** Five preset colours and any colour, like the legacy look's dots; the picker's stream of changes is one undo step (its merge key). */
function ColorDots(props: { id: string; label: string; value: string; presets: readonly string[]; mergeKey: string; onChange: (color: string, key?: string) => void }): JSX.Element {
  const v = props.value.toLowerCase()
  const custom = !props.presets.includes(v)
  return (
    <div className="field">
      <span className="field-label">{props.label}</span>
      <div className="shape-colors" role="group" aria-label={props.label} data-testid={props.id}>
        {props.presets.map((c) => (
          <button key={c} type="button" className={`shape-color ${v === c ? 'active' : ''}`} style={{ background: c }} title={c} aria-label={`${props.label} ${c}`} aria-pressed={v === c} onClick={() => props.onChange(c)} />
        ))}
        <label className={`shape-color custom ${custom ? 'active' : ''}`} title={t('common.colour.pickAny')} style={custom ? { background: props.value } : undefined}>
          <input type="color" aria-label={t('common.colour.anyFor', { label: props.label })} value={props.value} onChange={(e) => props.onChange(e.target.value.toLowerCase(), props.mergeKey)} />
        </label>
      </div>
    </div>
  )
}

const pct1 = (v: number): string => `${(Math.round(v * 1000) / 10).toString()}%`
const pct = (v: number): string => `${Math.round(v * 100)}%`

/* ---------- Text ---------- */

const WEIGHT_NAMES: Readonly<Record<number, MessageKey>> = {
  300: 'captions.studio.weight.300',
  400: 'captions.studio.weight.400',
  500: 'captions.studio.weight.500',
  600: 'captions.studio.weight.600',
  700: 'captions.studio.weight.700',
  800: 'captions.studio.weight.800',
  900: 'captions.studio.weight.900'
}

/** The weights the look's font has (§2.6): a static family's own, a variable one's within its range; others all. */
export function weightsOf(font: string): number[] {
  const id = catalogId(font)
  const cat = id ? catalogFont(id) : undefined
  const all = [300, 400, 500, 600, 700, 800, 900]
  if (!cat) return all
  if (Array.isArray(cat.weights)) return [...cat.weights]
  const r = cat.weights as { min: number; max: number }
  const out = all.filter((w) => w >= r.min && w <= r.max)
  return out.length ? out : [r.min]
}

export function TextControls(props: { project: Project }): JSX.Element {
  const { project } = props
  const { store } = useEditor()
  const { settings, studio, edit } = useLook(project)
  const frame = frameOf(project)
  // The language drawn: a shown translation's, so Digits, Case and letter spacing match the video.
  const language = base(captionLanguage(project))
  const weights = weightsOf(studio.text.font)
  const shown = studioSize(studio, frame.w, frame.h)
  const joined = JOINED[language]
  return (
    <>
      <FontPicker
        project={project}
        value={studio.text.font === 'system' ? undefined : studio.text.font}
        catalogue
        language={captionLanguage(project)}
        bangla={studio.text.scripts?.bengali?.font}
        testId="caption-font"
        apply={(p, id) => ({ ...p, captions: editStudio(captionsOf(p), (s) => ({ ...s, text: { ...s.text, font: id ?? 'system' } })) })}
      />
      <SelectField<string>
        id="caption-weight"
        label={t('captions.studio.weight')}
        value={String(weights.includes(studio.text.weight) ? studio.text.weight : weights.reduce((a, b) => (Math.abs(b - studio.text.weight) < Math.abs(a - studio.text.weight) ? b : a)))}
        options={weights.map((w) => ({ value: String(w), label: WEIGHT_NAMES[w] ? t(WEIGHT_NAMES[w]) : String(w) }))}
        onChange={(w) => edit((s) => ({ ...s, text: { ...s.text, weight: Number(w) } }))}
      />
      <StudioSlider
        id="caption-size"
        label={t('common.label.size')}
        value={shown}
        min={STUDIO_LIMITS.size.min}
        max={STUDIO_LIMITS.size.max}
        step={0.001}
        format={pct1}
        spoken={(v) => t('captions.studio.percentOfShorter', { n: fmt.number(Math.round(v * 1000) / 10) })}
        onChange={(v) => edit((s) => setStudioSize(s, v, frame.w, frame.h), 'caption-size')}
      />
      {!CASELESS.has(language) && (
        <ChipField<StudioCase>
          id="caption-case"
          label={t('captions.studio.case')}
          value={studio.text.case}
          options={[
            { value: 'asis', label: t('captions.studio.case.asis') },
            { value: 'upper', label: t('captions.studio.case.upper') },
            { value: 'lower', label: t('captions.studio.case.lower') }
          ]}
          onChange={(c) => edit((s) => ({ ...s, text: { ...s.text, case: c } }))}
        />
      )}
      <StudioSlider
        id="caption-tracking"
        label={t('captions.studio.letterSpacing')}
        value={studio.text.tracking}
        min={STUDIO_LIMITS.tracking.min}
        max={STUDIO_LIMITS.tracking.max}
        step={0.005}
        format={pct1}
        spoken={(v) => t('captions.studio.percentOfSize', { n: fmt.number(Math.round(v * 1000) / 10) })}
        disabled={!!joined}
        onChange={(v) => edit((s) => ({ ...s, text: { ...s.text, tracking: v } }), 'caption-tracking')}
      />
      {joined && <p className="hint">{t('captions.studio.trackingOff', { script: t(joined) })}</p>}
      {NATIVE_DIGITS[language] && (
        <ChipField<'asis' | 'native' | 'western'>
          id="caption-digits"
          label={t('captions.studio.digits')}
          value={settings.digits ?? 'asis'}
          options={[
            { value: 'asis', label: t('captions.studio.digits.asis') },
            { value: 'native', label: t(NATIVE_DIGITS[language]) },
            { value: 'western', label: t('captions.studio.digits.western') }
          ]}
          onChange={(d) =>
            store.update((p) => {
              const { digits: _old, ...rest } = captionsOf(p)
              void _old
              // A Classic look cannot draw other digits: like every change below today's controls,
              // the choice makes its Studio twin in the same undo step (§2.4, §5.8).
              return { ...p, captions: { ...rest, studio: rest.studio ?? legacyTwin(rest), ...(d === 'asis' ? {} : { digits: d }), picked: true } }
            })
          }
          hint={<span className="hint">{t('captions.studio.digitsHint')}</span>}
        />
      )}
    </>
  )
}

/* ---------- Colours ---------- */

const TEXT_COLORS = ['#ffffff', '#ffe14d', '#39e508', '#22d3ee', '#111111']
const MARK_COLORS = ['#ffe14d', '#39e508', '#22d3ee', '#ff5c8a', '#ff9f1c']
const EDGE_COLORS = ['#000000', '#ffffff', '#0a0a10', '#1d4ed8', '#c8102e']

const sameTheme = (a: StudioTheme, b: StudioTheme): boolean => (['text', 'spoken', 'emphasis', 'outline', 'box'] as const).every((k) => a[k].toLowerCase() === b[k].toLowerCase())
const shadowChip = (shadow: CaptionStudio['edge']['shadow']): keyof typeof SHADOW_CHIPS | null => {
  if (!shadow || shadow.alpha <= 0) return 'off'
  for (const [k, v] of Object.entries(SHADOW_CHIPS) as [keyof typeof SHADOW_CHIPS, (typeof SHADOW_CHIPS)[keyof typeof SHADOW_CHIPS]][]) {
    if (v.x === shadow.x && v.y === shadow.y && v.blur === shadow.blur && v.alpha === shadow.alpha) return k
  }
  return null
}

/** The playhead and whether the player is paused (the contrast meter measures only then). */
function usePlayhead(): { t: number; paused: boolean } {
  const { player } = useEditor()
  const t = useSyncExternalStore(player.subscribe, () => player.time)
  const playing = useSyncExternalStore(player.subscribe, () => (typeof player.getPlaying === 'function' ? player.getPlaying() : false))
  return { t, paused: !playing }
}

export function ColourControls(props: { project: Project }): JSX.Element {
  const { project } = props
  const { studio, edit } = useLook(project)
  const { t: playhead, paused } = usePlayhead()
  const brandColors = project.brand?.colors ?? []
  const brand = useMemo(() => (brandColors.length >= 2 ? brandTheme(brandColors, studio) : null), [brandColors, studio])
  const themes = [...THEMES.map((x) => ({ id: x.id, name: themeName(x.id, x.name), theme: x.theme, title: themeName(x.id, x.name) })), ...(brand ? [{ id: 'brand', name: t('captions.studio.brand'), theme: brand.theme, title: brand.lightened.length ? t('captions.studio.brandLightened', { count: brand.lightened.length }) : t('captions.studio.brand') }] : [])]
  const theme = studio.theme
  const setColor = (key: keyof StudioTheme) => (c: string, merge?: string) => edit((s) => ({ ...s, theme: { ...s.theme, [key]: c } }), merge)
  const box = studio.box
  const showGlow = studio.edge.glow > 0 || studio.spoken === 'glow'
  const gradients = [...GRADIENTS.map((g) => ({ id: g.id, name: gradientName(g.id, g.name), stops: [...g.stops] })), ...(brandColors.length >= 2 ? [{ id: 'brand', name: t('captions.studio.brand'), stops: brandColors.slice(0, 6) }] : [])]
  return (
    <>
      <div className="field">
        <span className="field-label">{t('captions.studio.theme')}</span>
        <div className="caption-themes" role="group" aria-label={t('captions.studio.theme')} data-testid="caption-theme">
          {themes.map((x) => {
            const on = sameTheme(theme, x.theme)
            return (
              <button key={x.id} type="button" className={`caption-theme ${on ? 'active' : ''}`} aria-pressed={on} title={x.title} onClick={() => edit((s) => withTheme(s, x.theme))}>
                <span className="theme-swatch" aria-hidden="true" style={{ background: x.theme.box, color: x.theme.text, borderColor: x.theme.spoken }}>{t('captions.studio.swatchUpper')}<span style={{ color: x.theme.spoken }}>{t('captions.studio.swatchLower')}</span>
                </span>
                <span>{x.name}</span>
              </button>
            )
          })}
        </div>
      </div>
      <ColorDots id="caption-color-text" label={t('captions.studio.words')} value={theme.text} presets={TEXT_COLORS} mergeKey="caption-color-text" onChange={setColor('text')} />
      <ColorDots id="caption-color-spoken" label={t('captions.studio.spokenWord')} value={theme.spoken} presets={MARK_COLORS} mergeKey="caption-color-spoken" onChange={setColor('spoken')} />
      <ColorDots id="caption-color-emphasis" label={t('captions.studio.emphasis')} value={theme.emphasis} presets={MARK_COLORS} mergeKey="caption-color-emphasis" onChange={setColor('emphasis')} />
      <ColorDots id="caption-color-emphasis2" label={t('captions.studio.secondEmphasis')} value={theme.emphasis2 ?? theme.emphasis} presets={MARK_COLORS} mergeKey="caption-color-emphasis2" onChange={setColor('emphasis2')} />
      <ColorDots id="caption-outline-color" label={t('captions.studio.outlineColour')} value={theme.outline} presets={EDGE_COLORS} mergeKey="caption-color-outline" onChange={setColor('outline')} />
      <StudioSlider
        id="caption-outline"
        label={t('captions.studio.outline')}
        value={studio.edge.outline}
        min={STUDIO_LIMITS.outline.min}
        max={STUDIO_LIMITS.outline.max}
        step={0.005}
        format={pct1}
        spoken={(v) => t('captions.studio.percentOfSize', { n: fmt.number(Math.round(v * 1000) / 10) })}
        onChange={(v) => edit((s) => ({ ...s, edge: { ...s.edge, outline: v } }), 'caption-outline')}
      />
      <ChipField<keyof typeof SHADOW_CHIPS>
        id="caption-shadow"
        label={t('common.label.shadow')}
        value={shadowChip(studio.edge.shadow)}
        options={[
          { value: 'off', label: t('common.state.off') },
          { value: 'soft', label: t('captions.studio.shadow.soft') },
          { value: 'strong', label: t('captions.studio.shadow.strong') },
          { value: 'hard', label: t('captions.studio.shadow.hard') }
        ]}
        onChange={(k) => edit((s) => ({ ...s, edge: { ...s.edge, shadow: { ...SHADOW_CHIPS[k] } } }))}
      />
      <ChipField<StudioBoxKind>
        id="caption-box"
        label={t('common.label.background')}
        value={box.kind}
        options={[
          { value: 'none', label: t('common.state.none') },
          { value: 'line', label: t('captions.studio.box.line') },
          { value: 'chunk', label: t('captions.studio.box.chunk') },
          { value: 'glass', label: t('captions.studio.box.glass') },
          { value: 'band', label: t('captions.studio.box.band') }
        ]}
        onChange={(kind) => edit((s) => ({ ...s, box: { ...s.box, kind } }))}
      />
      {box.kind !== 'none' && (
        <>
          <StudioSlider
            id="caption-box-alpha"
            label={t('captions.studio.backgroundOpacity')}
            value={Math.max(0.3, box.alpha)}
            min={0.3}
            max={1}
            step={0.01}
            format={pct}
            spoken={(v) => t('captions.studio.percent', { n: fmt.count(Math.round(v * 100)) })}
            onChange={(v) => edit((s) => ({ ...s, box: { ...s.box, alpha: v } }), 'caption-box-alpha')}
          />
          <ColorDots id="caption-box-color" label={t('captions.studio.backgroundColour')} value={theme.box} presets={['#0a0a10', '#ffffff', '#c8102e', '#1d4ed8', '#ffe14d']} mergeKey="caption-color-box" onChange={setColor('box')} />
        </>
      )}
      {showGlow && (
        <StudioSlider
          id="caption-glow"
          label={t('captions.studio.glow')}
          value={studio.edge.glow}
          min={0}
          max={1}
          step={0.05}
          format={pct}
          spoken={(v) => t('captions.studio.percent', { n: fmt.count(Math.round(v * 100)) })}
          onChange={(v) => edit((s) => ({ ...s, edge: { ...s.edge, glow: v } }), 'caption-glow')}
        />
      )}
      {studio.spoken === 'gradient' && (
        <div className="field">
          <span className="field-label">{t('captions.studio.gradient')}</span>
          <div className="caption-themes" role="group" aria-label={t('captions.studio.gradient')} data-testid="caption-gradient">
            {gradients.map((g) => {
              const on = !!theme.gradient && theme.gradient.join() === g.stops.join()
              return (
                <button key={g.id} type="button" className={`caption-theme ${on ? 'active' : ''}`} aria-pressed={on} title={g.name} onClick={() => edit((s) => ({ ...s, theme: { ...s.theme, gradient: [...g.stops] } }))}>
                  <span className="theme-swatch" aria-hidden="true" style={{ background: `linear-gradient(90deg, ${g.stops.join(', ')})` }} />
                  <span>{g.name}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
      <ContrastMeter project={project} t={playhead} paused={paused} />
    </>
  )
}

/** A theme's name in the UI language (studioPresets.ts keeps the English: main reads it); an unknown id keeps its own name. */
function themeName(id: string, english: string): string {
  switch (id) {
    case 'classic':
      return t('captions.studio.themeName.classic')
    case 'lime':
      return t('captions.studio.themeName.lime')
    case 'cyan':
      return t('captions.studio.themeName.cyan')
    case 'sunset':
      return t('captions.studio.themeName.sunset')
    case 'candy':
      return t('captions.studio.themeName.candy')
    case 'mono':
      return t('captions.studio.themeName.mono')
    case 'ink':
      return t('captions.studio.themeName.ink')
    default:
      return english
  }
}

/** A gradient's name in the UI language, as themeName. */
function gradientName(id: string, english: string): string {
  switch (id) {
    case 'sunset':
      return t('captions.studio.gradientName.sunset')
    case 'ocean':
      return t('captions.studio.gradientName.ocean')
    case 'candy':
      return t('captions.studio.gradientName.candy')
    default:
      return english
  }
}

/* ---------- Layout ---------- */

const chunks = (): readonly { value: StudioChunk; label: string; title: string }[] => [
  { value: 'phrase', label: t('captions.studio.chunk.phrase'), title: t('captions.studio.chunkTitle.phrase') },
  { value: 'words', label: t('captions.studio.chunk.words'), title: t('captions.studio.chunkTitle.words') },
  { value: 'word', label: t('captions.studio.chunk.word'), title: t('captions.studio.chunkTitle.word') },
  { value: 'stack', label: t('captions.studio.chunk.stack'), title: t('captions.studio.chunkTitle.stack') }
]
const positions = (): readonly { value: StudioPosition; label: string }[] => [
  { value: 'top', label: t('captions.studio.position.top') },
  { value: 'upper', label: t('captions.studio.position.upper') },
  { value: 'middle', label: t('captions.studio.position.middle') },
  { value: 'lower', label: t('captions.studio.position.lower') },
  { value: 'bottom', label: t('captions.studio.position.bottom') }
]

/** The layout with `chunk`, its words and lines brought into that mode's range (§4.1). */
export function withChunk(s: CaptionStudio, chunk: StudioChunk): CaptionStudio {
  const l = s.layout
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
  const words = chunk === 'stack' ? clamp(l.words, 4, 8) : chunk === 'words' ? clamp(l.words, 1, 6) : l.words
  const lines = chunk === 'stack' ? clamp(l.lines, 2, 4) : chunk === 'word' ? l.lines : clamp(l.lines, 1, 2)
  return { ...s, layout: { ...l, chunk, words, lines } }
}

/** The layout at `position`: the Studio anchors of §8.5, no dragged place and no legacy anchor. */
export function withPosition(s: CaptionStudio, position: StudioPosition): CaptionStudio {
  const { place: _p, legacyAnchor: _a, ...layout } = s.layout
  void _p
  void _a
  return { ...s, layout: { ...layout, position } }
}

export function LayoutControls(props: { project: Project }): JSX.Element {
  const { project } = props
  const { studio, edit } = useLook(project)
  const frame = frameOf(project)
  const l = studio.layout
  const tall = isTall(frame.w, frame.h)
  const appSafe = (project.reframe ?? DEFAULT_REFRAME).appSafe
  return (
    <>
      <ChipField<StudioChunk> id="caption-chunk" label={t('captions.studio.wordsOnScreen')} value={l.chunk} options={chunks()} onChange={(c) => edit((s) => withChunk(s, c))} />
      {(l.chunk === 'words' || l.chunk === 'stack') && (
        <StudioSlider
          id="caption-words"
          label={t('captions.studio.wordsAtOnce')}
          value={l.words}
          min={l.chunk === 'stack' ? 4 : 1}
          max={l.chunk === 'stack' ? 8 : 6}
          step={1}
          format={(v) => String(v)}
          spoken={(v) => `${v} ${v === 1 ? 'word' : 'words'}`}
          onChange={(v) => edit((s) => ({ ...s, layout: { ...s.layout, words: v } }), 'caption-words')}
        />
      )}
      {l.chunk !== 'word' && (
        <ChipField<number>
          id="caption-lines"
          label={t('captions.studio.lines')}
          value={l.lines}
          options={
            l.chunk === 'stack'
              ? [
                  { value: 2, label: t('captions.studio.lines.2') },
                  { value: 3, label: t('captions.studio.lines.3') },
                  { value: 4, label: t('captions.studio.lines.4') }
                ]
              : [
                  { value: 1, label: t('captions.studio.lines.1') },
                  { value: 2, label: t('captions.studio.lines.2') }
                ]
          }
          onChange={(n) => edit((s) => ({ ...s, layout: { ...s.layout, lines: n } }))}
        />
      )}
      {l.chunk === 'phrase' && (
        <ChipField<'short' | 'medium' | 'long'>
          id="caption-line-length"
          label={t('captions.studio.lineLength')}
          value={lineLengthOf(studio)}
          options={[
            { value: 'short', label: t('captions.studio.lineLength.short') },
            { value: 'medium', label: t('captions.studio.lineLength.medium') },
            { value: 'long', label: t('captions.studio.lineLength.long') }
          ]}
          onChange={(len) => edit((s) => withLineLength(s, len))}
        />
      )}
      <ChipField<StudioPosition>
        id="caption-position"
        label={t('common.label.position')}
        value={l.place ? null : l.position}
        options={positions()}
        onChange={(position) => edit((s) => withPosition(s, position))}
        hint={<span className="hint">{t('captions.studio.dragHint')}</span>}
      />
      {l.place && (
        <button
          type="button"
          className="btn small"
          data-testid="caption-position-reset"
          onClick={() =>
            edit((s) => {
              const { place: _p, ...layout } = s.layout
              void _p
              return { ...s, layout }
            })
          }
        >{t('captions.studio.resetPosition')}</button>
      )}
      <div data-testid="caption-avoid">
        <Toggle label={t('captions.studio.avoid')} checked={l.avoid} onChange={(avoid) => edit((s) => ({ ...s, layout: { ...s.layout, avoid } }))} />
      </div>
      <p className="hint">{t('captions.studio.avoidHint')}</p>
      {tall && appSafe && <p className="hint">{t('captions.studio.safeHint')}</p>}
    </>
  )
}

/* ---------- Motion ---------- */

const enters = (): readonly { value: ChunkEnter; label: string }[] => [
  { value: 'none', label: t('common.state.none') },
  { value: 'fade', label: t('captions.studio.enter.fade') },
  { value: 'rise', label: t('captions.studio.enter.rise') },
  { value: 'drop', label: t('captions.studio.enter.drop') },
  { value: 'slide', label: t('captions.studio.enter.slide') },
  { value: 'pop', label: t('captions.studio.enter.pop') },
  { value: 'squeeze', label: t('captions.studio.enter.squeeze') },
  { value: 'grow', label: t('captions.studio.enter.grow') },
  { value: 'blur', label: t('captions.studio.enter.blur') },
  { value: 'wipe', label: t('captions.studio.enter.wipe') },
  { value: 'slam', label: t('captions.studio.enter.slam') }
]
const exits = (): readonly { value: ChunkExit; label: string }[] => [
  { value: 'none', label: t('common.state.none') },
  { value: 'fade', label: t('captions.studio.exit.fade') },
  { value: 'rise', label: t('captions.studio.exit.rise') },
  { value: 'shrink', label: t('captions.studio.exit.shrink') },
  { value: 'blur', label: t('captions.studio.exit.blur') }
]
export const wordMotions = (): readonly { value: WordMotion; label: string }[] => [
  { value: 'none', label: t('common.state.none') },
  { value: 'pulse', label: t('captions.studio.word.pulse') },
  { value: 'pop', label: t('captions.studio.word.pop') },
  { value: 'bounce', label: t('captions.studio.word.bounce') },
  { value: 'rise', label: t('captions.studio.word.rise') },
  { value: 'slide', label: t('captions.studio.word.slide') },
  { value: 'fade', label: t('captions.studio.word.fade') },
  { value: 'typewriter', label: t('captions.studio.word.typewriter') },
  { value: 'blur', label: t('captions.studio.word.blur') },
  { value: 'shake', label: t('captions.studio.word.shake') },
  { value: 'wipe', label: t('captions.studio.word.wipe') }
]
const spokenMarks = (): readonly { value: SpokenMark; label: string }[] => [
  { value: 'none', label: t('common.state.none') },
  { value: 'color', label: t('common.label.colour') },
  { value: 'fill', label: t('captions.studio.spoken.fill') },
  { value: 'box', label: t('captions.studio.spoken.box') },
  { value: 'pill', label: t('captions.studio.spoken.pill') },
  { value: 'underline', label: t('captions.studio.spoken.underline') },
  { value: 'weight', label: t('captions.studio.spoken.weight') },
  { value: 'glow', label: t('captions.studio.spoken.glow') },
  { value: 'gradient', label: t('captions.studio.spoken.gradient') }
]
/** A look's own value the menu lacks (Editorial's Grow) shows as itself. */
const withCurrent = <T extends string>(list: readonly { value: T; label: string }[], v: T): readonly { value: T; label: string }[] =>
  list.some((o) => o.value === v) ? list : [...list, { value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }]

/** localStorage key of the closed calm-motion note (§2.6). */
export const CALM_HINT_KEY = 'captions-calm-hint'
const calmHintClosed = (): boolean => {
  try {
    return localStorage.getItem(CALM_HINT_KEY) === 'closed'
  } catch {
    return false
  }
}
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function MotionControls(props: { project: Project }): JSX.Element {
  const { project } = props
  const { settings, studio, edit } = useLook(project)
  const m = studio.motion
  const setMotion = (patch: Partial<CaptionMotion>, key?: string): void => edit((s) => ({ ...s, motion: { ...s.motion, ...patch } }), key)
  const [hintClosed, setHintClosed] = useState(calmHintClosed)
  const estimated = useMemo(() => estimatedShare(project.transcript?.segments ?? []) > 0.1, [project.transcript])
  return (
    <>
      <SelectField<ChunkEnter> id="caption-enter" label={t('captions.studio.enter')} value={m.enter} options={withCurrent(enters(), m.enter)} onChange={(enter) => setMotion({ enter })} />
      <SelectField<ChunkExit>
        id="caption-exit"
        label={t('captions.studio.exit')}
        value={m.exit}
        options={withCurrent(exits(), m.exit)}
        onChange={(exit) => setMotion({ exit })}
        hint={t('captions.studio.exitHint')}
      />
      <SelectField<WordMotion> id="caption-word" label={t('captions.studio.eachWord')} value={m.word} options={withCurrent(wordMotions(), m.word)} onChange={(word) => setMotion({ word })} />
      <SelectField<SpokenMark> id="caption-spoken" label={t('captions.studio.spokenWord')} value={studio.spoken} options={spokenMarks()} onChange={(spoken) => edit((s) => ({ ...s, spoken }))} />
      <ChipField<number>
        id="caption-upcoming"
        label={t('captions.studio.unspoken')}
        value={m.upcoming === 1 ? 1 : m.upcoming === 0 ? 0 : m.upcoming === 0.55 ? 0.55 : null}
        options={[
          { value: 1, label: t('common.action.show') },
          { value: 0.55, label: t('captions.studio.unspokenDim') },
          { value: 0, label: t('common.action.hide') }
        ]}
        onChange={(upcoming) => setMotion({ upcoming })}
      />
      <StudioSlider id="caption-strength" label={t('common.label.strength')} value={m.strength} min={0} max={1} step={0.05} format={pct} spoken={(v) => t('captions.studio.percent', { n: fmt.count(Math.round(v * 100)) })} onChange={(strength) => setMotion({ strength }, 'caption-strength')} />
      {m.strength === 0 && <p className="hint">{t('captions.studio.calmStrength')}</p>}
      <StudioSlider id="caption-speed" label={t('common.label.speed')} value={m.speed} min={0.5} max={2} step={0.1} format={pct} spoken={(v) => t('captions.studio.percent', { n: fmt.count(Math.round(v * 100)) })} onChange={(speed) => setMotion({ speed }, 'caption-speed')} />
      <div data-testid="caption-calm">
        <Toggle
          label={t('captions.studio.calmMotion')}
          checked={!!m.calm}
          onChange={(on) =>
            edit((s) => {
              const { calm: _c, ...motion } = s.motion
              void _c
              return { ...s, motion: on ? { ...motion, calm: true } : motion }
            })
          }
        />
      </div>
      <p className="hint">{t('captions.studio.calmHint')}</p>
      {reducedMotion() && !m.calm && !hintClosed && (
        <p className="hint caption-note" data-testid="caption-calm-note">{t('captions.studio.calmNote')}{' '}
          <button
            type="button"
            className="link"
            onClick={() => {
              setHintClosed(true)
              try {
                localStorage.setItem(CALM_HINT_KEY, 'closed')
              } catch {
                // The note comes back in a new window.
              }
            }}
          >{t('common.action.close')}</button>
        </p>
      )}
      {estimated && <p className="hint">{t('captions.studio.estimated')}</p>}
      {settings.track && <p className="hint">{t('captions.studio.noWordTimes')}</p>}
    </>
  )
}

/* ---------- Emphasis ---------- */

/** Words marked by `marks`. */
export const markedWordCount = (marks: Project['captionMarks']): number => (marks ?? []).reduce((n, m) => n + (m.to - m.from + 1), 0)

export function EmphasisControls(props: { project: Project }): JSX.Element {
  const { project } = props
  const { store } = useEditor()
  const group = useGroup()
  const { studio, edit } = useLook(project)
  const count = markedWordCount(project.captionMarks)
  // On a Classic look emphasis needs the Studio twin (§2.7); the emphasis buttons do not set `picked`.
  const find = (): void => findImportantWords(store, group.notice)
  const clear = (): void => {
    const n = markedWordCount(store.state.captionMarks)
    store.update((p) => clearEmphasis(p))
    group.notice(t('captions.studio.emphasisRemoved', { count: n, n: fmt.count(n) }))
  }
  return (
    <>
      <div className="caption-emphasis-tools">
        <button type="button" className="btn small" data-testid="caption-emphasis-find" onClick={find}>{t('captions.studio.findImportant')}</button>
        <button type="button" className="btn small" data-testid="caption-emphasis-clear" disabled={count === 0} onClick={clear}>{t('captions.studio.clearEmphasis')}</button>
      </div>
      <p className="hint" data-testid="caption-emphasis-count">
        {count ? t('captions.studio.emphasised', { count, n: fmt.count(count) }) : t('captions.studio.noneEmphasised')}
      </p>
      <StudioSlider
        id="caption-emphasis-size"
        label={t('common.label.size')}
        value={studio.emphasis.scale}
        min={STUDIO_LIMITS.emphasisScale.min}
        max={STUDIO_LIMITS.emphasisScale.max}
        step={0.01}
        format={pct}
        spoken={(v) => t('captions.studio.percentOfWords', { n: fmt.count(Math.round(v * 100)) })}
        onChange={(scale) => edit((s) => ({ ...s, emphasis: { ...s.emphasis, scale } }), 'caption-emphasis-size')}
      />
      <FontPicker
        project={project}
        value={studio.emphasis.font}
        catalogue
        language={captionLanguage(project)}
        bangla={studio.text.scripts?.bengali?.font}
        testId="caption-emphasis-font"
        defaultLabel={t('captions.studio.sameAsWords')}
        apply={(p, font) =>
          ({
            ...p,
            captions: editStudio(captionsOf(p), (s) => {
              const { font: _f, ...emphasis } = s.emphasis
              void _f
              return { ...s, emphasis: font ? { ...emphasis, font } : emphasis }
            })
          }) as Project
        }
      />
      <ChipField<EmphasisMark>
        id="caption-emphasis-mark"
        label={t('captions.studio.mark')}
        value={studio.emphasis.mark}
        options={[
          { value: 'none', label: t('common.state.none') },
          { value: 'marker', label: t('captions.studio.markKind.marker') },
          { value: 'underline', label: t('captions.studio.markKind.underline') },
          { value: 'box', label: t('captions.studio.markKind.box') },
          ...(studio.emphasis.mark === 'circle' ? [{ value: 'circle' as const, label: t('captions.studio.markKind.circle') }] : [])
        ]}
        onChange={(mark) => edit((s) => ({ ...s, emphasis: { ...s.emphasis, mark } }))}
      />
      <SelectField<WordMotion> id="caption-emphasis-motion" label={t('common.label.motion')} value={studio.motion.emphasis} options={withCurrent(wordMotions(), studio.motion.emphasis)} onChange={(emphasis) => edit((s) => ({ ...s, motion: { ...s.motion, emphasis } }))} />
      <p className="hint">{t('captions.studio.emphasisHint')}</p>
    </>
  )
}

/* ---------- Speakers ---------- */

/** With NW-09's Show speaker names (its copy and title), which here also turns speaker colours off (§2.6). */
export function SpeakerControls(props: { project: Project }): JSX.Element {
  const { project } = props
  const { store } = useEditor()
  const { settings, studio, edit } = useLook(project)
  const names = settings.showSpeaker === true
  const speakers = useMemo(() => speakersOf(project.transcript?.segments ?? []), [project.transcript])
  const colours = studio.speakerColors && names ? speakerColors(studio, speakers.length) : []
  return (
    <>
      <Toggle label={speakerCopy.showOnVideo} title={speakerCopy.showOnVideoTitle} checked={names} onChange={(on) => store.update((p) => ({ ...p, captions: withSpeakerNames(captionsOf(p), on) }))} />
      <div data-testid="caption-speaker-colors">
        <Toggle
          label={t('captions.studio.speakerColour')}
          checked={!!studio.speakerColors && names}
          disabled={!names}
          onChange={(on) =>
            edit((s) => {
              const { speakerColors: _c, ...rest } = s
              void _c
              return on ? { ...rest, speakerColors: true } : rest
            })
          }
        />
      </div>
      {!names && <p className="hint">{t('captions.studio.speakerNamesFirst')}</p>}
      {names && studio.speakerColors && speakers.length > 0 && colours.length === 0 && <p className="hint">{t('captions.studio.speakerHard')}</p>}
      {colours.length > 0 && (
        <ul className="caption-speaker-dots" aria-label={t('captions.studio.speakerColours')}>
          {speakers.map((sp, i) => (
            <li key={sp.name}>
              <span className="speaker-dot" style={{ background: colours[i] }} aria-hidden="true" />
              {sp.name}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
