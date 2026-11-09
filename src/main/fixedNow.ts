/**
 * A fixed clock for the English guard's tour (docs/design/output-and-languages.md §10.6): in an
 * unpackaged app started with SSW_FIXED_NOW set to an instant ("2026-03-12T14:02:00Z"),
 * Date.now() and new Date() give that instant, so every date and time the app shows is the same on
 * every run. Imported by src/main/index.ts before any other module of the app runs. A packaged app
 * never reads the variable.
 */
import { app } from 'electron'

/** Replaces the global Date so Date.now() and `new Date()` give `at`; a Date made from a value is untouched. */
export function installFixedClock(at: number, target: { Date: DateConstructor } = globalThis): void {
  const Real = target.Date
  function Fixed(this: unknown, ...args: unknown[]): unknown {
    // Called without new, Date() gives the string of now.
    if (!new.target) return new Real(at).toString()
    return args.length === 0 ? new Real(at) : new (Real as unknown as new (...a: unknown[]) => Date)(...args)
  }
  Fixed.prototype = Real.prototype
  Fixed.now = (): number => at
  Fixed.parse = Real.parse
  Fixed.UTC = Real.UTC
  target.Date = Fixed as unknown as DateConstructor
}

/** The instant SSW_FIXED_NOW names, or null when it is absent, unreadable or the app is packaged. */
export function fixedNowFromEnv(env: NodeJS.ProcessEnv, packaged: boolean): number | null {
  const raw = env.SSW_FIXED_NOW
  if (packaged || !raw) return null
  const at = Date.parse(raw)
  return Number.isFinite(at) ? at : null
}

const fixed = fixedNowFromEnv(process.env, app.isPackaged)
if (fixed !== null) installFixedClock(fixed)
