/**
 * The text reader's models (docs/design/auto-blur.md §5.12, §0 decisions 1 and 10): PaddlePaddle's
 * own PP-OCRv6 ONNX files, Apache-2.0, pinned to their upstream commits by size and SHA-256 and
 * checked before any is parsed (§10.2). The shipped set is the tiny detector, the tiny recogniser and
 * the small recogniser (the careful pass, §5.6), with both recognisers' `inference.yml` (their
 * character lists). Written in full by the contracts step from scripts/privacy/reader-models.json,
 * whose shipping entries test 40 compares with these.
 *
 * The tiny detector's own inference.yml (883 bytes) is not downloaded: its four post-processing
 * numbers are constants in the helper (test 85 checks them against the pinned file).
 */

export interface ReaderFile {
  /** Where the file is kept, in the mirror and in userData/reader-models: '<upstream repository name>/<file>'. */
  file: string
  bytes: number
  /** Lower-case hex. */
  sha256: string
  /** The upstream Hugging Face repository. */
  repo: string
  /** Its pinned commit, which serves these exact bytes. */
  commit: string
}

export const READER_FILES: readonly ReaderFile[] = Object.freeze([
  Object.freeze({
    file: 'PP-OCRv6_tiny_det_onnx/inference.onnx',
    bytes: 1780590,
    sha256: '193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8',
    repo: 'PaddlePaddle/PP-OCRv6_tiny_det_onnx',
    commit: '2ba1506c0380b8f0b03dd142459aac66d4421f6c'
  }),
  Object.freeze({
    file: 'PP-OCRv6_tiny_rec_onnx/inference.onnx',
    bytes: 4462639,
    sha256: '9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6',
    repo: 'PaddlePaddle/PP-OCRv6_tiny_rec_onnx',
    commit: '2612ab37152ae0a677521bae4e1e3d4fb4cf7c30'
  }),
  Object.freeze({
    file: 'PP-OCRv6_tiny_rec_onnx/inference.yml',
    bytes: 55571,
    sha256: '66170210bad538e83fff3c4a3867e547d6bf20b50d64b20347c4b913f3034ea1',
    repo: 'PaddlePaddle/PP-OCRv6_tiny_rec_onnx',
    commit: '2612ab37152ae0a677521bae4e1e3d4fb4cf7c30'
  }),
  Object.freeze({
    file: 'PP-OCRv6_small_rec_onnx/inference.onnx',
    bytes: 21159378,
    sha256: '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634',
    repo: 'PaddlePaddle/PP-OCRv6_small_rec_onnx',
    commit: 'b8f84f0b80c529de40b4fbb3544b84fa7233a513'
  }),
  Object.freeze({
    file: 'PP-OCRv6_small_rec_onnx/inference.yml',
    bytes: 150579,
    sha256: 'ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1',
    repo: 'PaddlePaddle/PP-OCRv6_small_rec_onnx',
    commit: 'b8f84f0b80c529de40b4fbb3544b84fa7233a513'
  })
])

/** Every file's bytes together: what Settings says the download is. */
export const READER_BYTES = 27608757

/** The model set and careful pass Find records in `FindRecord.reader` (§4.1). */
export const READER_ID = 'pp-ocrv6-tiny+small-careful-long'

/**
 * Qbexel's own Hugging Face mirror (decision 10): the five files byte for byte, the Apache-2.0 text
 * and a NOTICE; null until the owner creates it. A release build refuses null (verify-dist, §16.2).
 */
export const READER_MIRROR: { repo: string; commit: string } | null = null

/** Windows OCR as a second reader (§5.13): closed until it passes decision 8's check on the reference PC. */
export const WINDOWS_READER_ALLOWED = false

const hfUrl = (repo: string, commit: string, file: string): string => `https://huggingface.co/${repo}/resolve/${commit}/${file.split('/').map(encodeURIComponent).join('/')}`

/**
 * Where `f` downloads from, in order (§5.12): the mirror when it exists (its own path), then the
 * pinned upstream commit, which serves the pinned bytes. Never any other host.
 */
export function readerUrls(f: ReaderFile, mirror: { repo: string; commit: string } | null = READER_MIRROR): string[] {
  const upstream = hfUrl(f.repo, f.commit, f.file.slice(f.file.indexOf('/') + 1))
  return mirror ? [hfUrl(mirror.repo, mirror.commit, f.file), upstream] : [upstream]
}
