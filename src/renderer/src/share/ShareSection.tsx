import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ShareHookInfo, ShareTargets } from '../../../shared/api/share'
import { sourceText } from '../../../shared/share/cloudFolders'
import { folderPlaces, hookPlaces, withPlace } from '../../../shared/share/names'
import { switchOn, whenOnScreen } from '../../../shared/share/onScreen'
import { SHARE_LIMITS, WEBHOOK_SERVICES } from '../../../shared/share/webhooks'
import { ipcMessage } from '../settings/providerText'
import { t } from '../../../shared/i18n/t'
import { useShareTargets } from './useShare'
import './share.css'

type TestState = { busy: true } | { busy: false; ok: boolean; message: string }

/**
 * Settings › Share (F-22, docs/design/share.md §4): the cloud folders found on this PC (each with
 * where it was found, and a switch) and the ones the user added, and the chats with their webhook
 * (typed once, then only shown masked). Esc closes the add form first, as the AI providers do.
 */
export function ShareSection(): JSX.Element {
  // Found folders are offered once their list has been on screen, not when Settings opens elsewhere.
  const [folderList, setFolderList] = useState<HTMLUListElement | null>(null)
  const [seen, setSeen] = useState(false)
  const { targets, error, set } = useShareTargets(seen)
  const [adding, setAdding] = useState(false)
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [removing, setRemoving] = useState<ShareHookInfo | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [looking, setLooking] = useState(false)
  const addRef = useRef<HTMLButtonElement>(null)
  const addFolderRef = useRef<HTMLButtonElement>(null)
  /** Where focus goes once a form or question closes: a button's data-focus-key, '' for "+ Add a chat". */
  const refocus = useRef<string | null>(null)

  useEffect(() => {
    if (adding || removing || refocus.current === null) return
    const key = refocus.current
    refocus.current = null
    const el = key ? document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`) : null
    ;(el ?? (key === 'folder' ? addFolderRef.current : addRef.current))?.focus({ preventScroll: true })
  }, [adding, removing, targets])

  const act = async (fn: () => Promise<ShareTargets | null>): Promise<void> => {
    setActionError(null)
    try {
      const next = await fn()
      if (next) set(next)
    } catch (err) {
      setActionError(ipcMessage(err))
    }
  }

  const test = async (h: ShareHookInfo): Promise<void> => {
    setTests((all) => ({ ...all, [h.id]: { busy: true } }))
    const result = await window.api.shareTestHook(h.id).catch((err: unknown) => ({ ok: false, message: ipcMessage(err) }))
    setTests((all) => ({ ...all, [h.id]: { busy: false, ...result } }))
  }

  const lookAgain = async (): Promise<void> => {
    setLooking(true)
    await act(() => window.api.shareTargets(true))
    setLooking(false)
  }

  const folders = targets?.folders ?? []
  const hooks = targets?.hooks ?? []
  const found = folders.filter((f) => f.source !== 'picked')
  // Switches and buttons of two folders or chats with the same name say which one they act on.
  const folderPlace = folderPlaces(folders)
  const hookPlace = hookPlaces(hooks)
  const watch = found.length > 0 && targets?.reviewed === false && !seen

  useEffect(() => (folderList && watch ? whenOnScreen(folderList, () => setSeen(true), IntersectionObserver) : undefined), [folderList, watch])

  return (
    <section
      className="settings-section share-settings"
      aria-labelledby="settings-share-title"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return
        if (removing) {
          e.preventDefault()
          refocus.current = `remove:${removing.id}`
          setRemoving(null)
        } else if (adding) {
          e.preventDefault()
          refocus.current = ''
          setAdding(false)
        }
      }}
    >
      <h3 id="settings-share-title">{t('review.share.title')}</h3>
      <p className="hint">{t('review.share.intro')}</p>
      {error && (
        <p className="error" role="alert">
          {t('review.share.readError', { error })}
        </p>
      )}

      <h4>{t('review.share.folders')}</h4>
      {targets && found.length === 0 && <p className="settings-empty">{t('review.share.noFolders')}</p>}
      {folders.length > 0 && (
        <ul className="share-list" aria-label={t('review.share.folders')} ref={setFolderList}>
          {folders.map((f) => (
            <li key={f.id} className="share-item" data-share-folder={f.id}>
              <div className="share-item-main">
                <strong className="share-item-name">{f.label}</strong>
                <code className="share-item-path" title={f.path}>
                  {f.path}
                </code>
                <span className="share-item-source">{sourceText(f.service, f.source)}</span>
              </div>
              <div className="share-item-actions">
                <label className="share-use">
                  <input type="checkbox" checked={switchOn(f, targets?.reviewed ?? true)} onChange={(e) => void act(() => window.api.shareSetFolder(f.id, e.target.checked))} aria-label={t('review.share.useName', { name: withPlace(f.label, folderPlace.get(f.id)) })} />
                  {t('common.action.use')}
                </label>
                {f.source === 'picked' && (
                  <button
                    type="button"
                    className="btn ghost danger settings-small"
                    onClick={() => {
                      refocus.current = 'folder'
                      void act(() => window.api.shareSetFolder(f.id, null))
                    }}
                    aria-label={t('common.action.removeName', { name: withPlace(f.label, folderPlace.get(f.id)) })}
                  >
                    {t('common.action.remove')}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">{t('review.share.foldersHint')}</p>
      <div className="share-row">
        <button type="button" className="btn" ref={addFolderRef} onClick={() => void act(() => window.api.sharePickFolder())}>
          {t('review.share.addFolder')}
        </button>
        <button type="button" className="btn ghost" onClick={() => void lookAgain()} disabled={looking}>
          {looking ? t('review.share.looking') : t('review.share.lookAgain')}
        </button>
      </div>

      <h4>{t('review.share.chats')}</h4>
      {targets && hooks.length === 0 && !adding && <p className="settings-empty">{t('review.share.noChats')}</p>}
      {hooks.length > 0 && (
        <ul className="share-list" aria-label={t('review.share.chats')}>
          {hooks.map((h) => {
            const probe = tests[h.id]
            return (
              <li key={h.id} className="share-item" data-share-hook={h.id}>
                <div className="share-item-main">
                  <strong className="share-item-name">{h.label}</strong>
                  <span className="share-item-source">{WEBHOOK_SERVICES[h.service].label}</span>
                  {h.readable ? (
                    <code className="share-item-path" title={t('review.share.webhookMasked')}>
                      {h.masked}
                    </code>
                  ) : (
                    <em className="error">{t('review.share.unreadable')}</em>
                  )}
                  {probe && (
                    <p className={`ai-test ${probe.busy ? '' : probe.ok ? 'ok' : 'error'}`} role="status" aria-live="polite">
                      {probe.busy ? t('review.share.posting') : `${probe.ok ? '✓' : '✕'} ${probe.message}`}
                    </p>
                  )}
                </div>
                {removing?.id === h.id ? (
                  <div className="share-item-actions" role="alert">
                    <span>{t('review.share.removeQuestion', { name: h.label })}</span>
                    <button
                      type="button"
                      className="btn danger settings-small"
                      onClick={() => {
                        refocus.current = ''
                        setRemoving(null)
                        void act(() => window.api.shareRemoveHook(h.id))
                      }}
                    >
                      {t('common.action.remove')}
                    </button>
                    <button
                      type="button"
                      className="btn ghost settings-small"
                      autoFocus
                      onClick={() => {
                        refocus.current = `remove:${h.id}`
                        setRemoving(null)
                      }}
                    >
                      {t('common.action.cancel')}
                    </button>
                  </div>
                ) : (
                  <div className="share-item-actions">
                    <button type="button" className="btn settings-small" disabled={probe?.busy || !h.readable} onClick={() => void test(h)} aria-label={t('review.share.testName', { name: withPlace(h.label, hookPlace.get(h.id)) })}>
                      {t('review.share.test')}
                    </button>
                    <button type="button" className="btn ghost danger settings-small" data-focus-key={`remove:${h.id}`} onClick={() => setRemoving(h)} aria-label={t('common.action.removeName', { name: withPlace(h.label, hookPlace.get(h.id)) })}>
                      {t('common.action.remove')}
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {adding ? (
        <HookForm
          onCancel={() => {
            refocus.current = ''
            setAdding(false)
          }}
          onSaved={(next) => {
            set(next)
            refocus.current = ''
            setAdding(false)
          }}
        />
      ) : (
        <div>
          <button type="button" className="btn" ref={addRef} onClick={() => setAdding(true)} disabled={hooks.length >= SHARE_LIMITS.maxHooks}>
            {t('review.share.addChatButton')}
          </button>
        </div>
      )}
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
    </section>
  )
}

function HookForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: (targets: ShareTargets) => void }): JSX.Element {
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      onSaved(await window.api.shareAddHook(label, url))
    } catch (err) {
      setError(ipcMessage(err))
      setSaving(false)
    }
  }
  return (
    <form className="ai-form share-form" onSubmit={(e) => void submit(e)} aria-labelledby="share-hook-title">
      <h4 id="share-hook-title">{t('review.share.addChat')}</h4>
      <label className="field">
        <span>{t('common.label.name')}</span>
        <input className="settings-input" value={label} maxLength={SHARE_LIMITS.labelLength} placeholder={t('review.share.namePlaceholder')} autoFocus onChange={(e) => setLabel(e.target.value)} />
      </label>
      <div className="field">
        <label htmlFor="share-hook-url">
          <span className="settings-label">{t('review.share.webhookUrl')}</span>
        </label>
        <div className="ai-key-row">
          <input
            id="share-hook-url"
            className="settings-input"
            type={show ? 'text' : 'password'}
            value={url}
            placeholder={t('review.share.webhookPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            maxLength={SHARE_LIMITS.urlLength}
            aria-describedby="share-hook-hint"
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="button" className="btn ghost settings-small" aria-pressed={show} aria-label={show ? t('review.share.hideWebhook') : t('review.share.showWebhook')} onClick={() => setShow((v) => !v)}>
            {show ? t('common.action.hide') : t('common.action.show')}
          </button>
        </div>
        <p className="hint" id="share-hook-hint">
          {t('review.share.webhookHint')}
        </p>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="ai-form-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t('common.action.cancel')}
        </button>
        <button type="submit" className="btn primary" disabled={saving || !url.trim()}>
          {saving ? t('common.state.saving') : t('review.share.addChatSubmit')}
        </button>
      </div>
    </form>
  )
}
