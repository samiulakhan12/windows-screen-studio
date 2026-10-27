//! The chunk plan (§2.5): the part's speech ranges packed into chunks of at most
//! SIDECAR.maxChunk (29 s) including their padding, split in silences; each chunk padded by
//! 0.25 s on both sides but never past the middle of the gap to its neighbour. Each chunk is
//! transcribed on its own (never whisper.cpp's own VAD, whose times stay in compressed time).

pub const PAD: f64 = 0.25;

/// Chunks (start, end) in seconds for speech ranges sorted by start.
pub fn plan(speech: &[(f64, f64)], audio_s: f64, max_chunk: f64) -> Vec<(f64, f64)> {
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
                // A range longer than a chunk (the detector splits at max_speech already; this is
                // the last resort) is cut at fixed points.
                let mut a = s;
                while e - a > limit {
                    packed.push((a, a + limit));
                    a += limit;
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
        let chunks = plan(&speech, 125.0, 29.0);
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
        let chunks = plan(&speech, 50.0, 29.0);
        assert_eq!(chunks.len(), 2);
        assert!((chunks[0].0 - 0.75).abs() < 1e-9);
        assert!((chunks[0].1 - 20.15).abs() < 1e-9);
        assert!((chunks[1].0 - 20.15).abs() < 1e-9);
        assert!((chunks[1].1 - 40.25).abs() < 1e-9);
        // Clamped to the audio.
        let c = plan(&[(0.1, 2.0)], 2.1, 29.0);
        assert_eq!(c, vec![(0.0, 2.1)]);
    }

    #[test]
    fn a_range_longer_than_a_chunk_is_cut() {
        let chunks = plan(&[(0.0, 70.0)], 70.0, 29.0);
        assert!(chunks.len() == 3);
        assert!(chunks.iter().all(|c| c.1 - c.0 <= 29.0 + 1e-9));
        assert!(plan(&[], 10.0, 29.0).is_empty());
    }

    #[test]
    fn measures_speech_inside_a_chunk() {
        let s = [(1.0, 3.0), (4.0, 10.0)];
        assert!((speech_in(&s, 2.0, 5.0) - 2.0).abs() < 1e-9);
        assert_eq!(speech_in(&s, 10.0, 12.0), 0.0);
    }
}
