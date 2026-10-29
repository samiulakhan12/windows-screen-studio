import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppLog, LOG_FILE, OLD_LOG_FILE } from '../src/main/appLog'

let dir = ''
const roots = { userData: '/home/jane/.config/Flown' }
const clock = () => new Date('2026-10-28T12:00:00.000Z')

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-log-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('AppLog', () => {
  it('writes redacted lines with a time and level', async () => {
    const log = new AppLog(dir, roots, { maxBytes: 10_000, flushMs: 10, lineMax: 2000 }, clock)
    log.write('warn', ['Could not open %s', '/home/jane/Desktop/x.mp4'])
    log.write('info', ['config at /home/jane/.config/Flown/app-settings.json, key sk-abcdefghijklmnopqrstuvwxyz'])
    await log.flush()
    expect(readFileSync(path.join(dir, LOG_FILE), 'utf8')).toBe(
      '2026-10-28T12:00:00.000Z WARN Could not open <path>\n2026-10-28T12:00:00.000Z INFO config at <userData>/app-settings.json, key <secret>\n'
    )
  })

  it('caps long lines', async () => {
    const log = new AppLog(dir, roots, { maxBytes: 100_000, flushMs: 10, lineMax: 50 }, clock)
    log.write('log', ['y'.repeat(30) + ' ' + 'x'.repeat(500)])
    await log.flush()
    const line = readFileSync(path.join(dir, LOG_FILE), 'utf8').trim()
    expect(line.length).toBeLessThan(120)
    expect(line.endsWith('…')).toBe(true)
  })

  it('rotates at the cap, keeping one older file', async () => {
    const log = new AppLog(dir, roots, { maxBytes: 300, flushMs: 10, lineMax: 2000 }, clock)
    for (let round = 0; round < 6; round++) {
      log.write('info', [`round ${round} ${'a b '.repeat(10)}`])
      await log.flush()
    }
    expect(statSync(path.join(dir, LOG_FILE)).size).toBeLessThanOrEqual(300)
    expect(existsSync(path.join(dir, OLD_LOG_FILE))).toBe(true)
    expect(statSync(path.join(dir, OLD_LOG_FILE)).size).toBeLessThanOrEqual(300)
    const recent = await log.recent(3)
    expect(recent.length).toBe(3)
    expect(recent[2]).toMatch(/round 5/)
  })

  it('writes what is buffered at once when quitting', () => {
    const log = new AppLog(dir, roots, { maxBytes: 10_000, flushMs: 60_000, lineMax: 2000 }, clock)
    log.write('error', [new Error('boom')])
    log.flushSync()
    expect(readFileSync(path.join(dir, LOG_FILE), 'utf8')).toMatch(/ERROR Error: boom/)
  })
})
