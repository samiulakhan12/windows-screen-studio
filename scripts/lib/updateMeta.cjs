// The update metadata electron-builder writes for Flown's own updates (docs/design/auto-update.md):
// resources/app-update.yml inside the app (where the updater looks) and latest.yml next to the
// installer (what a release carries). verify-dist checks both with these helpers; the tests cover them.
'use strict'

/** Top-level `key: value` lines of a small YAML file (quotes removed); nested lines are skipped. */
function topLevel(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

/** latest.yml: the version, the installer's name, SHA-512 (base64) and size, and its `files` list. */
function parseLatestYml(text) {
  const top = topLevel(text)
  const files = []
  let cur = null
  for (const line of String(text).split(/\r?\n/)) {
    const item = /^\s*-\s+url:\s*(.+)$/.exec(line)
    if (item) {
      cur = { url: item[1].trim().replace(/^['"]|['"]$/g, '') }
      files.push(cur)
      continue
    }
    const field = /^\s+(sha512|size):\s*(.+)$/.exec(line)
    if (field && cur) cur[field[1]] = field[1] === 'size' ? Number(field[2].trim()) : field[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return { version: top.version, path: top.path, sha512: top.sha512, files }
}

/**
 * Problems with the update metadata (an empty list when it is right): app-update.yml must point at
 * `publish` (GitHub, the owner and repository), latest.yml must name `installerName` at `version`
 * with the installer's real SHA-512 (base64), and its size when it gives one.
 */
function updateMetaProblems({ appUpdateText, latestText, publish, version, installerName, installerSha512, installerSize }) {
  const problems = []
  if (appUpdateText == null) problems.push('resources/app-update.yml is missing (the app could not look for updates)')
  else {
    const a = topLevel(appUpdateText)
    if (a.provider !== publish.provider) problems.push(`app-update.yml provider is ${a.provider || 'missing'}, expected ${publish.provider}`)
    if (a.owner !== publish.owner || a.repo !== publish.repo) problems.push(`app-update.yml points at ${a.owner}/${a.repo}, expected ${publish.owner}/${publish.repo}`)
    if (!a.updaterCacheDirName) problems.push('app-update.yml has no updaterCacheDirName')
  }
  if (latestText == null) problems.push('latest.yml is missing (a release could not offer this version)')
  else {
    const l = parseLatestYml(latestText)
    if (l.version !== version) problems.push(`latest.yml version is ${l.version || 'missing'}, expected ${version}`)
    if (l.path !== installerName) problems.push(`latest.yml path is ${l.path || 'missing'}, expected ${installerName}`)
    if (l.sha512 !== installerSha512) problems.push("latest.yml sha512 does not match the installer's")
    const f = l.files.find((x) => x.url === installerName)
    if (!f) problems.push(`latest.yml files has no ${installerName}`)
    else {
      if (f.sha512 !== installerSha512) problems.push("latest.yml files[].sha512 does not match the installer's")
      // electron-builder writes the size only with a blockmap (differential downloads, off for Flown).
      if (f.size !== undefined && f.size !== installerSize) problems.push(`latest.yml files[].size is ${f.size}, the installer has ${installerSize} bytes`)
    }
  }
  return problems
}

module.exports = { topLevel, parseLatestYml, updateMetaProblems }
