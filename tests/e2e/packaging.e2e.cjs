// Packaging: the running app's window carries the app icon (not Electron's), and, when an
// installer has been built (npm run dist:win), the packaged output passes scripts/verify-dist.mjs.
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')

// Reads _NET_WM_ICON (the window icon the X11 client publishes) through libX11.
const READ_X11_ICON = `
import ctypes, json, sys
x = ctypes.cdll.LoadLibrary('libX11.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x.XInternAtom.restype = ctypes.c_ulong
x.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int,
  ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
  ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong))]
d = x.XOpenDisplay(None)
atom = x.XInternAtom(d, b'_NET_WM_ICON', 0)
t, f, n, after = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong()
data = ctypes.POINTER(ctypes.c_ulong)()
x.XGetWindowProperty(d, int(sys.argv[1]), atom, 0, 1 << 24, 0, 0, ctypes.byref(t), ctypes.byref(f), ctypes.byref(n), ctypes.byref(after), ctypes.byref(data))
values = [data[i] & 0xffffffff for i in range(n.value)]
icons, i = [], 0
while i + 2 <= len(values):
  w, hgt = values[i], values[i + 1]
  px = values[i + 2:i + 2 + w * hgt]
  sample = lambda fx, fy: px[int(fy * hgt) * w + int(fx * w)]
  icons.append({'w': w, 'h': hgt, 'tile': sample(0.1, 0.5), 'frame': sample(0.5, 0.25), 'corner': sample(0.0, 0.0)})
  i += 2 + w * hgt
print(json.dumps(icons))
`

const argb = (v) => ({ a: (v >>> 24) & 255, r: (v >>> 16) & 255, g: (v >>> 8) & 255, b: v & 255 })

async function windowIcon(ctx) {
  const home = h.tempHome('packaging')
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForLoadState('domcontentloaded')
  const xid = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((b) => !b.webContents.getURL().includes('#/toolbar'))
    const handle = w?.getNativeWindowHandle()
    return handle ? Number(handle.length >= 8 ? handle.readBigUInt64LE(0) : handle.readUInt32LE(0)) : null
  })
  h.assert(xid, 'main window has a native X11 handle')
  let icons = []
  for (let i = 0; i < 20 && icons.length === 0; i++) {
    icons = JSON.parse(execFileSync('python3', ['-I', '-c', READ_X11_ICON, String(xid)]).toString())
    if (!icons.length) await h.sleep(250)
  }
  h.assert(icons.length > 0, 'the main window publishes an icon (_NET_WM_ICON)')
  const big = icons.reduce((a, b) => (b.w > a.w ? b : a))
  h.assert(big.w === big.h && big.w >= 64, `square icon of at least 64 px (got ${big.w}x${big.h})`)
  // build/icon.png: transparent corners, a violet tile, a white screen frame. Electron's default
  // icon is a dark tile with a cyan atom, so these samples tell the two apart.
  const tile = argb(big.tile)
  const frame = argb(big.frame)
  h.assert(argb(big.corner).a < 16, `transparent corner (${JSON.stringify(argb(big.corner))})`)
  h.assert(tile.a > 240 && tile.r > 100 && tile.b > 180 && tile.g < 110, `violet tile (${JSON.stringify(tile)})`)
  h.assert(frame.a > 240 && frame.r > 235 && frame.g > 235 && frame.b > 235, `white screen frame (${JSON.stringify(frame)})`)
  console.log(`  window icon sizes: ${icons.map((i) => `${i.w}x${i.h}`).join(', ')}`)
}

async function packagedOutput() {
  const unpacked = path.join(h.APP_DIR, 'dist', 'win-unpacked')
  if (!fs.existsSync(unpacked)) {
    console.log('  SKIP: no dist/win-unpacked (run npm run dist:win to build the installer first)')
    return
  }
  const r = spawnSync(process.execPath, [path.join(h.APP_DIR, 'scripts', 'verify-dist.mjs')], { encoding: 'utf8' })
  process.stdout.write(r.stdout.replace(/^(?=.)/gm, '  '))
  h.assert(r.status === 0, `verify-dist exit code ${r.status}\n${r.stderr}`)
}

;(async () => {
  await h.run('packaging: window icon is the app icon', windowIcon)
  await h.run('packaging: built Windows package passes verify-dist (when dist/ exists)', packagedOutput)
})()
