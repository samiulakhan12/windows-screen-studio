import { Icon } from '../components/Icon'
import { actionLabel, actionTitle, type AfterExport } from './useShare'
import './share.css'

/**
 * "After export" in the export dialog's settings (F-22, docs/design/share.md §2.7): copy to a
 * cloud folder and post to a chat when the export finishes, remembered per destination preset.
 * Only for a single file; a batch or one file per chapter would flood a chat.
 */
export function ShareAfterExport({ share, single }: { share: AfterExport; single: boolean }): JSX.Element {
  const { targets, offered, chosen } = share
  return (
    <div className="form-row export-share">
      <span>After export</span>
      <div className="export-stack">
        {!single ? (
          <p className="hint">After export works when one file is exported.</p>
        ) : targets && offered.length === 0 ? (
          <p className="hint">
            {!targets.reviewed && targets.folders.length > 0
              ? `Flown found ${[...new Set(targets.folders.map((f) => f.label))].join(', ')} on this PC. Check them in Settings › Share to copy exports there.`
              : 'Add a cloud folder or a chat in Settings › Share.'}
          </p>
        ) : (
          <>
            <div className="chips" role="group" aria-label="After export">
              {offered.map((id) => {
                const on = chosen.includes(id)
                return (
                  <button key={id} className={`chip ${on ? 'active' : ''}`} aria-pressed={on} title={actionTitle(targets, id)} data-share-target={id} onClick={() => share.toggle(id)}>
                    {on && <Icon name="check" size={12} />}
                    {actionLabel(targets, id)}
                  </button>
                )
              })}
            </div>
            <p className="hint">Remembered for this destination. The video itself is never posted to a chat.</p>
          </>
        )}
      </div>
    </div>
  )
}
