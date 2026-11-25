import { ipcRenderer } from 'electron'
import { PRIVACY_CHANNELS, type FindProgress, type PrivacyApi, type ReaderState } from '../shared/api/privacy'
import { subscribe } from './ipc'

/** Private info (docs/design/auto-blur.md §10.7): the text reader, Find, Follow, Cover this text everywhere, copies and the listed names. */
export const privacyApi: PrivacyApi = {
  readerState: () => ipcRenderer.invoke(PRIVACY_CHANNELS.readerState),
  downloadReader: () => ipcRenderer.invoke(PRIVACY_CHANNELS.downloadReader),
  cancelReaderDownload: () => ipcRenderer.invoke(PRIVACY_CHANNELS.cancelReaderDownload),
  removeReader: () => ipcRenderer.invoke(PRIVACY_CHANNELS.removeReader),
  onReaderState: (listener) => subscribe<ReaderState>(PRIVACY_CHANNELS.readerProgress, listener),
  findPrivate: (request) => ipcRenderer.invoke(PRIVACY_CHANNELS.find, request),
  stopFind: (projectId, requestId) => (requestId === undefined ? ipcRenderer.invoke(PRIVACY_CHANNELS.stopFind, projectId) : ipcRenderer.invoke(PRIVACY_CHANNELS.stopFind, projectId, requestId)),
  onFindProgress: (listener) => subscribe<FindProgress>(PRIVACY_CHANNELS.findProgress, listener),
  followCover: (request) => ipcRenderer.invoke(PRIVACY_CHANNELS.follow, request),
  underCover: (request) => ipcRenderer.invoke(PRIVACY_CHANNELS.underCover, request),
  coverEverywhere: (request) => ipcRenderer.invoke(PRIVACY_CHANNELS.everywhere, request),
  copies: (projectId) => ipcRenderer.invoke(PRIVACY_CHANNELS.copies, projectId),
  coverCopies: (projectId, copyIds) => ipcRenderer.invoke(PRIVACY_CHANNELS.coverCopies, { projectId, copyIds }),
  originCovers: (projectId) => ipcRenderer.invoke(PRIVACY_CHANNELS.originCovers, projectId),
  setPrivateNames: (names) => ipcRenderer.invoke(PRIVACY_CHANNELS.names, names)
}
