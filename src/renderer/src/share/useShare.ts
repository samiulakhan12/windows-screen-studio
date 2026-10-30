/**
 * The page side of "Share without a server" (F-22, docs/design/share.md): the destinations set up
 * in Settings › Share, the export dialog's "After export" choices remembered per preset, and the
 * share runs main reports for a file.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ShareMeta, ShareRunView, ShareTargets } from '../../../shared/api/share'
import { choicesFor, readShareChoices, withChoices } from '../../../shared/share/choices'
import { ipcMessage } from '../settings/providerText'

const CHOICES_KEY = 'export-share'

/** Folders that are on and chats that can be read, as offered (folders first). */
export function offeredIds(t: ShareTargets | null): string[] {
  if (!t) return []
  return [...t.folders.filter((f) => f.on).map((f) => f.id), ...t.hooks.filter((h) => h.readable).map((h) => h.id)]
}

/** "Copy to OneDrive" / "Post to #demos" for a destination id. */
export function actionLabel(t: ShareTargets | null, id: string): string {
  const f = t?.folders.find((x) => x.id === id)
  if (f) return `Copy to ${f.label}`
  const h = t?.hooks.find((x) => x.id === id)
  return h ? `Post to ${h.label}` : 'Share'
}

/** The tooltip of a destination: the folder's path, or the chat's service and masked webhook. */
export function actionTitle(t: ShareTargets | null, id: string): string {
  const f = t?.folders.find((x) => x.id === id)
  if (f) return `Copy the video into ${f.path}${f.path.includes('\\') ? '\\' : '/'}Flown`
  const h = t?.hooks.find((x) => x.id === id)
  return h ? `Post the title, length and where it was saved to ${h.label} (${h.masked}). The video is not uploaded.` : ''
}

export function useShareTargets(): { targets: ShareTargets | null; error: string | null; reload: (refresh?: boolean) => void; set: (t: ShareTargets) => void } {
  const [targets, setTargets] = useState<ShareTargets | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback((refresh = false) => {
    window.api.shareTargets(refresh).then(
      (t) => {
        setTargets(t)
        setError(null)
      },
      (err: unknown) => setError(ipcMessage(err))
    )
  }, [])
  useEffect(() => reload(), [reload])
  return { targets, error, reload, set: setTargets }
}

function readChoices(): ReturnType<typeof readShareChoices> {
  try {
    return readShareChoices(JSON.parse(localStorage.getItem(CHOICES_KEY) ?? '{}'))
  } catch {
    return readShareChoices({})
  }
}

export interface AfterExport {
  targets: ShareTargets | null
  offered: string[]
  chosen: string[]
  toggle: (id: string) => void
  /**
   * After a single export: tells main about the file (the notification then offers the
   * destinations not chosen) and starts the chosen ones. Never throws.
   */
  begin: (file: string, meta: ShareMeta) => Promise<void>
}

/** The export dialog's "After export" row, remembered for `preset`. */
export function useAfterExport(preset: string | undefined): AfterExport {
  const { targets } = useShareTargets()
  const [choices, setChoices] = useState(readChoices)
  const offered = useMemo(() => offeredIds(targets), [targets])
  const chosen = useMemo(() => choicesFor(choices, preset, offered), [choices, preset, offered])
  const toggle = (id: string): void => {
    const ids = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]
    const next = withChoices(choices, preset, ids, offered)
    setChoices(next)
    try {
      localStorage.setItem(CHOICES_KEY, JSON.stringify(next))
    } catch {
      // Not remembered; the choice still applies now.
    }
  }
  const begin = async (file: string, meta: ShareMeta): Promise<void> => {
    try {
      await window.api.shareOffer(file, meta, chosen.length > 0)
      if (chosen.length) await window.api.shareStart(file, chosen, meta)
    } catch (err) {
      console.warn('Share could not start:', ipcMessage(err))
    }
  }
  return { targets, offered, chosen, toggle, begin }
}

/** The share runs of `file`, kept up to date. */
export function useShareRuns(file: string): ShareRunView[] {
  const [runs, setRuns] = useState<ShareRunView[]>([])
  useEffect(() => {
    let live = true
    const off = window.api.onShareUpdate((run) => {
      if (run.file !== file) return
      setRuns((list) => (list.some((r) => r.id === run.id) ? list.map((r) => (r.id === run.id ? run : r)) : [...list, run]))
    })
    window.api.shareRuns(file).then(
      (list) => {
        if (!live) return
        // Updates that came in meanwhile are newer than the list.
        setRuns((now) => list.map((r) => now.find((x) => x.id === r.id) ?? r).concat(now.filter((x) => !list.some((r) => r.id === x.id))))
      },
      () => undefined
    )
    return () => {
      live = false
      off()
    }
  }, [file])
  return runs
}
