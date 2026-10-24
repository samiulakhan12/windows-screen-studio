import { shortcutKeys } from '../../../shared/editor/shortcuts'
import './commands.css'

/** A shortcut as keycaps: "Ctrl+Shift+Z" → Ctrl Shift Z. */
export function ShortcutKeys({ accelerator, className }: { accelerator: string; className?: string }): JSX.Element {
  return (
    <span className={`shortcut-keys ${className ?? ''}`}>
      {shortcutKeys(accelerator).map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  )
}

/** The first shortcut of a command as keycaps, or `fallback` (text) when it has none. */
export function FirstShortcut({ accelerators, fallback }: { accelerators: readonly string[] | undefined; fallback: string }): JSX.Element {
  return accelerators?.length ? <ShortcutKeys accelerator={accelerators[0]} /> : <>{fallback}</>
}
