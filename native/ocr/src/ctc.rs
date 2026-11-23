//! CTC greedy decoding with each character's x-range (docs/design/auto-blur.md §5.5), as
//! scripts/privacy/ppocr.py `Recogniser.decode` does it: runs of one class are one character, the
//! blank (class 0) separates them, a character's range is its run's CTC steps mapped back to the
//! crop, then widened to meet its neighbours so a match's box has no holes.
//!
//! One span is written per UTF-16 code unit of the text, so the app indexes them as it indexes the
//! text itself.

/// One decoded character: its text, its [a, b) in the recogniser's input pixels, its confidence.
#[derive(Clone, Debug, PartialEq)]
pub struct Piece {
    pub s: String,
    pub a: f32,
    pub b: f32,
    pub conf: f32,
}

pub struct Decoded {
    pub text: String,
    pub conf: f32,
    /// One [start, end) a UTF-16 code unit, in crop pixels.
    pub spans: Vec<(f32, f32)>,
}

/// The characters of `probs` (`steps` rows of `classes` probabilities) over an input `img_w` wide.
pub fn pieces(probs: &[f32], steps: usize, classes: usize, chars: &[String], img_w: f32) -> Vec<Piece> {
    let px = img_w / steps.max(1) as f32;
    let mut idx = Vec::with_capacity(steps);
    let mut best = Vec::with_capacity(steps);
    for t in 0..steps {
        let row = &probs[t * classes..(t + 1) * classes];
        let (mut bi, mut bv) = (0usize, f32::MIN);
        for (i, &v) in row.iter().enumerate() {
            if v > bv {
                bi = i;
                bv = v;
            }
        }
        idx.push(bi);
        best.push(bv);
    }
    let mut out = vec![];
    let mut t = 0;
    while t < steps {
        let c = idx[t];
        let mut end = t;
        while end + 1 < steps && idx[end + 1] == c {
            end += 1;
        }
        if c != 0 {
            let s = chars.get(c).map(String::as_str).unwrap_or("?").to_string();
            let conf = best[t..=end].iter().copied().fold(f32::MIN, f32::max);
            out.push(Piece { s, a: t as f32 * px, b: (end + 1) as f32 * px, conf });
        }
        t = end + 1;
    }
    out
}

/// The text, mean confidence and crop-pixel spans of `pieces`, whose ranges are in input pixels:
/// `k` crop pixels an input pixel, `step` one CTC step in input pixels, `crop_w` the crop's width.
pub fn assemble(pieces: &[Piece], k: f32, step: f32, crop_w: f32) -> Decoded {
    let mut text = String::new();
    let mut spans = vec![];
    let n = pieces.len();
    for (i, p) in pieces.iter().enumerate() {
        let (a, b) = (p.a * k, p.b * k);
        let a2 = if i > 0 { (a + pieces[i - 1].b * k) / 2.0 } else { (a - step * k).max(0.0) };
        let b2 = if i + 1 < n { (b + pieces[i + 1].a * k) / 2.0 } else { (b + step * k).min(crop_w) };
        text.push_str(&p.s);
        for _ in 0..p.s.encode_utf16().count() {
            spans.push((a2, b2));
        }
    }
    let conf = if n > 0 { pieces.iter().map(|p| p.conf).sum::<f32>() / n as f32 } else { 0.0 };
    Decoded { text, conf, spans }
}

#[cfg(test)]
/// `pieces` then `assemble` for one recogniser run: `rw` is the part of the `img_w`-wide input the
/// line fills, `crop_w` its width in the frame.
pub fn decode(probs: &[f32], steps: usize, classes: usize, chars: &[String], rw: f32, img_w: f32, crop_w: f32) -> Decoded {
    let p = pieces(probs, steps, classes, chars, img_w);
    assemble(&p, crop_w / rw.max(1.0), img_w / steps.max(1) as f32, crop_w)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probs(classes: usize, seq: &[usize]) -> Vec<f32> {
        let mut v = vec![0.0; classes * seq.len()];
        for (t, &c) in seq.iter().enumerate() {
            v[t * classes + c] = 0.9;
        }
        v
    }

    #[test]
    fn merges_runs_and_keeps_repeats_split_by_a_blank() {
        let chars: Vec<String> = ["", "a", "b", "😀", " "].iter().map(|s| s.to_string()).collect();
        let p = probs(5, &[1, 1, 0, 1, 2, 2, 0, 3]);
        let d = decode(&p, 8, 5, &chars, 64.0, 64.0, 64.0);
        assert_eq!(d.text, "aab😀");
        // One span a UTF-16 unit; increasing and inside the crop.
        assert_eq!(d.spans.len(), 5);
        assert!(d.spans.windows(2).all(|w| w[0].0 <= w[1].0 && w[0].1 <= w[1].1));
        assert!(d.spans.iter().all(|s| s.0 >= 0.0 && s.1 <= 64.0 && s.0 < s.1));
        assert!((d.conf - 0.9).abs() < 1e-6);
    }

    #[test]
    fn maps_steps_back_to_the_crop() {
        let chars: Vec<String> = ["", "x", " "].iter().map(|s| s.to_string()).collect();
        // 40 steps over a 320-wide input whose first 160 pixels hold a 80-pixel crop.
        let mut seq = vec![0; 40];
        seq[10] = 1;
        let d = decode(&probs(3, &seq), 40, 3, &chars, 160.0, 320.0, 80.0);
        // Step 10 is input pixels 80-88, crop pixels 40-44; widened by one step each side.
        assert_eq!(d.spans, vec![(36.0, 48.0)]);
    }
}
