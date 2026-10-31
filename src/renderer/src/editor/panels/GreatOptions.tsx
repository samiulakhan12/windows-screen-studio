/**
 * The options of Make my captions great (docs/design/captions-studio.md §2.8): its options button
 * and a dialog popover (focus kept inside, Esc closes it and returns focus to the button). The
 * choices are saved in prefs captionsGreat; an 'Auto' choice shows what it resolves to for this
 * project. Mounted beside the button with props { project: Project } (§14.4).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { captionFrame } from '../../../../shared/captions/autoStyle'
import { resolveGreatOptions, type Auto, type GreatOptions } from '../../../../shared/captions/great'
import type { Project } from '../../../../shared/types'
import { EditorIcon } from '../EditorIcon'
import { currentGreatOptions, loadGreatOptions, onGreatOptions, saveGreatOptions } from '../greatRun'
import { useModalFocus } from '../modalFocus'
import { providerName, useTextProviders } from './LanguagesSection'

type Flag = 'style' | 'emphasis' | 'speakers' | 'quotes' | 'tidy'
type AutoKey = 'emoji' | 'keywords' | 'counters' | 'lists' | 'chapters'

/** The checkboxes, in the order of §2.8. */
const ROWS: (Flag | AutoKey)[] = ['style', 'emphasis', 'emoji', 'keywords', 'counters', 'lists', 'speakers', 'chapters', 'quotes', 'tidy']
const AUTO_KEYS: readonly AutoKey[] = ['emoji', 'keywords', 'counters', 'lists', 'chapters']
const isAuto = (k: Flag | AutoKey): k is AutoKey => (AUTO_KEYS as readonly string[]).includes(k)
const COPY: Record<Flag | AutoKey, { label: string; title?: string }> = {
  style: { label: "Style for this video's shape", title: 'Skipped when you picked a style yourself' },
  emphasis: { label: 'Emphasise key words' },
  emoji: { label: 'Emoji next to key words' },
  keywords: { label: 'Keyword pop-ups', title: 'A big card replaces the caption for a key word' },
  counters: { label: 'Counters for statistics', title: 'Percentages, money, “grew by”, “from 20 to 80”' },
  lists: { label: 'List cards' },
  speakers: { label: 'Lower thirds with speaker names', title: 'Only names you typed for the speakers' },
  chapters: { label: 'Chapter titles' },
  quotes: { label: 'Quote cards (needs AI)' },
  tidy: { label: 'Tidy the text', title: 'Capitals, punctuation, digits' }
}
/** Why an Auto choice is on or off for this video (§2.8, §11.6). */
const AUTO_WHY: Record<AutoKey, string> = {
  emoji: 'Auto: on in tall and square videos where you are on camera',
  keywords: 'Auto: on in tall and square videos where you are on camera',
  counters: 'Auto: on in tall and square videos',
  lists: 'Auto: on in tall and square videos',
  chapters: 'Auto: on in wide videos that have chapters'
}

export function GreatOptionsPopover({ project }: { project: Project }): JSX.Element {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => void loadGreatOptions(), [])
  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn small ghost"
        data-testid="captions-great-options"
        aria-label="Choose what Make my captions great does"
        title="Choose what Make my captions great does"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <EditorIcon name="gear" size={15} />
      </button>
      {open && (
        <OptionsDialog
          project={project}
          onClose={() => {
            setOpen(false)
            button.current?.focus()
          }}
        />
      )}
    </>
  )
}

function OptionsDialog({ project, onClose }: { project: Project; onClose: () => void }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  useModalFocus(box, onClose)
  const options = useSyncExternalStore(onGreatOptions, currentGreatOptions)
  const providers = useTextProviders() ?? []
  const resolved = resolveGreatOptions(options, project, captionFrame(project))
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  const set = (patch: Partial<GreatOptions>): void => void saveGreatOptions({ ...options, ...patch }).catch(() => undefined)
  // A provider that was removed reads as On this PC.
  const provider = providers.some((p) => p.id === options.provider) ? options.provider : null
  return (
    <div ref={box} role="dialog" aria-label="Make my captions great options" data-testid="great-options" className="captions-suggestion great-options">
      {ROWS.map((key, i) => {
        const copy = COPY[key]
        const quotesOff = key === 'quotes' && provider === null
        // An Auto choice shows what it does for this video; ticking it makes the choice yours.
        const auto = isAuto(key) && options[key] === 'auto'
        const checked = isAuto(key) ? resolved[key] : options[key] && !quotesOff
        const title = quotesOff ? 'Choose an AI provider under Better picks with AI' : auto ? AUTO_WHY[key as AutoKey] : copy.title
        return (
          <label key={key} className={`toggle ${quotesOff ? 'disabled' : ''}`} title={title}>
            <span>
              {copy.label}
              {auto && <span className="hint"> · Auto</span>}
            </span>
            <input
              ref={i === 0 ? first : undefined}
              type="checkbox"
              data-testid={`great-${key}`}
              aria-label={auto ? `${copy.label}, automatic` : copy.label}
              checked={checked}
              disabled={quotesOff}
              onChange={(e) => set({ [key]: e.target.checked } as Partial<GreatOptions>)}
            />
          </label>
        )
      })}
      {AUTO_KEYS.some((k) => options[k] !== 'auto') && (
        <button type="button" className="btn small ghost" onClick={() => set(Object.fromEntries(AUTO_KEYS.map((k) => [k, 'auto' as Auto])) as Partial<GreatOptions>)}>
          Let Flown choose emoji, pop-ups, counters, lists and chapter titles
        </button>
      )}
      <label className="field">
        <span>Sound on pop-ups</span>
        <select className="captions-select" data-testid="great-sound" value={options.sound} onChange={(e) => set({ sound: e.target.value as GreatOptions['sound'] })}>
          <option value="none">None</option>
          <option value="pop">Pop</option>
          <option value="ding">Ding</option>
        </select>
      </label>
      <label className="field">
        <span>Better picks with AI</span>
        <select className="captions-select" data-testid="great-provider" value={provider ?? ''} onChange={(e) => set({ provider: e.target.value || null })}>
          <option value="">No, on this PC only</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {providerName(p)}
            </option>
          ))}
        </select>
      </label>
      {provider && <p className="hint">The captions' words are sent to the provider with your key; only the picks come back.</p>}
      <div className="row start">
        <button type="button" className="btn small" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}
