import { spawn } from 'node:child_process'
import type { H264Encoder } from '../shared/api/export'
import { ffmpegPath } from './ffmpeg'

export type { H264Encoder }

/** GPU encoders in order of preference (NVIDIA, Intel, AMD, then Windows Media Foundation). */
export const HARDWARE_ENCODERS: H264Encoder[] = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf']

/** Input pixel format each encoder accepts: Intel, AMD and Media Foundation want NV12. */
export const encoderPixelFormat = (encoder: H264Encoder): 'nv12' | 'yuv420p' =>
  encoder === 'h264_qsv' || encoder === 'h264_amf' || encoder === 'h264_mf' ? 'nv12' : 'yuv420p'

/** Tries a tiny encode; an encoder being compiled in does not mean the GPU/driver supports it. */
export function probeEncoder(encoder: H264Encoder, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'color=c=black:s=320x240:r=30',
      '-frames:v', '10',
      '-pix_fmt', encoderPixelFormat(encoder),
      '-c:v', encoder,
      '-f', 'null',
      '-'
    ]
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

let detected: Promise<H264Encoder[]> | null = null

/** Working H.264 encoders on this machine, best first; always ends with libx264. Cached. */
export function detectH264Encoders(): Promise<H264Encoder[]> {
  if (!detected) {
    detected = (async () => {
      const candidates = process.platform === 'win32' ? HARDWARE_ENCODERS : HARDWARE_ENCODERS.filter((e) => e !== 'h264_mf')
      const working: H264Encoder[] = []
      for (const enc of candidates) {
        if (await probeEncoder(enc)) working.push(enc)
      }
      return [...working, 'libx264']
    })()
  }
  return detected
}
