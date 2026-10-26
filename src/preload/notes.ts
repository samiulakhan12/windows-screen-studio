import { ipcRenderer } from 'electron'
import type { NotesApi, NotesCommand, NotesState, NotesView } from '../shared/api/notes'
import { subscribe } from './ipc'

// Channel names as in NOTES_CHANNELS (src/shared/api/notes.ts); written out like the other preload
// files, so the sandboxed preload bundle imports nothing but types (tests/notesContracts.test.ts checks them).
export const notesApi: NotesApi = {
  getNotes: () => ipcRenderer.invoke('notes:get'),
  updateNotes: (patch) => ipcRenderer.invoke('notes:update', patch),
  rehearseNotes: (open) => ipcRenderer.invoke('notes:rehearse', open === true),
  onNotesState: (cb) => subscribe<NotesState>('notes:state', cb),
  getNotesView: () => ipcRenderer.invoke('notes:getView'),
  onNotesView: (cb) => subscribe<NotesView>('notes:view', cb),
  onNotesCommand: (cb) => subscribe<NotesCommand>('notes:command', cb),
  reportNotes: (report) => ipcRenderer.send('notes:report', report),
  setNotesLook: (patch) => ipcRenderer.send('notes:look', patch),
  dismissNotes: () => ipcRenderer.send('notes:dismiss'),
  toggleNotesShown: () => ipcRenderer.invoke('notes:toggleShown')
}
