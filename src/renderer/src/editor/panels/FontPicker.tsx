import { useEffect, useState } from 'react'
import { DEFAULT_FONT_LABEL, fontNameFromFile, fontOf, MAX_PROJECT_FONTS, newFontId } from '../../../../shared/render/fonts'
import type { Project, ProjectFont } from '../../../../shared/types'
import { fontState, preloadProjectFont } from '../../render/fontLoader'
import { onStyleAssetsChanged } from '../../render/watermarkLayer'
import { useEditor } from '../context'
import { EditorIcon } from '../EditorIcon'
import { ipcMessage } from '../overlayItems'
import './fontPicker.css'

/** The brand kit's colours first, then `presets` (no repeats): the colour pickers of a title card. */
export function withBrandColors(project: Pick<Project, 'brand'>, presets: readonly string[]): string[] {
  const out = [...(project.brand?.colors ?? [])]
  for (const c of presets) if (!out.includes(c.toLowerCase())) out.push(c)
  return out
}

/** The name a font shows in the menus, saying when it is missing and what draws instead. */
export function fontLabel(font: ProjectFont, state: ReturnType<typeof fontState>): string {
  return state === 'missing' ? `${font.name} (missing: drawn with ${DEFAULT_FONT_LABEL})` : font.name
}

/**
 * The Font menu of a text, a title card or the captions (docs/design/brand-kit.md §5): the default
 * font and the project's fonts, and beside it "Add font…", which copies a TTF, OTF or WOFF2 file
 * into the project and uses it. A button, not an entry of the menu: Windows changes a closed menu
 * on the arrow keys, which would open the file dialog while the user only looks through the fonts.
 * `apply` returns the project with font `id` (undefined: the default) set where this menu sets it,
 * so adding a font and using it is one undo step.
 */
export function FontPicker({
  project,
  value,
  apply,
  label = 'Font'
}: {
  project: Project
  value: string | undefined
  apply: (p: Project, id: string | undefined) => Project
  label?: string
}): JSX.Element {
  const { store } = useEditor()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, setVersion] = useState(0)
  useEffect(() => onStyleAssetsChanged(() => setVersion((n) => n + 1)), [])
  const fonts = project.fonts ?? []
  const current = fontOf(fonts, value)
  const state = current ? fontState(project, current.id) : null

  const addFont = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (fonts.length >= MAX_PROJECT_FONTS) throw new Error(`This video already has ${MAX_PROJECT_FONTS} fonts.`)
      const picked = await window.api.pickAsset(project.id, 'font')
      if (!picked) return
      // The same file (stored once) is the same font.
      const same = (store.state.fonts ?? []).find((f) => f.file === picked.path)
      const font: ProjectFont = same ?? { id: newFontId(), name: fontNameFromFile(picked.name ?? picked.path), file: picked.path }
      await preloadProjectFont(project.id, font, picked.url)
      store.update((p) => apply(same ? p : { ...p, fonts: [...(p.fonts ?? []), font] }, font.id))
    } catch (err) {
      setError(ipcMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="font-picker">
      <div className="font-picker-row">
        <label className="field">
          <span>{label}</span>
          <select value={current ? current.id : ''} disabled={busy} data-testid="font-picker" onChange={(e) => store.update((p) => apply(p, e.target.value || undefined))}>
            <option value="">Default ({DEFAULT_FONT_LABEL})</option>
            {fonts.map((f) => (
              <option key={f.id} value={f.id}>
                {fontLabel(f, fontState(project, f.id))}
              </option>
            ))}
          </select>
        </label>
        {/* Not disabled while adding: the button keeps keyboard focus through the file dialog. */}
        <button type="button" className="btn" data-testid="font-add" title="Add a TTF, OTF or WOFF2 font file" onClick={() => void addFont()}>
          Add font…
        </button>
      </div>
      {busy && <span className="hint">Adding the font…</span>}
      {state === 'missing' && current && (
        <p className="callout" role="status" data-testid="font-missing">
          <EditorIcon name="alert" size={16} />
          <span>
            {current.name} could not be loaded, so this text is drawn with {DEFAULT_FONT_LABEL}. Add the font again to use it.
          </span>
        </p>
      )}
      {error && (
        <p className="callout" role="alert" data-testid="font-error">
          <EditorIcon name="alert" size={16} />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}
