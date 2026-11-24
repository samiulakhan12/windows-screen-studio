import { useEffect, useState, useSyncExternalStore } from 'react'
import type { CopyInfo } from '../../../shared/api/privacy'
import { isPrivateBleep } from '../../../shared/privacy/coverData'
import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { fmt } from '../../../shared/i18n/fmt'
import { t } from '../../../shared/i18n/t'
import type { Project } from '../../../shared/types'
import type { EditorServices } from '../editor/context'
import './privacyPanel.css'

/**
 * *Also cover the copies made from this video* (docs/design/auto-blur.md §2.12, §5.10): after Find, on
 * a project with copies (short clips, vertical and square versions, duplicates, shorter versions),
 * one button adds this video's found covers and private bleeps to each closed copy as suggestions,
 * through main; a copy open in Flown is skipped. No undo step in this project: each copy's file
 * changes once. Then the line says how many copies were covered. Main reads this project from its
 * project.json, so the press first writes it as the user sees it (`flush`, the editor's saver, as
 * the export's timeline does, §9 row 10): a press before the autosave would give the copies the
 * covers as they were at the last save.
 */
export function CopiesOffer(props: { services: EditorServices; flush?: () => unknown }): JSX.Element | null {
  const { store } = props.services
  const now = (): Project => store.state
  const project = useSyncExternalStore(store.subscribe, now, now)
  const [copies, setCopies] = useState<CopyInfo[] | null>(null)
  const [covered, setCovered] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const found = !!project.privacy?.find && (!!project.covers?.some((c) => c.kind) || !!project.bleeps?.some(isPrivateBleep))
  useEffect(() => {
    setCopies(null)
    setCovered(null)
    if (!found) return
    let live = true
    window.api.copies(project.id).then(
      (list) => live && setCopies(Array.isArray(list) ? list : []),
      () => live && setCopies([])
    )
    return () => {
      live = false
    }
  }, [project.id, found])
  if (covered !== null)
    return (
      <p className="privacy-line" role="status" data-testid="copies-done">
        {t(PRIVACY_COPY.copies.done, { count: covered, n: fmt.count(covered) })}
      </p>
    )
  if (!found || !copies?.length) return null
  const cover = async (): Promise<void> => {
    setBusy(true)
    try {
      await props.flush?.()
      const r = await window.api.coverCopies(project.id, copies.map((c) => c.id))
      setCovered(r.covered)
    } catch {
      setCovered(0)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" className="link" disabled={busy} onClick={() => void cover()} data-testid="copies-offer">
      {t(PRIVACY_COPY.copies.offer, { count: copies.length, n: fmt.count(copies.length) })}
    </button>
  )
}
