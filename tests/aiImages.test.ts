import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TextPrompt } from '../src/shared/captions/transcriptText'

/*
 * Titles from the screenshots in the main process (docs/design/smart-tools.md §5.3.1, §20.6; §22.1
 * test 139): each client sends a prompt's pictures in its API's own form (OpenAI's Responses API an
 * input_image part, a service's Chat Completions an image_url part, Gemini inline_data, Claude an
 * image block), each after the line naming its item, to a mock server; a 400 naming the image gives
 * "This model does not read pictures…" and is not tried again; checkImages refuses what is not a
 * JPEG, larger than 512 KB, or more than 50 in a request, before anything is sent; a prompt without
 * pictures goes as it always did.
 */

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/nonexistent' }, net: { fetch: () => Promise.reject(new Error('no net')) } }))

const { checkImages, chatImagePart, claudeImageBlock, geminiImagePart, openAiImagePart, refusesPictures } = await import('../src/main/ai/images')
const { NO_PICTURES_MESSAGE } = await import('../src/main/ai/types')
const { openAiClient } = await import('../src/main/ai/openai')
const { geminiClient } = await import('../src/main/ai/gemini')
const { anthropicClient } = await import('../src/main/ai/anthropic')
const { compatibleClient } = await import('../src/main/ai/compatible')
const { calibration, noteUsage, usageKey, useUsageFile } = await import('../src/main/ai/usage')

/** A small JPEG's first bytes: SOI, then an APP0 marker. */
const jpeg = (fill: number, size = 64): Uint8Array => {
  const b = new Uint8Array(size).fill(fill)
  b.set([0xff, 0xd8, 0xff, 0xe0], 0)
  return b
}
const PIC_A = jpeg(1)
const PIC_B = jpeg(2, 80)
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')

const SCHEMA = { type: 'object', properties: { names: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'], additionalProperties: false } } }, required: ['names'], additionalProperties: false }
const ITEMS = '{"items":[{"id":"c3000","text":"","action":"click, top right of the screen"},{"id":"c9000","text":"now save","action":"press Ctrl + S"}]}'
const withPics = (): TextPrompt => ({
  name: 'names',
  system: 'Name the control in the ring.',
  user: `Steps:\n${ITEMS}`,
  schema: SCHEMA,
  images: [
    { mime: 'image/jpeg', data: PIC_A, id: 'c3000' },
    { mime: 'image/jpeg', data: PIC_B, id: 'c9000' }
  ]
})
const ANSWER = { names: [{ id: 'c3000', name: 'Click “Export”' }, { id: 'c9000', name: 'Press Ctrl + S' }] }
const OPTS = (): { signal: AbortSignal; effort: 'low' } => ({ signal: AbortSignal.timeout(20_000), effort: 'low' })

/* ---------- a mock server for every API ---------- */

const mock = { refuse: false, bodies: [] as { route: string; json: Record<string, unknown> }[] }
const REFUSAL = {
  openai: { error: { message: 'Invalid content type. image_url is only supported by certain models.', type: 'invalid_request_error', param: 'input', code: null } },
  gemini: { error: { code: 400, message: 'Image input modality is not enabled for models/gemini-text-only.', status: 'INVALID_ARGUMENT' } },
  anthropic: { type: 'error', error: { type: 'invalid_request_error', message: 'messages.0.content.2: this model does not support image input.' } }
}

const srv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const route = (req.url ?? '').split('?')[0]
    const json = body ? (JSON.parse(body) as Record<string, unknown>) : {}
    mock.bodies.push({ route, json })
    const send = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const text = JSON.stringify(ANSWER)
    if (route === '/v1/responses') {
      if (mock.refuse) return send(400, REFUSAL.openai)
      return send(200, {
        id: 'resp_1', object: 'response', created_at: 1, status: 'completed', model: json.model,
        output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
        usage: { input_tokens: 900, output_tokens: 20, total_tokens: 920 }
      })
    }
    if (/^\/v1beta\/models\/[^/]+:generateContent$/.test(route)) {
      if (mock.refuse) return send(400, REFUSAL.gemini)
      return send(200, { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 20, totalTokenCount: 620 } })
    }
    if (route === '/v1/messages') {
      if (mock.refuse) return send(400, REFUSAL.anthropic)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (e: Record<string, unknown>): boolean => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      event({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 700, output_tokens: 1 } } })
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
      event({ type: 'content_block_stop', index: 0 })
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null }, usage: { output_tokens: 20 } })
      event({ type: 'message_stop' })
      return res.end()
    }
    if (route === '/svc/v1/chat/completions') {
      if (mock.refuse) return send(400, { error: { message: 'Bad request: `image_url` is not supported by model text-only.', type: 'invalid_request_error' } })
      return send(200, { id: 'c1', object: 'chat.completion', created: 1, model: json.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 800, completion_tokens: 20, total_tokens: 820 } })
    }
    send(404, { error: { message: `no route ${route}` } })
  })
})

let origin = ''
beforeAll(async () => {
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  vi.stubEnv('SSW_AI_BASE_URL_OPENAI', `${origin}/v1`)
  vi.stubEnv('SSW_AI_BASE_URL_GEMINI', origin)
  vi.stubEnv('SSW_AI_BASE_URL_ANTHROPIC', origin)
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await new Promise((r) => srv.close(r))
})
beforeEach(() => {
  mock.refuse = false
  mock.bodies.length = 0
})

const service = (json: 'schema' | 'object' | 'text' = 'schema') => ({
  id: 'svc1',
  kind: 'openai' as const,
  label: 'Mock',
  model: 'vision-model',
  maskedKey: '',
  createdAt: '',
  service: { preset: 'other' as const, baseUrl: `${origin}/svc/v1`, host: new URL(origin).host, loopback: true, json }
})
const clients = (): [string, () => ReturnType<typeof openAiClient>][] => [
  ['OpenAI', () => openAiClient('sk-test-images-0123456789', 'gpt-6.1-sol', 'whisper-1')],
  ['Gemini', () => geminiClient('AIzaTestImages0123456789', 'gemini-3.8-flash', 'gemini-3.8-flash')],
  ['Claude', () => anthropicClient('claude-test-images-0123456789', 'claude-opus-5-5')],
  ['Service', () => compatibleClient(service(), 'svc-test-images-0123456789', { setJsonMode: () => undefined })]
]

/** Each part of a message's content, as the mock received it. */
const parts = (json: Record<string, unknown>): Record<string, unknown>[] => {
  const input = json.input as { content: Record<string, unknown>[] }[] | undefined
  if (input) return input[0].content
  const contents = json.contents as { parts: Record<string, unknown>[] }[] | undefined
  if (contents) return contents[0].parts
  const messages = json.messages as { role: string; content: Record<string, unknown>[] }[]
  return messages.find((m) => m.role === 'user')!.content
}

describe('test 139: each client sends a picture in its API’s form', () => {
  it('OpenAI’s Responses API: input_text, then each picture as an input_image part with a data: URL after the line naming its item', async () => {
    expect(await openAiClient('sk-test-images-0123456789', 'gpt-6.1-sol', 'whisper-1').json(withPics(), OPTS())).toEqual(ANSWER)
    expect(mock.bodies).toHaveLength(1)
    const { route, json } = mock.bodies[0]
    expect(route).toBe('/v1/responses')
    expect(json.instructions).toBe('Name the control in the ring.')
    expect((json.input as { role: string }[])[0].role).toBe('user')
    expect(parts(json)).toEqual([
      { type: 'input_text', text: `Steps:\n${ITEMS}` },
      { type: 'input_text', text: 'The picture for item "c3000":' },
      { type: 'input_image', image_url: `data:image/jpeg;base64,${b64(PIC_A)}`, detail: 'auto' },
      { type: 'input_text', text: 'The picture for item "c9000":' },
      { type: 'input_image', image_url: `data:image/jpeg;base64,${b64(PIC_B)}`, detail: 'auto' }
    ])
  })

  it('a service’s Chat Completions: text, then each picture as an image_url part with a data: URL', async () => {
    expect(await compatibleClient(service(), 'svc-test-images-0123456789', { setJsonMode: () => undefined }).json(withPics(), OPTS())).toEqual(ANSWER)
    const { route, json } = mock.bodies[0]
    expect(route).toBe('/svc/v1/chat/completions')
    const messages = json.messages as { role: string; content: unknown }[]
    expect(messages[0]).toEqual({ role: 'system', content: 'Name the control in the ring.' })
    expect(parts(json)).toEqual([
      { type: 'text', text: `Steps:\n${ITEMS}` },
      { type: 'text', text: 'The picture for item "c3000":' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64(PIC_A)}` } },
      { type: 'text', text: 'The picture for item "c9000":' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64(PIC_B)}` } }
    ])
  })

  it('Gemini: text, then each picture as an inline_data part with its bytes in base64', async () => {
    expect(await geminiClient('AIzaTestImages0123456789', 'gemini-3.8-flash', 'gemini-3.8-flash').json(withPics(), OPTS())).toEqual(ANSWER)
    const { route, json } = mock.bodies[0]
    expect(route).toBe('/v1beta/models/gemini-3.8-flash:generateContent')
    const sent = parts(json)
    expect(sent).toHaveLength(5)
    expect(sent[0]).toEqual({ text: `Steps:\n${ITEMS}` })
    expect(sent[1]).toEqual({ text: 'The picture for item "c3000":' })
    // The API's inline_data (the SDK writes its JSON name, inlineData; the API takes both).
    const inline = (p: Record<string, unknown>): unknown => p.inline_data ?? p.inlineData
    expect(inline(sent[2])).toEqual({ mimeType: 'image/jpeg', data: b64(PIC_A) })
    expect(sent[3]).toEqual({ text: 'The picture for item "c9000":' })
    expect(inline(sent[4])).toEqual({ mimeType: 'image/jpeg', data: b64(PIC_B) })
  })

  it('Claude: text, then each picture as an image block with a base64 source', async () => {
    expect(await anthropicClient('claude-test-images-0123456789', 'claude-opus-5-5').json(withPics(), OPTS())).toEqual(ANSWER)
    const { route, json } = mock.bodies[0]
    expect(route).toBe('/v1/messages')
    expect(parts(json)).toEqual([
      { type: 'text', text: `Steps:\n${ITEMS}` },
      { type: 'text', text: 'The picture for item "c3000":' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(PIC_A) } },
      { type: 'text', text: 'The picture for item "c9000":' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(PIC_B) } }
    ])
  })

  it('every client says it sends pictures (aiIpc refuses a prompt with pictures to one that does not)', () => {
    for (const [name, make] of clients()) expect(make().pictures, name).toBe(true)
  })

  it('a prompt without pictures goes as it always did: the text alone', async () => {
    const plain: TextPrompt = { name: 'title', system: 's', user: 'u', schema: SCHEMA }
    for (const [, make] of clients()) await make().json(plain, OPTS())
    const [openai, gemini, claude, svc] = mock.bodies.map((b) => b.json)
    expect(openai.input).toBe('u')
    expect(gemini.contents).toEqual([{ role: 'user', parts: [{ text: 'u' }] }])
    expect(claude.messages).toEqual([{ role: 'user', content: 'u' }])
    expect((svc.messages as unknown[])[1]).toEqual({ role: 'user', content: 'u' })
  })
})

describe('test 139: a provider that refuses pictures', () => {
  it('a 400 naming the image gives "This model does not read pictures…", for every client, without trying again', async () => {
    mock.refuse = true
    for (const [name, make] of clients()) {
      mock.bodies.length = 0
      const message = await make()
        .json(withPics(), OPTS())
        .then(
          () => 'resolved',
          (e: unknown) => (e instanceof Error ? e.message : String(e))
        )
      expect(message, name).toBe(NO_PICTURES_MESSAGE)
      expect(message, name).toMatch(/^This model does not read pictures\. Choose another model, or untick Also send the screenshots\.$/)
      expect(mock.bodies, name).toHaveLength(1)
    }
  })

  it('a service’s refusal of the pictures never drops its JSON mode', async () => {
    mock.refuse = true
    const modes: string[] = []
    const client = compatibleClient(service('schema'), 'svc-test-images-0123456789', { setJsonMode: (_id, json) => void modes.push(json) })
    await expect(client.json(withPics(), OPTS())).rejects.toThrow(NO_PICTURES_MESSAGE)
    expect(modes).toEqual([])
    expect(mock.bodies).toHaveLength(1)
  })

  it('the same 400 for a prompt without pictures is the provider’s own message', async () => {
    mock.refuse = true
    const plain: TextPrompt = { name: 'title', system: 's', user: 'u', schema: SCHEMA }
    const message = await openAiClient('sk-test-images-0123456789', 'gpt-6.1-sol', 'whisper-1')
      .json(plain, OPTS())
      .then(
        () => 'resolved',
        (e: unknown) => (e instanceof Error ? e.message : String(e))
      )
    expect(message).toMatch(/^OpenAI rejected the request: /)
  })

  it('refusesPictures: a 400 or 422 whose code or message names the image, nothing else', () => {
    expect(refusesPictures({ status: 400, message: 'Invalid image.' })).toBe(true)
    expect(refusesPictures({ status: 422, message: 'This model does not support images' })).toBe(true)
    expect(refusesPictures({ status: 400, code: 'INVALID_ARGUMENT', message: 'Unable to process input image.' })).toBe(true)
    expect(refusesPictures({ status: 400, message: 'Invalid schema for response_format' })).toBe(false)
    expect(refusesPictures({ status: 500, message: 'image service down' })).toBe(false)
    expect(refusesPictures({ status: 401, message: 'Incorrect API key' })).toBe(false)
  })
})

describe('checkImages: what may be sent', () => {
  it('JPEG by its first bytes, at most 512 KB each and 50 a request', () => {
    expect(() => checkImages([PIC_A, PIC_B])).not.toThrow()
    expect(() => checkImages([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0])])).toThrow('A picture to send is not a JPEG image.')
    expect(() => checkImages([jpeg(3, 512 * 1024)])).not.toThrow()
    expect(() => checkImages([jpeg(3, 512 * 1024 + 1)])).toThrow('A picture to send is too large.')
    expect(() => checkImages(Array.from({ length: 50 }, () => PIC_A))).not.toThrow()
    expect(() => checkImages(Array.from({ length: 51 }, () => PIC_A))).toThrow('There are too many pictures to send at once.')
  })

  it('a client given a picture that is not a JPEG sends nothing', async () => {
    for (const [name, make] of clients()) {
      mock.bodies.length = 0
      const bad: TextPrompt = { ...withPics(), images: [{ mime: 'image/jpeg', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), id: 'c3000' }] }
      await expect(make().json(bad, OPTS()), name).rejects.toThrow('A picture to send is not a JPEG image.')
      expect(mock.bodies, name).toHaveLength(0)
    }
  })

  it('the four forms of one picture', () => {
    const img = { mime: 'image/jpeg' as const, data: PIC_A, id: 'k' }
    const url = `data:image/jpeg;base64,${b64(PIC_A)}`
    expect(openAiImagePart(img)).toEqual({ type: 'input_image', image_url: url, detail: 'auto' })
    expect(chatImagePart(img)).toEqual({ type: 'image_url', image_url: { url } })
    expect(geminiImagePart(img)).toEqual({ inlineData: { mimeType: 'image/jpeg', data: b64(PIC_A) } })
    expect(claudeImageBlock(img)).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(PIC_A) } })
  })
})

describe('the usage figures (§11.6) leave out prompts with pictures', () => {
  it('a reported count for a prompt with pictures keeps no ratio; the same prompt without them does', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-images-usage-'))
    useUsageFile(path.join(dir, 'ai-usage.json'))
    try {
      const key = usageKey('openai', 'gpt-6.1-sol', 'names')!
      // Picture tokens follow each provider's own rule: counted against the text's estimate they would skew it.
      noteUsage('openai', 'gpt-6.1-sol', withPics(), JSON.stringify(ANSWER), { input: 5000, output: 20 })
      await new Promise((r) => setTimeout(r, 20))
      expect(calibration(key)).toEqual({ input: 1, output: 1 })
      expect(fs.existsSync(path.join(dir, 'ai-usage.json'))).toBe(false)
      const { images: _images, ...plain } = withPics()
      noteUsage('openai', 'gpt-6.1-sol', plain, JSON.stringify(ANSWER), { input: 5000, output: 20 })
      await new Promise((r) => setTimeout(r, 20))
      expect(calibration(key).input).toBeGreaterThan(1)
    } finally {
      useUsageFile(null)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
