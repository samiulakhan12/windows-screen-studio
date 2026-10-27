//! Language with `--lang auto` (§2.5): detected once, after the speech detector and the chunk
//! plan, on the first chunk that holds at least SIDECAR.detectMinSpeech (10 s) of speech, else on
//! the chunk with the most speech; every chunk is then transcribed with that language. The
//! result reports the seconds of speech the detection heard (`language_s`), so the app carries a
//! language to later parts only from a part where it was heard well.

use std::ffi::CStr;

use whisper_rs_sys as sys;

use crate::chunks::speech_in;
use crate::protocol::{Code, Failure};

/// SIDECAR.detectMinSpeech.
pub const DETECT_MIN_SPEECH: f64 = 10.0;

/// The chunk to detect the language on and the seconds of speech in it; None without speech.
pub fn detection_chunk(chunks: &[(f64, f64)], speech: &[(f64, f64)]) -> Option<(usize, f64)> {
    let heard: Vec<f64> = chunks.iter().map(|&(a, b)| speech_in(speech, a, b)).collect();
    if let Some(i) = heard.iter().position(|s| *s >= DETECT_MIN_SPEECH) {
        return Some((i, heard[i]));
    }
    let mut best: Option<(usize, f64)> = None;
    for (i, s) in heard.iter().enumerate() {
        if *s > 0.0 && best.is_none_or(|(_, b)| *s > b) {
            best = Some((i, *s));
        }
    }
    best
}

/// Whether the model knows `code` ("en", "de"...).
pub fn known(code: &str) -> bool {
    match std::ffi::CString::new(code) {
        Ok(c) => (unsafe { sys::whisper_lang_id(c.as_ptr()) }) >= 0,
        Err(_) => false,
    }
}

/// Detects the language of `pcm` (one chunk): one mel and one encoder pass, which cannot be
/// aborted.
pub fn detect(
    ctx: *mut sys::whisper_context,
    st: *mut sys::whisper_state,
    pcm: &[f32],
    threads: i32,
) -> Result<String, Failure> {
    let rc = unsafe { sys::whisper_pcm_to_mel_with_state(ctx, st, pcm.as_ptr(), pcm.len() as i32, threads) };
    if rc != 0 {
        return Err(Failure::new(Code::Internal, format!("cannot compute the features for language detection ({rc})")));
    }
    let id = unsafe { sys::whisper_lang_auto_detect_with_state(ctx, st, 0, threads, std::ptr::null_mut()) };
    if id < 0 {
        return Err(Failure::new(Code::Internal, format!("language detection failed ({id})")));
    }
    let p = unsafe { sys::whisper_lang_str(id) };
    if p.is_null() {
        return Err(Failure::new(Code::Internal, "language detection gave an unknown language"));
    }
    Ok(unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_first_chunk_with_ten_seconds_of_speech() {
        // A 1.5 s opening "OK", then a long chunk of talking, then another long one.
        let speech = [(0.2, 1.7), (40.0, 52.0), (60.0, 80.0)];
        let chunks = [(0.0, 2.0), (39.75, 53.0), (59.75, 80.25)];
        assert_eq!(detection_chunk(&chunks, &speech).map(|(i, s)| (i, (s * 1000.0).round())), Some((1, 12000.0)));
    }

    #[test]
    fn otherwise_takes_the_chunk_with_the_most_speech() {
        let speech = [(0.2, 1.7), (10.0, 14.0), (20.0, 26.0), (30.0, 32.0)];
        let chunks = [(0.0, 2.0), (9.75, 14.25), (19.75, 26.25), (29.75, 32.25)];
        let (i, s) = detection_chunk(&chunks, &speech).unwrap();
        assert_eq!(i, 2);
        assert!((s - 6.0).abs() < 1e-9);
        // The 1.5 s opening is never chosen while there is more elsewhere.
        assert_ne!(detection_chunk(&chunks[..2], &speech[..2]).unwrap().0, 0);
        // Only the opening: it is all there is.
        assert_eq!(detection_chunk(&chunks[..1], &speech[..1]).unwrap().0, 0);
    }

    #[test]
    fn no_speech_means_no_detection() {
        assert_eq!(detection_chunk(&[], &[]), None);
        assert_eq!(detection_chunk(&[(0.0, 5.0)], &[]), None);
    }

    #[test]
    fn knows_whispers_language_codes() {
        assert!(known("en") && known("de") && known("haw"));
        assert!(!known("xx") && !known("") && !known("auto"));
    }
}
