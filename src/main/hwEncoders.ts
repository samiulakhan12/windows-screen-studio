import { spawn } from 'node:child_process'
import type { Av1Encoder, H264Encoder, HevcEncoder } from '../shared/api/export'
import { ffmpegPath } from './ffmpeg'

export type { H264Encoder }

/** The encoders of H.264, HEVC and AV1 whose input format and GPU options are set here (output-and-languages §5.4). */
export type VideoCodecEncoder = H264Encoder | HevcEncoder | Av1Encoder

/**
 * GPU encoders in order of preference (NVIDIA, Intel, AMD, then a hardware encoder
 * found through Windows Media Foundation). Each is used only after a test encode.
 */
export const HARDWARE_ENCODERS: H264Encoder[] = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf']

/**
 * Input pixel format each encoder accepts: Intel, AMD and Media Foundation want NV12 (for H.264, HEVC
 * and AV1 alike); NVENC and the software encoders take planar 4:2:0.
 */
export const encoderPixelFormat = (encoder: VideoCodecEncoder): 'nv12' | 'yuv420p' => (/_(qsv|amf|mf)$/.test(encoder) ? 'nv12' : 'yuv420p')

/**
 * Options that make an encoder run on the GPU. ffmpeg's h264_mf otherwise picks
 * Microsoft's software H.264 encoder (`-hw_encoding` defaults to false), which is
 * present on every Windows install: the probe would always pass and the "GPU"
 * encoder would really be a CPU one, slower and worse than x264. With the flag it
 * only works where a hardware encoder exists. The probe and every real encode
 * (exports, proxies) must pass the same options, so a passing probe means the real
 * encode gets the same encoder.
 */
export function gpuEncoderOptions(encoder: VideoCodecEncoder): string[] {
  // hevc_mf likewise: without the flag it can pick Windows' own software HEVC encoder (Mfh265enc.dll,
  // or the one in HEVC Video Extensions), the very encoder output-and-languages §0 decision 1 keeps out.
  return encoder === 'h264_mf' || encoder === 'hevc_mf' ? ['-hw_encoding', '1'] : []
}

/** ffmpeg arguments of the test encode for `encoder`. */
export function probeArgs(encoder: H264Encoder): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'color=c=black:s=320x240:r=30',
    '-frames:v', '10',
    '-pix_fmt', encoderPixelFormat(encoder),
    '-c:v', encoder,
    ...gpuEncoderOptions(encoder),
    '-f', 'null',
    '-'
  ]
}

/** Tries a tiny encode; an encoder being compiled in does not mean the GPU/driver supports it. */
export function probeEncoder(encoder: H264Encoder, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(ffmpegPath(), probeArgs(encoder), { windowsHide: true })
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

/** Working H.264 encoders, best first: the GPU encoders that pass a test encode, then always libx264. */
export async function detectWith(platform: NodeJS.Platform, probe: (e: H264Encoder) => Promise<boolean>): Promise<H264Encoder[]> {
  // Media Foundation exists only on Windows.
  const candidates = platform === 'win32' ? HARDWARE_ENCODERS : HARDWARE_ENCODERS.filter((e) => e !== 'h264_mf')
  const working: H264Encoder[] = []
  for (const enc of candidates) {
    if (await probe(enc)) working.push(enc)
  }
  return [...working, 'libx264']
}

let detected: Promise<H264Encoder[]> | null = null

/** Working H.264 encoders on this machine, best first; always ends with libx264. Cached. */
export function detectH264Encoders(): Promise<H264Encoder[]> {
  detected ??= detectWith(process.platform, (e) => probeEncoder(e))
  return detected
}
