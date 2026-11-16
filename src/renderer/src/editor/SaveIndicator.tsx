import { useSyncExternalStore } from 'react'
import type { Autosaver } from '../../../shared/editor/autosave'
import type { Project } from '../../../shared/types'
import { t } from '../../../shared/i18n/t'
import { EditorIcon } from './EditorIcon'

/** Autosave state in the title bar; a failed save stays visible with a Retry button until it succeeds. */
export function SaveIndicator({ saver }: { saver: Autosaver<Project> }): JSX.Element {
  const status = useSyncExternalStore(
    (cb) => saver.onStatus(cb),
    () => saver.status
  )
  if (status.state === 'error') {
    return (
      <div className="save-state error" role="alert" title={status.message} data-state="error">
        <EditorIcon name="alert" size={15} />
        <span>{t('editor.save.notSaved')}</span>
        <span className="save-detail">{status.message}</span>
        <button className="btn ghost small" onClick={() => saver.retryNow()}>
          {t('editor.save.retry')}
        </button>
      </div>
    )
  }
  return (
    <div className="save-state" data-state={status.state} aria-live="polite">
      {status.state === 'saved' ? (
        <>
          <EditorIcon name="check" size={14} /> {t('common.state.saved')}
        </>
      ) : (
        t('common.state.saving')
      )}
    </div>
  )
}
