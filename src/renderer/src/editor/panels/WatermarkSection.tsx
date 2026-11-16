import { useState } from 'react'
import { DEFAULT_WATERMARK, WATERMARK_LIMITS, WATERMARK_SIZE, WATERMARK_TEXT_MAX, watermarkSettings } from '../../../../shared/engine/watermark'
import type { Project, WatermarkSettings } from '../../../../shared/types'
import { preloadWatermarkImage } from '../../render/watermarkLayer'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider, Toggle } from '../controls'
import { EditorIcon } from '../EditorIcon'
import { t } from '../../../../shared/i18n/t'

const POSITIONS = (): { value: WatermarkSettings['position']; label: string; name: string }[] => [
  { value: 'top-left', label: t('style.watermarkSection.position.topLeft'), name: t('style.watermarkSection.positionName.topLeft') },
  { value: 'top-right', label: t('style.watermarkSection.position.topRight'), name: t('style.watermarkSection.positionName.topRight') },
  { value: 'center', label: t('style.watermarkSection.position.centre'), name: t('style.watermarkSection.positionName.centre') },
  { value: 'bottom-left', label: t('style.watermarkSection.position.bottomLeft'), name: t('style.watermarkSection.positionName.bottomLeft') },
  { value: 'bottom-right', label: t('style.watermarkSection.position.bottomRight'), name: t('style.watermarkSection.positionName.bottomRight') }
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
      // Each pick is a new file: decode it before switching, so an unreadable one changes nothing.
      try {
        await preloadWatermarkImage(project.id, picked.path, picked.url)
      } catch {
        setError(wm?.kind === 'image' && wm.path ? t('style.watermarkSection.unreadableKept') : t('style.watermarkSection.unreadable'))
        return
      }
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
    <Section title={t('style.watermarkSection.watermark')}>
      <Toggle label={t('style.watermarkSection.showWatermark')} checked={on} onChange={(v) => set({ show: v })} />
      {!on ? (
        <p className="hint">{t('style.watermarkSection.stampYourLogoOr')}</p>
      ) : (
        <>
          <Chips
            label={t('style.watermarkSection.watermarkType')}
            value={wm!.kind}
            onChange={chooseKind}
            options={[
              { value: 'text', label: t('style.watermarkSection.kind.text') },
              { value: 'image', label: t('style.watermarkSection.kind.image'), title: t('style.watermarkSection.kind.image.title') }
            ]}
          />
          {wm!.kind === 'text' ? (
            <input
              className="text-input"
              aria-label={t('style.watermarkSection.watermarkText')}
              placeholder={t('style.watermarkSection.yourNameOrWebsite')}
              maxLength={WATERMARK_TEXT_MAX}
              value={wm!.text ?? ''}
              onChange={(e) => set({ text: e.target.value }, 'watermark.text')}
            />
          ) : (
            <div className="style-file-row">
              <span className="muted small">{wm!.path ?? t('style.watermarkSection.noLogoChosen')}</span>
              <button className="btn ghost small-btn" disabled={busy} onClick={() => void pickLogo()}>
                {wm!.path ? t('style.watermarkSection.changeLogo') : t('style.watermarkSection.chooseLogo')}
              </button>
            </div>
          )}
          {error && (
            <p className="callout" role="alert" data-testid="watermark-error">
              <EditorIcon name="alert" size={16} />
              <span>{error}</span>
            </p>
          )}
          <div className="wm-positions" role="radiogroup" aria-label={t('style.watermarkSection.watermarkPosition')}>
            {POSITIONS().map((p) => (
              <button
                key={p.value}
                role="radio"
                aria-checked={wm!.position === p.value}
                aria-label={p.name}
                title={p.label}
                className={`wm-position ${p.value} ${wm!.position === p.value ? 'active' : ''}`}
                onClick={() => set({ position: p.value })}
              >
                <span />
              </button>
            ))}
          </div>
          <Slider label={t('common.label.size')} value={wm!.size} {...WATERMARK_LIMITS.size} step={0.005} format={pctFmt} onChange={(v) => set({ size: v }, 'watermark.size')} />
          <Slider label={t('common.label.opacity')} value={wm!.opacity} {...WATERMARK_LIMITS.opacity} step={0.05} format={pctFmt} onChange={(v) => set({ opacity: v }, 'watermark.opacity')} />
          <Slider label={t('style.watermarkSection.distanceFromEdge')} value={wm!.margin} {...WATERMARK_LIMITS.margin} step={0.005} format={pctFmt} onChange={(v) => set({ margin: v }, 'watermark.margin')} />
        </>
      )}
    </Section>
  )
}
