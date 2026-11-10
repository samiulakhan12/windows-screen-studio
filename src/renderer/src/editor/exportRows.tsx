/**
 * The export dialog's Codec, Background and Frame rate rows (docs/design/output-and-languages.md §2.1).
 * Each is a radio group of chips with one tab stop: the arrows, Home and End move the choice and the
 * focus together, Space and Enter pick, and a disabled chip says why in visible text under the row
 * (a disabled button's tooltip is not announced, §2.8). Their data comes from settingsRows.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import type { MessageKey, MessageValues } from '../../../shared/i18n/t'
import { t } from '../../../shared/i18n/t'
import type { ExportOptions } from '../../../shared/render/exportPresets'
import { CODEC_NAMES, pickBackground, pickCodec, pickFps, type RowChip, type RowsState } from '../../../shared/render/exportRows'
import { codecOf } from '../../../shared/render/proFormats'
import type { ExportCodec, ExportFps } from '../../../shared/types'

interface RowProps {
  rows: RowsState
  options: ExportOptions
  onChange: (o: ExportOptions) => void
}

/** The id of the Frame rate row's label, which the dialog keeps as before; the group is named by it. */
export const FPS_LABEL_ID = 'export-fps-label'

interface RadioChip<V extends string | number> {
  value: V
  label: string
  title?: string
  disabled: boolean
}

/** A radio group of chips (the ARIA radio pattern, as RadioChips in the panels). */
function ChipRadios<V extends string | number>(props: { labelledBy: string; testid: string; value: V; chips: readonly RadioChip<V>[]; onPick: (v: V) => void }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const enabled = props.chips.filter((c) => !c.disabled)
  // The checked chip takes the tab stop; with none checked (or it disabled), the first enabled one.
  const stop = enabled.some((c) => c.value === props.value) ? props.value : enabled[0]?.value
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!enabled.length) return
    const at = Math.max(
      0,
      enabled.findIndex((c) => c.value === props.value)
    )
    let next = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % enabled.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (at - 1 + enabled.length) % enabled.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = enabled.length - 1
    if (next < 0) return
    e.preventDefault()
    // The dialog's keys are its own: never the editor's behind it.
    e.stopPropagation()
    const v = enabled[next].value
    if (v !== props.value) props.onPick(v)
    box.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(String(v))}"]`)?.focus()
  }
  return (
    <div className="chips" role="radiogroup" aria-labelledby={props.labelledBy} data-testid={props.testid} ref={box} onKeyDown={onKey}>
      {props.chips.map((c) => {
        const on = c.value === props.value
        return (
          <button
            key={String(c.value)}
            type="button"
            role="radio"
            aria-checked={on}
            data-value={String(c.value)}
            tabIndex={c.value === stop ? 0 : -1}
            className={`chip ${on ? 'active' : ''}`}
            title={c.title}
            disabled={c.disabled}
            onClick={() => {
              if (!on) props.onPick(c.value)
            }}
          >
            {c.label}
          </button>
        )
      })}
    </div>
  )
}

/** The reasons of a row's disabled chips, each once, as text under the row. */
function Reasons({ chips }: { chips: readonly RowChip<unknown>[] }): JSX.Element | null {
  const keys = [...new Set(chips.map((c) => c.disabled).filter((k): k is MessageKey => !!k))]
  if (!keys.length) return null
  return (
    <>
      {keys.map((k) => (
        <p key={k} className="hint">
          {t(k)}
        </p>
      ))}
    </>
  )
}

/** Each codec's chip label and title keys. */
const CODEC_KEYS: Readonly<Record<ExportCodec, { label: MessageKey; title: MessageKey }>> = {
  h264: { label: 'codecs.codec.h264.label', title: 'codecs.codec.h264.title' },
  hevc: { label: 'codecs.codec.hevc.label', title: 'codecs.codec.hevc.title' },
  av1: { label: 'codecs.codec.av1.label', title: 'codecs.codec.av1.title' },
  vp9: { label: 'codecs.codec.vp9.label', title: 'codecs.codec.vp9.title' },
  cineform: { label: 'codecs.codec.cineform.label', title: 'codecs.codec.cineform.title' },
  animation: { label: 'codecs.codec.animation.label', title: 'codecs.codec.animation.title' },
  'prores-422': { label: 'codecs.codec.prores422.label', title: 'codecs.codec.prores422.title' },
  'prores-4444': { label: 'codecs.codec.prores4444.label', title: 'codecs.codec.prores4444.title' }
}

/** A codec chip's label, as the Codec row shows it ("CineForm (for editing)", "Lossless"). */
export const codecLabel = (codec: ExportCodec): string => t(CODEC_KEYS[codec].label)

/**
 * The Codec row (MP4, MOV and WebM), or null when the format has no codec choice. `hintValues` fill
 * the row's hint ({names}, {size}, {time}, {length}: codecHintValues), `noticeValues` its notice
 * ({codec}, {fallback}: codecNotice). Picking a codec goes through pickCodec.
 */
export function CodecRow(props: RowProps & { hintValues?: MessageValues; noticeValues?: MessageValues }): JSX.Element | null {
  const row = props.rows.codec
  if (!row) return null
  const chips = row.chips.map((c) => ({ value: c.value, label: t(CODEC_KEYS[c.value].label), title: t(c.disabled ?? CODEC_KEYS[c.value].title), disabled: !!c.disabled }))
  return (
    <div className="form-row export-codec">
      <span id="export-codec-label">{t('codecs.row.codec')}</span>
      <div className="export-stack">
        <ChipRadios labelledBy="export-codec-label" testid="export-codec" value={codecOf(props.options)} chips={chips} onPick={(codec) => props.onChange(pickCodec(props.options, codec))} />
        <Reasons chips={row.chips} />
        {row.notice && (
          <p className="hint warn" data-testid="export-codec-notice">
            {t(row.notice, props.noticeValues)}
          </p>
        )}
        {row.hint && (
          <p className="hint" data-testid="export-codec-hint">
            {t(row.hint, props.hintValues)}
          </p>
        )}
      </div>
    </div>
  )
}

type Background = 'with' | 'background' | 'overlays'

const BACKGROUND_KEYS: Readonly<Record<Background, { label: MessageKey; title: MessageKey }>> = {
  with: { label: 'alpha.background.with.label', title: 'alpha.background.with.title' },
  background: { label: 'alpha.background.transparent.label', title: 'alpha.background.transparent.title' },
  overlays: { label: 'alpha.background.overlays.label', title: 'alpha.background.overlays.title' }
}

/**
 * The Background row (MOV and WebM), or null. Transparent and Overlays only switch a codec that
 * cannot be transparent in the same click, and With background gives it back; `replaced` is that
 * codec, kept by the dialog for its session (`onReplaced`). The switch is said under the row ("CineForm
 * keeps the transparency.", "Back to H.264.") while the settings it made still hold.
 */
export function BackgroundRow(props: RowProps & { replaced?: ExportCodec | null; onReplaced?: (codec: ExportCodec | null) => void }): JSX.Element | null {
  const [note, setNote] = useState<{ text: string; codec: ExportCodec; alpha: ExportOptions['alpha'] } | null>(null)
  const row = props.rows.background
  if (!row) return null
  const value: Background = props.options.alpha ?? 'with'
  const pick = (v: Background): void => {
    const alpha = v === 'with' ? undefined : v
    const replaced = props.replaced ?? null
    const result = pickBackground(props.options, alpha, replaced)
    const codec = codecOf(result.options)
    if (alpha && result.replaced && result.replaced !== replaced) setNote({ text: t('alpha.hint.keeps', { codec: CODEC_NAMES[codec] }), codec, alpha })
    else if (!alpha && replaced && codec === replaced) setNote({ text: t('alpha.hint.back', { codec: CODEC_NAMES[replaced] }), codec, alpha })
    else if (!alpha) setNote(null)
    if (result.replaced !== replaced) props.onReplaced?.(result.replaced)
    props.onChange(result.options)
  }
  const shown = note && note.codec === codecOf(props.options) && !!note.alpha === !!props.options.alpha ? note.text : null
  const chips = row.chips.map((c) => ({ value: c.value, label: t(BACKGROUND_KEYS[c.value].label), title: t(c.disabled ?? BACKGROUND_KEYS[c.value].title), disabled: !!c.disabled }))
  return (
    <div className="form-row export-background">
      <span id="export-background-label">{t('alpha.row.background')}</span>
      <div className="export-stack">
        <ChipRadios labelledBy="export-background-label" testid="export-background" value={value} chips={chips} onPick={pick} />
        <Reasons chips={row.chips} />
        {shown && (
          <p className="hint" data-testid="export-background-note">
            {shown}
          </p>
        )}
        {row.hint && (
          <p className="hint" data-testid="export-background-hint">
            {t(row.hint)}
          </p>
        )}
      </div>
    </div>
  )
}

/** The titles of the frame rates of wave 12; 30 and 60 fps have none, as before. */
const FPS_TITLES: Readonly<Partial<Record<ExportFps, MessageKey>>> = { 24: 'codecs.fps.24.title', 25: 'codecs.fps.25.title', 120: 'codecs.fps.120.title' }

/**
 * The Frame rate row's chips, 24, 25, 30, 60 and 120 fps, inside the row the dialog keeps (its label
 * has the id FPS_LABEL_ID), with the reason of a disabled chip and `note` (a pick elsewhere that set
 * the rate: "4K with H.264 is exported at 60 fps.") under them.
 */
export function FrameRateRow(props: RowProps & { note?: string | null }): JSX.Element {
  const chips = props.rows.fps.chips.map((c) => {
    const title = c.disabled ?? FPS_TITLES[c.value]
    return { value: c.value, label: t('codecs.fps.chip', { fps: String(c.value) }), title: title ? t(title) : undefined, disabled: !!c.disabled }
  })
  const radios = <ChipRadios labelledBy={FPS_LABEL_ID} testid="export-fps" value={props.options.fps} chips={chips} onPick={(fps) => props.onChange(pickFps(props.options, fps))} />
  if (!props.rows.fps.reason && !props.note) return radios
  return (
    <div className="export-stack">
      {radios}
      {props.rows.fps.reason && <p className="hint">{t(props.rows.fps.reason)}</p>}
      {props.note && (
        <p className="hint" data-testid="export-fps-note">
          {props.note}
        </p>
      )}
    </div>
  )
}
