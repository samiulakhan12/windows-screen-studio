/**
 * Settings › Brand kit and "Apply brand kit" requests. Only the app's own page may make them, and
 * it never names a path: files are picked in a dialog here, and read or copied by their kit name.
 */
import { dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { loadBrandKit, readBrandFile, saveBrandKit } from './brandKit'
import { addBrandFile, copyKitIntoProject } from './brandKitFiles'
import { isAppUrl } from './security'
import { getMainWindow } from './windows'

const fromApp = (e: IpcMainInvokeEvent): void => {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

export function registerBrandKitIpc(): void {
  ipcMain.handle('brandKit:get', (e) => {
    fromApp(e)
    return loadBrandKit()
  })
  ipcMain.handle('brandKit:save', (e, kit: unknown) => {
    fromApp(e)
    return saveBrandKit(kit)
  })
  ipcMain.handle('brandKit:file', (e, name: unknown) => {
    fromApp(e)
    return readBrandFile(name)
  })
  ipcMain.handle('brandKit:pickFile', async (e, kind: unknown) => {
    fromApp(e)
    if (kind !== 'logo' && kind !== 'font') return null
    const main = getMainWindow()
    if (!main) return null
    const result = await dialog.showOpenDialog(main, {
      title: kind === 'logo' ? 'Choose your logo' : 'Add a font',
      properties: ['openFile'],
      filters: kind === 'logo' ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'] }] : [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff2'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return addBrandFile(kind, result.filePaths[0])
  })
  ipcMain.handle('brandKit:copyInto', (e, projectId: unknown) => {
    fromApp(e)
    if (typeof projectId !== 'string') throw new Error('Unknown project')
    return copyKitIntoProject(projectId)
  })
}
