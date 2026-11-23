/**
 * QR codes (docs/design/auto-blur.md §6.9): main classes the payload the helper decoded and forgets
 * it. Secret: authenticator setup and export links, Wi-Fi with a password, a strong key or a secret
 * link parameter inside, login and pairing links (0.99); personal: contact cards, mail, phone, SMS
 * and places (0.90); any other payload (0.60); three finder patterns and no decode (0.60). Pure.
 */
import { cleanLine } from './clean'
import { strongHits } from './keys'
import { lineWindows } from './windows'
import { LINK_RULES, QR_PERSONAL, QR_SECRET, SECRET_PARAM, WIFI_PASSWORD } from './tables'

export type QrClass = 'secret' | 'personal' | 'other' | 'undecoded'

/** Longest payload looked at (the helper drops longer ones, §10.3). */
const MAX_PAYLOAD = 4096

/** Whether a payload holds a strong key or a secret link part (on its prefix and URL views, read in windows). */
function holdsSecret(payload: string): boolean {
  for (const w of lineWindows(payload.slice(0, MAX_PAYLOAD))) {
    const c = cleanLine(w.text)
    if (strongHits(c.prefix).length) return true
    for (const m of c.url.matchAll(SECRET_PARAM)) if (m[2].length >= 8) return true
    if (LINK_RULES.some((r) => c.url.search(r.pattern) >= 0)) return true
  }
  return false
}

/** The class and score of a QR code's payload; null is a code seen but not decoded. */
export function classQr(payload: string | null): { kind: 'qr'; score: number; class: QrClass } {
  if (payload === null || typeof payload !== 'string') return { kind: 'qr', score: 0.6, class: 'undecoded' }
  const p = payload.slice(0, MAX_PAYLOAD)
  if (QR_SECRET.test(p) || (/^WIFI:/i.test(p) && WIFI_PASSWORD.test(p)) || holdsSecret(p)) return { kind: 'qr', score: 0.99, class: 'secret' }
  if (QR_PERSONAL.test(p)) return { kind: 'qr', score: 0.9, class: 'personal' }
  return { kind: 'qr', score: 0.6, class: 'other' }
}
