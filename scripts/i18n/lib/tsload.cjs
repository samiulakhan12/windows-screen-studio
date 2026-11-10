'use strict'
/**
 * Loads one of the app's TypeScript modules into a script, so the i18n tools use the app's own code
 * (src/shared/i18n/icu.ts's parser) instead of a copy. The file is compiled with the repository's
 * TypeScript (`ts.transpileModule`, CommonJS output) and run in a module of its own; its relative
 * imports load the same way. Type-only code disappears in the compile, so nothing else is needed.
 */
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const cache = new Map()

/** The module exports of the TypeScript file `file` (absolute), compiled once per process. */
function loadTs(file) {
  const abs = path.resolve(file)
  if (cache.has(abs)) return cache.get(abs).exports
  const source = fs.readFileSync(abs, 'utf8')
  const out = ts.transpileModule(source, {
    fileName: abs,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true, jsx: ts.JsxEmit.ReactJSX }
  })
  const mod = new Module(abs, module)
  mod.filename = abs
  mod.paths = Module._nodeModulePaths(path.dirname(abs))
  cache.set(abs, mod)
  const localRequire = (spec) => {
    if (spec.startsWith('.')) {
      const base = path.resolve(path.dirname(abs), spec)
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
        if (/\.tsx?$/.test(candidate) && fs.existsSync(candidate)) return loadTs(candidate)
      }
      return require(base)
    }
    return require(spec)
  }
  const wrapper = new Function('exports', 'require', 'module', '__filename', '__dirname', out.outputText)
  wrapper.call(mod.exports, mod.exports, localRequire, mod, abs, path.dirname(abs))
  return mod.exports
}

module.exports = { loadTs }
