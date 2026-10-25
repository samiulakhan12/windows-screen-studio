/**
 * AI providers (OpenAI, Gemini, Claude) with the user's own API keys: key storage, transcription
 * of a recording's sound, and text tasks on its transcript. Keys stay in the main process.
 */
import { ipcMain } from 'electron'

const notReady = (): never => {
  throw new Error('AI providers are not available yet')
}

export function registerAiIpc(): void {
  ipcMain.handle('ai:listProviders', () => [])
  ipcMain.handle('ai:saveProvider', () => notReady())
  ipcMain.handle('ai:removeProvider', () => notReady())
  ipcMain.handle('ai:testProvider', () => notReady())
  ipcMain.handle('ai:transcribe', () => notReady())
  ipcMain.handle('ai:cancelTranscription', () => undefined)
  ipcMain.handle('ai:text', () => notReady())
}
