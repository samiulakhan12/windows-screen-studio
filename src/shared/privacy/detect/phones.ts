/**
 * Phone numbers (docs/design/auto-blur.md §6.8): libphonenumber-js 1.13.16 and its max metadata
 * (vendored, resources/notices/38-libphonenumber-js.txt). A bare digit run is never enough: a `+` or
 * `00` number that is valid (0.92) or of a possible length and grouped (0.85); a number valid for one
 * of the user's regions with a phone label (0.92) or written in one of the region's formats (0.85); a
 * bare mobile written with its national prefix (0.60, never NANP). Dates, IPv4 addresses, times and
 * decimals are refused first; Bengali and Devanagari digits are converted before the library is
 * called (the digit view). Pure.
 */
import type { CleanLine } from './clean'
import { labelled } from './labels'
import { lineHit, taken, type Hit, type LineContext } from './score'
import { DECIMAL, LANGUAGE_REGION, NOT_PHONE_LINE, PHONE_CANDIDATE, PHONE_NOT } from './tables'
import isValidPhoneNumber from '../vendor/libphonenumber/es6/isValidPhoneNumber.js'
import parsePhoneNumber from '../vendor/libphonenumber/es6/parsePhoneNumber.js'
import metadata from '../vendor/libphonenumber/metadata.max.json.js'

/** The phone regions Find uses (§0 decision 2): the PC's region, the UI language's and up to 5 added, each once. */
export function phoneRegions(pcRegion: string | null | undefined, uiLanguage: string | null | undefined, added: readonly string[] = []): string[] {
  const out: string[] = []
  const add = (r: string | null | undefined): void => {
    if (typeof r === 'string' && /^[A-Z]{2}$/.test(r) && Object.hasOwn(metadata.countries, r) && !out.includes(r)) out.push(r)
  }
  add(pcRegion)
  add(LANGUAGE_REGION[(uiLanguage ?? '').toLowerCase().split(/[-_]/)[0]])
  for (const r of added.slice(0, 5)) add(r)
  return out
}

interface RegionFormats {
  natPrefix: string | null
  formats: { re: RegExp; lead: RegExp | null }[]
}
const formatCache = new Map<string, RegionFormats | null>()

/** A region's national prefix and number formats, from the metadata. */
function formatsOf(region: string): RegionFormats | null {
  if (formatCache.has(region)) return formatCache.get(region)!
  const e = (metadata.countries as Record<string, readonly unknown[]>)[region]
  let out: RegionFormats | null = null
  if (e) {
    const formats = (Array.isArray(e[4]) ? (e[4] as unknown[][]) : []).map((f) => {
      const leads = Array.isArray(f[2]) ? (f[2] as string[]) : []
      return { re: new RegExp('^(?:' + String(f[0]) + ')$'), lead: leads.length ? new RegExp('^(?:' + leads[leads.length - 1] + ')') : null }
    })
    out = { natPrefix: typeof e[5] === 'string' && e[5] ? e[5] : null, formats }
  }
  formatCache.set(region, out)
  return out
}

/**
 * Whether the written digit groups follow one of the region's formats for this national number (the
 * library's matcher has no grouping leniency): after the calling code's group and a national prefix
 * are taken off, the groups are the format's groups, or neighbours of them joined.
 */
export function groupsMatch(region: string, national: string, written: readonly string[], nationalForm: boolean): boolean {
  const r = formatsOf(region)
  if (!r) return false
  let g = [...written]
  if (!nationalForm) g = g.slice(1)
  if (!g.length) return false
  if (nationalForm && r.natPrefix && g[0].startsWith(r.natPrefix) && g.join('').length === national.length + r.natPrefix.length) g[0] = g[0].slice(r.natPrefix.length)
  if (g[0] === '') g = g.slice(1)
  if (g.length < 2) return false
  for (const f of r.formats) {
    if (f.lead && !f.lead.test(national)) continue
    const m = f.re.exec(national)
    if (!m) continue
    const parts = m.slice(1).map((x) => x.length)
    let i = 0
    let ok = true
    for (const w of g) {
      let n = 0
      while (i < parts.length && n < w.length) n += parts[i++]
      if (n !== w.length) {
        ok = false
        break
      }
    }
    if (ok && i === parts.length) return true
  }
  return false
}

/** Whether a string of digits is a valid phone number for one of `regions`, or internationally with its calling code (`international`). The vendored isValidPhoneNumber decides. */
export function validPhone(digits: string, regions: readonly string[], international = false): boolean {
  if (international) return isValidPhoneNumber('+' + digits, {}, metadata)
  return regions.some((r) => isValidPhoneNumber(digits, { defaultCountry: r }, metadata))
}

/** Phone numbers on a line. */
export function findPhones(line: CleanLine, ctx: LineContext): Hit[] {
  const dv = line.digit
  if (!/\d.{0,4}\d.{0,4}\d/.test(dv)) return []
  const out: Hit[] = []
  const lab = labelled(line, ctx, 'phone')
  for (const m of dv.matchAll(PHONE_CANDIDATE)) {
    const all = m[0]
    if (taken({ ...ctx, found: [...ctx.found, ...out] }, m.index!)) continue
    if (DECIMAL.test(all)) continue
    if (all.includes('.') && all.split('.').some((g, _i, a) => a.length > 1 && (g.replace(/\D/g, '').length === 1 || g.replace(/\D/g, '').length > 4))) continue
    if (PHONE_NOT.test(all.trim())) continue
    const digits = m[2].replace(/\D/g, '')
    const plus = !!m[1]
    const grouped = /[\s().-]/.test(m[2])
    const groups = m[2]
      .split(/[\s().-]+/)
      .filter(Boolean)
      .map((g) => g.replace(/\D/g, ''))
    let found: { region: string; mobile: boolean; groups: boolean; prefixed: boolean; possibleOnly?: true } | null = null
    if (plus) {
      const p = parsePhoneNumber('+' + digits, {}, metadata)
      if (p && isValidPhoneNumber('+' + digits, {}, metadata)) found = { region: p.country ?? '', mobile: p.getType() === 'MOBILE', groups: !!p.country && groupsMatch(p.country, p.nationalNumber, groups, false), prefixed: true }
      else if (p && p.isPossible()) found = { region: p.country ?? '', mobile: false, groups: false, prefixed: true, possibleOnly: true }
    } else {
      for (const region of ctx.regions) {
        if (!isValidPhoneNumber(digits, { defaultCountry: region }, metadata)) continue
        const p = parsePhoneNumber(digits, { defaultCountry: region }, metadata)
        if (!p) continue
        const f = formatsOf(region)
        const prefixed = !f?.natPrefix || digits.startsWith(f.natPrefix)
        found = { region, mobile: p.getType() === 'MOBILE', groups: groupsMatch(region, p.nationalNumber, groups, true), prefixed }
        break
      }
    }
    if (!found) continue
    let score = 0
    let rule = ''
    if (plus && found.possibleOnly) (score = grouped ? 0.85 : 0.6), (rule = 'phone-intl')
    else if (plus) (score = 0.92), (rule = 'phone-intl')
    else if (lab) (score = 0.92), (rule = 'phone-labelled')
    else if (grouped && found.groups) (score = 0.85), (rule = 'phone-grouped')
    else if (found.mobile && found.prefixed && !NOT_PHONE_LINE.test(line.text)) (score = 0.6), (rule = 'phone-bare-mobile')
    if (!score) continue
    const s = m.index! + all.indexOf(all.trim())
    out.push(lineHit(ctx, 'phone', rule, s, m.index! + all.length, score))
  }
  return out
}
