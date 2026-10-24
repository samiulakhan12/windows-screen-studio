import { describe, expect, it, vi } from 'vitest'
import type { DesktopIconsAction, DesktopIconsResult } from '../src/main/nativeCapture'
import { DesktopIcons, type DesktopIconsDeps } from '../src/main/recording/desktopIcons'

/** A desktop whose icons the fake helper hides and shows, and a persisted flag. */
function setup(opts: { platform?: NodeJS.Platform; visible?: boolean; fail?: DesktopIconsAction[]; hidden?: boolean; saveFails?: boolean } = {}) {
  const desktop = { visible: opts.visible ?? true }
  const calls: string[] = []
  const saved = { hidden: opts.hidden ?? false }
  const apply = (action: DesktopIconsAction): DesktopIconsResult => {
    calls.push(action)
    if (opts.fail?.includes(action)) return { ok: false, message: `${action} failed` }
    const before = desktop.visible
    if (action === 'hide') desktop.visible = false
    if (action === 'show') desktop.visible = true
    return { ok: true, visible: desktop.visible, changed: before !== desktop.visible }
  }
  const deps: DesktopIconsDeps = {
    platform: opts.platform ?? 'win32',
    run: async (action) => {
      await new Promise((r) => setTimeout(r, 5))
      return apply(action)
    },
    runSync: apply,
    state: {
      get desktopIconsHidden() {
        return saved.hidden
      },
      setDesktopIconsHidden(hidden) {
        if (opts.saveFails) throw new Error('disk full')
        saved.hidden = hidden
      }
    }
  }
  return { icons: new DesktopIcons(deps), desktop, calls, saved }
}

describe('DesktopIcons', () => {
  it('hides for a recording and restores afterwards', async () => {
    const { icons, desktop, saved } = setup()
    expect(await icons.hide()).toBe(true)
    expect(desktop.visible).toBe(false)
    expect(saved.hidden).toBe(true)
    await icons.restore()
    expect(desktop.visible).toBe(true)
    expect(saved.hidden).toBe(false)
  })

  it('restores at the next app start when the app died while they were hidden', async () => {
    const { icons, desktop, calls, saved } = setup({ visible: false, hidden: true })
    await icons.restore()
    expect(calls).toEqual(['show'])
    expect(desktop.visible).toBe(true)
    expect(saved.hidden).toBe(false)
  })

  it('leaves icons alone that the user had hidden already (never shows them)', async () => {
    const { icons, desktop, calls, saved } = setup({ visible: false })
    expect(await icons.hide()).toBe(false)
    expect(saved.hidden).toBe(false)
    await icons.restore()
    expect(calls).toEqual(['hide'])
    expect(desktop.visible).toBe(false)
  })

  it('a cancel right after starting waits for the hide, then restores', async () => {
    const { icons, desktop, calls } = setup()
    const hiding = icons.hide()
    const restoring = icons.restore()
    await Promise.all([hiding, restoring])
    expect(calls).toEqual(['hide', 'show'])
    expect(desktop.visible).toBe(true)
  })

  it('keeps the flag when showing fails, so the next stop or start tries again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { icons, saved } = setup({ fail: ['show'] })
    await icons.hide()
    await icons.restore()
    expect(saved.hidden).toBe(true)
    warn.mockRestore()
  })

  it('does not hide when it cannot remember doing so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { icons, calls, desktop } = setup({ saveFails: true })
    expect(await icons.hide()).toBe(false)
    expect(calls).toEqual([])
    expect(desktop.visible).toBe(true)
    warn.mockRestore()
  })

  it('a failed hide leaves nothing to restore', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { icons, saved } = setup({ fail: ['hide'] })
    expect(await icons.hide()).toBe(false)
    expect(saved.hidden).toBe(false)
    warn.mockRestore()
  })

  it('restores synchronously when the app quits', async () => {
    const { icons, desktop, saved, calls } = setup()
    await icons.hide()
    icons.restoreSync()
    expect(desktop.visible).toBe(true)
    expect(saved.hidden).toBe(false)
    icons.restoreSync()
    expect(calls).toEqual(['hide', 'show'])
  })

  it('does nothing outside Windows', async () => {
    const { icons, calls } = setup({ platform: 'linux', hidden: true })
    expect(await icons.hide()).toBe(false)
    await icons.restore()
    icons.restoreSync()
    expect(calls).toEqual([])
  })
})
