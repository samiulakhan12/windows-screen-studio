/**
 * The common namespace (docs/design/output-and-languages.md §10.4, §10.5): filled by the lead at step
 * S2 from the inventory of texts that three or more files show, then frozen. The extraction parts use
 * these keys and none adds to them, so no two parts write the same namespace. A change here is the
 * lead's, named in its commit.
 */
import { describe, expect, it } from 'vitest'
import common from '../src/shared/i18n/messages/en/common.json'
import commonMeta from '../src/shared/i18n/messages/en/common.meta.json'
import { t } from '../src/shared/i18n/t'

/** The common namespace as frozen at step S2. */
const FROZEN: Record<string, string> = {
  'action.add': 'Add',
  'action.addAiProvider': 'Add an AI provider',
  'action.back': 'Back',
  'action.cancel': 'Cancel',
  'action.close': 'Close',
  'action.copy': 'Copy',
  'action.cut': 'Cut',
  'action.delete': 'Delete',
  'action.deleteName': 'Delete {name}',
  'action.done': 'Done',
  'action.hide': 'Hide',
  'action.keep': 'Keep',
  'action.later': 'Later',
  'action.makeCaptions': 'Make captions',
  'action.play': 'Play',
  'action.playName': 'Play {name}',
  'action.refresh': 'Refresh',
  'action.regenerate': 'Regenerate',
  'action.remove': 'Remove',
  'action.removeAll': 'Remove all',
  'action.removeName': 'Remove {name}',
  'action.reset': 'Reset',
  'action.restore': 'Restore',
  'action.save': 'Save',
  'action.selectAll': 'Select all',
  'action.show': 'Show',
  'action.showInFolder': 'Show in folder',
  'action.stop': 'Stop',
  'action.tryAgain': 'Try again',
  'action.use': 'Use',
  'state.copied': 'Copied',
  'state.loading': 'Loading…',
  'state.none': 'None',
  'state.off': 'Off',
  'state.saved': 'Saved',
  'state.saving': 'Saving…',
  'state.working': 'Working…',
  'label.background': 'Background',
  'label.camera': 'Camera',
  'label.captions': 'Captions',
  'label.colour': 'Colour',
  'label.colours': 'Colours',
  'label.keyboardShortcuts': 'Keyboard shortcuts',
  'label.layout': 'Layout',
  'label.length': 'Length',
  'label.look': 'Look',
  'label.motion': 'Motion',
  'label.name': 'Name',
  'label.opacity': 'Opacity',
  'label.position': 'Position',
  'label.provider': 'Provider',
  'label.settings': 'Settings',
  'label.shadow': 'Shadow',
  'label.size': 'Size',
  'label.sound': 'Sound',
  'label.speed': 'Speed',
  'label.strength': 'Strength',
  'label.text': 'Text',
  'label.textColour': 'Text colour',
  'label.title': 'Title',
  'label.volume': 'Volume',
  'label.zoom': 'Zoom',
  'colour.pickAny': 'Pick any colour',
  'colour.anyFor': '{label} (any colour)',
  'error.drawingSurface': 'Could not create a drawing surface'
}

describe('the common namespace, frozen at step S2', () => {
  it('holds exactly the frozen keys and English', () => {
    expect(common).toEqual(FROZEN)
  })

  it('describes every key for translators, and marks the names a user gives', () => {
    const meta = commonMeta as Record<string, { description?: string; user?: string[] }>
    expect(Object.keys(meta).sort()).toEqual(Object.keys(FROZEN).sort())
    for (const [key, m] of Object.entries(meta)) expect(m.description?.trim(), key).toBeTruthy()
    expect(Object.keys(meta).filter((k) => meta[k].user)).toEqual(['action.deleteName', 'action.playName', 'action.removeName'])
  })

  it('formats in English exactly as the texts it replaces', () => {
    expect(t('common.action.cancel')).toBe('Cancel')
    expect(t('common.state.saving')).toBe('Saving…')
    expect(t('common.action.deleteName', { name: 'Phone demo' })).toBe('Delete Phone demo')
    expect(t('common.colour.anyFor', { label: 'Background' })).toBe('Background (any colour)')
  })
})
