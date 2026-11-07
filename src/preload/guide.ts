import { ipcRenderer } from 'electron'
import { GUIDE_CHANNELS, guideCopyProblem, guidePayloadProblem, GUIDE_SAVE_LIMITS, type GuideApi } from '../shared/api/guide'

/**
 * Saving and copying guides (docs/design/smart-tools.md §5.8). The preload checks GUIDE_SAVE_LIMITS,
 * the total too, before anything is sent, so a page cannot make main deserialise more; main checks
 * again (part P1's checkGuidePayload). Main shows the dialogs and builds every path.
 */
export const guideApi: GuideApi = {
  saveGuide: (payload) => {
    const problem = guidePayloadProblem(payload)
    return problem ? Promise.reject(new Error(problem)) : ipcRenderer.invoke(GUIDE_CHANNELS.save, payload)
  },
  showGuideFile: (path) => ipcRenderer.invoke(GUIDE_CHANNELS.showItem, path),
  copyGuide: (clip) => {
    const problem = guideCopyProblem(clip)
    return problem ? Promise.reject(new Error(problem)) : ipcRenderer.invoke(GUIDE_CHANNELS.copy, { html: clip.html, text: clip.text })
  },
  copyGuideImage: (png) =>
    png instanceof Uint8Array && png.byteLength <= GUIDE_SAVE_LIMITS.image ? ipcRenderer.invoke(GUIDE_CHANNELS.copyImage, png) : Promise.reject(new Error('This screenshot cannot be copied.'))
}
