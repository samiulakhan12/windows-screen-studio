/**
 * A strict XML 1.0 reader for the timeline files (tests 37, 38, 40): it accepts a document only when
 * it is well formed (one root element, every tag closed or self-closed in order, attributes quoted
 * and named once, `&` only in a predefined or character reference, `<` only starting markup) and every
 * character, written or referenced, is one XML 1.0 allows. It throws on anything else, so a name that
 * broke out of its attribute or a control character that slipped through would fail the test.
 */

export interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
}
export type XmlNode = XmlElement | string

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const NAME = /^[A-Za-z_:][A-Za-z0-9_:.-]*/

/** XML 1.0's Char production. */
function isXmlChar(code: number): boolean {
  return code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)
}

function checkChars(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1)
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw new Error(`lone surrogate at ${i}`)
      i++
      continue
    }
    if (c >= 0xdc00 && c <= 0xdfff) throw new Error(`lone surrogate at ${i}`)
    if (!isXmlChar(c)) throw new Error(`character U+${c.toString(16).padStart(4, '0')} at ${i} is not allowed in XML 1.0`)
  }
}

function decode(text: string, where: string): string {
  if (text.includes('<')) throw new Error(`< in ${where}`)
  return text.replace(/&([^;]*);?/g, (all, ref: string) => {
    if (!all.endsWith(';')) throw new Error(`bare & in ${where}`)
    if (ref in NAMED) return NAMED[ref]
    const m = /^#(x[0-9a-fA-F]+|[0-9]+)$/.exec(ref)
    if (!m) throw new Error(`unknown reference &${ref}; in ${where}`)
    const code = m[1][0] === 'x' ? parseInt(m[1].slice(1), 16) : parseInt(m[1], 10)
    if (!isXmlChar(code)) throw new Error(`reference to a character XML 1.0 forbids in ${where}`)
    return String.fromCodePoint(code)
  })
}

/** Attribute value normalisation (XML 1.0 §3.3.3, CDATA): literal whitespace becomes a space, references keep theirs. */
function attrValue(raw: string, where: string): string {
  return decode(raw.replace(/[\t\n\r]/g, ' '), where)
}

/** The document's root element; throws when the document is not well-formed XML 1.0. */
export function parseXml(doc: string): XmlElement {
  checkChars(doc)
  let i = 0
  const skipSpace = (): void => {
    while (i < doc.length && /\s/.test(doc[i])) i++
  }
  if (doc.startsWith('﻿')) i = 1
  if (doc.startsWith('<?xml', i)) {
    const end = doc.indexOf('?>', i)
    if (end < 0) throw new Error('unclosed XML declaration')
    const decl = doc.slice(i, end + 2)
    if (!/^<\?xml version="1\.0"( encoding="UTF-8")?\?>$/.test(decl)) throw new Error(`unexpected declaration ${decl}`)
    i = end + 2
  }
  skipSpace()
  const doctype = /^<!DOCTYPE [A-Za-z_][A-Za-z0-9_.-]*>/.exec(doc.slice(i))
  if (doctype) i += doctype[0].length
  skipSpace()
  const stack: XmlElement[] = []
  let root: XmlElement | null = null
  while (i < doc.length) {
    if (doc.startsWith('<!--', i)) {
      const end = doc.indexOf('-->', i + 4)
      if (end < 0) throw new Error('unclosed comment')
      i = end + 3
      continue
    }
    if (doc.startsWith('</', i)) {
      const m = NAME.exec(doc.slice(i + 2))
      if (!m) throw new Error(`bad end tag at ${i}`)
      const open = stack.pop()
      if (!open || open.name !== m[0]) throw new Error(`</${m[0]}> closes <${open?.name ?? 'nothing'}>`)
      i += 2 + m[0].length
      skipSpace()
      if (doc[i] !== '>') throw new Error(`bad end tag </${m[0]}>`)
      i++
      continue
    }
    if (doc[i] === '<') {
      if (root && stack.length === 0) throw new Error('a second root element')
      const m = NAME.exec(doc.slice(i + 1))
      if (!m) throw new Error(`bad tag at ${i}: ${JSON.stringify(doc.slice(i, i + 20))}`)
      const el: XmlElement = { name: m[0], attrs: {}, children: [] }
      i += 1 + m[0].length
      for (;;) {
        const before = i
        skipSpace()
        if (doc.startsWith('/>', i)) {
          i += 2
          break
        }
        if (doc[i] === '>') {
          i++
          stack.push(el)
          break
        }
        if (i === before) throw new Error(`attributes of <${el.name}> need a space before them`)
        const a = NAME.exec(doc.slice(i))
        if (!a) throw new Error(`bad attribute in <${el.name}>`)
        if (a[0] in el.attrs) throw new Error(`attribute ${a[0]} twice in <${el.name}>`)
        i += a[0].length
        if (doc[i] !== '=') throw new Error(`attribute ${a[0]} of <${el.name}> has no value`)
        const q = doc[i + 1]
        if (q !== '"' && q !== "'") throw new Error(`attribute ${a[0]} of <${el.name}> is not quoted`)
        const end = doc.indexOf(q, i + 2)
        if (end < 0) throw new Error(`attribute ${a[0]} of <${el.name}> is not closed`)
        el.attrs[a[0]] = attrValue(doc.slice(i + 2, end), `${el.name}@${a[0]}`)
        i = end + 1
      }
      const parent = stack[stack.length - (stack[stack.length - 1] === el ? 2 : 1)]
      if (parent) parent.children.push(el)
      else root = el
      continue
    }
    const lt = doc.indexOf('<', i)
    const end = lt < 0 ? doc.length : lt
    const text = doc.slice(i, end)
    if (stack.length === 0) {
      if (text.trim()) throw new Error('text outside the root element')
    } else {
      if (text.includes(']]>')) throw new Error(']]> in text')
      stack[stack.length - 1].children.push(decode(text, stack[stack.length - 1].name))
    }
    i = end
  }
  if (stack.length) throw new Error(`<${stack[stack.length - 1].name}> is not closed`)
  if (!root) throw new Error('no root element')
  return root
}

/** Every element named `name` under `el`, in document order. */
export function findAll(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = []
  const walk = (e: XmlElement): void => {
    for (const c of e.children) {
      if (typeof c === 'string') continue
      if (c.name === name) out.push(c)
      walk(c)
    }
  }
  walk(el)
  return out
}

/** The child elements of `el` named `name`. */
export const childrenOf = (el: XmlElement, name: string): XmlElement[] => el.children.filter((c): c is XmlElement => typeof c !== 'string' && c.name === name)

/** The text of `el`'s first child named `name` (empty when it has none). */
export function textOf(el: XmlElement, name?: string): string {
  const target = name === undefined ? el : childrenOf(el, name)[0]
  if (!target) return ''
  return target.children.filter((c): c is string => typeof c === 'string').join('')
}
