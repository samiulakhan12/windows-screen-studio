import { useEffect, useRef, useState } from 'react'
import type { ReaderState } from '../../../shared/api/privacy'
import type { PrivacyPrefs } from '../../../shared/types'
import { kindLabel, PRIVACY_COPY } from '../../../shared/privacy/copy'
import { readPrivacyPrefs } from '../../../shared/privacy/coverData'
import { FIND_KINDS, MAX_ADDED_REGIONS } from '../../../shared/privacy/findState'
import { DEFAULT_KINDS } from '../../../shared/privacy/kinds'
import { regionName } from '../../../shared/privacy/regions'
import { fmt } from '../../../shared/i18n/fmt'
import { formatLocale, t, type MessageKey } from '../../../shared/i18n/t'
import { onNamesChanged } from './followRun'
import { showCoverMarks } from './peek'
import { setReaderState, useReaderState } from './readerState'
import { RegionsDialog } from './RegionsDialog'
import './privacyPanel.css'

type Colour = NonNullable<PrivacyPrefs['colour']>
const COLOURS: readonly { value: Colour; label: MessageKey }[] = [
  { value: 'ring', label: PRIVACY_COPY.cover.colourRing },
  { value: 'dark', label: PRIVACY_COPY.cover.colourDark },
  { value: 'light', label: PRIVACY_COPY.cover.colourLight },
  { value: 'black', label: PRIVACY_COPY.cover.colourBlack },
  { value: 'white', label: PRIVACY_COPY.cover.colourWhite }
]

const lines = (text: string): string[] => text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

/**
 * Settings › Private info (docs/design/auto-blur.md §2.14): the text reader (what it is, its state
 * with Download, Cancel or Remove, or why it cannot run on this PC), what Find looks for in a new
 * video, the names to hide and the words never to hide in every video (kept in editor-prefs.json,
 * and given to main so logs and diagnostics leave them out), the phone regions added, the colour of
 * new covers and *Show where covers are*. The reader's state is the one the Find dialog shows
 * (finding 29). `reveal` (Settings opened at 'privacy') scrolls it into view and focuses its heading.
 */
export function PrivacySettings(props: { reveal: boolean }): JSX.Element | null {
  const reader = useReaderState()
  const ref = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const regionsButton = useRef<HTMLButtonElement>(null)
  const [prefs, setPrefs] = useState<PrivacyPrefs | null>(null)
  const [namesText, setNamesText] = useState('')
  const [neverText, setNeverText] = useState('')
  const [regionsOpen, setRegionsOpen] = useState(false)

  useEffect(() => {
    if (!props.reveal) return
    ref.current?.scrollIntoView({ block: 'nearest' })
    headingRef.current?.focus({ preventScroll: true })
  }, [props.reveal])

  const load = (): void => {
    void window.api.getPref('privacy').then(
      (raw) => {
        const p = readPrivacyPrefs(raw) ?? {}
        setPrefs(p)
        setNamesText((p.names ?? []).join('\n'))
        setNeverText((p.neverHide ?? []).join('\n'))
      },
      () => setPrefs({})
    )
  }
  useEffect(load, [])
  // A name added in every video by Cover this text everywhere shows here at once (finding 28).
  useEffect(() => onNamesChanged((where) => where === 'settings' && load()), [])

  /** Saves `patch` into the preference (sanitised as main reads it) and keeps it. */
  const save = (patch: Partial<PrivacyPrefs>): void => {
    const next = readPrivacyPrefs({ ...(prefs ?? {}), ...patch }) ?? {}
    setPrefs(next)
    void window.api.setPref('privacy', next).catch(() => undefined)
    if (patch.names) void window.api.setPrivateNames(next.names ?? []).catch(() => undefined)
  }

  const act = async (what: () => Promise<ReaderState | void>): Promise<void> => {
    try {
      const s = await what()
      if (s) setReaderState(s)
    } catch (err) {
      setReaderState({ status: 'failed', reason: err instanceof Error ? err.message : String(err) })
    }
  }

  const kinds = prefs?.kinds ?? [...DEFAULT_KINDS]
  const locale = formatLocale()
  const percent = reader?.status === 'downloading' ? Math.round((reader.done / Math.max(1, reader.total)) * 100) : null

  let state: JSX.Element | null = null
  if (reader) {
    switch (reader.status) {
      case 'ready':
        state = (
          <div className="privacy-line" data-testid="privacy-settings-reader">
            <p>{t(PRIVACY_COPY.settings.readerReady)}</p>
            <button type="button" className="btn small" onClick={() => void act(() => window.api.removeReader())} data-testid="privacy-settings-remove">
              {t(PRIVACY_COPY.settings.remove)}
            </button>
          </div>
        )
        break
      case 'downloading':
        state = (
          <div className="privacy-line" data-testid="privacy-settings-reader">
            <p role="status">{t(PRIVACY_COPY.find.readerProgress, { percent: fmt.count(percent ?? 0) })}</p>
            <button type="button" className="btn small" onClick={() => void act(() => window.api.cancelReaderDownload())} data-testid="privacy-settings-cancel">
              {t(PRIVACY_COPY.settings.cancel)}
            </button>
          </div>
        )
        break
      case 'unavailable':
        state = (
          <p className="privacy-line" role="alert" data-testid="privacy-settings-reader">
            {t(reader.reason === 'cpu' ? PRIVACY_COPY.settings.unavailableCpu : PRIVACY_COPY.settings.unavailableHelper)}
          </p>
        )
        break
      default: {
        const failed = reader.status === 'failed' ? reader.reason : null
        const line = failed !== null ? t(PRIVACY_COPY.find.readerFailed, { reason: failed }) : reader.status === 'damaged' ? t(PRIVACY_COPY.settings.readerDamaged) : t(PRIVACY_COPY.settings.readerNone)
        state = (
          <div className="privacy-line" data-testid="privacy-settings-reader">
            <p role={failed !== null || reader.status === 'damaged' ? 'alert' : undefined}>{line}</p>
            <button type="button" className="btn small" onClick={() => void act(() => window.api.downloadReader())} data-testid="privacy-settings-download">
              {t(failed !== null ? PRIVACY_COPY.find.readerRetry : PRIVACY_COPY.settings.download)}
            </button>
          </div>
        )
      }
    }
  }

  return (
    <section className="settings-section privacy-settings" aria-labelledby="settings-privacy-title" ref={ref} data-testid="privacy-settings">
      <h3 id="settings-privacy-title" ref={headingRef} tabIndex={-1}>
        {t(PRIVACY_COPY.settings.title)}
      </h3>
      <h4>{t(PRIVACY_COPY.settings.reader)}</h4>
      <p className="hint">{t(PRIVACY_COPY.settings.readerAbout)}</p>
      {state}
      {prefs && (
        <>
          <fieldset className="privacy-kinds">
            <legend>{t(PRIVACY_COPY.settings.kinds)}</legend>
            {FIND_KINDS.map((k) => (
              <label key={k} className="check">
                <input type="checkbox" checked={kinds.includes(k)} onChange={(e) => save({ kinds: e.target.checked ? FIND_KINDS.filter((x) => x === k || kinds.includes(x)) : kinds.filter((x) => x !== k) })} data-kind={k} />
                <span>{t(kindLabel(k as Exclude<typeof k, 'text'>))}</span>
              </label>
            ))}
          </fieldset>
          <label className="privacy-field">
            <span>{t(PRIVACY_COPY.settings.names)}</span>
            <textarea rows={3} value={namesText} onChange={(e) => setNamesText(e.target.value)} onBlur={() => save({ names: lines(namesText) })} aria-describedby="privacy-settings-names-hint" data-testid="privacy-settings-names" />
          </label>
          <p className="hint" id="privacy-settings-names-hint">
            {t(PRIVACY_COPY.find.namesHint)}
          </p>
          <label className="privacy-field">
            <span>{t(PRIVACY_COPY.settings.neverHide)}</span>
            <textarea rows={2} value={neverText} onChange={(e) => setNeverText(e.target.value)} onBlur={() => save({ neverHide: lines(neverText) })} data-testid="privacy-settings-never" />
          </label>
          <p className="privacy-line" data-testid="privacy-settings-regions">
            <span>{t(PRIVACY_COPY.settings.regions)}</span>{' '}
            <span>{fmt.list((prefs.regions ?? []).map((r) => regionName(r, locale)))}</span>{' '}
            <button ref={regionsButton} type="button" className="link" onClick={() => setRegionsOpen(true)} data-testid="privacy-settings-regions-change">
              {t(PRIVACY_COPY.find.regionsChange)}
            </button>
          </p>
          <label className="privacy-field">
            <span>{t(PRIVACY_COPY.settings.colour)}</span>
            <select value={prefs.colour ?? 'ring'} onChange={(e) => save({ colour: e.target.value as Colour })} data-testid="privacy-settings-colour">
              {COLOURS.map((c) => (
                <option key={c.value} value={c.value}>
                  {t(c.label)}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={prefs.showCovers !== false}
              onChange={(e) => {
                showCoverMarks(e.target.checked)
                const { showCovers: _old, ...rest } = prefs
                void _old
                const next = e.target.checked ? rest : { ...rest, showCovers: false as const }
                setPrefs(next)
                void window.api.setPref('privacy', next).catch(() => undefined)
              }}
              data-testid="privacy-settings-show-covers"
            />
            <span>{t(PRIVACY_COPY.section.showCovers)}</span>
          </label>
          <p className="hint">{t(PRIVACY_COPY.settings.withPolish)}</p>
        </>
      )}
      {regionsOpen && prefs && (
        <RegionsDialog
          regions={prefs.regions ?? []}
          onDone={(regions) => {
            save({ regions: regions.slice(0, MAX_ADDED_REGIONS) })
            setRegionsOpen(false)
          }}
          onCancel={() => setRegionsOpen(false)}
        />
      )}
    </section>
  )
}
