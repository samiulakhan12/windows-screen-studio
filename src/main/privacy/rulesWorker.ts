/**
 * The text rules in a worker thread (docs/design/auto-blur.md §5.7, §10.3, D20): detectFrame (with the
 * QR classes) and careful-long's trigger run here, never on main's event loop, so a line built to
 * make a pattern slow costs at most the host's time limit and one failed read. Screen text arrives,
 * hits leave; nothing is logged or kept.
 */
import { parentPort } from 'node:worker_threads'
import { detectFrame, needsCareful, type DetectOptions, type Hit } from '../../shared/privacy/detect/detect'
import type { ReadLine, ReadResult } from '../../shared/privacy/protocol'

/** One read to run the rules on; with `careful`, also the lines careful-long reads again. */
export interface RulesAsk {
  id: number
  lines: ReadLine[]
  qr: ReadResult['qr']
  options: DetectOptions
  careful?: boolean
}

export type RulesAnswer = { id: number; hits: Hit[]; careful: number[] } | { id: number; failed: true }

/** The rules on one ask. */
export function answer(m: RulesAsk): RulesAnswer {
  try {
    const hits = detectFrame(m.lines, m.qr, m.options)
    const careful: number[] = []
    if (m.careful) m.lines.forEach((line, i) => needsCareful(line, hits, i) && careful.push(i))
    return { id: m.id, hits, careful }
  } catch {
    return { id: m.id, failed: true }
  }
}

const port = parentPort
if (port) port.on('message', (m: RulesAsk) => port.postMessage(answer(m)))
