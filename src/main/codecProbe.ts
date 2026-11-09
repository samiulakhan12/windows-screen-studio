/**
 * Which GPU encoders make HEVC and AV1 on this PC (docs/design/output-and-languages.md §5.9): a
 * 10-frame test encode per encoder, once per codec per session, when the export dialog first needs
 * it, never at start. hevc_mf carries `-hw_encoding 1` in the probe and in every encode.
 *
 * Only encoders on the allow-list are ever run (ALLOWED_ENCODERS, §5.1), and only GPU encoders: libx265
 * and libaom-av1 are never probed (libaom always works; libx265 is off by the owner's policy).
 */
import { spawn } from 'node:child_process'
import { ipcMain } from 'electron'
import type { Av1Encoder, FfmpegVideoEncoder, HevcEncoder } from '../shared/api/export'
import { encoderAllowed } from '../shared/render/proFormats'
import { ffmpegPath } from './ffmpeg'
import { encoderPixelFormat, gpuEncoderOptions } from './hwEncoders'
import { isAppUrl } from './security'

/** The HEVC GPU encoders, best first (libx265 is never probed: CODEC_POLICY.hevcSoftware is off). */
export const HEVC_ENCODERS: HevcEncoder[] = ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf']
/** The AV1 GPU encoders, best first. */
export const AV1_ENCODERS: Av1Encoder[] = ['av1_nvenc', 'av1_qsv', 'av1_amf']

/** Encoders that exist only on Windows: Media Foundation, and AMD's AV1 encoder of this build. */
const WINDOWS_ONLY: readonly string[] = ['hevc_mf', 'av1_amf']

/** ffmpeg arguments of the test encode for `encoder`: 10 black frames in the encoder's own pixel format, with its GPU options. */
export function probeCodecArgs(encoder: HevcEncoder | Av1Encoder): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    // 320×240: a size every GPU encoder takes, and one av1_amf does not pad (width a multiple of 64, height of 16).
    '-i', 'color=c=black:s=320x240:r=30',
    '-frames:v', '10',
    '-pix_fmt', encoderPixelFormat(encoder),
    '-c:v', encoder,
    ...gpuEncoderOptions(encoder),
    '-f', 'null',
    '-'
  ]
}

/** Longest a test encode may take before it counts as failed. */
const PROBE_TIMEOUT_MS = 8000

/** Runs one test encode with the bundled ffmpeg; true when it exits cleanly. */
function runProbe(args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(ffmpegPath(), args, { windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve(false)
    }, timeoutMs)
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

/** The encoders a probe of `codec` tries on `platform`, best first: allowed ones only, the Windows-only ones on Windows. */
export function probeCandidates(codec: 'hevc' | 'av1', platform: NodeJS.Platform): (HevcEncoder | Av1Encoder)[] {
  const all: (HevcEncoder | Av1Encoder)[] = codec === 'hevc' ? HEVC_ENCODERS : AV1_ENCODERS
  return all.filter((e) => encoderAllowed(e) && (platform === 'win32' || !WINDOWS_ONLY.includes(e)))
}

/** The working GPU encoders for `codec` on `platform`, best first, one test encode each, one after another. */
export async function probeCodecWith(codec: 'hevc' | 'av1', platform: NodeJS.Platform, run: (args: string[]) => Promise<boolean>): Promise<FfmpegVideoEncoder[]> {
  const working: FfmpegVideoEncoder[] = []
  for (const encoder of probeCandidates(codec, platform)) {
    if (await run(probeCodecArgs(encoder)).catch(() => false)) working.push(encoder)
  }
  return working
}

/** Each codec's probe of this session (the promise, so two callers share one probe). */
const probes = new Map<'hevc' | 'av1', Promise<FfmpegVideoEncoder[]>>()

/** The working GPU encoders for `codec`, best first, probed once per session (the first call runs it; later calls get its answer). */
export function probeCodec(codec: 'hevc' | 'av1', run: (args: string[]) => Promise<boolean> = (args) => runProbe(args)): Promise<FfmpegVideoEncoder[]> {
  let probe = probes.get(codec)
  if (!probe) {
    probe = probeCodecWith(codec, process.platform, run)
    probes.set(codec, probe)
  }
  return probe
}

/** Forgets this session's probes (tests). */
export function forgetCodecProbes(): void {
  probes.clear()
}

/** `export:probeCodec`, for the app's own page only. */
export function registerCodecProbeIpc(): void {
  ipcMain.handle('export:probeCodec', (e, codec: unknown) => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
    if (codec !== 'hevc' && codec !== 'av1') throw new Error('Invalid codec')
    return probeCodec(codec)
  })
}
