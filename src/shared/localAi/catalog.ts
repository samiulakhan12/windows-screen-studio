/**
 * The text models of AI on this PC (docs/design/smart-tools.md §9.3): pinned by repository, commit,
 * bytes and SHA-256, Apache-2.0, downloaded only from Hugging Face (Qbexel's mirror first once it
 * exists, §0 decision 2, then unsloth's repository at the pinned commit). Nothing downloaded is
 * ever run: the files are model weights the bundled helper reads.
 */
import type { AiTextTask } from '../api/ai'
import type { LocalModelId, LocalModelUse } from '../api/localAi'

export interface LocalModelSpec {
  id: LocalModelId
  name: string
  title: string
  hint: string
  file: string
  bytes: number
  sha256: string
  repo: string
  commit: string
  licence: 'Apache-2.0'
  maker: string
  family: 'qwen' | 'gemma'
  peakMB: number
  minTotalMemGB: number
  /** Default tokens a second read and written (§9.8). */
  read: number
  write: number
  loadS: number
  notes: Partial<Record<AiTextTask, string>>
}

/** The catalogue (§9.3): Recommended first. */
export const LOCAL_MODELS: readonly LocalModelSpec[] = Object.freeze([
  Object.freeze({
    id: 'gemma4-e2b',
    name: 'Gemma 4 E2B',
    title: 'Recommended',
    hint: 'Every language, including Bangla. Needs 12 GB of memory.',
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
    write: 7,
    loadS: 8.2,
    notes: Object.freeze({})
  } satisfies LocalModelSpec),
  Object.freeze({
    id: 'qwen3.5-2b',
    name: 'Qwen3.5 2B',
    title: 'Small',
    hint: 'Rough drafts, for PCs with 8 GB of memory.',
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
    write: 8,
    loadS: 2.0,
    // From the research's samples; decision 9's evaluation replaces them before release.
    notes: Object.freeze({ title: 'Small: titles often repeat the first sentence', summary: 'Small: Bangla summaries are short' })
  } satisfies LocalModelSpec)
])

/** Qbexel's own mirror (§0 decision 2): the same bytes plus the licence and a NOTICE; null until it exists. */
export const LOCAL_MODEL_MIRROR: { repo: string; commit: string } | null = null

/** The Recommended and Small models' ids. */
export const RECOMMENDED: LocalModelId = 'gemma4-e2b'
export const SMALL: LocalModelId = 'qwen3.5-2b'

/** The catalogue entry of `id`; undefined for anything else (paths and URLs included). */
export function localModel(id: string): LocalModelSpec | undefined {
  return typeof id === 'string' ? LOCAL_MODELS.find((m) => m.id === id) : undefined
}

export const isLocalModelId = (v: unknown): v is LocalModelId => typeof v === 'string' && LOCAL_MODELS.some((m) => m.id === v)
export const isLocalModelUse = (v: unknown): v is LocalModelUse => v === 'auto' || isLocalModelId(v)

const hfUrl = (repo: string, commit: string, file: string): string => `https://huggingface.co/${repo}/resolve/${commit}/${encodeURIComponent(file)}`

/** Where `spec` downloads from, in order: the mirror when it exists, then the pinned commit upstream (§9.4). */
export function localModelUrls(spec: LocalModelSpec, mirror: { repo: string; commit: string } | null = LOCAL_MODEL_MIRROR): string[] {
  const upstream = hfUrl(spec.repo, spec.commit, spec.file)
  return mirror ? [hfUrl(mirror.repo, mirror.commit, spec.file), upstream] : [upstream]
}

const GIB = 2 ** 30

/**
 * Why this PC cannot use `spec` (§9.5), or null: no helper in this build; a processor without
 * AVX2, FMA and F16C, or one that could not be checked (`avx2` null); less memory in all than
 * minTotalMemGB − 1 GB (an "8 GB" PC reports as little as 7 GB, as speechModelBlock).
 */
export function localModelBlock(spec: LocalModelSpec, pc: { totalMemBytes: number; avx2: boolean | null; helper: boolean }): 'memory' | 'processor' | 'helper' | null {
  if (!pc.helper) return 'helper'
  if (pc.avx2 !== true) return 'processor'
  if (!(pc.totalMemBytes >= (spec.minTotalMemGB - 1) * GIB)) return 'memory'
  return null
}

/** Whether `spec`'s measured peak fits in `freeMemBytes` (§9.5). */
export const fitsFreeMemory = (spec: Pick<LocalModelSpec, 'peakMB'>, freeMemBytes: number): boolean => freeMemBytes >= spec.peakMB * 2 ** 20

/**
 * The model a run uses now (§9.3 Use): Automatic takes Recommended when it is downloaded, the PC is
 * not blocked for it and its peak fits in the free memory, else Small on the same terms, else
 * none; a pinned choice is used as set when it is downloaded and the PC is not blocked for it (the
 * run still checks the free memory, localRunProblem in messages.ts).
 */
export function pickLocalModel(use: LocalModelUse, ready: readonly LocalModelId[], pc: { totalMemBytes: number; freeMemBytes: number; avx2: boolean | null; helper: boolean }): LocalModelId | null {
  const usable = (id: LocalModelId): LocalModelSpec | null => {
    const spec = localModel(id)
    return spec && ready.includes(id) && !localModelBlock(spec, pc) ? spec : null
  }
  if (use !== 'auto') return usable(use) ? use : null
  for (const id of [RECOMMENDED, SMALL]) {
    const spec = usable(id)
    if (spec && fitsFreeMemory(spec, pc.freeMemBytes)) return id
  }
  return null
}

/** The model suggested at first download: Recommended on PCs with 12 GB or more (as the block reads it), Small below. */
export function suggestedModel(pc: { totalMemBytes: number }): LocalModelId {
  const recommended = localModel(RECOMMENDED)!
  return pc.totalMemBytes >= (recommended.minTotalMemGB - 1) * GIB ? RECOMMENDED : SMALL
}

/** Threads the helper runs with: one per physical core on most PCs, 1 to 8 (§9.2). */
export function llmThreads(logical: number): number {
  const n = Number.isFinite(logical) ? Math.floor(logical) : 1
  return Math.min(8, Math.max(1, Math.floor(n / 2)))
}
