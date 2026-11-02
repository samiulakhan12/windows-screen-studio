/**
 * The contrast meter (docs/design/captions-studio.md §7.3): with a dependable surround (a box of
 * alpha 0.6 or more, or an outline of 0.04 em or more at alpha 0.8 or more) the static figure,
 * which no video can lower; without one, measured on the video at the playhead, only while paused
 * and after a seek, never during playback (the last figure stays, with its time). Fix strengthens
 * the outline or the box in one undo step. Text, not only colour: "Contrast 3.1 to 1, hard to read
 * on this video at 0:42".
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { contrastFix, staticContrast } from '../../../../shared/captions/colors'
import { captionsOf } from '../../../../shared/captions/settings'
import { editStudio, legacyTwin } from '../../../../shared/captions/studioEdit'
import { videoTimeAt, planOf } from '../../../../shared/engine/freeze'
import { formatTime } from '../../../../shared/engine/project'
import type { CaptionStudio, Project } from '../../../../shared/types'
import { probeContrast } from '../../render/contrastProbe'
import { useEditor } from '../context'

/** A surround no video can change (§7.3): a box or an outline strong enough. */
export function dependableSurround(studio: CaptionStudio): boolean {
  const box = studio.box.kind !== 'none' && studio.box.alpha >= 0.6
  const outline = studio.edge.outline >= 0.04 && studio.edge.outlineAlpha >= 0.8
  return box || outline
}

/** How the meter words a ratio (§7.3). */
export function contrastWords(ratio: number): 'Easy to read' | 'Hard to read for some people' | 'Hard to read on this video' {
  return ratio >= 4.5 ? 'Easy to read' : ratio >= 3 ? 'Hard to read for some people' : 'Hard to read on this video'
}

/** "12.4" (one decimal, never rounded up past a threshold: 4.46 shows 4.4). */
const ratioText = (r: number): string => (Math.floor(r * 10) / 10).toFixed(1)

export function ContrastMeter(props: { project: Project; t: number; paused: boolean }): JSX.Element {
  const { project, t, paused } = props
  const { store } = useEditor()
  const settings = captionsOf(project)
  // A Classic look is measured as its twin, which draws it the same way (§5.8).
  const studio = useMemo(() => settings.studio ?? legacyTwin(settings), [settings])
  const fixed = dependableSurround(studio)
  const [measured, setMeasured] = useState<{ ratio: number; at: number } | null>(null)
  const seq = useRef(0)
  // Measured only while paused, after a seek or a change of the look; never during playback.
  useEffect(() => {
    if (fixed || !paused) return
    const n = ++seq.current
    probeContrast(project, t, studio).then(
      (r) => {
        if (n === seq.current && r) setMeasured(r)
      },
      () => undefined
    )
  }, [fixed, paused, t, studio, project])

  const ratio = fixed ? staticContrast(studio).worst : (measured?.ratio ?? null)
  const fix = (): void => store.update((p) => ({ ...p, captions: editStudio(captionsOf(p), contrastFix) }))
  if (ratio === null) {
    return (
      <p className="caption-contrast hint" data-testid="caption-contrast" role="status">
        Pause the video to check the contrast of the captions on it.
      </p>
    )
  }
  const words = contrastWords(ratio)
  const at = !fixed && measured ? formatTime(videoTimeAt(project.clips, planOf(project), measured.at), false) : null
  const shownText = `Contrast ${ratioText(ratio)} : 1${at ? ` at ${at}` : ''} · ${words}`
  const spoken = `Contrast ${ratioText(ratio)} to 1, ${words.toLowerCase()}${at ? ` at ${at}` : ''}`
  return (
    <div className={`caption-contrast ${ratio >= 4.5 ? 'good' : 'poor'}`} data-testid="caption-contrast" role="status" aria-label={spoken}>
      <span aria-hidden="true">{shownText}</span>
      {ratio < 4.5 && (
        <button type="button" className="btn small" data-testid="caption-contrast-fix" title="Strengthen the outline or the box so the captions read well" onClick={fix}>
          Fix
        </button>
      )}
    </div>
  )
}
