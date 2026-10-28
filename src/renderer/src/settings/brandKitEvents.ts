/** Opens Settings at a section from anywhere (SettingsButton listens): `{ detail: { section } }`. */
export const OPEN_SETTINGS_EVENT = 'ssw:open-settings'

/** Dispatched on window when Settings saved the brand kit: the editor reads it again. */
export const BRAND_KIT_CHANGED_EVENT = 'ssw:brand-kit-changed'

/** Opens Settings at the Brand kit section. */
export const openBrandKitSettings = (): void => void window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'brand' } }))
