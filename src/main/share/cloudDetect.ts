/**
 * Finds the cloud folders on this PC (F-22, docs/design/share.md §2.2) through a CloudProbe: the
 * environment, two registry keys read with reg.exe (a fixed program path and fixed arguments, a
 * time limit and an output cap), Dropbox's info.json, and whether a folder exists. Tests and the
 * end-to-end run use fakeProbe (Windows-shaped data on any OS).
 */
import { execFile } from 'node:child_process'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { cloudCandidates, mergeRegistry, parseRegQuery, REGISTRY_KEYS, type CloudCandidate } from '../../shared/share/cloudFolders'

export interface CloudProbe {
  env: Readonly<Record<string, string | undefined>>
  driveLetters: boolean
  /** `reg query <key> [/s]` output, '' when it fails. */
  regQuery(key: string, recursive: boolean): Promise<string>
  /** A small text file, or null. */
  readText(file: string): Promise<string | null>
  isDir(dir: string): Promise<boolean>
  join(...parts: string[]): string
}

const REG_TIMEOUT_MS = 5000
const REG_MAX_BYTES = 256 * 1024
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
    regQuery: (key, recursive) =>
      !win
        ? Promise.resolve('')
        : new Promise((resolve) => {
            execFile(reg, ['query', key, ...(recursive ? ['/s'] : [])], { windowsHide: true, timeout: REG_TIMEOUT_MS, maxBuffer: REG_MAX_BYTES, encoding: 'utf8' }, (err, stdout) =>
              resolve(err ? '' : stdout)
            )
          }),
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
    probe.regQuery(REGISTRY_KEYS.onedrive, true).catch(() => ''),
    probe.regQuery(REGISTRY_KEYS.drivefs, false).catch(() => ''),
    probe.regQuery(REGISTRY_KEYS.drivefsMachine, false).catch(() => '')
  ])
  const infos: string[] = []
  for (const base of [probe.env.APPDATA, probe.env.LOCALAPPDATA]) {
    if (!base) continue
    const text = await probe.readText(probe.join(base, 'Dropbox', 'info.json')).catch(() => null)
    if (text) infos.push(text)
  }
  const candidates = cloudCandidates({
    env: probe.env,
    registry: mergeRegistry(parseRegQuery(od), parseRegQuery(gd), parseRegQuery(gdm)),
    dropboxInfo: infos,
    driveLetters: probe.driveLetters,
    join: probe.join
  })
  const found: CloudCandidate[] = []
  for (const c of candidates) if (await probe.isDir(c.path).catch(() => false)) found.push(c)
  return found
}
