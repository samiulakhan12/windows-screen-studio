//! The helper's side of the frozen protocol (src/shared/speech/protocol.ts,
//! docs/design/offline-captions.md §5.2): one JSON object per line on stdout, UTF-8, times in
//! seconds with three decimals. Every line goes through `emit`, which also feeds the heartbeat.

use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// SIDECAR.heartbeat: while `transcribe` works, a line at least this often.
pub const HEARTBEAT: Duration = Duration::from_secs(15);
/// SIDECAR.lineMax: no line may be longer (the app kills a helper that prints one).
pub const LINE_MAX: usize = 1 << 20;

/// Exit codes (SIDECAR.exit).
pub const EXIT_ERROR: i32 = 1;
pub const EXIT_CANCELLED: i32 = 2;

/// Error codes of `{"type":"error"}` lines (SidecarErrorCode).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    Args,
    Model,
    Audio,
    Language,
    Memory,
    Cpu,
    Internal,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::Args => "args",
            Code::Model => "model",
            Code::Audio => "audio",
            Code::Language => "language",
            Code::Memory => "memory",
            Code::Cpu => "cpu",
            Code::Internal => "internal",
        }
    }
}

/// A failure that ends the run with an error line and exit code 1.
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub code: Code,
    pub message: String,
}

impl Failure {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Failure { code, message: message.into() }
    }
}

/// A JSON string literal. Control characters are escaped; the input is already valid UTF-8
/// (bytes from the engine are decoded lossily before they get here).
pub fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            // U+2028/2029 are valid JSON but break some line-oriented readers.
            c if (c as u32) < 0x20 || c == '\u{7f}' || c == '\u{2028}' || c == '\u{2029}' => {
                o.push_str(&format!("\\u{:04x}", c as u32))
            }
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Bytes as text: invalid UTF-8 (a code point split by the tokenizer and never completed)
/// becomes U+FFFD instead of breaking the line.
pub fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// A number with three decimals; never NaN or Infinity (the reader rejects those), so a value
/// that is not finite is written as 0.
pub fn num(v: f64) -> String {
    if v.is_finite() {
        let s = format!("{:.3}", v);
        if s == "-0.000" {
            "0.000".into()
        } else {
            s
        }
    } else {
        "0.000".into()
    }
}

/// Base64 (standard alphabet, padded).
pub fn base64(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut o = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        o.push(A[(n >> 18) as usize & 63] as char);
        o.push(A[(n >> 12) as usize & 63] as char);
        o.push(if c.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
        o.push(if c.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    o
}

/// The latest progress, for the heartbeat; and when the last line was printed.
struct Out {
    last_line: Instant,
    percent: i32,
    at: f64,
    /// The last line (result or error) is out: nothing may follow it.
    closed: bool,
    /// Seconds of audio whose segment lines are all out (for a `cancelled` line).
    done_until: f64,
}

const FRESH: fn() -> Out = || Out { last_line: Instant::now(), percent: 0, at: 0.0, closed: false, done_until: 0.0 };

static OUT: Mutex<Option<Out>> = Mutex::new(None);

fn out() -> std::sync::MutexGuard<'static, Option<Out>> {
    OUT.lock().unwrap_or_else(|e| e.into_inner())
}

fn write_line(line: &str) {
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    if lock.write_all(line.as_bytes()).and_then(|_| lock.write_all(b"\n")).and_then(|_| lock.flush()).is_err() {
        hard_exit(EXIT_ERROR);
    }
}

/// Prints one line. Lines, the heartbeat and a cancel share one lock, so they never interleave,
/// and nothing is printed after the last line. A stdout that cannot be written (the app is gone)
/// ends the helper.
pub fn emit(line: &str) {
    let mut g = out();
    let s = g.get_or_insert_with(FRESH);
    if s.closed {
        return;
    }
    s.last_line = Instant::now();
    write_line(line);
}

/// Prints the run's last line (`result` or `error`): a cancel or a heartbeat after it is ignored.
pub fn last(line: &str) {
    let mut g = out();
    let s = g.get_or_insert_with(FRESH);
    if s.closed {
        return;
    }
    write_line(line);
    s.closed = true;
}

/// Records that the segment lines up to `t` seconds of the audio are out.
pub fn note_done_until(t: f64) {
    out().get_or_insert_with(FRESH).done_until = t;
}

extern "C" {
    /// The C runtime's _exit (glibc and msvcrt): ends the process without running atexit
    /// handlers or C++ static destructors, which must not run while engine threads still compute.
    fn _exit(code: i32) -> !;
}

/// Ends the process now, from any thread (stdout is flushed after every line).
pub fn hard_exit(code: i32) -> ! {
    unsafe { _exit(code) }
}

/// Records the progress the heartbeat repeats (without printing).
pub fn note_progress(percent: i32, at: f64) {
    let mut g = out();
    let s = g.get_or_insert_with(FRESH);
    s.percent = percent;
    s.at = at;
}

pub fn progress_line(percent: i32, at: f64) -> String {
    format!("{{\"type\":\"progress\",\"percent\":{},\"at\":{}}}", percent.clamp(0, 100), num(at))
}

/// Prints a progress line and remembers it for the heartbeat.
pub fn progress(percent: i32, at: f64) {
    note_progress(percent, at);
    emit(&progress_line(percent, at));
}

/// Whether the heartbeat must print now: `HEARTBEAT` passed since the last line.
pub fn heartbeat_due(last_line: Instant, now: Instant) -> bool {
    now.saturating_duration_since(last_line) >= HEARTBEAT
}

/// The heartbeat thread of `transcribe` (§3.4): whisper.cpp reports progress only at the top of
/// each 30 s window and language detection reports nothing, so this repeats the latest progress
/// whenever 15 s passed without a line. Checked twice a second.
pub fn start_heartbeat() {
    {
        let mut g = out();
        let s = g.get_or_insert_with(FRESH);
        s.last_line = Instant::now();
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(500));
        let due = {
            let g = out();
            g.as_ref().and_then(|s| heartbeat_due(s.last_line, Instant::now()).then_some((s.percent, s.at)))
        };
        if let Some((p, at)) = due {
            emit(&progress_line(p, at));
        }
    });
}

pub fn error_line(f: &Failure) -> String {
    format!("{{\"type\":\"error\",\"code\":\"{}\",\"message\":{}}}", f.code.as_str(), esc(&f.message))
}

/// Prints the error line and exits with code 1.
pub fn fail(f: Failure) -> ! {
    last(&error_line(&f));
    hard_exit(EXIT_ERROR);
}

/// Cancels the run at once, from the control thread or a checkpoint: prints the `cancelled` line
/// (with the end of the audio whose segment lines are out) and exits with code 2. The helper
/// writes no files, so nothing is left half done; whisper.cpp checks its abort flag only between
/// encoder passes (about a second each on a slow processor) and never during language detection.
/// Does nothing after the last line: a run that has ended is not cancelled.
pub fn cancel_now() {
    let mut g = out();
    let s = g.get_or_insert_with(FRESH);
    if s.closed {
        return;
    }
    write_line(&format!("{{\"type\":\"cancelled\",\"done_until\":{}}}", num(s.done_until)));
    s.closed = true;
    hard_exit(EXIT_CANCELLED);
}

/// A word of a `segment` line.
#[derive(Clone, Debug, PartialEq)]
pub struct Word {
    pub text: String,
    pub start: f64,
    pub end: f64,
    pub prob: f64,
}

/// A segment of a chunk, with its words (seconds from the start of the audio).
#[derive(Clone, Debug, PartialEq)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub words: Vec<Word>,
}

pub fn segment_line(s: &Segment) -> String {
    let words: Vec<String> = s
        .words
        .iter()
        .map(|w| {
            format!(
                "{{\"text\":{},\"start\":{},\"end\":{},\"prob\":{}}}",
                esc(&w.text),
                num(w.start),
                num(w.end),
                num(w.prob.clamp(0.0, 1.0))
            )
        })
        .collect();
    format!(
        "{{\"type\":\"segment\",\"start\":{},\"end\":{},\"text\":{},\"words\":[{}]}}",
        num(s.start),
        num(s.end),
        esc(&s.text),
        words.join(",")
    )
}

pub fn speech_line(ranges: &[(f64, f64)]) -> String {
    let list: Vec<String> = ranges.iter().map(|(s, e)| format!("[{},{}]", num(*s), num(*e))).collect();
    format!("{{\"type\":\"speech\",\"segments\":[{}]}}", list.join(","))
}

/// `vad`: one byte per 32 ms frame, probability × 255 rounded.
pub fn vad_line(audio_s: f64, probs: &[f32], detect_ms: f64) -> String {
    let bytes: Vec<u8> = probs.iter().map(|p| (p.clamp(0.0, 1.0) * 255.0).round() as u8).collect();
    format!(
        "{{\"type\":\"vad\",\"audio_s\":{},\"frame\":0.032,\"n\":{},\"probs\":\"{}\",\"detect_ms\":{}}}",
        num(audio_s),
        bytes.len(),
        base64(&bytes),
        num(detect_ms)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testjson::{parse, Json};

    #[test]
    fn escapes_control_characters_and_round_trips() {
        let s = "a\"b\\c\nd\re\tf\u{1}g\u{1f}h\u{7f}i\u{2028}j é ж 🎤";
        let line = esc(s);
        assert!(!line.chars().any(|c| (c as u32) < 0x20));
        assert_eq!(parse(&line).unwrap(), Json::Str(s.into()));
    }

    #[test]
    fn decodes_split_code_points_lossily() {
        // "é" is C3 A9; a token boundary that never completes leaves C3 alone.
        let mut b = b"caf".to_vec();
        b.push(0xC3);
        b.extend_from_slice(b" ok");
        let t = lossy(&b);
        assert_eq!(t, "caf\u{FFFD} ok");
        assert!(parse(&esc(&t)).is_ok());
        // Joined before decoding, the two halves make the letter.
        assert_eq!(lossy(&[b'c', b'a', b'f', 0xC3, 0xA9]), "café");
    }

    #[test]
    fn numbers_are_finite_with_three_decimals() {
        assert_eq!(num(1.23456), "1.235");
        assert_eq!(num(f64::NAN), "0.000");
        assert_eq!(num(f64::INFINITY), "0.000");
        assert_eq!(num(-0.0001), "0.000");
    }

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(&[0, 255, 128, 7]), "AP+ABw==");
    }

    #[test]
    fn lines_have_exactly_the_protocol_fields() {
        let seg = Segment {
            start: 1.0,
            end: 2.5,
            text: "Hi, \"you\"".into(),
            words: vec![Word { text: "Hi,".into(), start: 1.0, end: 1.4, prob: 0.9 }],
        };
        let v = parse(&segment_line(&seg)).unwrap();
        assert_eq!(v.keys(), vec!["end", "start", "text", "type", "words"]);
        assert_eq!(v.get("words").unwrap().idx(0).unwrap().keys(), vec!["end", "prob", "start", "text"]);
        let v = parse(&vad_line(1.0, &[0.0, 1.0, 0.5], 2.0)).unwrap();
        assert_eq!(v.get("probs").unwrap(), &Json::Str("AP+A".into()));
        assert_eq!(v.get("n").unwrap(), &Json::Num(3.0));
        let v = parse(&error_line(&Failure::new(Code::Model, "bad\nfile"))).unwrap();
        assert_eq!(v.get("code").unwrap(), &Json::Str("model".into()));
        let v = parse(&speech_line(&[(0.25, 1.5)])).unwrap();
        assert_eq!(v.keys(), vec!["segments", "type"]);
        assert_eq!(parse(&progress_line(150, 3.0)).unwrap().get("percent").unwrap(), &Json::Num(100.0));
    }

    #[test]
    fn heartbeat_fires_after_15_s_without_a_line_and_not_while_lines_flow() {
        let t0 = Instant::now();
        // Lines every 5 s: never due.
        let mut last = t0;
        for k in 1..=10u64 {
            let now = t0 + Duration::from_secs(5 * k);
            assert!(!heartbeat_due(last, now - Duration::from_millis(1)));
            last = now;
        }
        // Then silence: due once 15 s passed, and not a moment before.
        assert!(!heartbeat_due(last, last + Duration::from_millis(14_999)));
        assert!(heartbeat_due(last, last + HEARTBEAT));
        // A line (the heartbeat's own) resets it.
        let hb = last + HEARTBEAT;
        assert!(!heartbeat_due(hb, hb + Duration::from_secs(10)));
        assert!(heartbeat_due(hb, hb + Duration::from_secs(16)));
        // A clock that went backwards is never due.
        assert!(!heartbeat_due(hb, t0));
    }
}
