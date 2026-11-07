/**
 * Audio tab, Music: the Library list (docs/design/editing-polish.md §2.6, §12). Mood chips filter
 * the beds (text, not colour); each row has its title, artist, mood and length, a Play toggle that
 * plays a preview from the library (outside the project) and Use, which copies the bed into the
 * project (main checks its hash again) and makes it the music in one undo step, keeping today's
 * volume, ducking, loop and fades. A bed that is not on this PC yet has one button, Download and
 * use; its Play is disabled until then ("Download to listen"). The eight download rows are listed
 * only while a download source exists (owner decision 1): main leaves them out otherwise.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SoundLibraryState } from '../../../../shared/api/soundLibrary'
import { bedLength, libraryBedOf, megabytes, withLibraryBed } from '../../../../shared/audio/soundFxEdit'
import { MOODS, MUSIC_BEDS, musicCredit, type Mood, type MusicBed } from '../../../../shared/audio/soundLibrary'
import { MEDIA_SCHEME } from '../../../../shared/mediaUrl'
import type { Project } from '../../../../shared/types'
import { useEditor, type EditorServices } from '../context'
import { createAudio } from '../media'
import './soundLibrary.css'

type Filter = 'all' | Mood
const FILTERS: readonly { id: Filter; label: string }[] = [{ id: 'all', label: 'All' }, ...MOODS]

/** A library file through the media protocol's sounds host (catalogue names only). */
export const librarySoundUrl = (file: string): string => `${MEDIA_SCHEME}://sounds/${encodeURIComponent(file)}`

/**
 * Space on a Play toggle plays or stops its preview (§12), where Space elsewhere in the editor plays
 * the video: the key stops here, and the button's own click on key up is cancelled.
 */
export function spaceToggles(e: ReactKeyboardEvent, toggle: () => void): void {
  if (e.key !== ' ' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
  e.preventDefault()
  e.stopPropagation()
  toggle()
}

const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Copies bed `id` into the project (downloading it first when it is not on this PC) and makes it the music: one undo step. */
async function useBedIn(project: Project, id: string, services: EditorServices, download: boolean): Promise<void> {
  if (download) await window.api.soundLibraryDownload(id)
  const { file } = await window.api.soundLibraryUseBed(project.id, id)
  services.store.update((p) => withLibraryBed(p, id, file))
  services.player.reloadMusic()
}

export function MusicLibrarySection(props: { project: Project }): JSX.Element {
  const { project } = props
  const services = useEditor()
  const [filter, setFilter] = useState<Filter>('all')
  const [states, setStates] = useState<ReadonlyMap<string, SoundLibraryState> | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [live, setLive] = useState('')
  const [error, setError] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const chips = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    let alive = true
    void window.api.soundLibraryList().then(
      (list) => alive && setStates(new Map(list.map((s) => [s.id, s]))),
      (err: unknown) => {
        if (!alive) return
        setStates(new Map())
        setError(`The music library could not be read: ${ipcMessage(err)}`)
      }
    )
    const off = window.api.onSoundLibraryProgress((s) => alive && setStates((m) => new Map(m ?? []).set(s.id, s)))
    return () => {
      alive = false
      off()
      audio.current?.pause()
      audio.current = null
    }
  }, [])

  const inUse = libraryBedOf(project)?.id ?? null
  const rows = useMemo(() => MUSIC_BEDS.filter((b) => states?.has(b.id) && (filter === 'all' || b.mood === filter)), [states, filter])

  const stop = (): void => {
    audio.current?.pause()
    audio.current = null
    setPlaying(null)
    setLive('Stopped')
  }
  const togglePlay = (bed: MusicBed, here: boolean): void => {
    if (!here) return
    if (playing === bed.id) return stop()
    audio.current?.pause()
    const a = createAudio(librarySoundUrl(bed.prepared.file))
    a.onended = () => {
      if (audio.current !== a) return
      audio.current = null
      setPlaying(null)
      setLive('Stopped')
    }
    audio.current = a
    void a.play().catch(() => undefined)
    setPlaying(bed.id)
    setLive(`Playing preview: ${bed.title}, ${bedLength(bed).spoken}`)
  }
  const use = async (bed: MusicBed, download: boolean): Promise<void> => {
    if (busy) return
    setBusy(bed.id)
    setError(null)
    try {
      await useBedIn(project, bed.id, services, download)
      if (download) setStates((m) => new Map(m ?? []).set(bed.id, { id: bed.id, state: 'downloaded', bytes: bed.prepared.bytes }))
      setLive(`Music: ${bed.title} by ${bed.artist}`)
    } catch (err) {
      setError(ipcMessage(err))
      // A failed download leaves the row as it was (its file deleted).
      void window.api.soundLibraryList().then(
        (list) => setStates(new Map(list.map((s) => [s.id, s]))),
        () => undefined
      )
    } finally {
      setBusy(null)
    }
  }
  const onListKey = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Escape' && playing) {
      e.preventDefault()
      e.stopPropagation()
      stop()
    }
  }
  const onMoodKey = (e: ReactKeyboardEvent, i: number): void => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? FILTERS.length - 1 : step ? (i + step + FILTERS.length) % FILTERS.length : -1
    if (to < 0) return
    e.preventDefault()
    setFilter(FILTERS[to].id)
    chips.current[to]?.focus()
  }

  return (
    <section className="insp-section music-library-section">
      <h3>
        <span>Music library</span>
      </h3>
      <p className="hint">Free music for any video (CC0). Every track loops smoothly under your voice.</p>
      <div className="chips music-moods" role="radiogroup" aria-label="Mood" data-testid="music-mood">
        {FILTERS.map((f, i) => (
          <button
            key={f.id}
            ref={(el) => void (chips.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={filter === f.id}
            tabIndex={filter === f.id ? 0 : -1}
            className={`chip ${filter === f.id ? 'active' : ''}`}
            onClick={() => setFilter(f.id)}
            onKeyDown={(e) => onMoodKey(e, i)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {error && (
        <p className="callout" role="alert">
          {error}
        </p>
      )}
      {states === null ? (
        <p className="hint">Loading…</p>
      ) : (
        <ul className="music-library" role="list" data-testid="music-library" onKeyDown={onListKey}>
          {rows.map((bed) => {
            const s = states.get(bed.id)!
            const here = s.state === 'bundled' || s.state === 'downloaded'
            const downloading = s.state === 'downloading' || (busy === bed.id && !here)
            const length = bedLength(bed)
            const mood = MOODS.find((m) => m.id === bed.mood)!.label
            const hintId = `music-hint-${bed.id}`
            const size = megabytes(bed.prepared.bytes)
            const current = inUse === bed.id
            const pct = Math.round((s.progress ?? 0) * 100)
            return (
              <li key={bed.id} className={`music-row ${current ? 'in-use' : ''}`} data-testid="music-row" data-bed={bed.id}>
                <span className="music-row-text">
                  <span className="music-row-title">{bed.title}</span>
                  <span className="music-row-meta">
                    {bed.artist} · <span className="music-mood">{mood}</span> · <span aria-hidden="true">{length.text}</span>
                    <span className="sr-only">{length.spoken}</span>
                  </span>
                </span>
                <span className="music-row-actions">
                  <button
                    type="button"
                    className="btn ghost small-btn"
                    data-testid="music-play"
                    aria-pressed={playing === bed.id}
                    aria-label={`Play preview of ${bed.title}`}
                    aria-disabled={!here || undefined}
                    aria-describedby={here ? undefined : hintId}
                    onClick={() => togglePlay(bed, here)}
                    onKeyDown={(e) => spaceToggles(e, () => togglePlay(bed, here))}
                  >
                    {playing === bed.id ? 'Stop' : 'Play'}
                  </button>
                  {here ? (
                    <button
                      type="button"
                      className="btn small-btn"
                      data-testid="music-use"
                      aria-label={current ? `${bed.title} is in use` : `Use ${bed.title}`}
                      aria-disabled={current || busy !== null || undefined}
                      onClick={() => void (current ? undefined : use(bed, false))}
                    >
                      {current ? 'In use' : 'Use'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn small-btn"
                      data-testid="music-download"
                      aria-label={`Download and use ${bed.title}, ${size.spoken}`}
                      aria-disabled={busy !== null || downloading || undefined}
                      onClick={() => void (downloading ? undefined : use(bed, true))}
                    >
                      Download and use ({size.text})
                    </button>
                  )}
                </span>
                {!here && (
                  <span id={hintId} className="hint music-row-hint">
                    Download to listen
                  </span>
                )}
                {downloading && (
                  <span
                    className="music-progress"
                    role="progressbar"
                    data-testid="music-progress"
                    aria-label={`Downloading ${bed.title}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                    aria-valuetext={`${pct} percent`}
                  >
                    <span style={{ width: `${pct}%` }} />
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {live}
      </span>
    </section>
  )
}

/** "Music: Sweet Sun by Loyalty Freak Music (CC0)" under the music row while a library bed is the music (§2.6, §10.10). */
export function MusicCredit(props: { project: Project }): JSX.Element | null {
  const credit = musicCredit(props.project)
  return credit ? (
    <p className="hint music-credit" data-testid="music-credit">
      {credit}
    </p>
  ) : null
}

/** A bed's copy is gone from the project (or a version points at a pruned pick): one button copies (or downloads) it again by id (§10.3). */
export function BedMissingNotice(props: { project: Project }): JSX.Element | null {
  const services = useEditor()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bed = libraryBedOf(props.project)
  if (!bed) return null
  const again = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const listed = (await window.api.soundLibraryList()).find((s) => s.id === bed.id)
      await useBedIn(props.project, bed.id, services, !!listed && listed.state === 'missing')
    } catch (err) {
      setError(ipcMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="callout music-missing-bed" role="alert">
      <span>The music file is missing. Copy it from the library again?</span>
      <button type="button" className="btn small-btn" disabled={busy} onClick={() => void again()}>
        Copy {bed.title} again
      </button>
      {error && <span>{error}</span>}
    </div>
  )
}
