// Renders the Flown app icon masters (assets/brand, from the brand kit) with Electron's own
// Chromium (no extra tools needed) and writes
//   build/icon.ico                 16, 20, 24, 32, 40 (flown-app-icon-small.svg: the kit's art for
//                                  under 48 px) and 48, 64, 96, 128, 256 (flown-app-icon.svg)
//   build/icon.png                 512 px (window icon in development, Linux, docs)
//   build/installerSidebar.bmp     164x314 NSIS welcome/finish page image (build/installer-sidebar.svg)
// Run with: npm run icons   (Linux needs a display: xvfb-run -a npm run icons)
'use strict'

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { encodeIco, encodeBmp24 } = require('../lib/ico.cjs')

const BUILD = path.resolve(__dirname, '../../build')
const BRAND = path.resolve(__dirname, '../../assets/brand')
const SMALL_SIZES = [16, 20, 24, 32, 40]
const LARGE_SIZES = [48, 64, 96, 128, 256]
const ICON = path.join(BRAND, 'flown-app-icon.svg')
const ICON_SMALL = path.join(BRAND, 'flown-app-icon-small.svg')

// Runs inside the page: rasterises an SVG at the exact target size (vector, not a downscale).
async function rasterise(svg, width, height) {
  const img = new Image()
  img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, width, height)
  const rgba = ctx.getImageData(0, 0, width, height).data
  let bin = ''
  for (let i = 0; i < rgba.length; i += 0x8000) bin += String.fromCharCode.apply(null, rgba.subarray(i, i + 0x8000))
  return { png: canvas.toDataURL('image/png').split(',')[1], rgba: btoa(bin) }
}

async function main() {
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8"><body></body>')
  const render = async (file, width, height = width) => {
    const svg = fs.readFileSync(path.resolve(BUILD, file), 'utf8')
    const r = await win.webContents.executeJavaScript(`(${rasterise})(${JSON.stringify(svg)}, ${width}, ${height})`)
    return { png: Buffer.from(r.png, 'base64'), rgba: Buffer.from(r.rgba, 'base64') }
  }

  const images = []
  for (const size of SMALL_SIZES) images.push({ size, rgba: (await render(ICON_SMALL, size)).rgba })
  for (const size of LARGE_SIZES) {
    const r = await render(ICON, size)
    // PNG only for 256 px: the classic DIB format keeps small sizes readable by every consumer.
    images.push(size === 256 ? { size, png: r.png } : { size, rgba: r.rgba })
  }
  write('icon.ico', encodeIco(images))
  write('icon.png', (await render(ICON, 512)).png)
  const sidebar = await render('installer-sidebar.svg', 164, 314)
  write('installerSidebar.bmp', encodeBmp24(164, 314, sidebar.rgba))
}

function write(name, data) {
  fs.writeFileSync(path.join(BUILD, name), data)
  console.log(`icons: build/${name} (${data.length} bytes)`)
}

app.disableHardwareAcceleration() // CPU raster: identical output on every machine with this Electron
app
  .whenReady()
  .then(main)
  .then(
    () => app.exit(0),
    (err) => {
      console.error(err)
      app.exit(1)
    }
  )
