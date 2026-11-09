/**
 * The GBNF grammar AI on this PC answers under (docs/design/smart-tools.md §9.6), made from a task's
 * JSON schema. The schemas use only objects with every property required, arrays, strings,
 * numbers and integers (transcriptText.ts), so the grammar is exact: the answer starts with `{`
 * (the model cannot think aloud or chat), keys come in the schema's order, and nothing else is
 * allowed. Strings are JSON strings; a `{0,n}` repetition bounds them only for caps of 100
 * characters or fewer (names, titles), because a bounded repetition expands into n nested optional
 * rules in llama.cpp and slows the sampler. Longer strings are bounded by the answer's room
 * (maxTokens) and the validators, which still check every answer.
 */

type Schema = Record<string, unknown>

/** Strings bounded by a repetition only up to this cap. */
export const STRING_BOUND_MAX = 100

const isObject = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A GBNF string literal of `s`. */
const literal = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`

/**
 * The grammar of `schema`'s answers. `caps.string`: the longest string (a `{0,n}` bound when it is
 * 100 or fewer); `caps.minItems`: the fewest items of the arrays under these property names (the
 * names and chapters of an answer need one: an empty list satisfied the schema in the research).
 */
export function schemaGrammar(schema: Record<string, unknown>, caps: { string?: number; minItems?: Readonly<Record<string, number>> } = {}): string {
  const rules = new Map<string, string>()
  const byBody = new Map<string, string>()
  let next = 0
  /** A rule for `body`, shared by identical bodies. */
  const rule = (body: string, hint: string): string => {
    const known = byBody.get(body)
    if (known) return known
    const name = `${hint.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'r'}-${next++}`
    rules.set(name, body)
    byBody.set(body, name)
    return name
  }
  const bound = caps.string !== undefined && Number.isInteger(caps.string) && caps.string >= 0 && caps.string <= STRING_BOUND_MAX ? caps.string : null

  const value = (s: unknown, name: string): string => {
    if (!isObject(s)) throw new Error(`The schema of ${name} is not an object.`)
    switch (s.type) {
      case 'string':
        return bound === null ? 'string' : 'string-bounded'
      case 'integer':
        return 'integer'
      case 'number':
        return 'number'
      case 'boolean':
        return 'boolean'
      case 'array': {
        const item = value(s.items, `${name} item`)
        const min = Math.max(0, Math.floor(caps.minItems?.[name] ?? 0))
        const tail = `( "," ws ${item} )*`
        const body = min === 0 ? `"[" ws ( ${item} ws ${tail} )? ws "]"` : `"[" ws ${Array.from({ length: min }, () => item).join(' ws "," ws ')} ws ${tail} ws "]"`
        return rule(body, name)
      }
      case 'object': {
        const props = isObject(s.properties) ? s.properties : {}
        const keys = Object.keys(props)
        const required = Array.isArray(s.required) ? s.required : []
        if (keys.some((k) => !required.includes(k))) throw new Error(`Every property of ${name} must be required.`)
        if (!keys.length) return rule('"{" ws "}"', name)
        const members = keys.map((k) => `${literal(JSON.stringify(k))} ws ":" ws ${value(props[k], k)}`)
        return rule(`"{" ws ${members.join(' ws "," ws ')} ws "}"`, name)
      }
      default:
        throw new Error(`The schema of ${name} has a type the grammar cannot express.`)
    }
  }

  if (!isObject(schema) || schema.type !== 'object') throw new Error('The answer must be an object.')
  const top = value(schema, 'answer')
  const lines = [`root ::= ${top}`]
  for (const [name, body] of rules) lines.push(`${name} ::= ${body}`)
  lines.push(
    // JSON whitespace, short: a model cannot fill the answer's room with it.
    'ws ::= | " " | "\\n" [ \\t]{0,8}',
    // A JSON string: any character but a quote, a backslash or a control character, or an escape.
    'char ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" ( ["\\\\/bfnrt] | "u" [0-9a-fA-F]{4} )',
    'string ::= "\\"" char* "\\""',
    ...(bound !== null ? [`string-bounded ::= "\\"" char{0,${bound}} "\\""`] : []),
    'integer ::= "-"? ( "0" | [1-9] [0-9]{0,15} )',
    'number ::= integer ( "." [0-9]{1,15} )?',
    'boolean ::= "true" | "false"'
  )
  return `${lines.join('\n')}\n`
}

/** The fewest items of the arrays every 'names' and 'chapters' answer must hold (§9.6). */
export const MIN_ITEMS: Readonly<Record<string, number>> = Object.freeze({ names: 1, chapters: 1 })
