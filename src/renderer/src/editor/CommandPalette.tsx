import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { categoryLabel, COMMAND_CATEGORIES, commandTitle, pushRecent, sanitizeRecent, searchCommands, type CommandId, type CommandInfo } from '../../../shared/editor/commands'
import { ariaKeys } from '../../../shared/editor/shortcuts'
import { t } from '../../../shared/i18n/t'
import { T } from '../i18n/T'
import { useModalFocus } from './modalFocus'
import { ShortcutKeys } from './ShortcutKeys'
import './commands.css'

/** A command as the palette shows it right now. */
export interface PaletteEntry {
  info: CommandInfo
  shortcuts: readonly string[]
  /** Why the command cannot run now (it is shown dimmed), or null. */
  unavailable: string | null
  /** Current state of a toggle command. */
  on?: boolean
}

const RECENT_KEY = 'editor-recent-commands'
const PAGE = 8

function loadRecent(): CommandId[] {
  try {
    return sanitizeRecent(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'))
  } catch {
    return []
  }
}

function saveRecent(recent: CommandId[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
  } catch {
    // Ignore: the order of the list is a convenience.
  }
}

/** Title with the characters the search matched in bold. */
function Highlighted({ text, indices }: { text: string; indices: number[] }): JSX.Element {
  if (!indices.length) return <>{text}</>
  const marked = new Set(indices)
  const parts: { text: string; mark: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const mark = marked.has(i)
    const last = parts[parts.length - 1]
    if (last && last.mark === mark) last.text += text[i]
    else parts.push({ text: text[i], mark })
  }
  return (
    <>
      {parts.map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>))}
    </>
  )
}

export function SearchIcon({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" className="icon">
      <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" />
    </svg>
  )
}

interface Row {
  entry: PaletteEntry
  indices: number[]
  /** Position in the whole list (for keyboard navigation). */
  at: number
}

/**
 * Ctrl+K / Ctrl+Shift+P: every editor command, searchable by fuzzy matching, with its
 * shortcut. Arrow keys move, Enter runs, Esc closes; recently used commands come first.
 * A combobox (the search field) controlling a listbox, inside a modal dialog.
 */
export function CommandPalette({ entries, onRun, onClose }: { entries: PaletteEntry[]; onRun: (id: CommandId) => void; onClose: () => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [status, setStatus] = useState<string | null>(null)
  const [recent] = useState(loadRecent)
  const boxRef = useRef<HTMLDivElement>(null)
  const baseId = useId()
  useModalFocus(boxRef, onClose)

  const byId = useMemo(() => new Map(entries.map((e) => [e.info.id, e])), [entries])
  const groups = useMemo(() => {
    const ranked = searchCommands(
      entries.map((e) => e.info),
      query,
      recent
    )
    let at = 0
    const rows = (list: typeof ranked): Row[] => list.map((r) => ({ entry: byId.get(r.command.id)!, indices: r.indices, at: at++ }))
    if (query.trim()) return [{ label: null as string | null, rows: rows(ranked) }]
    const recentRows = rows(ranked.filter((r) => r.recent))
    const rest = ranked.filter((r) => !r.recent)
    return [
      ...(recentRows.length ? [{ label: t('commands.palette.recent') as string | null, rows: recentRows }] : []),
      ...COMMAND_CATEGORIES.map((c) => ({ label: categoryLabel(c) as string | null, rows: rows(rest.filter((r) => r.command.category === c)) })).filter((g) => g.rows.length)
    ]
  }, [entries, byId, query, recent])
  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups])
  const index = flat.length ? Math.min(active, flat.length - 1) : -1
  const optionId = (i: number): string => `${baseId}-opt-${i}`

  useLayoutEffect(() => {
    if (index >= 0) document.getElementById(`${baseId}-opt-${index}`)?.scrollIntoView({ block: 'nearest' })
  }, [index, baseId])

  const run = (row: Row | undefined): void => {
    if (!row) return
    const { info, unavailable } = row.entry
    if (unavailable) {
      setStatus(unavailable)
      return
    }
    saveRecent(pushRecent(recent, info.id))
    onRun(info.id)
  }

  const move = (delta: number, wrap: boolean): void => {
    if (!flat.length) return
    setStatus(null)
    let next = index + delta
    if (wrap) next = (next + flat.length) % flat.length
    else next = Math.max(0, Math.min(flat.length - 1, next))
    setActive(next)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        move(1, true)
        return
      case 'ArrowUp':
        e.preventDefault()
        move(-1, true)
        return
      case 'PageDown':
        e.preventDefault()
        move(PAGE, false)
        return
      case 'PageUp':
        e.preventDefault()
        move(-PAGE, false)
        return
      case 'Enter':
        e.preventDefault()
        if (!e.repeat) run(flat[index])
        return
      case 'Escape':
        e.preventDefault()
        onClose()
        return
    }
  }

  return (
    <div className="overlay palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label={t('commands.palette.label')} ref={boxRef}>
        <div className="palette-search">
          <SearchIcon />
          <input
            autoFocus
            type="text"
            role="combobox"
            aria-label={t('commands.palette.search')}
            aria-expanded="true"
            aria-controls={`${baseId}-list`}
            aria-autocomplete="list"
            aria-activedescendant={index >= 0 ? optionId(index) : undefined}
            placeholder={t('commands.palette.placeholder')}
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
              setStatus(null)
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="palette-list" id={`${baseId}-list`} role="listbox" aria-label={t('commands.palette.list')}>
          {groups.map((g, gi) => (
            <div key={g.label ?? gi} role="group" aria-labelledby={g.label ? `${baseId}-g${gi}` : undefined} aria-label={g.label ? undefined : t('commands.palette.results')}>
              {g.label && (
                <div className="palette-group" id={`${baseId}-g${gi}`} role="presentation">
                  {g.label}
                </div>
              )}
              {g.rows.map((row) => {
                const i = row.at
                const { info, shortcuts, unavailable, on } = row.entry
                return (
                  <div
                    key={info.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === index}
                    aria-disabled={unavailable ? true : undefined}
                    // The row shows its shortcut as keycaps but names it nowhere a screen reader reads (§14.2).
                    aria-keyshortcuts={ariaKeys(shortcuts)}
                    data-command={info.id}
                    className={`palette-item ${i === index ? 'active' : ''} ${unavailable ? 'unavailable' : ''}`}
                    title={unavailable ?? undefined}
                    onMouseMove={() => i !== index && setActive(i)}
                    // Keep focus in the search field.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => run(row)}
                  >
                    <span className="palette-title">
                      <Highlighted text={commandTitle(info).normalize('NFC')} indices={row.indices} />
                    </span>
                    {query.trim() !== '' && <span className="palette-category">{categoryLabel(info.category)}</span>}
                    {on !== undefined && <span className={`palette-state ${on ? 'on' : ''}`}>{on ? t('commands.palette.on') : t('common.state.off')}</span>}
                    {shortcuts[0] && <ShortcutKeys accelerator={shortcuts[0]} />}
                  </div>
                )
              })}
            </div>
          ))}
          {flat.length === 0 && (
            <div className="palette-empty">
              <T k="commands.palette.noMatch" values={{ query: query.trim() }} />
            </div>
          )}
        </div>
        <footer className="palette-foot">
          <span className="palette-help">
            <T k="commands.palette.help" tags={{ kbd: (keys) => <kbd>{keys}</kbd> }} />
          </span>
          <span className="palette-status" role="status" aria-live="polite">
            {status}
          </span>
        </footer>
      </div>
    </div>
  )
}
