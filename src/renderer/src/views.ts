/**
 * The windows' views, loaded in one piece after the UI language is set (docs/design/output-and-languages.md
 * §9.4 step 4). The stylesheet comes last, after the views' own styles, exactly as main.tsx imported
 * them before, so every window keeps the cascade and the styles it had.
 */
export { App } from './App'
export { NotesWindow } from './views/NotesWindow'
export { RegionPicker } from './views/RegionPicker'
export { Toolbar } from './views/Toolbar'
import './styles.css'
