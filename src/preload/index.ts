import { contextBridge } from 'electron'
import type { StudioApi } from '../shared/api'
import { exportApi } from './export'
import { prefsApi } from './prefs'
import { projectsApi } from './projects'
import { recordingApi } from './recording'

const api: StudioApi = { platform: process.platform, ...recordingApi, ...projectsApi, ...exportApi, ...prefsApi }

contextBridge.exposeInMainWorld('api', api)
