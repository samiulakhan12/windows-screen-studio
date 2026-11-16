import { t } from '../../../shared/i18n/t'
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
      <span>{t('review.share.afterExport')}</span>
      <div className="export-stack">
        {!single ? (
          <p className="hint">{t('review.share.afterExportOne')}</p>
        ) : targets && offered.length === 0 ? (
          <p className="hint">
            {!targets.reviewed && targets.folders.length > 0
              ? t('review.share.foundFolders', { folders: [...new Set(targets.folders.map((f) => f.label))].join(', ') })
              : t('review.share.addTarget')}
          </p>
        ) : (
          <>
            <div className="chips" role="group" aria-label={t('review.share.afterExport')}>
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
            <p className="hint">{t('review.share.remembered')}</p>
          </>
        )}
      </div>
    </div>
  )
}
