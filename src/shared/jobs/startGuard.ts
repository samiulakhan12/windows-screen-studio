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
