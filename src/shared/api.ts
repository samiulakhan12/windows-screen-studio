import type { AiApi } from './api/ai'
import type { CaptionsApi } from './api/captions'
import type { PrefsApi } from './api/prefs'
import type { ExportApi } from './api/export'
import type { ProjectsApi } from './api/projects'
import type { RecordingApi } from './api/recording'

export type { ExportApi, ExportJob } from './api/export'
export type { LoadedProject, ProjectsApi } from './api/projects'
export type { RecorderCommand, RecordingApi, SaveRecordingPayload } from './api/recording'

/** API exposed to renderer windows by the preload script as `window.api`. */
export type StudioApi = { platform: string } & RecordingApi & ProjectsApi & ExportApi & PrefsApi & AiApi & CaptionsApi
