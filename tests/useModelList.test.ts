import { describe, expect, it, vi } from 'vitest'
import { BUNDLED_MODEL_LIST, type ModelList } from '../src/shared/ai/modelList'

/*
 * useModelList() without a DOM: React's two hooks are swapped for a mount that keeps its state, and
 * window.api is main, whose list changes when it refreshes it while Flown runs.
 */

interface Mount {
  value?: unknown
  cleanup?: (() => void) | void
}
let mount: Mount = {}

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: (init: unknown) => {
    const m = mount
    if (!('value' in m)) m.value = init
    return [m.value, (v: unknown) => (m.value = v)]
  },
  useEffect: (fn: () => (() => void) | void) => {
    mount.cleanup = fn()
  }
}))

const main = { list: BUNDLED_MODEL_LIST as ModelList, fail: false, asks: 0 }
vi.stubGlobal('window', {
  api: {
    getAiModelList: () => {
      main.asks++
      return main.fail ? Promise.reject(new Error('IPC failed')) : Promise.resolve(main.list)
    }
  }
})

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const HOOK = '../src/renderer/src/settings/useModelList'
const { useModelList } = (await import(/* @vite-ignore */ HOOK)) as { useModelList: () => ModelList | null }

/** Settings (or the provider form) opens: the hook runs once and its effect starts. */
function open(): Mount {
  mount = {}
  useModelList()
  return mount
}
const answered = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const listOf = (updated: string, model: string): ModelList => ({ ...BUNDLED_MODEL_LIST, updated, providers: { ...BUNDLED_MODEL_LIST.providers, openai: { model, transcriptionModel: 'whisper-1' } } })

describe('useModelList (docs/design/auto-update.md §3)', () => {
  it('asks main each time it opens, so a list main refreshed reaches Settings', async () => {
    const a = listOf('2026-10-30', 'gpt-a')
    const b = listOf('2026-11-05', 'gpt-b')
    main.list = a
    const first = open()
    await answered()
    expect(first.value).toBe(a)
    // Main refreshes its list later in the session; Settings opens again.
    main.list = b
    const asks = main.asks
    const second = open()
    expect(second.value).toBe(a)
    await answered()
    expect(main.asks).toBe(asks + 1)
    expect(second.value).toBe(b)
  })

  it('a failed ask keeps the last answer, and the next open asks again', async () => {
    const a = listOf('2026-12-01', 'gpt-c')
    main.list = a
    open()
    await answered()
    main.fail = true
    const failed = open()
    await answered()
    expect(failed.value).toBe(a)
    main.fail = false
    const b = listOf('2026-12-02', 'gpt-d')
    main.list = b
    const again = open()
    await answered()
    expect(again.value).toBe(b)
  })

  it('an answer that comes after it closed is dropped', async () => {
    main.list = listOf('2026-12-03', 'gpt-e')
    const m = open()
    const before = m.value
    m.cleanup?.()
    await answered()
    expect(m.value).not.toBe(main.list)
    expect(m.value).toBe(before)
  })
})
