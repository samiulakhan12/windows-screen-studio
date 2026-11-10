'use strict'
/**
 * CSV as Excel on Windows reads and writes it (RFC 4180): fields with a comma, a quote or a line
 * break are quoted, quotes are doubled, rows end with CRLF. The review sheet and the glossary use it.
 */

/** Rows of fields. A leading byte-order mark is skipped; LF and CRLF both end a row. */
function parseCsv(text) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"' && field === '') {
      quoted = true
      i++
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (c === '\r' && s[i + 1] === '\n') i++
    if (c === '\n' || c === '\r') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      continue
    }
    field += c
    i++
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const needsQuotes = (v) => /[",\r\n]/.test(v) || /^\s|\s$/.test(v)

/** CSV text of `rows`, CRLF after every row. */
function formatCsv(rows) {
  return rows.map((r) => r.map((v) => (needsQuotes(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')).join('\r\n') + '\r\n'
}

module.exports = { parseCsv, formatCsv }
