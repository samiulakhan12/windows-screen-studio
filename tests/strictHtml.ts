/**
 * A strict reader of the HTML the guide writes (tests 24–26): it accepts only well-formed markup
 * (every tag closed or self-closed, attributes double-quoted, `&` only in a reference, `<` only
 * starting a tag), keeps `script` and `style` as raw text, and throws on anything else. A string that
 * broke out of its place in the page would make it throw or show up as an element or attribute.
 */

export interface Element {
  name: string
  attrs: Record<string, string>
  children: Node[]
}
export type Node = Element | string

const VOID = new Set(['meta', 'img', 'br', 'hr', 'input', 'link', 'source', 'wbr'])
const RAW = new Set(['script', 'style'])
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(text: string, where: string): string {
  return text.replace(/&([^;\s]*);?/g, (all, ref: string) => {
    if (!all.endsWith(';')) throw new Error(`bare & in ${where}: ${JSON.stringify(text.slice(0, 80))}`)
    if (ref in NAMED) return NAMED[ref]
    const m = /^#(x[0-9a-f]+|[0-9]+)$/i.exec(ref)
    if (!m) throw new Error(`unknown reference &${ref}; in ${where}`)
    const code = m[1][0].toLowerCase() === 'x' ? parseInt(m[1].slice(1), 16) : parseInt(m[1], 10)
    return String.fromCodePoint(code)
  })
}

/** The document's tree under a root element named '#root'. */
export function parseStrict(html: string): Element {
  const root: Element = { name: '#root', attrs: {}, children: [] }
  const stack: Element[] = [root]
  let i = 0
  const top = (): Element => stack[stack.length - 1]
  if (html.startsWith('<!DOCTYPE html>')) i = '<!DOCTYPE html>'.length
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    const textEnd = lt < 0 ? html.length : lt
    if (textEnd > i) {
      top().children.push(decode(html.slice(i, textEnd), top().name))
    }
    if (lt < 0) break
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      if (end < 0) throw new Error('unclosed comment')
      i = end + 3
      continue
    }
    if (html.startsWith('</', lt)) {
      const m = /^<\/([a-z][a-z0-9-]*)\s*>/i.exec(html.slice(lt))
      if (!m) throw new Error(`bad end tag at ${lt}: ${html.slice(lt, lt + 40)}`)
      const open = stack.pop()
      if (!open || open.name !== m[1].toLowerCase()) throw new Error(`</${m[1]}> closes <${open?.name}>`)
      i = lt + m[0].length
      continue
    }
    const m = /^<([a-z][a-z0-9-]*)((?:\s+[a-z][a-z0-9:-]*="[^"<]*")*)\s*(\/?)>/i.exec(html.slice(lt))
    if (!m) throw new Error(`bad tag at ${lt}: ${JSON.stringify(html.slice(lt, lt + 60))}`)
    const name = m[1].toLowerCase()
    const attrs: Record<string, string> = {}
    for (const a of m[2].matchAll(/([a-z][a-z0-9:-]*)="([^"<]*)"/gi)) {
      const key = a[1].toLowerCase()
      if (key in attrs) throw new Error(`repeated attribute ${key}`)
      attrs[key] = decode(a[2], `${name}@${key}`)
    }
    const el: Element = { name, attrs, children: [] }
    top().children.push(el)
    i = lt + m[0].length
    if (m[3]) continue
    if (VOID.has(name)) throw new Error(`<${name}> is not closed`)
    if (RAW.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}>`, i)
      if (end < 0) throw new Error(`unclosed <${name}>`)
      el.children.push(html.slice(i, end))
      i = end + name.length + 3
      continue
    }
    stack.push(el)
  }
  if (stack.length !== 1) throw new Error(`unclosed <${top().name}>`)
  return root
}

/** Every element under `el`, in document order. */
export function elements(el: Element): Element[] {
  const out: Element[] = []
  const walk = (e: Element): void => {
    for (const c of e.children)
      if (typeof c !== 'string') {
        out.push(c)
        walk(c)
      }
  }
  walk(el)
  return out
}

/** The text of `el`, its descendants' text joined. */
export function textOf(el: Element): string {
  return el.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('')
}

/** Whether `el` has `cls` among its classes. */
export const hasClass = (el: Element, cls: string): boolean => (el.attrs.class ?? '').split(/\s+/).includes(cls)
