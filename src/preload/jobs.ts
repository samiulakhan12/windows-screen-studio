import { ipcRenderer } from 'electron'
import type { JobsApi } from '../shared/api/jobs'
import { subscribe } from './ipc'

export const jobsApi: JobsApi = {
  jobBegin: (kind, options) => ipcRenderer.invoke('jobs:begin', kind, options),
  jobUpdate: (id, update) => ipcRenderer.send('jobs:update', id, update),
  jobEnd: (id, outcome) => ipcRenderer.invoke('jobs:end', id, outcome),
  onJobCommand: (listener) => subscribe('jobs:command', listener)
}
