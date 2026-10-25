/**
 * A local stand-in for the AI providers' HTTP APIs, as the app calls them (point the app at it
 * with SSW_AI_BASE_URL_OPENAI / _GEMINI / _ANTHROPIC = mockAiEnv(url)). It emulates exactly the
 * endpoints and response shapes the provider modules use, checks the requests (auth headers,
 * models, structured-output settings), and records them for assertions.
 *
 *   OpenAI     <url>/openai/v1:  GET /models, POST /audio/transcriptions (multipart, verbose_json
 *              with segment + word timestamps), POST /responses (json_schema text format)
 *   Gemini     <url>/gemini:     GET /v1beta/models/{m}, POST /v1beta/models/{m}:generateContent,
 *              resumable POST /upload/v1beta/files, GET + DELETE /v1beta/files/{id}
 *   Anthropic  <url>/anthropic:  GET /v1/models/{id}, POST /v1/messages?beta=true (SSE stream)
 *
 * Transcription answers come from the sound itself: the fixtures play tone bursts whose pitch
 * says which word they are (400 + 150 * k Hz is "Word k"), so a transcript's text and times can
 * be checked after parts are shifted and merged. Text tasks answer from the transcript JSON in
 * the prompt (cleanup capitalises, translate prefixes the language, chapters / title / summary
 * are canned).
 *
 * The API key picks a behaviour: "bad..." is rejected (401, or Gemini's 400 API_KEY_INVALID),
 * "quota..." has no credits, "flaky..." fails twice per endpoint with a server error first,
 * "slow..." takes 60 s to transcribe (for cancelling), "refuse..." is declined by the model,
 * "fallback..." (Claude) switches models mid-answer. Anything else works.
 */
'use strict'
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const RATE = 16000

/** "Word k" bursts in `file` (any audio): [{ k, start, end }] in seconds from its start. */
function bursts(ffmpeg, file) {
  const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { maxBuffer: 1 << 28 })
  const n = pcm.length >> 1
  const win = RATE / 50
  const on = []
  for (let i = 0; i + win <= n; i += win) {
    let sum = 0
    for (let j = i; j < i + win; j++) sum += (pcm.readInt16LE(j * 2) / 32768) ** 2
    on.push(Math.sqrt(sum / win) > 0.02)
  }
  const out = []
  let start = -1
  for (let w = 0; w <= on.length; w++) {
    if (w < on.length && on[w]) {
      if (start < 0) start = w
    } else if (start >= 0) {
      const a = (start * win) / RATE
      const b = (w * win) / RATE
      // Bursts are 1.2 s: pieces cut off at the edge of a part are shorter but still counted.
      if (b - a >= 0.1) {
        // Pitch from zero crossings over the middle of the burst.
        const s0 = Math.floor((a + (b - a) * 0.1) * RATE)
        const s1 = Math.floor((b - (b - a) * 0.1) * RATE)
        let crossings = 0
        for (let j = s0 + 1; j < s1; j++) if (pcm.readInt16LE((j - 1) * 2) < 0 !== pcm.readInt16LE(j * 2) < 0) crossings++
        const freq = crossings / 2 / ((s1 - s0) / RATE)
        out.push({ k: Math.round((freq - 400) / 150), start: a, end: b })
      }
      start = -1
    }
  }
  return out
}

/** A minimal multipart/form-data reader: { name: { value?: string, data?: Buffer, type?: string } }. */
function multipart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '')
  if (!boundary) return null
  const sep = Buffer.from(`--${boundary[1] || boundary[2]}`)
  const fields = {}
  let at = body.indexOf(sep)
  while (at >= 0) {
    const next = body.indexOf(sep, at + sep.length)
    if (next < 0) break
    const part = body.subarray(at + sep.length + 2, next - 2)
    const headEnd = part.indexOf('\r\n\r\n')
    const head = part.subarray(0, headEnd).toString()
    const data = part.subarray(headEnd + 4)
    const name = /name="([^"]+)"/.exec(head)?.[1]
    const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]
    if (name) {
      const entry = /filename=/.test(head) ? { data, type } : { value: data.toString() }
      if (fields[name]) fields[name] = [].concat(fields[name], entry)
      else fields[name] = entry
    }
    at = next
  }
  return fields
}

/** The transcript JSON a text-task prompt carries. */
function promptSegments(text) {
  const at = text.indexOf('{"segments"')
  return at < 0 ? [] : JSON.parse(text.slice(at)).segments
}

/** The answer a model would give to a text task (by its instructions). */
function textAnswer(system, user) {
  const segs = promptSegments(user)
  if (/correct automatic captions/.test(system)) return { segments: segs.map((s) => ({ id: s.id, text: `${s.text.charAt(0).toUpperCase()}${s.text.slice(1).replace(/[.]?$/, '.')}` })) }
  const lang = /translate the captions of a screen recording into (.+?)\. /.exec(system)
  if (lang) return { segments: segs.map((s) => ({ id: s.id, text: `[${lang[1]}] ${s.text}` })) }
  if (/split a screen recording into chapters/.test(system)) {
    return { chapters: [{ start: segs[0]?.start ?? 0, title: 'Introduction' }, ...(segs.length > 2 ? [{ start: segs[Math.floor(segs.length / 2)].start, title: 'Main part' }] : [])] }
  }
  if (/write the title/.test(system)) return { text: '"Mock title."' }
  return { text: 'A mock summary of the recording.' }
}

/** Sends a "Word k" transcript of `file` in OpenAI verbose_json. */
function openAiTranscript(ffmpeg, file) {
  const found = bursts(ffmpeg, file)
  const segments = found.map((b, i) => ({
    id: i, seek: 0, start: b.start, end: b.end, text: ` Word ${b.k}`, tokens: [50364], temperature: 0, avg_logprob: -0.2, compression_ratio: 1.1, no_speech_prob: 0.01
  }))
  const words = found.flatMap((b) => {
    const mid = (b.start + b.end) / 2
    return [{ word: 'Word', start: b.start, end: mid }, { word: String(b.k), start: mid, end: b.end }]
  })
  const duration = found.length ? found[found.length - 1].end : 0
  return { task: 'transcribe', language: 'english', duration, text: segments.map((s) => s.text).join(''), segments, words, usage: { type: 'duration', seconds: Math.ceil(duration) } }
}

/** A "Word k" transcript of `file` as Gemini's JSON answer (per the app's response schema). */
function geminiTranscript(ffmpeg, file) {
  return {
    language: 'en',
    segments: bursts(ffmpeg, file).map((b) => {
      const mid = (b.start + b.end) / 2
      return { start: +b.start.toFixed(2), end: +b.end.toFixed(2), text: `Word ${b.k}`, words: [{ text: 'Word', start: b.start, end: mid }, { text: String(b.k), start: mid, end: b.end }] }
    })
  }
}

/** Starts the mock on a free port: { url, requests, close() }. `ffmpeg` decodes uploaded sound. */
function startMockAi({ ffmpeg }) {
  const requests = []
  const hits = new Map()
  const uploads = new Map()
  const files = new Map()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-ai-mock-'))
  let counter = 0
  let url = ''

  /** Fails twice per key and endpoint for "flaky" keys. */
  const flaky = (key, route) => {
    if (!/^flaky/.test(key || '')) return false
    const id = `${key} ${route}`
    const n = (hits.get(id) || 0) + 1
    hits.set(id, n)
    return n <= 2
  }
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const saveAudio = (data, ext) => {
    const file = path.join(tmp, `audio-${++counter}.${ext}`)
    fs.writeFileSync(file, data)
    return file
  }
  /** Waits `ms` unless the client goes away first; resolves false then. */
  const wait = (req, ms) =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(true), ms)
      req.socket.once('close', () => {
        clearTimeout(t)
        resolve(false)
      })
    })

  async function openai(req, res, route, body, rec) {
    const key = (req.headers.authorization || '').replace(/^Bearer /, '')
    rec.key = key
    const error = (status, message, type, code) => json(res, status, { error: { message, type, param: null, code } })
    if (/^bad/.test(key)) return error(401, `Incorrect API key provided: ${key.slice(0, 3)}***${key.slice(-2)}. You can find your API key at https://platform.openai.com/account/api-keys.`, 'invalid_request_error', 'invalid_api_key')
    if (/^quota/.test(key)) return error(429, 'You exceeded your current quota, please check your plan and billing details.', 'insufficient_quota', 'insufficient_quota')
    if (flaky(key, route)) return json(res, 503, { error: { message: 'The server is overloaded.', type: 'server_error', param: null, code: null } }, { 'retry-after': '0' })
    if (req.method === 'GET' && route === '/models') return json(res, 200, { object: 'list', data: [{ id: 'whisper-1', object: 'model', created: 0, owned_by: 'openai' }] })
    if (req.method === 'POST' && route === '/audio/transcriptions') {
      const fields = multipart(body, req.headers['content-type'])
      rec.fields = Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => x.value ?? `<${x.data.length} bytes ${x.type}>`) : v.value ?? `<${v.data.length} bytes ${v.type}>`]))
      if (!fields?.file?.data || fields.response_format?.value !== 'verbose_json') return error(400, 'file and response_format verbose_json expected', 'invalid_request_error', null)
      const grains = [].concat(fields['timestamp_granularities[]'] || []).map((f) => f.value)
      if (!grains.includes('word') || !grains.includes('segment')) return error(400, 'timestamp_granularities must include word and segment', 'invalid_request_error', null)
      if (fields.model?.value !== 'whisper-1') return error(400, `timestamp_granularities is not supported for ${fields.model?.value}`, 'invalid_request_error', null)
      if (fields.file.data.length > 25 * 1024 * 1024) return error(413, 'Maximum content size limit (26214400) exceeded.', 'invalid_request_error', null)
      if (/^slow/.test(key) && !(await wait(req, 60000))) return
      return json(res, 200, openAiTranscript(ffmpeg, saveAudio(fields.file.data, 'mp3')))
    }
    if (req.method === 'POST' && route === '/responses') {
      const b = JSON.parse(body.toString())
      rec.json = b
      const format = b.text?.format
      if (format?.type !== 'json_schema' || format.strict !== true || !format.name || !format.schema) return error(400, 'text.format json_schema expected', 'invalid_request_error', null)
      const content = /^refuse/.test(key)
        ? [{ type: 'refusal', refusal: "I'm sorry, I cannot assist with that request." }]
        : [{ type: 'output_text', text: JSON.stringify(textAnswer(b.instructions, b.input)), annotations: [] }]
      return json(res, 200, {
        id: `resp_${++counter}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: b.model,
        output: [{ type: 'message', id: `msg_${counter}`, status: 'completed', role: 'assistant', content }],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 }
      })
    }
    return error(404, `Unknown route ${req.method} ${route}`, 'invalid_request_error', null)
  }

  async function gemini(req, res, route, body, rec) {
    const key = req.headers['x-goog-api-key'] || ''
    rec.key = key
    const error = (code, message, status, reason) => json(res, code, { error: { code, message, status, ...(reason ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] } : {}) } })
    const uploadId = /^\/upload-session\/(\d+)\/?$/.exec(route)
    if (uploadId) {
      // The resumable upload URL itself carries the session (no key header on these requests in some SDK versions).
      const u = uploads.get(uploadId[1])
      if (!u) return error(404, 'No such upload', 'NOT_FOUND')
      u.chunks.push(body)
      if (!/finalize/.test(req.headers['x-goog-upload-command'] || '')) {
        res.writeHead(200, { 'x-goog-upload-status': 'active' })
        return res.end()
      }
      const id = `file${++counter}`
      const data = Buffer.concat(u.chunks)
      files.set(id, { file: saveAudio(data, 'mp3'), mimeType: u.mimeType, polls: 0, deleted: false })
      return json(res, 200, { file: { name: `files/${id}`, uri: `${url}/gemini/v1beta/files/${id}`, mimeType: u.mimeType, sizeBytes: String(data.length), state: 'PROCESSING' } }, { 'x-goog-upload-status': 'final' })
    }
    if (/^bad/.test(key)) return error(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT', 'API_KEY_INVALID')
    if (/^quota/.test(key)) return error(429, 'You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generate_content_requests_PerDay', 'RESOURCE_EXHAUSTED')
    if (flaky(key, route.replace(/files\/\w+/, 'files'))) return error(503, 'The model is overloaded. Please try again later.', 'UNAVAILABLE')
    if (req.method === 'POST' && route === '/upload/v1beta/files') {
      if (req.headers['x-goog-upload-protocol'] !== 'resumable' || req.headers['x-goog-upload-command'] !== 'start') return error(400, 'resumable start expected', 'INVALID_ARGUMENT')
      const id = String(++counter)
      uploads.set(id, { mimeType: req.headers['x-goog-upload-header-content-type'], chunks: [] })
      res.writeHead(200, { 'x-goog-upload-url': `${url}/gemini/upload-session/${id}`, 'x-goog-upload-status': 'active' })
      return res.end()
    }
    const file = /^\/v1beta\/files\/(\w+)$/.exec(route)
    if (file) {
      const f = files.get(file[1])
      if (!f) return error(404, 'File not found', 'NOT_FOUND')
      if (req.method === 'DELETE') {
        f.deleted = true
        return json(res, 200, {})
      }
      // Processing for one poll, then ready.
      f.polls++
      return json(res, 200, { name: `files/${file[1]}`, uri: `${url}/gemini/v1beta/files/${file[1]}`, mimeType: f.mimeType, state: f.polls > 1 ? 'ACTIVE' : 'PROCESSING' })
    }
    const model = /^\/v1beta\/models\/([^/:]+)(:generateContent)?$/.exec(route)
    if (model && req.method === 'GET' && !model[2]) return json(res, 200, { name: `models/${model[1]}`, displayName: model[1], inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] })
    if (model && req.method === 'POST' && model[2]) {
      const b = JSON.parse(body.toString())
      rec.json = b
      const config = b.generationConfig || {}
      if (config.responseMimeType !== 'application/json' || !config.responseJsonSchema) return error(400, 'JSON response schema expected', 'INVALID_ARGUMENT')
      const parts = b.contents?.[0]?.parts || []
      const inline = parts.find((p) => p.inlineData)
      const ref = parts.find((p) => p.fileData)
      let answer
      if (inline || ref) {
        if (/^slow/.test(key) && !(await wait(req, 60000))) return
        let audio
        if (inline) audio = saveAudio(Buffer.from(inline.inlineData.data, 'base64'), 'mp3')
        else {
          const id = /files\/(\w+)$/.exec(ref.fileData.fileUri)?.[1]
          const f = files.get(id)
          if (!f || f.deleted || f.polls < 2) return error(400, 'File is not ACTIVE', 'FAILED_PRECONDITION')
          audio = f.file
        }
        answer = geminiTranscript(ffmpeg, audio)
      } else {
        const system = (b.systemInstruction?.parts || []).map((p) => p.text).join('')
        const user = parts.map((p) => p.text || '').join('')
        answer = textAnswer(system, user)
      }
      if (/^refuse/.test(key)) return json(res, 200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 } })
      return json(res, 200, {
        candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
        modelVersion: model[1]
      })
    }
    return error(404, `Unknown route ${req.method} ${route}`, 'NOT_FOUND')
  }

  async function anthropic(req, res, route, body, rec) {
    const key = req.headers['x-api-key'] || ''
    rec.key = key
    const error = (status, type, message) => json(res, status, { type: 'error', error: { type, message }, request_id: `req_${++counter}` })
    if (!req.headers['anthropic-version']) return error(400, 'invalid_request_error', 'anthropic-version header is required')
    if (req.headers.authorization) return error(400, 'invalid_request_error', 'unexpected Authorization header')
    if (/^bad/.test(key)) return error(401, 'authentication_error', 'invalid x-api-key')
    if (/^quota/.test(key)) return error(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.')
    if (flaky(key, route)) return error(529, 'overloaded_error', 'Overloaded')
    const model = /^\/v1\/models\/([^/?]+)$/.exec(route)
    if (model && req.method === 'GET') return json(res, 200, { type: 'model', id: model[1], display_name: model[1], created_at: '2026-01-01T00:00:00Z' })
    if (req.method === 'POST' && route === '/v1/messages') {
      const b = JSON.parse(body.toString())
      rec.json = b
      rec.beta = req.headers['anthropic-beta'] || ''
      if (b.output_config?.format?.type !== 'json_schema' || !b.output_config.format.schema) return error(400, 'invalid_request_error', 'output_config.format expected')
      if (b.stream !== true) return error(400, 'invalid_request_error', 'stream expected')
      const answer = JSON.stringify(textAnswer(typeof b.system === 'string' ? b.system : '', b.messages?.[0]?.content || ''))
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      const id = `msg_${++counter}`
      send({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } })
      let index = 0
      const text = (t) => {
        send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
        const mid = Math.floor(t.length / 2)
        send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t.slice(0, mid) } })
        send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t.slice(mid) } })
        send({ type: 'content_block_stop', index })
        index++
      }
      if (/^fallback/.test(key)) {
        // Declined mid-answer and continued on another model: the partial text must be discarded.
        text('{"segments":[{"id":')
        send({ type: 'content_block_start', index, content_block: { type: 'fallback', from: { model: b.model }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal', category: 'cyber' } } })
        send({ type: 'content_block_stop', index })
        index++
      }
      if (/^refuse/.test(key)) {
        send({ type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: 'cyber', explanation: null } }, usage: { output_tokens: 0 } })
      } else {
        text(answer)
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null }, usage: { output_tokens: 30 } })
      }
      send({ type: 'message_stop' })
      return res.end()
    }
    return error(404, 'not_found_error', `Unknown route ${req.method} ${route}`)
  }

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const u = new URL(req.url, 'http://mock')
      const [, provider, ...rest] = u.pathname.split('/')
      const route = `/${rest.join('/')}`
      const rec = { provider, method: req.method, route, query: u.search, headers: { ...req.headers }, bytes: body.length }
      requests.push(rec)
      const handler = { openai, gemini, anthropic }[provider]
      // OpenAI's routes are recorded as the SDK names them, without the /v1 of its base URL.
      if (provider === 'openai') rec.route = route.replace(/^\/v1/, '')
      const done = handler ? handler(req, res, rec.route, body, rec) : Promise.resolve(json(res, 404, {}))
      done.catch((err) => {
        rec.error = String(err && err.stack ? err.stack : err)
        if (!res.headersSent) json(res, 500, { error: { message: String(err) } })
      })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      url = `http://127.0.0.1:${server.address().port}`
      resolve({
        url,
        requests,
        files,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.()
            server.close(() => {
              fs.rmSync(tmp, { recursive: true, force: true })
              r()
            })
          })
      })
    })
  })
}

/** The environment that points the app at the mock at `url`. */
function mockAiEnv(url) {
  return { SSW_AI_BASE_URL_OPENAI: `${url}/openai/v1`, SSW_AI_BASE_URL_GEMINI: `${url}/gemini`, SSW_AI_BASE_URL_ANTHROPIC: `${url}/anthropic` }
}

/**
 * ffmpeg arguments for the fixture sound: "Word k" bursts of 1.2 s at `starts[k]` seconds
 * (pitch 400 + 150 k Hz) over silence, `seconds` long; output path appended by the caller.
 */
function burstAudioArgs(starts, seconds) {
  const expr = starts.map((t, k) => `between(t,${t},${t + 1.2})*sin(2*PI*${400 + 150 * k}*t)`).join('+')
  return ['-f', 'lavfi', '-i', `aevalsrc='0.5*(${expr})':s=48000:d=${seconds}`]
}

module.exports = { startMockAi, mockAiEnv, burstAudioArgs, bursts }
