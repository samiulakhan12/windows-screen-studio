import { CORNERS, LOOK_LIMITS } from '../../../../shared/editor/styleDefaults'
import type { Project } from '../../../../shared/types'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider, Toggle } from '../controls'

const L = LOOK_LIMITS

/* ---------- Camera ---------- */

export function CameraPanel({ project, hasWebcam }: { project: Project; hasWebcam: boolean }): JSX.Element {
  const { store } = useEditor()
  const { webcam } = project
  const set = (patch: Partial<Project['webcam']>, key?: string): void => store.update((p) => ({ ...p, webcam: { ...p.webcam, ...patch } }), key)
  const off = !hasWebcam || !webcam.show
  return (
    <>
      {!hasWebcam && <p className="hint">This recording has no camera. Pick a camera on the home screen before recording.</p>}
      <Section title="Camera">
        <Toggle label="Show camera" checked={hasWebcam && webcam.show} disabled={!hasWebcam} onChange={(v) => set({ show: v })} />
        <Slider label="Size" value={webcam.size} {...L.webcamSize} step={0.01} format={pctFmt} disabled={off} onChange={(v) => set({ size: v }, 'webcam.size')} />
        <Chips
          label="Camera shape"
          value={webcam.shape}
          disabled={off}
          onChange={(shape) => set({ shape })}
          options={[
            { value: 'circle', label: 'Circle' },
            { value: 'rounded', label: 'Rounded' }
          ]}
        />
        <div className="corner-grid" role="group" aria-label="Camera corner">
          {CORNERS.map((c) => (
            <button key={c} disabled={off} className={`corner ${webcam.corner === c ? 'active' : ''} ${c}`} onClick={() => set({ corner: c })} title={c.replace('-', ' ')} aria-label={c.replace('-', ' ')}>
              <span />
            </button>
          ))}
        </div>
      </Section>
    </>
  )
}
