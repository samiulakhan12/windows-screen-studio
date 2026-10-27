//! The chunk plan (§2.5): the part's speech ranges packed into chunks of at most
//! SIDECAR.maxChunk (29 s) including their padding, split in silences; each chunk padded by
//! 0.25 s on both sides but never past the middle of the gap to its neighbour. Each chunk is
//! transcribed on its own (never whisper.cpp's own VAD, whose times stay in compressed time).
//! Speech that runs on past a chunk is cut where the detector heard the least speech in the
//! CUT_WINDOW seconds before the limit: a breath or the gap between two words.

use crate::vad::FRAME;
use crate::wav::SAMPLE_RATE;

pub const PAD: f64 = 0.25;
/// Long speech is cut in the last this many seconds before a chunk's limit...
pub const CUT_WINDOW: f64 = 8.0;
/// ...and at least this long before its end, so no scrap is transcribed on its own.
pub const MIN_TAIL: f64 = 1.0;

/// Chunks (start, end) in seconds for speech ranges sorted by start; `probs` are the detector's
/// probabilities of the part (one per vad::FRAME samples), which place the cuts in long speech.
pub fn plan(speech: &[(f64, f64)], probs: &[f32], audio_s: f64, max_chunk: f64) -> Vec<(f64, f64)> {
    let limit = (max_chunk - 2.0 * PAD).max(0.5);
    let mut packed: Vec<(f64, f64)> = Vec::new();
    for &(s, e) in speech {
        let (s, e) = (s.max(0.0), e.min(audio_s));
        if e <= s {
            continue;
        }
        match packed.last_mut() {
            Some(c) if e - c.0 <= limit => c.1 = c.1.max(e),
            _ => {
                // A range longer than a chunk is cut at its quietest frames (whisper.cpp's
                // max_speech_duration_s is no help: it cuts at whatever frame passes the limit,
                // and its 200 ms merge joins the pieces again).
                let mut a = s;
                while e - a > limit {
                    let c = quietest(probs, a, e, limit);
                    packed.push((a, c));
                    a = c;
                }
                packed.push((a, e));
            }
        }
    }
    let n = packed.len();
    (0..n)
        .map(|i| {
            let lo = if i > 0 { (packed[i - 1].1 + packed[i].0) / 2.0 } else { 0.0 };
            let hi = if i + 1 < n { (packed[i].1 + packed[i + 1].0) / 2.0 } else { audio_s };
            ((packed[i].0 - PAD).max(lo).max(0.0), (packed[i].1 + PAD).min(hi).min(audio_s))
        })
        .collect()
}

/// Where speech running from `a` to `e` (longer than `limit`) is cut: the middle of the frame
/// with the lowest probability in [a + limit - CUT_WINDOW, a + limit] and at least MIN_TAIL
/// before `e`; a + limit when no probability falls there.
fn quietest(probs: &[f32], a: f64, e: f64, limit: f64) -> f64 {
    let frame = FRAME as f64 / SAMPLE_RATE as f64;
    let lo = a + (limit - CUT_WINDOW).max(limit / 2.0);
    let hi = (a + limit).min(e - MIN_TAIL);
    // The frames whose middle lies in [lo, hi].
    let first = (lo / frame - 0.5).ceil().max(0.0) as usize;
    let end = (hi / frame + 0.5).floor().max(0.0) as usize;
    let mut best: Option<(usize, f32)> = None;
    for (i, &p) in probs.iter().enumerate().take(end).skip(first) {
        if best.is_none_or(|(_, b)| p < b) {
            best = Some((i, p));
        }
    }
    best.map_or(a + limit, |(i, _)| (i as f64 + 0.5) * frame)
}

/// Seconds of speech inside [a, b).
pub fn speech_in(speech: &[(f64, f64)], a: f64, b: f64) -> f64 {
    speech.iter().map(|&(s, e)| (e.min(b) - s.max(a)).max(0.0)).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_ranges_into_chunks_of_at_most_29_s() {
        let speech: Vec<(f64, f64)> = (0..40).map(|i| (i as f64 * 3.0 + 0.5, i as f64 * 3.0 + 2.5)).collect();
        let chunks = plan(&speech, &[], 125.0, 29.0);
        assert!(chunks.len() >= 5);
        for c in &chunks {
            assert!(c.1 - c.0 <= 29.0 + 1e-9, "{c:?}");
        }
        // Every bit of speech is inside a chunk, in order, without overlap.
        for &(s, e) in &speech {
            assert!(chunks.iter().any(|c| c.0 <= s && e <= c.1), "{s}-{e}");
        }
        for w in chunks.windows(2) {
            assert!(w[0].1 <= w[1].0 + 1e-9);
        }
    }

    #[test]
    fn padding_never_passes_the_middle_of_a_gap() {
        // Gap of 0.3 s between two chunks: each side gets 0.15 s, not 0.25.
        let speech = [(1.0, 20.0), (20.3, 40.0)];
        let chunks = plan(&speech, &[], 50.0, 29.0);
        assert_eq!(chunks.len(), 2);
        assert!((chunks[0].0 - 0.75).abs() < 1e-9);
        assert!((chunks[0].1 - 20.15).abs() < 1e-9);
        assert!((chunks[1].0 - 20.15).abs() < 1e-9);
        assert!((chunks[1].1 - 40.25).abs() < 1e-9);
        // Clamped to the audio.
        let c = plan(&[(0.1, 2.0)], &[], 2.1, 29.0);
        assert_eq!(c, vec![(0.0, 2.1)]);
    }

    #[test]
    fn a_range_longer_than_a_chunk_is_cut() {
        // Without probabilities, at the limit.
        let chunks = plan(&[(0.0, 70.0)], &[], 70.0, 29.0);
        assert!(chunks.len() == 3);
        assert!(chunks.iter().all(|c| c.1 - c.0 <= 29.0 + 1e-9));
        assert!(plan(&[], &[], 10.0, 29.0).is_empty());
    }

    /// The detector's probabilities of `seconds` of speech (0.9), with one-frame dips (time, p).
    fn track(seconds: f64, dips: &[(f64, f32)]) -> Vec<f32> {
        let frame = FRAME as f64 / SAMPLE_RATE as f64;
        let mut p = vec![0.9f32; (seconds / frame).ceil() as usize];
        for &(t, v) in dips {
            p[(t / frame) as usize] = v;
        }
        p
    }

    #[test]
    fn long_speech_is_cut_where_the_detector_heard_the_least() {
        // A minute the detector never ends (no dip of 100 ms below 0.35), with a breath at 22 s
        // and a softer one at 45.3 s; the dip at 10 s is too early to make a chunk of.
        let probs = track(60.0, &[(10.0, 0.05), (22.0, 0.3), (45.3, 0.4)]);
        let chunks = plan(&[(0.0, 60.0)], &probs, 60.0, 29.0);
        assert_eq!(chunks.len(), 3, "{chunks:?}");
        assert!((chunks[0].1 - 22.0).abs() <= 0.032 && chunks[1].0 == chunks[0].1, "{chunks:?}");
        assert!((chunks[1].1 - 45.3).abs() <= 0.032 && chunks[2].0 == chunks[1].1, "{chunks:?}");
        assert!(chunks.iter().all(|c| c.1 - c.0 <= 29.0 + 1e-9), "{chunks:?}");
        // Just over a chunk: the quietest frame of the last second would leave a scrap of a word
        // to transcribe alone, so the cut takes the next quietest.
        let probs = track(30.0, &[(24.0, 0.2), (28.4, 0.0)]);
        let chunks = plan(&[(0.0, 28.7)], &probs, 30.0, 29.0);
        assert_eq!(chunks.len(), 2, "{chunks:?}");
        assert!((chunks[0].1 - 24.0).abs() <= 0.032, "{chunks:?}");
        assert!((chunks[1].1 - 28.95).abs() < 1e-9, "{chunks:?}");
    }

    #[test]
    fn measures_speech_inside_a_chunk() {
        let s = [(1.0, 3.0), (4.0, 10.0)];
        assert!((speech_in(&s, 2.0, 5.0) - 2.0).abs() < 1e-9);
        assert_eq!(speech_in(&s, 10.0, 12.0), 0.0);
    }
}
