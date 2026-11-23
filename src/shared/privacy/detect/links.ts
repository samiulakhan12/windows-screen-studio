/**
 * Secrets in links (docs/design/auto-blur.md §6.5), on the URL view; the cover is the secret part
 * only: Slack, Discord, Teams and Google Chat webhook paths (0.98), the password of
 * `scheme://user:pw@host` (0.97), a DSN key (0.90), secret query and fragment parameters (0.92),
 * reset, invite, magic and share path tokens (0.90). Their kind is 'link'. CLI secret flags (0.85,
 * kind 'key'): `-p` only on a `mysql`, `psql`, `login`, … line, never `tsc -p` or `docker -p`. Pure.
 */
import type { CleanLine } from './clean'
import { entropy } from './labels'
import { lineHit, type Hit, type LineContext } from './score'
import { CLI_SECRET_FLAG, CODE_EXPR, FLAG_NOT_SECRET, ISO_DATE, LINK_RULES, P_FLAG, P_FLAG_COMMANDS, PARAM_PLACEHOLDER, PLACEHOLDER, SECRET_PARAM, WEAK_PARAMS } from './tables'

/** Link secrets and CLI secret flags on a line. */
export function findLinks(line: CleanLine, ctx: LineContext): Hit[] {
  const out: Hit[] = []
  const u = line.url
  const linkish = /[/@?#=]/.test(u)
  if (linkish) {
    for (const r of LINK_RULES) {
      for (const m of u.matchAll(r.pattern)) {
        const v = m[1]
        if (r.id === 'url-userinfo' && PLACEHOLDER.test(v)) continue
        const s = m.index! + m[0].lastIndexOf(v)
        out.push(lineHit(ctx, 'link', r.id, s, s + v.length, r.score))
      }
    }
    for (const m of u.matchAll(SECRET_PARAM)) {
      const name = m[1].toLowerCase()
      const v = m[2]
      if (PARAM_PLACEHOLDER.test(v)) continue
      if (WEAK_PARAMS.has(name) && v.length < 16 && !/\d/.test(v)) continue
      if (ISO_DATE.test(v)) continue
      const s = m.index! + m[0].length - v.length
      out.push(lineHit(ctx, 'link', 'url-param:' + name, s, s + v.length, 0.92))
    }
  }
  if (line.text.includes('-')) {
    for (const m of line.text.matchAll(CLI_SECRET_FLAG)) {
      const v = m[1]
      if (FLAG_NOT_SECRET.test(v) || entropy(v) < 3 || CODE_EXPR.test(v)) continue
      if (P_FLAG.test(m[0]) && !P_FLAG_COMMANDS.test(line.text)) continue
      const s = m.index! + m[0].lastIndexOf(v)
      out.push(lineHit(ctx, 'key', 'cli-secret-flag', s, s + v.length, 0.85))
    }
  }
  return out
}
