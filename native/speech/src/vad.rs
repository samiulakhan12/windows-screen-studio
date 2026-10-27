//! The speech detector (Silero VAD v6.2.0 in ggml form, run by whisper.cpp on one thread).
//!
//! `vad` prints one probability per 32 ms frame. The audio is read in windows of 300 s with
//! about 2 s of overlap, so an hour needs about 20 MB of samples, not 230 MB. whisper.cpp
//! resets Silero's state at the start of each call, so the frames of the overlap are taken from
//! the later window only after it has heard about 1 s, and from the earlier one before that.
//! `transcribe` runs the detector on its whole part (at most 10 minutes) and uses whisper.cpp's
//! own segments (`whisper_vad_segments_from_probs`).

use std::io::Read;
use std::path::Path;

use whisper_rs_sys as sys;

use crate::loader::Loader;
use crate::protocol::{Code, Failure};
use crate::wav::{fill_f32le, SAMPLE_RATE};

/// Samples per probability (32 ms at 16 kHz).
pub const FRAME: usize = 512;
/// 300 s windows (9375 frames) with 63 frames (2.016 s) of overlap.
pub const WINDOW_FRAMES: usize = 9375;
pub const OVERLAP_FRAMES: usize = 63;

pub struct VadModel(*mut sys::whisper_vad_context);

impl Drop for VadModel {
    fn drop(&mut self) {
        unsafe { sys::whisper_vad_free(self.0) }
    }
}

impl VadModel {
    pub fn open(path: &Path, threads: i32) -> Result<VadModel, Failure> {
        let mut loader = Loader::open(path)?;
        let mut cp = unsafe { sys::whisper_vad_default_context_params() };
        cp.n_threads = threads;
        cp.use_gpu = false;
        let ctx = unsafe { sys::whisper_vad_init_with_params(&mut loader.raw, cp) };
        if ctx.is_null() {
            return Err(Failure::new(Code::Model, "cannot load the speech detector model"));
        }
        let m = VadModel(ctx);
        if loader.truncated() {
            return Err(Failure::new(Code::Model, "the speech detector model is cut short"));
        }
        Ok(m)
    }

    /// `open` for `transcribe`, where error `model` means the Whisper model (the app clears its
    /// verified record and offers to download it again). The detector model ships with the app
    /// and is checked against its pin before it is passed, so one that cannot be loaded is a bad
    /// argument: error `args`, naming it.
    pub fn open_beside_whisper(path: &Path, threads: i32) -> Result<VadModel, Failure> {
        VadModel::open(path, threads).map_err(|f| match f.code {
            Code::Model => {
                Failure::new(Code::Args, format!("--vad-model is not a usable speech detector model ({})", f.message))
            }
            _ => f,
        })
    }

    /// One probability per 512 samples (the last frame zero-padded).
    pub fn detect(&self, pcm: &[f32]) -> Result<Vec<f32>, Failure> {
        if pcm.is_empty() {
            return Ok(Vec::new());
        }
        if !unsafe { sys::whisper_vad_detect_speech(self.0, pcm.as_ptr(), pcm.len() as i32) } {
            return Err(Failure::new(Code::Internal, "the speech detector failed"));
        }
        let n = unsafe { sys::whisper_vad_n_probs(self.0) }.max(0) as usize;
        let p = unsafe { sys::whisper_vad_probs(self.0) };
        if n > 0 && p.is_null() {
            return Err(Failure::new(Code::Internal, "the speech detector returned nothing"));
        }
        let probs = if n == 0 { Vec::new() } else { unsafe { std::slice::from_raw_parts(p, n) }.to_vec() };
        Ok(probs.into_iter().map(|v| if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 }).collect())
    }

    /// Speech ranges of the last `detect`, seconds (the design's VAD constants: threshold 0.5,
    /// speech of at least 250 ms, silences of at least 100 ms, 30 ms padding). A range can be
    /// longer than a chunk: chunks::plan cuts it at its quietest frame. whisper.cpp's
    /// `max_speech_duration_s` stays off: it cuts at whatever frame passes the limit (mid-word),
    /// and its merge of gaps under 200 ms joins the pieces again.
    pub fn segments(&self) -> Result<Vec<(f64, f64)>, Failure> {
        let mut p = unsafe { sys::whisper_vad_default_params() };
        p.threshold = 0.5;
        p.min_speech_duration_ms = 250;
        p.min_silence_duration_ms = 100;
        p.speech_pad_ms = 30;
        p.max_speech_duration_s = f32::MAX;
        let segs = unsafe { sys::whisper_vad_segments_from_probs(self.0, p) };
        if segs.is_null() {
            return Err(Failure::new(Code::Internal, "the speech detector's segments failed"));
        }
        let n = unsafe { sys::whisper_vad_segments_n_segments(segs) };
        // whisper.cpp gives segment times in centiseconds.
        let out = (0..n)
            .map(|i| unsafe {
                (
                    sys::whisper_vad_segments_get_segment_t0(segs, i) as f64 / 100.0,
                    sys::whisper_vad_segments_get_segment_t1(segs, i) as f64 / 100.0,
                )
            })
            .filter(|(s, e)| s.is_finite() && e.is_finite() && e > s)
            .collect();
        unsafe { sys::whisper_vad_free_segments(segs) };
        Ok(out)
    }
}

/// Where window `k` (starting at frame `k * step`) contributes: frames `[from, to)` relative to
/// the window, `None` for `to` meaning its end.
fn take(k: usize, window: usize, overlap: usize, last: bool) -> (usize, Option<usize>) {
    let half = overlap / 2;
    let from = if k == 0 { 0 } else { half };
    let to = if last { None } else { Some(window - overlap + half) };
    (from, to)
}

/// Probabilities of a whole stream, computed window by window: `next` fills the buffer from the
/// input (false at its end), `detect` turns samples into frame probabilities. The result has
/// one probability per started 512-sample frame of the input, like one call over all of it.
/// Returns (probabilities, samples read).
pub fn windowed(
    window: usize,
    overlap: usize,
    mut next: impl FnMut(&mut Vec<f32>, usize) -> Result<bool, Failure>,
    mut detect: impl FnMut(&[f32]) -> Result<Vec<f32>, Failure>,
) -> Result<(Vec<f32>, u64), Failure> {
    assert!(overlap < window && overlap >= 2);
    let step = window - overlap;
    let mut buf: Vec<f32> = Vec::new();
    let mut out: Vec<f32> = Vec::new();
    let mut total: u64 = 0;
    let mut k = 0;
    loop {
        let before = buf.len();
        let more = next(&mut buf, window * FRAME)?;
        total += (buf.len() - before) as u64;
        // Without more input, or with only what the previous window already covered, this is
        // the last window.
        let last = !more || buf.len() < window * FRAME;
        if last {
            if k > 0 && buf.len() <= overlap * FRAME && buf.len() <= (overlap / 2) * FRAME {
                // Everything left was already taken from the previous window.
                break;
            }
            let probs = detect(&buf)?;
            let (from, _) = take(k, window, overlap, true);
            out.extend_from_slice(probs.get(from..).unwrap_or(&[]));
            break;
        }
        let probs = detect(&buf[..window * FRAME])?;
        let (from, to) = take(k, window, overlap, false);
        out.extend_from_slice(&probs[from..to.unwrap()]);
        buf.drain(..step * FRAME);
        k += 1;
    }
    Ok((out, total))
}

/// `vad` on a stream of f32le samples (ffmpeg's pipe).
pub fn probs_from_reader(model: &VadModel, r: &mut impl Read) -> Result<(Vec<f32>, f64), Failure> {
    let mut carry = Vec::new();
    let (probs, n) = windowed(
        WINDOW_FRAMES,
        OVERLAP_FRAMES,
        |buf, want| fill_f32le(r, buf, want, &mut carry),
        |pcm| model.detect(pcm),
    )?;
    Ok((probs, n as f64 / SAMPLE_RATE as f64))
}

/// `vad` on samples already in memory (a WAV file).
pub fn probs_from_samples(model: &VadModel, pcm: &[f32]) -> Result<(Vec<f32>, f64), Failure> {
    let (probs, n) = windowed_slice(pcm, WINDOW_FRAMES, OVERLAP_FRAMES, |p| model.detect(p))?;
    Ok((probs, n as f64 / SAMPLE_RATE as f64))
}

pub fn windowed_slice(
    pcm: &[f32],
    window: usize,
    overlap: usize,
    detect: impl FnMut(&[f32]) -> Result<Vec<f32>, Failure>,
) -> Result<(Vec<f32>, u64), Failure> {
    let mut pos = 0;
    windowed(
        window,
        overlap,
        |buf, want| {
            let n = want.saturating_sub(buf.len()).min(pcm.len() - pos);
            buf.extend_from_slice(&pcm[pos..pos + n]);
            pos += n;
            Ok(pos < pcm.len())
        },
        detect,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loader::tests::{temp_dir, vad_model};

    /// A fake detector whose "probability" of a frame is its first sample, so stitching errors
    /// show as wrong values.
    fn fake(pcm: &[f32]) -> Result<Vec<f32>, Failure> {
        Ok(pcm.chunks(FRAME).map(|c| c[0]).collect())
    }

    #[test]
    fn stitched_windows_give_one_value_per_frame_in_order() {
        for len in [0, 1, 511, 512, 513, 10 * 512, 20 * 512, 20 * 512 + 7, 21 * 512, 23 * 512, 100 * 512 + 3, 101 * 512]
        {
            let pcm: Vec<f32> = (0..len).map(|i| (i / FRAME) as f32).collect();
            let (probs, n) = windowed_slice(&pcm, 20, 6, fake).unwrap();
            assert_eq!(n as usize, len);
            let want: Vec<f32> = (0..len.div_ceil(FRAME)).map(|i| i as f32).collect();
            assert_eq!(probs, want, "len {len}");
            // The stream reader in odd piece sizes gives the same.
            let bytes: Vec<u8> = pcm.iter().flat_map(|v| v.to_le_bytes()).collect();
            let mut r: &[u8] = &bytes;
            let mut carry = Vec::new();
            let (p2, n2) = windowed(20, 6, |b, w| fill_f32le(&mut r, b, w, &mut carry), fake).unwrap();
            assert_eq!((p2, n2 as usize), (want, len));
        }
    }

    /// Something Silero takes for speech: a 100-140 Hz glottal pulse train (smoothed pulses)
    /// through three vowel formants that change every syllable, 4 syllables a second in 4.5 s
    /// phrases with 2.5 s pauses, plus a little noise.
    fn synthetic_voice(seconds: f64) -> Vec<f32> {
        let sr = SAMPLE_RATE as f64;
        let n = (seconds * sr) as usize;
        let pi = std::f64::consts::PI;
        // Pulses.
        let mut src = vec![0f64; n];
        let mut phase = 0f64;
        for (i, s) in src.iter_mut().enumerate() {
            let t = i as f64 / sr;
            let before = phase;
            phase += (120.0 + 20.0 * (2.0 * pi * 0.7 * t).sin()) / sr;
            if phase.floor() > before.floor() {
                *s = 1.0;
            }
        }
        let hann: Vec<f64> = (0..40).map(|k| 0.5 - 0.5 * (2.0 * pi * k as f64 / 39.0).cos()).collect();
        let mut glottal = vec![0f64; n];
        for (i, s) in src.iter().enumerate().filter(|(_, s)| **s > 0.0) {
            for (k, h) in hann.iter().enumerate() {
                if let Some(g) = (i + k).checked_sub(20).and_then(|j| glottal.get_mut(j)) {
                    *g += s * h;
                }
            }
        }
        const VOWELS: [[f64; 3]; 5] = [
            [730.0, 1090.0, 2440.0],
            [270.0, 2290.0, 3010.0],
            [300.0, 870.0, 2240.0],
            [530.0, 1840.0, 2480.0],
            [640.0, 1190.0, 2390.0],
        ];
        let syl_len = (sr / 4.0) as usize;
        let mut y = vec![0f64; n];
        for (k, chunk) in glottal.chunks(syl_len).enumerate() {
            let formants = VOWELS[k % 5];
            for (f, (bw, gain)) in formants.iter().zip([(80.0, 1.0), (100.0, 0.5), (120.0, 0.25)]) {
                let r = (-pi * bw / sr).exp();
                let c = 2.0 * r * (2.0 * pi * f / sr).cos();
                let (mut y1, mut y2) = (0f64, 0f64);
                for (j, x) in chunk.iter().enumerate() {
                    let v = (1.0 - r) * x + c * y1 - r * r * y2;
                    y2 = y1;
                    y1 = v;
                    y[k * syl_len + j] += gain * v;
                }
            }
        }
        for (i, v) in y.iter_mut().enumerate() {
            let t = i as f64 / sr;
            let syl = (t * 4.0).fract();
            let talking = (t % 7.0) < 4.5 && syl < 0.7;
            *v *= if talking { (pi * syl / 0.7).sin() } else { 0.0 };
        }
        let peak = y.iter().fold(0f64, |m, v| m.max(v.abs())).max(1e-9);
        let mut seed = 12345u32;
        y.iter()
            .map(|v| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let noise = (seed as f64 / u32::MAX as f64 - 0.5) * 0.007;
                (v / peak * 0.3 + noise) as f32
            })
            .collect()
    }

    /// Speech ranges in frames by Silero's own rules (the app's speechFromProbs): starts at
    /// p >= 0.5, holds while p >= 0.35, speech under 250 ms dropped; silences of up to `bridge`
    /// frames joined.
    fn ranges(p: &[f32], bridge: usize) -> Vec<(usize, usize)> {
        let mut raw: Vec<(usize, usize)> = Vec::new();
        let mut on: Option<usize> = None;
        for (i, v) in p.iter().enumerate() {
            match on {
                None if *v >= 0.5 => on = Some(i),
                Some(s) if *v < 0.35 => {
                    raw.push((s, i));
                    on = None
                }
                _ => {}
            }
        }
        if let Some(s) = on {
            raw.push((s, p.len()));
        }
        let mut out: Vec<(usize, usize)> = Vec::new();
        for r in raw {
            match out.last_mut() {
                Some(l) if r.0 - l.1 <= bridge => l.1 = r.1,
                _ => out.push(r),
            }
        }
        out.retain(|r| r.1 - r.0 >= 8);
        out
    }

    /// whisper.cpp resets Silero's recurrent state at the start of every call, and that state
    /// never quite converges to the one of a longer run (probabilities stay 0.05-0.3 apart near
    /// onsets for many seconds), so windowed probabilities cannot equal whole-buffer ones within
    /// 0.02. What the app uses them for must agree: the speech it hears (frame decisions), and
    /// the ranges once pauses shorter than its 0.5 s join (ACTIVITY.hold) are joined, within
    /// 5 frames (160 ms). A short dip can split a range in one run and not in the other.
    #[test]
    fn windowed_probabilities_give_the_whole_buffers_speech_ranges() {
        let model = VadModel::open(&vad_model(), 1).unwrap();
        let pcm = synthetic_voice(40.0);
        let whole = model.detect(&pcm).unwrap();
        // 10 s windows with 2 s of overlap (the shipped ones are 300 s).
        let (stitched, n) = windowed_slice(&pcm, 313, 63, |p| model.detect(p)).unwrap();
        assert_eq!(n as usize, pcm.len());
        assert_eq!(stitched.len(), whole.len());
        // The first window is the same computation.
        assert_eq!(stitched[..250], whole[..250]);
        let (a, b) = (ranges(&stitched, 15), ranges(&whole, 15));
        assert!(b.len() >= 4, "the synthetic voice must look like speech: {b:?}");
        assert_eq!(a.len(), b.len(), "{a:?}\n{b:?}");
        for (x, y) in a.iter().zip(&b) {
            assert!(x.0.abs_diff(y.0) <= 5 && x.1.abs_diff(y.1) <= 5, "{x:?} against {y:?}");
        }
        let decided = |r: &[(usize, usize)], i: usize| r.iter().any(|x| x.0 <= i && i < x.1);
        let (fa, fb) = (ranges(&stitched, 3), ranges(&whole, 3));
        let agree = (0..whole.len()).filter(|i| decided(&fa, *i) == decided(&fb, *i)).count();
        assert!(agree * 100 >= whole.len() * 98, "{agree} of {} frames decided alike", whole.len());
        let close = stitched.iter().zip(&whole).filter(|(x, y)| (*x - *y).abs() <= 0.02).count();
        println!(
            "windowed: {agree} of {} frames decided alike, {close} probabilities within 0.02; ranges {a:?}",
            whole.len()
        );
    }

    #[test]
    fn the_model_loads_from_a_non_ascii_folder_and_a_cut_copy_is_rejected() {
        let dir = temp_dir("vad").join("modèle-тест");
        std::fs::create_dir_all(&dir).unwrap();
        let copy = dir.join("ggml-silero-v6.2.0.bin");
        std::fs::copy(vad_model(), &copy).unwrap();
        let m = VadModel::open(&copy, 1).unwrap();
        assert_eq!(m.detect(&vec![0.0; 16000]).unwrap().len(), 32);
        let bytes = std::fs::read(&copy).unwrap();
        let cut = dir.join("cut.bin");
        std::fs::write(&cut, &bytes[..bytes.len() / 2]).unwrap();
        assert_eq!(VadModel::open(&cut, 1).err().unwrap().code, Code::Model);
        std::fs::write(&cut, &bytes[..bytes.len() - 10]).unwrap();
        assert_eq!(VadModel::open(&cut, 1).err().unwrap().code, Code::Model);
        assert_eq!(VadModel::open(&dir.join("missing.bin"), 1).err().unwrap().code, Code::Model);
        // Beside a Whisper model, error `model` would send the app after the wrong file.
        for bad in [cut.clone(), dir.join("missing.bin")] {
            let f = VadModel::open_beside_whisper(&bad, 1).err().unwrap();
            assert_eq!(f.code, Code::Args, "{bad:?}");
            assert!(f.message.starts_with("--vad-model is not a usable speech detector model ("), "{}", f.message);
        }
        assert!(VadModel::open_beside_whisper(&copy, 1).is_ok());
    }
}
