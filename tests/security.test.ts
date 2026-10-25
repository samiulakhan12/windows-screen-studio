// Window guards (src/main/security.ts): which URLs count as the app's page, which permissions
// it gets, and that navigation away from it and new windows are blocked.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: true }, session: {} }))

import { guardWebContents, isAppUrl, permissionAllowed, type AppPage } from '../src/main/security'

const indexFile = path.resolve('/opt/Flown/resources/app.asar/out/renderer/index.html')
const built: AppPage = { devUrl: null, indexFile }
const page = pathToFileURL(indexFile).href

describe('isAppUrl', () => {
  it('accepts the built page at any route', () => {
    expect(isAppUrl(page, built)).toBe(true)
    expect(isAppUrl(`${page}#/toolbar`, built)).toBe(true)
    expect(isAppUrl(`${page}#/editor/rec-1`, built)).toBe(true)
  })

  it('refuses other local files, other schemes and malformed URLs', () => {
    expect(isAppUrl(pathToFileURL(path.resolve('/tmp/evil.html')).href, built)).toBe(false)
    expect(isAppUrl(pathToFileURL(path.join(path.dirname(indexFile), 'other.html')).href, built)).toBe(false)
    expect(isAppUrl(page.replace('index.html', 'index.html/../../evil.html'), built)).toBe(false)
    expect(isAppUrl('file://server/share/index.html', built)).toBe(false)
    for (const url of ['https://example.com/', 'about:blank', 'data:text/html,<p>', 'studio-media://project/rec-1/screen.mp4', '', 'not a url']) {
      expect(isAppUrl(url, built)).toBe(false)
    }
  })

  it('accepts the dev server origin only while developing', () => {
    const dev: AppPage = { devUrl: 'http://localhost:5173', indexFile }
    expect(isAppUrl('http://localhost:5173/#/toolbar', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isAppUrl(page, dev)).toBe(false)
  })
})

describe('permissionAllowed', () => {
  it('gives the app page the camera, microphone, screen and clipboard writes only', () => {
    for (const p of ['media', 'display-capture', 'clipboard-sanitized-write']) expect(permissionAllowed(p, `${page}#/`, built)).toBe(true)
    for (const p of ['geolocation', 'notifications', 'clipboard-read', 'openExternal', 'midi']) expect(permissionAllowed(p, page, built)).toBe(false)
  })

  it('gives any other page nothing', () => {
    for (const p of ['media', 'display-capture', 'clipboard-sanitized-write']) {
      expect(permissionAllowed(p, pathToFileURL(path.resolve('/tmp/evil.html')).href, built)).toBe(false)
      expect(permissionAllowed(p, 'https://example.com/', built)).toBe(false)
    }
  })
})

describe('guardWebContents', () => {
  it('cancels navigation and redirects away from the app page and denies new windows', () => {
    const listeners = new Map<string, (e: { preventDefault: () => void }, url: string) => void>()
    let openHandler: ((details: { url: string }) => { action: string }) | null = null
    const wc = {
      on: (event: string, fn: (e: { preventDefault: () => void }, url: string) => void) => listeners.set(event, fn),
      setWindowOpenHandler: (fn: typeof openHandler) => (openHandler = fn)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    guardWebContents(wc as never)
    const navigate = (event: string, url: string): boolean => {
      const e = { preventDefault: vi.fn() }
      listeners.get(event)!(e, url)
      return e.preventDefault.mock.calls.length === 0
    }
    // appPage() looks next to the module: src/renderer/index.html here, out/renderer/index.html in the build.
    const own = pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href
    expect(navigate('will-navigate', `${own}#/`)).toBe(true)
    expect(navigate('will-navigate', pathToFileURL(path.resolve('/tmp/evil.html')).href)).toBe(false)
    expect(navigate('will-navigate', 'https://example.com/')).toBe(false)
    expect(navigate('will-redirect', 'https://example.com/')).toBe(false)
    expect(openHandler!({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    warn.mockRestore()
  })
})
