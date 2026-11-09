import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * Certificate checks stay on in a packaged app (docs/design/smart-tools.md §16.4, §22 test 86): the
 * TLS guard, imported first by main, deletes NODE_TLS_REJECT_UNAUTHORIZED, so "=0" in the user's
 * environment cannot silently turn off the checks for fetch, and a self-signed server is refused.
 * Unpackaged (development and the tests) the variable is left alone.
 */

const h = vi.hoisted(() => ({ packaged: false }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.packaged
    }
  }
}))

const CERT = fs.readFileSync(path.join(__dirname, 'fixtures', 'tls', 'localhost-test-cert.pem'))
const KEY = fs.readFileSync(path.join(__dirname, 'fixtures', 'tls', 'localhost-test-key.pem'))

/** A fresh self-signed server (a new connection each time: none is reused across the cases). */
async function selfSigned(): Promise<{ url: string; close(): Promise<void> }> {
  const srv = https.createServer({ cert: CERT, key: KEY }, (_req, res) => {
    res.writeHead(200, { connection: 'close' })
    res.end('ok')
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { url: `https://localhost:${(srv.address() as AddressInfo).port}/`, close: () => new Promise((r) => srv.close(() => r())) }
}

const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED
afterEach(() => {
  if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before
  h.packaged = false
  vi.resetModules()
})

describe('the TLS guard (test 86)', () => {
  it('unpackaged, the variable is left (and it does turn certificate checks off for fetch)', async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    await import('../src/main/ai/tlsGuard')
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('0')
    const s = await selfSigned()
    try {
      expect(await (await fetch(s.url)).text()).toBe('ok')
    } finally {
      await s.close()
      warn.mockRestore()
    }
  })

  it('packaged, it is removed before the first request and a self-signed server is refused', async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    h.packaged = true
    await import('../src/main/ai/tlsGuard')
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
    const s = await selfSigned()
    try {
      const err = await fetch(s.url).then(
        () => null,
        (e: unknown) => e as Error & { cause?: { code?: string } }
      )
      expect(err).not.toBeNull()
      expect(String(err!.cause?.code ?? err!.cause)).toMatch(/SELF_SIGNED|CERT|certificate/i)
    } finally {
      await s.close()
    }
  })
})
