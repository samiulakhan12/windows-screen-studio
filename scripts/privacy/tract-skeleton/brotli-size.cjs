// Prints each file's size and its brotli size at quality 11 with a 16 MB window (as
// scripts/lib/packaging.cjs measures the shipped helpers).
const fs = require('node:fs')
const zlib = require('node:zlib')
for (const f of process.argv.slice(2)) {
  const buf = fs.readFileSync(f)
  const c = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length
  console.log(JSON.stringify({ file: f.split('/').slice(-3).join('/'), bytes: buf.length, brotli11: c }))
}
