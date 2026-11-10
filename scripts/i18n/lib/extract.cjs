'use strict'
/**
 * The extraction codemod (docs/design/output-and-languages.md §10.2, §10.3). For the files it is
 * given it proposes, without changing any file:
 *
 * - JSX text (as React renders it: the text is taken from TypeScript's react-jsx output, so its
 *   whitespace and entities are React's), the text attributes, and literals handed to UI sinks, each
 *   replaced by t('<ns>.<component>.<slug>');
 * - templates as messages with named placeholders (`Rename ${project.name}` → "Rename {name}",
 *   given String(project.name) so the text is exactly the template's);
 * - `n === 1 ? 'x' : 'xs'` and its variants as ICU plurals on `count` with an exact `=1` branch, so
 *   English chooses exactly as the condition did;
 * - for each message a meta entry and a log row { key, file, line, english, sample }: the literal it
 *   replaced and the values that reproduce it (for plurals the counts 0, 1, 2 and 1000), which test
 *   69 formats back.
 *
 * What it cannot make identical (text made when a module loads, sentences joined with +, templates
 * with text inside their placeholders) is left as it was and listed for a hand edit.
 */
const path = require('node:path')
const ts = require('typescript')
const scan = require('./scan.cjs')
const { printIcu } = require('./pseudo.cjs')

/** The text React renders for one JSX text node, from TypeScript's own react-jsx transform. */
function jsxRenderedText(raw) {
  const out = ts.transpileModule(`const x = <>${raw}</>`, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const m = /children: ("(?:[^"\\]|\\.)*")/.exec(out)
  return m ? JSON.parse(m[1]) : ''
}

/** camelCase of up to four words of `text`, ASCII letters and digits only. */
function slugOf(text) {
  const words = (text.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').match(/[A-Za-z0-9]+/g) ?? []).slice(0, 4)
  if (!words.length) return 'text'
  const slug = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('')
  return /^[0-9]/.test(slug) ? `n${slug}` : slug
}

/** The component part of a key: the file's name in camelCase ("ExportDialog.tsx" → "exportDialog"). */
function componentOf(file) {
  const base = path.basename(file).replace(/\.(tsx?|jsx?)$/, '')
  const clean = base.replace(/[^A-Za-z0-9]+(.)/g, (_, c) => c.toUpperCase())
  return clean[0].toLowerCase() + clean.slice(1)
}

/** A placeholder name for a template's expression. */
function placeholderName(expr) {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  if (ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) return placeholderName(expr.expression)
  return 'value'
}

/** `subject === 1 ? one : other` and its variants, or null. */
function pluralOf(expr) {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression
  if (!ts.isConditionalExpression(expr)) return null
  const c = expr.condition
  if (!ts.isBinaryExpression(c)) return null
  const op = c.operatorToken.kind
  const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken
  const ne = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken
  if (!eq && !ne) return null
  const isOne = (e) => ts.isNumericLiteral(e) && e.text === '1'
  const subject = isOne(c.right) ? c.left : isOne(c.left) ? c.right : null
  if (!subject) return null
  const lit = (e) => {
    while (ts.isParenthesizedExpression(e)) e = e.expression
    return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : null
  }
  const a = lit(expr.whenTrue)
  const b = lit(expr.whenFalse)
  if (a === null || b === null) return null
  return { subject, one: eq ? a : b, other: eq ? b : a }
}

const PLURAL_SAMPLES = [0, 1, 2, 1000]

/**
 * The proposal for one file: `edits` (start, end, replacement), the `messages`, `meta` and `log` it
 * adds, and `manual`, what a person must edit by hand. `taken` holds keys already used (English and
 * earlier files) and is updated.
 */
function extractSource({ file, text, ns, taken = new Set(), english = {} }) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const component = componentOf(file)
  const edits = []
  const messages = {}
  const meta = {}
  const log = []
  const manual = []
  const byText = new Map()
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const hand = (node, reason) => manual.push({ file, line: lineOf(node), text: node.getText(sf).slice(0, 120), reason })

  /** A key for `message`, named from its words (`words`): the same message in this component reuses its key. */
  const keyFor = (message, node, where, words) => {
    const known = byText.get(message)
    if (known) return known
    const base = `${ns}.${component}.${slugOf(words)}`
    let key = base
    if (english[key] === message) {
      byText.set(message, key)
      return key
    }
    for (let i = 2; taken.has(key) || key in messages; i++) key = `${base}${i}`
    taken.add(key)
    byText.set(message, key)
    messages[key] = message
    meta[key] = { description: `${component}, ${where} (${file}:${lineOf(node)}).` }
    return key
  }
  const call = (key, values) => {
    const entries = Object.entries(values)
    return entries.length ? `t('${key}', { ${entries.map(([k, v]) => (k === v ? k : `${k}: ${v}`)).join(', ')} })` : `t('${key}')`
  }
  const addLog = (key, node, english, sample) => log.push({ key, file, line: lineOf(node), english, sample })

  /** Replaces one text expression; `wrap` puts JSX braces around attribute values. */
  const replaceExpr = (expr, where, wrap = false) => {
    if (!expr) return
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) return replaceExpr(expr.expression, where, wrap)
    const plural = pluralOf(expr)
    if (plural) {
      if (!scan.HAS_LETTER.test(plural.one + plural.other)) return
      if (!scan.insideFunction(expr)) return hand(expr, 'made when the module loads: move it into the function that shows it, or keep a key in the table')
      const message = printIcu([{ kind: 'plural', name: 'count', offset: 0, options: { '=1': [{ kind: 'text', value: plural.one }], other: [{ kind: 'text', value: plural.other }] } }])
      const key = keyFor(message, expr, where, plural.other)
      edits.push({ start: expr.getStart(sf), end: expr.getEnd(), replacement: wrapIf(call(key, { count: plural.subject.getText(sf) }), wrap) })
      addLog(key, expr, PLURAL_SAMPLES.map((n) => (n === 1 ? plural.one : plural.other)), PLURAL_SAMPLES.map((n) => ({ count: n })))
      return
    }
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      if (!scan.HAS_LETTER.test(expr.text)) return
      if (!scan.insideFunction(expr)) return hand(expr, 'made when the module loads: move it into the function that shows it, or keep a key in the table')
      const key = keyFor(printIcu([{ kind: 'text', value: expr.text }]), expr, where, expr.text)
      edits.push({ start: expr.getStart(sf), end: expr.getEnd(), replacement: wrapIf(call(key, {}), wrap) })
      addLog(key, expr, expr.text, {})
      return
    }
    if (ts.isTemplateExpression(expr)) return replaceTemplate(expr, where, wrap)
    if (ts.isConditionalExpression(expr)) {
      replaceExpr(expr.whenTrue, where, false)
      replaceExpr(expr.whenFalse, where, false)
      return
    }
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind
      if (op === ts.SyntaxKind.PlusToken) {
        const pieces = []
        const walk = (e) => (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken ? (walk(e.left), walk(e.right)) : pieces.push(e))
        walk(expr)
        if (pieces.some((p) => (ts.isStringLiteral(p) || ts.isNoSubstitutionTemplateLiteral(p) || ts.isTemplateExpression(p)) && scan.HAS_LETTER.test(p.getText(sf)))) hand(expr, 'a sentence joined with +: write it as one message with placeholders, or a merge group with its .whole message')
        return
      }
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        replaceExpr(expr.left, where, false)
        replaceExpr(expr.right, where, false)
      } else if (op === ts.SyntaxKind.AmpersandAmpersandToken) replaceExpr(expr.right, where, false)
      return
    }
    if (ts.isIdentifier(expr)) {
      const init = scan.constValue(expr, expr.text)
      if (init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) || ts.isTemplateExpression(init)) && scan.HAS_LETTER.test(init.getText(sf))) replaceExpr(init, where, false)
    }
  }
  const wrapIf = (code, wrap) => (wrap ? `{${code}}` : code)

  /** A template as one message with placeholders (and a plural for a `x === 1 ? …` span). */
  const replaceTemplate = (expr, where, wrap) => {
    const statics = [expr.head.text, ...expr.templateSpans.map((s) => s.literal.text)]
    if (!scan.HAS_LETTER.test(statics.join(' ')) && !expr.templateSpans.some((s) => pluralOf(s.expression))) return
    if (!scan.insideFunction(expr)) return hand(expr, 'made when the module loads: move it into the function that shows it, or keep a key in the table')
    const nodes = [{ kind: 'text', value: expr.head.text }]
    const values = {}
    const sampleOf = {}
    const names = new Map()
    let plural = null
    for (const span of expr.templateSpans) {
      const p = pluralOf(span.expression)
      if (p) {
        if (plural && plural.subject.getText(sf) !== p.subject.getText(sf)) return hand(expr, 'two different plurals in one template')
        plural = p
        nodes.push({ kind: 'plural', name: 'count', offset: 0, options: { '=1': [{ kind: 'text', value: p.one }], other: [{ kind: 'text', value: p.other }] } })
      } else {
        let inner = false
        const look = (n) => {
          if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && scan.HAS_LETTER.test(n.getText(sf))) inner = true
          else ts.forEachChild(n, look)
        }
        look(span.expression)
        if (inner) return hand(expr, 'text inside a placeholder: split it into messages by hand')
        const code = span.expression.getText(sf)
        let name = names.get(code)
        if (!name) {
          const base = placeholderName(span.expression)
          name = base === 'count' ? 'n' : base
          for (let i = 2; [...names.values()].includes(name); i++) name = `${base}${i}`
          names.set(code, name)
          values[name] = `String(${code})`
          sampleOf[name] = `«${name}»`
        }
        nodes.push({ kind: 'arg', name })
      }
      nodes.push({ kind: 'text', value: span.literal.text })
    }
    const merged = nodes.filter((n) => n.kind !== 'text' || n.value !== '')
    const message = printIcu(merged)
    const key = keyFor(message, expr, where, [...statics, plural ? plural.other : ''].join(' '))
    const callValues = { ...values }
    if (plural) callValues.count = plural.subject.getText(sf)
    edits.push({ start: expr.getStart(sf), end: expr.getEnd(), replacement: wrapIf(call(key, callValues), wrap) })
    // What the template showed, from its own parts, for the log.
    const render = (count) => {
      let out = expr.head.text
      for (const span of expr.templateSpans) {
        const p = pluralOf(span.expression)
        if (p) out += count === 1 ? p.one : p.other
        else {
          const name = names.get(span.expression.getText(sf))
          // A placeholder holding the plural's subject shows the count itself.
          out += plural && span.expression.getText(sf) === plural.subject.getText(sf) ? String(count) : sampleOf[name]
        }
        out += span.literal.text
      }
      return out
    }
    const sampleFor = (count) => {
      const s = {}
      for (const [code, name] of names) s[name] = plural && code === plural.subject.getText(sf) ? String(count) : sampleOf[name]
      if (plural) s.count = count
      return s
    }
    if (plural) addLog(key, expr, PLURAL_SAMPLES.map(render), PLURAL_SAMPLES.map(sampleFor))
    else addLog(key, expr, render(0), sampleFor(0))
  }

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      // Keycaps stay as they are in every language (§14.1).
      if (!node.containsOnlyTriviaWhiteSpaces && scan.HAS_LETTER.test(node.text) && !scan.isKeycap(node)) {
        // The whole text node, its surrounding whitespace included, is what React renders from.
        const shown = jsxRenderedText(node.getFullText(sf))
        if (shown) {
          if (!scan.insideFunction(node)) hand(node, 'made when the module loads')
          else {
            const key = keyFor(printIcu([{ kind: 'text', value: shown }]), node, `text of <${tagOf(node)}>`, shown)
            edits.push({ start: node.pos, end: node.getEnd(), replacement: `{${call(key, {})}}` })
            addLog(key, node, shown, {})
          }
        }
      }
      return
    }
    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      replaceExpr(node.expression, `text of <${tagOf(node)}>`)
    } else if (ts.isJsxAttribute(node) && scan.TEXT_ATTRIBUTES.has(node.name.getText(sf)) && node.initializer) {
      const where = `the ${node.name.getText(sf)} of <${tagOf(node)}>`
      if (ts.isStringLiteral(node.initializer)) replaceExpr(node.initializer, where, true)
      else if (ts.isJsxExpression(node.initializer)) replaceExpr(node.initializer.expression, where)
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const { object, name } = scan.calleeName(node.expression)
      const sink = ts.isCallExpression(node) ? name && (scan.SINK_FUNCTIONS.has(name) || scan.DIALOG_METHODS.has(name)) : name && scan.SINK_CONSTRUCTORS.has(name) && (!object || (ts.isIdentifier(object) && object.text === 'window'))
      if (sink) for (const a of node.arguments ?? []) sinkArg(a, `a message given to ${name}`)
    }
    // JSX and sinks nested inside (a list's items, a condition's elements) have their own text.
    ts.forEachChild(node, visit)
  }
  /** A sink's argument: direct text, and the text properties of option objects. */
  const sinkArg = (a, where) => {
    if (ts.isObjectLiteralExpression(a)) {
      for (const p of a.properties) {
        if (!ts.isPropertyAssignment(p)) continue
        const pname = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null
        if (pname && scan.TEXT_PROPERTIES.has(pname)) {
          if (ts.isArrayLiteralExpression(p.initializer)) p.initializer.elements.forEach((e) => replaceExpr(e, `${where} (${pname})`))
          else replaceExpr(p.initializer, `${where} (${pname})`)
        } else if (ts.isObjectLiteralExpression(p.initializer) || ts.isArrayLiteralExpression(p.initializer)) sinkArg(p.initializer, where)
      }
      return
    }
    if (ts.isArrayLiteralExpression(a)) return a.elements.forEach((e) => sinkArg(e, where))
    replaceExpr(a, where)
  }
  const tagOf = (node) => {
    for (let p = node; p; p = p.parent) {
      if (ts.isJsxElement(p)) return p.openingElement.tagName.getText(sf)
      if (ts.isJsxSelfClosingElement(p) || ts.isJsxOpeningElement(p)) return p.tagName.getText(sf)
    }
    return 'fragment'
  }
  visit(sf)

  // One edit per place, in order.
  const seen = new Set()
  const ordered = edits.filter((e) => (seen.has(e.start) ? false : seen.add(e.start))).sort((a, b) => a.start - b.start)
  return { edits: ordered, messages, meta, log, manual, needsImport: ordered.length > 0 && !importsT(sf) }
}

/** True when the file already imports t from the runtime. */
function importsT(sf) {
  return sf.statements.some((s) => ts.isImportDeclaration(s) && /(^|\/)i18n\/t$/.test(s.moduleSpecifier.text) && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings) && s.importClause.namedBindings.elements.some((e) => e.name.text === 't'))
}

/** The file's text with the edits made and, when needed, `import { t }` after its imports. */
function applyEdits(file, text, { edits, needsImport }) {
  let out = text
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.replacement + out.slice(e.end)
  if (needsImport) {
    const rel = path.posix.relative(path.posix.dirname(file), 'src/shared/i18n/t')
    const spec = rel.startsWith('.') ? rel : `./${rel}`
    const sf = ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const imports = sf.statements.filter((s) => ts.isImportDeclaration(s))
    const at = imports.length ? imports[imports.length - 1].getEnd() : 0
    const line = `import { t } from '${spec}'`
    out = at ? `${out.slice(0, at)}\n${line}${out.slice(at)}` : `${line}\n${out}`
  }
  return out
}

/**
 * Problems of extraction log rows (test 69): each row's message, formatted with its sample values by
 * `format(key, values)`, must give the literal it replaced; a plural row has the samples 0, 1, 2 and
 * 1000, each with its own English.
 */
function logProblems(rows, format) {
  const out = []
  for (const row of rows) {
    const at = `${row.key} (${row.file}:${row.line})`
    const samples = Array.isArray(row.sample) ? row.sample : [row.sample ?? {}]
    const english = Array.isArray(row.english) ? row.english : [row.english]
    if (samples.length !== english.length) {
      out.push(`${at}: ${samples.length} sample(s) for ${english.length} English text(s)`)
      continue
    }
    if (samples.some((s) => s && 'count' in s) && samples.map((s) => s.count).join() !== PLURAL_SAMPLES.join()) out.push(`${at}: a plural needs the samples ${PLURAL_SAMPLES.join(', ')}`)
    samples.forEach((values, i) => {
      let got
      try {
        got = format(row.key, values ?? {})
      } catch (err) {
        out.push(`${at}: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      if (got !== english[i]) out.push(`${at}: gives ${JSON.stringify(got)} where the code showed ${JSON.stringify(english[i])}`)
    })
  }
  return out
}

module.exports = { PLURAL_SAMPLES, jsxRenderedText, slugOf, componentOf, pluralOf, extractSource, applyEdits, logProblems }
