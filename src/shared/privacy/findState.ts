/**
 * What part P5's panels read from a project about Find (docs/design/auto-blur.md §2.5, §2.6, §2.10,
 * §2.12, §7.7): the dialog's choices and their defaults, the record a run leaves, whether the screen
 * is already checked, whether the last run finished, the captions' signature, the export note's
 * lines and a run's result line. Pure.
 */
import type { FindResult, OriginCovers } from '../api/privacy'
import { newCoverId } from '../editor/coverEdit'
import { planOf } from '../engine/freeze'
import { rowTimes } from '../review/times'
import type { Bleep, Cover, FindRecord, PrivacyPrefs, PrivateKind, Project, ProjectPrivacy, Transcript } from '../types'
import { isPrivateBleep, privateGroupOf, privateItems } from './coverData'
import { foundCovers, limitCovers } from './found'
import { DEFAULT_KINDS, PRIVATE_KINDS } from './kinds'
import { noticesApply } from './notices'
import { READER_ID } from './readerCatalog'
import { sha256Hex } from './sha256'

/** The kinds the Find dialog offers, in its order (§2.5): every kind but the text chosen in Cover this text everywhere. */
export const FIND_KINDS: readonly PrivateKind[] = Object.freeze(PRIVATE_KINDS.filter((k) => k !== 'text'))

/** Most phone regions the user adds (§2.5). */
export const MAX_ADDED_REGIONS = 5
/** Most names or never-hide words a request carries (Settings' 200 and the project's 200). */
const MAX_REQUEST_LIST = 400

/** What the Find dialog chooses (§2.5). `regions` are the ones the user added; the PC's and the UI language's are always on. */
export interface FindChoices {
  kinds: PrivateKind[]
  regions: string[]
  names: string[]
  neverHide: string[]
  listen: boolean
}

/** Whether the project has captions to listen to. */
export const hasCaptions = (project: Pick<Project, 'transcript'>): boolean => !!project.transcript?.segments.length

/**
 * The dialog's choices for `project` (§2.5): the project's own, else Settings', else decision 2's
 * defaults; this video's names and never-hide words (Settings' are used too, at the request);
 * *listen* on whenever the project has captions unless the user unticked it for this project.
 */
export function findChoices(project: Pick<Project, 'privacy' | 'transcript'>, prefs: PrivacyPrefs | null): FindChoices {
  const own = project.privacy
  const kinds = own?.kinds ?? prefs?.kinds ?? DEFAULT_KINDS
  return {
    kinds: FIND_KINDS.filter((k) => kinds.includes(k)),
    regions: [...(own?.regions ?? prefs?.regions ?? [])].slice(0, MAX_ADDED_REGIONS),
    names: [...(own?.names ?? [])],
    neverHide: [...(own?.neverHide ?? [])],
    listen: hasCaptions(project) && own?.listen !== false
  }
}

/** The kinds a run looks for on screen: the chosen ones, without notifications where they never apply (area, window and imported recordings). */
export function screenKinds(project: Pick<Project, 'capture' | 'source'>, kinds: readonly PrivateKind[]): PrivateKind[] {
  return kinds.filter((k) => k !== 'text' && (k !== 'notice' || noticesApply(project)))
}

/** A list's entries trimmed, one line each, once each, none empty. */
const cleanList = (list: readonly string[]): string[] => {
  const out: string[] = []
  for (const raw of list) {
    const s = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()
    if (s && s.length <= 80 && !out.includes(s)) out.push(s)
  }
  return out
}

/** The project's privacy with the dialog's choices (§2.5): *listen* kept only as false, and only when unticked with captions. */
export function withChoices(privacy: ProjectPrivacy | undefined, choices: FindChoices, captions: boolean): ProjectPrivacy {
  const out: ProjectPrivacy = { ...(privacy ?? {}), kinds: FIND_KINDS.filter((k) => choices.kinds.includes(k)) }
  const regions = choices.regions.slice(0, MAX_ADDED_REGIONS)
  if (regions.length) out.regions = regions
  else delete out.regions
  const names = cleanList(choices.names).slice(0, 200)
  if (names.length) out.names = names
  else delete out.names
  const never = cleanList(choices.neverHide).slice(0, 200)
  if (never.length) out.neverHide = never
  else delete out.neverHide
  if (captions) {
    if (choices.listen) delete out.listen
    else out.listen = false
  }
  return out
}

/** Whether two privacy records hold the same choices (no edit is needed to save them). */
export function sameChoices(a: ProjectPrivacy | undefined, b: ProjectPrivacy): boolean {
  const list = (x: readonly string[] | undefined): string => JSON.stringify(x ?? [])
  return list(a?.kinds) === list(b.kinds) && list(a?.regions) === list(b.regions) && list(a?.names) === list(b.names) && list(a?.neverHide) === list(b.neverHide) && a?.listen === b.listen
}

/** Settings' entries then this video's, each once, at most 400 (the request's names and never-hide words). */
export function requestList(settings: readonly string[] | undefined, own: readonly string[]): string[] {
  return cleanList([...(settings ?? []), ...own]).slice(0, MAX_REQUEST_LIST)
}

/** Whether the last Find stopped, failed reads or ended early (§2.6, §2.12). */
export const unfinished = (record: FindRecord | undefined): boolean => !!record && (!!record.stopped || (record.failed ?? 0) > 0 || record.readTo !== undefined)

/**
 * Whether the project's last Find already read the whole screen with these kinds and this reader
 * (§2.10, §14.5): then Polish only listens to the new captions.
 */
export function screenChecked(project: Pick<Project, 'privacy' | 'capture' | 'source'>, kinds: readonly PrivateKind[]): boolean {
  const r = project.privacy?.find
  if (!r || r.reader !== READER_ID || unfinished(r)) return false
  const want = screenKinds(project, kinds)
  const had = screenKinds(project, r.kinds)
  return want.length === had.length && want.every((k) => had.includes(k))
}

/** Seconds as Find's messages count them: whole minutes, 0 under a minute. */
export const minutesOf = (seconds: number): number => (Number.isFinite(seconds) && seconds >= 60 ? Math.round(seconds / 60) : 0)

/** The minutes Find read less often, from a record's spans ("start end" pairs joined by ';'). */
export function thinMinutes(spans: string): number {
  let total = 0
  for (const pair of spans.split(';')) {
    const [a, b] = pair.split(' ').map(Number)
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) total += b - a
  }
  return minutesOf(total)
}

const sigs = new WeakMap<Transcript, string>()
/**
 * The captions' signature (§7.7): the SHA-256 of their words and times, as hex; worked out once for
 * each transcript. Find records it when it starts listening (finding 14).
 */
export function captionsSig(transcript: Transcript | null | undefined): string {
  if (!transcript) return sha256Hex('[]')
  const hit = sigs.get(transcript)
  if (hit) return hit
  const words = transcript.segments.map((s) => [s.start, s.end, s.text, (s.words ?? []).map((w) => [w.text, w.start, w.end])])
  const sig = sha256Hex(JSON.stringify(words))
  sigs.set(transcript, sig)
  return sig
}

/** Whether the captions changed after the last Find listened to them (§2.12 `captionsChanged`). */
export function captionsChanged(project: Pick<Project, 'privacy' | 'transcript'>): boolean {
  const r = project.privacy?.find
  return !!r?.listened && !!r.captionsSig && captionsSig(project.transcript) !== r.captionsSig
}

/** How many private bleeps the last Find made are gone (removed by hand or by an older Flown, §2.12 `saidRemoved`). */
export function saidRemoved(project: Pick<Project, 'privacy' | 'bleeps'>): number {
  const ids = project.privacy?.find?.saidIds
  if (!ids?.length) return 0
  const have = new Set((project.bleeps ?? []).map((b) => b.id))
  return ids.filter((id) => !have.has(id)).length
}

/** The record a run leaves (§4.1, §5.10): no text, only what it did. */
export function findRecordOf(o: {
  at: string
  kinds: readonly PrivateKind[]
  listened: boolean
  captionsSig?: string
  result: Extract<FindResult, { ok: true }> | null
  saidIds: readonly string[]
}): FindRecord {
  const rec: FindRecord = { at: o.at, kinds: [...o.kinds], listened: o.listened }
  if (o.listened && o.captionsSig) rec.captionsSig = o.captionsSig
  const r = o.result
  if (r) {
    rec.reader = r.reader
    if (r.failedReads > 0) rec.failed = r.failedReads
    if (r.stopped) {
      rec.stopped = true
      if (r.readTo !== null && Number.isFinite(r.readTo)) rec.readTo = r.readTo
    }
    if (r.thinSpans) rec.thin = r.thinSpans
  }
  if (o.saidIds.length) rec.saidIds = o.saidIds.slice(0, 2000)
  return rec
}

/** The time Find read to, as the editor shows a time (the video's): its readTo, or the recording's end. */
export function readToTime(project: Pick<Project, 'clips' | 'freezes' | 'duration' | 'privacy'>): string {
  const r = project.privacy?.find
  const at = r?.readTo ?? project.duration
  return rowTimes([{ start: at }], project.clips, planOf(project))[0]
}

/** The lines of the export note (§2.12), as counts and flags; none applies to a project hiding nothing when the reader is not downloaded. */
export interface ExportNoteLines {
  /** Private items hidden (`hides`), and how many still wait (`toCheck`). */
  hides: number
  toCheck: number
  /** Blur and pixelate shapes (`weak`). */
  weak: number
  /** The reader is downloaded and Find never read this video's screen. */
  notChecked: boolean
  /** The last Find did not finish: the time it read to. */
  unfinished: string | null
  /** Minutes read less often (null: none). */
  thinned: number | null
  saidRemoved: number
  captionsChanged: boolean
}

export function exportNoteLines(project: Project, readerReady: boolean): ExportNoteLines {
  const items = privateItems(project)
  const r = project.privacy?.find
  return {
    hides: items.items,
    toCheck: items.waiting,
    weak: items.weak,
    notChecked: readerReady && !r?.reader,
    unfinished: unfinished(r) ? readToTime(project) : null,
    thinned: r?.thin ? thinMinutes(r.thin) : null,
    saidRemoved: saidRemoved(project),
    captionsChanged: captionsChanged(project)
  }
}

/** Whether any line of the export note applies. */
export const anyExportLine = (l: ExportNoteLines): boolean =>
  l.hides > 0 || l.weak > 0 || l.notChecked || l.unfinished !== null || l.thinned !== null || l.saidRemoved > 0 || l.captionsChanged

/** What a run ended with, for its result line (§2.6). */
export type FindOutcome =
  | { ok: true; found: number; check: number; said: number; failedReads: number; thinned: number | null; suppressed: number; saidFull: boolean; stopped: boolean; crashed: boolean; notFollowed?: number }
  | { ok: false; reason: 'reader' | 'busy' | 'tooLarge' | 'helper' | 'video' | 'crashed' | 'failed' }

/**
 * A run's outcome (§2.6) from the project before and after its results landed: the private items it
 * added (one a group of new covers, one a said text), how many of them are Check ones, those said
 * aloud, and what the run's result says.
 */
export function outcomeOf(before: Pick<Project, 'covers'>, after: Pick<Project, 'covers'>, said: readonly Bleep[], o: { result: Extract<FindResult, { ok: true }> | null; unplaced: number; suppressed: number }): Extract<FindOutcome, { ok: true }> {
  const had = new Set((before.covers ?? []).map((c) => c.id))
  const groups = new Map<string, boolean>()
  let lone = 0
  let loneCheck = 0
  for (const c of after.covers ?? ([] as Cover[])) {
    if (had.has(c.id) || !c.found) continue
    if (!c.group) {
      lone++
      if (c.found === 'check') loneCheck++
      continue
    }
    groups.set(c.group, (groups.get(c.group) ?? false) || c.found === 'check')
  }
  const saidGroups = new Set(said.filter(isPrivateBleep).map((b) => privateGroupOf(b) ?? b.id))
  const r = o.result
  return {
    ok: true,
    found: groups.size + lone + saidGroups.size,
    check: [...groups.values()].filter(Boolean).length + loneCheck,
    said: saidGroups.size,
    failedReads: r?.failedReads ?? 0,
    notFollowed: r?.notFollowed ?? 0,
    thinned: r?.thinSpans ? thinMinutes(r.thinSpans) : null,
    suppressed: o.suppressed,
    saidFull: o.unplaced > 0,
    stopped: !!r?.stopped,
    crashed: !!r?.crashed
  }
}

/**
 * *Bring them over* (§2.12, §5.10): what the copy's original has that this copy lacks, added as
 * suggestions (the covers waiting for review, the private bleeps automatic), in one update; the
 * project itself when nothing is missing.
 */
export function withOriginCovers(project: Project, origin: OriginCovers, random: () => number): Project {
  const made = foundCovers({ found: origin.covers }, { width: project.width, height: project.height }, random)
  const used = new Set((project.covers ?? []).map((c) => c.id))
  for (const c of made) {
    while (used.has(c.id)) c.id = newCoverId(random)
    used.add(c.id)
  }
  const have = new Set((project.bleeps ?? []).map((b) => b.id))
  const bleeps: Bleep[] = origin.bleeps.filter((b) => isPrivateBleep(b) && !have.has(b.id)).map((b) => ({ ...b, auto: true as const }))
  if (!made.length && !bleeps.length) return project
  const out: Project = { ...project }
  if (made.length) out.covers = limitCovers([...(project.covers ?? []), ...made])
  if (bleeps.length) out.bleeps = [...(project.bleeps ?? []), ...bleeps]
  return out
}
