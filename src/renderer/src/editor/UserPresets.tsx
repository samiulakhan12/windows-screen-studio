/**
 * Your presets in the export dialog (docs/design/output-and-languages.md §2.2): the cards, their More
 * menus (Update with these settings, Rename…, Save to a file…, Delete), the Save as preset field, and
 * Import presets….
 *
 * A card is a radio (a checkbox in batch mode) with its More button beside it, never inside it. The
 * menu opens with Enter, Space or Shift+F10 and closes with Escape, giving the focus back to its
 * button. The inline field, the menu and the delete question keep Escape to themselves
 * (`data-own-escape`), so it never closes the export dialog behind them.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { PresetFileRead } from '../../../shared/api/export'
import { fmt } from '../../../shared/i18n/fmt'
import { t } from '../../../shared/i18n/t'
import type { BundleOptions } from '../../../shared/render/exportBundle'
import { matchesUserPreset, type ExportOptions } from '../../../shared/render/exportPresets'
import { codecAllowed } from '../../../shared/render/proFormats'
import { cleanPresetName, USER_PRESET_LIMIT, type UserExportPreset, type UserPresetStore } from '../../../shared/render/userPresets'
import { deletePreset, importPresets, renamePreset, uniqueName, updatePreset } from '../../../shared/render/userPresetsEdit'
import type { ExportCodec } from '../../../shared/types'
import { Icon } from '../components/Icon'
import './exportPro.css'

/** The reason of a failed main call, without Electron's "Error invoking remote method" prefix. */
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').split(/\n/)[0]

/** A plain badge for the user's own presets: a card with a bookmark. */
function UserPresetBadge(): JSX.Element {
  return (
    <svg className="preset-badge user-preset-badge" width={30} height={30} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="6" />
      <path d="M8.5 6.5h7v11l-3.5-2.6-3.5 2.6z" fill="none" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}

/** Whether the "Also save" choices of `preset` differ from `bundle` (absent choices count as off). */
function bundleDiffers(preset: UserExportPreset, bundle: Omit<BundleOptions, 'languages'>): boolean {
  if (!preset.bundle) return false
  const keys = new Set([...Object.keys(preset.bundle), ...Object.keys(bundle)].filter((k) => k !== 'languages'))
  const a = preset.bundle as unknown as Record<string, unknown>
  const b = bundle as unknown as Record<string, unknown>
  return [...keys].some((k) => JSON.stringify(a[k] ?? false) !== JSON.stringify(b[k] ?? false))
}

/**
 * The inline name field of Save as preset and Rename…: a labelled text field prefilled with a free
 * name, Save and Cancel. Enter saves, Escape cancels. A name that is empty once cleaned cannot be saved.
 */
export function SavePresetField(props: { suggestion: string; taken: readonly string[]; onSave: (name: string) => void; onCancel: () => void }): JSX.Element {
  const [name, setName] = useState(() => uniqueName(props.taken, cleanPresetName(props.suggestion) ?? ''))
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])
  const clean = cleanPresetName(name)
  const save = (): void => {
    if (clean) props.onSave(clean)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      props.onCancel()
    } else if (e.key === 'Enter' && e.target === field.current) {
      e.preventDefault()
      e.stopPropagation()
      save()
    }
  }
  return (
    <div className="preset-name-field" data-own-escape onKeyDown={onKey} data-testid="preset-name-field">
      <label className="preset-name-label">
        <span>{t('presets.save.field')}</span>
        <input ref={field} type="text" value={name} placeholder={t('presets.save.field')} spellCheck={false} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="preset-name-buttons">
        <button type="button" className="btn small primary" disabled={!clean} onClick={save}>
          {t('presets.save.save')}
        </button>
        <button type="button" className="btn small" onClick={props.onCancel}>
          {t('presets.save.cancel')}
        </button>
      </div>
    </div>
  )
}

type MenuItem = { key: 'update' | 'rename' | 'save' | 'delete'; label: string; act: () => void }

/** A card's More menu: the ARIA menu pattern, as the title bar's copy menu has it. */
function PresetMenu(props: { id: string; label: string; items: MenuItem[]; onClose: (refocus: boolean) => void }): JSX.Element {
  const [active, setActive] = useState(0)
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    refs.current[active]?.focus()
  }, [active])
  // A press anywhere else closes the menu (the focus goes where the press puts it).
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node | null
      if (target && menu.current?.parentElement?.contains(target)) return
      props.onClose(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [props.onClose])
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const last = props.items.length - 1
    let next: number | null = null
    if (e.key === 'ArrowDown') next = active >= last ? 0 : active + 1
    else if (e.key === 'ArrowUp') next = active <= 0 ? last : active - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    else if (e.key === 'Escape' || e.key === 'Tab') props.onClose(true)
    else if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    e.stopPropagation()
    if (next !== null) setActive(next)
  }
  return (
    <div ref={menu} id={props.id} className="preset-menu" role="menu" aria-label={props.label} data-own-escape onKeyDown={onKey}>
      {props.items.map((item, i) => (
        <button
          key={item.key}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="menuitem"
          className="preset-menu-item"
          data-menu={item.key}
          tabIndex={i === active ? 0 : -1}
          onMouseEnter={() => setActive(i)}
          onClick={item.act}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/** The question before a preset is deleted: Delete and Cancel, Cancel focused; Escape cancels. */
function DeleteQuestion(props: { name: string; onDelete: () => void; onCancel: () => void }): JSX.Element {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => cancel.current?.focus(), [])
  const id = useRef(`preset-delete-${Math.random().toString(36).slice(2)}`).current
  return (
    <div
      className="preset-delete"
      role="alertdialog"
      aria-describedby={id}
      aria-label={t('presets.menu.delete')}
      data-own-escape
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        props.onCancel()
      }}
    >
      <p id={id}>{t('presets.delete.ask', { name: props.name })}</p>
      <div className="preset-name-buttons">
        <button type="button" className="btn small danger" data-testid="preset-delete-confirm" onClick={props.onDelete}>
          {t('presets.delete.confirm')}
        </button>
        <button ref={cancel} type="button" className="btn small" onClick={props.onCancel}>
          {t('presets.delete.cancel')}
        </button>
      </div>
    </div>
  )
}

/** One saved preset: its card, its More button and menu, and, in place of the card, the rename field or the delete question. */
function PresetCard(props: {
  preset: UserExportPreset
  store: UserPresetStore
  on: boolean
  batch: boolean
  meta: string
  differs: boolean
  onSelect: () => void
  onStore: (s: UserPresetStore) => void
  onUpdate: () => void
  onProblem: (text: string | null) => void
  /** The preset was deleted: the list moves the focus on, as the card and its button are gone. */
  onDeleted: () => void
}): JSX.Element {
  const { preset } = props
  const [mode, setMode] = useState<'card' | 'menu' | 'rename' | 'delete'>('card')
  const more = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLButtonElement>(null)
  const menuId = `preset-menu-${preset.id.slice(5)}`
  const back = (to: 'more' | 'card'): void => {
    setMode('card')
    // After the field or question is gone, the focus goes back to the card or its button.
    requestAnimationFrame(() => (to === 'more' ? more.current : card.current)?.focus())
  }
  const openMenu = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (!((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu')) return
    e.preventDefault()
    e.stopPropagation()
    setMode('menu')
  }
  if (mode === 'rename') {
    return (
      <div className="user-preset editing">
        <SavePresetField
          suggestion={preset.name}
          taken={props.store.presets.filter((p) => p.id !== preset.id).map((p) => p.name)}
          onSave={(name) => {
            props.onStore(renamePreset(props.store, preset.id, name))
            back('more')
          }}
          onCancel={() => back('more')}
        />
      </div>
    )
  }
  if (mode === 'delete') {
    return (
      <div className="user-preset editing">
        <DeleteQuestion
          name={preset.name}
          onDelete={() => {
            props.onStore(deletePreset(props.store, preset.id))
            props.onDeleted()
          }}
          onCancel={() => back('more')}
        />
      </div>
    )
  }
  const items: MenuItem[] = [
    ...(props.differs
      ? [
          {
            key: 'update' as const,
            label: t('presets.menu.update'),
            act: () => {
              back('more')
              props.onUpdate()
            }
          }
        ]
      : []),
    { key: 'rename', label: t('presets.menu.rename'), act: () => setMode('rename') },
    {
      key: 'save',
      label: t('presets.menu.save'),
      act: () => {
        back('more')
        props.onProblem(null)
        window.api.savePresetFile(preset.name, [preset]).catch((err: unknown) => props.onProblem(reasonOf(err)))
      }
    },
    { key: 'delete', label: t('presets.menu.delete'), act: () => setMode('delete') }
  ]
  return (
    <div className="user-preset">
      <button
        ref={card}
        type="button"
        className={`preset-card ${props.on ? 'active' : ''}`}
        role={props.batch ? 'checkbox' : 'radio'}
        aria-checked={props.on}
        data-preset={preset.id}
        onClick={props.onSelect}
        onKeyDown={openMenu}
      >
        <UserPresetBadge />
        <span className="preset-text">
          <span className="preset-label">{preset.name}</span>
          <span className="preset-meta">{props.meta}</span>
        </span>
        {props.batch && <span className={`preset-check ${props.on ? 'on' : ''}`}>{props.on && <Icon name="check" size={12} />}</span>}
      </button>
      <button
        ref={more}
        type="button"
        className="preset-more"
        aria-label={t('presets.more.name', { name: preset.name })}
        title={t('presets.more.name', { name: preset.name })}
        aria-haspopup="menu"
        aria-expanded={mode === 'menu'}
        aria-controls={mode === 'menu' ? menuId : undefined}
        data-testid="preset-more"
        onClick={() => setMode(mode === 'menu' ? 'card' : 'menu')}
        onKeyDown={openMenu}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {mode === 'menu' && <PresetMenu id={menuId} label={t('presets.more.name', { name: preset.name })} items={items} onClose={(refocus) => (refocus ? back('more') : setMode('card'))} />}
    </div>
  )
}

/**
 * Your presets: a heading and one card per saved preset, in the order they were saved (nothing when
 * there are none). Picking a card applies it (`onPick`); in batch mode the cards are checkboxes
 * (`batch`). `metaOf` gives each card's meta line as the destinations have it, and `usable` says which
 * codecs this PC makes, so Update with these settings shows only when the settings really differ.
 */
export function UserPresets(props: {
  store: UserPresetStore
  selected: string | null
  options: ExportOptions
  bundle: Omit<BundleOptions, 'languages'>
  onPick: (p: UserExportPreset) => void
  onStore: (s: UserPresetStore) => void
  batch?: { checked: readonly string[]; onToggle: (id: string) => void }
  metaOf?: (o: ExportOptions) => string
  usable?: (codec: ExportCodec) => boolean
}): JSX.Element {
  const [problem, setProblem] = useState<string | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  // After a delete, the focus goes to the More button of the preset now in its place (or the one
  // before it), and to Import presets… when none is left, never to the page.
  const deletedAt = useRef<number | null>(null)
  const { store, batch } = props
  useEffect(() => {
    const at = deletedAt.current
    if (at === null) return
    deletedAt.current = null
    const mores = grid.current?.querySelectorAll<HTMLButtonElement>('.preset-more') ?? []
    const target = mores.length ? mores[Math.min(at, mores.length - 1)] : document.querySelector<HTMLElement>('[data-testid="preset-import"]')
    target?.focus()
  }, [store])
  if (!store.presets.length) return <></>
  const usable = props.usable ?? codecAllowed
  return (
    <>
      <div className="export-section-head">
        <span id="user-presets-heading">{t('presets.yours.heading')}</span>
      </div>
      <div ref={grid} className="preset-grid user-presets" role={batch ? 'group' : 'radiogroup'} aria-labelledby="user-presets-heading" data-testid="user-presets">
        {store.presets.map((p, i) => {
          const on = batch ? batch.checked.includes(p.id) : props.selected === p.id
          const differs = !matchesUserPreset(props.options, p, usable) || bundleDiffers(p, props.bundle)
          return (
            <PresetCard
              key={p.id}
              preset={p}
              store={store}
              on={on}
              batch={!!batch}
              meta={props.metaOf?.(p.options) ?? ''}
              differs={differs}
              onSelect={() => (batch ? batch.onToggle(p.id) : props.onPick(p))}
              onStore={props.onStore}
              onUpdate={() => {
                const next = updatePreset(store, p.id, props.options, props.bundle)
                props.onStore(next)
                const updated = next.presets.find((q) => q.id === p.id)
                if (updated && !batch) props.onPick(updated)
              }}
              onProblem={setProblem}
              onDeleted={() => {
                deletedAt.current = i
              }}
            />
          )
        })}
      </div>
      {problem && (
        <p className="hint warn" role="status">
          {problem}
        </p>
      )}
    </>
  )
}

/** The notices after an import, each a whole sentence in the UI language (§2.2). */
export function importNotices(read: PresetFileRead | { refused: 'too-large' | 'unreadable' }, added: number, skipped: number): { text: string; warn: boolean }[] {
  if ('refused' in read) return [{ text: t(read.refused === 'too-large' ? 'presets.import.tooLarge' : 'presets.import.none'), warn: true }]
  if (!read.presets.length) return [{ text: t('presets.import.none'), warn: true }]
  const out: { text: string; warn: boolean }[] = []
  if (added > 0) out.push({ text: t('presets.import.done', { count: added, n: fmt.count(added) }), warn: false })
  const left = read.skipped + skipped
  if (left > 0) out.push({ text: t('presets.import.overLimit', { count: left, limit: fmt.count(USER_PRESET_LIMIT), n: fmt.count(left) }), warn: true })
  const prores = read.changed.filter((c) => c.to === 'cineform').reduce((n, c) => n + c.count, 0)
  if (prores > 0) out.push({ text: t('presets.import.changed', { count: prores, n: fmt.count(prores) }), warn: false })
  return out
}

/** Import presets…: a link that opens a .flownpreset file through main, adds what it can read, and says what happened. */
export function ImportPresets(props: { store: UserPresetStore; onStore: (s: UserPresetStore) => void }): JSX.Element {
  const [notices, setNotices] = useState<{ text: string; warn: boolean }[]>([])
  const [busy, setBusy] = useState(false)
  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const read = await window.api.openPresetFile()
      if (!read) return
      if ('refused' in read) {
        setNotices(importNotices(read, 0, 0))
        return
      }
      const result = importPresets(props.store, read.presets, Date.now(), Math.random)
      if (result.added > 0) props.onStore(result.store)
      setNotices(importNotices(read, result.added, result.skipped))
    } catch (err) {
      setNotices([{ text: reasonOf(err), warn: true }])
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="preset-import">
      <button type="button" className="link" data-testid="preset-import" disabled={busy} onClick={() => void run()}>
        {t('presets.import.link')}
      </button>
      <div role="status" className="preset-import-notices">
        {notices.map((n) => (
          <p key={n.text} className={`hint ${n.warn ? 'warn' : ''}`}>
            {n.text}
          </p>
        ))}
      </div>
    </div>
  )
}
