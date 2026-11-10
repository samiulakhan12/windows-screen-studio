/**
 * One export at a time from the export dialog: the steps before an export shows its progress (the
 * HEVC probe, which may take seconds, and the save or folder dialog) run through the guard. A second
 * click meanwhile, or while an export runs (`busy`), does nothing: it would open a second dialog and
 * its export would replace or cancel the first one's.
 */
export function startGuard(busy: () => boolean): <T>(ask: () => Promise<T>) => Promise<T | null> {
  let asking = false
  return async <T>(ask: () => Promise<T>): Promise<T | null> => {
    if (asking || busy()) return null
    asking = true
    try {
      return await ask()
    } finally {
      asking = false
    }
  }
}

/**
 * An Export click while the HEVC probe still runs (a few test encodes, seconds each): the wait shows
 * (`waiting(true)`, the button says so), and when the probe ends the export the dialog shows by then
 * starts, read with `latest()` after the wait, so a setting changed meanwhile is the one exported.
 * A second click meanwhile does nothing; a dialog closed meanwhile (`open()` false) starts nothing,
 * and `latest()` gives null when the dialog as it is then cannot export.
 */
export function waitThenStart(hooks: { waiting: (on: boolean) => void; open: () => boolean }): (probe: Promise<unknown> | null, latest: () => (() => Promise<void>) | null) => Promise<void> {
  let wait = false
  return async (probe, latest): Promise<void> => {
    if (wait) return
    if (probe) {
      wait = true
      hooks.waiting(true)
      try {
        await probe
      } finally {
        wait = false
        if (hooks.open()) hooks.waiting(false)
      }
      if (!hooks.open()) return
    }
    await latest()?.()
  }
}
