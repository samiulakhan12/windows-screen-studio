/**
 * Finds the cloud folders on this PC (F-22, docs/design/share.md §2.2) through a CloudProbe: the
 * environment, three registry keys read with `reg.exe export` (a fixed program path and fixed
 * arguments, a time limit; it writes UTF-16, so user names in any script survive, where `reg query`
 * prints in the console code page), Dropbox's info.json, and whether a folder exists. Tests and the
 * end-to-end run use fakeProbe (Windows-shaped data on any OS).
 */
import { execFile } from 'node:child_process'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cloudCandidates, mergeRegistry, parseRegistryText, REGISTRY_KEYS, type CloudCandidate } from '../../shared/share/cloudFolders'

export interface CloudProbe {
  env: Readonly<Record<string, string | undefined>>
  driveLetters: boolean
  /** The key with its subkeys as registry text (`reg export`, or `reg query` output), '' when it fails. */
  regQuery(key: string): Promise<string>
  /** A small text file, or null. */
  readText(file: string): Promise<string | null>
  isDir(dir: string): Promise<boolean>
  join(...parts: string[]): string
}

const REG_TIMEOUT_MS = 5000
const REG_MAX_BYTES = 512 * 1024
let exports = 0
const INFO_MAX_BYTES = 64 * 1024

async function readSmall(file: string): Promise<string | null> {
  try {
    const st = await fs.stat(file)
    if (!st.isFile() || st.size > INFO_MAX_BYTES) return null
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function isDir(dir: string): Promise<boolean> {
  if (!path.isAbsolute(dir)) return false
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/** This PC: the registry only on Windows. */
export function realProbe(): CloudProbe {
  const win = process.platform === 'win32'
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  return {
    env: process.env,
    driveLetters: win,
    regQuery: async (key) => {
      if (!win) return ''
      const file = path.join(os.tmpdir(), `flown-reg-${process.pid}-${exports++}.reg`)
      try {
        const ok = await new Promise<boolean>((resolve) => {
          execFile(reg, ['export', key, file, '/y'], { windowsHide: true, timeout: REG_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (err) => resolve(!err))
        })
        if (!ok) return ''
        const st = await fs.stat(file)
        if (st.size > REG_MAX_BYTES) return ''
        const bytes = await fs.readFile(file)
        // UTF-16 LE with a byte order mark; anything else is read as UTF-8.
        return bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8')
      } catch {
        return ''
      } finally {
        await fs.rm(file, { force: true }).catch(() => undefined)
      }
    },
    readText: readSmall,
    isDir,
    join: path.join
  }
}

/**
 * A probe for tests (unpackaged builds only, SSW_SHARE_FAKE_CLOUD): `{ env, registry: { key: output } }`
 * from a JSON file; files and folders are real.
 */
export function fakeProbe(file: string): CloudProbe {
  let data: { env?: Record<string, string>; registry?: Record<string, string> } = {}
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    console.warn('Share: the fake cloud file cannot be read')
  }
  const registry = data.registry ?? {}
  return {
    env: data.env ?? {},
    driveLetters: false,
    regQuery: async (key) => (typeof registry[key] === 'string' ? registry[key] : ''),
    readText: readSmall,
    isDir,
    join: path.join
  }
}

/** The cloud folders that exist, best source first; never throws. */
export async function detectCloudFolders(probe: CloudProbe): Promise<CloudCandidate[]> {
  const [od, gd, gdm] = await Promise.all([
    probe.regQuery(REGISTRY_KEYS.onedrive).catch(() => ''),
    probe.regQuery(REGISTRY_KEYS.drivefs).catch(() => ''),
    probe.regQuery(REGISTRY_KEYS.drivefsMachine).catch(() => '')
  ])
  const infos: string[] = []
  for (const base of [probe.env.APPDATA, probe.env.LOCALAPPDATA]) {
    if (!base) continue
    const text = await probe.readText(probe.join(base, 'Dropbox', 'info.json')).catch(() => null)
    if (text) infos.push(text)
  }
  const candidates = cloudCandidates({
    env: probe.env,
    registry: mergeRegistry(parseRegistryText(od), parseRegistryText(gd), parseRegistryText(gdm)),
    dropboxInfo: infos,
    driveLetters: probe.driveLetters,
    join: probe.join
  })
  const found: CloudCandidate[] = []
  for (const c of candidates) if (await probe.isDir(c.path).catch(() => false)) found.push(c)
  return found
}
