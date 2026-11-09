// English first, before any module of the views makes text (docs/design/output-and-languages.md §9.1).
import '../../shared/i18n/messages/en/index'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bootLanguage } from './i18n/boot'
import './i18n/scripts.css'

// A file dropped on a window would otherwise be opened in place of the app (main blocks that navigation too).
for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault())

const hash = window.location.hash
const isToolbar = hash.startsWith('#/toolbar')
const isRegion = hash.startsWith('#/region')
const isNotes = hash.startsWith('#/notes')
document.body.classList.toggle('toolbar-body', isToolbar)
document.body.classList.toggle('region-body', isRegion)
document.body.classList.toggle('notes-body', isNotes)

/**
 * The UI language is set before the views' modules load and before the first render (§9.4 step 4):
 * they are imported only after bootLanguage, so nothing makes text in another language first.
 */
async function start(): Promise<void> {
  await bootLanguage(isToolbar ? 'toolbar' : isRegion ? 'region' : isNotes ? 'notes' : 'main')
  const views = await import('./views')
  const View = isToolbar ? views.Toolbar : isRegion ? views.RegionPicker : isNotes ? views.NotesWindow : views.App
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <View />
    </StrictMode>
  )
}

void start()
