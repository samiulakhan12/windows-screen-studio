import { createContext, useContext } from 'react'
import { DEFAULT_KEYMAP, type Keymap } from '../../../shared/editor/shortcuts'

/** The editor's current shortcuts (the user's own), so hints and tooltips name the right keys. */
export const KeymapContext = createContext<Keymap>(DEFAULT_KEYMAP)

export const useKeymap = (): Keymap => useContext(KeymapContext)
