import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { displayTime } from '../../../shared/editor/clips'
import {
  coverEndHere,
  coversFromShapes,
  coverStartHere,
  coverWholeVideo,
  deleteCovers,
  editCoverBox,
  keepCovers,
  setCoverColour,
  type BoxEdit
} from '../../../shared/editor/coverEdit'
import { itemKey, parseItemKey } from '../../../shared/editor/multiSelect'
import { boxAt, pathKeys } from '../../../shared/privacy/coverPath'
import { kindTitle, PRIVACY_COPY } from '../../../shared/privacy/copy'
import { COVER_COLOURS } from '../../../shared/privacy/kinds'
import { fmt } from '../../../shared/i18n/fmt'
import { t, type MessageKey } from '../../../shared/i18n/t'
import type { Cover, NormRect, Project, Shape } from '../../../shared/types'
import type { EditorServices } from '../editor/context'
import { useGroup } from '../editor/groupContext'
import { NumberField } from '../i18n/NumberField'
import { setWholePath, subscribeWholePath, wholePathOn } from './coverCommands'
import { ringColourAt } from './coverPick'
import { EverywhereDialog } from './EverywhereDialog'
import { runFollow } from './followRun'
import './covers.css'

/** The colour chips (§2.2): *Match the background*, then Settings' four. */
const CHIPS: readonly { id: 'ring' | keyof typeof COVER_COLOURS; label: MessageKey }[] = [
  { id: 'ring', label: PRIVACY_COPY.cover.colourRing },
  { id: 'dark', label: PRIVACY_COPY.cover.colourDark },
  { id: 'light', label: PRIVACY_COPY.cover.colourLight },
  { id: 'black', label: PRIVACY_COPY.cover.colourBlack },
  { id: 'white', label: PRIVACY_COPY.cover.colourWhite }
]

type Field = 'left' | 'top' | 'width' | 'height'
const FIELDS: readonly { id: Field; label: MessageKey }[] = [
  { id: 'left', label: PRIVACY_COPY.cover.boxLeft },
  { id: 'top', label: PRIVACY_COPY.cover.boxTop },
  { id: 'width', label: PRIVACY_COPY.cover.boxWidth },
  { id: 'height', label: PRIVACY_COPY.cover.boxHeight }
]

const isWeak = (s: Shape): boolean => s.kind === 'blur' || s.kind === 'pixelate'
/** A box value in percent, one decimal. */
const pct = (v: number): number => Math.round(v * 1000) / 10
const shapeBox = (s: Shape): NormRect => ({ x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) })

/** The edit a box field's new value (percent) makes: Left and Top move the box, Width and Height move the right or bottom edge at every key (§2.2). */
function fieldEdit(field: Field, value: number, box: NormRect): BoxEdit | null {
  const v = value / 100
  if (!Number.isFinite(v)) return null
  switch (field) {
    case 'left':
      return { move: { dx: v - box.x, dy: 0 } }
    case 'top':
      return { move: { dx: 0, dy: v - box.y } }
    case 'width':
      return { edges: { right: v - box.w } }
    case 'height':
      return { edges: { bottom: v - box.h } }
  }
}

/** The covers and the blur or pixelate shapes the section is about: a group's, else the single selection's. */
function chosen(project: Project, groupKeys: readonly string[], coverIds: readonly string[]): { covers: Cover[]; weak: Shape[] } {
  const many = groupKeys.length >= 2
  const ids = many ? groupKeys.map((k) => parseItemKey(k)).filter((k) => k?.kind === 'cover').map((k) => k!.id) : coverIds
  const want = new Set(ids)
  const covers = (project.covers ?? []).filter((c) => want.has(c.id))
  const shapeIds = new Set(many ? groupKeys.map((k) => parseItemKey(k)).filter((k) => k?.kind === 'shape').map((k) => k!.id) : [])
  const weak = (project.shapes ?? []).filter((s) => shapeIds.has(s.id) && isWeak(s))
  return { covers, weak }
}

/**
 * The *Cover* section of one or several selected covers (docs/design/auto-blur.md §2.2): the
 * colour chips, the box at the playhead in percent of the whole frame, *Change the whole path*,
 * *Start here* and *End here*, *Follow what is under it*, *Cover this text everywhere…*, *Keep it
 * for the whole video*, *Keep covered* and *Uncover*, and a suggestion's lines. With several
 * selected, actions that need one cover are disabled with their reason; selected blur and pixelate
 * shapes offer *Turn into covers*. Every action is one undo step.
 */
export function CoverSection(props: { services: EditorServices; coverIds: readonly string[]; shapeIds: readonly string[] }): JSX.Element | null {
  const { store, player } = props.services
  const group = useGroup()
  const project = useSyncExternalStore(store.subscribe, () => store.state)
  // Drawn again when the playhead stops somewhere else, or starts or stops moving (never every frame of playback).
  useSyncExternalStore(player.subscribe, () => (player.moving ? 'moving' : player.time))
  const wholePath = useSyncExternalStore(subscribeWholePath, wholePathOn)
  const [following, setFollowing] = useState<{ id: string; stop: AbortController } | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [everywhere, setEverywhere] = useState<string | null>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const followRef = useRef<HTMLButtonElement>(null)
  const statusRef = useRef<HTMLParagraphElement>(null)
  const focusNext = useRef<'title' | 'follow' | 'status' | null>(null)
  const uid = `cover-${useId().replace(/:/g, '')}`

  const { covers, weak } = chosen(project, group.group.keys, props.coverIds)
  const one = covers.length === 1 ? covers[0] : null
  const coverKey = covers.map((c) => c.id).join(',')

  // Focus after an action that removes what had it (§11, finding 37).
  useEffect(() => {
    const target = focusNext.current
    focusNext.current = null
    if (target === 'title') titleRef.current?.focus()
    else if (target === 'follow') followRef.current?.focus()
    else if (target === 'status') statusRef.current?.focus()
  })
  // A status line belongs to the cover it was about.
  useEffect(() => setStatus(null), [coverKey])

  if (!covers.length && !weak.length) return null
  const ids = covers.map((c) => c.id)
  const at = displayTime(project.clips, player.time)
  const t0 = one ? Math.min(Math.max(at, one.start), Math.max(one.start, one.end - 0.001)) : at
  const box = one ? boxAt(one, t0) : null
  const inside = !!one && at >= one.start && at < one.end
  const suggestion = covers.some((c) => !!c.found)

  const colour = async (id: (typeof CHIPS)[number]['id']): Promise<void> => {
    if (id !== 'ring') return store.update((p) => setCoverColour(p, ids, COVER_COLOURS[id]))
    // *Match the background* picks again from the frame at the playhead, for each cover.
    const picked: Record<string, string> = {}
    for (const c of covers) {
      const b = boxAt(c, Math.min(Math.max(at, c.start), c.end - 0.001)) ?? pathKeys(c)[0]
      if (b) picked[c.id] = await ringColourAt(project.id, Math.min(Math.max(at, c.start), c.end - 0.001), b)
    }
    store.update((p) => Object.entries(picked).reduce((q, [cid, col]) => setCoverColour(q, [cid], col), p))
  }

  const setField = (field: Field, value: number): void => {
    if (!one || !box) return
    const edit = fieldEdit(field, value, box)
    if (!edit) return
    store.update((p) => editCoverBox(p, one.id, t0, edit, wholePath), `cover-box:${one.id}:${field}`)
  }

  const follow = async (): Promise<void> => {
    if (!one) return
    const stop = new AbortController()
    setFollowing({ id: one.id, stop })
    setStatus(null)
    const r = await runFollow(props.services, one.id, stop.signal)
    setFollowing(null)
    if (r === 'stopped') {
      // *Stop* changes nothing and keeps the focus on Follow.
      focusNext.current = 'follow'
      return
    }
    const now = store.state.covers?.find((c) => c.id === one.id)
    setStatus(
      r === 'done' && now
        ? t(PRIVACY_COPY.cover.followDone, { start: fmt.clock(now.start), end: fmt.clock(now.end) })
        : r === 'none'
          ? t(PRIVACY_COPY.cover.followNone)
          : r === 'busy'
            ? t(PRIVACY_COPY.run.busy)
            : t(PRIVACY_COPY.run.failedOther)
    )
    focusNext.current = 'status'
  }

  const keep = (): void => {
    store.update((p) => keepCovers(p, ids))
    // The suggestion's lines that held the focus are gone: the section's title takes it.
    focusNext.current = 'title'
  }

  const uncover = (): void => {
    store.update((p) => deleteCovers(p, ids))
    group.notice(t(PRIVACY_COPY.cover.uncovered))
    group.select([], null)
  }

  const turnWeak = async (): Promise<void> => {
    const colours: Record<string, string> = {}
    for (const s of weak) colours[s.id] = await ringColourAt(project.id, (s.start + s.end) / 2, shapeBox(s))
    let made: string[] = []
    store.update((p) => {
      const r = coversFromShapes(p, weak.map((s) => s.id), colours)
      made = r.ids
      return r.project
    })
    if (made.length) group.select([...ids, ...made].map((id) => itemKey('cover', id)), itemKey('cover', made[0]))
  }

  const reason = (key: MessageKey, id: string): JSX.Element => (
    <p className="hint" id={`${uid}-${id}`}>
      {t(key)}
    </p>
  )

  return (
    <section className="insp-section cover-section" data-testid="cover-section">
      <h3 ref={titleRef} tabIndex={-1} id={`${uid}-title`}>
        <span>{covers.length >= 2 ? t(PRIVACY_COPY.cover.selected, { count: covers.length, n: fmt.count(covers.length) }) : covers.length === 1 ? t(PRIVACY_COPY.cover.title) : t(PRIVACY_COPY.weak.turnSelected, { count: weak.length, n: fmt.count(weak.length) })}</span>
      </h3>

      {one?.found && (
        <div className="cover-lines" data-testid="cover-lines">
          <p className="hint">{t(PRIVACY_COPY.cover.found)}</p>
          {one.kind && (
            <p className="cover-what">
              <span className="muted">{t(PRIVACY_COPY.cover.what)}</span> <span>{t(kindTitle(one.kind))}</span>
            </p>
          )}
          {one.found === 'check' && <p className="hint cover-check-line">{t(PRIVACY_COPY.cover.toCheck)}</p>}
          {one.lost && <p className="hint">{t(PRIVACY_COPY.cover.lost)}</p>}
          {one.missed && <p className="hint">{t(PRIVACY_COPY.cover.missed)}</p>}
          {one.thin && <p className="hint">{t(PRIVACY_COPY.cover.thin)}</p>}
        </div>
      )}
      {one && !one.found && (one.missed || one.thin || one.lost) && (
        <div className="cover-lines">
          {one.lost && <p className="hint">{t(PRIVACY_COPY.cover.lost)}</p>}
          {one.missed && <p className="hint">{t(PRIVACY_COPY.cover.missed)}</p>}
          {one.thin && <p className="hint">{t(PRIVACY_COPY.cover.thin)}</p>}
        </div>
      )}

      {covers.length > 0 && (
        <>
          <div className="chips cover-colours" role="group" aria-label={t(PRIVACY_COPY.cover.colour)} data-testid="cover-colours">
            {CHIPS.map((c) => {
              const value = c.id === 'ring' ? null : COVER_COLOURS[c.id]
              const on = value !== null && covers.every((x) => x.color === value)
              return (
                <button key={c.id} type="button" className={`chip ${on ? 'active' : ''}`} aria-pressed={c.id === 'ring' ? undefined : on} onClick={() => void colour(c.id)} data-colour={c.id}>
                  {value && <span className="cover-swatch" style={{ background: value }} aria-hidden="true" />}
                  {t(c.label)}
                </button>
              )
            })}
          </div>

          <fieldset className="cover-box" disabled={!one} aria-describedby={one ? undefined : `${uid}-box`} data-testid="cover-box">
            <legend>{t(PRIVACY_COPY.cover.box)}</legend>
            {FIELDS.map((f) => {
              const value = !box ? 0 : f.id === 'left' ? pct(box.x) : f.id === 'top' ? pct(box.y) : f.id === 'width' ? pct(box.w) : pct(box.h)
              return (
                <label key={f.id} className="cover-field">
                  <span>{t(f.label)}</span>
                  <NumberField
                    aria-label={t(f.label)}
                    min={0}
                    max={100}
                    step={0.1}
                    value={value}
                    disabled={!one}
                    onValue={(n) => setField(f.id, n)}
                    onBlur={() => store.seal()}
                    data-field={f.id}
                  />
                </label>
              )
            })}
          </fieldset>
          {!one && reason(PRIVACY_COPY.cover.oneForBox, 'box')}

          {one && (
            <>
              <label className="toggle">
                <span>{t(PRIVACY_COPY.cover.wholePath)}</span>
                <input type="checkbox" aria-label={t(PRIVACY_COPY.cover.wholePath)} aria-describedby={`${uid}-whole`} checked={wholePath} onChange={(e) => setWholePath(e.target.checked)} data-testid="cover-whole-path" />
              </label>
              <p className="hint" id={`${uid}-whole`}>
                {t(PRIVACY_COPY.cover.wholePathHint)}
              </p>
              <div className="cover-row">
                <button
                  type="button"
                  className="btn ghost small"
                  disabled={!inside || !coverStartHere(project, one.id, at)}
                  aria-describedby={inside ? undefined : `${uid}-outside`}
                  onClick={() => store.update((p) => coverStartHere(p, one.id, displayTime(p.clips, player.time)) ?? p)}
                  data-testid="cover-start-here"
                >
                  {t(PRIVACY_COPY.cover.startHere)}
                </button>
                <button
                  type="button"
                  className="btn ghost small"
                  disabled={!inside || !coverEndHere(project, one.id, at)}
                  aria-describedby={inside ? undefined : `${uid}-outside`}
                  onClick={() => store.update((p) => coverEndHere(p, one.id, displayTime(p.clips, player.time)) ?? p)}
                  data-testid="cover-end-here"
                >
                  {t(PRIVACY_COPY.cover.endHere)}
                </button>
              </div>
              {!inside && reason(PRIVACY_COPY.cover.outside, 'outside')}
            </>
          )}

          <div className="cover-row">
            {following ? (
              <span className="cover-following" role="status">
                <span>{t(PRIVACY_COPY.cover.following)}</span>{' '}
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => {
                    following.stop.abort()
                    focusNext.current = 'follow'
                  }}
                  data-testid="cover-follow-stop"
                >
                  {t(PRIVACY_COPY.cover.followStop)}
                </button>
              </span>
            ) : (
              <button
                ref={followRef}
                type="button"
                className="btn ghost small"
                disabled={!one}
                aria-describedby={one ? `${uid}-follow` : `${uid}-oneFollow`}
                onClick={() => void follow()}
                data-testid="cover-follow"
              >
                {t(PRIVACY_COPY.cover.follow)}
              </button>
            )}
            <button
              type="button"
              className="btn ghost small"
              disabled={!one}
              aria-describedby={one ? undefined : `${uid}-oneEverywhere`}
              onClick={() => one && setEverywhere(one.id)}
              data-testid="cover-everywhere"
            >
              {t(PRIVACY_COPY.cover.everywhere)}
            </button>
          </div>
          {one ? reason(PRIVACY_COPY.cover.followHint, 'follow') : reason(PRIVACY_COPY.cover.oneForFollow, 'oneFollow')}
          {!one && reason(PRIVACY_COPY.cover.oneForEverywhere, 'oneEverywhere')}
          <p className="cover-status" ref={statusRef} tabIndex={-1} role="status" data-testid="cover-status">
            {status}
          </p>

          <div className="cover-row">
            <button type="button" className="btn ghost small" onClick={() => store.update((p) => ids.reduce((q, id) => coverWholeVideo(q, id), p))} data-testid="cover-whole">
              {t(PRIVACY_COPY.cover.whole)}
            </button>
            {suggestion && (
              <button type="button" className="btn small" onClick={keep} data-testid="cover-keep">
                {t(PRIVACY_COPY.cover.keep)}
              </button>
            )}
            <button type="button" className="btn ghost small danger" onClick={uncover} data-testid="cover-uncover">
              {t(PRIVACY_COPY.cover.uncover)}
            </button>
          </div>
        </>
      )}

      {weak.length > 0 && (
        <button type="button" className="btn ghost small" onClick={() => void turnWeak()} data-testid="cover-turn-selected">
          {t(PRIVACY_COPY.weak.turnSelected, { count: weak.length, n: fmt.count(weak.length) })}
        </button>
      )}

      {everywhere && <EverywhereDialog services={props.services} coverId={everywhere} onClose={() => setEverywhere(null)} />}
    </section>
  )
}
