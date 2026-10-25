import { contextBridge } from 'electron'
import type { StudioApi } from '../shared/api'
import { exportApi } from './export'
import { aiApi } from './ai'
import { brandApi } from './brand'
import { captionsApi } from './captions'
import { prefsApi } from './prefs'
import { projectsApi } from './projects'
import { recordingApi } from './recording'

const api: StudioApi = { platform: process.platform, ...recordingApi, ...projectsApi, ...exportApi, ...prefsApi, ...aiApi, ...captionsApi, ...brandApi }

contextBridge.exposeInMainWorld('api', api)
