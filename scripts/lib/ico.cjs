// ICO and BMP encoding/decoding for the icon generator and the packaging checks.
// Pure functions over Buffers so they can be unit-tested without Electron.
'use strict'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 32-bit BGRA DIB as stored inside .ico files: BITMAPINFOHEADER with doubled height,
 * bottom-up straight-alpha pixels, then the 1-bit AND mask (set where fully transparent).
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba straight (unpremultiplied) RGBA, top-down, width*height*4 bytes
 */
function encodeIconDib(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error(`expected ${width * height * 4} RGBA bytes, got ${rgba.length}`)
  const maskStride = Math.ceil(width / 32) * 4
  const pixelBytes = width * height * 4
  const out = Buffer.alloc(40 + pixelBytes + maskStride * height)
  out.writeUInt32LE(40, 0)
  out.writeInt32LE(width, 4)
  out.writeInt32LE(height * 2, 8) // XOR bitmap + AND mask
  out.writeUInt16LE(1, 12)
  out.writeUInt16LE(32, 14)
  out.writeUInt32LE(0, 16) // BI_RGB
  out.writeUInt32LE(pixelBytes + maskStride * height, 20)
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4
    const dst = 40 + y * width * 4
    const mask = 40 + pixelBytes + y * maskStride
    for (let x = 0; x < width; x++) {
      const s = src + x * 4
      const d = dst + x * 4
      out[d] = rgba[s + 2]
      out[d + 1] = rgba[s + 1]
      out[d + 2] = rgba[s]
      out[d + 3] = rgba[s + 3]
      if (rgba[s + 3] === 0) out[mask + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return out
}

/**
 * Builds a multi-resolution .ico. Each image is { size, png } or { size, rgba }:
 * PNG data is stored as-is (Windows Vista+), RGBA becomes a classic 32-bit DIB, which
 * every consumer (resource editors, NSIS, the shell) reads.
 * @param {{ size: number, png?: Uint8Array, rgba?: Uint8Array }[]} images
 */
function encodeIco(images) {
  if (images.length === 0) throw new Error('an icon needs at least one image')
  const blobs = images.map((img) => {
    if (img.size < 1 || img.size > 256) throw new Error(`icon size ${img.size} is outside 1-256`)
    if (img.png) return Buffer.from(img.png)
    if (img.rgba) return encodeIconDib(img.size, img.size, img.rgba)
    throw new Error(`icon image ${img.size} has neither png nor rgba data`)
  })
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach((img, i) => {
    const e = 6 + i * 16
    header[e] = img.size === 256 ? 0 : img.size
    header[e + 1] = img.size === 256 ? 0 : img.size
    header[e + 2] = 0
    header[e + 3] = 0
    header.writeUInt16LE(1, e + 4)
    header.writeUInt16LE(32, e + 6)
    header.writeUInt32LE(blobs[i].length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += blobs[i].length
  })
  return Buffer.concat([header, ...blobs])
}

/** Parses an .ico file into its directory entries (throws on malformed input). */
function parseIco(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an .ico file')
  const count = buf.readUInt16LE(4)
  if (buf.length < 6 + count * 16) throw new Error('truncated .ico directory')
  const entries = []
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16
    const bytes = buf.readUInt32LE(e + 8)
    const offset = buf.readUInt32LE(e + 12)
    if (offset + bytes > buf.length) throw new Error(`.ico image ${i} points outside the file`)
    const data = buf.subarray(offset, offset + bytes)
    entries.push({
      width: buf[e] || 256,
      height: buf[e + 1] || 256,
      bitCount: buf.readUInt16LE(e + 6),
      format: isPng(data) ? 'png' : 'bmp',
      data
    })
  }
  return entries
}

function isPng(data) {
  return data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(PNG_SIGNATURE)
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png) {
  if (!isPng(png) || png.length < 24) throw new Error('not a PNG')
  const b = Buffer.from(png)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

/**
 * 24-bit bottom-up .bmp file (what NSIS wants for installer sidebar/header images).
 * Alpha is composited over `background` ([r, g, b]).
 */
function encodeBmp24(width, height, rgba, background = [255, 255, 255]) {
  if (rgba.length !== width * height * 4) throw new Error(`expected ${width * height * 4} RGBA bytes, got ${rgba.length}`)
  const stride = Math.ceil((width * 3) / 4) * 4
  const out = Buffer.alloc(54 + stride * height)
  out.write('BM', 0, 'ascii')
  out.writeUInt32LE(out.length, 2)
  out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(width, 18)
  out.writeInt32LE(height, 22)
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(24, 28)
  out.writeUInt32LE(stride * height, 34)
  out.writeInt32LE(2835, 38) // 72 dpi
  out.writeInt32LE(2835, 42)
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4
    const dst = 54 + y * stride
    for (let x = 0; x < width; x++) {
      const s = src + x * 4
      const a = rgba[s + 3] / 255
      const d = dst + x * 3
      out[d] = Math.round(rgba[s + 2] * a + background[2] * (1 - a))
      out[d + 1] = Math.round(rgba[s + 1] * a + background[1] * (1 - a))
      out[d + 2] = Math.round(rgba[s] * a + background[0] * (1 - a))
    }
  }
  return out
}

module.exports = { encodeIco, encodeIconDib, parseIco, isPng, pngSize, encodeBmp24 }
