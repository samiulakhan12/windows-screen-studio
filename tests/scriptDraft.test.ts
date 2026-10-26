import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  /** Pending json() calls of the fake provider client. */
  calls: [] as { prompt: { system: string; user: string }; signal: AbortSignal; effort: string; resolve: (v: unknown) => void }[]
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
      return { info: { id: 'p1', kind: 'anthropic' }, apiKey: 'k' }
    }
  }
}))
vi.mock('../src/main/ai/providers', () => ({
  clientFor: async () => ({
    json: (prompt: { system: string; user: string }, opts: { signal: AbortSignal; effort: string }) =>
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

import { cancelScriptDraft, draftScript, registerAiIpc } from '../src/main/aiIpc'
import { SCRIPT_DRAFT_MAX_NOTES } from '../src/shared/api/ai'
import { AiOutputError } from '../src/shared/captions/transcriptText'
import { cleanNotesText, NOTES_TEXT_MAX } from '../src/shared/notes/notes'
import {
  runScriptDraft,
  SCRIPT_EFFORT,
  SCRIPT_LIMITS,
  SCRIPT_SCHEMA_NAME,
  SCRIPT_SYSTEM_START,
  SCRIPT_USER_START,
  scriptPrompt,
  validateScriptAnswer,
  validateScriptRequest
} from '../src/shared/notes/scriptDraft'

const message = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    return (err as Error).message
  }
  throw new Error('expected a failure')
}

describe('validateScriptRequest', () => {
  it('rejects requests without usable notes, with a message', () => {
    expect(message(() => validateScriptRequest({}))).toMatch(/notes as text/)
    expect(message(() => validateScriptRequest({ notes: '' }))).toMatch(/bullet points first/)
    expect(message(() => validateScriptRequest({ notes: '   \n ' }))).toMatch(/bullet points first/)
    expect(message(() => validateScriptRequest({ notes: 'x'.repeat(SCRIPT_DRAFT_MAX_NOTES + 1) }))).toMatch(/up to 20,000 characters/)
    expect(message(() => validateScriptRequest({ notes: 42 }))).toMatch(/notes as text/)
    expect(message(() => validateScriptRequest(null))).toMatch(/notes as text/)
  })

  it('accepts 1 to 20,000 characters', () => {
    expect(validateScriptRequest({ notes: 'a' })).toEqual({ notes: 'a' })
    expect(validateScriptRequest({ notes: 'x'.repeat(SCRIPT_DRAFT_MAX_NOTES), extra: 1 })).toEqual({ notes: 'x'.repeat(SCRIPT_DRAFT_MAX_NOTES) })
  })
})

describe('scriptPrompt', () => {
  it('is a strict schema named spoken_script, the notes marked as data', () => {
    const p = scriptPrompt({ notes: '- Open Settings' })
    expect(p.name).toBe(SCRIPT_SCHEMA_NAME)
    expect(p.name).toBe('spoken_script')
    expect(p.schema).toEqual({ type: 'object', properties: { paragraphs: { type: 'array', items: { type: 'string' } } }, required: ['paragraphs'], additionalProperties: false })
    expect(p.system.startsWith(SCRIPT_SYSTEM_START)).toBe(true)
    expect(p.system).toContain('never add facts')
    expect(p.system).toContain('If the notes are already a script, only smooth the wording.')
    expect(p.user).toBe(SCRIPT_USER_START + '- Open Settings')
  })
})

describe('validateScriptAnswer', () => {
  const notes = 'a few notes'
  it('refuses answers it cannot use', () => {
    for (const bad of [{}, null, 'text', { paragraphs: [] }, { paragraphs: ['  '] }, { paragraphs: [1] }, { paragraphs: Array(SCRIPT_LIMITS.paragraphsMax + 1).fill('Hi.') }]) {
      expect(() => validateScriptAnswer(bad, notes)).toThrow(AiOutputError)
    }
    const tooLong = 'x'.repeat(SCRIPT_LIMITS.growth * notes.length + SCRIPT_LIMITS.growthExtra + 1)
    expect(() => validateScriptAnswer({ paragraphs: [tooLong] }, notes)).toThrow(/far longer/)
    expect(validateScriptAnswer({ paragraphs: [tooLong.slice(1)] }, notes)).toHaveLength(tooLong.length - 1)
  })

  it('never returns more than the notes can hold: saving would cut it short and lose "Restore my notes"', () => {
    // 12,000 characters of bullets may grow to 74,000, but the notes hold NOTES_TEXT_MAX.
    const bullets = 'x'.repeat(12_000)
    const paragraph = 'y'.repeat(998)
    const answer = (count: number, extra = '') => ({ paragraphs: [...Array<string>(count).fill(paragraph), ...(extra ? [extra] : [])] })
    // 50 paragraphs of 998 + 49 blank-line joins = 49,998 characters; one more character joined by a blank line: 50,001.
    expect(validateScriptAnswer(answer(50), bullets)).toHaveLength(49_998)
    expect(validateScriptAnswer(answer(50), bullets)).toBe(cleanNotesText(validateScriptAnswer(answer(50), bullets)))
    expect(() => validateScriptAnswer(answer(50, 'z'), bullets)).toThrow(AiOutputError)
    expect(() => validateScriptAnswer(answer(50, 'z'), bullets)).toThrow(/longer than the 50,000 characters your notes can hold/)
    expect(NOTES_TEXT_MAX).toBe(50_000)
    // Exactly the limit is kept whole.
    expect(validateScriptAnswer({ paragraphs: ['w'.repeat(NOTES_TEXT_MAX)] }, bullets)).toHaveLength(NOTES_TEXT_MAX)
  })

  it('cleans each paragraph and joins them with a blank line', () => {
    expect(validateScriptAnswer({ paragraphs: ['# Intro', '- Open Settings.', '2. Click Add user.', 'Hi\u0007 there'] }, notes)).toBe(
      'Intro\n\nOpen Settings.\n\nClick Add user.\n\nHi there'
    )
    expect(validateScriptAnswer({ paragraphs: ['* One', '• Two', '3) Three', 'Line\nbreak', '', '  -  '] }, notes)).toBe('One\n\nTwo\n\nThree\n\nLine break')
    // A number that is not a list marker stays.
    expect(validateScriptAnswer({ paragraphs: ['2024 was busy.'] }, notes)).toBe('2024 was busy.')
  })
})

describe('runScriptDraft', () => {
  it('asks once and returns the cleaned script', async () => {
    const ask = vi.fn(async () => ({ paragraphs: ['- First.', 'Second.'] }))
    await expect(runScriptDraft({ notes: 'first\nsecond' }, ask)).resolves.toEqual({ text: 'First.\n\nSecond.' })
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('never asks with an invalid request', async () => {
    const ask = vi.fn(async () => ({ paragraphs: ['x'] }))
    await expect(runScriptDraft({ notes: ' ' }, ask)).rejects.toThrow()
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('the draft script IPC (aiIpc)', () => {
  registerAiIpc()
  const appEvent = { senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href } }
  const otherEvent = { senderFrame: { url: 'https://example.com/' } }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('answers the app page only', async () => {
    expect(() => h.handlers.get('ai:draftScript')!(otherEvent, 'p1', { notes: 'x' })).toThrow('Not allowed')
    expect(() => h.handlers.get('ai:cancelScriptDraft')!(otherEvent)).toThrow('Not allowed')
  })

  it('runs the draft with the provider client at medium effort', async () => {
    h.calls.length = 0
    const p = h.handlers.get('ai:draftScript')!(appEvent, 'p1', { notes: '- Open Settings' }) as Promise<{ text: string }>
    await tick()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].effort).toBe(SCRIPT_EFFORT)
    expect(h.calls[0].prompt.user).toBe(SCRIPT_USER_START + '- Open Settings')
    h.calls[0].resolve({ paragraphs: ['Open Settings.'] })
    await expect(p).resolves.toEqual({ text: 'Open Settings.' })
  })

  it('one draft at a time: a new one aborts the old, cancel aborts the current one', async () => {
    h.calls.length = 0
    const first = draftScript('p1', { notes: 'one' }).catch((err: Error) => err)
    await tick()
    const second = draftScript('p1', { notes: 'two' }).catch((err: Error) => err)
    await tick()
    expect(await first).toMatchObject({ message: 'aborted' })
    expect(h.calls[0].signal.aborted).toBe(true)
    expect(h.calls[1].signal.aborted).toBe(false)
    cancelScriptDraft()
    expect(await second).toMatchObject({ message: 'aborted' })
    expect(h.calls[1].signal.aborted).toBe(true)
  })

  it('an invalid request never aborts the draft in progress', async () => {
    h.calls.length = 0
    const running = draftScript('p1', { notes: 'one' })
    await tick()
    await expect(draftScript('p1', { notes: '' })).rejects.toThrow(/bullet points first/)
    expect(h.calls[0].signal.aborted).toBe(false)
    h.calls[0].resolve({ paragraphs: ['One.'] })
    await expect(running).resolves.toEqual({ text: 'One.' })
  })
})
