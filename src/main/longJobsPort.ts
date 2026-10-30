/**
 * The Electron side of long jobs (longJobs.ts): the main window's taskbar progress and thumbnail
 * buttons (Windows), notifications with buttons, keep-awake and the power events. With
 * SSW_JOBS_TRACE=1 on an unpackaged run, every call is also kept in globalThis.__sswJobsTrace so
 * the end-to-end tests can see what the taskbar would show on Windows.
 */
import { app, nativeImage, Notification, powerMonitor, powerSaveBlocker, shell, type NativeImage } from 'electron'
import type { ThumbAction } from '../shared/jobs/longJobs'
import { thumbIcon } from '../shared/jobs/thumbIcons'
import type { PowerEvent, TaskbarPort } from './longJobs'
import { getMainWindow, windowIconPath } from './windows'

type Trace = { at: number; call: string; value: unknown }[]

function tracer(): ((call: string, value: unknown) => void) | null {
  if (app.isPackaged || process.env.SSW_JOBS_TRACE !== '1') return null
  const g = globalThis as { __sswJobsTrace?: Trace }
  g.__sswJobsTrace = []
  return (call, value) => g.__sswJobsTrace!.push({ at: Date.now(), call, value })
}

const icons = new Map<ThumbAction, NativeImage>()
function iconOf(action: ThumbAction): NativeImage {
  let img = icons.get(action)
  if (!img) {
    img = nativeImage.createFromBitmap(Buffer.from(thumbIcon(action, 16)), { width: 16, height: 16, scaleFactor: 1 })
    icons.set(action, img)
  }
  return img
}

/** Notifications must stay referenced until they close, or their buttons stop working. */
const shown = new Set<Notification>()

export function electronTaskbarPort(): TaskbarPort {
  const trace = tracer()
  let blocker: number | null = null
  let flashing = false
  return {
    setProgress(state) {
      trace?.('progress', state)
      const win = getMainWindow()
      if (!win || win.isDestroyed()) return
      win.setProgressBar(state.mode === 'none' ? -1 : state.value, { mode: state.mode })
    },
    setButtons(buttons, onClick) {
      trace?.('buttons', buttons)
      const win = getMainWindow()
      if (!win || win.isDestroyed() || process.platform !== 'win32') return
      try {
        win.setThumbarButtons(
          buttons.map((b) => ({ icon: iconOf(b.action), tooltip: b.tooltip, flags: b.enabled ? [] : ['disabled'], click: () => onClick(b.action) }))
        )
      } catch (err) {
        console.warn('Could not set the taskbar buttons:', err)
      }
    },
    isFocused() {
      if (trace && process.env.SSW_JOBS_UNFOCUSED === '1') return false
      const win = getMainWindow()
      return !!win && !win.isDestroyed() && win.isFocused()
    },
    flash() {
      trace?.('flash', true)
      const win = getMainWindow()
      if (!win || win.isDestroyed() || win.isFocused()) return
      win.flashFrame(true)
      if (flashing) return
      flashing = true
      win.once('focus', () => {
        flashing = false
        if (!win.isDestroyed()) win.flashFrame(false)
      })
    },
    notify(copy, handlers) {
      trace?.('notify', handlers.extras ? { ...copy, extras: handlers.extras.map((x) => x.text) } : copy)
      if (!Notification.isSupported()) return
      const n = new Notification({
        title: copy.title,
        body: copy.body,
        icon: windowIconPath(),
        actions: [...copy.actions.map((a) => ({ type: 'button' as const, text: a === 'open' ? 'Open' : 'Show in folder' })), ...(handlers.extras ?? []).map((x) => ({ type: 'button' as const, text: x.text }))]
      })
      n.on('action', (details, index) => {
        const i = typeof details?.actionIndex === 'number' ? details.actionIndex : index
        const action = copy.actions[i]
        if (action === 'open') handlers.open()
        else if (action === 'show') handlers.show()
        else handlers.extras?.[i - copy.actions.length]?.run()
      })
      n.on('click', () => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      })
      n.on('close', () => shown.delete(n))
      shown.add(n)
      n.show()
    },
    keepAwake(on) {
      trace?.('awake', on)
      if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
      else if (!on && blocker !== null) {
        if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker)
        blocker = null
      }
    },
    onPower(listener) {
      try {
        for (const event of ['suspend', 'resume', 'lock-screen', 'unlock-screen'] as PowerEvent[]) powerMonitor.on(event as 'suspend', () => listener(event))
      } catch {
        // powerMonitor is not available (tests).
      }
    },
    openFile(file) {
      void shell.openPath(file).then((error) => error && console.warn(`Could not open the exported file: ${error}`))
    },
    showFile(file) {
      shell.showItemInFolder(file)
    }
  }
}
