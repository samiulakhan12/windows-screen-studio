import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CopyInfo } from '../../../shared/api/privacy'
import { isPrivateBleep } from '../../../shared/privacy/coverData'
import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { fmt } from '../../../shared/i18n/fmt'
import { t } from '../../../shared/i18n/t'
import type { Project } from '../../../shared/types'
import type { EditorServices } from '../editor/context'
import { lastInputWasKey } from '../editor/focus'
import './privacyPanel.css'

/** After a press: how many copies have this video's covers now, and the copies main could not cover. */
interface Covered {
  covered: number
  left: CopyInfo[]
}

/**
 * *Also cover the copies made from this video* (docs/design/auto-blur.md §2.12, §5.10): after Find, on
 * a project with copies (short clips, vertical and square versions, duplicates, shorter versions),
 * one button adds this video's found covers and private bleeps to each closed copy as suggestions,
 * through main; a copy open in Flown is skipped. No undo step in this project: each copy's file
 * changes once. Then the line says how many copies were covered, and how many main could not cover
 * (a copy it could not read or save, or the call failing), which the button offers again; it never
 * says it covered none (second review, finding [26]). Main reads this project from its
 * project.json, so the press first writes it as the user sees it (`flush`, the editor's saver, as
 * the export's timeline does, §9 row 10): a press before the autosave would give the copies the
 * covers as they were at the last save. While main works the button waits with aria-disabled, so
 * the keyboard stays on it; once every copy is covered, the line takes the keyboard from it.
 */
export function CopiesOffer(props: { services: EditorServices; flush?: () => unknown }): JSX.Element | null {
  const { store } = props.services
  const now = (): Project => store.state
  const project = useSyncExternalStore(store.subscribe, now, now)
  const [copies, setCopies] = useState<CopyInfo[] | null>(null)
  const [done, setDone] = useState<Covered | null>(null)
  const [busy, setBusy] = useState(false)
  const lineRef = useRef<HTMLParagraphElement>(null)
  const focusLine = useRef(false)
  const found = !!project.privacy?.find && (!!project.covers?.some((c) => c.kind) || !!project.bleeps?.some(isPrivateBleep))
  useEffect(() => {
    setCopies(null)
    setDone(null)
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
  // The offer the keyboard pressed went with the last copy covered: the line that says so takes the focus.
  useEffect(() => {
    if (!focusLine.current) return
    focusLine.current = false
    lineRef.current?.focus()
  })
  if (!found) return null
  const offered = done ? done.left : (copies ?? [])
  if (!done && !offered.length) return null
  const cover = async (list: CopyInfo[]): Promise<void> => {
    if (busy || !list.length) return
    const keyed = lastInputWasKey()
    const before = done?.covered ?? 0
    setBusy(true)
    let left = list
    try {
      await props.flush?.()
      const r = await window.api.coverCopies(project.id, list.map((c) => c.id))
      // Main skips a copy it cannot read or save; every other one has this video's covers now.
      const skipped = new Set(Array.isArray(r?.skipped) ? r.skipped : list.map((c) => c.id))
      left = list.filter((c) => skipped.has(c.id))
    } catch {
      left = list
    } finally {
      setBusy(false)
    }
    focusLine.current = keyed && !left.length
    setDone({ covered: before + list.length - left.length, left })
  }
  return (
    <>
      {done && (
        <p ref={lineRef} className="privacy-line" role="status" tabIndex={-1} data-testid="copies-result">
          {done.covered > 0 && <span data-testid="copies-done">{t(PRIVACY_COPY.copies.done, { count: done.covered, n: fmt.count(done.covered) })}</span>}
          {done.covered > 0 && done.left.length > 0 && ' '}
          {done.left.length > 0 && <span data-testid="copies-left">{t(PRIVACY_COPY.copies.notCovered, { count: done.left.length, n: fmt.count(done.left.length) })}</span>}
        </p>
      )}
      {offered.length > 0 && (
        <button key="offer" type="button" className="link" aria-disabled={busy ? 'true' : undefined} onClick={() => void cover(offered)} data-testid="copies-offer">
          {t(PRIVACY_COPY.copies.offer, { count: offered.length, n: fmt.count(offered.length) })}
        </button>
      )}
    </>
  )
}
