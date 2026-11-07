/**
 * AI on this PC over IPC (docs/design/smart-tools.md §9.4): LOCAL_AI_CHANNELS, each handler taking
 * only the app's own page and catalogue ids. Part P4 writes this file; the contracts' stub answers
 * the state (nothing downloaded, no helper) and refuses the rest.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { LOCAL_AI_CHANNELS } from '../../shared/api/localAi'
import { isAppUrl } from '../security'
import { localAiState } from './models'

const NOT_IN_BUILD = 'AI on this PC is not part of this build.'

/** Only the app's own page. */
function fromApp(e: IpcMainInvokeEvent): void {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

export function registerLocalAiIpc(): void {
  ipcMain.handle(LOCAL_AI_CHANNELS.state, (e) => {
    fromApp(e)
    return localAiState()
  })
  for (const channel of [LOCAL_AI_CHANNELS.download, LOCAL_AI_CHANNELS.cancel, LOCAL_AI_CHANNELS.remove, LOCAL_AI_CHANNELS.setUse]) {
    ipcMain.handle(channel, (e) => {
      fromApp(e)
      throw new Error(NOT_IN_BUILD)
    })
  }
}
