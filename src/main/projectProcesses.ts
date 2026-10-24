/**
 * ffmpeg runs that read a project's files (smart speed's still detection, the sound level
 * measurement), kept per project so they can be stopped when the editor closes or before the
 * project is deleted: on Windows a file an ffmpeg process has open cannot be deleted.
 */
import type { ChildProcess } from 'node:child_process'

/** Longest wait for a killed process to let go of its files. */
const CLOSE_TIMEOUT = 5000

export class ProjectProcesses {
  private readonly owners = new Map<ChildProcess, string>()
  private readonly stops = new Map<string, number>()

  /** How often project `id`'s work was stopped: work that started before a stop starts nothing new. */
  generation(id: string): number {
    return this.stops.get(id) ?? 0
  }

  add(proc: ChildProcess, id: string): void {
    this.owners.set(proc, id)
  }

  delete(proc: ChildProcess): void {
    this.owners.delete(proc)
  }

  /** Kills project `id`'s processes; resolves once each has exited (and closed the files it read). */
  async stop(id: string): Promise<void> {
    this.stops.set(id, this.generation(id) + 1)
    const procs = [...this.owners].filter(([, owner]) => owner === id).map(([proc]) => proc)
    await Promise.all(procs.map(killAndWait))
  }

  /** Kills every process (the app is quitting). */
  stopAll(): void {
    for (const proc of this.owners.keys()) proc.kill('SIGKILL')
    this.owners.clear()
  }
}

function killAndWait(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
    const timer = setTimeout(resolve, CLOSE_TIMEOUT)
    proc.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    proc.kill('SIGKILL')
  })
}
