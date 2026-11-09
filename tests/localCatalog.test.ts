import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOCAL_MODELS, LOCAL_MODEL_MIRROR, llmThreads, localModel, localModelBlock, localModelUrls, pickLocalModel, suggestedModel } from '../src/shared/localAi/catalog'
import { freeMemoryMessage, LOCAL_MESSAGES, localRunProblem, pcLine } from '../src/shared/localAi/messages'
import { allowDownloadUrl } from '../src/main/speech/download'

/*
 * AI on this PC's catalogue (docs/design/smart-tools.md §9.3, §9.5): tests 63, 70, 72 and 130.
 */

const GB = 2 ** 30
const fixtures = path.join(__dirname, 'fixtures', 'llm')
const pc = (over: Partial<{ totalMemBytes: number; freeMemBytes: number; avx2: boolean | null; helper: boolean }> = {}) => ({ totalMemBytes: 16 * GB, freeMemBytes: 8 * GB, avx2: true as boolean | null, helper: true, ...over })

describe('the catalogue (test 63)', () => {
  it('holds the two pinned Apache-2.0 models, Recommended first, with §9.3’s sizes, SHA-256 and full commits', () => {
    expect(LOCAL_MODELS.map((m) => m.id)).toEqual(['gemma4-e2b', 'qwen3.5-2b'])
    const [gemma, qwen] = LOCAL_MODELS
    expect(gemma).toMatchObject({
      title: 'Recommended',
      name: 'Gemma 4 E2B',
      file: 'gemma-4-E2B-it-Q4_K_M.gguf',
      bytes: 3_106_738_272,
      sha256: '740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8',
      repo: 'unsloth/gemma-4-E2B-it-GGUF',
      commit: '0314792d7f1f7e229411f620751375812bb9faf2',
      licence: 'Apache-2.0',
      maker: 'Google',
      family: 'gemma',
      peakMB: 3848,
      minTotalMemGB: 12,
      read: 250,
      write: 7
    })
    expect(qwen).toMatchObject({
      title: 'Small',
      name: 'Qwen3.5 2B',
      file: 'Qwen3.5-2B-Q4_K_M.gguf',
      bytes: 1_280_835_840,
      sha256: 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223',
      repo: 'unsloth/Qwen3.5-2B-GGUF',
      commit: 'f6d5376be1edb4d416d56da11e5397a961aca8ae',
      licence: 'Apache-2.0',
      maker: 'Alibaba Cloud',
      family: 'qwen',
      peakMB: 2226,
      minTotalMemGB: 8,
      read: 120,
      write: 8
    })
    for (const m of LOCAL_MODELS) {
      expect(m.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(localModel(m.id)).toBe(m)
    }
    expect(qwen.notes.title).toBe('Small: titles often repeat the first sentence')
    expect(localModel('../gemma.gguf')).toBeUndefined()
    expect(localModel('https://huggingface.co/x')).toBeUndefined()
  })

  it('downloads from huggingface.co at the pinned commit, addresses allowDownloadUrl accepts; the mirror first when there is one', () => {
    expect(LOCAL_MODEL_MIRROR).toBeNull()
    for (const m of LOCAL_MODELS) {
      const urls = localModelUrls(m)
      expect(urls).toEqual([`https://huggingface.co/${m.repo}/resolve/${m.commit}/${m.file}`])
      for (const u of urls) expect(allowDownloadUrl(new URL(u))).toBe(true)
      const mirrored = localModelUrls(m, { repo: 'qbexel/flown-models', commit: 'a'.repeat(40) })
      expect(mirrored).toEqual([`https://huggingface.co/qbexel/flown-models/resolve/${'a'.repeat(40)}/${m.file}`, urls[0]])
      for (const u of mirrored) expect(allowDownloadUrl(new URL(u))).toBe(true)
    }
  })

  it('the fixture script reads the same pins (scripts/llm-special-tokens.mjs PINS)', async () => {
    // @ts-expect-error: a plain .mjs script without types
    const { PINS } = (await import('../scripts/llm-special-tokens.mjs')) as { PINS: { id: string; repo: string; commit: string; file: string; bytes: number }[] }
    expect(PINS).toEqual(LOCAL_MODELS.map((m) => ({ id: m.id, repo: m.repo, commit: m.commit, file: m.file, bytes: m.bytes })))
  })

  it('threads: half the logical processors, 1 to 8', () => {
    expect([1, 2, 3, 4, 8, 16, 32, NaN].map(llmThreads)).toEqual([1, 1, 1, 2, 4, 8, 8, 1])
  })
})

describe('licences, from fixtures (test 70)', () => {
  const read = (f: string): string => readFileSync(path.join(fixtures, 'licences', f), 'utf8')

  it('unsloth’s READMEs say apache-2.0 in their front matter; Gemma’s links the Gemma 4 licence page', () => {
    const gemma = read('unsloth-gemma-4-E2B-it-GGUF.README.front-matter.md')
    const qwen = read('unsloth-Qwen3.5-2B-GGUF.README.front-matter.md')
    expect(gemma).toMatch(/^license: apache-2\.0$/m)
    expect(gemma).toMatch(/^license_link: https:\/\/ai\.google\.dev\/gemma\/docs\/gemma_4_license$/m)
    expect(gemma).toMatch(/^base_model: google\/gemma-4-E2B-it$/m)
    expect(qwen).toMatch(/^license: apache-2\.0$/m)
    expect(qwen).toMatch(/Qwen\/Qwen3\.5-2B/)
  })

  it('upstream: Qwen/Qwen3.5-2B’s LICENSE is Apache-2.0; google/gemma-4-E2B-it links a page that is the Apache 2.0 text', () => {
    const license = read('Qwen-Qwen3.5-2B.LICENSE')
    expect(license).toMatch(/Apache License\s+Version 2\.0, January 2004/)
    expect(license).toMatch(/END OF TERMS AND CONDITIONS/)
    const google = read('google-gemma-4-E2B-it.README.front-matter.md')
    expect(google).toMatch(/^license: apache-2\.0$/m)
    expect(google).toMatch(/^license_link: https:\/\/ai\.google\.dev\/gemma\/docs\/gemma_4_license$/m)
    const page = read('gemma-4-license-page.txt')
    expect(page.startsWith('Apache License\nVersion 2.0, January 2004')).toBe(true)
    expect(page).toMatch(/TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/)
    expect(page.trim().endsWith('END OF TERMS AND CONDITIONS')).toBe(true)
  })

  it('the notice names llama.cpp, ggml, the Mozilla Foundation, YaRN’s authors, ggllm.cpp and the crates', () => {
    const notice = readFileSync(path.join(__dirname, '..', 'resources', 'notices', '11-llama-cpp.txt'), 'utf8')
    for (const name of ['llama.cpp', 'The ggml authors', 'Mozilla Foundation', 'Jeffrey Quesnelle and Bowen Peng', 'ggllm.cpp', 'llama-cpp-sys-2 0.1.161', 'llama-cpp-2', 'd81235049384534c167caea52b85a694f6103d14', 'e7af607ebd5ec2932709ef918c17cca2f9b0fce4', 'Unicode']) {
      expect(notice).toContain(name)
    }
  })
})

describe('gates (test 72)', () => {
  const [gemma, qwen] = LOCAL_MODELS

  it('no AVX2 blocks both for the processor; an unknown processor too; no helper blocks first', () => {
    expect(localModelBlock(gemma, pc({ avx2: false }))).toBe('processor')
    expect(localModelBlock(qwen, pc({ avx2: false }))).toBe('processor')
    expect(localModelBlock(qwen, pc({ avx2: null }))).toBe('processor')
    expect(localModelBlock(qwen, pc({ helper: false, avx2: false }))).toBe('helper')
    expect(localModelBlock(qwen, pc())).toBeNull()
  })

  it('7.2 GB in all blocks Recommended for memory, not Small; 11 GB is enough for Recommended', () => {
    expect(localModelBlock(gemma, pc({ totalMemBytes: 7.2 * GB }))).toBe('memory')
    expect(localModelBlock(qwen, pc({ totalMemBytes: 7.2 * GB }))).toBeNull()
    expect(localModelBlock(qwen, pc({ totalMemBytes: 6.9 * GB }))).toBe('memory')
    expect(localModelBlock(gemma, pc({ totalMemBytes: 11 * GB }))).toBeNull()
  })

  it('free memory under the peak refuses the run with §9.5’s message', () => {
    const r = localRunProblem('auto', ['gemma4-e2b'], pc({ freeMemBytes: 2.6 * GB }))
    expect(r).toEqual({ message: 'AI on this PC needs about 3.8 GB of free memory and 2.6 GB is free. Close some apps, or download the Small model.' })
    expect(localRunProblem('qwen3.5-2b', ['qwen3.5-2b'], pc({ freeMemBytes: 1 * GB }))).toEqual({ message: 'AI on this PC needs about 2.2 GB of free memory and 1.0 GB is free. Close some apps.' })
  })

  it('the PC’s line and why AI on this PC cannot run', () => {
    expect(pcLine(pc())).toBe('This PC: 16 GB of memory · processor OK')
    expect(pcLine(pc({ avx2: false }))).toBe("This PC's processor is too old for AI on this PC (it needs AVX2).")
    expect(pcLine(pc({ avx2: null }))).toBe("Flown could not check this PC's processor.")
    expect(pcLine(pc({ helper: false }))).toBe('AI on this PC is not part of this build.')
    expect(localRunProblem('auto', ['qwen3.5-2b'], pc({ helper: false }))).toEqual({ message: LOCAL_MESSAGES.notInBuild })
    expect(localRunProblem('auto', ['qwen3.5-2b'], pc({ avx2: null }))).toEqual({ message: LOCAL_MESSAGES.processorUnknown })
    expect(localRunProblem('auto', [], pc())).toEqual({ message: LOCAL_MESSAGES.noModel })
  })
})

describe('Use (test 130)', () => {
  it('Automatic picks Recommended when it is ready and its peak fits in the free memory', () => {
    expect(pickLocalModel('auto', ['gemma4-e2b', 'qwen3.5-2b'], pc({ freeMemBytes: 4 * GB }))).toBe('gemma4-e2b')
    expect(localRunProblem('auto', ['gemma4-e2b', 'qwen3.5-2b'], pc({ freeMemBytes: 4 * GB }))).toEqual({ id: 'gemma4-e2b' })
  })

  it('Small when memory is short for Recommended, or Recommended is missing or blocked', () => {
    expect(pickLocalModel('auto', ['gemma4-e2b', 'qwen3.5-2b'], pc({ freeMemBytes: 3 * GB }))).toBe('qwen3.5-2b')
    expect(pickLocalModel('auto', ['qwen3.5-2b'], pc({ freeMemBytes: 8 * GB }))).toBe('qwen3.5-2b')
    expect(pickLocalModel('auto', ['gemma4-e2b', 'qwen3.5-2b'], pc({ totalMemBytes: 8 * GB, freeMemBytes: 6 * GB }))).toBe('qwen3.5-2b')
  })

  it('fails with §9.5’s message when neither fits', () => {
    const tight = pc({ freeMemBytes: 1.5 * GB })
    expect(pickLocalModel('auto', ['gemma4-e2b', 'qwen3.5-2b'], tight)).toBeNull()
    expect(localRunProblem('auto', ['gemma4-e2b', 'qwen3.5-2b'], tight)).toEqual({ message: freeMemoryMessage(LOCAL_MODELS[1], 1.5 * GB, true) })
    expect(freeMemoryMessage(LOCAL_MODELS[1], 1.5 * GB, true)).toBe('AI on this PC needs about 2.2 GB of free memory and 1.5 GB is free. Close some apps.')
  })

  it('a pinned choice is used as set: Recommended even with Small ready, never one not downloaded', () => {
    expect(pickLocalModel('gemma4-e2b', ['gemma4-e2b', 'qwen3.5-2b'], pc({ freeMemBytes: 1 * GB }))).toBe('gemma4-e2b')
    expect(pickLocalModel('qwen3.5-2b', ['gemma4-e2b', 'qwen3.5-2b'], pc({ freeMemBytes: 8 * GB }))).toBe('qwen3.5-2b')
    expect(pickLocalModel('gemma4-e2b', ['qwen3.5-2b'], pc())).toBeNull()
  })

  it('the suggestion at first download: Recommended with 12 GB (an 11-point-something reading), Small below', () => {
    expect(suggestedModel({ totalMemBytes: 16 * GB })).toBe('gemma4-e2b')
    expect(suggestedModel({ totalMemBytes: 11.4 * GB })).toBe('gemma4-e2b')
    expect(suggestedModel({ totalMemBytes: 7.8 * GB })).toBe('qwen3.5-2b')
  })
})
