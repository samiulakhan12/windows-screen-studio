/** The copy pack's text requests in the main process (aiIpc): named requests, cancelling, effort, sender checks. */
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  calls: [] as { prompt: { name: string; system: string; user: string }; signal: AbortSignal; effort: string; resolve: (v: unknown) => void }[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent', isPackaged: false, on: () => undefined },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  safeStorage: {}
}))
vi.mock('../src/main/ai/keyStore', () => ({
  AiProviderStore: class {
    get(id: unknown) {
      if (id !== 'p1') throw new Error('Unknown provider')
      return { info: { id: 'p1', kind: 'openai' }, apiKey: 'k' }
    }
  }
}))
vi.mock('../src/main/ai/providers', () => ({
  clientFor: async () => ({
    json: (prompt: { name: string; system: string; user: string }, opts: { signal: AbortSignal; effort: string }) =>
      new Promise((resolve, reject) => {
        h.calls.push({ prompt, signal: opts.signal, effort: opts.effort, resolve })
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
  })
}))
vi.mock('../src/main/ai/transcribe', () => ({
  stopAllTranscriptions: () => undefined,
  stopTranscription: () => undefined,
  sweepTranscribeTemp: async () => undefined,
  transcribeProject: async () => undefined
}))

import { aiText, cancelAiText, readRequestId, registerAiIpc } from '../src/main/aiIpc'

const segments = [{ id: 'a', start: 0, end: 3, text: 'Open the settings page and add a new user to the team.' }]
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('copy pack requests (aiIpc)', () => {
  registerAiIpc()
  const url = pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href
  const appEvent = (sender = new EventEmitter()): { senderFrame: { url: string }; sender: EventEmitter } => ({ senderFrame: { url }, sender })

  it('reads request ids strictly', () => {
    expect(readRequestId(undefined)).toBeUndefined()
    expect(readRequestId('pub-1_A')).toBe('pub-1_A')
    for (const bad of ['', 'a b', 'x'.repeat(65), '../x', 5, {}]) expect(() => readRequestId(bad)).toThrow('Invalid request id.')
  })

  it('answers the app page only', async () => {
    const other = { senderFrame: { url: 'https://example.com/' }, sender: new EventEmitter() }
    await expect(h.handlers.get('ai:text')!(other, 'p1', { task: 'xpost', segments }, 'pub-1')).rejects.toThrow('Not allowed')
    expect(() => h.handlers.get('ai:cancelText')!(other, 'pub-1')).toThrow('Not allowed')
  })

  it('runs a pack task with its prompt and effort, and checks the answer', async () => {
    h.calls.length = 0
    const p = h.handlers.get('ai:text')!(appEvent(), 'p1', { task: 'xpost', segments, tone: 'casual', length: 'short' }, 'pub-1') as Promise<unknown>
    await tick()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].prompt.name).toBe('x_post')
    expect(h.calls[0].effort).toBe('low')
    h.calls[0].resolve({ text: 'New video: adding users \u0000in a minute' })
    await expect(p).resolves.toEqual({ task: 'xpost', text: 'New video: adding users in a minute' })
    h.calls.length = 0
    const q = aiText('p1', { task: 'article', segments })
    await tick()
    expect(h.calls[0].effort).toBe('medium')
    h.calls[0].resolve({ title: 'Add a user', intro: '', sections: [] })
    await expect(q).rejects.toThrow(/no steps/)
  })

  it('cancels a named request, and a second request with the same id replaces the first', async () => {
    h.calls.length = 0
    const a = aiText('p1', { task: 'linkedin', segments }, 'pub-2').catch((e: Error) => e)
    const b = aiText('p1', { task: 'youtube', segments }, 'pub-3').catch((e: Error) => e)
    await tick()
    expect(h.calls).toHaveLength(2)
    cancelAiText('pub-2')
    expect(await a).toMatchObject({ message: 'aborted' })
    expect(h.calls[1].signal.aborted).toBe(false)
    const again = aiText('p1', { task: 'youtube', segments }, 'pub-3')
    expect(await b).toMatchObject({ message: 'aborted' })
    await tick()
    h.calls[2].resolve({ description: 'Adding users.', tags: ['users'] })
    await expect(again).resolves.toEqual({ task: 'youtube', text: 'Adding users.', tags: ['users'] })
    // Nothing runs under that id now: cancelling it is harmless.
    expect(() => cancelAiText('pub-3')).not.toThrow()
  })

  it('a request cancelled before the provider is ready never sends', async () => {
    h.calls.length = 0
    const a = aiText('p1', { task: 'linkedin', segments }, 'pub-4').catch((e: Error) => e)
    cancelAiText('pub-4')
    expect(await a).toBeInstanceOf(Error)
    await tick()
    expect(h.calls).toHaveLength(0)
  })

  it('a page that goes away stops its named requests', async () => {
    h.calls.length = 0
    const sender = new EventEmitter()
    const p = (h.handlers.get('ai:text')!(appEvent(sender), 'p1', { task: 'linkedin', segments }, 'pub-5') as Promise<unknown>).catch((e: Error) => e)
    await tick()
    sender.emit('did-navigate')
    expect(await p).toMatchObject({ message: 'aborted' })
    expect(sender.listenerCount('destroyed')).toBe(0)
  })

  it('a request without an id works as before', async () => {
    h.calls.length = 0
    const p = h.handlers.get('ai:text')!({ senderFrame: { url } }, 'p1', { task: 'title', segments }) as Promise<unknown>
    await tick()
    h.calls[0].resolve({ text: 'Adding users' })
    await expect(p).resolves.toEqual({ task: 'title', text: 'Adding users' })
  })
})
