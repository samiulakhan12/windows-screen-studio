import { useEffect, useState } from 'react'
import { itemKey } from '../../../../shared/editor/multiSelect'
import { overlayLabel, resetOverlayShape, sizeForAspect } from '../../../../shared/editor/overlays'
import { stickerName } from '../../../../shared/editor/itemNames'
import { OVERLAY_LIMITS } from '../../../../shared/engine/overlayData'
import { STICKERS, stickerUrl } from '../../../../shared/render/stickers'
import { fmt } from '../../../../shared/i18n/fmt'
import type { ImageOverlay, Project } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { onStyleAssetsChanged } from '../../render/watermarkLayer'
import { overlayStatus } from '../../render/overlayLayer'
import { useEditor } from '../context'
import { pctFmt, Section, Slider } from '../controls'
import { EditorIcon } from '../EditorIcon'
import type { InspectorProps } from '../Inspector'
import { addSticker, ipcMessage, pickOverlay, showOverlay } from '../overlayItems'
import { useListSelect } from '../listSelect'
import '../overlays.css'
import { t } from '../../../../shared/i18n/t'
import { Rich } from './Rich'

/* ---------- Images: overlays and stickers (docs/design/brand-kit.md §5) ---------- */

export function ImagesPanel(props: InspectorProps): JSX.Element {
  const { project, selection } = props
  const selected = selection?.kind === 'overlay' ? ((project.overlays ?? []).find((o) => o.id === selection.id) ?? null) : null
  return (
    <>
      {selected && <SelectedImage project={project} overlay={selected} onSelect={props.onSelect} />}
      <AddImages {...props} />
      <ImageList project={project} selectedId={selected?.id ?? null} onSelect={props.onSelect} />
    </>
  )
}

function AddImages(props: InspectorProps): JSX.Element {
  const services = useEditor()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (task: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await task()
    } catch (err) {
      setError(ipcMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Section title={t('text.imagesPanel.imagesAndStickers')}>
        <button className="btn" disabled={busy} onClick={() => void run(() => pickOverlay(services, { onSelect: props.onSelect }))} data-testid="add-image">
          <EditorIcon name="image" size={16} /> {busy ? t('text.imagesPanel.adding') : t('text.imagesPanel.addImage')}
        </button>
        <p className="hint">
          {/* The formats are their own text, as in today's markup, so English lays the line out as before. */}
          <Rich k="text.imagesPanel.dropHint" values={{ keys: 'Ctrl+V', formats: <>{t('text.imagesPanel.formats')}</> }} />
        </p>
        {error && (
          <p className="callout" role="alert" data-testid="overlay-error">
            <EditorIcon name="alert" size={16} />
            <span>{error}</span>
          </p>
        )}
      </Section>
      <Section title={t('text.imagesPanel.stickers')}>
        <div className="sticker-grid">
          {STICKERS.map((s) => (
            <button
              key={s.id}
              className="sticker-btn"
              aria-label={t('text.imagesPanel.addSticker', { name: stickerName(s.id) ?? s.id })}
              title={t('text.imagesPanel.addStickerAtThe', { name: fmt.inSentence(stickerName(s.id) ?? s.id) })}
              disabled={busy}
              onClick={() => void run(() => addSticker(services, s.id, { onSelect: props.onSelect }))}
            >
              <img src={stickerUrl(s)} alt="" width={28} height={28} draggable={false} />
            </button>
          ))}
        </div>
      </Section>
    </>
  )
}

/** Re-renders when a decoded picture arrives (its status and aspect show in the panel). */
function useAssetsVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => onStyleAssetsChanged(() => setV((n) => n + 1)), [])
  return v
}

function SelectedImage({ project, overlay: o, onSelect }: { project: Project; overlay: ImageOverlay; onSelect: InspectorProps['onSelect'] }): JSX.Element {
  const { store } = useEditor()
  useAssetsVersion()
  const status = overlayStatus(project.id, o)
  const set = (patch: Partial<ImageOverlay>, key?: string): void => store.update((p) => ({ ...p, overlays: (p.overlays ?? []).map((x) => (x.id === o.id ? { ...x, ...patch } : x)) }), key)
  const L = OVERLAY_LIMITS
  const side = Math.max(o.w, o.h)
  const aspect = o.w / o.h
  // The smallest long side that keeps the short side at its minimum (sizeForAspect stops there).
  const minSide = Math.min(L.side.max, L.side.min * Math.max(aspect, 1 / aspect))
  const setSize = (v: number): void => set(sizeForAspect(aspect, v), `overlay-size:${o.id}`)
  const imageAspect = status.state === 'ready' ? status.aspect : null
  const shaped = imageAspect !== null && Math.abs(aspect - imageAspect) > 0.01
  return (
    <Section
      title={t('text.imagesPanel.selectedImage')}
      aside={
        <span className="muted small">
          {fmt.clock(o.start)} – {fmt.clock(o.end)}
        </span>
      }
    >
      <p className="overlay-name" title={overlayLabel(o)}>
        {overlayLabel(o)}
        {status.state === 'ready' && status.frames > 1 && <span className="muted small"> · {t('text.imagesPanel.animatedFrames', { n: fmt.count(status.frames) })}</span>}
      </p>
      {status.state === 'failed' && (
        <p className="callout" role="alert" data-testid="overlay-missing">
          <EditorIcon name="alert" size={16} />
          <span>
            {status.error} {t('text.imagesPanel.itIsLeftOut')}
          </span>
        </p>
      )}
      <Slider label={t('text.imagesPanel.positionX')} value={o.x} min={0} max={1} step={0.005} format={pctFmt} onChange={(v) => set({ x: v }, `overlay-geom:${o.id}`)} />
      <Slider label={t('text.imagesPanel.positionY')} value={o.y} min={0} max={1} step={0.005} format={pctFmt} onChange={(v) => set({ y: v }, `overlay-geom:${o.id}`)} />
      <Slider label={t('common.label.size')} value={side} min={minSide} max={L.side.max} step={0.005} format={pctFmt} onChange={setSize} />
      <Slider
        label={t('text.imagesPanel.rotation')}
        value={o.rotation}
        min={L.rotation.min}
        max={L.rotation.max}
        step={1}
        format={(v) => `${Math.round(v)}°`}
        onChange={(v) => set({ rotation: v }, `overlay-rotation:${o.id}`)}
      />
      <Slider label={t('common.label.opacity')} value={o.opacity} min={L.opacity.min} max={L.opacity.max} step={0.05} format={pctFmt} onChange={(v) => set({ opacity: v }, `overlay-opacity:${o.id}`)} />
      <Slider label={t('text.imagesPanel.fadeIn')} value={o.fadeIn} min={L.fade.min} max={L.fade.max} step={0.1} format={(v) => t('text.imagesPanel.seconds', { n: fmt.number(v, { max: 1 }) })} onChange={(v) => set({ fadeIn: v }, `overlay-fade-in:${o.id}`)} />
      <Slider label={t('text.imagesPanel.fadeOut')} value={o.fadeOut} min={L.fade.min} max={L.fade.max} step={0.1} format={(v) => t('text.imagesPanel.seconds', { n: fmt.number(v, { max: 1 }) })} onChange={(v) => set({ fadeOut: v }, `overlay-fade-out:${o.id}`)} />
      <p className="hint">{t('text.imagesPanel.tipDragOnThe')}</p>
      <div className="row-buttons">
        {shaped && (
          <button className="btn ghost" onClick={() => set(resetOverlayShape(o, imageAspect!))} title={t('text.imagesPanel.backToTheImage')}>
            {t('text.imagesPanel.resetShape')}
          </button>
        )}
        <button
          className="btn ghost danger"
          onClick={() => {
            store.update((p) => ({ ...p, overlays: (p.overlays ?? []).filter((x) => x.id !== o.id) }))
            onSelect(null)
          }}
        >
          <Icon name="trash" size={16} /> {t('text.imagesPanel.deleteImage')}
        </button>
      </div>
    </Section>
  )
}

function ImageList({ project, selectedId, onSelect }: { project: Project; selectedId: string | null; onSelect: InspectorProps['onSelect'] }): JSX.Element | null {
  const { player } = useEditor()
  const list = useListSelect()
  const overlays = project.overlays ?? []
  if (!overlays.length) return null
  return (
    <Section title={t('text.imagesPanel.imagesInThisVideo', { n: fmt.count(overlays.length) })}>
      <ul className="item-list">
        {[...overlays]
          .sort((a, b) => a.start - b.start)
          .slice(0, 200)
          .map((o) => (
            <li key={o.id}>
              <button
                data-overlay-item={o.id}
                className={selectedId === o.id || list.member(itemKey('overlay', o.id)) ? 'active' : ''}
                {...list.row(
                  itemKey('overlay', o.id),
                  () => {
                    onSelect({ kind: 'overlay', id: o.id })
                    showOverlay(player, project.clips, o)
                  },
                  selectedId === o.id
                )}
              >
                <span className="muted">{fmt.clock(o.start, 'whole')}</span> {overlayLabel(o)}
              </button>
            </li>
          ))}
      </ul>
    </Section>
  )
}
