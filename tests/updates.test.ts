import { describe, expect, it } from 'vitest'
import { BUSY_COPY, NOTES_MAX, UPDATE_COPY, disabledState, isNewer, isVersion, notesText, reduceUpdate, statusLine, type UpdateState } from '../src/shared/updates/updates'

const AT = '2026-10-30T10:00:00.000Z'
const idle = (over: Partial<UpdateState> = {}): UpdateState => ({ phase: 'idle', current: '0.7.1', lastCheck: null, auto: true, ...over })

describe('versions (docs/design/auto-update.md §5)', () => {
  it('takes plain x.y.z only and compares numerically', () => {
    expect(isVersion('0.7.1')).toBe(true)
    for (const v of ['0.7', '0.7.1-beta.1', 'v0.7.1', '0.7.1 ', '', null, 7]) expect(isVersion(v)).toBe(false)
    expect(isNewer('0.7.10', '0.7.9')).toBe(true)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
    expect(isNewer('0.7.1', '0.7.1')).toBe(false)
    expect(isNewer('0.7.0', '0.7.1')).toBe(false)
    expect(isNewer('0.8.0-beta', '0.7.1')).toBe(false)
  })
})

describe('release notes as plain text', () => {
  it('drops scripts and styles with their content, keeps lists and lines, decodes entities', () => {
    const t = notesText('<h2>What&#39;s new</h2><ul><li>Faster <b>exports</b> &amp; fixes</li><li>One &lt;b&gt;</li></ul><script>alert(1)</script><style>p{}</style><p>Bye&nbsp;now</p>')
    expect(t).toBe("What's new\n\n• Faster exports & fixes\n• One <b>\n\nBye now")
    expect(t).not.toMatch(/alert|p\{\}/)
  })

  it('takes a list of notes, and nothing else', () => {
    expect(notesText([{ version: '0.7.2', note: '<p>A</p>' }, { version: '0.7.1', note: 'B' }])).toBe('A\n\nB')
    expect(notesText([{ note: 3 }, null, 'x'])).toBe('')
    expect(notesText(undefined)).toBe('')
    expect(notesText({ note: 'x' })).toBe('')
  })

  it('removes control and bidi characters and unsafe numeric entities', () => {
    expect(notesText('a\u202Eb\u0000c &#0; &#xD800; &#x41;')).toBe('abc A')
  })

  it('is cut at a word to NOTES_MAX characters', () => {
    const t = notesText(`${'word '.repeat(2000)}`)
    expect(t.length).toBeLessThanOrEqual(NOTES_MAX)
    expect(t.endsWith('…')).toBe(true)
    expect(t.slice(0, -1).endsWith('word')).toBe(true)
  })
})

describe('the update state', () => {
  it('goes checking, available, downloading, ready', () => {
    let s = reduceUpdate(idle(), { type: 'checking' }, AT)
    expect(s.phase).toBe('checking')
    s = reduceUpdate(s, { type: 'available', version: '0.7.2', notes: '<p>Hi</p>' }, AT)
    expect(s).toMatchObject({ phase: 'available', version: '0.7.2', notes: 'Hi', lastCheck: AT })
    s = reduceUpdate(s, { type: 'progress', percent: 41.6 }, AT)
    expect(s).toMatchObject({ phase: 'downloading', percent: 42, version: '0.7.2' })
    s = reduceUpdate(s, { type: 'progress', percent: 140 }, AT)
    expect(s.percent).toBe(100)
    s = reduceUpdate(s, { type: 'downloaded', version: '0.7.2' }, AT)
    expect(s).toMatchObject({ phase: 'ready', version: '0.7.2', notes: 'Hi' })
  })

  it('ignores a version that is not newer, and never undoes a download with a check', () => {
    expect(reduceUpdate(idle(), { type: 'available', version: '0.7.1' }, AT)).toMatchObject({ phase: 'idle', lastCheck: AT })
    expect(reduceUpdate(idle(), { type: 'available', version: '0.7.2-beta.1' }, AT).phase).toBe('idle')
    const ready = idle({ phase: 'ready', version: '0.7.2' })
    expect(reduceUpdate(ready, { type: 'checking' }, AT)).toBe(ready)
    expect(reduceUpdate(ready, { type: 'available', version: '0.7.2' }, AT)).toMatchObject({ phase: 'ready', version: '0.7.2', lastCheck: AT })
    expect(reduceUpdate(ready, { type: 'error', stage: 'check', message: 'x' }, AT)).toBe(ready)
    expect(reduceUpdate(idle({ phase: 'downloading', version: '0.7.2' }), { type: 'checking' }, AT).phase).toBe('downloading')
  })

  it('forgets a downloaded release that was pulled', () => {
    expect(reduceUpdate(idle({ phase: 'ready', version: '0.7.2' }), { type: 'none' }, AT)).toEqual(idle({ lastCheck: AT }))
  })

  it('drops a downloaded release the check no longer offers, for the version it offers now', () => {
    const ready = idle({ phase: 'ready', version: '0.7.3', notes: 'Old' })
    // 0.7.3 pulled: the latest is 0.7.2 again (still newer than this copy).
    expect(reduceUpdate(ready, { type: 'available', version: '0.7.2', notes: '<p>Two</p>' }, AT)).toEqual(
      idle({ phase: 'available', version: '0.7.2', notes: 'Two', lastCheck: AT })
    )
    // 0.7.3 pulled and the fix published as 0.7.4.
    expect(reduceUpdate(ready, { type: 'available', version: '0.7.4' }, AT)).toMatchObject({ phase: 'available', version: '0.7.4', lastCheck: AT })
  })

  it('says a failed check or download plainly, never the raw error', () => {
    const c = reduceUpdate(idle({ phase: 'checking' }), { type: 'error', stage: 'check', message: 'net::ERR_X C:\\Users\\me' }, AT)
    expect(c).toMatchObject({ phase: 'error', error: UPDATE_COPY.checkFailed, lastCheck: AT })
    const d = reduceUpdate(idle({ phase: 'downloading', version: '0.7.2', notes: 'n' }), { type: 'error', stage: 'download', message: 'sha512 mismatch' }, AT)
    expect(d).toMatchObject({ phase: 'error', error: UPDATE_COPY.downloadFailed, version: '0.7.2', notes: 'n' })
    expect(JSON.stringify([c, d])).not.toMatch(/ERR_X|Users|sha512/)
  })

  it('a disabled copy stays disabled', () => {
    const s = disabledState('0.7.1')
    expect(reduceUpdate(s, { type: 'available', version: '9.0.0' }, AT)).toBe(s)
  })

  it('has a status line for every phase', () => {
    expect(statusLine(disabledState('0.7.1'))).toBe(UPDATE_COPY.disabled)
    expect(statusLine(idle())).toBe(UPDATE_COPY.never)
    expect(statusLine(idle({ lastCheck: AT }))).toBe(UPDATE_COPY.upToDate)
    expect(statusLine(idle({ phase: 'checking' }))).toBe(UPDATE_COPY.checking)
    expect(statusLine(idle({ phase: 'available', version: '0.7.2' }))).toBe('Flown 0.7.2 is available.')
    expect(statusLine(idle({ phase: 'downloading', version: '0.7.2', percent: 45 }))).toBe('Downloading Flown 0.7.2… 45%')
    expect(statusLine(idle({ phase: 'ready', version: '0.7.2' }))).toBe('Flown 0.7.2 is ready. It installs when you close Flown.')
    expect(statusLine(idle({ phase: 'error', error: UPDATE_COPY.downloadFailed }))).toBe(UPDATE_COPY.downloadFailed)
    expect(Object.values(BUSY_COPY).every((t) => t.endsWith('.'))).toBe(true)
  })

  it('promises another try at a failed download only when automatic updates are on', () => {
    const failed = reduceUpdate(idle({ phase: 'downloading', version: '0.7.2', auto: false }), { type: 'error', stage: 'download', message: 'x' }, AT)
    expect(statusLine(failed)).toBe(UPDATE_COPY.downloadFailedManual)
    expect(statusLine({ ...failed, auto: true })).toBe(UPDATE_COPY.downloadFailed)
    expect(statusLine(idle({ phase: 'error', error: UPDATE_COPY.checkFailed, auto: false }))).toBe(UPDATE_COPY.checkFailed)
  })
})
