/**
 * Saving and copying guides over IPC (docs/design/smart-tools.md §5.8, §16 rules 12 and 13): each
 * handler takes only the app's own page and checks every argument again. Main shows every dialog and
 * builds every path; the renderer sends a format, a name and bytes, never a path. A PDF, HTML or demo
 * file written here joins the export's files of this session (rememberExported), so Show in folder
 * and Share accept it, and nothing else.
 */
import { app, clipboard, dialog, ipcMain, nativeImage, shell, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { GUIDE_CHANNELS, GUIDE_SAVE_LIMITS, guideCopyProblem, imageKind, type GuideSavePayload } from '../../shared/api/guide'
import { isExportedFile, rememberExported } from '../exportIpc'
import { isAppUrl } from '../security'
import { getMainWindow } from '../windows'
import { printGuidePdf } from './printPdf'
import { checkGuidePayload, writeGuideFiles } from './writeGuide'

/** Only the app's own page. */
function fromApp(e: IpcMainInvokeEvent): void {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

/** guide:showItem's answer for a path this session's guide:save did not write. */
export const NOT_WRITTEN = 'Flown did not save that file.'

/** Folders of Markdown guides written this session (Show in folder accepts them). */
const guideFolders = new Set<string>()

const EXTENSIONS: Record<Exclude<GuideSavePayload['format'], 'markdown'>, { ext: string; filter: string }> = {
  pdf: { ext: 'pdf', filter: 'PDF' },
  html: { ext: 'html', filter: 'Web page' },
  demo: { ext: 'html', filter: 'Web page' }
}

/** `file` ending in `.ext` (the dialog keeps what the user typed). */
const withExt = (file: string, ext: string): string => (path.extname(file).toLowerCase() === `.${ext}` ? file : `${file}.${ext}`)

/** How many steps a print page has, for its time limit. */
const stepCount = (html: string): number => html.split('class="step"').length - 1

/** Where the guide goes, from the save or folder dialog; null when cancelled. */
async function chooseTarget(payload: GuideSavePayload): Promise<string | null> {
  const main = getMainWindow()
  if (!main) return null
  const documents = app.getPath('documents')
  if (payload.format === 'markdown') {
    const result = await dialog.showOpenDialog(main, {
      title: 'Save the guide as Markdown',
      defaultPath: documents,
      buttonLabel: 'Save the guide in this folder',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  }
  const kind = EXTENSIONS[payload.format]
  const result = await dialog.showSaveDialog(main, {
    title: payload.format === 'pdf' ? 'Save the guide as PDF' : payload.format === 'demo' ? 'Save the click-through demo' : 'Save the guide as a web page',
    defaultPath: path.join(documents, `${payload.name}.${kind.ext}`),
    filters: [{ name: kind.filter, extensions: [kind.ext] }]
  })
  return result.canceled || !result.filePath ? null : withExt(result.filePath, kind.ext)
}

/** guide:save: the dialog, then the file or folder written; null when the dialog was cancelled. */
export async function saveGuide(raw: unknown): Promise<{ path: string; bytes: number } | null> {
  const payload = checkGuidePayload(raw)
  const target = await chooseTarget(payload)
  if (!target) return null
  const pdf = payload.format === 'pdf' ? await printGuidePdf(payload.html ?? '', { page: payload.page ?? 'A4', steps: stepCount(payload.html ?? '') }) : undefined
  const written = await writeGuideFiles(target, payload, pdf)
  if (payload.format === 'markdown') guideFolders.add(written.path)
  else rememberExported(written.path)
  return written
}

/** guide:showItem: only a file or folder this session's guide:save wrote. */
export function showGuideFile(file: unknown): void {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !(isExportedFile(file) || guideFolders.has(file))) throw new Error(NOT_WRITTEN)
  shell.showItemInFolder(file)
}

/** guide:copy: the guide's HTML and plain text on the clipboard. */
export function copyGuide(clip: unknown): void {
  const problem = guideCopyProblem(clip)
  if (problem) throw new Error(problem)
  const c = clip as { html: string; text: string }
  clipboard.write({ html: c.html, text: c.text })
}

/** guide:copyImage: one PNG of at most 16 MB on the clipboard. */
export function copyGuideImage(png: unknown): void {
  if (!(png instanceof Uint8Array) || png.byteLength > GUIDE_SAVE_LIMITS.image || imageKind(png) !== 'png') throw new Error('This screenshot cannot be copied.')
  const image = nativeImage.createFromBuffer(Buffer.from(png))
  if (image.isEmpty()) throw new Error('This screenshot cannot be copied.')
  clipboard.writeImage(image)
}

export function registerGuideIpc(): void {
  ipcMain.handle(GUIDE_CHANNELS.save, (e, payload: unknown) => {
    fromApp(e)
    return saveGuide(payload)
  })
  ipcMain.handle(GUIDE_CHANNELS.showItem, (e, file: unknown) => {
    fromApp(e)
    showGuideFile(file)
  })
  ipcMain.handle(GUIDE_CHANNELS.copy, (e, clip: unknown) => {
    fromApp(e)
    copyGuide(clip)
  })
  ipcMain.handle(GUIDE_CHANNELS.copyImage, (e, png: unknown) => {
    fromApp(e)
    copyGuideImage(png)
  })
}
