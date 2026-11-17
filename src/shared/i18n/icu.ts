/**
 * ICU MessageFormat, the subset Flown's messages use (docs/design/output-and-languages.md §9.3):
 * simple arguments `{name}`, `{count, plural, =0 {…} one {…} other {…}}`, `{kind, select, a {…}
 * other {…}}`, the rich tags `<kbd>`, `<b>`, `<em>` and `<link>`, and ICU's apostrophe quoting
 * (`''` is one apostrophe; `'{`, `'}`, `'<` and, in a plural, `'#` start a quoted literal). `#` in a
 * plural and `{x, number}` are understood as ICU does, although the checker refuses them in Flown's
 * own messages. Pure: no locale data of its own, only Intl.
 *
 * Written here because intl-messageformat could not be added to this checkout's dependencies; it
 * parses the same syntax, so either can format the catalogues.
 */

export type IcuNode =
  | { kind: 'text'; value: string }
  | { kind: 'arg'; name: string; format?: 'number' }
  | { kind: 'pound' }
  | { kind: 'plural'; name: string; offset: number; options: Record<string, IcuNode[]> }
  | { kind: 'select'; name: string; options: Record<string, IcuNode[]> }
  | { kind: 'tag'; name: string; children: IcuNode[] }

/** Tags a message may hold (RichTag of t.ts). */
export const RICH_TAGS: readonly string[] = ['kbd', 'b', 'em', 'link']

export class IcuSyntaxError extends Error {
  constructor(message: string, readonly source: string) {
    super(`${message} in message "${source}"`)
  }
}

/** Parses `source` into its nodes; throws IcuSyntaxError on anything outside the subset. */
export function parseIcu(source: string): IcuNode[] {
  let i = 0
  const fail = (why: string): never => {
    throw new IcuSyntaxError(`${why} at ${i}`, source)
  }

  /** Nodes until `}` (inside an option), `</` (inside a tag) or the end. */
  function nodes(inPlural: boolean, closingTag: string | null): IcuNode[] {
    const out: IcuNode[] = []
    let text = ''
    const flush = (): void => {
      if (text) out.push({ kind: 'text', value: text })
      text = ''
    }
    while (i < source.length) {
      const c = source[i]
      if (c === "'") {
        const next = source[i + 1]
        if (next === "'") {
          text += "'"
          i += 2
          continue
        }
        if (next === '{' || next === '}' || next === '<' || (inPlural && next === '#')) {
          // A quoted literal up to the next lone apostrophe ('' inside it is one apostrophe).
          i++
          while (i < source.length) {
            if (source[i] === "'") {
              if (source[i + 1] === "'") {
                text += "'"
                i += 2
                continue
              }
              i++
              break
            }
            text += source[i++]
          }
          continue
        }
        text += "'"
        i++
        continue
      }
      if (c === '}') {
        if (closingTag !== null) fail('unexpected }')
        break
      }
      if (c === '{') {
        flush()
        out.push(argument())
        continue
      }
      if (c === '#' && inPlural) {
        flush()
        out.push({ kind: 'pound' })
        i++
        continue
      }
      if (c === '<') {
        const close = /^<\/([a-z]+)>/.exec(source.slice(i))
        if (close) {
          if (close[1] !== closingTag) fail(`unexpected </${close[1]}>`)
          break
        }
        const open = /^<([a-z]+)>/.exec(source.slice(i))
        if (open) {
          if (!RICH_TAGS.includes(open[1])) fail(`unknown tag <${open[1]}>`)
          flush()
          i += open[0].length
          const children = nodes(inPlural, open[1])
          const end = `</${open[1]}>`
          if (!source.startsWith(end, i)) fail(`missing ${end}`)
          i += end.length
          out.push({ kind: 'tag', name: open[1], children })
          continue
        }
      }
      text += c
      i++
    }
    flush()
    return out
  }

  const space = (): void => {
    while (i < source.length && /\s/.test(source[i])) i++
  }
  const word = (): string => {
    space()
    const m = /^[^\s{},#<>'=]+/.exec(source.slice(i)) ?? /^=-?\d+/.exec(source.slice(i))
    if (!m) fail('expected a name')
    i += m![0].length
    return m![0]
  }

  function argument(): IcuNode {
    i++ // {
    const name = word()
    space()
    if (source[i] === '}') {
      i++
      return { kind: 'arg', name }
    }
    if (source[i] !== ',') fail('expected , or }')
    i++
    const type = word()
    space()
    if (type === 'number') {
      if (source[i] !== '}') fail('number arguments take no style here')
      i++
      return { kind: 'arg', name, format: 'number' }
    }
    if (type !== 'plural' && type !== 'select') fail(`unsupported argument type ${type}`)
    if (source[i] !== ',') fail('expected ,')
    i++
    let offset = 0
    const options: Record<string, IcuNode[]> = Object.create(null)
    for (;;) {
      space()
      if (source[i] === '}') {
        i++
        break
      }
      if (type === 'plural' && source.startsWith('offset:', i)) {
        i += 'offset:'.length
        space()
        const m = /^\d+/.exec(source.slice(i))
        if (!m) fail('expected an offset')
        offset = Number(m![0])
        i += m![0].length
        continue
      }
      const key = word()
      space()
      if (source[i] !== '{') fail(`expected { after ${key}`)
      i++
      options[key] = nodes(type === 'plural', null)
      if (source[i] !== '}') fail('expected }')
      i++
    }
    if (!options.other) fail(`${type} without other`)
    return type === 'plural' ? { kind: 'plural', name, offset, options } : { kind: 'select', name, options }
  }

  const out = nodes(false, null)
  if (i < source.length) fail('unexpected }')
  return out
}

/** How a message is formatted: its locale's plural rules and number format. */
export interface IcuContext {
  /** The UI language, for plural categories. */
  language: string
  /** The format locale, for `#` and `{x, number}`. */
  formatLocale: string
}

/** A tag's content handed to the caller's function, which returns what stands for it. */
export type TagFn<T> = (chunks: (string | T)[]) => T

const pluralRules = new Map<string, Intl.PluralRules>()
const rulesFor = (language: string): Intl.PluralRules => {
  let r = pluralRules.get(language)
  if (!r) {
    r = new Intl.PluralRules(language)
    pluralRules.set(language, r)
  }
  return r
}

/**
 * Formats parsed `nodes` with `values` into parts: strings, and what the caller's tag functions and
 * non-string values give. A missing value throws (as intl-messageformat does); a tag without a
 * function keeps only its content.
 */
export function formatIcu<T>(nodes: readonly IcuNode[], values: Readonly<Record<string, unknown>>, ctx: IcuContext, tags: Partial<Record<string, TagFn<T>>> = {}): (string | T)[] {
  const out: (string | T)[] = []
  const push = (part: string | T): void => {
    if (typeof part === 'string' && typeof out[out.length - 1] === 'string') out[out.length - 1] += part
    else if (part !== '') out.push(part)
  }
  const value = (name: string): unknown => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) throw new Error(`The message needs a value for {${name}}`)
    return values[name]
  }
  const walk = (list: readonly IcuNode[], pound: number | null): void => {
    for (const n of list) {
      switch (n.kind) {
        case 'text':
          push(n.value)
          break
        case 'pound':
          push(pound === null ? '#' : new Intl.NumberFormat(ctx.formatLocale).format(pound))
          break
        case 'arg': {
          const v = value(n.name)
          if (n.format === 'number') push(new Intl.NumberFormat(ctx.formatLocale).format(Number(v)))
          else push(typeof v === 'string' || typeof v === 'number' ? String(v) : (v as T))
          break
        }
        case 'plural': {
          const v = Number(value(n.name))
          const exact = n.options[`=${v}`]
          const branch = exact ?? n.options[rulesFor(ctx.language).select(v - n.offset)] ?? n.options.other
          walk(branch, v - n.offset)
          break
        }
        case 'select': {
          const v = String(value(n.name))
          walk(Object.prototype.hasOwnProperty.call(n.options, v) ? n.options[v] : n.options.other, pound)
          break
        }
        case 'tag': {
          const fn = tags[n.name]
          if (!fn) {
            walk(n.children, pound)
            break
          }
          const inner = formatIcu(n.children, values, ctx, tags)
          push(fn(inner))
          break
        }
      }
    }
  }
  walk(nodes, null)
  return out
}

/** The names a message picks a branch by (plural and select): their values must stay plain strings and numbers. */
export function selectorsOf(nodes: readonly IcuNode[]): Set<string> {
  const names = new Set<string>()
  const walk = (list: readonly IcuNode[]): void => {
    for (const n of list) {
      if (n.kind === 'plural' || n.kind === 'select') {
        names.add(n.name)
        for (const o of Object.values(n.options)) walk(o)
      } else if (n.kind === 'tag') walk(n.children)
    }
  }
  walk(nodes)
  return names
}

/** The argument names a message uses (plural and select names included), for the checks. */
export function argumentsOf(nodes: readonly IcuNode[]): Set<string> {
  const names = new Set<string>()
  const walk = (list: readonly IcuNode[]): void => {
    for (const n of list) {
      if (n.kind === 'arg') names.add(n.name)
      else if (n.kind === 'plural' || n.kind === 'select') {
        names.add(n.name)
        for (const o of Object.values(n.options)) walk(o)
      } else if (n.kind === 'tag') walk(n.children)
    }
  }
  walk(nodes)
  return names
}
