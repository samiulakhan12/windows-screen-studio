let labelsRequested = false

/**
 * Lists cameras and microphones without opening them. Device labels are only
 * hidden before media permission was ever granted; in that case the devices are
 * opened once per app session to reveal them (never on every visit to Home).
 */
export async function listInputDevices(): Promise<MediaDeviceInfo[]> {
  const list = await navigator.mediaDevices.enumerateDevices()
  const inputs = list.filter((d) => d.kind === 'audioinput' || d.kind === 'videoinput')
  if (labelsRequested || inputs.length === 0 || inputs.some((d) => d.label)) return list
  labelsRequested = true
  for (const constraints of [{ audio: true }, { video: true }]) {
    try {
      const s = await navigator.mediaDevices.getUserMedia(constraints)
      s.getTracks().forEach((t) => t.stop())
    } catch {
      // No device of this kind, or access denied: labels stay generic.
    }
  }
  return navigator.mediaDevices.enumerateDevices()
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
