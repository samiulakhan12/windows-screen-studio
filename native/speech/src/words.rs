//! Word forming (§5.2), per chunk, before the chunk's segment lines are printed: nothing changes
//! a word after its line is out, because the segment lines are all the app receives.
//!
//! Raw words: tokens with an id below `whisper_token_eot`; a word starts at a token whose bytes
//! begin with a space; bytes are joined and decoded once (a token can split a code point);
//! `t_dtw` (centiseconds) marks about the end of a token, so a word ends at the `t_dtw` of its
//! last letter or digit token (punctuation tokens come late) and starts at the previous word's
//! end or the segment's t0. Then the refinements, with state carried through the run:
//! 1. pull-in: a start more than max(0.3 s, 2 × min(0.7, median)) before the word's end moves
//!    to that distance; the median is over the raw word lengths of this chunk and every earlier
//!    one (the first chunk seeds it), never over words not yet transcribed;
//! 2. onset snap: a speech onset inside (start, end − 50 ms) moves the start to it;
//! 3. monotonic: a start is never before the previous word's end, across chunk joins too; an
//!    end is never before its start.

use crate::protocol::{lossy, Segment, Word};

/// One token of a segment, as whisper.cpp reports it.
#[derive(Clone, Debug)]
pub struct Token {
    pub bytes: Vec<u8>,
    /// DTW time, seconds from the start of the audio.
    pub dtw: f64,
    pub p: f32,
}

/// One segment of a chunk before words are formed.
#[derive(Clone, Debug)]
pub struct RawSegment {
    pub t0: f64,
    pub t1: f64,
    pub text: Vec<u8>,
    /// Text tokens only (ids below eot).
    pub tokens: Vec<Token>,
}

fn has_letter_or_digit(b: &[u8]) -> bool {
    // Non-ASCII bytes belong to letters of other scripts (or part of one).
    b.iter().any(|c| c.is_ascii_alphanumeric() || *c >= 0x80)
}

/// The words of one chunk's segments, unrefined.
pub fn raw_words(segs: &[RawSegment]) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut prev_end = f64::NEG_INFINITY;
    for s in segs {
        struct Acc {
            bytes: Vec<u8>,
            end: Option<f64>,
            probs: Vec<f32>,
        }
        let mut raw: Vec<Acc> = Vec::new();
        for t in &s.tokens {
            if raw.is_empty() || t.bytes.first() == Some(&b' ') {
                raw.push(Acc { bytes: Vec::new(), end: None, probs: Vec::new() });
            }
            let w = raw.last_mut().unwrap();
            w.bytes.extend_from_slice(&t.bytes);
            if w.end.is_none() || has_letter_or_digit(&t.bytes) {
                w.end = Some(t.dtw);
            }
            w.probs.push(t.p);
        }
        let mut words = Vec::new();
        for (k, w) in raw.into_iter().enumerate() {
            let text = lossy(&w.bytes).trim().to_string();
            if text.is_empty() {
                continue;
            }
            let prob = w.probs.iter().map(|p| *p as f64).sum::<f64>() / w.probs.len().max(1) as f64;
            let end = w.end.unwrap_or(s.t0).clamp(s.t0, s.t1.max(s.t0));
            let start = if k == 0 { s.t0.max(prev_end) } else { prev_end.max(s.t0) };
            words.push(Word { text, start: start.min(end), end, prob });
            prev_end = end;
        }
        out.push(Segment { start: s.t0, end: s.t1, text: lossy(&s.text).trim().to_string(), words });
    }
    out
}

/// The refinement state of a run.
#[derive(Debug, Clone)]
pub struct Refiner {
    /// Raw word lengths of every chunk so far.
    lengths: Vec<f64>,
    /// End of the last word printed.
    last_end: f64,
}

impl Default for Refiner {
    fn default() -> Self {
        Refiner { lengths: Vec::new(), last_end: f64::NEG_INFINITY }
    }
}

impl Refiner {
    /// Refines one chunk's words in place (`speech`: the part's speech ranges, for the onset
    /// snap). Segment bounds follow their words.
    pub fn chunk(&mut self, segs: &mut [Segment], speech: &[(f64, f64)]) {
        self.lengths.extend(segs.iter().flat_map(|s| s.words.iter().map(|w| w.end - w.start)));
        let mut durs: Vec<f64> = self.lengths.iter().copied().filter(|d| *d > 0.0).collect();
        if durs.is_empty() {
            // Nothing measured yet (every word has zero length): only the monotonic rule.
            for s in segs.iter_mut() {
                for w in s.words.iter_mut() {
                    self.monotonic(w);
                }
                bounds(s);
            }
            return;
        }
        durs.sort_by(|a, b| a.total_cmp(b));
        let median = durs[durs.len() / 2].min(0.7);
        let max_word = (median * 2.0).max(0.3);
        for s in segs.iter_mut() {
            for w in s.words.iter_mut() {
                if w.end - w.start > max_word {
                    w.start = w.end - max_word;
                }
                if let Some(on) = speech.iter().map(|r| r.0).rfind(|on| *on > w.start && *on < w.end - 0.05) {
                    w.start = on;
                }
                self.monotonic(w);
            }
            bounds(s);
        }
    }

    fn monotonic(&mut self, w: &mut Word) {
        if w.start < self.last_end {
            w.start = self.last_end;
        }
        if w.end < w.start {
            w.end = w.start;
        }
        self.last_end = w.end;
    }
}

fn bounds(s: &mut Segment) {
    if let (Some(f), Some(l)) = (s.words.first(), s.words.last()) {
        s.start = f.start;
        s.end = s.end.max(l.end);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testjson::{parse, Json};

    fn tok(s: &[u8], dtw: f64) -> Token {
        Token { bytes: s.to_vec(), dtw, p: 0.5 }
    }

    #[test]
    fn forms_words_from_tokens() {
        let seg = RawSegment {
            t0: 1.0,
            t1: 5.0,
            text: b" Hello, caf\xc3\xa9 ok.".to_vec(),
            tokens: vec![
                tok(b" Hel", 1.3),
                tok(b"lo", 1.6),
                tok(b",", 2.4), // punctuation comes late: the word ends at "lo"
                tok(b" caf\xc3", 2.0),
                tok(b"\xa9", 2.2), // a code point split across two tokens
                tok(b" ok", 2.6),
                tok(b".", 3.4),
            ],
        };
        let w = &raw_words(&[seg])[0].words;
        let texts: Vec<&str> = w.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["Hello,", "café", "ok."]);
        assert_eq!((w[0].start, w[0].end), (1.0, 1.6));
        assert_eq!((w[1].start, w[1].end), (1.6, 2.2));
        assert_eq!((w[2].start, w[2].end), (2.2, 2.6));
        assert!((w[0].prob - 0.5).abs() < 1e-9);
    }

    #[test]
    fn a_dangling_split_code_point_stays_valid_text() {
        let seg = RawSegment { t0: 0.0, t1: 1.0, text: vec![], tokens: vec![tok(b" caf\xc3", 0.5)] };
        assert_eq!(raw_words(&[seg])[0].words[0].text, "caf\u{FFFD}");
    }

    fn word(text: &str, start: f64, end: f64) -> Word {
        Word { text: text.into(), start, end, prob: 1.0 }
    }

    #[test]
    fn pulls_in_starts_that_swallowed_a_pause() {
        let mut segs = vec![Segment {
            start: 0.0,
            end: 10.0,
            text: String::new(),
            words: vec![word("a", 0.0, 0.3), word("b", 0.3, 0.6), word("c", 0.6, 3.6)],
        }];
        Refiner::default().chunk(&mut segs, &[]);
        // median 0.3 → at most max(0.3, 0.6) = 0.6 s
        assert!((segs[0].words[2].start - 3.0).abs() < 1e-9);
    }

    #[test]
    fn snaps_a_start_to_a_speech_onset_inside_the_word() {
        let mut segs = vec![Segment {
            start: 0.0,
            end: 10.0,
            text: String::new(),
            words: vec![word("a", 0.0, 0.4), word("b", 0.4, 0.8)],
        }];
        Refiner::default().chunk(&mut segs, &[(0.0, 0.3), (0.55, 2.0)]);
        assert!((segs[0].words[1].start - 0.55).abs() < 1e-9);
        // An onset in the last 50 ms does not count.
        let mut segs = vec![Segment {
            start: 0.0,
            end: 10.0,
            text: String::new(),
            words: vec![word("a", 0.0, 0.4), word("b", 0.4, 0.8)],
        }];
        Refiner::default().chunk(&mut segs, &[(0.77, 2.0)]);
        assert!((segs[0].words[1].start - 0.4).abs() < 1e-9);
    }

    #[test]
    fn stays_monotonic_across_a_chunk_join() {
        let mut r = Refiner::default();
        let mut a = vec![Segment {
            start: 0.0,
            end: 5.0,
            text: String::new(),
            words: vec![word("a", 0.0, 0.5), word("b", 0.5, 5.2)],
        }];
        r.chunk(&mut a, &[]);
        let end_b = a[0].words[1].end;
        let mut b = vec![Segment {
            start: 4.9,
            end: 8.0,
            text: String::new(),
            words: vec![word("c", 4.9, 5.0), word("d", 5.0, 5.6)],
        }];
        r.chunk(&mut b, &[]);
        assert!(b[0].words[0].start >= end_b);
        assert!(b[0].words[0].end >= b[0].words[0].start);
        assert!(b[0].start >= end_b);
    }

    #[test]
    fn the_median_grows_with_the_run_and_never_looks_ahead() {
        let mut r = Refiner::default();
        // First chunk: short words (median 0.2 → limit 0.4).
        let mut a = vec![Segment {
            start: 0.0,
            end: 2.0,
            text: String::new(),
            words: vec![word("a", 0.0, 0.2), word("b", 0.2, 0.4), word("c", 0.4, 1.4)],
        }];
        r.chunk(&mut a, &[]);
        assert!((a[0].words[2].start - 1.0).abs() < 1e-9);
        // Second chunk alone would have median 0.6, but the run's median is still over the first.
        let mut b = vec![Segment {
            start: 10.0,
            end: 12.0,
            text: String::new(),
            words: vec![word("d", 10.0, 10.6), word("e", 10.6, 11.2), word("f", 11.2, 12.2)],
        }];
        r.chunk(&mut b, &[]);
        // lengths 0.2 0.2 1.0 0.6 0.6 1.0 → sorted upper median 0.6 → limit 1.2: f stays.
        assert!((b[0].words[2].start - 11.2).abs() < 1e-9);
    }

    /// The spike's recorded run (tests/data): its segment lines are the unrefined words of five
    /// chunks; its result line holds the same words refined once over the whole run.
    #[test]
    fn per_chunk_refinement_matches_the_recorded_whole_run() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/spike-base-q5_1-clip.jsonl");
        let lines: Vec<Json> = std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| parse(l).unwrap())
            .collect();
        fn of<'a>(lines: &'a [Json], t: &'static str) -> impl Iterator<Item = &'a Json> {
            lines.iter().filter(move |l| l.get("type").map(|v| v.s()) == Some(t))
        }
        let speech: Vec<(f64, f64)> = of(&lines, "speech")
            .next()
            .unwrap()
            .get("segments")
            .unwrap()
            .arr()
            .iter()
            .map(|r| (r.idx(0).unwrap().f(), r.idx(1).unwrap().f()))
            .collect();
        let result = of(&lines, "result").next().unwrap();
        let audio_s = result.get("duration").unwrap().f();
        let whole: Vec<(String, f64, f64)> = result
            .get("words")
            .unwrap()
            .arr()
            .iter()
            .map(|w| (w.get("text").unwrap().s().to_string(), w.get("start").unwrap().f(), w.get("end").unwrap().f()))
            .collect();
        let segs: Vec<Segment> = of(&lines, "segment")
            .map(|s| Segment {
                start: s.get("start").unwrap().f(),
                end: s.get("end").unwrap().f(),
                text: s.get("text").unwrap().s().into(),
                words: s
                    .get("words")
                    .unwrap()
                    .arr()
                    .iter()
                    .map(|w| word(w.get("text").unwrap().s(), w.get("start").unwrap().f(), w.get("end").unwrap().f()))
                    .collect(),
            })
            .collect();
        // The helper's own chunk plan groups the segment lines (each chunk's segments start
        // inside it).
        let chunks = crate::chunks::plan(&speech, &[], audio_s, 29.0);
        assert_eq!(chunks.len(), 5);
        let mut groups: Vec<Vec<Segment>> = vec![Vec::new(); chunks.len()];
        for s in segs {
            let k = chunks.iter().rposition(|c| c.0 <= s.start + 1e-6).unwrap();
            groups[k].push(s);
        }
        let mut r = Refiner::default();
        let mut streamed: Vec<Word> = Vec::new();
        for mut g in groups {
            r.chunk(&mut g, &speech);
            streamed.extend(g.into_iter().flat_map(|s| s.words));
        }
        assert_eq!(streamed.len(), whole.len());
        let mut same = 0;
        let mut worst = 0f64;
        for (a, b) in streamed.iter().zip(&whole) {
            assert_eq!(a.text, b.0);
            // The recorded file has three decimals.
            let d = (a.start - b.1).abs().max((a.end - b.2).abs());
            if d <= 0.001 + 1e-9 {
                same += 1;
            }
            worst = worst.max(d);
        }
        let share = same as f64 / whole.len() as f64;
        println!(
            "per-chunk refinement: {same} of {} words identical, at most {:.0} ms apart",
            whole.len(),
            worst * 1000.0
        );
        assert!(share >= 0.95, "{same} of {} identical", whole.len());
        assert!(worst <= 0.150, "a word {worst} s apart");
        for w in streamed.windows(2) {
            assert!(w[1].start >= w[0].end - 1e-9 && w[1].end >= w[1].start);
        }
    }
}
