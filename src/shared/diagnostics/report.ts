/**
 * The diagnostics report (X-03, docs/design/hands-off.md §2.6): what it holds and its text, the
 * one the user sees in Settings before copying it. Pure.
 */

/** A part of the report that could not be read says why instead. */
export type Part<T> = { ok: true; value: T } | { ok: false; reason: string }

export interface DiagnosticsReport {
  createdAt: string
  app: { name: string; version: string; electron: string; chrome: string; node: string; packaged: boolean }
  system: Part<{ os: string; build: string; arch: string; cpu: string; cores: number; memoryGB: number }>
  displays: Part<{ width: number; height: number; scale: number; hz: number; primary: boolean }[]>
  gpu: Part<{ devices: { vendorId: string; deviceId: string; active: boolean; driver?: string }[]; features: Record<string, string> }>
  encoders: Part<string[]>
  capture: Part<{ supported: boolean; windowCapture: boolean; cursorToggle: boolean; borderToggle: boolean; encoders: string[]; reason: string | null }>
  lastCapture: Part<{ method: string; target: string; cursorInVideo: boolean; recordedAt: string } | null>
  recordings: Part<number>
  /** Long jobs running now ("export 42%"). */
  jobs: string[]
  log: Part<string[]>
}

const hex = (n: unknown): string => (typeof n === 'number' ? `0x${n.toString(16).padStart(4, '0')}` : String(n ?? '?'))

/** A GPU device of app.getGPUInfo('basic'), with only the fields that describe the hardware. */
export function gpuDevice(raw: unknown): { vendorId: string; deviceId: string; active: boolean; driver?: string } {
  const d = (raw ?? {}) as { vendorId?: unknown; deviceId?: unknown; active?: unknown; driverVersion?: unknown }
  return { vendorId: hex(d.vendorId), deviceId: hex(d.deviceId), active: d.active === true, ...(typeof d.driverVersion === 'string' ? { driver: d.driverVersion } : {}) }
}

function part<T>(p: Part<T>, show: (v: T) => string[]): string[] {
  return p.ok ? show(p.value) : [`unavailable (${p.reason})`]
}

const yes = (b: boolean): string => (b ? 'yes' : 'no')

/** The report as plain text, one "Section" heading per part. */
export function formatDiagnostics(r: DiagnosticsReport): string {
  const lines: string[] = []
  const section = (title: string, body: string[]): void => {
    lines.push(`== ${title}`, ...body.map((l) => `  ${l}`), '')
  }
  lines.push(`${r.app.name} diagnostics · ${r.createdAt}`, '')
  section('App', [
    `Version ${r.app.version}${r.app.packaged ? '' : ' (development build)'}`,
    `Electron ${r.app.electron} · Chromium ${r.app.chrome} · Node ${r.app.node}`
  ])
  section(
    'System',
    part(r.system, (s) => [`${s.os} ${s.build} (${s.arch})`, `${s.cpu} · ${s.cores} logical cores · ${s.memoryGB} GB memory`])
  )
  section(
    'Displays',
    part(r.displays, (ds) => (ds.length ? ds.map((d) => `${d.width}×${d.height} at ${Math.round(d.scale * 100)}% · ${d.hz} Hz${d.primary ? ' · primary' : ''}`) : ['none']))
  )
  section(
    'Graphics',
    part(r.gpu, (g) => [
      ...(g.devices.length ? g.devices.map((d) => `GPU ${d.vendorId}:${d.deviceId}${d.active ? ' (active)' : ''}${d.driver ? ` · driver ${d.driver}` : ''}`) : ['No GPU reported']),
      ...Object.entries(g.features)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}: ${v}`)
    ])
  )
  section('Video encoders', part(r.encoders, (e) => [e.length ? e.join(', ') : 'none found']))
  section(
    'Capture helper',
    part(r.capture, (c) => [
      `Native capture: ${yes(c.supported)} · window capture: ${yes(c.windowCapture)} · cursor toggle: ${yes(c.cursorToggle)} · border toggle: ${yes(c.borderToggle)}`,
      `Helper encoders: ${c.encoders.length ? c.encoders.join(', ') : 'none'}`,
      ...(c.reason ? [`Reason: ${c.reason}`] : [])
    ])
  )
  section(
    'Last recording',
    part(r.lastCapture, (c) => [c ? `${c.recordedAt} · ${c.method === 'native' ? 'native capture' : 'Chromium capture'} · ${c.target} · cursor in video: ${yes(c.cursorInVideo)}` : 'No recordings yet'])
  )
  section('Recordings', part(r.recordings, (n) => [String(n)]))
  section('Running jobs', r.jobs.length ? r.jobs : ['none'])
  section('Recent messages', part(r.log, (l) => (l.length ? l : ['none'])))
  return `${lines.join('\n').trimEnd()}\n`
}
