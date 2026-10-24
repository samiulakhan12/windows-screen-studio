import { frameDuration } from './frameTiming'
import { presentationIndex, type VideoSample } from './mp4'

export interface FeedPlan {
  /** Presentation index wanted for each target. */
  wanted: number[]
  /** Decode-order sample indices to feed, in order (jumps start at a keyframe). */
  feed: number[]
}

/**
 * Which samples to decode so that every target time can be shown: for each wanted
 * frame, everything from its keyframe up to it in decode order, skipping the
 * stretches no target needs (cuts, or fast clips spanning whole GOPs).
 */
export function planFeed(samples: VideoSample[], times: number[]): FeedPlan {
  const order = samples.map((s, d) => ({ ...s, d })).sort((a, b) => a.time - b.time || a.d - b.d)
  const frame = frameDuration(samples) ?? 1 / 60
  const keyBefore = new Array<number>(samples.length)
  let lastKey = 0
  for (let d = 0; d < samples.length; d++) {
    if (samples[d].key) lastKey = d
    keyBefore[d] = lastKey
  }
  const wanted = times.map((t) => presentationIndex(order, t, frame / 2))
  const feed: number[] = []
  let fed = -1
  let prev = -1
  for (const p of wanted) {
    if (p === prev) continue
    prev = p
    const d = order[p].d
    if (d <= fed) continue
    const k = keyBefore[d]
    for (let x = k > fed ? k : fed + 1; x <= d; x++) feed.push(x)
    fed = d
  }
  return { wanted, feed }
}
