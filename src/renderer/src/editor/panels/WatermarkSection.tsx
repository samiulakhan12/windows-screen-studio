import { useState } from 'react'
import { DEFAULT_WATERMARK, WATERMARK_LIMITS, WATERMARK_SIZE, WATERMARK_TEXT_MAX, watermarkSettings } from '../../../../shared/engine/watermark'
import type { Project, WatermarkSettings } from '../../../../shared/types'
import { reloadWatermarkImage } from '../../render/watermarkLayer'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider, Toggle } from '../controls'
import { EditorIcon } from '../EditorIcon'

const POSITIONS: { value: WatermarkSettings['position']; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'center', label: 'Centre' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' }
]

/** "Error invoking remote method 'x': Error: message" -> "message". */
const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Logo or text stamped on every frame, over everything (zoom never moves it). */
export function WatermarkSection({ project }: { project: Project }): JSX.Element {
  const { store, player } = useEditor()
  const wm = watermarkSettings(project.watermark)
  const on = !!wm?.show
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = (patch: Partial<WatermarkSettings>, key?: string): void =>
    store.update((p) => ({ ...p, watermark: { ...(watermarkSettings(p.watermark) ?? DEFAULT_WATERMARK), ...patch } }), key)

  const pickLogo = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const picked = await window.api.pickAsset(project.id, 'watermark')
      if (!picked) return
      // A new image may replace an older one of the same name: decode it before switching.
      await reloadWatermarkImage(project.id, picked.path, picked.url)
      const sizeFor = wm?.kind === 'image' ? wm.size : WATERMARK_SIZE.image
      set({ show: true, kind: 'image', path: picked.path, size: sizeFor })
      player.invalidate()
    } catch (err) {
      setError(ipcMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const chooseKind = (kind: WatermarkSettings['kind']): void => {
    if (kind === wm?.kind) return
    if (kind === 'image' && !wm?.path) {
      void pickLogo()
      return
    }
    // Text height and logo width have very different good sizes.
    set({ kind, size: WATERMARK_SIZE[kind] })
  }

  return (
    <Section title="Watermark">
      <Toggle label="Show watermark" checked={on} onChange={(v) => set({ show: v })} />
      {!on ? (
        <p className="hint">Stamp your logo or name on every frame of the video.</p>
      ) : (
        <>
          <Chips
            label="Watermark type"
            value={wm!.kind}
            onChange={chooseKind}
            options={[
              { value: 'text', label: 'Text' },
              { value: 'image', label: 'Logo', title: 'A PNG, JPG, WebP or SVG logo' }
            ]}
          />
          {wm!.kind === 'text' ? (
            <input
              className="text-input"
              aria-label="Watermark text"
              placeholder="Your name or website"
              maxLength={WATERMARK_TEXT_MAX}
              value={wm!.text ?? ''}
              onChange={(e) => set({ text: e.target.value }, 'watermark.text')}
            />
          ) : (
            <div className="style-file-row">
              <span className="muted small">{wm!.path ?? 'No logo chosen'}</span>
              <button className="btn ghost small-btn" disabled={busy} onClick={() => void pickLogo()}>
                {wm!.path ? 'Change logo…' : 'Choose logo…'}
              </button>
            </div>
          )}
          {error && (
            <p className="callout" role="alert" data-testid="watermark-error">
              <EditorIcon name="alert" size={16} />
              <span>{error}</span>
            </p>
          )}
          <div className="wm-positions" role="radiogroup" aria-label="Watermark position">
            {POSITIONS.map((p) => (
              <button
                key={p.value}
                role="radio"
                aria-checked={wm!.position === p.value}
                aria-label={`Watermark ${p.label.toLowerCase()}`}
                title={p.label}
                className={`wm-position ${p.value} ${wm!.position === p.value ? 'active' : ''}`}
                onClick={() => set({ position: p.value })}
              >
                <span />
              </button>
            ))}
          </div>
          <Slider label="Size" value={wm!.size} {...WATERMARK_LIMITS.size} step={0.005} format={pctFmt} onChange={(v) => set({ size: v }, 'watermark.size')} />
          <Slider label="Opacity" value={wm!.opacity} {...WATERMARK_LIMITS.opacity} step={0.05} format={pctFmt} onChange={(v) => set({ opacity: v }, 'watermark.opacity')} />
          <Slider label="Distance from edge" value={wm!.margin} {...WATERMARK_LIMITS.margin} step={0.005} format={pctFmt} onChange={(v) => set({ margin: v }, 'watermark.margin')} />
        </>
      )}
    </Section>
  )
}
