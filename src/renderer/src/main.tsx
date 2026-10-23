import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { RegionPicker } from './views/RegionPicker'
import { Toolbar } from './views/Toolbar'
import './styles.css'

const hash = window.location.hash
const isToolbar = hash.startsWith('#/toolbar')
const isRegion = hash.startsWith('#/region')
document.body.classList.toggle('toolbar-body', isToolbar)
document.body.classList.toggle('region-body', isRegion)

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isToolbar ? <Toolbar /> : isRegion ? <RegionPicker /> : <App />}</StrictMode>
)
