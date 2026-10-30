import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ShareHookInfo, ShareTargets } from '../../../shared/api/share'
import { sourceText } from '../../../shared/share/cloudFolders'
import { SHARE_LIMITS, WEBHOOK_SERVICES } from '../../../shared/share/webhooks'
import { ipcMessage } from '../settings/providerText'
import { useShareTargets } from './useShare'
import './share.css'

type TestState = { busy: true } | { busy: false; ok: boolean; message: string }

/**
 * Settings › Share (F-22, docs/design/share.md §4): the cloud folders found on this PC (each with
 * where it was found, and a switch) and the ones the user added, and the chats with their webhook
 * (typed once, then only shown masked). Esc closes the add form first, as the AI providers do.
 */
export function ShareSection(): JSX.Element {
  const { targets, error, set } = useShareTargets(true)
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
    setTests((t) => ({ ...t, [h.id]: { busy: true } }))
    const result = await window.api.shareTestHook(h.id).catch((err: unknown) => ({ ok: false, message: ipcMessage(err) }))
    setTests((t) => ({ ...t, [h.id]: { busy: false, ...result } }))
  }

  const lookAgain = async (): Promise<void> => {
    setLooking(true)
    await act(() => window.api.shareTargets(true))
    setLooking(false)
  }

  const folders = targets?.folders ?? []
  const hooks = targets?.hooks ?? []
  const found = folders.filter((f) => f.source !== 'picked')

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
      <h3 id="settings-share-title">Share</h3>
      <p className="hint">Copy exports to your cloud folders and tell your team in a chat. Nothing goes through a Flown server.</p>
      {error && (
        <p className="error" role="alert">
          Could not read the share settings: {error}
        </p>
      )}

      <h4>Cloud folders</h4>
      {targets && found.length === 0 && <p className="settings-empty">No OneDrive, Dropbox or Google Drive folder was found on this PC. Add any folder instead.</p>}
      {folders.length > 0 && (
        <ul className="share-list" aria-label="Cloud folders">
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
                  <input type="checkbox" checked={f.on} onChange={(e) => void act(() => window.api.shareSetFolder(f.id, e.target.checked))} aria-label={`Use ${f.label}`} />
                  Use
                </label>
                {f.source === 'picked' && (
                  <button
                    type="button"
                    className="btn ghost danger settings-small"
                    onClick={() => {
                      refocus.current = 'folder'
                      void act(() => window.api.shareSetFolder(f.id, null))
                    }}
                    aria-label={`Remove ${f.label}`}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">Videos go into a Flown folder inside. Your cloud app uploads them.</p>
      <div className="share-row">
        <button type="button" className="btn" ref={addFolderRef} onClick={() => void act(() => window.api.sharePickFolder())}>
          + Add a folder…
        </button>
        <button type="button" className="btn ghost" onClick={() => void lookAgain()} disabled={looking}>
          {looking ? 'Looking…' : 'Look again'}
        </button>
      </div>

      <h4>Chats</h4>
      {targets && hooks.length === 0 && !adding && <p className="settings-empty">No chat yet.</p>}
      {hooks.length > 0 && (
        <ul className="share-list" aria-label="Chats">
          {hooks.map((h) => {
            const t = tests[h.id]
            return (
              <li key={h.id} className="share-item" data-share-hook={h.id}>
                <div className="share-item-main">
                  <strong className="share-item-name">{h.label}</strong>
                  <span className="share-item-source">{WEBHOOK_SERVICES[h.service].label}</span>
                  {h.readable ? (
                    <code className="share-item-path" title="Webhook (only the end is shown)">
                      {h.masked}
                    </code>
                  ) : (
                    <em className="error">The webhook cannot be read on this PC: remove it and paste it again.</em>
                  )}
                  {t && (
                    <p className={`ai-test ${t.busy ? '' : t.ok ? 'ok' : 'error'}`} role="status" aria-live="polite">
                      {t.busy ? 'Posting a test message…' : `${t.ok ? '✓' : '✕'} ${t.message}`}
                    </p>
                  )}
                </div>
                {removing?.id === h.id ? (
                  <div className="share-item-actions" role="alert">
                    <span>Remove “{h.label}”? Its webhook is deleted from this PC.</span>
                    <button
                      type="button"
                      className="btn danger settings-small"
                      onClick={() => {
                        refocus.current = ''
                        setRemoving(null)
                        void act(() => window.api.shareRemoveHook(h.id))
                      }}
                    >
                      Remove
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
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="share-item-actions">
                    <button type="button" className="btn settings-small" disabled={t?.busy || !h.readable} onClick={() => void test(h)} aria-label={`Test ${h.label}`}>
                      Test
                    </button>
                    <button type="button" className="btn ghost danger settings-small" data-focus-key={`remove:${h.id}`} onClick={() => setRemoving(h)} aria-label={`Remove ${h.label}`}>
                      Remove
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
            + Add a chat
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

function HookForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: (t: ShareTargets) => void }): JSX.Element {
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
      <h4 id="share-hook-title">Add a chat</h4>
      <label className="field">
        <span>Name</span>
        <input className="settings-input" value={label} maxLength={SHARE_LIMITS.labelLength} placeholder="#team-videos" autoFocus onChange={(e) => setLabel(e.target.value)} />
      </label>
      <div className="field">
        <label htmlFor="share-hook-url">
          <span className="settings-label">Webhook URL</span>
        </label>
        <div className="ai-key-row">
          <input
            id="share-hook-url"
            className="settings-input"
            type={show ? 'text' : 'password'}
            value={url}
            placeholder="https://hooks.slack.com/services/…"
            autoComplete="off"
            spellCheck={false}
            maxLength={SHARE_LIMITS.urlLength}
            aria-describedby="share-hook-hint"
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="button" className="btn ghost settings-small" aria-pressed={show} aria-label={show ? 'Hide the webhook' : 'Show the webhook'} onClick={() => setShow((v) => !v)}>
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
        <p className="hint" id="share-hook-hint">
          Paste an incoming webhook from Slack, Discord or Microsoft Teams. Flown posts the title, the length and where the video was saved. The video itself is never uploaded. It is
          encrypted on this PC.
        </p>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="ai-form-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={saving || !url.trim()}>
          {saving ? 'Saving…' : 'Add chat'}
        </button>
      </div>
    </form>
  )
}
