import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ClipboardResult } from '../shared/api/export'

/** A process that puts a file on the clipboard. Paths never pass through a shell. */
export interface ClipboardCommand {
  command: string
  args: string[]
  /** Extra environment (the path travels this way on Windows, never inside the script). */
  env?: Record<string, string>
  /** Written to the process's stdin. */
  input?: string
  /** The tool keeps serving the selection in the background (X11/Wayland): do not wait for it to exit. */
  detached?: boolean
}

const PS_SCRIPT = 'Set-Clipboard -LiteralPath $env:SSW_CLIPBOARD_FILE'

/**
 * How to copy `file` as a file (not text) on this platform: Explorer/Slack/Discord
 * paste it like a copied file. Returns null where no supported tool is available.
 */
export function clipboardCommand(
  platform: NodeJS.Platform,
  file: string,
  env: NodeJS.ProcessEnv,
  has: (tool: string) => boolean
): ClipboardCommand | null {
  if (platform === 'win32') {
    const root = env.SystemRoot || env.windir || 'C:\\Windows'
    const ps = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return {
      command: ps,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      env: { SSW_CLIPBOARD_FILE: file }
    }
  }
  if (platform === 'darwin') {
    return {
      command: 'osascript',
      args: ['-e', 'on run argv', '-e', 'set the clipboard to (POSIX file (item 1 of argv))', '-e', 'end run', file]
    }
  }
  const uri = `${pathToFileURL(file).href}\r\n`
  if (env.WAYLAND_DISPLAY && has('wl-copy')) return { command: 'wl-copy', args: ['--type', 'text/uri-list'], input: uri, detached: true }
  if (has('xclip')) return { command: 'xclip', args: ['-selection', 'clipboard', '-t', 'text/uri-list', '-i'], input: uri, detached: true }
  if (has('wl-copy')) return { command: 'wl-copy', args: ['--type', 'text/uri-list'], input: uri, detached: true }
  return null
}

/** True when `tool` is an executable on PATH. */
export function onPath(tool: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  return dirs.some((d) => existsSync(path.join(d, tool)))
}

/** Runs a clipboard command; resolves with a user-facing result (never throws). */
export function runClipboardCommand(cmd: ClipboardCommand, timeoutMs = 10000): Promise<ClipboardResult> {
  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    const done = (r: ClipboardResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    let proc
    try {
      proc = spawn(cmd.command, cmd.args, {
        windowsHide: true,
        shell: false,
        env: { ...process.env, ...cmd.env },
        // xclip/wl-copy fork a child that keeps serving the clipboard; it must not hold our pipes open.
        stdio: ['pipe', 'ignore', cmd.detached ? 'ignore' : 'pipe']
      })
    } catch (e) {
      done({ ok: false, message: `Could not copy to the clipboard (${e instanceof Error ? e.message : String(e)}).` })
      return
    }
    const timer = setTimeout(() => {
      // A detached tool that is still running after the timeout owns the selection; that is success.
      if (cmd.detached) done({ ok: true })
      else {
        proc.kill()
        done({ ok: false, message: 'Copying to the clipboard timed out.' })
      }
    }, timeoutMs)
    proc.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-1000)))
    proc.on('error', (e) => done({ ok: false, message: `Could not copy to the clipboard (${e.message}).` }))
    // 'exit', not 'close': a forked helper may keep inherited handles open.
    proc.on('exit', (code) =>
      done(code === 0 ? { ok: true } : { ok: false, message: `Could not copy to the clipboard${stderr.trim() ? `: ${stderr.trim()}` : '.'}` })
    )
    proc.stdin?.on('error', () => undefined)
    proc.stdin?.end(cmd.input ?? '')
  })
}

export async function copyFileToClipboard(file: string): Promise<ClipboardResult> {
  if (!existsSync(file)) return { ok: false, message: 'The exported file no longer exists.' }
  const cmd = clipboardCommand(process.platform, file, process.env, (t) => onPath(t))
  if (!cmd) {
    return { ok: false, message: 'Copying files is not supported here: install xclip (X11) or wl-clipboard (Wayland).' }
  }
  return runClipboardCommand(cmd)
}
