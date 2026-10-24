import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import { saveErrorMessage } from '../../../../shared/editor/autosave'
import {
  addUserPreset,
  applyPreset,
  BUILT_IN_PRESETS,
  deleteUserPreset,
  parseUserPresets,
  presetLookOf,
  presetMatches,
  PRESET_NAME_MAX,
  renameUserPreset,
  type StylePreset
} from '../../../../shared/editor/stylePresets'
import type { Project } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Section } from '../controls'
import { lookThumb } from './styleThumbs'

type Naming = { mode: 'new' } | { mode: 'rename'; id: string } | null

/**
 * Named looks: the built-in presets and the user's own (saved in the editor preferences).
 * Applying one is a single undo step; your own can be renamed and deleted.
 */
export function PresetsSection({ project, onNotice }: { project: Project; onNotice: (message: string) => void }): JSX.Element {
  const { store } = useEditor()
  // null while the saved presets are read.
  const [mine, setMine] = useState<StylePreset[] | null>(null)
  const [naming, setNaming] = useState<Naming>(null)
  const [name, setName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    window.api
      .getPref('stylePresets')
      .then((raw) => live && setMine(parseUserPresets(raw)))
      .catch(() => live && setMine([]))
    return () => {
      live = false
    }
  }, [])

  // A pending "Delete?" confirmation lapses after a few seconds.
  useEffect(() => {
    if (!confirmDelete) return
    const timer = window.setTimeout(() => setConfirmDelete(null), 4000)
    return () => window.clearTimeout(timer)
  }, [confirmDelete])

  const persist = async (next: StylePreset[], done: string): Promise<boolean> => {
    setBusy(true)
    try {
      await window.api.setPref('stylePresets', next)
      setMine(next)
      onNotice(done)
      return true
    } catch (err) {
      onNotice(`Could not save your presets: ${saveErrorMessage(err)}`)
      return false
    } finally {
      setBusy(false)
    }
  }

  const apply = (preset: StylePreset): void => store.update((p) => applyPreset(p, preset.look))

  const startNaming = (n: Naming, initial: string): void => {
    setNaming(n)
    setName(initial)
    setConfirmDelete(null)
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!naming || !mine) return
    try {
      if (naming.mode === 'new') {
        const { list, preset } = addUserPreset(mine, name, presetLookOf(project))
        const note = project.style.background.type === 'image' ? ' (without the background image, which belongs to this recording)' : ''
        if (await persist(list, `Saved "${preset.name}"${note}`)) setNaming(null)
      } else {
        const list = renameUserPreset(mine, naming.id, name)
        if (await persist(list, 'Preset renamed')) setNaming(null)
      }
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err))
    }
  }

  const remove = (preset: StylePreset): void => {
    if (!mine) return
    if (confirmDelete !== preset.id) {
      setConfirmDelete(preset.id)
      return
    }
    setConfirmDelete(null)
    void persist(deleteUserPreset(mine, preset.id), `Deleted "${preset.name}"`)
  }

  const onNameKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      setNaming(null)
    }
  }

  const card = (preset: StylePreset, own: boolean): JSX.Element => {
    const active = presetMatches(project, preset.look)
    const renaming = naming?.mode === 'rename' && naming.id === preset.id
    return (
      <div key={preset.id} className={`preset-item ${active ? 'active' : ''}`} data-preset={preset.id}>
        <button className="preset-card" aria-label={`${preset.name} preset`} aria-pressed={active} title={`Apply the ${preset.name} look`} onClick={() => apply(preset)}>
          <img src={lookThumb(preset.look)} alt="" draggable={false} />
          {!renaming && <span className="preset-name">{preset.name}</span>}
        </button>
        {own && !renaming && (
          <span className="preset-tools">
            <button className="preset-tool" title="Rename" aria-label={`Rename ${preset.name}`} disabled={busy} onClick={() => startNaming({ mode: 'rename', id: preset.id }, preset.name)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />
              </svg>
            </button>
            <button
              className={`preset-tool ${confirmDelete === preset.id ? 'confirm' : ''}`}
              title={confirmDelete === preset.id ? 'Click again to delete' : 'Delete'}
              aria-label={confirmDelete === preset.id ? `Confirm deleting ${preset.name}` : `Delete ${preset.name}`}
              disabled={busy}
              onClick={() => remove(preset)}
            >
              {confirmDelete === preset.id ? <span>Delete?</span> : <Icon name="trash" size={12} />}
            </button>
          </span>
        )}
      </div>
    )
  }

  const form = naming && (
    <form className="preset-name-row" onSubmit={(e) => void submit(e)}>
      <input
        className="text-input"
        aria-label={naming.mode === 'new' ? 'New preset name' : 'Preset name'}
        placeholder="Preset name"
        value={name}
        maxLength={PRESET_NAME_MAX}
        autoFocus
        onKeyDown={onNameKey}
        onChange={(e) => setName(e.target.value)}
      />
      <button className="btn primary small-btn" type="submit" disabled={busy || !name.trim()}>
        {naming.mode === 'new' ? 'Save' : 'Rename'}
      </button>
      <button className="btn ghost small-btn" type="button" onClick={() => setNaming(null)}>
        Cancel
      </button>
    </form>
  )

  return (
    <Section title="Presets">
      <div className="preset-grid" data-testid="built-in-presets">
        {BUILT_IN_PRESETS.map((p) => card(p, false))}
      </div>
      {!!mine?.length && (
        <>
          <h4 className="style-subhead">Your presets</h4>
          <div className="preset-grid" data-testid="user-presets">
            {mine.map((p) => card(p, true))}
          </div>
        </>
      )}
      {form || (
        <button className="btn" disabled={!mine || busy} onClick={() => startNaming({ mode: 'new' }, '')}>
          <Icon name="plus" size={16} /> Save this look as a preset…
        </button>
      )}
      <p className="hint">A preset sets the background, card, device frame, cursor look and zoom style in one step; undo brings the previous look back.</p>
    </Section>
  )
}
