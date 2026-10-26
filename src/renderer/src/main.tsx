import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { NotesWindow } from './views/NotesWindow'
import { RegionPicker } from './views/RegionPicker'
import { Toolbar } from './views/Toolbar'
import './styles.css'

// A file dropped on a window would otherwise be opened in place of the app (main blocks that navigation too).
for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault())

const hash = window.location.hash
const isToolbar = hash.startsWith('#/toolbar')
const isRegion = hash.startsWith('#/region')
const isNotes = hash.startsWith('#/notes')
document.body.classList.toggle('toolbar-body', isToolbar)
document.body.classList.toggle('region-body', isRegion)
document.body.classList.toggle('notes-body', isNotes)

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isToolbar ? <Toolbar /> : isRegion ? <RegionPicker /> : isNotes ? <NotesWindow /> : <App />}</StrictMode>
)
