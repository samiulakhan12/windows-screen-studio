import { ANNOTATION_SIZE } from '../../../../shared/editor/annotations'
import { formatTime } from '../../../../shared/engine/project'
import type { AnnotationStyle } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider } from '../controls'
import { EditorIcon } from '../EditorIcon'
import type { InspectorProps } from '../Inspector'

/* ---------- Text ---------- */

export function TextPanel(props: InspectorProps): JSX.Element {
  const { store, player } = useEditor()
  const { project, selection } = props
  const ann = selection?.kind === 'annotation' ? (project.annotations.find((a) => a.id === selection.id) ?? null) : null
  const set = (patch: Partial<(typeof project.annotations)[number]>, key?: string): void => {
    if (!ann) return
    store.update((p) => ({ ...p, annotations: p.annotations.map((a) => (a.id === ann.id ? { ...a, ...patch } : a)) }), key)
  }

  if (!ann) {
    return (
      <>
        <Section title="Text">
          <button className="btn" onClick={props.onAddText}>
            <EditorIcon name="text" size={16} /> Add text at playhead
          </button>
          <p className="hint">
            Press <kbd>T</kbd> or double-click the text track. Drag a text item on the timeline to change when it shows, and on the preview to move it.
          </p>
        </Section>
        {project.annotations.length > 0 && (
          <Section title={`In this video (${project.annotations.length})`}>
            <ul className="item-list">
              {[...project.annotations]
                .sort((a, b) => a.start - b.start)
                .slice(0, 100)
                .map((a) => (
                  <li key={a.id}>
                    <button
                      onClick={() => {
                        props.onSelect({ kind: 'annotation', id: a.id })
                        player.seek(a.start + Math.min(0.5, (a.end - a.start) / 2))
                      }}
                    >
                      <span className="muted">{formatTime(a.start, false)}</span> {a.text || 'Text'}
                    </button>
                  </li>
                ))}
            </ul>
          </Section>
        )}
      </>
    )
  }

  return (
    <Section title="Selected text" aside={<span className="muted small">{formatTime(ann.start)} – {formatTime(ann.end)}</span>}>
      <label className="field">
        <span>Text</span>
        <textarea className="text-field" rows={2} value={ann.text} onChange={(e) => set({ text: e.target.value }, `annotation-text:${ann.id}`)} placeholder="Type your text" />
      </label>
      <Chips<AnnotationStyle>
        label="Text style"
        value={ann.style}
        onChange={(style) => set({ style })}
        options={[
          { value: 'pill', label: 'Caption pill' },
          { value: 'title', label: 'Title' }
        ]}
      />
      <Slider label="Size" value={ann.size} min={ANNOTATION_SIZE.min} max={ANNOTATION_SIZE.max} step={0.002} format={(v) => `${Math.round(v * 1000) / 10}%`} onChange={(v) => set({ size: v }, `annotation-size:${ann.id}`)} />
      <Slider label="Position X" value={ann.x} min={0} max={1} step={0.005} format={pctFmt} onChange={(v) => set({ x: v }, `annotation-pos:${ann.id}`)} />
      <Slider label="Position Y" value={ann.y} min={0} max={1} step={0.005} format={pctFmt} onChange={(v) => set({ y: v }, `annotation-pos:${ann.id}`)} />
      <p className="hint">Tip: drag the text on the preview to place it.</p>
      <button
        className="btn ghost danger"
        onClick={() => {
          store.update((p) => ({ ...p, annotations: p.annotations.filter((a) => a.id !== ann.id) }))
          props.onSelect(null)
        }}
      >
        <Icon name="trash" size={16} /> Delete text
      </button>
    </Section>
  )
}
