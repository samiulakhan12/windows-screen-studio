import { contextBridge } from 'electron'
import type { StudioApi } from '../shared/api'
import { exportApi } from './export'
import { projectsApi } from './projects'
import { recordingApi } from './recording'

const api: StudioApi = { platform: process.platform, ...recordingApi, ...projectsApi, ...exportApi }

contextBridge.exposeInMainWorld('api', api)
