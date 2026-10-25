import { createRoot, type Root } from 'react-dom/client'
import type { RecordingApi } from '../../../shared/api/recording'
import { CameraBubble } from '../views/CameraBubble'
import bubbleCss from '../views/CameraBubble.css?inline'

/** A live camera bubble on screen; `close` removes it (safe to call at any time, more than once). */
export interface LiveBubble {
  close(): void
}

type BubbleApi = Pick<RecordingApi, 'allowCameraBubble' | 'dragCameraBubble' | 'resizeCameraBubble' | 'toggleCameraBubble'>

/**
 * Shows `camera` (the track the recording is recording) live in a small always-on-top bubble
 * window while recording.
 *
 * The camera is never opened a second time: many Windows camera drivers refuse a second open of
 * a device (NotReadableError), which could break or delay the recording. Instead this page, which
 * already holds the camera, opens the bubble window itself (window.open of about:blank: a window
 * of this same renderer process, whose document this page can fill) and shows a clone of the
 * recorded track in it. A clone shares the capture; stopping it leaves the recorded track running.
 *
 * Nothing here can stop, delay or corrupt the recording: it is started without being awaited,
 * every step is guarded, and a bubble that cannot open (refused by the main process on a PC that
 * cannot keep it out of the capture, or any error) is simply left out.
 */
export function openCameraBubble(api: BubbleApi, token: string, camera: MediaStreamTrack): LiveBubble {
  let closed = false
  let win: Window | null = null
  let root: Root | null = null
  let clone: MediaStreamTrack | null = null

  const close = (): void => {
    closed = true
    try {
      root?.unmount()
    } catch (err) {
      console.warn('Closing the camera bubble:', err)
    }
    root = null
    clone?.stop()
    clone = null
    try {
      if (win && !win.closed) win.close()
    } catch {
      // Already gone.
    }
    win = null
  }

  void (async () => {
    try {
      const grant = await api.allowCameraBubble(token)
      if (closed) return
      if (!grant.ok) {
        console.info('No live camera bubble:', grant.reason)
        return
      }
      win = window.open('about:blank', grant.name)
      if (!win) return
      const doc = win.document
      doc.title = 'Camera'
      const style = doc.createElement('style')
      style.textContent = bubbleCss
      doc.head.appendChild(style)
      const host = doc.createElement('div')
      host.id = 'bubble-root'
      doc.body.appendChild(host)
      clone = camera.clone()
      root = createRoot(host)
      root.render(<CameraBubble api={api} token={token} stream={new MediaStream([clone])} shape={grant.shape} mirror={grant.mirror} size={grant.size} />)
    } catch (err) {
      console.warn('The live camera bubble could not be shown (the recording is not affected):', err)
      close()
    }
  })()

  return { close }
}
