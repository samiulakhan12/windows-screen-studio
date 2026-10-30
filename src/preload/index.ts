import { contextBridge } from 'electron'
import type { StudioApi } from '../shared/api'
import { exportApi } from './export'
import { aiApi } from './ai'
import { brandApi } from './brand'
import { brandKitApi } from './brandKit'
import { captionsApi } from './captions'
import { notesApi } from './notes'
import { prefsApi } from './prefs'
import { projectsApi } from './projects'
import { recordingApi } from './recording'
import { speechApi } from './speech'
import { importApi } from './import'
import { jobsApi } from './jobs'
import { exportBundleApi } from './exportBundle'
import { diagnosticsApi } from './diagnostics'
import { storageApi } from './storage'
import { voiceApi } from './voice'
import { updatesApi } from './updates'
import { soundsApi } from './sounds'

const api: StudioApi = { platform: process.platform, ...recordingApi, ...projectsApi, ...exportApi, ...prefsApi, ...aiApi, ...captionsApi, ...brandApi, ...brandKitApi, ...notesApi, ...speechApi, ...jobsApi, ...exportBundleApi, ...diagnosticsApi, ...storageApi, ...importApi, ...voiceApi, ...updatesApi, ...soundsApi }

contextBridge.exposeInMainWorld('api', api)
