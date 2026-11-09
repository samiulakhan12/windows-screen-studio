/**
 * Which GPU encoders make HEVC and AV1 on this PC (docs/design/output-and-languages.md §5.9): a
 * 10-frame test encode per encoder, once per codec per session, when the export dialog first needs
 * it, never at start. hevc_mf carries `-hw_encoding 1` in the probe and in every encode.
 *
 * Part P1 writes it; the contracts' stub finds none.
 */
import { ipcMain } from 'electron'
import type { Av1Encoder, FfmpegVideoEncoder, HevcEncoder } from '../shared/api/export'
import { isAppUrl } from './security'

/** The HEVC GPU encoders, best first (libx265 is never probed: CODEC_POLICY.hevcSoftware is off). */
export const HEVC_ENCODERS: HevcEncoder[] = ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf']
/** The AV1 GPU encoders, best first. */
export const AV1_ENCODERS: Av1Encoder[] = ['av1_nvenc', 'av1_qsv', 'av1_amf']

/** ffmpeg arguments of the test encode for `encoder`. Part P1. */
export function probeCodecArgs(encoder: HevcEncoder | Av1Encoder): string[] {
  void encoder
  return []
}

/** The working GPU encoders for `codec`, best first, probed once per session. Part P1. */
export async function probeCodec(codec: 'hevc' | 'av1', run?: (args: string[]) => Promise<boolean>): Promise<FfmpegVideoEncoder[]> {
  void codec
  void run
  return []
}

/** `export:probeCodec`, for the app's own page only. */
export function registerCodecProbeIpc(): void {
  ipcMain.handle('export:probeCodec', (e, codec: unknown) => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
    if (codec !== 'hevc' && codec !== 'av1') throw new Error('Invalid codec')
    return probeCodec(codec)
  })
}
