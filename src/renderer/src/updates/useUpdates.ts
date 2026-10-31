import { useCallback, useEffect, useState } from 'react'
import type { UpdateInstallResult } from '../../../shared/api/updates'
import type { UpdateState } from '../../../shared/updates/updates'

/** Flown's update state (NW-15, docs/design/auto-update.md): what main last said, null until it answers. */
export function useUpdates(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    let live = true
    const off = window.api.onUpdatesChanged((s) => {
      if (live) setState(s)
    })
    // A change that arrived first is newer than this answer.
    window.api.updatesGet().then(
      (s) => {
        if (live) setState((cur) => cur ?? s)
      },
      () => undefined
    )
    return () => {
      live = false
      off()
    }
  }, [])
  return state
}

/** How long the reason Restart now was refused shows. */
export const REFUSED_MS = 8000

/**
 * Why Restart now was refused, and how to show a new refusal. Main says nothing when the job it
 * waited for ends, so the reason goes after REFUSED_MS, and at once when the update moves on (another
 * phase or version): it never stays to describe a job that is over.
 */
export function useRefusal(s: UpdateState | null): [string | null, (reason: string | null) => void] {
  // A new object each time: the same reason given again shows for its full time again.
  const [refused, setRefused] = useState<{ reason: string } | null>(null)
  useEffect(() => setRefused(null), [s?.phase, s?.version])
  useEffect(() => {
    if (!refused) return
    const timer = window.setTimeout(() => setRefused(null), REFUSED_MS)
    return () => window.clearTimeout(timer)
  }, [refused])
  const refuse = useCallback((reason: string | null) => setRefused(reason ? { reason } : null), [])
  return [refused?.reason ?? null, refuse]
}

/**
 * Why a recording keeps Restart now from running, as Home shows it: from Record until the recording
 * has been saved and processed. Main's busy check cannot see all of that (it lives in the recording
 * code), and quitting then asks first (Keep working or Quit anyway), which would lose the restart.
 * Set by Home only, null while Home is closed.
 */
let recordingBusy: string | null = null
export const setRecordingBusy = (reason: string | null): void => {
  recordingBusy = reason
}

/** Restart now: refused here while Home makes, saves or processes a recording; otherwise main decides. */
export const installUpdate = (): Promise<UpdateInstallResult> =>
  recordingBusy ? Promise.resolve({ ok: false, reason: recordingBusy }) : window.api.updatesInstall()

/** Versions whose Home notice the user put off with Later (until the next start). */
const later = new Set<string>()
export const putOff = (version: string): void => void later.add(version)
export const isPutOff = (version: string): boolean => later.has(version)

/** "10:42", or "30 Oct, 10:42" when not today. */
export function checkedAt(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}
