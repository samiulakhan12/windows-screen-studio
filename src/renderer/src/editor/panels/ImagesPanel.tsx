import { useEffect, useState } from 'react'
import { overlayLabel, resetOverlayShape, sizeForAspect } from '../../../../shared/editor/overlays'
import { OVERLAY_LIMITS } from '../../../../shared/engine/overlayData'
import { formatTime } from '../../../../shared/engine/project'
import { STICKERS, stickerUrl } from '../../../../shared/render/stickers'
import type { ImageOverlay, Project } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { onStyleAssetsChanged } from '../../render/watermarkLayer'
import { overlayStatus } from '../../render/overlayLayer'
import { useEditor } from '../context'
import { pctFmt, Section, Slider } from '../controls'
import { EditorIcon } from '../EditorIcon'
import type { InspectorProps } from '../Inspector'
import { addSticker, ipcMessage, OVERLAY_FORMATS_TEXT, pickOverlay, showOverlay } from '../overlayItems'
import '../overlays.css'

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
      <Section title="Images and stickers">
        <button className="btn" disabled={busy} onClick={() => void run(() => pickOverlay(services, { onSelect: props.onSelect }))} data-testid="add-image">
          <EditorIcon name="image" size={16} /> {busy ? 'Adding…' : 'Add image…'}
        </button>
        <p className="hint">Or drop an image on the editor, or paste one with Ctrl+V. {OVERLAY_FORMATS_TEXT}.</p>
        {error && (
          <p className="callout" role="alert" data-testid="overlay-error">
            <EditorIcon name="alert" size={16} />
            <span>{error}</span>
          </p>
        )}
      </Section>
      <Section title="Stickers">
        <div className="sticker-grid">
          {STICKERS.map((s) => (
            <button
              key={s.id}
              className="sticker-btn"
              aria-label={`Add ${s.name} sticker`}
              title={`Add ${s.name.toLowerCase()} sticker at the playhead`}
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
  const setSize = (v: number): void => set(sizeForAspect(aspect, v), `overlay-size:${o.id}`)
  const imageAspect = status.state === 'ready' ? status.aspect : null
  const shaped = imageAspect !== null && Math.abs(aspect - imageAspect) > 0.01
  return (
    <Section
      title="Selected image"
      aside={
        <span className="muted small">
          {formatTime(o.start)} – {formatTime(o.end)}
        </span>
      }
    >
      <p className="overlay-name" title={overlayLabel(o)}>
        {overlayLabel(o)}
        {status.state === 'ready' && status.frames > 1 && <span className="muted small"> · animated, {status.frames} frames</span>}
      </p>
      {status.state === 'failed' && (
        <p className="callout" role="alert" data-testid="overlay-missing">
          <EditorIcon name="alert" size={16} />
          <span>{status.error} It is left out of the video.</span>
        </p>
      )}
      <Slider label="Position X" value={o.x} min={0} max={1} step={0.005} format={pctFmt} onChange={(v) => set({ x: v }, `overlay-geom:${o.id}`)} />
      <Slider label="Position Y" value={o.y} min={0} max={1} step={0.005} format={pctFmt} onChange={(v) => set({ y: v }, `overlay-geom:${o.id}`)} />
      <Slider label="Size" value={side} min={L.side.min} max={L.side.max} step={0.005} format={pctFmt} onChange={setSize} />
      <Slider
        label="Rotation"
        value={o.rotation}
        min={L.rotation.min}
        max={L.rotation.max}
        step={1}
        format={(v) => `${Math.round(v)}°`}
        onChange={(v) => set({ rotation: v }, `overlay-rotation:${o.id}`)}
      />
      <Slider label="Opacity" value={o.opacity} min={L.opacity.min} max={L.opacity.max} step={0.05} format={pctFmt} onChange={(v) => set({ opacity: v }, `overlay-opacity:${o.id}`)} />
      <Slider label="Fade in" value={o.fadeIn} min={L.fade.min} max={L.fade.max} step={0.1} format={(v) => `${v.toFixed(1)} s`} onChange={(v) => set({ fadeIn: v }, `overlay-fade-in:${o.id}`)} />
      <Slider label="Fade out" value={o.fadeOut} min={L.fade.min} max={L.fade.max} step={0.1} format={(v) => `${v.toFixed(1)} s`} onChange={(v) => set({ fadeOut: v }, `overlay-fade-out:${o.id}`)} />
      <p className="hint">Tip: drag on the preview to move it; handles resize (Shift keeps the shape) and rotate (Shift: 15° steps).</p>
      <div className="row-buttons">
        {shaped && (
          <button className="btn ghost" onClick={() => set(resetOverlayShape(o, imageAspect!))} title="Back to the image's own proportions">
            Reset shape
          </button>
        )}
        <button
          className="btn ghost danger"
          onClick={() => {
            store.update((p) => ({ ...p, overlays: (p.overlays ?? []).filter((x) => x.id !== o.id) }))
            onSelect(null)
          }}
        >
          <Icon name="trash" size={16} /> Delete image
        </button>
      </div>
    </Section>
  )
}

function ImageList({ project, selectedId, onSelect }: { project: Project; selectedId: string | null; onSelect: InspectorProps['onSelect'] }): JSX.Element | null {
  const { player } = useEditor()
  const overlays = project.overlays ?? []
  if (!overlays.length) return null
  return (
    <Section title={`Images in this video (${overlays.length})`}>
      <ul className="item-list">
        {[...overlays]
          .sort((a, b) => a.start - b.start)
          .slice(0, 200)
          .map((o) => (
            <li key={o.id}>
              <button
                aria-current={o.id === selectedId ? 'true' : undefined}
                onClick={() => {
                  onSelect({ kind: 'overlay', id: o.id })
                  showOverlay(player, project.clips, o)
                }}
              >
                <span className="muted">{formatTime(o.start, false)}</span> {overlayLabel(o)}
              </button>
            </li>
          ))}
      </ul>
    </Section>
  )
}
