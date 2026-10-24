import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/nonexistent', prependListener: () => undefined },
  screen: {}
}))

import { desktopIcons, desktopIconsSync } from '../src/main/nativeCapture'

/** A stand-in helper: `desktop-icons <action>` prints what the real one would, per scenario. */
const FAKE = `
const [cmd, action] = process.argv.slice(2)
const mode = process.env.FAKE_ICONS
if (cmd !== 'desktop-icons') process.exit(2)
if (mode === 'none') {
  console.log(JSON.stringify({ event: 'error', message: 'The desktop icons were not found (Explorer is not the shell, or not running)' }))
  process.exit(4)
}
if (mode === 'garbage') {
  console.log('not json')
  process.exit(0)
}
console.log('a log line')
console.log(JSON.stringify({ visible: action === 'show' || (action === 'status'), changed: action !== 'status' }))
`

let dir = ''
const saved = { helper: process.env.SSW_CAPTURE_HELPER, mode: process.env.FAKE_ICONS }

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ssw-icons-client-'))
  const file = path.join(dir, 'helper.cjs')
  writeFileSync(file, FAKE)
  process.env.SSW_CAPTURE_HELPER = file
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  process.env.SSW_CAPTURE_HELPER = saved.helper
  process.env.FAKE_ICONS = saved.mode
  if (saved.helper === undefined) delete process.env.SSW_CAPTURE_HELPER
  if (saved.mode === undefined) delete process.env.FAKE_ICONS
})

describe('desktopIcons client', () => {
  it('reads the helper result, async and sync', async () => {
    expect(await desktopIcons('hide')).toEqual({ ok: true, visible: false, changed: true })
    expect(await desktopIcons('status')).toEqual({ ok: true, visible: true, changed: false })
    expect(desktopIconsSync('show', 20000)).toEqual({ ok: true, visible: true, changed: true })
  })

  it('reports a missing desktop and malformed output as failures, never throwing', async () => {
    process.env.FAKE_ICONS = 'none'
    const none = await desktopIcons('hide')
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.message).toMatch(/exit code 4.*not found/)
    expect(desktopIconsSync('show', 20000).ok).toBe(false)
    process.env.FAKE_ICONS = 'garbage'
    expect((await desktopIcons('status')).ok).toBe(false)
  })

  it('is unavailable without a helper (not Windows)', async () => {
    process.env.SSW_CAPTURE_HELPER = path.join(dir, 'missing.cjs')
    expect(await desktopIcons('hide')).toMatchObject({ ok: false, message: expect.stringMatching(/Windows only/) })
    expect(desktopIconsSync('show')).toMatchObject({ ok: false })
  })
})
