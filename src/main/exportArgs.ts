import type { ExportJob } from '../shared/api/export'

const CRF: Record<ExportJob['quality'], string> = { high: '17', medium: '22', small: '27' }
const PRESET: Record<ExportJob['quality'], string> = { high: 'medium', medium: 'faster', small: 'faster' }

/** Encoder reading raw RGBA frames from stdin, optionally muxing trimmed audio from `audioInput`. */
export function exportArgs(job: ExportJob, audioInput: string | null): string[] {
  const input = [
    '-y',
    '-hide_banner',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${job.width}x${job.height}`,
    '-r', String(job.fps),
    '-i', 'pipe:0'
  ]
  if (job.format === 'gif') {
    return [
      ...input,
      '-vf', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
      '-loop', '0',
      job.outputPath
    ]
  }
  const audio = job.audio && audioInput
  return [
    ...input,
    ...(audio ? ['-ss', job.audio!.start.toFixed(3), '-to', job.audio!.end.toFixed(3), '-i', audioInput!] : []),
    '-map', '0:v:0',
    ...(audio ? ['-map', '1:a:0?'] : []),
    '-c:v', 'libx264',
    '-preset', PRESET[job.quality],
    '-crf', CRF[job.quality],
    '-pix_fmt', 'yuv420p',
    ...(audio ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
    '-movflags', '+faststart',
    job.outputPath
  ]
}
