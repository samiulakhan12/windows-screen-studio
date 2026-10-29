import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { StorageCleanupResult, StorageOverview } from '../../../shared/api/storage'
import { CACHE_DAY_CHOICES, formatBytes, freedBytes, REMOVE_DAY_CHOICES, sharedBytes, usedAgo, type CleanupItem, type SharedFile, type StorageRules } from '../../../shared/storage/rules'
import { ipcMessage } from './providerText'

/** Recordings listed before "Show all". */
const SHOWN = 8

/** Dispatched on window when a clean-up moved recordings to the Recycle Bin: Home lists them again. */
export const PROJECTS_CHANGED_EVENT = 'ssw:projects-changed'

const keyOf = (i: Pick<CleanupItem, 'id' | 'action'>): string => `${i.action}:${i.id}`
/** " · 1.9 GB shared with a copy" for files a recording shares with another (Duplicate links its media). */
const sharedNote = (files: readonly SharedFile[] | undefined): string => (files?.length ? ` · ${formatBytes(sharedBytes(files))} shared with a copy` : '')
const dateOf = (iso: string): string => {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
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
      <h3 id="settings-storage-title">Storage</h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!overview && !error && <p className="settings-empty">Measuring…</p>}
      {overview && (
        <>
          <div className="health-actions">
            <p className="storage-total" data-testid="storage-total">
              Recordings use <strong>{formatBytes(overview.bytes)}</strong>
              {overview.free !== null ? ` · ${formatBytes(overview.free)} free on this drive` : ''}
            </p>
            <button type="button" className="btn ghost settings-small" onClick={() => void scan()}>
              Refresh
            </button>
          </div>
          {overview.recordings.length === 0 ? (
            <p className="settings-empty">No recordings yet.</p>
          ) : (
            <ul className="storage-list" aria-label="Recordings by size">
              {list.map((r) => (
                <li key={r.id} className="storage-row" data-id={r.id}>
                  <span className="storage-name" title={r.name}>
                    {r.name}
                  </span>
                  <span className="storage-meta">
                    {r.finished ? `${dateOf(r.createdAt)} · used ${usedAgo(r.lastUsed, overview.now)}` : 'Unfinished'}
                    {r.cacheBytes > 0 ? ` · incl. ${formatBytes(r.cacheBytes)} cache` : ''}
                    {sharedNote(r.shared)}
                  </span>
                  <span className="storage-size">
                    {r.capped ? 'at least ' : ''}
                    {formatBytes(r.bytes)}
                  </span>
                  <button type="button" className="btn ghost settings-small" aria-label={`Show ${r.name} in its folder`} onClick={() => void window.api.revealProject(r.id).catch(() => undefined)}>
                    Show
                  </button>
                </li>
              ))}
            </ul>
          )}
          {overview.recordings.length > SHOWN && (
            <button type="button" className="link storage-more" onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show all ${overview.recordings.length}`}
            </button>
          )}

          <h4>Clean-up rules</h4>
          <div className="storage-rule">
            <label htmlFor="storage-cache-days">Clear caches of recordings not used for</label>
            <select id="storage-cache-days" value={rules?.cacheDays ?? 'off'} onChange={(e) => void setRules({ cacheDays: e.target.value === 'off' ? null : Number(e.target.value) })}>
              {CACHE_DAY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
              <option value="off">Off</option>
            </select>
            <label className="storage-check">
              <input type="checkbox" checked={!!rules?.autoCaches} disabled={rules?.cacheDays === null} onChange={(e) => void setRules({ autoCaches: e.target.checked })} />
              Do this automatically
            </label>
          </div>
          <div className="storage-rule">
            <label htmlFor="storage-remove-days">Remove recordings not used for</label>
            <select id="storage-remove-days" value={rules?.removeDays ?? 'off'} onChange={(e) => void setRules({ removeDays: e.target.value === 'off' ? null : Number(e.target.value) })}>
              <option value="off">Off</option>
              {REMOVE_DAY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </div>
          <p className="hint">
            Caches are rebuilt when needed. Removed files go to the Recycle Bin, and recordings are only removed after you confirm them. Nothing outside the projects folder is
            touched.
          </p>
          <div className="health-actions">
            <button type="button" ref={reviewButtonRef} className="btn settings-small" onClick={() => void review()} disabled={busy}>
              Review clean-up…
            </button>
          </div>

          {plan && (
            <div className="storage-review" data-testid="storage-review">
              <h4 ref={reviewRef} tabIndex={-1}>
                Review clean-up
              </h4>
              {plan.length === 0 ? (
                <p className="settings-empty">Nothing to clean up with these rules.</p>
              ) : (
                groups.map((g) => (
                  <fieldset key={g.action} className="storage-group">
                    <legend>
                      {g.action === 'remove' ? 'Move to the Recycle Bin' : 'Clear caches'} ({g.items.length} recording{g.items.length === 1 ? '' : 's'},{' '}
                      {formatBytes(freedBytes(g.items))})
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
                          {dateOf(i.createdAt)} · used {usedAgo(i.lastUsed, overview.now)}
                          {sharedNote(i.shared)}
                        </span>
                        <span className="storage-size">{formatBytes(i.bytes)}</span>
                      </label>
                    ))}
                  </fieldset>
                ))
              )}
              <div className="health-actions">
                {plan.length > 0 && (
                  <button type="button" className="btn danger settings-small" onClick={() => void run()} disabled={busy || chosen.length === 0}>
                    Move {chosen.length} to the Recycle Bin ({formatBytes(chosenBytes)})
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
                  {plan.length ? 'Cancel' : 'Close'}
                </button>
              </div>
            </div>
          )}
          {result && (
            <div role="status" data-testid="storage-result" ref={resultRef} tabIndex={-1} className="storage-result">
              <p className="hint">
                {result.moved.length
                  ? `Moved ${result.moved.length} item${result.moved.length === 1 ? '' : 's'} to the Recycle Bin · freed ${formatBytes(result.freed)}`
                  : 'Nothing was moved.'}
              </p>
              {result.failed.map((f) => (
                <p key={keyOf(f.item)} className="hint storage-failed">
                  Could not move {f.item.action === 'caches' ? `the caches of ${f.item.name}` : f.item.name} to the Recycle Bin: {f.reason}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
