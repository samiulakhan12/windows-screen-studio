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
 * - `key`: a t() or <T k> key that English does not have;
 * - with `rules.words` (step S4b), `table`, `copy` and `fragment`: UI words in word tables, words a
 *   function returns or builds, and sentences made of pieces (see WORD_KINDS below). scanTree sorts
 *   them apart, a report until config.json's `words` says "fail".
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
  const richComponents = new Set()
  const richFunctions = new Set()
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
    // The message helpers whose values or tags are elements (<Rich k>, richText(k, …)), for the words rule.
    if (/(^|\/)(?:Rich|i18n\/richText)$/.test(spec)) {
      const nb = clause.namedBindings
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          const imported = (el.propertyName ?? el.name).text
          if (imported === 'Rich') richComponents.add(el.name.text)
          if (imported === 'richText') richFunctions.add(el.name.text)
        }
      }
    }
  }
  return { tNames, tNamespaces, tComponents, richComponents, richFunctions }
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

/* ---------- words in code: tables, copy and fragments (step S4b) ---------- */

/**
 * The kinds the words rule adds (§9.1, §9.3, §16.1), for UI text the sink rules cannot see:
 *
 * - `table`: UI words held in an object or array literal: labels, names, titles, hints, notes and
 *   sentences, maps keyed by ids (`{ fast: 'Fast', best: 'Most accurate' }`), and the getters,
 *   methods and arrow functions such a table holds (`offline: (size) => \`This PC is offline…\``),
 *   and a component's own text prop (`<Section hint="…">`);
 * - `copy`: UI words a function returns or builds outside a table (`return 'Loading the speech
 *   model…'`, `` const head = `Sends ${what} to ${where}` ``), or hands to a function the sink rules
 *   do not know;
 * - `fragment`: a sentence made of pieces (§9.3): a message's text joined with English words by `+`
 *   or a template, English words in a message's placeholder, two or more messages side by side in
 *   one element, messages joined by a space, a comma or a semicolon, and a message whose English is
 *   itself a piece (it starts or ends with a space or a joining mark, or ends with a comma, a
 *   semicolon or a joining word). Keys of a `merge: true` group are handled (§9.3) and pass.
 *
 * Ids, CSS values, file-format words, paths, message keys and other data do not read as words and
 * pass; what reads as words but is data (AI prompts, words in exported files, brand names) is
 * listed in allow.json with its reason.
 */
const WORD_KINDS = Object.freeze(['table', 'copy', 'fragment'])

/**
 * Property names whose string values are data, whatever they look like. Not `error` or `filter`: a
 * failure's words (`{ status: 'error', error: '…' }`) and a save dialog's file type are shown; an id
 * or a CSS filter there still reads as no words.
 */
const DATA_PROPS = new Set([
  'id', 'ids', 'key', 'keys', 'k', 'kind', 'type', 'value', 'values', 'family', 'fontFamily', 'fontName', 'font', 'fonts', 'className', 'class',
  'displayName', 'tagName', 'style', 'css', 'color', 'colour', 'background', 'fill', 'stroke', 'icon', 'path', 'file', 'files', 'fileName',
  'filename', 'dir', 'folder', 'url', 'href', 'src', 'ext', 'extension', 'extensions', 'mime', 'mimeType', 'codec', 'encoder', 'keywords',
  'testId', 'testid', 'role', 'lang', 'locale', 'repo', 'commit', 'sha', 'sha256', 'hash', 'accelerator', 'channel', 'event', 'method',
  'pattern', 'regex', 'selector', 'prompt', 'system', 'schema', 'format', 'mode', 'variant', 'group', 'category', 'slug', 'model', 'voice',
  'easing', 'cursor', 'align', 'position', 'anchor', 'shape', 'look', 'theme', 'preset', 'state', 'status', 'code', 'level', 'unit',
  'units', 'tag', 'tags', 'english', 'en', 'licence', 'license', 'spdx', 'holder', 'copyright', 'artist', 'album', 'source', 'credit',
  'author', 'publisher', 'host', 'origin', 'endpoint', 'header', 'headers', 'contentType', 'accept', 'charset', 'encoding', 'args', 'arg',
  'flags', 'filters', 'vf', 'af', 'pixFmt', 'profile', 'tune', 'container', 'muxer', 'demuxer', 'ffmpeg', 'Authorization',
  'authorization', 'userAgent', 'fontStack', 'stack', 'csp'
])

/**
 * Properties whose string values are labels a table holds for the UI (`{ id: 'aurora', label: 'Aurora' }`),
 * as the split found tables at S2 (split.cjs labelTablesOf reads these too).
 */
const LABEL_PROPS = new Set(['label', 'title', 'name', 'description', 'hint', 'tooltip', 'placeholder', 'summary', 'text', 'heading', 'help', 'note'])

/** Whether a property's string looks like words a person reads, not an id or a path: a capitalised word first, or two words (labelTablesOf). */
const looksLikeWords = (s) => /^[A-Z][a-z]+\b/.test(s) || /[A-Za-z]{2,} [A-Za-z]{2,}/.test(s)

/** More label properties, and camel-case names that end in one ('hintText', 'doneLabel'). */
const MORE_LABEL_PROPS = /^(?:labels|titles|names|hints|notes|message|detail|body|caption|subtitle|short|long|lead|intro|question|tip|warning|blurb|explanation|why|reason|sentence|line|notice|action|button|empty|aria|plural|singular|word|words|phrase)$|[a-z](?:Label|Labels|Title|Name|Names|Hint|Text|Note|Line|Message|Sentence|Question|Tip|Description|Notice|Words|Word|Heading|Help|Summary|Intro|Lead|Body|Detail|Caption|Button|Plural|Singular|Phrase|Copy)$/

/** Property names whose values are labels: there a single capitalised word ('Quality') is UI text too. */
const LABEL_PROP = { test: (name) => LABEL_PROPS.has(name) || MORE_LABEL_PROPS.test(name) }

/** Words that are CSS or canvas values, not English a person reads ('top left', 'bold italic', '1px solid'). */
const CSS_WORDS = new Set([
  'auto', 'none', 'inherit', 'initial', 'unset', 'solid', 'dashed', 'dotted', 'double', 'inset', 'outset', 'bold', 'bolder', 'lighter',
  'normal', 'italic', 'oblique', 'nowrap', 'pre', 'hidden', 'visible', 'scroll', 'absolute', 'relative', 'fixed', 'sticky', 'block', 'inline',
  'flex', 'grid', 'contents', 'center', 'left', 'right', 'top', 'bottom', 'middle', 'baseline', 'start', 'end', 'transparent', 'currentcolor',
  'ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'forwards', 'backwards', 'infinite', 'alternate', 'reverse', 'repeat', 'no-repeat',
  'cover', 'contain', 'round', 'miter', 'bevel', 'butt', 'evenodd', 'nonzero', 'serif', 'sans-serif', 'monospace', 'system-ui', 'cursive',
  'fantasy', 'ui-sans-serif', 'ui-monospace', 'ui-serif', 'important', 'source-over', 'destination-out', 'multiply', 'screen', 'overlay',
  'lighten', 'darken', 'alphabetic', 'hanging', 'ideographic'
])

/** Text shapes that are data: a URL, a path or MIME type, a CSS function, a colour, a command-line flag, a file extension. */
const DATA_SHAPE = /^(?:[a-z][a-z0-9+.-]*:\/\/|data:|mailto:|#[0-9a-f]{3,8}$|-{1,2}[a-z]|\.[a-z0-9]{1,8}$)|^[^\s]*[/\\][^\s]*$|^(?:rgba?|hsla?|var|calc|url|linear-gradient|radial-gradient|conic-gradient|cubic-bezier|translate[XYZ3d]*|scale[XYZ3d]*|rotate[XYZ3d]*|matrix|blur|drop-shadow|steps)\(/i

/** A CSS font list or font shorthand ("'Segoe UI', system-ui, sans-serif", "600 14px 'Segoe UI'"), or an HTTP credential. */
const FONT_OR_HEADER = /^(?:\d{3}\s|(?:normal|bold|italic)\s+\d)|(?:^|,\s*)(?:'[^']+'|"[^"]+"|system-ui|sans-serif|serif|monospace|-apple-system)\s*(?:,|$)|^(?:Bearer|Basic)\s/

/** One word as a person writes it, with the punctuation around it: "Don't", "(slow)", "check-in,". */
const WORD = /^[("“‘'«[]*[A-Za-z][A-Za-z'’]*(?:-[A-Za-z]+)*[)"”’'»\].,:;!?…]*$/

/** A literal's text with `\u0000` for each placeholder, and how many placeholders it has. */
function textWithHoles(node) {
  if (ts.isTemplateExpression(node)) return { text: node.head.text + node.templateSpans.map((s) => '\u0000' + s.literal.text).join(''), holes: node.templateSpans.length }
  return { text: node.text, holes: 0 }
}

/**
 * Whether a literal reads as words a person reads. `labelLike`: it sits where a label goes (a
 * property such as `label` or `hintText`, or among other names), so one capitalised word counts.
 */
function readsAsWords(node, labelLike = false, wordTable = false) {
  const { text, holes } = textWithHoles(node)
  if (!/[A-Za-z]/.test(text)) return false
  const plain = text.replace(/\u0000/g, ' ').trim()
  if (!plain || DATA_SHAPE.test(plain) || FONT_OR_HEADER.test(plain) || FONT_OR_HEADER.test(text)) return false
  // Code and markup: arrows, braces, tags, assignments without spaces, escapes, a call.
  if (/=>|[{}<>]|\w=\S|^\W*[a-z]+\([^)]*\)\W*$/.test(plain)) return false
  // Words and placeholders as written: a placeholder glued to letters (`pop${n}`, `${n}px`) is no word.
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  const wordTokens = tokens.filter((x) => !(x.includes('\u0000') && /^[\u0000\W]*$/.test(x)))
  const holeTokens = tokens.length - wordTokens.length
  // A CSS keyword counts as a word only when it is written as one ('Top left corner', not 'top left').
  const words = wordTokens.filter((x) => WORD.test(x) && !(x === x.toLowerCase() && CSS_WORDS.has(x.replace(/[^a-z-]/g, ''))))
  const real = words.filter((w) => (w.match(/[A-Za-z]/g) ?? []).length >= 2)
  if (wordTokens.length === 1 && !holeTokens) {
    // One word: in a table of words any word ('zoom', 'zooms'); where labels go a capitalised word ('Quality', "Don't", 'Karaoke-style').
    if (wordTable && real.length === 1 && !/^[a-z]{1,3}(?:[-_][A-Za-z0-9]{2,4})?$/.test(plain)) return true
    return labelLike && /^[("“‘]*[A-Z][a-z]+(?:['’-]?[A-Za-z]+)*[.…!?)"”’]*$/.test(plain)
  }
  if (wordTable && real.length >= 1 && real.length >= wordTokens.length / 2) return true
  if (real.length < 2 || real.length < wordTokens.length / 2) {
    // Where labels go, a capitalised word with a number or a short word ('Size 2'), or a word with a placeholder ('${…}, downloaded');
    // elsewhere a capitalised word with a placeholder ('Use ${…}').
    if (real.length < 1 || real.length < wordTokens.length / 2) return false
    if (labelLike && (/^[A-Z][a-z]/.test(plain) || holeTokens > 0)) return true
    return holeTokens > 0 && /^[A-Z][a-z]+$/.test(wordTokens[0])
  }
  const first = plain.replace(/^[("“‘'«[]+/, '')
  const capital = /^[A-Z][a-z]/.test(first) || /^[A-Z]{2,}[a-z]/.test(first)
  const sentenceEnd = /[.…?!]["”’)]?$/.test(plain)
  return capital || sentenceEnd || holes > 0 || labelLike
}

/** A module's table named for the words it holds (KIND_WORDS, SPEECH_TIER_NAMES, LIBRARY_COPY, RESOLUTION_LABELS). */
const WORD_TABLE_NAME = /^[A-Z][A-Z0-9_]*(?:WORDS|NAMES|LABELS|TITLES|COPY|TEXTS|HINTS|NOTES|MESSAGES|PHRASES)$/

/** True for a capitalised word or words that name something ('Fast', 'Most accurate', 'Glass Pill'). */
const isNameLike = (node) => (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^[A-Z][a-z]+(?:[ '’-][A-Za-z][a-z]*)*$/.test(node.text)

/** Functions and methods whose string arguments are data: logs, string tests and edits, DOM and storage lookups, IPC channels. */
const DATA_CALLS = new Set([
  'log', 'warn', 'debug', 'info', 'trace', 'error', 'appLog', 'logLine', 'write', 'startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf',
  'replace', 'replaceAll', 'split', 'match', 'matchAll', 'test', 'search', 'localeCompare', 'padStart', 'padEnd', 'join', 'querySelector',
  'querySelectorAll', 'getElementById', 'closest', 'matches', 'addEventListener', 'removeEventListener', 'getAttribute', 'createElement',
  'require', 'invoke', 'handle', 'on', 'once', 'off', 'emit', 'send', 'removeListener', 'removeAllListeners', 'get', 'set', 'has', 'delete',
  'getItem', 'setItem', 'removeItem', 'postMessage', 'stringify', 'parse', 'RegExp', 'fetch', 'spawn', 'execFile', 'exec', 'fork', 'mark',
  'measure', 'time', 'timeEnd', 'assert', 'normalize', 'encode', 'decode', 'digest', 'update', 'createHash', 'Symbol', 'Buffer', 'from',
  'TextEncoder', 'DisplayNames', 'Segmenter', 'measureText', 'fillText', 'strokeText', 'matchMedia', 'setProperty', 'getPropertyValue'
])

/** Log helpers by their names (warnOnce, logLine, debugLog): what they are given goes to the log. */
const LOG_NAME = /^(?:(?:log|warn|debug|trace)(?:[A-Z]\w*)?|\w+(?:Log|Warn|Warning))$/

/** The name a call is made by: `log` for console.log(…), JSON.stringify(…), path.join(…) and any log helper. */
function callName(call) {
  let e = call.expression
  while (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression
  let name = null
  if (ts.isIdentifier(e)) name = e.text
  else if (ts.isPropertyAccessExpression(e)) {
    const obj = e.expression
    if (ts.isIdentifier(obj) && ['console', 'JSON', 'path', 'Intl'].includes(obj.text)) return 'log'
    name = e.name.text
  }
  return name && LOG_NAME.test(name) ? 'log' : name
}

/** Steps up from a literal through the expressions that pass its text on (brackets, conditions, `+`, `??`, templates). */
function textHolder(node) {
  let n = node
  for (;;) {
    const p = n.parent
    if (!p) return { holder: n, parent: p }
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression?.(p) || ts.isTypeAssertionExpression(p)) n = p
    else if (ts.isConditionalExpression(p) && p.condition !== n) n = p
    else if (ts.isBinaryExpression(p) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) n = p
    else if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.right === n) n = p
    else if (ts.isTemplateSpan(p)) n = p.parent
    else return { holder: n, parent: p }
  }
}

/** Statements and expressions a value passes through on its way out of a function a table holds. */
const passesOut = (p) =>
  ts.isReturnStatement(p) || ts.isBlock(p) || ts.isIfStatement(p) || ts.isSwitchStatement(p) || ts.isCaseBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p) || ts.isParenthesizedExpression(p) || ts.isConditionalExpression(p) || ts.isBinaryExpression(p) || ts.isTemplateSpan(p) || ts.isTemplateExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression?.(p)

/**
 * The object or array literal a value belongs to, or null: the literal it is a property value or
 * an element of (through nested literals), or the literal holding the getter, method or arrow
 * function that returns it. `parent` is what holds the outermost literal.
 */
function outerTable(holder) {
  let table = null
  let n = holder
  for (let p = holder.parent; p; n = p, p = p.parent) {
    if (ts.isObjectLiteralExpression(p) || ts.isArrayLiteralExpression(p)) {
      table = p
      continue
    }
    if (ts.isPropertyAssignment(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p) || passesOut(p)) {
      if (!table && (ts.isReturnStatement(p) || ts.isBlock(p) || ts.isIfStatement(p) || ts.isSwitchStatement(p) || ts.isCaseBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p))) {
        // A return: only a function a table holds makes it a table's.
        continue
      }
      continue
    }
    if (ts.isGetAccessor(p) || ts.isMethodDeclaration(p) || ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      const owner = ts.isGetAccessor(p) || ts.isMethodDeclaration(p) ? p.parent : p.parent && (ts.isPropertyAssignment(p.parent) ? p.parent.parent : p.parent)
      if (owner && (ts.isObjectLiteralExpression(owner) || ts.isArrayLiteralExpression(owner))) {
        table = owner
        n = owner
        p = owner
        continue
      }
      return table ? { table, parent: p } : null
    }
    return table ? { table, parent: p } : null
  }
  return table ? { table, parent: null } : null
}

/** The name of the property a value is assigned to (a getter's, method's or arrow property's name for what it returns), or null. */
function propertyOf(holder) {
  const nameOf = (n) => (n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier(n)) ? n.text : null)
  const p = holder.parent
  if (p && ts.isPropertyAssignment(p) && p.initializer === holder) return nameOf(p.name)
  if (p && ts.isEnumMember(p)) return nameOf(p.name)
  for (let q = holder.parent; q; q = q.parent) {
    if (ts.isGetAccessor(q) || ts.isMethodDeclaration(q)) return nameOf(q.name)
    if ((ts.isArrowFunction(q) || ts.isFunctionExpression(q)) && q.parent && ts.isPropertyAssignment(q.parent)) return nameOf(q.parent.name)
    if (ts.isFunctionLike(q) || ts.isSourceFile(q) || ts.isObjectLiteralExpression(q) || ts.isArrayLiteralExpression(q)) return null
  }
  return null
}

/** Each literal's answer, since every value of a table asks about the same table. */
const nameTables = new WeakMap()
const remembered = (node, answer) => {
  if (!nameTables.has(node)) nameTables.set(node, answer())
  return nameTables.get(node)
}

/** True for an object literal whose string values are mostly names or sentences: a map keyed by ids ({ fast: 'Fast', best: 'Most accurate' }). */
function isNameMap(obj) {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return false
  return remembered(obj, () => {
    const strings = obj.properties.filter((p) => ts.isPropertyAssignment(p) && (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer))).map((p) => p.initializer)
    return strings.length >= 2 && strings.filter((s) => isNameLike(s) || readsAsWords(s)).length * 3 >= strings.length * 2
  })
}

/** True for an array literal of two or more names ('Fast', 'Standard', 'Most accurate'). */
const isNameList = (arr) => !!arr && ts.isArrayLiteralExpression(arr) && remembered(arr, () => arr.elements.length >= 2 && arr.elements.every((e) => isNameLike(e) || (ts.isStringLiteral(e) && readsAsWords(e))))

/** How a message that is itself a piece of a sentence starts or ends (§9.3). */
const PIECE_START = /^(?:\s|[,;·•–—|)\]]|(?:and|or|but|to|of|with|for|then|so)\s)/
const PIECE_END = /(?:\s|[,;(·•–—|[]|\s(?:and|or|but|the|a|an))$/

/** True when an English message reads as a piece of a sentence rather than a whole one. */
function isPieceMessage(english) {
  if (typeof english !== 'string' || !/\p{L}/u.test(english)) return false
  return PIECE_START.test(english) || PIECE_END.test(english)
}

/** True when an English message is a whole sentence: not a piece, and it ends as a sentence does. */
const isWholeSentence = (english) => typeof english === 'string' && !isPieceMessage(english) && /[.!?…]["”’)]*$/.test(english)

/** Attribute names whose values are data in JSX. */
const DATA_ATTRIBUTES = new Set(['href', 'src', 'id', 'type', 'name', 'htmlFor', 'rel', 'target', 'download', 'accept', 'autoComplete', 'inputMode', 'pattern', 'k', 'lang', 'dir', 'viewBox', 'd', 'points', 'transform', 'key', 'value', 'defaultValue', 'form', 'method', 'action', 'list', 'step', 'min', 'max', 'tabIndex', 'xmlns', 'fill', 'stroke', 'fontFamily', 'textAnchor', 'dominantBaseline', 'preserveAspectRatio', 'clipPath', 'mask', 'filter', 'icon', 'as', 'variant', 'size', 'tone', 'kind', 'testId'])
const isDataAttribute = (name) => TEXT_ATTRIBUTES.has(name) || DATA_PROPS.has(name) || DATA_ATTRIBUTES.has(name) || /^(?:data-|aria-|on[A-Z])/.test(name)

/**
 * The words rule's findings in a parsed file: tables, copy and fragments (see WORD_KINDS), as
 * `{ at, kind, text }`. `reported` holds the start of every literal another rule already reported;
 * `rules.keys` (full English keys) passes keys; `rules.messages` (full key → English) and
 * `rules.merge` (keys of `merge: true` groups) feed the fragment rule.
 */
function wordFindings(sf, rules, bindings, reported) {
  const { tNames, tNamespaces, tComponents, richComponents, richFunctions } = bindings
  const out = []
  const messages = rules.messages ?? {}
  const merge = rules.merge ?? new Set()
  const add = (node, kind, text) => out.push({ at: node.getStart(sf), kind, text })
  const isTCall = (e) => {
    if (!e || !ts.isCallExpression(e)) return false
    const c = e.expression
    if (ts.isIdentifier(c)) return tNames.has(c.text) || richFunctions.has(c.text)
    return ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && tNamespaces.has(c.expression.text) && T_FUNCTIONS.has(c.name.text)
  }
  const keyOfCall = (e) => {
    const a = e.arguments[0]
    return a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : null
  }
  const openingOf = (e) => (ts.isJsxElement(e) ? e.openingElement : ts.isJsxSelfClosingElement(e) ? e : null)
  const isMessageElement = (e) => {
    const open = openingOf(e)
    return !!open && ts.isIdentifier(open.tagName) && (tComponents.has(open.tagName.text) || richComponents.has(open.tagName.text))
  }
  const keyOfElement = (e) => {
    const k = openingOf(e).attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'k')
    if (!k || !k.initializer) return null
    const v = ts.isStringLiteral(k.initializer) ? k.initializer : k.initializer.expression
    return v && (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) ? v.text : null
  }
  /** The message calls and elements an expression shows (through conditions, `&&`, `||`, `??` and brackets). */
  const messagesIn = (e, found = []) => {
    if (!e) return found
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return messagesIn(e.expression, found)
    if (ts.isConditionalExpression(e)) {
      messagesIn(e.whenTrue, found)
      messagesIn(e.whenFalse, found)
    } else if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) {
      messagesIn(e.left, found)
      messagesIn(e.right, found)
    } else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) messagesIn(e.right, found)
    else if (isTCall(e)) found.push({ node: e, key: keyOfCall(e) })
    else if (isMessageElement(e)) found.push({ node: e, key: keyOfElement(e) })
    return found
  }
  // Message nodes already part of a sentence in pieces (a run, a join, a template), and messages that are pieces on their own.
  const inSentence = new Set()
  const pieces = []
  const fragment = (node, keys, why, members = []) => {
    if (keys.length > 0 && keys.every((k) => k && merge.has(k))) return
    for (const m of members) inSentence.add(m)
    add(node, 'fragment', `${keys.map((k) => k ?? '(a key made in code)').join(' + ')} ${why}`)
  }
  /** Several messages that together make one sentence: some of them is not a whole sentence. */
  const oneSentence = (msgs) => msgs.length >= 2 && msgs.some((m) => m.key && m.key in messages && !isWholeSentence(messages[m.key]))
  /** The messages a joined array holds: an array literal's elements, or what the function pushes into a named array. */
  const piecesOfArray = (e) => {
    if (!e) return []
    if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap((x) => messagesIn(x))
    if (!ts.isIdentifier(e)) return []
    const init = constValue(e, e.text)
    const found = init && ts.isArrayLiteralExpression(init) ? init.elements.flatMap((x) => messagesIn(x)) : []
    let scope = e.parent
    while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['push', 'unshift'].includes(n.expression.name.text) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === e.text) {
        for (const a of n.arguments) found.push(...messagesIn(a))
      }
      ts.forEachChild(n, visit)
    }
    if (scope) visit(scope)
    return found
  }

  const literal = (node) => {
    const p0 = node.parent
    // A property's or a declaration's name is a key, not text.
    if (p0 && 'name' in p0 && p0.name === node) return
    if (ts.isLiteralTypeNode(p0) || ts.isImportDeclaration(p0) || ts.isExportDeclaration(p0) || ts.isExternalModuleReference(p0) || ts.isModuleDeclaration(p0)) return
    if (ts.isImportAttribute?.(p0) || ts.isPropertySignature(p0) || ts.isIndexedAccessTypeNode?.(p0)) return
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // A message key: already extracted.
      if (rules.keys?.has(node.text) || /^[a-z][a-zA-Z0-9]*(?:\.[A-Za-z0-9_-]+)+$/.test(node.text)) return
    }
    const { holder, parent } = textHolder(node)
    if (!parent) return
    if (ts.isTaggedTemplateExpression(parent) || ts.isElementAccessExpression(parent) || ts.isCaseClause(parent) || ts.isSwitchStatement(parent)) return
    if (ts.isPropertyAccessExpression(parent) || ts.isPrefixUnaryExpression(parent) || ts.isTypeOfExpression(parent) || ts.isDeleteExpression(parent) || ts.isThrowStatement(parent)) return
    if (ts.isBinaryExpression(parent)) {
      // A comparison reads text, it does not show it.
      const op = parent.operatorToken.kind
      if (![ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken].includes(op)) return
      if (parent.left === holder) return
    }
    if (ts.isJsxAttribute(parent) || (ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent))) {
      // The listed text attributes are the attr rule's; a component's own text prop is its element's table entry.
      const attr = ts.isJsxAttribute(parent) ? parent : parent.parent
      const name = attr.name.getText(sf)
      if (isDataAttribute(name)) return
      if (readsAsWords(node, LABEL_PROP.test(name))) add(node, 'table', literalText(node))
      return
    }
    if (ts.isJsxExpression(parent)) return
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      if (ts.isCallExpression(parent) && (isTCall(parent) || parent.expression.kind === ts.SyntaxKind.ImportKeyword)) return
      const name = ts.isCallExpression(parent) ? callName(parent) : calleeName(parent.expression).name
      if (name && DATA_CALLS.has(name)) return
    }
    const owned = outerTable(holder)
    if (owned) {
      // A table handed to a log line, JSON or a message's values is not shown as a table.
      let p = owned.parent
      while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression?.(p))) p = p.parent
      if (p && ts.isCallExpression(p)) {
        if (isTCall(p)) return
        const name = callName(p)
        if (name && DATA_CALLS.has(name)) return
      }
      const prop = propertyOf(holder)
      if (prop && DATA_PROPS.has(prop)) return
      const container = holder.parent && ts.isPropertyAssignment(holder.parent) ? holder.parent.parent : holder.parent
      const labelLike = (prop !== null && LABEL_PROP.test(prop)) || isNameMap(container) || isNameList(container)
      const wordTable = !!p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && WORD_TABLE_NAME.test(p.name.text)
      if (readsAsWords(node, labelLike, wordTable)) add(node, 'table', literalText(node))
      return
    }
    // Copy: returned, assigned or handed on outside a table.
    let owner = null
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) owner = parent.name.text
    if (ts.isBinaryExpression(parent) && ts.isIdentifier(parent.left)) owner = parent.left.text
    if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) owner = parent.name.text
    if (ts.isParameter(parent) && ts.isIdentifier(parent.name)) owner = parent.name.text
    if (owner && DATA_PROPS.has(owner)) return
    if (readsAsWords(node, owner !== null && LABEL_PROP.test(owner))) add(node, 'copy', literalText(node))
  }

  const visit = (node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && !reported.has(node.getStart(sf)) && !ts.isTemplateSpan(node.parent)) {
      literal(node)
    }
    // A message's text joined with English words by a template or `+`.
    if (ts.isTemplateExpression(node)) {
      const msgs = node.templateSpans.flatMap((s) => messagesIn(s.expression))
      const words = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ')
      if (msgs.length && /[A-Za-z]{2,}/.test(words)) fragment(node, msgs.map((m) => m.key), `with "${literalText(node)}"`, msgs.map((m) => m.node))
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && !(ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      const parts = []
      const flat = (e) => {
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          flat(e.left)
          flat(e.right)
        } else parts.push(e)
      }
      flat(node)
      const msgs = parts.flatMap((p) => messagesIn(p))
      const words = parts.filter((p) => ts.isStringLiteral(p) || ts.isNoSubstitutionTemplateLiteral(p)).map((p) => p.text).join(' ')
      if (msgs.length && /[A-Za-z]{2,}/.test(words)) fragment(node, msgs.map((m) => m.key), `with "${words.trim()}"`, msgs.map((m) => m.node))
    }
    if (ts.isCallExpression(node)) {
      // English words in a message's placeholder: t('k', { what: 'the clip' }).
      if (isTCall(node) && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) {
        for (const p of node.arguments[1].properties) {
          if (!ts.isPropertyAssignment(p)) continue
          for (const lit of textLiterals(p.initializer, false)) {
            if (readsAsWords(lit, true)) {
              reported.add(lit.getStart(sf))
              fragment(lit, [keyOfCall(node)], `with "${literalText(lit)}" in {${p.name.getText(sf)}}`)
            }
          }
        }
      }
      // Messages joined into one sentence by a space or a semicolon (a list joined by commas or dots is fmt.list's or a line of facts).
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join' && node.arguments.length === 1) {
        const sep = node.arguments[0]
        if ((ts.isStringLiteral(sep) || ts.isNoSubstitutionTemplateLiteral(sep)) && /^(?: |; ?)$/.test(sep.text)) {
          const msgs = piecesOfArray(node.expression.expression)
          if (oneSentence(msgs) || msgs.some((m) => m.key && isPieceMessage(messages[m.key]))) fragment(node, msgs.map((m) => m.key), `joined by "${sep.text}"`, msgs.map((m) => m.node))
        }
      }
      // A message whose English is a piece (reported after the walk, unless a sentence above holds it).
      if (isTCall(node)) {
        const key = keyOfCall(node)
        if (key && !merge.has(key) && isPieceMessage(messages[key])) pieces.push({ node, key })
      }
    }
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node)) && isMessageElement(node)) {
      const key = keyOfElement(node)
      if (key && !merge.has(key) && isPieceMessage(messages[key])) pieces.push({ node, key })
    }
    // Two or more messages side by side in one element that are not each a whole sentence: one sentence in pieces.
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      let run = []
      const flush = () => {
        if (oneSentence(run)) fragment(run[0].node, run.map((m) => m.key), 'side by side in one element', run.map((m) => m.node))
        run = []
      }
      for (const c of node.children) {
        if (ts.isJsxText(c)) {
          if (c.text.trim()) flush()
        } else if (ts.isJsxExpression(c)) {
          if (!c.expression) continue
          if ((ts.isStringLiteral(c.expression) || ts.isNoSubstitutionTemplateLiteral(c.expression)) && !c.expression.text.trim()) continue
          const msgs = messagesIn(c.expression)
          if (msgs.length) run.push(msgs[0])
          else flush()
        } else if (isMessageElement(c)) run.push({ node: c, key: keyOfElement(c) })
        else flush()
      }
      flush()
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  for (const p of pieces) if (!inSentence.has(p.node)) fragment(p.node, [p.key], `reads as a piece: ${JSON.stringify(messages[p.key])}`)
  return out
}

/**
 * The findings in one source file. `rules.keys` (a Set of full English keys) turns on the `key`
 * rule; `rules.words` turns on the words rule (tables, copy and fragments, step S4b), which reads
 * `rules.messages` and `rules.merge`; `rules.allow` drops what allow.json lists by text or by site.
 */
function scanSource(file, text, rules = {}) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
  const bindings = runtimeBindings(sf, file)
  const { tNames, tNamespaces, tComponents } = bindings
  const findings = []
  const seen = new Set()
  // Where the rules above reported a literal: the words rule does not report it again.
  const reported = new Set()
  const add = (node, kind, shown) => {
    const at = node.getStart(sf)
    reported.add(at)
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
  if (rules.words) {
    for (const w of wordFindings(sf, rules, bindings, reported)) {
      const line = sf.getLineAndCharacterOfPosition(w.at).line + 1
      const id = `${line}\u0000${w.kind}\u0000${w.text}`
      if (seen.has(id)) continue
      seen.add(id)
      findings.push({ at: w.at, finding: { file, line, kind: w.kind, text: w.text } })
    }
  }
  // In the order they are written.
  const ordered = findings.sort((a, b) => a.at - b.at).map((f) => f.finding)
  return applyAllow(ordered, rules.allow)
}

/**
 * Drops findings allow.json explains: by text pattern (optionally for some kinds), or by site: a
 * file glob, optionally a kind, and the exact text or a `pattern` over it.
 */
function applyAllow(findings, allow) {
  if (!allow) return findings
  const texts = (allow.texts ?? []).map((t) => ({ re: new RegExp(t.pattern, 'u'), kinds: t.kinds }))
  const sites = (allow.sites ?? []).map((s) => ({ ...s, file: globRegExp(s.file), re: s.pattern === undefined ? null : new RegExp(s.pattern, 'u') }))
  return findings.filter((f) => {
    if (texts.some((t) => (!t.kinds || t.kinds.includes(f.kind)) && t.re.test(f.text))) return false
    if (sites.some((s) => s.file.test(f.file) && (!s.kind || s.kind === f.kind) && (s.text === undefined || s.text === f.text) && (!s.re || s.re.test(f.text)))) return false
    return true
  })
}

/** The English catalogue's keys, messages and `merge: true` keys, as the rules read them. */
function englishRules(root = files.ROOT) {
  const en = files.readEnglish(root)
  const merge = new Set(Object.entries(en.meta).filter(([, m]) => m && m.merge === true).map(([k]) => k))
  return { keys: new Set(Object.keys(en.messages)), messages: en.messages, merge }
}

/**
 * Scans the tree and sorts each finding: `allowed` (a file allow.json lists), `pending` (the other
 * account's, pending.json), `failures` (a failFor file, or any file once the scan fails) and
 * `report` (the rest, until S4). `mode` overrides config.json's scan ('report' or 'fail').
 *
 * The words rule's findings (WORD_KINDS: tables, copy and fragments, step S4b) are sorted apart:
 * `words` while config.json's `words` says "report" (as it did while step S4b's builders worked),
 * `failures` once it says "fail" (as it has since S4b's integration); `wordsMode` overrides it, and `words: false` leaves the rule out
 * (the split, which reads only the report). The other account's stay pending.
 */
function scanTree(root = files.ROOT, { mode, keys, wordsMode, words = true } = {}) {
  const config = files.readConfig(root)
  const allow = files.readAllow(root)
  const pending = files.readPending(root)
  const english = englishRules(root)
  const scanMode = mode ?? config.scan
  const wordMode = wordsMode ?? config.words ?? 'report'
  const out = { failures: [], report: [], pending: [], allowed: [], words: [], files: 0 }
  for (const abs of files.sourceFiles(root)) {
    const file = files.rel(root, abs)
    out.files++
    const found = scanSource(file, fs.readFileSync(abs, 'utf8'), { keys: keys ?? english.keys, messages: english.messages, merge: english.merge, words, allow })
    if (!found.length) continue
    if (matchesAny(file, allow.files)) out.allowed.push(...found)
    else if (matchesAny(file, pending.files)) out.pending.push(...found)
    else {
      for (const f of found) {
        if (WORD_KINDS.includes(f.kind)) (wordMode === 'fail' ? out.failures : out.words).push(f)
        else if ((config.failFor ?? []).includes(file) || scanMode === 'fail') out.failures.push(f)
        else out.report.push(f)
      }
    }
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
  WORD_KINDS,
  LABEL_PROPS,
  looksLikeWords,
  readsAsWords,
  isPieceMessage,
  scanSource,
  applyAllow,
  englishRules,
  scanTree,
  runtimeImports,
  importGraph,
  mainNamespaces,
  metaImporters
}
