/**
 * Settings › Language (docs/design/output-and-languages.md §2.5): the language of Flown, the digits
 * for Bangla and Hindi, and the restart notice. Settings shows it only once a language other than
 * English ships (showLanguageSection), first in the list.
 *
 * - A choice is saved at once and applies when Flown restarts; the notice (role="status") says so,
 *   with Restart now. Restart now is refused while Home records or processes, or while main has
 *   anything that would be lost; the reason joins the notice, and the button stays to try again.
 * - From the editor, the project is saved as quitting saves it and opens again after the restart.
 * - Opened from the palette's Language…, it scrolls into view and the select takes the focus.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { UiLanguage, UiPrefs } from '../../../shared/api/ui'
import { DIGIT_NAMES, NATIVE_NUMBERING } from '../../../shared/i18n/locale'
import { t, uiLanguage } from '../../../shared/i18n/t'
import { currentUiInfo, editorProjectToReopen, updateUiPrefs } from '../i18n/boot'
import { choiceOf, nameInUi, nextStart, optionLabel, withEnglish } from '../i18n/languageNames'
import { recordingBusyReason } from '../updates/useUpdates'
import '../i18n/language.css'

/** A heading or label with its English after it outside English. */
function Labelled({ part }: { part: { text: string; english: string | null } }): JSX.Element {
  return part.english === null ? (
    <>{part.text}</>
  ) : (
    <>
      {part.text} · <span lang="en">{part.english}</span>
    </>
  )
}

export function LanguageSection(): JSX.Element {
  const info = currentUiInfo()
  const id = useId()
  const ref = useRef<HTMLElement>(null)
  const selectRef = useRef<HTMLSelectElement>(null)
  const [prefs, setPrefs] = useState<UiPrefs>(info.prefs)
  const [refused, setRefused] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)

  useEffect(() => {
    // Settings opened at 'language' (the palette's Language…).
    if (ref.current?.closest('[data-section]')?.getAttribute('data-section') !== 'language') return
    ref.current.scrollIntoView({ block: 'nearest' })
    selectRef.current?.focus({ preventScroll: true })
  }, [])

  const next = nextStart(prefs, info)
  const changed = next.language !== info.language || next.digits !== info.digits
  const digitsOf: UiLanguage | null = NATIVE_NUMBERING[next.language] ? next.language : null
  const shownDigits = digitsOf ? (prefs.digits ?? next.digits) : null

  const save = (patch: UiPrefs): void => {
    setPrefs((p) => ({ ...p, ...patch }))
    setRefused(null)
    void updateUiPrefs(patch).then(setPrefs, () => undefined)
  }

  const restart = async (): Promise<void> => {
    if (asking) return
    setAsking(true)
    try {
      const home = recordingBusyReason()
      const result = home ? { ok: false as const, reason: home } : await window.api.relaunch(editorProjectToReopen() ?? undefined)
      setRefused(result.ok ? null : result.reason)
    } catch {
      setRefused(null)
    } finally {
      setAsking(false)
    }
  }

  const ui = uiLanguage()
  const options: ('system' | UiLanguage)[] = ['system', 'en', ...info.shipped.filter((l) => l !== 'en')]
  return (
    <section className="settings-section language-section" aria-labelledby={`${id}-title`} ref={ref}>
      <h3 id={`${id}-title`}>
        <Labelled part={withEnglish('section.title')} />
      </h3>
      <div className="language-field">
        <label htmlFor={`${id}-select`} className="settings-label">
          <Labelled part={withEnglish('select.label')} />
        </label>
        <select
          id={`${id}-select`}
          ref={selectRef}
          className="settings-input"
          value={choiceOf(prefs, info)}
          onChange={(e) => save({ language: e.currentTarget.value as 'system' | UiLanguage })}
        >
          {options.map((o) => (
            <option key={o} value={o}>
              {o === 'system' ? t('language.option.system', { name: nameInUi(info.system) }) : optionLabel(o, info)}
            </option>
          ))}
        </select>
      </div>
      {digitsOf && shownDigits && (
        <fieldset className="language-digits">
          <legend className="settings-label">{t('language.digits.label')}</legend>
          <label>
            <input type="radio" name={`${id}-digits`} value="native" checked={shownDigits === 'native'} onChange={() => save({ digits: 'native' })} />
            <span lang={digitsOf === ui ? undefined : digitsOf}>
              {DIGIT_NAMES[digitsOf]?.own} {DIGIT_NAMES[digitsOf]?.digits}
            </span>
          </label>
          <label>
            <input type="radio" name={`${id}-digits`} value="western" checked={shownDigits === 'western'} onChange={() => save({ digits: 'western' })} />
            {t('language.digits.western')}
          </label>
        </fieldset>
      )}
      <div className="language-restart">
        <p role="status" className="language-status">
          {changed ? t('language.restart.notice', { name: nameInUi(next.language) }) : ''}
          {changed && refused ? ` ${refused}` : ''}
        </p>
        {changed && (
          <button type="button" className="btn primary settings-small" aria-busy={asking || undefined} onClick={() => void restart()}>
            {t('language.restart.button')}
          </button>
        )}
      </div>
      <p className="hint">{t('language.note.untranslated')}</p>
      {(info.preview.includes(next.language) || info.preview.includes(info.language)) && <p className="hint">{t('language.note.preview')}</p>}
      {next.language === 'bn' && <p className="hint">{t('language.note.screenReader')}</p>}
    </section>
  )
}
