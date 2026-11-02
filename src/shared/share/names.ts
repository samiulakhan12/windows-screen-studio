/**
 * What each destination is called on its buttons, switches, steps and the notification's buttons
 * (F-22, docs/design/share.md §2.8): its label, and when two share a label, where each one is, so
 * every button names one place: "Google Drive (H:)", "Videos (nas)", "#team (…AbCd)". Chat
 * messages keep the label alone (no local path goes in them). Pure.
 */
import { WEBHOOK_SERVICES, type WebhookService } from './webhooks'

interface Named {
  id: string
  label: string
}

/**
 * For each item whose label another shares (any case): the first kind of place that tells all of
 * those apart, or a number when none does. Items with a label of their own get none.
 */
function placesOf<T extends Named>(items: readonly T[], kinds: readonly ((x: T) => string)[]): Map<string, string> {
  const groups = new Map<string, T[]>()
  for (const x of items) groups.set(x.label.toLowerCase(), [...(groups.get(x.label.toLowerCase()) ?? []), x])
  const out = new Map<string, string>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const kind = kinds.find((k) => {
      const places = group.map((x) => k(x).toLowerCase())
      return places.every((p) => p !== '') && new Set(places).size === group.length
    })
    group.forEach((x, i) => out.set(x.id, kind ? kind(x) : String(i + 1)))
  }
  return out
}

/** "H:" for a drive, the server of a network folder ("nas"), otherwise "". */
function driveOf(p: string): string {
  const letter = /^([A-Za-z]):/.exec(p)
  if (letter) return `${letter[1].toUpperCase()}:`
  return /^[\\/]{2}([^\\/]+)/.exec(p)?.[1] ?? ''
}

const lastParts = (p: string, n: number): string => p.split(/[\\/]+/).filter(Boolean).slice(-n).join('\\')

/** Where each folder is, for folders whose label another shares: its drive, else its last folders, else its path. */
export function folderPlaces(folders: readonly { id: string; label: string; path: string }[]): Map<string, string> {
  return placesOf(folders, [(f) => driveOf(f.path), (f) => lastParts(f.path, 1), (f) => lastParts(f.path, 2), (f) => f.path])
}

/** Which chat each is, for chats whose label another shares: its service, else the end of its webhook. */
export function hookPlaces(hooks: readonly { id: string; label: string; service: WebhookService; masked: string; readable?: boolean }[]): Map<string, string> {
  return placesOf(hooks, [(h) => WEBHOOK_SERVICES[h.service].label, (h) => (h.readable === false ? '' : `…${h.masked.slice(-4)}`)])
}

/** "Google Drive (H:)": a label, and its place when it needs one. */
export const withPlace = (label: string, place: string | undefined): string => (place ? `${label} (${place})` : label)
