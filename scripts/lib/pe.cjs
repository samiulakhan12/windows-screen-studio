// Minimal Windows PE reader for the packaging checks: architecture, truncation,
// Authenticode presence, the icon resources and the version strings. Works on any OS (no Windows tools).
'use strict'

const { createHash } = require('node:crypto')

const MACHINES = { 0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64' }
const RT_ICON = 3
const RT_GROUP_ICON = 14
const RT_VERSION = 16

/**
 * Parses the headers of a PE file.
 * @param {Buffer} buf whole file
 * @returns {{ machine: string, sections: {name: string, virtualAddress: number, virtualSize: number, rawOffset: number, rawSize: number}[],
 *   rawEnd: number, truncated: boolean, signed: boolean, certOffset: number, resourceRva: number, resourceSize: number }}
 */
function parsePe(buf) {
  if (buf.length < 64 || buf.toString('latin1', 0, 2) !== 'MZ') throw new Error('not a Windows executable (no MZ header)')
  const pe = buf.readUInt32LE(0x3c)
  if (pe + 24 > buf.length || buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a Windows executable (no PE header)')
  const machineId = buf.readUInt16LE(pe + 4)
  const sectionCount = buf.readUInt16LE(pe + 6)
  const optSize = buf.readUInt16LE(pe + 20)
  const opt = pe + 24
  const magic = buf.readUInt16LE(opt)
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('unknown PE optional header')
  const dirs = opt + (magic === 0x20b ? 112 : 96)
  const dirCount = buf.readUInt32LE(opt + (magic === 0x20b ? 108 : 92))
  const dir = (i) => (i < dirCount ? { rva: buf.readUInt32LE(dirs + i * 8), size: buf.readUInt32LE(dirs + i * 8 + 4) } : { rva: 0, size: 0 })

  const sections = []
  const table = opt + optSize
  let rawEnd = table + sectionCount * 40
  for (let i = 0; i < sectionCount; i++) {
    const s = table + i * 40
    if (s + 40 > buf.length) break
    const section = {
      name: buf.toString('latin1', s, s + 8).replace(/\0+$/, ''),
      virtualSize: buf.readUInt32LE(s + 8),
      virtualAddress: buf.readUInt32LE(s + 12),
      rawSize: buf.readUInt32LE(s + 16),
      rawOffset: buf.readUInt32LE(s + 20)
    }
    sections.push(section)
    if (section.rawSize) rawEnd = Math.max(rawEnd, section.rawOffset + section.rawSize)
  }
  // The certificate table (data directory 4) holds a file offset, not an RVA, and sits after the sections.
  const security = dir(4)
  if (security.size) rawEnd = Math.max(rawEnd, security.rva + security.size)
  const resource = dir(2)
  return {
    machine: MACHINES[machineId] || `0x${machineId.toString(16)}`,
    sections,
    rawEnd,
    truncated: sections.length < sectionCount || buf.length < rawEnd,
    signed: security.size > 0 && security.rva + security.size <= buf.length,
    certOffset: security.size ? security.rva : 0,
    resourceRva: resource.rva,
    resourceSize: resource.size
  }
}

function rvaToOffset(info, rva) {
  for (const s of info.sections) {
    const size = Math.max(s.virtualSize, s.rawSize)
    if (rva >= s.virtualAddress && rva < s.virtualAddress + size) return s.rawOffset + (rva - s.virtualAddress)
  }
  throw new Error(`RVA 0x${rva.toString(16)} is outside every section`)
}

/** Flattens the resource tree into { type, id, lang, data } leaves (named entries get id = null). */
function readResources(buf, info = parsePe(buf)) {
  if (!info.resourceRva) return []
  const root = rvaToOffset(info, info.resourceRva)
  const out = []
  const walk = (offset, depth, path) => {
    const named = buf.readUInt16LE(offset + 12)
    const ids = buf.readUInt16LE(offset + 14)
    for (let i = 0; i < named + ids; i++) {
      const e = offset + 16 + i * 8
      const nameField = buf.readUInt32LE(e)
      const target = buf.readUInt32LE(e + 4)
      const key = nameField & 0x80000000 ? null : nameField
      if (target & 0x80000000) {
        if (depth < 2) walk(root + (target & 0x7fffffff), depth + 1, [...path, key])
      } else {
        const leaf = root + target
        const dataOffset = rvaToOffset(info, buf.readUInt32LE(leaf))
        const size = buf.readUInt32LE(leaf + 4)
        const [type, id] = path
        out.push({ type, id, lang: key, data: buf.subarray(dataOffset, dataOffset + size) })
      }
    }
  }
  walk(root, 0, [])
  return out
}

/**
 * The icon groups of an executable, each with its images resolved:
 * [{ id, images: [{ width, height, bitCount, data }] }]. The first group is the one
 * Explorer, shortcuts and the taskbar show.
 */
function readIconGroups(buf) {
  const resources = readResources(buf)
  const icons = new Map(resources.filter((r) => r.type === RT_ICON).map((r) => [r.id, r.data]))
  return resources
    .filter((r) => r.type === RT_GROUP_ICON)
    .map((group) => {
      const d = group.data
      const count = d.readUInt16LE(4)
      const images = []
      for (let i = 0; i < count; i++) {
        const e = 6 + i * 14
        images.push({
          width: d[e] || 256,
          height: d[e + 1] || 256,
          bitCount: d.readUInt16LE(e + 6),
          data: icons.get(d.readUInt16LE(e + 12)) || null
        })
      }
      return { id: group.id, images }
    })
}

/**
 * One block of a VS_VERSIONINFO tree (wLength, wValueLength, wType, a NUL-terminated UTF-16 key,
 * the value and the child blocks, each 32-bit aligned within the resource).
 */
function readVersionBlock(d, offset) {
  const align = (n) => (n + 3) & ~3
  const length = d.readUInt16LE(offset)
  const valueLength = d.readUInt16LE(offset + 2)
  const text = d.readUInt16LE(offset + 4) === 1
  const end = Math.min(offset + length, d.length)
  let p = offset + 6
  let key = ''
  for (; p + 1 < end; p += 2) {
    const c = d.readUInt16LE(p)
    if (!c) break
    key += String.fromCharCode(c)
  }
  p = align(p + 2)
  const value = d.subarray(p, Math.min(p + (text ? valueLength * 2 : valueLength), end))
  p = align(p + value.length)
  const children = []
  while (p + 6 <= end) {
    const child = readVersionBlock(d, p)
    if (!child.length) break
    children.push(child)
    p = align(p + child.length)
  }
  return { key, text, value, children, length }
}

/**
 * The version strings of an executable (CompanyName, FileDescription, ProductName,
 * LegalCopyright, FileVersion, ...) from its first string table, or {} when it has none.
 * @returns {Record<string, string>}
 */
function readVersionStrings(buf) {
  const resource = readResources(buf).find((r) => r.type === RT_VERSION)
  if (!resource) return {}
  const root = readVersionBlock(resource.data, 0)
  const table = root.children.find((c) => c.key === 'StringFileInfo')?.children[0]
  const out = {}
  for (const entry of table?.children ?? []) out[entry.key] = entry.value.toString('utf16le').replace(/\0+$/, '')
  return out
}

/**
 * SHA-256 of a PE file's first `length` bytes with the two header fields Authenticode signing
 * rewrites (the checksum and the certificate table entry) read as zeros. Signing only pads the
 * file to 8 bytes and appends the certificate table, so over the unsigned length this hash is
 * the same before and after signing.
 */
function peContentHash(buf, length = buf.length) {
  const opt = buf.readUInt32LE(0x3c) + 24
  const checksum = opt + 64
  const certEntry = opt + (buf.readUInt16LE(opt) === 0x20b ? 112 : 96) + 4 * 8
  return createHash('sha256')
    .update(buf.subarray(0, checksum))
    .update(Buffer.alloc(4))
    .update(buf.subarray(checksum + 4, certEntry))
    .update(Buffer.alloc(8))
    .update(buf.subarray(certEntry + 8, length))
    .digest('hex')
}

/**
 * Whether `buf` is the build `pin` describes ({ size, sha256 } of the unsigned file, sha256 as
 * peContentHash), signed or not.
 */
function matchesPin(buf, info, pin) {
  const end = info.signed ? info.certOffset : buf.length
  if (end < pin.size || end - pin.size >= 8 || buf.subarray(pin.size, end).some((b) => b !== 0)) return false
  return peContentHash(buf, pin.size) === pin.sha256
}

/**
 * Is `file` a complete x64 Windows executable? Catches a missing file, the build host's own
 * (Linux/macOS) binary, a 32-bit/ARM build and an interrupted download. With `pin`, the file
 * must also be exactly that build (see matchesPin).
 * @returns {{ ok: true, size: number, signed: boolean } | { ok: false, reason: string }}
 */
function checkWindowsExe(file, { minBytes = 0, pin = null, fs = require('node:fs') } = {}) {
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'missing' : err.message }
  }
  let info
  try {
    info = parsePe(buf)
  } catch (err) {
    return { ok: false, reason: err.message }
  }
  if (info.machine !== 'x64') return { ok: false, reason: `built for ${info.machine}, not x64` }
  if (info.truncated) return { ok: false, reason: `truncated (${buf.length} of at least ${info.rawEnd} bytes)` }
  if (buf.length < minBytes) return { ok: false, reason: `only ${buf.length} bytes` }
  if (pin && !matchesPin(buf, info, pin)) return { ok: false, reason: `not the expected build (its SHA-256 differs from the pinned ${pin.sha256})` }
  return { ok: true, size: buf.length, signed: info.signed }
}

module.exports = { parsePe, readResources, readIconGroups, readVersionStrings, checkWindowsExe, peContentHash, RT_ICON, RT_GROUP_ICON, RT_VERSION }
