/**
 * The offer on Home (docs/design/output-and-languages.md §2.7): once, at the top of Home, while the
 * language setting is absent and main found a shipped language the user works in (Windows lists it,
 * a speech model made for it is installed, or a project in it was opened). Nothing is sent anywhere
 * to decide it. Its own-language parts are in `lang` spans, so screen readers switch voice.
 *
 * - Use Bangla saves the setting and restarts; while Home records or processes, or main has anything
 *   that would be lost, it says Flown opens in that language the next time it starts.
 * - Not now records the answer and the offer never returns; Settings › Language stays the way back.
 *
 * It also tells boot.ts that Home is on screen, so Restart now reopens no project from here.
 */
import { useEffect, useRef, useState } from 'react'
import type { UiLanguage } from '../../../shared/api/ui'
import { LANGUAGE_NAMES, OWN_WORDS } from '../../../shared/i18n/locale'
import { t } from '../../../shared/i18n/t'
import { currentUiInfo, noteHomeShown, updateUiPrefs } from '../i18n/boot'
import { recordingBusyReason } from '../updates/useUpdates'
import '../i18n/language.css'

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** The first control after `el` in the page, for the focus when the offer goes. */
function nextFocusable(el: HTMLElement | null): HTMLElement | null {
  for (let s = el?.nextElementSibling ?? null; s; s = s.nextElementSibling) {
    const found = s.matches(FOCUSABLE) ? (s as HTMLElement) : s.querySelector<HTMLElement>(FOCUSABLE)
    if (found) return found
  }
  return null
}

export function LanguageOffer(): JSX.Element | null {
  // As Home opened: answering the offer changes the preference, not what this notice says.
  const [info] = useState(currentUiInfo)
  const [state, setState] = useState<'offer' | 'later' | 'gone'>('offer')
  const ref = useRef<HTMLElement>(null)
  const statusRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    noteHomeShown(true)
    return () => noteHomeShown(false)
  }, [])
  useEffect(() => {
    if (state === 'later' && ref.current?.contains(document.activeElement)) statusRef.current?.focus()
  }, [state])

  const language: UiLanguage | null = info.offer
  if (!language || language === 'en' || info.prefs.language !== undefined || state === 'gone') return null
  const english = LANGUAGE_NAMES[language].english
  const own = OWN_WORDS[language]

  const notNow = (): void => {
    const focus = ref.current?.contains(document.activeElement) ? nextFocusable(ref.current) : null
    setState('gone')
    focus?.focus()
    void updateUiPrefs({ offered: [...(info.prefs.offered ?? []).filter((l) => l !== language), language] }).catch(() => undefined)
  }

  const use = async (): Promise<void> => {
    try {
      await updateUiPrefs({ language })
    } catch {
      return
    }
    const busy = recordingBusyReason()
    const result = busy ? { ok: false as const, reason: busy } : await window.api.relaunch().catch(() => ({ ok: false as const, reason: '' }))
    if (!result.ok) setState('later')
  }

  return (
    <section className="language-offer" role="region" aria-label={t('language.offer.region')} ref={ref}>
      <p className="language-offer-text" role="status" tabIndex={-1} ref={statusRef}>
        {state === 'later' ? (
          <>
            {t('language.offer.nextStart', { english })}
            {own && (
              <>
                {' — '}
                <span lang={language}>{own.nextStart}</span>
              </>
            )}
          </>
        ) : (
          <>
            {t('language.offer.available', { english })}
            {own && (
              <>
                {' — '}
                <span lang={language}>{own.available}</span>
              </>
            )}
          </>
        )}
      </p>
      {state === 'offer' && (
        <div className="language-offer-actions">
          <button type="button" className="btn primary" onClick={() => void use()}>
            {own && (
              <>
                <span lang={language}>{own.use}</span>
                {' · '}
              </>
            )}
            {t('language.offer.use', { english })}
          </button>
          <button type="button" className="btn ghost" onClick={notNow}>
            {own && (
              <>
                <span lang={language}>{own.notNow}</span>
                {' · '}
              </>
            )}
            {t('language.offer.notNow')}
          </button>
        </div>
      )}
    </section>
  )
}
