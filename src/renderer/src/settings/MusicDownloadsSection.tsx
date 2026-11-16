/**
 * Settings › Downloads: More music, "8 tracks, 7.1 MB", Download all and Remove
 * (docs/design/editing-polish.md §2.6, §10.3). Hidden while no download source exists (owner
 * decision 1: SOUND_LIBRARY_SOURCE is null, so main lists no bed to download).
 */
import { useEffect, useState } from 'react'
import type { SoundLibraryState } from '../../../shared/api/soundLibrary'
import { megabytes } from '../../../shared/audio/soundFxEdit'
import { t } from '../../../shared/i18n/t'
import { fmt } from '../../../shared/i18n/fmt'

const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function MusicDownloadsSection(): JSX.Element {
  const [list, setList] = useState<SoundLibraryState[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState('')
  const read = (): void =>
    void window.api.soundLibraryList().then(
      (all) => setList(all.filter((s) => s.state !== 'bundled')),
      (err: unknown) => {
        setList([])
        setError(t('settings.music.readFailed', { reason: ipcMessage(err) }))
      }
    )
  useEffect(() => {
    read()
    return window.api.onSoundLibraryProgress((s) => setList((l) => (l ? l.map((x) => (x.id === s.id ? s : x)) : l)))
  }, [])
  // Nothing to download (no source yet): the group is not shown.
  if (!list || list.length === 0) return <>{error && <p className="callout" role="alert">{error}</p>}</>
  const total = list.reduce((t, s) => t + s.bytes, 0)
  const missing = list.filter((s) => s.state === 'missing')
  const downloaded = list.filter((s) => s.state === 'downloaded')
  const downloadAll = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      for (const s of missing) await window.api.soundLibraryDownload(s.id)
      setLive(t('settings.music.allDownloaded'))
    } catch (err) {
      setError(ipcMessage(err))
    } finally {
      setBusy(false)
      read()
    }
  }
  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.soundLibraryRemove()
      setLive(t('settings.music.removed'))
    } catch (err) {
      setError(ipcMessage(err))
    } finally {
      setBusy(false)
      read()
    }
  }
  return (
    <section className="settings-section music-downloads" aria-labelledby="settings-music-downloads-title" data-testid="music-downloads">
      <h3 id="settings-music-downloads-title">{t('settings.music.title')}</h3>
      <p className="settings-empty">
        {downloaded.length > 0
          ? t('settings.music.summaryDownloaded', { count: list.length, n: fmt.count(list.length), size: megabytes(total).text, downloaded: fmt.count(downloaded.length) })
          : t('settings.music.summary', { count: list.length, n: fmt.count(list.length), size: megabytes(total).text })}
      </p>
      {error && (
        <p className="callout" role="alert">
          {error}
        </p>
      )}
      <div className="music-downloads-actions">
        <button type="button" className="btn settings-small" data-testid="music-download-all" disabled={busy || missing.length === 0} onClick={() => void downloadAll()}>
          {t('settings.music.downloadAll')}
        </button>
        <button type="button" className="btn settings-small" data-testid="music-downloads-remove" disabled={busy || downloaded.length === 0} onClick={() => void remove()}>
          {t('common.action.remove')}
        </button>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {live}
      </span>
    </section>
  )
}
