import { ipcRenderer } from 'electron'
import type { DiagnosticsApi } from '../shared/api/diagnostics'

export const diagnosticsApi: DiagnosticsApi = {
  collectDiagnostics: () => ipcRenderer.invoke('diagnostics:collect'),
  copyDiagnostics: (id) => ipcRenderer.invoke('diagnostics:copy', id),
  openLogFolder: () => ipcRenderer.invoke('diagnostics:openLogs')
}
