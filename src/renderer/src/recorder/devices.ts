import { friendlyError, type RecorderError } from '../../../shared/recording/errors'

type InputKind = 'microphone' | 'camera'

let labelsRequested = false
/** Why a kind of device could not be opened when its labels were requested (e.g. blocked in Windows privacy settings). */
const blocked: Record<InputKind, RecorderError | null> = { microphone: null, camera: null }

export interface InputDevices {
  devices: MediaDeviceInfo[]
  /** Set when access to that kind of device is blocked or failed, with a message to show. */
  blocked: Record<InputKind, RecorderError | null>
}

/**
 * Lists cameras and microphones without opening them. Device labels are only
 * hidden before media permission was ever granted; in that case the devices are
 * opened once per app session to reveal them (never on every visit to Home).
 */
export async function listInputDevices(): Promise<InputDevices> {
  const list = await navigator.mediaDevices.enumerateDevices()
  const inputs = list.filter((d) => d.kind === 'audioinput' || d.kind === 'videoinput')
  if (labelsRequested || inputs.length === 0 || inputs.some((d) => d.label)) return { devices: list, blocked: { ...blocked } }
  labelsRequested = true
  const probes: [InputKind, MediaStreamConstraints][] = [
    ['microphone', { audio: true }],
    ['camera', { video: true }]
  ]
  for (const [kind, constraints] of probes) {
    try {
      const s = await navigator.mediaDevices.getUserMedia(constraints)
      s.getTracks().forEach((t) => t.stop())
      blocked[kind] = null
    } catch (err) {
      // No device of this kind is fine; anything else (access denied, device busy) is worth saying.
      const name = (err as DOMException | null)?.name
      blocked[kind] = name === 'NotFoundError' || name === 'OverconstrainedError' ? null : friendlyError(err, kind)
    }
  }
  return { devices: await navigator.mediaDevices.enumerateDevices(), blocked: { ...blocked } }
}

/** Calls `cb` when a device is plugged in or removed. */
export function onDevicesChanged(cb: () => void): () => void {
  navigator.mediaDevices.addEventListener('devicechange', cb)
  return () => navigator.mediaDevices.removeEventListener('devicechange', cb)
}

/** Microphones the user can pick (the "default"/"communications" aliases are hidden). */
export const microphones = (devices: MediaDeviceInfo[]): MediaDeviceInfo[] =>
  devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')

export const cameras = (devices: MediaDeviceInfo[]): MediaDeviceInfo[] => devices.filter((d) => d.kind === 'videoinput')

/** Level 0..1 from a block of samples: RMS on a 60 dB scale, so speech moves the meter visibly. */
export function levelFromSamples(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / Math.max(1, samples.length))
  const db = 20 * Math.log10(rms + 1e-9)
  return Math.min(1, Math.max(0, (db + 60) / 60))
}

/**
 * Shows camera `deviceId` live in `video` (mirrored by CSS) at a small size and frame rate,
 * so the preview costs little; `onLive` is called once frames arrive. Returns a stop function
 * that releases the camera at once (before a recording opens it at full size).
 */
export function previewCamera(deviceId: string, video: HTMLVideoElement, onLive: () => void, onError: (err: RecorderError) => void): () => void {
  let stopped = false
  let stream: MediaStream | null = null
  const live = (): void => {
    if (!stopped) onLive()
  }
  void (async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 480 }, height: { ideal: 270 }, frameRate: { ideal: 30, max: 30 } }
      })
      if (stopped) {
        s.getTracks().forEach((t) => t.stop())
        return
      }
      stream = s
      video.srcObject = s
      video.addEventListener('loadeddata', live, { once: true })
      await video.play().catch(() => undefined)
    } catch (err) {
      if (!stopped) onError(friendlyError(err, 'camera'))
    }
  })()
  return () => {
    stopped = true
    video.removeEventListener('loadeddata', live)
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    video.srcObject = null
  }
}

/**
 * Shows the live input level of microphone `deviceId` by scaling `bar` (no React
 * re-render per frame). Runs one AnalyserNode and a requestAnimationFrame loop, which
 * the browser pauses while the window is hidden. Returns a stop function.
 */
export function meterMicrophone(deviceId: string, bar: HTMLElement, onError: (err: RecorderError) => void): () => void {
  let stopped = false
  let raf = 0
  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null
  void (async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      })
      if (stopped) {
        s.getTracks().forEach((t) => t.stop())
        return
      }
      stream = s
      ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      ctx.createMediaStreamSource(s).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      let shown = 0
      let drawn = -1
      const tick = (): void => {
        analyser.getFloatTimeDomainData(samples)
        const level = levelFromSamples(samples)
        // Rises at once, falls gently: easier to read than the raw level.
        shown = level > shown ? level : shown * 0.85 + level * 0.15
        // Only visible changes touch the page, so silence costs no repaints.
        if (Math.abs(shown - drawn) > 0.01) {
          drawn = shown
          bar.style.transform = `scaleX(${shown.toFixed(3)})`
        }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    } catch (err) {
      if (!stopped) onError(friendlyError(err, 'microphone'))
    }
  })()
  return () => {
    stopped = true
    cancelAnimationFrame(raf)
    stream?.getTracks().forEach((t) => t.stop())
    void ctx?.close()
    bar.style.transform = 'scaleX(0)'
  }
}
