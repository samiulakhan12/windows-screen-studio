/**
 * The options of Make my captions great (docs/design/captions-studio.md §2.8): its options button
 * and a dialog popover (focus kept inside, Esc closes it and returns focus to the button). The
 * choices are saved in prefs captionsGreat; an 'Auto' choice shows what it resolves to for this
 * project. Mounted beside the button with props { project: Project } (§14.4).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { captionFrame } from '../../../../shared/captions/autoStyle'
import { resolveGreatOptions, type Auto, type GreatOptions } from '../../../../shared/captions/great'
import { t, type MessageKey } from '../../../../shared/i18n/t'
import type { Project } from '../../../../shared/types'
import { EditorIcon } from '../EditorIcon'
import { currentGreatOptions, loadGreatOptions, marksCostRequest, onGreatOptions, saveGreatOptions } from '../greatRun'
import { useModalFocus } from '../modalFocus'
import { sentHint, useTextChoices } from '../../ai/textChoices'
import { CostLine } from '../../ai/CostLine'

type Flag = 'style' | 'emphasis' | 'speakers' | 'quotes' | 'tidy'
type AutoKey = 'emoji' | 'keywords' | 'counters' | 'lists' | 'chapters'

/** The checkboxes, in the order of §2.8. */
const ROWS: (Flag | AutoKey)[] = ['style', 'emphasis', 'emoji', 'keywords', 'counters', 'lists', 'speakers', 'chapters', 'quotes', 'tidy']
const AUTO_KEYS: readonly AutoKey[] = ['emoji', 'keywords', 'counters', 'lists', 'chapters']
const isAuto = (k: Flag | AutoKey): k is AutoKey => (AUTO_KEYS as readonly string[]).includes(k)
const COPY: Record<Flag | AutoKey, { label: MessageKey; title?: MessageKey }> = {
  style: { label: 'captions.great.style', title: 'captions.great.styleTitle' },
  emphasis: { label: 'captions.great.emphasis' },
  emoji: { label: 'captions.great.emoji' },
  keywords: { label: 'captions.great.keywords', title: 'captions.great.keywordsTitle' },
  counters: { label: 'captions.great.counters', title: 'captions.great.countersTitle' },
  lists: { label: 'captions.great.lists' },
  speakers: { label: 'captions.great.speakers', title: 'captions.great.speakersTitle' },
  chapters: { label: 'captions.great.chapters' },
  quotes: { label: 'captions.great.quotes' },
  tidy: { label: 'captions.great.tidy', title: 'captions.great.tidyTitle' }
}
/** Why an Auto choice is on or off for this video (§2.8, §11.6). */
const AUTO_WHY: Record<AutoKey, MessageKey> = {
  emoji: 'captions.great.autoOnCamera',
  keywords: 'captions.great.autoOnCamera',
  counters: 'captions.great.autoTall',
  lists: 'captions.great.autoTall',
  chapters: 'captions.great.autoChapters'
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
        aria-label={t('captions.great.optionsButton')}
        title={t('captions.great.optionsButton')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          // Read again: the Graphics tab saves the pop-up sound in the same prefs.
          if (!open) void loadGreatOptions(true)
          setOpen(!open)
        }}
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
  // The providers and services (smart-tools.md §20.0); never On this PC: its only AI task, emphasis marks, the small models do poorly (§2.5).
  const providers = useTextChoices('marks')
  const resolved = resolveGreatOptions(options, project, captionFrame(project))
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  const set = (patch: Partial<GreatOptions>): void => void saveGreatOptions({ ...options, ...patch }).catch(() => undefined)
  // A provider that was removed reads as On this PC.
  const provider = providers.some((p) => p.id === options.provider) ? options.provider : null
  const choice = providers.find((p) => p.id === provider) ?? null
  return (
    <div
      ref={box}
      role="dialog"
      aria-label={t('captions.great.optionsLabel')}
      data-testid="great-options"
      className="captions-suggestion great-options"
      onKeyDown={(e) => {
        // Esc closes here, before the editor's own keys see it: on a select they would blur it
        // (the focus left on the page, the dialog open), elsewhere clear the selection.
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
    >
      {ROWS.map((key, i) => {
        const copy = { label: t(COPY[key].label), title: COPY[key].title ? t(COPY[key].title) : undefined }
        const quotesOff = key === 'quotes' && provider === null
        // An Auto choice shows what it does for this video; ticking it makes the choice yours.
        const auto = isAuto(key) && options[key] === 'auto'
        const checked = isAuto(key) ? resolved[key] : options[key] && !quotesOff
        const title = quotesOff ? t('captions.great.quotesNeedAi') : auto ? t(AUTO_WHY[key as AutoKey]) : copy.title
        return (
          <label key={key} className={`toggle ${quotesOff ? 'disabled' : ''}`} title={title}>
            <span>
              {copy.label}
              {auto && <span className="hint"> · {t('captions.great.autoMark')}</span>}
            </span>
            <input
              ref={i === 0 ? first : undefined}
              type="checkbox"
              data-testid={`great-${key}`}
              aria-label={auto ? t('captions.great.automatic', { label: copy.label }) : copy.label}
              checked={checked}
              disabled={quotesOff}
              onChange={(e) => set({ [key]: e.target.checked } as Partial<GreatOptions>)}
            />
          </label>
        )
      })}
      {AUTO_KEYS.some((k) => options[k] !== 'auto') && (
        <button type="button" className="btn small ghost" onClick={() => set(Object.fromEntries(AUTO_KEYS.map((k) => [k, 'auto' as Auto])) as Partial<GreatOptions>)}>
          {t('captions.great.letFlown')}
        </button>
      )}
      <label className="field">
        <span>{t('captions.great.sound')}</span>
        <select className="captions-select" data-testid="great-sound" value={options.sound} onChange={(e) => set({ sound: e.target.value as GreatOptions['sound'] })}>
          <option value="none">{t('common.state.none')}</option>
          <option value="pop">{t('captions.great.soundPop')}</option>
          <option value="ding">{t('captions.great.soundDing')}</option>
        </select>
      </label>
      <label className="field">
        <span>{t('captions.great.provider')}</span>
        <select
          id="great-provider"
          className="captions-select"
          data-testid="great-provider"
          aria-describedby={choice ? 'great-cost-marks' : undefined}
          value={provider ?? ''}
          onChange={(e) => set({ provider: e.target.value || null })}
        >
          <option value="">{t('captions.great.providerNone')}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {choice && <p className="hint">{sentHint(choice, 'captionWords')}</p>}
      {/* What the AI picks send, where, and what they cost (smart-tools.md §11.5), part P5's. A run asks its question itself (captionsGreat.ts). */}
      {choice && <CostLine id="great-cost" choice={choice} full actions={[{ key: 'marks', label: t('captions.great.aiPicks'), buttonId: 'great-provider', request: () => marksCostRequest(project) }]} />}
      <div className="row start">
        <button type="button" className="btn small" onClick={onClose}>
          {t('common.action.done')}
        </button>
      </div>
    </div>
  )
}
