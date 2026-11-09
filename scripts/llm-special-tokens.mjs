#!/usr/bin/env node
// Saves what AI on this PC needs to know about each pinned text model's vocabulary and chat
// template (docs/design/smart-tools.md §9.6), as test fixtures in tests/fixtures/llm/:
//   <id>-special.json   every CONTROL and USER_DEFINED token string of the vocabulary, the model's
//                       beginning-of-text settings and the template's hash;
//   <id>-template.jinja the GGUF's own chat template (tokenizer.chat_template), never run by Flown;
//   <id>-chat.txt       that template rendered with Jinja2 (python3, sandboxed) for a sample system
//                       and user turn with thinking off: what chatPrompt must equal (§22 test 67).
//
//   node scripts/llm-special-tokens.mjs            # both models, from their pinned addresses
//   node scripts/llm-special-tokens.mjs --file <id>=<path.gguf>
//
// Only the GGUF header is read (HTTP Range requests of a few MB), never the model's weights. The
// pins are a copy of src/shared/localAi/catalog.ts's; tests/localCatalog.test.ts checks they agree.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PINS = [
  { id: 'gemma4-e2b', repo: 'unsloth/gemma-4-E2B-it-GGUF', commit: '0314792d7f1f7e229411f620751375812bb9faf2', file: 'gemma-4-E2B-it-Q4_K_M.gguf', bytes: 3_106_738_272 },
  { id: 'qwen3.5-2b', repo: 'unsloth/Qwen3.5-2B-GGUF', commit: 'f6d5376be1edb4d416d56da11e5397a961aca8ae', file: 'Qwen3.5-2B-Q4_K_M.gguf', bytes: 1_280_835_840 }
]

/** The sample the template is rendered for. */
export const SAMPLE = { system: 'SYSTEM TEXT', user: 'USER TEXT' }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'tests', 'fixtures', 'llm')
const WINDOW = 4 << 20
/** The header is read no further than this. */
const HEADER_MAX = 96 << 20

/** Reads bytes [at, at + n) of a GGUF from a URL (Range requests) or a local file, in windows. */
function source(where) {
  const cache = new Map()
  const local = !/^https:/.test(where)
  const fd = local ? openSync(where, 'r') : null
  async function window(index) {
    if (cache.has(index)) return cache.get(index)
    const start = index * WINDOW
    if (start >= HEADER_MAX) throw new Error('the header is larger than expected')
    let buf
    if (local) {
      buf = Buffer.alloc(WINDOW)
      buf = buf.subarray(0, readSync(fd, buf, 0, WINDOW, start))
    } else {
      // A server may answer a range with fewer bytes than asked: ask again for the rest.
      const parts = []
      let have = 0
      while (have < WINDOW) {
        const res = await fetch(where, { headers: { Range: `bytes=${start + have}-${start + WINDOW - 1}` }, redirect: 'follow' })
        if (res.status !== 206) throw new Error(`HTTP ${res.status} for a range of ${where}`)
        const part = Buffer.from(await res.arrayBuffer())
        if (!part.length) break
        parts.push(part)
        have += part.length
      }
      buf = Buffer.concat(parts)
    }
    cache.set(index, buf)
    return buf
  }
  return {
    async read(at, n) {
      const parts = []
      let pos = at
      while (pos < at + n) {
        const w = await window(Math.floor(pos / WINDOW))
        const off = pos % WINDOW
        const take = Math.min(w.length - off, at + n - pos)
        if (take <= 0) throw new Error('the file ended inside its header')
        parts.push(w.subarray(off, off + take))
        pos += take
      }
      return Buffer.concat(parts)
    },
    close() {
      if (fd !== null) closeSync(fd)
    }
  }
}

/** The GGUF header's metadata: the keys this script needs, big arrays skipped. */
async function readMetadata(src) {
  let at = 0
  const take = async (n) => {
    const b = await src.read(at, n)
    at += n
    return b
  }
  const u32 = async () => (await take(4)).readUInt32LE(0)
  const u64 = async () => Number((await take(8)).readBigUInt64LE(0))
  const str = async () => (await take(await u64())).toString('utf8')
  const SIZES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }
  async function scalar(type) {
    const b = await take(SIZES[type])
    switch (type) {
      case 0: return b.readUInt8(0)
      case 1: return b.readInt8(0)
      case 2: return b.readUInt16LE(0)
      case 3: return b.readInt16LE(0)
      case 4: return b.readUInt32LE(0)
      case 5: return b.readInt32LE(0)
      case 6: return b.readFloatLE(0)
      case 7: return b.readUInt8(0) !== 0
      case 10: return Number(b.readBigUInt64LE(0))
      case 11: return Number(b.readBigInt64LE(0))
      case 12: return b.readDoubleLE(0)
    }
    throw new Error(`unknown GGUF type ${type}`)
  }
  const KEEP = new Set(['tokenizer.ggml.tokens', 'tokenizer.ggml.token_type'])
  async function value(type, key) {
    if (type === 8) return str()
    if (type !== 9) return scalar(type)
    const itemType = await u32()
    const count = await u64()
    if (!KEEP.has(key)) {
      // Skipped: merges, scores and the rest.
      if (itemType === 8) {
        for (let i = 0; i < count; i++) {
          const n = await u64()
          at += n
        }
      }
      else at += count * SIZES[itemType]
      return null
    }
    const out = new Array(count)
    for (let i = 0; i < count; i++) out[i] = itemType === 8 ? await str() : await scalar(itemType)
    return out
  }
  if ((await take(4)).toString('latin1') !== 'GGUF') throw new Error('not a GGUF file')
  const version = await u32()
  if (version < 2) throw new Error(`GGUF version ${version} is not supported`)
  await u64() // tensors
  const kvs = await u64()
  const meta = {}
  for (let i = 0; i < kvs; i++) {
    const key = await str()
    meta[key] = await value(await u32(), key)
  }
  return meta
}

/** Renders `template` with Jinja2's sandbox (python3 -P -E: no current folder on the path, no PYTHON* variables; the user's site keeps Jinja2): thinking off, the generation prompt on, no BOS text (the tokenizer adds it). */
function render(template) {
  const code = [
    'import json, sys',
    'from jinja2.sandbox import ImmutableSandboxedEnvironment',
    'a = json.load(sys.stdin)',
    'env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True)',
    'def fail(m): raise Exception(m)',
    'env.globals["raise_exception"] = fail',
    'env.globals["strftime_now"] = lambda f: "26 Jul 2024"',
    't = env.from_string(a["template"])',
    'msgs = [{"role": "system", "content": a["system"]}, {"role": "user", "content": a["user"]}]',
    'sys.stdout.write(t.render(messages=msgs, add_generation_prompt=True, enable_thinking=False, bos_token="", eos_token="", tools=None))'
  ].join('\n')
  const r = spawnSync('python3', ['-P', '-E', '-c', code], { input: JSON.stringify({ template, ...SAMPLE }), encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`rendering the template failed: ${r.stderr}`)
  return r.stdout
}

async function save(pin, where) {
  const src = source(where)
  try {
    const meta = await readMetadata(src)
    const tokens = meta['tokenizer.ggml.tokens']
    const types = meta['tokenizer.ggml.token_type']
    if (!Array.isArray(tokens) || !Array.isArray(types) || tokens.length !== types.length) throw new Error('no vocabulary in the header')
    // llama.cpp's token types: 3 CONTROL, 4 USER_DEFINED.
    const special = tokens.filter((_, i) => types[i] === 3 || types[i] === 4)
    const template = meta['tokenizer.chat_template']
    if (typeof template !== 'string') throw new Error('no chat template in the header')
    mkdirSync(outDir, { recursive: true })
    const record = {
      id: pin.id,
      source: `https://huggingface.co/${pin.repo}/resolve/${pin.commit}/${pin.file}`,
      architecture: meta['general.architecture'] ?? null,
      vocabulary: tokens.length,
      addBos: meta['tokenizer.ggml.add_bos_token'] ?? null,
      bos: typeof meta['tokenizer.ggml.bos_token_id'] === 'number' ? tokens[meta['tokenizer.ggml.bos_token_id']] : null,
      templateSha256: createHash('sha256').update(template).digest('hex'),
      special
    }
    writeFileSync(path.join(outDir, `${pin.id}-special.json`), `${JSON.stringify(record, null, 1)}\n`)
    writeFileSync(path.join(outDir, `${pin.id}-template.jinja`), template)
    writeFileSync(path.join(outDir, `${pin.id}-chat.txt`), render(template))
    console.log(`llm-special-tokens: ${pin.id}: ${special.length} special tokens of ${tokens.length}, template ${record.templateSha256.slice(0, 12)}`)
  } finally {
    src.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = new Map()
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--file') {
      const [id, file] = (process.argv[++i] ?? '').split('=')
      files.set(id, file)
    }
  }
  for (const pin of PINS) {
    await save(pin, files.get(pin.id) ?? `https://huggingface.co/${pin.repo}/resolve/${pin.commit}/${pin.file}`)
  }
}
