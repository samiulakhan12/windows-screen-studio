import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/*
 * The renderer and tooling seams of the contracts (docs/design/output-and-languages.md §21.0): with
 * no language shipped the English app is as before (no Language section, no Language… command in the
 * palette or the shortcuts editor), the bundle writes a timeline after its files, the scripts and
 * the scanner's config are in place, and main's English holds only main's namespaces.
 */

const { COMMANDS, PALETTE_COMMANDS, LANGUAGE_COMMANDS, WAITING_COMMANDS, commandInfo } = await import('../src/shared/editor/commands')
const BOOT = '../src/renderer/src/i18n/boot'
const boot = (await import(/* @vite-ignore */ BOOT)) as {
  bootLanguage(view: string): Promise<{ language: string; shipped: string[] }>
  currentUiInfo(): unknown
  showLanguageSection(info: unknown): boolean
}

describe('the language seams with nothing shipped', () => {
  it('boots in English at once and shows no Language section', async () => {
    expect(await boot.bootLanguage('main')).toMatchObject({ language: 'en', shipped: [] })
    expect(boot.showLanguageSection(boot.currentUiInfo())).toBe(false)
  })

  it('keeps Language… out of the palette until a language ships', () => {
    expect(commandInfo('language')).toMatchObject({ title: 'Language…', category: 'General' })
    expect(LANGUAGE_COMMANDS).toEqual(['language'])
    expect(PALETTE_COMMANDS.some((c) => c.id === 'language')).toBe(false)
    // Language… and the commands waiting for their part (auto-blur §12.3) are left out.
    expect(PALETTE_COMMANDS.length).toBe(COMMANDS.filter((c) => !c.hidden && !WAITING_COMMANDS.includes(c.id)).length - 1)
  })
})

describe('the bundle writes the timeline after its files', () => {
  it('asks for the timeline with the request and the export, and lists what it wrote and why it failed', async () => {
    vi.resetModules()
    const calls: unknown[][] = []
    vi.doMock('../src/renderer/src/editor/timelineRun', () => ({
      writeTimelineStep: async (...args: unknown[]) => {
        calls.push(args)
        return { files: [{ path: '/v/Demo.fcpxml', for: 'resolve' }], problem: 'Media changed' }
      }
    }))
    vi.stubGlobal('window', { api: { writeSidecar: async () => '/v/Demo.srt' } })
    const RUN = '../src/renderer/src/editor/exportBundleRun'
    const { writeBundle } = (await import(/* @vite-ignore */ RUN)) as { writeBundle(anchor: string, req: Record<string, unknown>): Promise<{ saved: string[]; failed: string[] } | undefined> }
    const timeline = { request: { projectId: 'p1', videoPath: '/v/Demo.mp4', editors: ['resolve'], media: 'export', stems: [] }, exported: { fps: 30, frames: 90, width: 1920, height: 1080 } }
    const project = { id: 'p1' }
    expect(await writeBundle('/v/Demo.mp4', { project, kinds: [], title: 'Demo', thumbnail: async () => new Uint8Array() })).toBeUndefined()
    const out = await writeBundle('/v/Demo.mp4', { project, kinds: [], title: 'Demo', thumbnail: async () => new Uint8Array(), timeline })
    expect(calls).toEqual([[project, timeline.request, timeline.exported, { signal: undefined }]])
    expect(out).toEqual({ saved: ['/v/Demo.fcpxml'], failed: ['Media changed'] })
    vi.unstubAllGlobals()
    vi.doUnmock('../src/renderer/src/editor/timelineRun')
  })
})

describe('tooling', () => {
  const root = path.join(__dirname, '..')
  it('runs the i18n scripts and the release check through P7’s files', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    for (const [name, file] of Object.entries({ check: 'check', build: 'build-catalogues', sheet: 'sheet', pack: 'pack', pseudo: 'pseudo', extract: 'extract' })) {
      expect(pkg.scripts[`i18n:${name}`]).toBe(`node scripts/i18n/${file}.mjs`)
      expect(fs.existsSync(path.join(root, 'scripts/i18n', `${file}.mjs`)), file).toBe(true)
    }
    expect(fs.readFileSync(path.join(root, 'scripts/predist.mjs'), 'utf8')).toContain("'check.mjs'), '--report'")
  })

  it('holds every file of parts P1-P7 to the scanner from S0, and the whole tree from step S4', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'scripts/i18n/config.json'), 'utf8')) as { scan: string; failFor: string[] }
    // Step S4 (§10.4) turned the report for the rest of the tree into a failure.
    expect(cfg.scan).toBe('fail')
    for (const f of cfg.failFor) expect(fs.existsSync(path.join(root, f)), f).toBe(true)
    for (const f of ['src/main/proArgs.ts', 'src/shared/render/stems.ts', 'src/main/timelineIpc.ts', 'src/main/presetFiles.ts', 'src/renderer/src/i18n/boot.ts', 'src/renderer/src/i18n/reviewOverlay.tsx']) expect(cfg.failFor).toContain(f)
  })

  it('gives main only the common, errors and main namespaces, and the preload none', () => {
    const mainEntry = fs.readFileSync(path.join(root, 'src/shared/i18n/messages/en/main.ts'), 'utf8')
    const imported = [...mainEntry.matchAll(/from '\.\/(\w+)\.json'/g)].map((m) => m[1])
    expect(imported).toEqual(['common', 'errors', 'main'])
    expect(fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')).toContain("import '../shared/i18n/messages/en/main'")
    for (const f of fs.readdirSync(path.join(root, 'src/preload'))) expect(fs.readFileSync(path.join(root, 'src/preload', f), 'utf8'), f).not.toMatch(/shared\/i18n/)
    const renderer = fs.readFileSync(path.join(root, 'src/renderer/src/main.tsx'), 'utf8')
    expect(renderer.indexOf("import '../../shared/i18n/messages/en/index'")).toBe(renderer.indexOf('import'))
  })
})
