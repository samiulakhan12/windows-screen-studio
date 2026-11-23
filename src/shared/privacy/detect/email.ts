/**
 * Email addresses (docs/design/auto-blur.md §6.3): a strict pattern first, an OCR-tolerant one only
 * where the strict one found nothing; the top-level domain in Flown's IANA lists; role and reserved
 * addresses as Check. Not emails: `git@host:` remotes, `@2x.png`, `@types/node`, `user@HOST`, and a
 * link's password or DSN key before its host. Pure.
 */
import { X_COUNTRY_TLDS, X_GENERIC_TLDS } from '../../publish/tlds'
import type { CleanLine } from './clean'
import { lineHit, type Hit, type LineContext } from './score'
import { EMAIL_OCR, EMAIL_STRICT, EXAMPLE_DOMAIN, IN_AUTHORITY, ROLE_LOCAL } from './tables'

let tlds: ReadonlySet<string> | null = null
/** Flown's top-level domains (twitter-text 3.1.0's lists, src/shared/publish/tlds.ts), lower case. */
export function topLevelDomains(): ReadonlySet<string> {
  if (!tlds) {
    const set = new Set<string>()
    for (const list of [X_GENERIC_TLDS, X_COUNTRY_TLDS]) for (const t of list.split('|')) if (t) set.add(t.toLowerCase())
    tlds = set
  }
  return tlds
}

const RESERVED_TLD = /^(?:test|example|invalid|localhost)$/i

/** The email addresses of a line. */
export function findEmail(line: CleanLine, ctx: LineContext): Hit[] {
  const t = line.text
  if (!t.includes('@') && !t.includes('©') && !t.includes('®')) return []
  const out: Hit[] = []
  const matches: RegExpMatchArray[] = [...t.matchAll(EMAIL_STRICT)]
  for (const m of t.matchAll(EMAIL_OCR)) if (!matches.some((e) => m.index! < e.index! + e[0].length && e.index! < m.index! + m[0].length)) matches.push(m)
  for (const m of matches) {
    const [all, local, at, mid, tld] = m
    const domain = (mid.replace(/[\s,·]/g, '.').replace(/\.+/g, '.') + tld).toLowerCase()
    const reserved = RESERVED_TLD.test(tld) || EXAMPLE_DOMAIN.test(domain)
    if (!topLevelDomains().has(tld.toLowerCase()) && !reserved) continue
    // An SSH remote: git@host:owner/repo.
    if (/^git$/i.test(local) && t[m.index! + all.length] === ':') continue
    // A link's password or DSN key (`postgres://user:pw@host`, `https://key@host`): the link rules cover its secret part.
    if (IN_AUTHORITY.test(t.slice(Math.max(0, m.index! - 240), m.index!))) continue
    const damaged = at !== '@' || /[\s,·]/.test(mid) || /\s/.test(all)
    let score = damaged ? 0.75 : 0.95
    if (ROLE_LOCAL.test(local) || reserved) score = 0.6
    out.push(lineHit(ctx, 'email', damaged ? 'email-ocr' : 'email', m.index!, m.index! + all.length, score))
  }
  return out
}
