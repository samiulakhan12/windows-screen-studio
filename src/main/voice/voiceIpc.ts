/**
 * Clean voice's IPC (VOICE_CHANNELS, docs/design/clean-voice.md §4.3 and §7) and its part of the
 * export. Every handler accepts the app's own page only; the cleaner checks every argument.
 * Progress goes to the app's windows.
 */
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { VOICE_CHANNELS, type VoiceProgress } from '../../shared/api/voice'
import { SOURCE_FILES } from '../../shared/audio/settings'
import { isVoiceStrength } from '../../shared/audio/voiceClean'
import { VOICE_COPY } from '../../shared/audio/voiceCopy'
import type { ExportJob } from '../../shared/api/export'
import type { SoundInputs } from '../exportJob'
import { ffmpegPath } from '../ffmpeg'
import { projectDir } from '../projects'
import { isAppUrl } from '../security'
import generalModel from './model/cb.rnnn?raw'
import speechModel from './model/sh.rnnn?raw'
import { VoiceCleaner } from './voiceClean'

function broadcast(p: VoiceProgress): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && isAppUrl(w.webContents.getURL())) w.webContents.send(VOICE_CHANNELS.progress, p)
  }
}

/** The app's cleaner: the models are kept in userData/voice, ffmpeg is the bundled one. */
export const voiceCleaner = new VoiceCleaner({
  projectDir,
  modelDir: () => path.join(app.getPath('userData'), 'voice'),
  modelTexts: { speech: speechModel, general: generalModel },
  ffmpeg: ffmpegPath,
  onProgress: broadcast
})

/** Stops project `id`'s render (the editor closed, or the project is about to be deleted). */
export const stopVoiceClean = (id: string): Promise<void> => voiceCleaner.cancel(id).catch(() => undefined)

/**
 * The export's sound files with the cleaned voice in place of what it was made from (§4.6), as
 * the editor chose it in `requested`: the microphone stem when the job mixes stems with one, the
 * mixed track when it mixes none. A job without `voice` is returned unchanged. When the stems
 * were dropped because the system sound's file went missing (resolveSoundInputs: the mixed track
 * then plays every source), nothing is cleaned, as the preview then plays the mixed sound as
 * recorded; the mixed track, with the PC's sound and any music in it, is never cleaned in place of
 * a microphone. When the microphone's own file went missing the export stops: the preview still
 * plays the stem cleaned from it, and the mixed track would quietly bring back the noisy voice.
 * The stem is made here if it is somehow not there yet.
 */
export async function cleanVoiceInputs(sound: SoundInputs, projectId: string, requested: ExportJob = sound.job, cleaner: Pick<VoiceCleaner, 'ensure'> = voiceCleaner): Promise<SoundInputs> {
  const strength = requested.audio?.voice
  if (strength === undefined) return sound
  if (!isVoiceStrength(strength)) throw new Error('Invalid export settings')
  const asked = requested.audio?.stems
  if (asked?.mic !== undefined && !sound.stems) {
    const mic = await fs.stat(path.join(projectDir(projectId), SOURCE_FILES.mic)).catch(() => null)
    if (!mic?.isFile()) throw new Error(`${VOICE_COPY.failed} ${VOICE_COPY.missingMic}`)
  }
  const source = asked ? (asked.mic !== undefined && sound.stems?.mic ? 'mic' : null) : sound.audioInput ? 'mix' : null
  if (!source) return sound
  const file = await cleaner.ensure(projectId, source, strength).catch((err: unknown) => {
    throw new Error(`${VOICE_COPY.failed} ${err instanceof Error ? err.message : String(err)}`)
  })
  const cleaned = path.join(projectDir(projectId), file)
  return source === 'mic' ? { ...sound, stems: { ...sound.stems, mic: cleaned } } : { ...sound, audioInput: cleaned }
}

export function registerVoiceIpc(): void {
  // Only the app's own page may start or stop work on a project's files.
  const fromApp = (e: IpcMainInvokeEvent): void => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
  }
  ipcMain.handle(VOICE_CHANNELS.status, (e, id: unknown, source: unknown, strength: unknown) => {
    fromApp(e)
    return voiceCleaner.status(id, source, strength)
  })
  ipcMain.handle(VOICE_CHANNELS.prepare, (e, id: unknown, source: unknown, strength: unknown) => {
    fromApp(e)
    return voiceCleaner.ensure(id, source, strength)
  })
  ipcMain.handle(VOICE_CHANNELS.cancel, (e, id: unknown) => {
    fromApp(e)
    return voiceCleaner.cancel(id)
  })
  // A render must not outlive the app.
  app.on('will-quit', () => voiceCleaner.stopAll())
}
