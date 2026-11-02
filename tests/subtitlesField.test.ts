/**
 * The export dialog's Subtitles field (docs/design/captions-studio.md §2.13): languages ticked by
 * default (the spoken one, and the burned-in track's), one file per ticked language, Also inside
 * the video only for MP4, MOV and WebM, and GIF and M4A as before. The field holds no state, so it
 * is called as a function and its elements are read.
 */
import { describe, expect, it } from 'vitest'
import { textHash } from '../src/shared/captions/captionTracks'
import { DEFAULT_CAPTIONS } from '../src/shared/captions/settings'
import { NO_BUNDLE, type BundleOptions } from '../src/shared/render/exportBundle'
import type { CaptionTrack, ExportFormat, Project } from '../src/shared/types'

interface El {
  type: unknown
  props: Record<string, unknown>
}
type Field = (props: Record<string, unknown>) => unknown
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const FIELD = '../src/renderer/src/editor/panels/SubtitlesField'
const { SubtitlesField } = (await import(/* @vite-ignore */ FIELD)) as { SubtitlesField: Field }

const elements = (node: unknown, out: El[] = []): El[] => {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out))
  else if (node && typeof node === 'object' && 'props' in node) {
    out.push(node as El)
    elements((node as El).props.children, out)
  }
  return out
}

const bn: CaptionTrack = { language: 'bn', by: 'gemini', model: 'm', createdAt: '', segments: [{ id: 'a', text: 'এক', src: textHash('One') }] }
const project = (over: Partial<Project> = {}): Project =>
  ({
    clips: [],
    transcript: { language: 'en', provider: 'local', model: 'm', createdAt: '', segments: [{ id: 'a', start: 0, end: 1, text: 'One' }, { id: 'b', start: 2, end: 3, text: 'Two' }] },
    captionTracks: [bn],
    ...over
  }) as unknown as Project

function render(p: Project, format: ExportFormat = 'mp4', value: BundleOptions = { ...NO_BUNDLE, srt: true }, streams = false) {
  const changes: BundleOptions[] = []
  const streamed: boolean[] = []
  const tree = elements(SubtitlesField({ project: p, value, onChange: (v: BundleOptions) => changes.push(v), format, streams, onStreams: (on: boolean) => streamed.push(on) }))
  const languages = tree.filter((e) => typeof e.props['data-language'] === 'string')
  const ticked = languages.filter((e) => e.props.checked).map((e) => e.props['data-language'])
  const streamBox = tree.find((e) => e.props['data-testid'] === 'export-subtitle-streams')
  const text = tree.filter((e) => e.type === 'p').map((e) => String(e.props.children))
  return { tree, changes, streamed, languages, ticked, streamBox, text }
}

describe('Subtitles in the export dialog (§2.13)', () => {
  it('offers each caption language, the spoken one ticked; the burned-in track is ticked too', () => {
    expect(render(project()).ticked).toEqual(['en'])
    const burned = render(project({ captions: { ...DEFAULT_CAPTIONS, show: true, track: 'bn' } }))
    expect(burned.ticked).toEqual(['en', 'bn'])
    // And it says what the burned-in track lacks.
    expect(burned.text).toContain('1 caption is not translated into Bengali: it shows in English.')
  })

  it('ticking writes the languages in order; the last one cannot be unticked', () => {
    const r = render(project())
    const bnBox = r.languages.find((e) => e.props['data-language'] === 'bn')!
    ;(bnBox.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } })
    expect(r.changes.at(-1)?.languages).toEqual(['en', 'bn'])
    expect(r.languages.find((e) => e.props['data-language'] === 'en')!.props.disabled).toBe(true)
  })

  it('Also inside the video only for MP4, MOV and WebM; GIF and M4A keep their choices', () => {
    for (const f of ['mp4', 'mov', 'webm'] as const) expect(render(project(), f).streamBox).toBeDefined()
    for (const f of ['gif', 'm4a'] as const) {
      const r = render(project(), f)
      expect(r.streamBox).toBeUndefined()
      expect(r.languages).toHaveLength(0)
    }
    const r = render(project())
    ;(r.streamBox!.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } })
    expect(r.streamed).toEqual([true])
    expect(render(project(), 'mp4', NO_BUNDLE, true).text).toContain('They are separate from the captions drawn on the video.')
  })

  it('a project with one language shows no language list', () => {
    expect(render(project({ captionTracks: undefined })).languages).toHaveLength(0)
  })
})
