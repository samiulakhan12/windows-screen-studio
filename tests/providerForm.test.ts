import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiProviderStore, type SecretBox } from '../src/main/ai/keyStore'
import { BUNDLED_MODEL_LIST, type ModelList } from '../src/shared/ai/modelList'
import type { AiProviderInfo } from '../src/shared/api/ai'

/*
 * Settings › AI's provider form without a DOM: React's hooks are swapped for a few lines that keep
 * the form's state (as in notesCard.test.ts), and window.api is main: its list of suggested models,
 * which main refreshes while Flown runs, and the real provider store behind saveAiProvider.
 */

interface Cell {
  value?: unknown
  deps?: readonly unknown[]
  cleanup?: (() => void) | void
}
interface El {
  type: unknown
  props: Record<string, unknown>
}

let cells: Cell[] = []
let at = 0
let effects: (() => void)[] = []
let dirty = false
const cell = (): Cell => (cells[at++] ??= {})
const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))

/** Main's list: whisper-1 suggested, until it downloads the one that moves to gpt-transcribe. */
const WHISPER: ModelList = BUNDLED_MODEL_LIST
const MOVED: ModelList = {
  ...BUNDLED_MODEL_LIST,
  updated: '2027-02-01',
  providers: { ...BUNDLED_MODEL_LIST.providers, openai: { ...BUNDLED_MODEL_LIST.providers.openai, transcriptionModel: 'gpt-transcribe' } }
}
const main = { list: WHISPER, store: null as unknown as AiProviderStore, sent: [] as Record<string, unknown>[] }
const box: SecretBox = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`v10${plain}`),
  decryptString: (enc) => enc.toString().slice(3)
}
vi.stubGlobal('window', {
  api: {
    getAiModelList: () => Promise.resolve(main.list),
    saveAiProvider: (input: Record<string, unknown>) => {
      main.sent.push(input)
      return Promise.resolve(main.store.save(structuredClone(input)))
    }
  }
})

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useId: () => ':f:',
  useState: (init: unknown) => {
    const c = cell()
    if (!('value' in c)) c.value = typeof init === 'function' ? (init as () => unknown)() : init
    const set = (v: unknown): void => {
      const next = typeof v === 'function' ? (v as (x: unknown) => unknown)(c.value) : v
      if (Object.is(next, c.value)) return
      c.value = next
      dirty = true
    }
    return [c.value, set]
  },
  useEffect: (fn: () => (() => void) | void, deps?: unknown[]) => {
    const c = cell()
    if (!changed(c.deps, deps)) return
    c.deps = deps
    effects.push(() => {
      c.cleanup?.()
      c.cleanup = fn()
    })
  }
}))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const FORM = '../src/renderer/src/settings/ProviderForm'
type Props = { editing: AiProviderInfo | null; existing: readonly AiProviderInfo[]; onCancel: () => void; onSaved: (saved: AiProviderInfo) => void }
const { ProviderForm } = (await import(/* @vite-ignore */ FORM)) as { ProviderForm: (props: Props) => unknown }

function walk(node: unknown, out: El[]): El[] {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, out))
    return out
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return out
  const el = node as El
  out.push(el)
  walk(el.props.children, out)
  return out
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** One open form: rendered until its state and effects settle; closed by `unmount`. */
function mount(editing: AiProviderInfo | null): { render: () => El[]; saved: AiProviderInfo[] } {
  const saved: AiProviderInfo[] = []
  const props: Props = { editing, existing: [], onCancel: () => undefined, onSaved: (s) => saved.push(s) }
  const render = (): El[] => {
    for (let pass = 0; pass < 20; pass++) {
      dirty = false
      at = 0
      const out = walk(ProviderForm(props), [])
      const run = effects
      effects = []
      run.forEach((e) => e())
      if (!dirty) return out
    }
    throw new Error('The form keeps rendering')
  }
  return { render, saved }
}
function unmount(): void {
  for (const c of cells) c.cleanup?.()
  cells = []
  effects = []
}

const input = (out: El[], test: (p: Record<string, unknown>) => boolean): El => out.find((e) => e.type === 'input' && test(e.props))!
const transcription = (out: El[]): El => input(out, (p) => p['aria-describedby'] === ':f:-tm-hint')
const type = (el: El, value: string): void => (el.props.onChange as (e: unknown) => void)({ target: { value } })
async function submit(render: () => El[]): Promise<void> {
  const form = render().find((e) => e.type === 'form')!
  ;(form.props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined })
  await flush()
  render()
}

describe('Settings › AI provider form: the suggested transcription model follows the list main has', () => {
  let dir: string
  let file: string
  const onDisk = (): { label: string; transcriptionModel?: string }[] => JSON.parse(readFileSync(file, 'utf8')).providers
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-aiform-'))
    file = path.join(dir, 'ai-providers.json')
    main.list = WHISPER
    main.store = new AiProviderStore(file, box, (kind) => main.list.providers[kind])
    main.sent = []
  })
  afterEach(() => {
    unmount()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a form opened after main moved the list suggests the new model', async () => {
    const first = mount(null)
    first.render()
    await flush()
    expect(transcription(first.render()).props.value).toBe('whisper-1')
    unmount()
    // Later in the same window: main downloaded the list that moves to gpt-transcribe.
    main.list = MOVED
    const again = mount(null)
    again.render()
    await flush()
    expect(transcription(again.render()).props.value).toBe('gpt-transcribe')
  })

  it('a provider added while the list moves gets the new suggestion and stores none', async () => {
    const { render, saved } = mount(null)
    render()
    await flush()
    const out = render()
    expect(transcription(out).props.value).toBe('whisper-1')
    main.list = MOVED
    type(input(out, (p) => p.id === ':f:-key'), 'sk-proj-THISISASECRETKEY1234abcd')
    await submit(render)
    expect(main.sent).toHaveLength(1)
    expect(main.sent[0]).not.toHaveProperty('transcriptionModel')
    expect(saved.map((p) => p.transcriptionModel)).toEqual(['gpt-transcribe'])
    expect(onDisk()[0]).not.toHaveProperty('transcriptionModel')
  })

  it('a transcription model the user types is sent and kept', async () => {
    const { render, saved } = mount(null)
    render()
    await flush()
    const out = render()
    main.list = MOVED
    type(input(out, (p) => p.id === ':f:-key'), 'sk-proj-THISISASECRETKEY1234abcd')
    type(transcription(render()), ' whisper-1 ')
    await submit(render)
    expect(main.sent[0].transcriptionModel).toBe('whisper-1')
    expect(saved.map((p) => p.transcriptionModel)).toEqual(['whisper-1'])
    expect(onDisk()[0].transcriptionModel).toBe('whisper-1')
  })

  it('an edit that leaves the transcription model alone keeps what the provider had', async () => {
    const follows = main.store.save({ kind: 'openai', label: 'Follows', apiKey: 'sk-proj-THISISASECRETKEY1234abcd' })
    const chosen = main.store.save({ kind: 'openai', label: 'Chosen', apiKey: 'sk-proj-THISISASECRETKEY1234abcd', transcriptionModel: 'gpt-4o-transcribe' })
    // Settings listed them with whisper-1 suggested; the list moves while it is open.
    expect([follows.transcriptionModel, chosen.transcriptionModel]).toEqual(['whisper-1', 'gpt-4o-transcribe'])
    main.list = MOVED
    for (const [p, name] of [
      [follows, 'Follows 2'],
      [chosen, 'Chosen 2']
    ] as const) {
      const { render } = mount(p)
      render()
      await flush()
      type(input(render(), (q) => q.value === p.label), name)
      await submit(render)
      unmount()
    }
    expect(main.sent.map((s) => s.transcriptionModel)).toEqual([undefined, undefined])
    expect(main.store.list().map((p) => [p.label, p.transcriptionModel])).toEqual([
      ['Follows 2', 'gpt-transcribe'],
      ['Chosen 2', 'gpt-4o-transcribe']
    ])
    expect(onDisk().map((p) => p.transcriptionModel)).toEqual([undefined, 'gpt-4o-transcribe'])
  })
})
