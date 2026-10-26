import { useCallback, useEffect, useRef, useState } from 'react'
import type { NotesState } from '../../../shared/api/notes'
import type { NotesSettingsPatch } from '../../../shared/notes/notes'
import { ipcMessage } from '../settings/providerText'

/** How long typing has to stop before the text is saved (docs/design/teleprompter.md, "Persistence"). */
export const NOTES_SAVE_MS = 500

export type SaveStatus = { kind: 'idle' } | { kind: 'saved' } | { kind: 'error'; message: string }

export interface NotesController {
  /** Null until the main process answered (Home shows nothing for the notes until then). */
  state: NotesState | null
  /** The text as typed: edits not saved yet come first. */
  text: string
  saveStatus: SaveStatus
  /** Shows `text` at once and saves it NOTES_SAVE_MS after typing stops. */
  setText(text: string): void
  /** Saves a pending text now (on blur, and when the dialog closes). */
  flushText(): Promise<void>
  /** Saves a change; resolves to the message to show when it could not be saved, else null. */
  update(patch: NotesSettingsPatch): Promise<string | null>
  /** Opens or closes the rehearsal window; resolves to an error message, else null. */
  rehearse(open: boolean): Promise<string | null>
}

/** The last state seen, so returning to Home shows the notes at once. */
let cached: NotesState | null = null

/**
 * The speaker notes as Home sees them: the state from the main process (and its changes, e.g.
 * speed or size changed from the notes window), the text being typed, and saving.
 */
export function useNotes(): NotesController {
  const [state, setState] = useState<NotesState | null>(cached)
  const [local, setLocal] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<string | null>(null)
  /** Counts edits: a save answer only replaces the typed text when nothing was typed since. */
  const edits = useRef(0)
  const live = useRef(true)

  const accept = useCallback((s: NotesState) => {
    if (!s || typeof s !== 'object' || !s.settings) return
    cached = s
    if (live.current) setState(s)
  }, [])

  useEffect(() => {
    live.current = true
    const off = window.api.onNotesState(accept)
    window.api.getNotes().then(accept, (err: unknown) => console.warn('Could not read the speaker notes:', err))
    return () => {
      live.current = false
      off()
    }
  }, [accept])

  const flushText = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const text = pending.current
    if (text === null) return
    pending.current = null
    const edit = edits.current
    try {
      accept(await window.api.updateNotes({ text }))
      if (!live.current) return
      setSaveStatus({ kind: 'saved' })
      if (edit === edits.current) setLocal(null)
    } catch (err) {
      console.warn('Could not save the speaker notes:', err)
      if (live.current) setSaveStatus({ kind: 'error', message: ipcMessage(err) })
    }
  }, [accept])

  const setText = useCallback(
    (text: string) => {
      edits.current++
      pending.current = text
      setLocal(text)
      setSaveStatus({ kind: 'idle' })
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flushText(), NOTES_SAVE_MS)
    },
    [flushText]
  )

  // Leaving Home saves what was typed.
  const flushRef = useRef(flushText)
  flushRef.current = flushText
  useEffect(() => () => void flushRef.current(), [])

  const update = useCallback(
    async (patch: NotesSettingsPatch): Promise<string | null> => {
      try {
        accept(await window.api.updateNotes(patch))
        return null
      } catch (err) {
        console.warn('Could not save the speaker notes:', err)
        return ipcMessage(err)
      }
    },
    [accept]
  )

  const rehearse = useCallback(
    async (open: boolean): Promise<string | null> => {
      if (open) await flushText()
      try {
        accept(await window.api.rehearseNotes(open))
        return null
      } catch (err) {
        console.warn('Could not open or close the rehearsal:', err)
        return ipcMessage(err)
      }
    },
    [accept, flushText]
  )

  return { state, text: local ?? state?.settings.text ?? '', saveStatus, setText, flushText, update, rehearse }
}
