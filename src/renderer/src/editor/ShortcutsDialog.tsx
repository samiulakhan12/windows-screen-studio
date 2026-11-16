import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { categoryLabel, COMMAND_CATEGORIES, commandTitle, listedCommands, type CommandId, type CommandInfo } from '../../../shared/editor/commands'
import { fmt } from '../../../shared/i18n/fmt'
import { t } from '../../../shared/i18n/t'
import { currentUiInfo, showLanguageSection } from '../i18n/boot'
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
  NUDGE_STEPS,
  partialLabel,
  removeBinding,
  resetCommand,
  shortcutLabel,
  standardKeyOf,
  takenDefaults,
  type Keymap
} from '../../../shared/editor/shortcuts'
import { Icon } from '../components/Icon'
import { T } from '../i18n/T'
import { useModalFocus } from './modalFocus'
import { ShortcutKeys } from './ShortcutKeys'
import './commands.css'

/**
 * What a row is doing: recording keys, asking about a key another command has (to add it, or
 * to reset to defaults other commands have now), or showing an error.
 */
type RowState =
  | { kind: 'capture'; partial: string }
  | { kind: 'conflict'; accelerator: string; owner: CommandId }
  | { kind: 'reset'; taken: { accelerator: string; owner: CommandId }[] }
  | { kind: 'error'; message: string }

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
  const { id } = info
  const title = commandTitle(info)
  const bindings = keymap[id]
  const rowRef = useRef<HTMLLIElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const capture = state?.kind === 'capture' ? state : null
  const full = bindings.length >= MAX_BINDINGS

  // Back on this row's add button when recording or a question ends, unless focus moved on.
  const busy = state?.kind === 'capture' || state?.kind === 'conflict' || state?.kind === 'reset'
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
    // Esc cancels, with Shift too (as everywhere in the editor).
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) return onState(null)
    const chord = chordFromEvent(e)
    if (chord) take(formatChord(chord))
    else onState({ kind: 'capture', partial: partialLabel(e) })
  }

  const modified = !isDefaultBinding(keymap, id)
  const defaults = DEFAULT_KEYMAP[id]
  // E-06: Ctrl+A/C/X/V work for their commands while no command has them in the keymap.
  const standard = standardKeyOf(id)
  const standardFree = !!standard && !bindings.includes(standard) && !commandForShortcut(keymap, standard)
  // E-09: a nudge also has its step command's keys, while items are selected (docs/design/versions.md §4.1).
  const nudgeStep = (NUDGE_STEPS as Partial<Record<CommandId, { step: CommandId }>>)[id]?.step
  const stepKeys = nudgeStep ? keymap[nudgeStep].filter((a) => !bindings.includes(a)) : []
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
                aria-label={t('keys.dialog.removeLabel', { keys: shortcutLabel(a), command: title })}
                title={t('keys.dialog.removeTitle')}
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
          {stepKeys.map((a) => (
            <span key={`step:${a}`} className="shortcut-chip standard" data-step={a} title={t('keys.dialog.stepKey', { command: commandTitle(nudgeStep!) })}>
              <ShortcutKeys accelerator={a} />
            </span>
          ))}
          {standardFree && (
            <span className="shortcut-chip standard" data-standard={standard} title={t('keys.dialog.standardKey')}>
              <ShortcutKeys accelerator={standard!} />
            </span>
          )}
          {capture ? (
            <button
              type="button"
              className="shortcut-capture"
              autoFocus
              aria-label={t('keys.dialog.captureLabel', { command: title })}
              title={t('keys.dialog.captureTitle')}
              onKeyDown={onCaptureKey}
              onKeyUp={(e) => {
                if (capture.partial && !(e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) onState({ kind: 'capture', partial: '' })
              }}
              onBlur={() => onState(null)}
              onClick={() => onState(null)}
            >
              {capture.partial || t('keys.dialog.pressKeys')}
            </button>
          ) : (
            <button
              type="button"
              ref={addRef}
              className="shortcut-add"
              disabled={full}
              aria-label={t('keys.dialog.addLabel', { command: title })}
              title={full ? t('keys.dialog.full', { n: fmt.count(MAX_BINDINGS) }) : t('keys.dialog.addTitle')}
              onClick={() => onState({ kind: 'capture', partial: '' })}
            >
              <Icon name="plus" size={13} />
              {bindings.length === 0 && <span>{t('common.action.add')}</span>}
            </button>
          )}
          <button
            type="button"
            className="shortcut-reset"
            disabled={!modified}
            aria-label={t('keys.dialog.resetLabel', { command: title })}
            title={modified ? (defaults.length ? t('keys.dialog.resetTo', { keys: fmt.list(defaults.map(shortcutLabel), 'or') }) : t('keys.dialog.resetToNone')) : t('keys.dialog.isDefault')}
            onClick={() => {
              // Defaults another command has now are only taken back when the user says so.
              const taken = takenDefaults(keymap, id)
              if (taken.length) return onState({ kind: 'reset', taken })
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
      {(state?.kind === 'conflict' || state?.kind === 'reset') && (
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
          {(state.kind === 'conflict' ? [{ accelerator: state.accelerator, owner: state.owner }] : state.taken).map((q) => (
            <span key={q.accelerator} className="shortcut-question">
              <ShortcutKeys accelerator={q.accelerator} />
              <span>
                <T k="keys.dialog.usedBy" values={{ command: commandTitle(q.owner) }} tags={{ b: (name) => <strong>{name}</strong> }} />
              </span>
            </span>
          ))}
          <button
            type="button"
            className="btn small primary"
            autoFocus
            onClick={() => {
              onChange(state.kind === 'conflict' ? addBinding(keymap, id, state.accelerator) : resetCommand(keymap, id, true))
              onState(null)
            }}
          >
            {state.kind === 'conflict' ? t('keys.dialog.useHere') : t('keys.dialog.takeBack', { count: state.taken.length })}
          </button>
          <button type="button" className="btn small ghost" onClick={() => onState(null)}>
            {t('common.action.cancel')}
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
    const words = query.normalize('NFC').trim().toLowerCase().split(/\s+/).filter(Boolean)
    const matches = (c: CommandInfo): boolean => {
      if (!words.length) return true
      // The title and category in the UI language and in English (the same in English), compared in NFC.
      const text = `${commandTitle(c)} ${c.title} ${categoryLabel(c.category)} ${c.category} ${c.keywords ?? ''} ${keymap[c.id].map((a) => `${a} ${shortcutLabel(a)}`).join(' ')}`.normalize('NFC').toLowerCase()
      return words.every((w) => text.includes(w))
    }
    // Language… is listed only while Settings has a Language section (output-and-languages §2.5).
    const listed = listedCommands(showLanguageSection(currentUiInfo()))
    return COMMAND_CATEGORIES.map((category) => ({ category, commands: listed.filter((c) => c.category === category && matches(c)) })).filter((g) => g.commands.length)
  }, [query, keymap])

  const modified = Object.keys(keymapOverrides(keymap)).length > 0
  const change = (next: Keymap): void => {
    if (next !== keymap) onChange(next)
  }

  return (
    <div className="overlay modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" ref={boxRef}>
        <header className="modal-head">
          <h2 id="shortcuts-title">{t('common.label.keyboardShortcuts')}</h2>
          <button type="button" className="btn ghost icon-btn" onClick={onClose} title={t('common.action.close')} aria-label={t('common.action.close')}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <input
          className="shortcuts-search"
          type="search"
          autoFocus
          aria-label={t('keys.dialog.search')}
          placeholder={t('keys.dialog.searchPlaceholder')}
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
            <section key={g.category} aria-label={categoryLabel(g.category)}>
              <h3>{categoryLabel(g.category)}</h3>
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
          {groups.length === 0 && (
            <p className="hint shortcuts-empty">
              <T k="keys.dialog.noMatch" values={{ query: query.trim() }} />
            </p>
          )}
        </div>
        <footer className="modal-foot shortcuts-foot">
          <p className="hint">{t('keys.dialog.pauseHint')}</p>
          <button type="button" className="btn ghost" disabled={!modified} onClick={() => change(DEFAULT_KEYMAP)} title={t('keys.dialog.resetAllTitle')}>
            {t('keys.dialog.resetAll')}
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            {t('common.action.done')}
          </button>
        </footer>
      </div>
    </div>
  )
}
