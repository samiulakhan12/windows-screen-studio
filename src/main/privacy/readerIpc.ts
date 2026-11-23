/**
 * The text reader's channels (docs/design/auto-blur.md §10.7, §5.12): its state, its download,
 * cancelling and removing it. A stub from the contracts step: part P2 fills it with readerModels.ts.
 * Until then there is no reader and nothing is ever downloaded. Every handler checks its sender
 * first, the download's included (a frame that is not Flown's own page can start no network).
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { PRIVACY_CHANNELS, type ReaderState } from '../../shared/api/privacy'
import { t } from '../../shared/i18n/t'
import { isAppUrl } from '../security'

const fromApp = (e: IpcMainInvokeEvent): void => {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

const NONE: ReaderState = { status: 'none' }

export function registerReaderIpc(): void {
  ipcMain.handle(PRIVACY_CHANNELS.readerState, (e) => {
    fromApp(e)
    return NONE
  })
  ipcMain.handle(PRIVACY_CHANNELS.downloadReader, (e) => {
    fromApp(e)
    throw new Error(t('errors.feature.notReady'))
  })
  ipcMain.handle(PRIVACY_CHANNELS.cancelReaderDownload, (e) => {
    fromApp(e)
  })
  ipcMain.handle(PRIVACY_CHANNELS.removeReader, (e) => {
    fromApp(e)
    return NONE
  })
}
