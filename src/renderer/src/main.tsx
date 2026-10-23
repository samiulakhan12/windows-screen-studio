import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Toolbar } from './views/Toolbar'
import './styles.css'

const isToolbar = window.location.hash.startsWith('#/toolbar')
document.body.classList.toggle('toolbar-body', isToolbar)

createRoot(document.getElementById('root')!).render(<StrictMode>{isToolbar ? <Toolbar /> : <App />}</StrictMode>)
