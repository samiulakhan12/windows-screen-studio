import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { COMMAND_CATEGORIES, COMMANDS, commandInfo, type CommandId, type CommandInfo } from '../../../shared/editor/commands'
import {
  addBinding,
  checkShortcut,
  chordFromEvent,
  commandForShortcut,
  DEFAULT_KEYMAP,
  formatChord,
  isDefaultBinding,
  keymapOverrides,
  MAX_BINDINGS,
  partialLabel,
  removeBinding,
  resetCommand,
  shortcutLabel,
  type Keymap
} from '../../../shared/editor/shortcuts'
import { Icon } from '../components/Icon'
import { useModalFocus } from './modalFocus'
import { ShortcutKeys } from './ShortcutKeys'
import './commands.css'

/** What a row is doing: recording keys, asking about a key another command has, or showing an error. */
type RowState = { kind: 'capture'; partial: string } | { kind: 'conflict'; accelerator: string; owner: CommandId } | { kind: 'error'; message: string }

function ResetIcon(): JSX.Element {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 12a8 8 0 1 0 2.3-5.7M4 5v5h5" />
    </svg>
  )
}

function ShortcutRow({
  info,
  keymap,
  state,
  onState,
  onChange
}: {
  info: CommandInfo
  keymap: Keymap
  state: RowState | null
  onState: (s: RowState | null) => void
  onChange: (next: Keymap) => void
}): JSX.Element {
  const { id, title } = info
  const bindings = keymap[id]
  const rowRef = useRef<HTMLLIElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const capture = state?.kind === 'capture' ? state : null
  const full = bindings.length >= MAX_BINDINGS

  // Back on this row's add button when recording or a question ends, unless focus moved on.
  const busy = state?.kind === 'capture' || state?.kind === 'conflict'
  const wasBusy = useRef(false)
  useEffect(() => {
    const active = document.activeElement
    const lost = !active || active === document.body || !!rowRef.current?.contains(active)
    if (wasBusy.current && !busy && lost) addRef.current?.focus({ preventScroll: true })
    wasBusy.current = busy
  }, [busy])

  const take = (accelerator: string): void => {
    const check = checkShortcut(accelerator, id)
    if (!check.ok) return onState({ kind: 'error', message: check.message })
    const owner = commandForShortcut(keymap, check.accelerator)
    if (owner === id) return onState(null)
    if (owner) return onState({ kind: 'conflict', accelerator: check.accelerator, owner })
    onChange(addBinding(keymap, id, check.accelerator))
    onState(null)
  }

  const onCaptureKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    // Tab still moves on (and ends the recording); every other key is the shortcut.
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) return
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat) return
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return onState(null)
    const chord = chordFromEvent(e)
    if (chord) take(formatChord(chord))
    else onState({ kind: 'capture', partial: partialLabel(e) })
  }

  const modified = !isDefaultBinding(keymap, id)
  const defaults = DEFAULT_KEYMAP[id]
  return (
    <li className={`shortcut-row ${capture ? 'capturing' : ''}`} data-command={id} ref={rowRef}>
      <div className="shortcut-line">
        <span className="shortcut-name">{title}</span>
        <div className="shortcut-bindings">
          {bindings.map((a) => (
            <span key={a} className="shortcut-chip">
              <ShortcutKeys accelerator={a} />
              <button
                type="button"
                className="shortcut-remove"
                aria-label={`Remove ${shortcutLabel(a)} from ${title}`}
                title="Remove this shortcut"
                onClick={() => {
                  onChange(removeBinding(keymap, id, a))
                  onState(null)
                  // The chip is gone: keep the keyboard in this row.
                  window.setTimeout(() => addRef.current?.focus({ preventScroll: true }), 0)
                }}
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
          {capture ? (
            <button
              type="button"
              className="shortcut-capture"
              autoFocus
              aria-label={`Press the new shortcut for ${title}`}
              title="Press the keys · Esc cancels"
              onKeyDown={onCaptureKey}
              onKeyUp={(e) => {
                if (capture.partial && !(e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) onState({ kind: 'capture', partial: '' })
              }}
              onBlur={() => onState(null)}
              onClick={() => onState(null)}
            >
              {capture.partial || 'Press keys…'}
            </button>
          ) : (
            <button
              type="button"
              ref={addRef}
              className="shortcut-add"
              disabled={full}
              aria-label={`Add shortcut for ${title}`}
              title={full ? `At most ${MAX_BINDINGS} shortcuts per command` : 'Add a shortcut'}
              onClick={() => onState({ kind: 'capture', partial: '' })}
            >
              <Icon name="plus" size={13} />
              {bindings.length === 0 && <span>Add</span>}
            </button>
          )}
          <button
            type="button"
            className="shortcut-reset"
            disabled={!modified}
            aria-label={`Reset ${title}`}
            title={modified ? `Reset to ${defaults.length ? defaults.map(shortcutLabel).join(' or ') : 'no shortcut'}` : 'Default'}
            onClick={() => {
              onChange(resetCommand(keymap, id))
              onState(null)
            }}
          >
            <ResetIcon />
          </button>
        </div>
      </div>
      {state?.kind === 'error' && (
        <p className="shortcut-message error" role="alert">
          {state.message}
        </p>
      )}
      {state?.kind === 'conflict' && (
        <div
          className="shortcut-message conflict"
          role="alert"
          onKeyDown={(e) => {
            // Esc answers the question (Cancel) rather than closing the dialog.
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            onState(null)
          }}
        >
          <span className="shortcut-question">
            <ShortcutKeys accelerator={state.accelerator} />
            <span>
              is used by <strong>{commandInfo(state.owner).title}</strong>.
            </span>
          </span>
          <button
            type="button"
            className="btn small primary"
            autoFocus
            onClick={() => {
              onChange(addBinding(keymap, id, state.accelerator))
              onState(null)
            }}
          >
            Use it here
          </button>
          <button type="button" className="btn small ghost" onClick={() => onState(null)}>
            Cancel
          </button>
        </div>
      )}
    </li>
  )
}

/**
 * Every editor command with its shortcuts: search, add a shortcut by pressing the keys
 * (another command's key asks first), remove one, reset one command or all of them. Changes
 * apply at once; `onChange` stores them.
 */
export function ShortcutsDialog({ keymap, onChange, onClose }: { keymap: Keymap; onChange: (next: Keymap) => void; onClose: () => void }): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [row, setRow] = useState<{ id: CommandId; state: RowState } | null>(null)
  useModalFocus(boxRef, onClose)

  const groups = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const matches = (c: CommandInfo): boolean => {
      if (!words.length) return true
      const text = `${c.title} ${c.category} ${c.keywords ?? ''} ${keymap[c.id].map((a) => `${a} ${shortcutLabel(a)}`).join(' ')}`.toLowerCase()
      return words.every((w) => text.includes(w))
    }
    return COMMAND_CATEGORIES.map((category) => ({ category, commands: COMMANDS.filter((c) => c.category === category && matches(c)) })).filter((g) => g.commands.length)
  }, [query, keymap])

  const modified = Object.keys(keymapOverrides(keymap)).length > 0
  const change = (next: Keymap): void => {
    if (next !== keymap) onChange(next)
  }

  return (
    <div className="overlay modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" ref={boxRef}>
        <header className="modal-head">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button type="button" className="btn ghost icon-btn" onClick={onClose} title="Close" aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </header>
        <input
          className="shortcuts-search"
          type="search"
          autoFocus
          aria-label="Search shortcuts"
          placeholder="Search commands or keys"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Esc first clears the search, then closes.
            if (e.key === 'Escape' && query) {
              e.preventDefault()
              setQuery('')
            }
          }}
        />
        <div className="shortcuts-list">
          {groups.map((g) => (
            <section key={g.category} aria-label={g.category}>
              <h3>{g.category}</h3>
              <ul>
                {g.commands.map((c) => (
                  <ShortcutRow
                    key={c.id}
                    info={c}
                    keymap={keymap}
                    state={row?.id === c.id ? row.state : null}
                    onState={(state) => setRow(state ? { id: c.id, state } : null)}
                    onChange={change}
                  />
                ))}
              </ul>
            </section>
          ))}
          {groups.length === 0 && <p className="hint shortcuts-empty">No commands match “{query.trim()}”.</p>}
        </div>
        <footer className="modal-foot shortcuts-foot">
          <p className="hint">Shortcuts pause while you type in a text field. Esc, Enter and Tab keep their usual jobs.</p>
          <button type="button" className="btn ghost" disabled={!modified} onClick={() => change(DEFAULT_KEYMAP)} title="Every command back to its default shortcuts">
            Reset all
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}
