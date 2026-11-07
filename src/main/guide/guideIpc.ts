/**
 * Saving and copying guides over IPC (docs/design/smart-tools.md §5.8): GUIDE_CHANNELS, each handler
 * taking only the app's own page. Part P1 writes this file; the contracts' stub refuses each.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { GUIDE_CHANNELS } from '../../shared/api/guide'
import { isAppUrl } from '../security'

/** Only the app's own page. */
function fromApp(e: IpcMainInvokeEvent): void {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

export function registerGuideIpc(): void {
  for (const channel of [GUIDE_CHANNELS.save, GUIDE_CHANNELS.showItem, GUIDE_CHANNELS.copy, GUIDE_CHANNELS.copyImage]) {
    ipcMain.handle(channel, (e) => {
      fromApp(e)
      throw new Error('Guides are not part of this build.')
    })
  }
}
