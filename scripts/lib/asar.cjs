// Reads the file list of an Electron .asar archive without extracting it (same data as
// `npx asar list`). Only the JSON header at the start of the file is read.
'use strict'

const fs = require('node:fs')

/**
 * Parses the header of an asar archive held in `buf` (at least the first 16 + header bytes).
 * Layout: UInt32 4, UInt32 header pickle size, then the pickle: UInt32 payload size,
 * UInt32 JSON length, JSON.
 */
function parseAsarHeader(buf) {
  if (buf.length < 16 || buf.readUInt32LE(0) !== 4) throw new Error('not an asar archive')
  const jsonLength = buf.readUInt32LE(12)
  if (16 + jsonLength > buf.length) throw new Error('truncated asar header')
  return JSON.parse(buf.toString('utf8', 16, 16 + jsonLength))
}

/** Reads and parses the header of the asar archive at `file`. */
function readAsarHeader(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(16)
    if (fs.readSync(fd, head, 0, 16, 0) < 16) throw new Error('not an asar archive')
    const total = 8 + head.readUInt32LE(4)
    const buf = Buffer.alloc(total)
    if (fs.readSync(fd, buf, 0, total, 0) < total) throw new Error('truncated asar header')
    return parseAsarHeader(buf)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Flattens an asar header into entries like { path: '/out/main/index.js', size, unpacked, dir }.
 * Directories are listed too, before their contents, as `asar list` does.
 */
function listAsar(header) {
  const out = []
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const p = `${prefix}/${name}`
      if (entry.files) {
        out.push({ path: p, size: 0, unpacked: !!entry.unpacked, dir: true })
        walk(entry, p)
      } else {
        out.push({ path: p, size: Number(entry.size) || 0, unpacked: !!entry.unpacked, dir: false, link: entry.link })
      }
    }
  }
  walk(header, '')
  return out
}

module.exports = { parseAsarHeader, readAsarHeader, listAsar }
