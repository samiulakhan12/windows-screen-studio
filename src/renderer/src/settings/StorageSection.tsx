import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { StorageCleanupResult, StorageOverview } from '../../../shared/api/storage'
import { CACHE_DAY_CHOICES, freedBytes, REMOVE_DAY_CHOICES, sharedBytes, type CleanupItem, type SharedFile, type StorageRules } from '../../../shared/storage/rules'
import { fmt } from '../../../shared/i18n/fmt'
import { ipcMessage } from './providerText'
import { t, uiLanguage } from '../../../shared/i18n/t'
import { richText } from '../i18n/richText'

/** Recordings listed before "Show all". */
const SHOWN = 8

/** Dispatched on window when a clean-up moved recordings to the Recycle Bin: Home lists them again. */
export const PROJECTS_CHANGED_EVENT = 'ssw:projects-changed'

const keyOf = (i: Pick<CleanupItem, 'id' | 'action'>): string => `${i.action}:${i.id}`
/** " · 1.9 GB shared with a copy" for files a recording shares with another (Duplicate links its media). */
const sharedNote = (files: readonly SharedFile[] | undefined): string => (files?.length ? ` · ${t('settings.storage.shared', { size: fmt.bytes(sharedBytes(files), 'storage') })}` : '')
const dateOf = (iso: string): string => {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? fmt.date(d.getTime(), 'dayYear') : ''
}

/**
 * Settings › Storage (F-26, docs/design/hands-off.md §2.7): disk use per recording and in total,
 * the clean-up rules, and a review that lists what the rules would move to the Recycle Bin before
 * anything moves. Main checks every item again; nothing is ever deleted for good.
 */
export function StorageSection(): JSX.Element {
  const [overview, setOverview] = useState<StorageOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const [plan, setPlan] = useState<CleanupItem[] | null>(null)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<StorageCleanupResult | null>(null)
  const reviewRef = useRef<HTMLHeadingElement>(null)
  const reviewButtonRef = useRef<HTMLButtonElement>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  // After a render that removed or disabled the focused control: focus on `ref`, never the page.
  const focusLater = (ref: RefObject<HTMLElement>): void => void requestAnimationFrame(() => ref.current?.focus())

  const scan = useCallback(async (): Promise<void> => {
    try {
      setOverview(await window.api.storageScan())
      setError(null)
    } catch (err) {
      setError(ipcMessage(err))
    }
  }, [])
  useEffect(() => void scan(), [scan])

  const setRules = async (patch: Partial<StorageRules>): Promise<void> => {
    if (!overview) return
    const rules = await window.api.storageSetRules({ ...overview.rules, ...patch })
    setOverview({ ...overview, rules })
    setPlan(null)
  }

  const review = async (): Promise<void> => {
    setResult(null)
    setBusy(true)
    try {
      const items = await window.api.storagePlan()
      setPlan(items)
      setTicked(new Set(items.map(keyOf)))
      focusLater(reviewRef)
    } catch (err) {
      setError(ipcMessage(err))
      focusLater(reviewButtonRef)
    } finally {
      setBusy(false)
    }
  }

  const run = async (): Promise<void> => {
    if (!plan) return
    setBusy(true)
    try {
      const r = await window.api.storageClean(plan.filter((i) => ticked.has(keyOf(i))).map((i) => ({ id: i.id, action: i.action })))
      setResult(r)
      setPlan(null)
      if (r.moved.some((i) => i.action === 'remove')) window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT))
      await scan()
      // The review (and its focused button) is gone: the result takes the focus.
      focusLater(resultRef)
    } catch (err) {
      setError(ipcMessage(err))
      focusLater(reviewRef)
    } finally {
      setBusy(false)
    }
  }

  const rules = overview?.rules
  const list = overview ? (all ? overview.recordings : overview.recordings.slice(0, SHOWN)) : []
  const chosen = plan?.filter((i) => ticked.has(keyOf(i))) ?? []
  const chosenBytes = freedBytes(chosen)
  const groups = plan ? (['remove', 'caches'] as const).map((action) => ({ action, items: plan.filter((i) => i.action === action) })).filter((g) => g.items.length) : []

  return (
    <section className="settings-section health-section" aria-labelledby="settings-storage-title" data-testid="storage">
      <h3 id="settings-storage-title">{t('settings.storage.title')}</h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!overview && !error && <p className="settings-empty">{t('settings.storage.measuring')}</p>}
      {overview && (
        <>
          <div className="health-actions">
            <p className="storage-total" data-testid="storage-total">
              {uiLanguage() === 'en' ? (
                // English keeps today's text nodes (merge group, output-and-languages §9.3); other languages say the line whole.
                <>
                  {richText('settings.storage.line.total', { size: fmt.bytes(overview.bytes, 'storage') }, { b: (chunks) => <strong>{chunks}</strong> })}
                  {overview.free !== null ? t('settings.storage.line.free', { free: fmt.bytes(overview.free, 'storage') }) : ''}
                </>
              ) : (
                richText(
                  'settings.storage.line.whole',
                  { size: fmt.bytes(overview.bytes, 'storage'), hasFree: overview.free !== null ? 'yes' : 'no', free: overview.free !== null ? fmt.bytes(overview.free, 'storage') : '' },
                  { b: (chunks) => <strong>{chunks}</strong> }
                )
              )}
            </p>
            <button type="button" className="btn ghost settings-small" onClick={() => void scan()}>
              {t('common.action.refresh')}
            </button>
          </div>
          {overview.recordings.length === 0 ? (
            <p className="settings-empty">{t('settings.storage.empty')}</p>
          ) : (
            <ul className="storage-list" aria-label={t('settings.storage.listLabel')}>
              {list.map((r) => (
                <li key={r.id} className="storage-row" data-id={r.id}>
                  <span className="storage-name" title={r.name}>
                    {r.name}
                  </span>
                  <span className="storage-meta">
                    {r.finished ? t('settings.storage.used', { date: dateOf(r.createdAt), when: fmt.relative(r.lastUsed, overview.now) }) : t('settings.storage.unfinished')}
                    {r.cacheBytes > 0 ? ` · ${t('settings.storage.cache', { size: fmt.bytes(r.cacheBytes, 'storage') })}` : ''}
                    {r.versionBytes ? ` · ${t('settings.storage.versions', { size: fmt.bytes(r.versionBytes, 'storage') })}` : ''}
                    {sharedNote(r.shared)}
                  </span>
                  <span className="storage-size">
                    {r.capped ? richText('settings.storage.atLeast', { size: fmt.bytes(r.bytes, 'storage') }) : fmt.bytes(r.bytes, 'storage')}
                  </span>
                  <button type="button" className="btn ghost settings-small" aria-label={t('settings.storage.showLabel', { name: r.name })} onClick={() => void window.api.revealProject(r.id).catch(() => undefined)}>
                    {t('common.action.show')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {overview.recordings.length > SHOWN && (
            <button type="button" className="link storage-more" onClick={() => setAll(!all)}>
              {all ? t('settings.storage.showFewer') : t('settings.storage.showAll', { n: fmt.count(overview.recordings.length) })}
            </button>
          )}

          <h4>{t('settings.storage.rules')}</h4>
          <div className="storage-rule">
            <label htmlFor="storage-cache-days">{t('settings.storage.cacheDays')}</label>
            <select id="storage-cache-days" value={rules?.cacheDays ?? 'off'} onChange={(e) => void setRules({ cacheDays: e.target.value === 'off' ? null : Number(e.target.value) })}>
              {CACHE_DAY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {t('settings.storage.days', { count: d, n: fmt.count(d) })}
                </option>
              ))}
              <option value="off">{t('common.state.off')}</option>
            </select>
            <label className="storage-check">
              <input type="checkbox" checked={!!rules?.autoCaches} disabled={rules?.cacheDays === null} onChange={(e) => void setRules({ autoCaches: e.target.checked })} />
              {t('settings.storage.auto')}
            </label>
          </div>
          <div className="storage-rule">
            <label htmlFor="storage-remove-days">{t('settings.storage.removeDays')}</label>
            <select id="storage-remove-days" value={rules?.removeDays ?? 'off'} onChange={(e) => void setRules({ removeDays: e.target.value === 'off' ? null : Number(e.target.value) })}>
              <option value="off">{t('common.state.off')}</option>
              {REMOVE_DAY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {t('settings.storage.days', { count: d, n: fmt.count(d) })}
                </option>
              ))}
            </select>
          </div>
          <p className="hint">
            {t('settings.storage.hint')}
          </p>
          <div className="health-actions">
            <button type="button" ref={reviewButtonRef} className="btn settings-small" onClick={() => void review()} disabled={busy}>
              {t('settings.storage.review')}
            </button>
          </div>

          {plan && (
            <div className="storage-review" data-testid="storage-review">
              <h4 ref={reviewRef} tabIndex={-1}>
                {t('settings.storage.reviewTitle')}
              </h4>
              {plan.length === 0 ? (
                <p className="settings-empty">{t('settings.storage.nothing')}</p>
              ) : (
                groups.map((g) => (
                  <fieldset key={g.action} className="storage-group">
                    <legend>
                      {richText(g.action === 'remove' ? 'settings.storage.groupRemove' : 'settings.storage.groupCaches', { count: g.items.length, n: fmt.count(g.items.length), size: fmt.bytes(freedBytes(g.items), 'storage') })}
                    </legend>
                    {g.items.map((i) => (
                      <label key={keyOf(i)} className="storage-check storage-item">
                        <input
                          type="checkbox"
                          checked={ticked.has(keyOf(i))}
                          onChange={(e) => {
                            const next = new Set(ticked)
                            if (e.target.checked) next.add(keyOf(i))
                            else next.delete(keyOf(i))
                            setTicked(next)
                          }}
                        />
                        <span className="storage-name">{i.name}</span>
                        <span className="storage-meta">
                          {richText('settings.storage.used', { date: dateOf(i.createdAt), when: fmt.relative(i.lastUsed, overview.now) })}
                          {sharedNote(i.shared)}
                        </span>
                        <span className="storage-size">{fmt.bytes(i.bytes, 'storage')}</span>
                      </label>
                    ))}
                  </fieldset>
                ))
              )}
              <div className="health-actions">
                {plan.length > 0 && (
                  <button type="button" className="btn danger settings-small" onClick={() => void run()} disabled={busy || chosen.length === 0}>
                    {richText('settings.storage.move', { n: fmt.count(chosen.length), size: fmt.bytes(chosenBytes, 'storage') })}
                  </button>
                )}
                <button
                  type="button"
                  className="btn ghost settings-small"
                  onClick={() => {
                    setPlan(null)
                    focusLater(reviewButtonRef)
                  }}
                >
                  {plan.length ? t('common.action.cancel') : t('common.action.close')}
                </button>
              </div>
            </div>
          )}
          {result && (
            <div role="status" data-testid="storage-result" ref={resultRef} tabIndex={-1} className="storage-result">
              <p className="hint">
                {result.moved.length
                  ? t('settings.storage.moved', { count: result.moved.length, n: fmt.count(result.moved.length), size: fmt.bytes(result.freed, 'storage') })
                  : t('settings.storage.nothingMoved')}
              </p>
              {result.failed.map((f) => (
                <p key={keyOf(f.item)} className="hint storage-failed">
                  {richText(f.item.action === 'caches' ? 'settings.storage.failedCaches' : 'settings.storage.failed', { name: f.item.name, reason: f.reason })}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
