import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { MAX_ADDED_REGIONS } from '../../../shared/privacy/findState'
import { alwaysOnRegions, phoneRegionCodes, regionName } from '../../../shared/privacy/regions'
import { formatLocale, t } from '../../../shared/i18n/t'
import { useModalFocus } from '../editor/modalFocus'
import { uiRegion } from './privacyRun'
import './privacyPanel.css'

/**
 * *Phone numbers from* (docs/design/auto-blur.md §2.5): every region the phone metadata knows, by its
 * name in the UI language. The PC's region and the UI language's are always on (checked, disabled,
 * first); up to 5 more may be added, after which the others are disabled. Done gives the regions
 * added (the ones always on are added at each run). A modal dialog labelled by its title; Cancel
 * keeps the regions as they were.
 */
export function RegionsDialog(props: { regions: readonly string[]; onDone: (regions: string[]) => void; onCancel: () => void }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLInputElement>(null)
  const uid = `regions-${useId().replace(/:/g, '')}`
  const always = useMemo(() => {
    const { pc, language } = uiRegion()
    return alwaysOnRegions(pc, language)
  }, [])
  const [added, setAdded] = useState<string[]>(() => props.regions.filter((r) => !always.includes(r)).slice(0, MAX_ADDED_REGIONS))
  useModalFocus(box, props.onCancel)
  useEffect(() => {
    first.current?.focus()
  }, [])
  const locale = formatLocale()
  const others = useMemo(
    () =>
      phoneRegionCodes()
        .filter((r) => !always.includes(r))
        .map((code) => ({ code, name: regionName(code, locale) }))
        .sort((a, b) => a.name.localeCompare(b.name, locale)),
    [always, locale]
  )
  const full = added.length >= MAX_ADDED_REGIONS
  const toggle = (code: string, on: boolean): void => setAdded((was) => (on ? (was.includes(code) || was.length >= MAX_ADDED_REGIONS ? was : [...was, code]) : was.filter((r) => r !== code)))
  let firstSet = false
  const firstRef = (): RefObject<HTMLInputElement> | undefined => {
    if (firstSet) return undefined
    firstSet = true
    return first
  }
  return (
    <div className="overlay modal-backdrop">
      <div className="privacy-dialog privacy-regions" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} aria-describedby={`${uid}-hint`} ref={box} tabIndex={-1} data-testid="regions-dialog">
        <header className="modal-head">
          <h2 id={`${uid}-title`}>{t(PRIVACY_COPY.find.regionsTitle)}</h2>
        </header>
        <div className="modal-body">
          <p className="hint" id={`${uid}-hint`}>
            {t(PRIVACY_COPY.find.regionsHint)}
          </p>
          <ul className="privacy-region-list" aria-labelledby={`${uid}-title`}>
            {always.map((code) => (
              <li key={code}>
                <label className="check">
                  <input type="checkbox" checked disabled data-region={code} />
                  <span>{regionName(code, locale)}</span>
                </label>
              </li>
            ))}
            {others.map(({ code, name }) => {
              const on = added.includes(code)
              return (
                <li key={code}>
                  <label className="check">
                    <input ref={on || !full ? firstRef() : undefined} type="checkbox" checked={on} disabled={!on && full} onChange={(e) => toggle(code, e.target.checked)} data-region={code} />
                    <span>{name}</span>
                  </label>
                </li>
              )
            })}
          </ul>
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={props.onCancel} data-testid="regions-cancel">
            {t('common.action.cancel')}
          </button>
          <button type="button" className="btn primary" onClick={() => props.onDone([...added])} data-testid="regions-done">
            {t('common.action.done')}
          </button>
        </footer>
      </div>
    </div>
  )
}
