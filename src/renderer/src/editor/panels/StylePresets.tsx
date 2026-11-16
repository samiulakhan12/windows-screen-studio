import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
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
  MAX_USER_PRESETS,
  PresetError,
  renameUserPreset,
  type StylePreset
} from '../../../../shared/editor/stylePresets'
import { presetLabel } from '../../../../shared/editor/stylePresetNames'
import type { Project } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Section } from '../controls'
import { lookThumb } from './styleThumbs'
import { t } from '../../../../shared/i18n/t'
import { fmt } from '../../../../shared/i18n/fmt'

type Naming = { mode: 'new' } | { mode: 'rename'; id: string } | null

/** Whether the preset gallery is open; kept while the editor runs, so switching tabs does not close it. */
let galleryOpen = false

/**
 * Named looks: the built-in presets and the user's own (saved in the editor preferences).
 * Applying one is a single undo step; your own can be renamed and deleted.
 */
/** What the panel says for a preset that could not be added or renamed. */
function presetErrorText(err: PresetError): string {
  if (err.code === 'no-name') return t('style.stylePresets.error.noName')
  if (err.code === 'unusable') return t('style.stylePresets.error.unusable')
  return t('style.stylePresets.error.full', { max: fmt.count(MAX_USER_PRESETS) })
}

export function PresetsSection({ project, onNotice }: { project: Project; onNotice: (message: string) => void }): JSX.Element {
  const { store } = useEditor()
  // null while the saved presets are read.
  const [mine, setMine] = useState<StylePreset[] | null>(null)
  const [naming, setNaming] = useState<Naming>(null)
  const [name, setName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpenState] = useState(galleryOpen)
  const setOpen = (v: boolean): void => {
    galleryOpen = v
    setOpenState(v)
  }

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
      onNotice(t('style.stylePresets.notSaved', { reason: saveErrorMessage(err) }))
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
        const saved = project.style.background.type === 'image' ? t('style.stylePresets.savedWithoutImage', { name: preset.name }) : t('style.stylePresets.saved', { name: preset.name })
        if (await persist(list, saved)) setNaming(null)
      } else {
        const list = renameUserPreset(mine, naming.id, name)
        if (await persist(list, t('style.stylePresets.renamed'))) setNaming(null)
      }
    } catch (err) {
      onNotice(err instanceof PresetError ? presetErrorText(err) : err instanceof Error ? err.message : String(err))
    }
  }

  const remove = (preset: StylePreset): void => {
    if (!mine) return
    if (confirmDelete !== preset.id) {
      setConfirmDelete(preset.id)
      return
    }
    setConfirmDelete(null)
    void persist(deleteUserPreset(mine, preset.id), t('style.stylePresets.deleted', { name: preset.name }))
  }

  const onNameKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      setNaming(null)
    }
  }

  // Which presets the project looks like now; only its style, cursor, zoom settings and tilt matter.
  const { style, cursor, zoomSettings, autoZoom, tilt } = project
  const matching = useMemo(() => {
    const look = { ...project, style, cursor, zoomSettings, autoZoom, tilt }
    return new Set([...BUILT_IN_PRESETS, ...(mine ?? [])].filter((p) => presetMatches(look, p.look)).map((p) => p.id))
  }, [style, cursor, zoomSettings, autoZoom, tilt, mine])

  const card = (preset: StylePreset, own: boolean): JSX.Element => {
    const active = matching.has(preset.id)
    const renaming = naming?.mode === 'rename' && naming.id === preset.id
    const label = presetLabel(preset, !own)
    return (
      <div key={preset.id} className={`preset-item ${active ? 'active' : ''}`} data-preset={preset.id}>
        <button className="preset-card" aria-label={t('style.stylePresets.preset', { name: label })} aria-pressed={active} title={t('style.stylePresets.applyTheLook', { name: label })} onClick={() => apply(preset)}>
          <img src={lookThumb(preset.look)} alt="" draggable={false} />
          {!renaming && <span className="preset-name">{label}</span>}
        </button>
        {own && !renaming && (
          <span className="preset-tools">
            <button className="preset-tool" title={t('style.stylePresets.rename')} aria-label={t('style.stylePresets.renameName', { name: String(preset.name) })} disabled={busy} onClick={() => startNaming({ mode: 'rename', id: preset.id }, preset.name)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />
              </svg>
            </button>
            <button
              className={`preset-tool ${confirmDelete === preset.id ? 'confirm' : ''}`}
              title={confirmDelete === preset.id ? t('style.stylePresets.clickAgainToDelete') : t('common.action.delete')}
              aria-label={confirmDelete === preset.id ? t('style.stylePresets.confirmDeleting', { name: String(preset.name) }) : t('common.action.deleteName', { name: String(preset.name) })}
              disabled={busy}
              onClick={() => remove(preset)}
            >
              {confirmDelete === preset.id ? <span>{t('style.stylePresets.deleteQuestion')}</span> : <Icon name="trash" size={12} />}
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
        aria-label={naming.mode === 'new' ? t('style.stylePresets.newPresetName') : t('style.stylePresets.presetName')}
        placeholder={t('style.stylePresets.presetName')}
        value={name}
        maxLength={PRESET_NAME_MAX}
        autoFocus
        onKeyDown={onNameKey}
        onChange={(e) => setName(e.target.value)}
      />
      <button className="btn primary small-btn" type="submit" disabled={busy || !name.trim()}>
        {naming.mode === 'new' ? t('common.action.save') : t('style.stylePresets.rename')}
      </button>
      <button className="btn ghost small-btn" type="button" onClick={() => setNaming(null)}>{t('common.action.cancel')}</button>
    </form>
  )

  const current = [...BUILT_IN_PRESETS, ...(mine ?? [])].find((p) => matching.has(p.id))

  return (
    <Section
      title={t('style.stylePresets.presets')}
      aside={
        open ? (
          <button className="link small" onClick={() => setOpen(false)}>{t('common.action.hide')}</button>
        ) : undefined
      }
    >
      {!open ? (
        <button className="preset-summary" onClick={() => setOpen(true)} title={t('style.stylePresets.showTheStylePresets')}>
          <span className="preset-summary-name">{current ? presetLabel(current, BUILT_IN_PRESETS.includes(current)) : t('style.stylePresets.customLook')}</span>
          <span className="preset-summary-action">{t('style.stylePresets.browsePresets')}</span>
        </button>
      ) : (
        <>
          <div className="preset-grid" data-testid="built-in-presets">
            {BUILT_IN_PRESETS.map((p) => card(p, false))}
          </div>
          {!!mine?.length && (
            <>
              <h4 className="style-subhead">{t('style.stylePresets.yourPresets')}</h4>
              <div className="preset-grid" data-testid="user-presets">
                {mine.map((p) => card(p, true))}
              </div>
            </>
          )}
          {form || (
            <button className="btn" disabled={!mine || busy} onClick={() => startNaming({ mode: 'new' }, '')}>
              <Icon name="plus" size={16} />{t('style.stylePresets.saveThisLookAs')}</button>
          )}
          <p className="hint">{t('style.stylePresets.aPresetSetsThe')}</p>
        </>
      )}
    </Section>
  )
}
