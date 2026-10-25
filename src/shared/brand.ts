/**
 * The product's name and maker, in one place for the main process and the renderer. The
 * packaging side (package.json, electron-builder.config.cjs) repeats them; tests/brand.test.ts
 * keeps the two in step.
 */
export const APP_NAME = 'Flown'
export const COMPANY_NAME = 'Qbexel'
/** Opened in the browser by the About section; the only address the brand IPC opens. */
export const COMPANY_URL = 'https://qbexel.com'
export const COMPANY_URL_LABEL = 'qbexel.com'
export const COPYRIGHT = '© 2026 Qbexel'

/**
 * Windows AppUserModelID: the installer stamps it on the shortcuts (electron-builder's appId)
 * and the app sets it at start, so the taskbar groups the running app with its shortcut.
 */
export const APP_USER_MODEL_ID = 'com.qbexel.flown'

/**
 * The name the app had before it became Flown. Electron derived the userData folder from it
 * and the recordings lived in Videos\<this>; both are migrated at start (main/brandMigration.ts).
 */
export const LEGACY_APP_NAME = 'Screen Studio for Windows'
