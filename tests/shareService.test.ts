import { describe, expect, it } from 'vitest'
import type { ShareFolderInfo, ShareRunView } from '../src/shared/api/share'
import { EXTRAS_WAIT_MS, MAX_RUNS, ShareService, validMeta, type ShareDeps } from '../src/main/share/shareService'

const FILE = 'C:\\Videos\\Demo.mp4'
const ONEDRIVE: ShareFolderInfo = { id: 'cf0000000001', service: 'onedrive', label: 'OneDrive', path: 'C:\\OneDrive', source: 'app', on: true }
const DROPBOX: ShareFolderInfo = { id: 'cf0000000002', service: 'dropbox', label: 'Dropbox', path: 'C:\\Dropbox', source: 'usual', on: false }
const META = { title: 'Demo', seconds: 151 }

function setup(over: Partial<ShareDeps> = {}) {
  const sent: ShareRunView[] = []
  const posts: { url: string; lines: string[] }[] = []
  const notes: { title: string; body: string; show?: string }[] = []
  let finish: (() => void) | null = null
  const deps: ShareDeps = {
    folders: async () => [ONEDRIVE, DROPBOX],
    hook: (id) => {
      if (id !== 'whkchat') throw new Error('This chat is no longer set up. Add it again in Settings › Share.')
      return { service: 'slack', label: '#demos', url: 'https://hooks.slack.com/services/T/B/x' }
    },
    hookIds: () => ['whkchat'],
    isExported: (f) => f === FILE,
    copy: async (_file, folder, _signal, onProgress) => {
      onProgress(0.5)
      return { dest: `${folder.path}\\Flown\\Demo.mp4`, bytes: 10, already: false }
    },
    post: async (hook, lines) => {
      posts.push({ url: hook.url, lines })
    },
    send: (run) => sent.push(run),
    isFocused: () => true,
    notify: (n) => notes.push(n),
    ...over
  }
  const service = new ShareService(deps)
  const settled = async (): Promise<ShareRunView> => {
    for (let i = 0; i < 100 && !sent.at(-1)?.finished; i++) await new Promise((r) => setTimeout(r, 1))
    return sent.at(-1)!
  }
  return { service, sent, posts, notes, settled, release: () => finish?.(), hold: (f: () => void) => (finish = f) }
}

describe('ShareService', () => {
  it('copies first, then posts where the file went', async () => {
    const s = setup()
    const started = await s.service.start(FILE, ['whkchat', ONEDRIVE.id], META)
    expect(started.steps.map((x) => [x.kind, x.label, x.state])).toEqual([
      ['copy', 'OneDrive', 'waiting'],
      ['post', '#demos', 'waiting']
    ])
    const end = await s.settled()
    expect(end.steps.map((x) => x.state)).toEqual(['done', 'done'])
    expect(end.steps[0].dest).toBe('C:\\OneDrive\\Flown\\Demo.mp4')
    expect(s.posts).toEqual([{ url: 'https://hooks.slack.com/services/T/B/x', lines: ['New video: Demo (2:31)', 'Saved to OneDrive › Flown'] }])
    // A later post for the same file still says where it went.
    await s.service.start(FILE, ['whkchat'], META)
    await new Promise((r) => setTimeout(r, 5))
    expect(s.posts[1].lines[1]).toBe('Saved to OneDrive › Flown')
  })

  it('does not post when the copy before it failed', async () => {
    const s = setup({ copy: async () => Promise.reject(new Error('The drive of OneDrive is full.')) })
    await s.service.start(FILE, [ONEDRIVE.id, 'whkchat'], META)
    const end = await s.settled()
    expect(end.steps.map((x) => [x.state, x.message])).toEqual([
      ['failed', 'The drive of OneDrive is full.'],
      ['failed', 'Not posted: the copy failed.']
    ])
    expect(s.posts).toEqual([])
  })

  it('cancels the running step and every step after it', async () => {
    const s = setup({
      copy: (_f, _folder, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('The share was cancelled.'))))
    })
    const run = await s.service.start(FILE, [ONEDRIVE.id, 'whkchat'], META)
    await new Promise((r) => setTimeout(r, 2))
    s.service.cancel(run.id)
    const end = await s.settled()
    expect(end.steps.map((x) => x.state)).toEqual(['cancelled', 'cancelled'])
    expect(s.posts).toEqual([])
  })

  it('refuses what it must not share', async () => {
    const s = setup()
    await expect(s.service.start('C:\\Windows\\win.ini', [ONEDRIVE.id], META)).rejects.toThrow('Only files exported in this session')
    await expect(s.service.start(FILE, [], META)).rejects.toThrow('Choose where')
    await expect(s.service.start(FILE, [DROPBOX.id], META)).rejects.toThrow('turned off')
    await expect(s.service.start(FILE, ['whkother'], META)).rejects.toThrow('no longer set up')
    await expect(s.service.start(FILE, ['cf00000000ff'], META)).rejects.toThrow('This folder is not set up any more')
    await expect(s.service.start(FILE, [ONEDRIVE.id], { title: 'x', seconds: -1 })).rejects.toThrow('Invalid')
    await expect(s.service.start(FILE, [ONEDRIVE.id], { title: 'x'.repeat(201), seconds: 1 })).rejects.toThrow('Invalid')
    expect(validMeta({ title: 'ok', seconds: 3 })).toEqual({ title: 'ok', seconds: 3 })
  })

  it('runs at most four shares at once and never the same one twice', async () => {
    const s = setup({ isExported: () => true, post: () => new Promise(() => undefined), copy: () => new Promise(() => undefined) })
    await s.service.start(FILE, ['whkchat'], META)
    await expect(s.service.start(FILE, ['whkchat'], META)).rejects.toThrow('Already sharing to #demos')
    for (let i = 1; i < MAX_RUNS; i++) await s.service.start(`C:\\Videos\\${i}.mp4`, [ONEDRIVE.id], META)
    await expect(s.service.start('C:\\Videos\\last.mp4', [ONEDRIVE.id], META)).rejects.toThrow('Wait for the other shares to finish.')
  })

  it('offers the destinations on the notification unless the page shares the file itself', async () => {
    const s = setup()
    expect(await s.service.extras(FILE)).toEqual([])
    s.service.offer(FILE, META, true)
    expect(await s.service.extras(FILE)).toEqual([])
    s.service.offer(FILE, META, false)
    const extras = await s.service.extras(FILE)
    expect(extras.map((x) => x.text)).toEqual(['Copy to OneDrive', 'Post to #demos'])
    extras[1].run()
    await s.settled()
    expect(s.posts).toHaveLength(1)
    // Not for a file that was not exported.
    s.service.offer('C:\\other.mp4', META, false)
    expect(await s.service.extras('C:\\other.mp4')).toEqual([])
  })

  it('lets only one of two starts at the same moment through', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const s = setup({ folders: async () => (await gate, [ONEDRIVE, DROPBOX]), copy: () => new Promise(() => undefined) })
    const a = s.service.start(FILE, [ONEDRIVE.id], META)
    const b = s.service.start(FILE, [ONEDRIVE.id], META)
    release()
    const results = await Promise.allSettled([a, b])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('does not hold the notification back for slow folder look-ups', async () => {
    const s = setup({ folders: () => new Promise(() => undefined) })
    s.service.offer(FILE, META, false)
    const t0 = Date.now()
    const extras = await s.service.extras(FILE)
    expect(Date.now() - t0).toBeLessThan(EXTRAS_WAIT_MS + 500)
    expect(extras.map((x) => x.text)).toEqual(['Post to #demos'])
  })

  it('offers at most three buttons', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...ONEDRIVE, id: `cf000000001${i}`, label: `F${i}` }))
    const s = setup({ folders: async () => many })
    s.service.offer(FILE, META, false)
    expect(await s.service.extras(FILE)).toHaveLength(3)
  })

  it('notifies the result when the window is in the background', async () => {
    const s = setup({ isFocused: () => false })
    await s.service.start(FILE, [ONEDRIVE.id, 'whkchat'], META)
    await s.settled()
    expect(s.notes).toEqual([{ title: 'Shared', body: 'Saved to OneDrive › Flown · Posted to #demos', show: 'C:\\OneDrive\\Flown\\Demo.mp4' }])
    const f = setup({ isFocused: () => false, post: async () => Promise.reject(new Error('Slack is busy. Try again in a minute.')) })
    await f.service.start(FILE, ['whkchat'], META)
    await f.settled()
    expect(f.notes).toEqual([{ title: 'Could not share', body: '#demos: Slack is busy. Try again in a minute.' }])
  })

  it('lists the runs of a file', async () => {
    const s = setup()
    const run = await s.service.start(FILE, [ONEDRIVE.id], META)
    await s.settled()
    expect(s.service.runsFor(FILE).map((r) => r.id)).toEqual([run.id])
    expect(s.service.runsFor('C:\\x.mp4')).toEqual([])
  })
})
