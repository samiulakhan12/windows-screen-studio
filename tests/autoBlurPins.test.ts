import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { READER_BYTES, READER_FILES, READER_ID, READER_MIRROR, WINDOWS_READER_ALLOWED, readerUrls } from '../src/shared/privacy/readerCatalog'

/*
 * The reader's model pins (docs/design/auto-blur.md §5.12, §17.1 test 40): READER_FILES is written
 * from the shipping entries of scripts/privacy/reader-models.json, which the contracts step checked
 * by downloading each file from its pinned upstream commit and measuring its size and SHA-256.
 */

interface Pin {
  repo: string
  commit: string
  file: string
  bytes: number
  sha256: string
  config?: { file: string; bytes: number; sha256: string }
}
const PINS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'privacy', 'reader-models.json'), 'utf8')) as {
  proposedShipping: string[]
  proposedShippingBytes: number
  models: Record<string, Pin>
}

describe('the reader pins', () => {
  it('40. READER_FILES equals the shipping entries of reader-models.json (bytes, SHA-256, repository, commit) and the files sum to 27,608,757 bytes', () => {
    const expected: { file: string; bytes: number; sha256: string; repo: string; commit: string }[] = []
    for (const name of PINS.proposedShipping) {
      const m = PINS.models[name]
      const dir = m.repo.split('/')[1]
      expected.push({ file: `${dir}/${m.file}`, bytes: m.bytes, sha256: m.sha256, repo: m.repo, commit: m.commit })
      // The detector's inference.yml is not downloaded: its numbers are constants in the helper (§5.12).
      if (m.config && name.endsWith('_rec')) expected.push({ file: `${dir}/${m.config.file}`, bytes: m.config.bytes, sha256: m.config.sha256, repo: m.repo, commit: m.commit })
    }
    expect(READER_FILES.map((f) => ({ ...f }))).toEqual(expected)
    const sum = READER_FILES.reduce((s, f) => s + f.bytes, 0)
    expect(sum).toBe(27608757)
    expect(READER_BYTES).toBe(sum)
    // The models alone are reader-models.json's shipping bytes; the recognisers' character lists add the rest.
    expect(READER_FILES.filter((f) => f.file.endsWith('.onnx')).reduce((s, f) => s + f.bytes, 0)).toBe(PINS.proposedShippingBytes)
    for (const f of READER_FILES) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(f.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(f.repo.startsWith('PaddlePaddle/PP-OCRv6_')).toBe(true)
    }
    expect(READER_ID).toBe('pp-ocrv6-tiny+small-careful-long')
    expect(READER_MIRROR).toBeNull()
    expect(WINDOWS_READER_ALLOWED).toBe(false)
    // Upstream at the pinned commit only while the mirror does not exist; the mirror first once it does.
    const det = READER_FILES[0]
    expect(readerUrls(det)).toEqual(['https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx/resolve/2ba1506c0380b8f0b03dd142459aac66d4421f6c/inference.onnx'])
    expect(readerUrls(det, { repo: 'Qbexel/flown-reader', commit: 'c'.repeat(40) })).toEqual([
      `https://huggingface.co/Qbexel/flown-reader/resolve/${'c'.repeat(40)}/PP-OCRv6_tiny_det_onnx/inference.onnx`,
      'https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx/resolve/2ba1506c0380b8f0b03dd142459aac66d4421f6c/inference.onnx'
    ])
  })
})
