import { useEffect, useState } from 'react'
import { applyBrandKit, brandFontsLeftOut, brandKitIsEmpty, type BrandFiles, type BrandKit } from '../../../../shared/editor/brandKit'
import { mediaUrl } from '../../../../shared/mediaUrl'
import { MAX_PROJECT_FONTS } from '../../../../shared/render/fonts'
import { shortcutLabel } from '../../../../shared/editor/shortcuts'
import type { Project } from '../../../../shared/types'
import { preloadProjectFont } from '../../render/fontLoader'
import { preloadWatermarkImage } from '../../render/watermarkLayer'
import { BRAND_KIT_CHANGED_EVENT, openBrandKitSettings } from '../../settings/brandKitEvents'
import { useEditor } from '../context'
import { Section } from '../controls'
import { EditorIcon } from '../EditorIcon'
import { useKeymap } from '../keymapContext'
import { ipcMessage } from '../overlayItems'
import { t } from '../../../../shared/i18n/t'
import { fmt } from '../../../../shared/i18n/fmt'

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
        else left.push(t('style.brandKitBar.theLogo'))
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
      const full = brandFontsLeftOut(before, saved, usable)
      store.update((p) => applyBrandKit(p, saved, usable))
      player.invalidate()
      if (store.state === before) return onNotice(t('style.brandKitBar.empty'))
      const keys = keymap.undo[0] ? shortcutLabel(keymap.undo[0]) : null
      const without = [
        left.length ? t('style.brandKitBar.unreadable', { names: left.join(', ') }) : '',
        full.length ? t('style.brandKitBar.tooManyFonts', { names: full.join(', '), max: fmt.count(MAX_PROJECT_FONTS) }) : ''
      ]
        .filter(Boolean)
        .join(', ')
      onNotice(
        without
          ? keys
            ? t('style.brandKitBar.appliedWithoutUndo', { without, keys })
            : t('style.brandKitBar.appliedWithout', { without })
          : keys
            ? t('style.brandKitBar.appliedUndo', { keys })
            : t('style.brandKitBar.applied')
      )
    } catch (err) {
      onNotice(t('style.brandKitBar.notApplied', { reason: ipcMessage(err) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={t('style.brandKitBar.brandKit')}>
      <div className="row-buttons">
        <button
          className="btn"
          data-testid="apply-brand-kit"
          disabled={busy || empty}
          onClick={() => void apply()}
          title={empty ? t('style.brandKitBar.setUpYourBrand') : t('style.brandKitBar.yourLogoColoursFonts')}
        >
          <EditorIcon name="sparkle" size={16} /> {busy ? t('style.brandKitBar.applying') : t('style.brandKitBar.applyBrandKit')}
        </button>
        <button className="btn ghost" onClick={openBrandKitSettings}>
          {empty ? t('style.brandKitBar.setUpBrandKit') : t('style.brandKitBar.editBrandKit')}
        </button>
      </div>
      {empty && kit && <p className="hint">{t('style.brandKitBar.saveYourLogoColours')}</p>}
    </Section>
  )
}
