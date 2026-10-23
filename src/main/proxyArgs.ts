/** Re-encodes a MediaRecorder WebM into a seekable H.264 MP4 with short GOPs. */
export function proxyArgs(input: string, output: string, withAudio: boolean): string[] {
  return [
    '-y',
    '-hide_banner',
    '-i', input,
    '-map', '0:v:0',
    ...(withAudio ? ['-map', '0:a:0?'] : []),
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    // WebM uses a 1 ms timebase; without an explicit rate ffmpeg would emit 1000 fps.
    '-fps_mode', 'cfr',
    '-r', '60',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '16',
    '-g', '15',
    '-pix_fmt', 'yuv420p',
    ...(withAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    '-movflags', '+faststart',
    output
  ]
}
