import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Autosaver, type SaveMeta } from '../src/shared/editor/autosave'
import { EditStore } from '../src/shared/editor/editStore'

interface Call {
  doc: number
  meta: SaveMeta
}

function setup(fail: () => Error | null = () => null): {
  store: EditStore<number>
  saver: Autosaver<number>
  calls: Call[]
  syncCalls: Call[]
} {
  const store = new EditStore(0)
  const calls: Call[] = []
  const syncCalls: Call[] = []
  const saver = new Autosaver(
    store,
    {
      save: (doc, meta) => {
        calls.push({ doc, meta })
        const err = fail()
        return err ? Promise.reject(err) : Promise.resolve()
      },
      saveSync: (doc, meta) => {
        syncCalls.push({ doc, meta })
        const err = fail()
        return err ? { ok: false, error: err.message } : { ok: true }
      }
    },
    { debounceMs: 400, maxWaitMs: 2000 }
  )
  return { store, saver, calls, syncCalls }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Autosaver', () => {
  it('debounces edits into one save of the latest state', async () => {
    const { store, saver, calls } = setup()
    store.update(() => 1)
    store.update(() => 2)
    expect(saver.status.state).toBe('pending')
    await vi.advanceTimersByTimeAsync(399)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.map((c) => c.doc)).toEqual([2])
    expect(saver.status.state).toBe('saved')
    expect(saver.dirty).toBe(false)
  })

  it('does not let continuous editing postpone saving forever', async () => {
    const { store, calls } = setup()
    for (let i = 1; i <= 30; i++) {
      store.update(() => i)
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it('shows a failure, retries with backoff and recovers', async () => {
    let failing = true
    const { store, saver, calls } = setup(() => (failing ? new Error("Error invoking remote method 'projects:save': Error: EPERM: operation not permitted") : null))
    store.update(() => 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(saver.status).toEqual({ state: 'error', message: 'EPERM: operation not permitted', retryInMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(2)
    expect(saver.status).toMatchObject({ state: 'error', retryInMs: 2000 })
    failing = false
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toHaveLength(3)
    expect(saver.status.state).toBe('saved')
  })

  it('flush saves immediately and reports success', async () => {
    const { store, saver, calls } = setup()
    store.update(() => 4)
    await expect(saver.flush()).resolves.toBe(true)
    expect(calls.map((c) => c.doc)).toEqual([4])
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(1)
  })

  it('flush reports failure so the caller can warn before leaving', async () => {
    const { store, saver } = setup(() => new Error('disk full'))
    store.update(() => 4)
    await expect(saver.flush()).resolves.toBe(false)
    saver.dispose()
  })

  it('flushSync writes the latest state with a newer sequence number than earlier saves', async () => {
    const { store, saver, calls, syncCalls } = setup()
    store.update(() => 1)
    await vi.advanceTimersByTimeAsync(400)
    store.update(() => 2)
    expect(saver.flushSync()).toBe(true)
    expect(syncCalls.map((c) => c.doc)).toEqual([2])
    expect(syncCalls[0].meta.session).toBe(calls[0].meta.session)
    expect(syncCalls[0].meta.seq).toBeGreaterThan(calls[0].meta.seq)
    expect(saver.flushSync()).toBe(true)
    expect(syncCalls).toHaveLength(1)
  })

  it('saves edits made while a save was in flight', async () => {
    let release: () => void = () => undefined
    const store = new EditStore(0)
    const docs: number[] = []
    const saver = new Autosaver(store, {
      save: (doc) => {
        docs.push(doc)
        return new Promise<void>((r) => (release = r))
      },
      saveSync: () => ({ ok: true })
    })
    store.update(() => 1)
    await vi.advanceTimersByTimeAsync(400)
    store.update(() => 2)
    release()
    await vi.advanceTimersByTimeAsync(400)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(docs).toEqual([1, 2])
    expect(saver.dirty).toBe(false)
  })

  it('markDirty saves an automatically corrected state', async () => {
    const { saver, calls } = setup()
    saver.markDirty()
    await vi.advanceTimersByTimeAsync(400)
    expect(calls).toHaveLength(1)
  })
})
