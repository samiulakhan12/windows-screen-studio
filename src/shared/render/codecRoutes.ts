/**
 * Routes for the codecs added in wave 12 and for transparent exports (docs/design/output-and-languages.md
 * §5.3): which encoders to try, in order, for HEVC, AV1, VP9 with alpha and the editing formats. Pure.
 *
 * HEVC runs on the graphics card only while CODEC_POLICY.hevcSoftware is off (§0 decision 1): WebCodecs
 * on the GPU, then the GPU encoders the probe found; with neither there is no route, and *Software*
 * gives none. libx265 joins only when the owner turns the policy on.
 */
import type { Av1Encoder, ExportCapabilities, HevcEncoder } from '../api/export'
import type { ExportRoute } from './exportPlan'
import type { ExportOptions } from './exportPresets'
import { codecAllowed, codecOf, encoderAllowed } from './proFormats'

/** What this PC can make: WebCodecs on the GPU, and the GPU encoders the probe found, best first (§5.9). */
export interface CodecCaps {
  webcodecs: { hevc: boolean; av1: boolean }
  gpu: { hevc: HevcEncoder[]; av1: Av1Encoder[] }
  overrides: ExportCapabilities['overrides']
}

/** The GPU encoders of each codec in the order they are tried (§5.3). */
const HEVC_GPU_ORDER: readonly HevcEncoder[] = ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf']
const AV1_GPU_ORDER: readonly Av1Encoder[] = ['av1_nvenc', 'av1_qsv', 'av1_amf']

/**
 * Whether AMD's AV1 encoder in this ffmpeg build makes `width`×`height` without padding it (§5.4):
 * ffmpeg 6.1's av1_amf pads 1920×1080 to 1920×1082 (trac #10266), so it is used only when the width
 * is a multiple of 64 and the height a multiple of 16 (1280×720, 2560×1440, 3840×2160).
 */
export function amfAv1Fits(width: number, height: number): boolean {
  return width > 0 && height > 0 && width % 64 === 0 && height % 16 === 0
}

/** `found` in the order of `order`, each once, only those on the allow-list. */
function inOrder<E extends string>(order: readonly E[], found: readonly E[]): E[] {
  return order.filter((e) => found.includes(e) && encoderAllowed(e))
}

const ffmpeg = (encoder: Extract<ExportRoute, { video: 'ffmpeg' }>['encoder']): ExportRoute => ({ video: 'ffmpeg', encoder })

/**
 * The routes to try for a non-default codec or a transparent export, in order (§5.3):
 *
 * - HEVC: WebCodecs on the GPU, then hevc_nvenc, hevc_qsv, hevc_amf, hevc_mf, each only when probed.
 *   *Software* gives no route (libx265 only with CODEC_POLICY.hevcSoftware).
 * - AV1: WebCodecs on the GPU, then av1_nvenc, av1_qsv, av1_amf (only for sizes it does not pad), then
 *   libaom-av1. *Software* is libaom-av1. The test override `webcodecs-software` puts WebCodecs'
 *   software AV1 first, as for H.264, so the WebCodecs path runs under Linux; `ffmpeg` skips WebCodecs.
 * - VP9 with alpha: libvpx-vp9 on raw frames.
 * - CineForm, Animation, ProRes: their ffmpeg encoder on raw frames.
 *
 * A transparent export gets raw-frame routes only: WebCodecs drops the alpha.
 */
export function codecRoutes(o: Pick<ExportOptions, 'format' | 'codec' | 'alpha' | 'encoder' | 'targetSizeMB' | 'resolution' | 'aspect'>, caps: CodecCaps, size: { width: number; height: number }): ExportRoute[] {
  const codec = codecOf(o)
  if (!codecAllowed(codec)) return []
  const forced = caps.overrides.videoEncoder
  const software = o.encoder === 'software'
  switch (codec) {
    case 'hevc': {
      if (o.alpha) return []
      const routes: ExportRoute[] = []
      if (!software) {
        if (caps.webcodecs.hevc && forced !== 'ffmpeg' && forced !== 'webcodecs-software') routes.push({ video: 'webcodecs', codec: 'hevc', hardware: true })
        for (const e of inOrder(HEVC_GPU_ORDER, caps.gpu.hevc)) routes.push(ffmpeg(e))
      }
      if (encoderAllowed('libx265')) routes.push(ffmpeg('libx265'))
      return routes
    }
    case 'av1': {
      if (o.alpha) return []
      const aom = ffmpeg('libaom-av1')
      if (forced === 'webcodecs-software') return [{ video: 'webcodecs', codec: 'av1', hardware: false }, aom]
      if (software) return [aom]
      const routes: ExportRoute[] = []
      if (caps.webcodecs.av1 && forced !== 'ffmpeg') routes.push({ video: 'webcodecs', codec: 'av1', hardware: true })
      for (const e of inOrder(AV1_GPU_ORDER, caps.gpu.av1)) {
        if (e === 'av1_amf' && !amfAv1Fits(size.width, size.height)) continue
        routes.push(ffmpeg(e))
      }
      return [...routes, aom]
    }
    case 'vp9':
      return [ffmpeg('libvpx-vp9')]
    case 'cineform':
      return [ffmpeg('cfhd')]
    case 'animation':
      return [ffmpeg('qtrle')]
    case 'prores-422':
    case 'prores-4444':
      return encoderAllowed('prores_ks') ? [ffmpeg('prores_ks')] : []
    default:
      // H.264 with a transparent background cannot happen (validateJob refuses it): no route.
      return []
  }
}
