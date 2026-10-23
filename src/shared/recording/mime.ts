/**
 * MediaRecorder formats in order of preference. H.264 can use the GPU encoder on
 * Windows (Media Foundation); VP8 is a cheap software fallback; VP9 encodes far too
 * slowly in software to keep up with 60 fps screens.
 */
const H264 = ['video/webm;codecs=h264', 'video/x-matroska;codecs=avc1']
const SOFTWARE = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9']

export function screenMimes(withAudio: boolean, allowH264 = true): string[] {
  const video = allowH264 ? [...H264, ...SOFTWARE] : SOFTWARE
  return [...video.map((m) => (withAudio ? `${m},opus` : m)), 'video/webm']
}

export const CAMERA_MIMES = [...H264, ...SOFTWARE, 'video/webm']
export const AUDIO_MIMES = ['audio/webm;codecs=opus', 'audio/webm']

/** First supported format, or '' to let the browser choose. */
export function pickMime(candidates: string[], isSupported: (mime: string) => boolean): string {
  return candidates.find((m) => isSupported(m)) ?? ''
}

/**
 * Bitrate for screen content: about 0.1 bit per pixel per frame, capped so a 4K
 * screen does not write 60 Mbit/s. Screen content is mostly static, and the encoder
 * uses the budget only for motion.
 */
export function screenBitrate(width: number, height: number, fps = 60): number {
  return Math.round(Math.min(32e6, Math.max(4e6, width * height * fps * 0.1)))
}
