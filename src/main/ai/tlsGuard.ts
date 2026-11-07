/**
 * Imported first by src/main/index.ts (docs/design/smart-tools.md §16): a packaged app never runs
 * with certificate checks turned off, whatever the environment says. Side effect only.
 */
import { app } from 'electron'

if (app.isPackaged) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
