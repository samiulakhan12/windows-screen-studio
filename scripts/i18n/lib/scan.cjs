'use strict'
/**
 * The string scanner (docs/design/output-and-languages.md §16.1): every UI text in src/ must come from
 * a message key. Built on the TypeScript compiler API. It reports
 *
 * - `jsx`: JSX text with a letter in it, and string literals shown as JSX children (`{'Save'}`);
 * - `attr`: aria-label, title, placeholder, alt, aria-valuetext, aria-roledescription and label with
 *   a literal or template value (both branches of a condition included);
 * - `sink`: literals and templates handed to UI sinks: showNotice, setStatus, new Error, the dialog.show*
 *   options, new Notification, setThumbarButtons tooltips, confirm, window.confirm, alert and any
 *   `confirm` property called (the duplicate flow's `deps.confirm`). A constant of the same file
 *   passed by name counts at its declaration;
 * - `module-scope-t`: t(), tParts(), tNodes() or <T> evaluated when a module loads (§9.1);
 * - `locale`: toLocaleString / toLocaleDateString / toLocaleTimeString and Intl constructors with no
 *   locale or `undefined`, except Intl.Segmenter (§9.7);
 * - `key`: a t() or <T k> key that English does not have.
 *
 * What is not UI text lives in scripts/i18n/allow.json, each entry with its reason; the other
 * account's files are in pending.json and reported as pending, never as failures (§9.5). Files in
 * config.json's failFor fail from their first commit; the rest of the tree is a report until S4 sets
 * "scan": "fail".
 */
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const files = require('./files.cjs')

/** JSX attributes that hold UI text. */
const TEXT_ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder', 'alt', 'aria-valuetext', 'aria-roledescription', 'label'])
/** Called by name or as a method: every string argument is UI text. */
const SINK_FUNCTIONS = new Set(['showNotice', 'setStatus', 'confirm', 'alert'])
/** Electron dialog and taskbar calls whose options carry UI text. */
const DIALOG_METHODS = new Set(['showMessageBox', 'showMessageBoxSync', 'showSaveDialog', 'showSaveDialogSync', 'showOpenDialog', 'showOpenDialogSync', 'showErrorBox', 'setThumbarButtons'])
/** Option properties that hold UI text in a sink's object argument. */
const TEXT_PROPERTIES = new Set(['message', 'title', 'detail', 'label', 'buttonLabel', 'checkboxLabel', 'nameFieldLabel', 'body', 'tooltip', 'text', 'buttons', 'reason', 'subtitle'])
/** Constructors that are sinks. */
const SINK_CONSTRUCTORS = new Set(['Error', 'Notification'])
/** The runtime's text makers, by exported name. */
const T_FUNCTIONS = new Set(['t', 'tParts', 'tNodes'])
const LOCALE_METHODS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'])

const HAS_LETTER = /\p{L}/u
/** Elements whose text is a keycap, which stays as it is in every language (§14.1). */
const KEYCAP_ELEMENTS = new Set(['kbd'])

/** True for JSX text directly inside a keycap element (<kbd>Esc</kbd>). */
function isKeycap(node) {
  const el = node.parent
  return !!el && ts.isJsxElement(el) && KEYCAP_ELEMENTS.has(el.openingElement.tagName.getText())
}

/** A glob ('src/main/ai/**', '*.tsx') as a regular expression over repository-relative paths. */
function globRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}
const matchesAny = (file, globs) => (globs ?? []).some((g) => globRegExp(typeof g === 'string' ? g : g.path).test(file))

const scriptKind = (file) => (file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

/** The bindings a file gets from the i18n runtime: local names of t/tParts/tNodes, namespace imports, T. */
function runtimeBindings(sf, file) {
  const tNames = new Set()
  const tNamespaces = new Set()
  const tComponents = new Set()
  const dir = path.posix.dirname(file)
  const resolved = (spec) => (spec.startsWith('.') ? path.posix.normalize(path.posix.join(dir, spec)) : spec)
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause || st.importClause.isTypeOnly) continue
    const spec = resolved(st.moduleSpecifier.text)
    const clause = st.importClause
    if (/(^|\/)i18n\/t$/.test(spec)) {
      const nb = clause.namedBindings
      if (nb && ts.isNamespaceImport(nb)) tNamespaces.add(nb.name.text)
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (el.isTypeOnly) continue
          const imported = (el.propertyName ?? el.name).text
          if (T_FUNCTIONS.has(imported)) tNames.add(el.name.text)
        }
      }
    }
    if (/(^|\/)i18n\/T$/.test(spec)) {
      const nb = clause.namedBindings
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if ((el.propertyName ?? el.name).text === 'T') tComponents.add(el.name.text)
    }
  }
  return { tNames, tNamespaces, tComponents }
}

/** True for a node inside a function body (anything that runs later than module load). */
function insideFunction(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p) && !ts.isFunctionTypeNode(p) && !ts.isConstructorTypeNode(p)) return true
    // An instance field runs when the object is made; a static one when its class is defined.
    if (ts.isPropertyDeclaration(p) && !(ts.getCombinedModifierFlags(p) & ts.ModifierFlags.Static)) return true
  }
  return false
}

/** The nearest declaration of `name` visible at `node`: a const's initializer, or null (a parameter, let, var or nothing found). */
function constValue(node, name) {
  const fromStatements = (statements) => {
    for (const st of statements) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) {
            return { found: true, init: st.declarationList.flags & ts.NodeFlags.Const ? (d.initializer ?? null) : null }
          }
        }
      }
      if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === name) return { found: true, init: null }
    }
    return { found: false, init: null }
  }
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) {
      for (const param of p.parameters ?? []) {
        let hit = false
        const visit = (n) => {
          if (ts.isIdentifier(n) && n.text === name) hit = true
          else ts.forEachChild(n, visit)
        }
        visit(param.name)
        if (hit) return null
      }
    }
    if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)) {
      const r = fromStatements(p.statements)
      if (r.found) return r.init
    }
    if ((ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer && ts.isVariableDeclarationList(p.initializer)) {
      if (p.initializer.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)) return null
    }
    if (ts.isCatchClause(p) && p.variableDeclaration && ts.isIdentifier(p.variableDeclaration.name) && p.variableDeclaration.name.text === name) return null
  }
  return null
}

/**
 * The literals an expression shows as text: the expression itself when it is a string or template,
 * both branches of a condition, `||`, `??` and `&&` alternatives, both sides of `+`, a template's
 * spans, and (when `follow`) a constant of the same file it names. Comparisons and call arguments
 * are not text.
 */
function textLiterals(expr, follow, seen = new Set()) {
  const out = []
  const visit = (e) => {
    if (!e) return
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression?.(e) || ts.isTypeAssertionExpression(e)) return visit(e.expression)
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return out.push(e)
    if (ts.isTemplateExpression(e)) {
      out.push(e)
      for (const span of e.templateSpans) visit(span.expression)
      return
    }
    if (ts.isConditionalExpression(e)) {
      visit(e.whenTrue)
      visit(e.whenFalse)
      return
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind
      if (op === ts.SyntaxKind.PlusToken) {
        visit(e.left)
        visit(e.right)
      } else if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        visit(e.left)
        visit(e.right)
      } else if (op === ts.SyntaxKind.AmpersandAmpersandToken) visit(e.right)
      return
    }
    if (follow && ts.isIdentifier(e) && !seen.has(e.text)) {
      seen.add(e.text)
      const init = constValue(e, e.text)
      if (init) visit(init)
    }
  }
  visit(expr)
  return out
}

/** The text a literal node shows: a string's value, a template's static parts with `${…}` between. */
function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => '${…}' + s.literal.text).join('')
  return node.getText()
}

/** The static text of a literal without its placeholders, for the letter test. */
function staticText(node) {
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => s.literal.text).join(' ')
  return literalText(node)
}

/** Literals in a sink argument: text positions, option objects' text properties, arrays, constants of the same file. */
function sinkLiterals(arg) {
  const out = []
  const seen = new Set()
  const takeText = (e) => {
    if (ts.isArrayLiteralExpression(e)) for (const el of e.elements) takeText(el)
    else out.push(...textLiterals(e, true))
  }
  const visit = (e, ctx) => {
    if (!e) return
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return visit(e.expression, ctx)
    if (ts.isIdentifier(e) && !seen.has(e.text)) {
      seen.add(e.text)
      const init = constValue(e, e.text)
      if (init && (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init))) return visit(init, ctx)
    }
    if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        if (!ts.isPropertyAssignment(p)) continue
        const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null
        if (!name) continue
        if (TEXT_PROPERTIES.has(name) || (ctx === 'filters' && name === 'name')) takeText(p.initializer)
        else visit(p.initializer, name)
      }
      return
    }
    if (ts.isArrayLiteralExpression(e)) {
      for (const el of e.elements) visit(el, ctx)
      return
    }
    // A direct argument is text; anything under an option that is not a text property is not.
    if (ctx === null) takeText(e)
  }
  visit(arg, null)
  return out
}

const calleeName = (expr) => {
  if (ts.isIdentifier(expr)) return { object: null, name: expr.text }
  if (ts.isPropertyAccessExpression(expr)) return { object: expr.expression, name: expr.name.text }
  return { object: null, name: null }
}

const isUndefined = (e) => !!e && ((ts.isIdentifier(e) && e.text === 'undefined') || ts.isVoidExpression(e))

/**
 * The findings in one source file. `rules.keys` (a Set of full English keys) turns on the `key`
 * rule; `rules.allow` drops what allow.json lists by text or by site.
 */
function scanSource(file, text, rules = {}) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
  const { tNames, tNamespaces, tComponents } = runtimeBindings(sf, file)
  const findings = []
  const seen = new Set()
  const add = (node, kind, shown) => {
    const at = node.getStart(sf)
    const line = sf.getLineAndCharacterOfPosition(at).line + 1
    const id = `${line}\u0000${kind}\u0000${shown}`
    if (seen.has(id)) return
    seen.add(id)
    findings.push({ at, finding: { file, line, kind, text: shown } })
  }
  const addText = (nodes, kind) => {
    for (const n of nodes) if (HAS_LETTER.test(staticText(n))) add(n, kind, literalText(n))
  }
  const isTCall = (call) => {
    const c = call.expression
    if (ts.isIdentifier(c)) return tNames.has(c.text)
    return ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && tNamespaces.has(c.expression.text) && T_FUNCTIONS.has(c.name.text)
  }
  const checkKey = (node, keyExpr) => {
    if (!rules.keys || !keyExpr) return
    for (const lit of textLiterals(keyExpr, false)) {
      if ((ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit)) && !rules.keys.has(lit.text)) add(lit, 'key', lit.text)
    }
  }

  const visit = (node) => {
    // JSX text and text children.
    if (ts.isJsxText(node)) {
      if (!node.containsOnlyTriviaWhiteSpaces && HAS_LETTER.test(node.text) && !isKeycap(node)) add(node, 'jsx', node.text.replace(/\s+/g, ' ').trim())
    } else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      addText(textLiterals(node.expression, true), 'jsx')
    }
    // Text attributes.
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf)
      if (TEXT_ATTRIBUTES.has(name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) addText([node.initializer], 'attr')
        else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) addText(textLiterals(node.initializer.expression, true), 'attr')
      }
    }
    // <T k="…"> outside a function, and its key.
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ts.isIdentifier(node.tagName) && tComponents.has(node.tagName.text)) {
      if (!insideFunction(node)) add(node, 'module-scope-t', node.getText(sf).slice(0, 80))
      const k = node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'k')
      if (k && k.initializer) checkKey(node, ts.isStringLiteral(k.initializer) ? k.initializer : k.initializer.expression)
    }
    if (ts.isCallExpression(node)) {
      const { object, name } = calleeName(node.expression)
      if (isTCall(node)) {
        if (!insideFunction(node)) add(node, 'module-scope-t', node.getText(sf).slice(0, 80))
        checkKey(node, node.arguments[0])
      } else if (name && SINK_FUNCTIONS.has(name)) {
        for (const a of node.arguments) addText(sinkLiterals(a), 'sink')
      } else if (name && DIALOG_METHODS.has(name)) {
        for (const a of node.arguments) addText(sinkLiterals(a), 'sink')
      } else if (name && LOCALE_METHODS.has(name) && object && (node.arguments.length === 0 || isUndefined(node.arguments[0]))) {
        add(node, 'locale', node.getText(sf).slice(0, 80))
      }
      if (object && ts.isIdentifier(object) && object.text === 'Intl' && name !== 'Segmenter' && (node.arguments.length === 0 || isUndefined(node.arguments[0]))) {
        add(node, 'locale', node.getText(sf).slice(0, 80))
      }
    }
    if (ts.isNewExpression(node)) {
      const { object, name } = calleeName(node.expression)
      if (name && SINK_CONSTRUCTORS.has(name) && (!object || (ts.isIdentifier(object) && object.text === 'window'))) {
        for (const a of node.arguments ?? []) addText(sinkLiterals(a), 'sink')
      }
      if (object && ts.isIdentifier(object) && object.text === 'Intl' && name !== 'Segmenter') {
        const args = node.arguments ?? []
        if (args.length === 0 || isUndefined(args[0])) add(node, 'locale', node.getText(sf).slice(0, 80))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  // In the order they are written.
  const ordered = findings.sort((a, b) => a.at - b.at).map((f) => f.finding)
  return applyAllow(ordered, rules.allow)
}

/** Drops findings allow.json explains: by text pattern, or by site (file glob, optional kind and text). */
function applyAllow(findings, allow) {
  if (!allow) return findings
  const texts = (allow.texts ?? []).map((t) => ({ re: new RegExp(t.pattern, 'u'), kinds: t.kinds }))
  const sites = allow.sites ?? []
  return findings.filter((f) => {
    if (texts.some((t) => (!t.kinds || t.kinds.includes(f.kind)) && t.re.test(f.text))) return false
    if (sites.some((s) => globRegExp(s.file).test(f.file) && (!s.kind || s.kind === f.kind) && (s.text === undefined || s.text === f.text))) return false
    return true
  })
}

/**
 * Scans the tree and sorts each finding: `allowed` (a file allow.json lists), `pending` (the other
 * account's, pending.json), `failures` (a failFor file, or any file once the scan fails) and
 * `report` (the rest, until S4). `mode` overrides config.json's scan ('report' or 'fail').
 */
function scanTree(root = files.ROOT, { mode, keys } = {}) {
  const config = files.readConfig(root)
  const allow = files.readAllow(root)
  const pending = files.readPending(root)
  const english = keys ?? new Set(Object.keys(files.readEnglish(root).messages))
  const scanMode = mode ?? config.scan
  const out = { failures: [], report: [], pending: [], allowed: [], files: 0 }
  for (const abs of files.sourceFiles(root)) {
    const file = files.rel(root, abs)
    out.files++
    const found = scanSource(file, fs.readFileSync(abs, 'utf8'), { keys: english, allow })
    if (!found.length) continue
    if (matchesAny(file, allow.files)) out.allowed.push(...found)
    else if (matchesAny(file, pending.files)) out.pending.push(...found)
    else if ((config.failFor ?? []).includes(file) || scanMode === 'fail') out.failures.push(...found)
    else out.report.push(...found)
  }
  return out
}

/* ---------- import graphs (test 86) ---------- */

const COMPILER_OPTIONS = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, resolveJsonModule: true, allowImportingTsExtensions: true, jsx: ts.JsxEmit.ReactJSX }

/** Module specifiers a file loads at run time: imports and re-exports that are not type-only, import(), require(); import.meta.glob patterns apart. */
function runtimeImports(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
  const specs = []
  const globs = []
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const typeOnly = clause && (clause.isTypeOnly || (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly)))
      if (!typeOnly) specs.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      specs.push(node.moduleSpecifier.text)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      specs.push(node.moduleReference.expression.text)
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0]
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && arg && ts.isStringLiteralLike(arg)) specs.push(arg.text)
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && arg && ts.isStringLiteralLike(arg)) specs.push(arg.text)
      else if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'glob' && node.expression.expression.getText(sf) === 'import.meta' && arg) {
        const patterns = ts.isArrayLiteralExpression(arg) ? arg.elements : [arg]
        for (const p of patterns) if (ts.isStringLiteralLike(p)) globs.push(p.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { specs, globs }
}

/** The files `entry` loads at run time, itself included (absolute paths; node_modules left out). */
function importGraph(entry) {
  const seen = new Set()
  const todo = [path.resolve(entry)]
  while (todo.length) {
    const file = todo.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file)) continue
    const { specs, globs } = runtimeImports(file, fs.readFileSync(file, 'utf8'))
    for (const spec of specs) {
      const r = ts.resolveModuleName(spec, file, COMPILER_OPTIONS, ts.sys).resolvedModule
      if (!r || r.isExternalLibraryImport || r.resolvedFileName.endsWith('.d.ts')) continue
      todo.push(path.resolve(r.resolvedFileName))
    }
    for (const g of globs) {
      if (g.startsWith('!')) continue
      const abs = path.resolve(path.dirname(file), g)
      const re = globRegExp(abs.split(path.sep).join('/'))
      const excluded = globs.filter((x) => x.startsWith('!')).map((x) => globRegExp(path.resolve(path.dirname(file), x.slice(1)).split(path.sep).join('/')))
      const base = path.dirname(abs.split('*')[0] + 'x')
      for (const f of files.walk(base, (p) => re.test(p.split(path.sep).join('/')) && !excluded.some((x) => x.test(p.split(path.sep).join('/'))))) todo.push(f)
    }
  }
  return seen
}

/**
 * The namespaces the run-time graph from `entry` uses: English namespace files it imports, keys of
 * built catalogues it imports, and in its code every string equal to an English key, every t() key
 * and every key template's namespace (test 86).
 */
function mainNamespaces(entry, root = files.ROOT) {
  const english = files.readEnglish(root)
  const keys = new Set(Object.keys(english.messages))
  const used = new Set()
  const messagesDir = path.join(root, files.MESSAGES_DIR)
  for (const file of importGraph(path.resolve(root, entry))) {
    if (file.endsWith('.json')) {
      if (path.dirname(file) === messagesDir && !file.endsWith('.meta.json')) used.add(path.basename(file, '.json'))
      else if (path.dirname(file) === path.join(root, files.BUILT_DIR)) {
        const raw = files.readJson(file)
        for (const k of Object.keys(raw?.messages ?? {})) used.add(files.namespaceOf(k))
      }
      continue
    }
    const text = fs.readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
    const { tNames, tNamespaces } = runtimeBindings(sf, files.rel(root, file))
    const visit = (node) => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && keys.has(node.text)) used.add(files.namespaceOf(node.text))
      if (ts.isCallExpression(node)) {
        const c = node.expression
        const isT = (ts.isIdentifier(c) && tNames.has(c.text)) || (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && tNamespaces.has(c.expression.text) && T_FUNCTIONS.has(c.name.text))
        if (isT && node.arguments[0]) {
          for (const lit of textLiterals(node.arguments[0], false)) {
            const head = ts.isTemplateExpression(lit) ? lit.head.text : lit.text
            const ns = head.includes('.') ? head.slice(0, head.indexOf('.')) : null
            if (ns) used.add(ns)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return used
}

/** Files under src/ that import a meta file (none may: meta files never ship, §9.1). */
function metaImporters(root = files.ROOT) {
  const out = []
  for (const abs of files.sourceFiles(root)) {
    const { specs, globs } = runtimeImports(abs, fs.readFileSync(abs, 'utf8'))
    const text = fs.readFileSync(abs, 'utf8')
    const typeImports = [...text.matchAll(/import\s+type[^'"]*['"]([^'"]+)['"]/g)].map((m) => m[1])
    if ([...specs, ...globs, ...typeImports].some((s) => /\.meta(\.json)?$/.test(s) || s.includes('.meta.json') || s.includes('*.meta'))) out.push(files.rel(root, abs))
  }
  return out
}

module.exports = {
  TEXT_ATTRIBUTES,
  SINK_FUNCTIONS,
  DIALOG_METHODS,
  SINK_CONSTRUCTORS,
  TEXT_PROPERTIES,
  HAS_LETTER,
  isKeycap,
  globRegExp,
  matchesAny,
  insideFunction,
  constValue,
  calleeName,
  scanSource,
  applyAllow,
  scanTree,
  runtimeImports,
  importGraph,
  mainNamespaces,
  metaImporters
}
