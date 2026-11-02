/**
 * Settings › Captions › Downloads for captions (docs/design/captions-studio.md §2.12): one row per
 * downloaded caption font (or, once offline translation ships, translation model), with the bytes
 * it uses on this PC, its licence and Remove. Downloads start where they are needed (Captions ›
 * Look › Text's Font menu; Languages).
 */
import { useEffect, useState } from 'react'
import type { AssetState } from '../../../shared/api/assets'
import { catalogFont, type FontCoverage, type FontLicence } from '../../../shared/captions/fontCatalog'

const LICENCES: Readonly<Record<FontLicence, string>> = { 'OFL-1.1': 'SIL Open Font License', 'Apache-2.0': 'Apache License 2.0' }
const SCRIPT_NAMES: Partial<Record<FontCoverage, string>> = { japanese: 'Japanese', korean: 'Korean', 'han-sc': 'Chinese (Simplified)', 'han-tc': 'Chinese (Traditional)' }

/** "9.6 MB" (one decimal). */
const megabytes = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`
const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** "Noto Sans JP · Japanese caption font · 9.6 MB · SIL Open Font License". */
export function downloadRow(a: AssetState): { name: string; text: string } {
  const size = a.bytes !== undefined ? megabytes(a.bytes) : 'size unknown'
  if (a.kind === 'font') {
    const f = catalogFont(a.id)
    const script = f?.coverage.map((c) => SCRIPT_NAMES[c]).find(Boolean)
    const name = f?.family ?? a.id
    return { name, text: `${name} · ${script ? `${script} caption font` : 'caption font'} · ${size} · ${f ? LICENCES[f.licence] : 'SIL Open Font License'}` }
  }
  // Translation models come with offline translation (phase B), under the Mozilla Public License.
  return { name: a.id, text: `${a.id} · translation model · ${size} · Mozilla Public License 2.0` }
}

export function CaptionDownloadsSection(): JSX.Element {
  const [list, setList] = useState<AssetState[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const read = (): void =>
    void window.api.listAssets().then(
      (all) => {
        setList(all.filter((a) => a.state === 'ready'))
        setError(null)
      },
      (err: unknown) => {
        setList([])
        setError(`The downloads could not be listed: ${ipcMessage(err)}`)
      }
    )
  useEffect(read, [])
  const remove = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      await window.api.removeAsset(id)
      read()
    } catch (err) {
      setError(`It could not be removed: ${ipcMessage(err)}`)
    } finally {
      setBusy(null)
    }
  }
  return (
    <section className="settings-section caption-downloads" aria-labelledby="settings-caption-downloads-title" data-testid="caption-downloads">
      <h3 id="settings-caption-downloads-title">Downloads for captions</h3>
      {error && (
        <p className="callout" role="alert">
          {error}
        </p>
      )}
      {list === null ? (
        <p className="settings-empty">Loading…</p>
      ) : list.length === 0 ? (
        <p className="settings-empty">Nothing downloaded. Chinese, Japanese and Korean caption fonts download when you pick them in Captions › Look › Text.</p>
      ) : (
        <ul className="caption-download-list">
          {list.map((a) => {
            const row = downloadRow(a)
            return (
              <li key={a.id} className="caption-download-row">
                <span>{row.text}</span>
                <button type="button" className="btn settings-small" aria-label={`Remove ${row.name}`} disabled={busy === a.id} onClick={() => void remove(a.id)}>
                  Remove
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
