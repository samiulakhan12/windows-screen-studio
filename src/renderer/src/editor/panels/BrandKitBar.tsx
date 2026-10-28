import { useEffect, useState } from 'react'
import { applyBrandKit, brandKitIsEmpty, type BrandFiles, type BrandKit } from '../../../../shared/editor/brandKit'
import { mediaUrl } from '../../../../shared/mediaUrl'
import { shortcutLabel } from '../../../../shared/editor/shortcuts'
import type { Project } from '../../../../shared/types'
import { preloadProjectFont } from '../../render/fontLoader'
import { preloadWatermarkImage } from '../../render/watermarkLayer'
import { OPEN_SETTINGS_EVENT } from '../../settings/SettingsButton'
import { useEditor } from '../context'
import { Section } from '../controls'
import { EditorIcon } from '../EditorIcon'
import { useKeymap } from '../keymapContext'
import { ipcMessage } from '../overlayItems'

/** Dispatched on window when Settings saved the brand kit: the editor reads it again. */
export const BRAND_KIT_CHANGED_EVENT = 'ssw:brand-kit-changed'

/** Opens Settings at the Brand kit section. */
export const openBrandKitSettings = (): void => void window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'brand' } }))

/**
 * "Apply brand kit" at the top of the Style tab (docs/design/brand-kit.md §4.5): copies the kit's
 * files into the project, decodes the logo and loads the fonts, then applies the whole kit as
 * one undo step. A part whose file cannot be read is left out, and the notice says so.
 */
export function BrandKitBar({ project, onNotice }: { project: Project; onNotice: (message: string) => void }): JSX.Element {
  const { store, player } = useEditor()
  const keymap = useKeymap()
  const [kit, setKit] = useState<BrandKit | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    const read = (): void =>
      void window.api
        .getBrandKit()
        .then((k) => live && setKit(k))
        .catch(() => live && setKit(null))
    read()
    window.addEventListener(BRAND_KIT_CHANGED_EVENT, read)
    return () => {
      live = false
      window.removeEventListener(BRAND_KIT_CHANGED_EVENT, read)
    }
  }, [])

  const empty = !kit || brandKitIsEmpty(kit)

  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      const { kit: saved, files } = await window.api.copyBrandKitInto(project.id)
      const usable: BrandFiles = { fonts: {} }
      const left: string[] = []
      if (saved.logo) {
        if (
          files.logo &&
          (await preloadWatermarkImage(project.id, files.logo, mediaUrl(project.id, files.logo)).then(
            () => true,
            () => false
          ))
        )
          usable.logo = files.logo
        else left.push('the logo')
      }
      for (const f of saved.fonts) {
        const file = files.fonts[f.id]
        const ok =
          !!file &&
          (await preloadProjectFont(project.id, { ...f, file }, mediaUrl(project.id, file)).then(
            () => true,
            () => false
          ))
        if (ok) usable.fonts[f.id] = file
        else left.push(f.name)
      }
      const before = store.state
      store.update((p) => applyBrandKit(p, saved, usable))
      player.invalidate()
      if (store.state === before) return onNotice('Your brand kit is empty: set it up in Settings › Brand kit')
      const undo = keymap.undo[0] ? ` · ${shortcutLabel(keymap.undo[0])} to undo` : ''
      onNotice(left.length ? `Brand kit applied without ${left.join(', ')} (could not be read)${undo}` : `Brand kit applied${undo}`)
    } catch (err) {
      onNotice(`The brand kit could not be applied: ${ipcMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Brand kit">
      <div className="row-buttons">
        <button
          className="btn"
          data-testid="apply-brand-kit"
          disabled={busy || empty}
          onClick={() => void apply()}
          title={empty ? 'Set up your brand kit in Settings first' : 'Your logo, colours, fonts, intro, outro and style preset, as one undo step'}
        >
          <EditorIcon name="sparkle" size={16} /> {busy ? 'Applying…' : 'Apply brand kit'}
        </button>
        <button className="btn ghost" onClick={openBrandKitSettings}>
          {empty ? 'Set up brand kit…' : 'Edit brand kit…'}
        </button>
      </div>
      {empty && kit && <p className="hint">Save your logo, colours, fonts, intro and outro once in Settings, then apply them to any video in one click.</p>}
    </Section>
  )
}
