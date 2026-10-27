//! ssw-speech (starting point: the offline-captions spike): offline transcription with word timings (whisper.cpp + DTW) and Silero VAD,
//! as a small sidecar that speaks JSON lines on stdout.
//!
//!   ssw-speech info       --model <ggml.bin>
//!   ssw-speech vad        --vad-model <silero.bin> --audio <wav|-> [--threads N] [--threshold F]
//!                          [--min-speech-ms N] [--min-silence-ms N] [--pad-ms N] [--repeat N]
//!   ssw-speech transcribe --model <ggml.bin> --audio <wav|-> [--vad-model <silero.bin>]
//!                          [--lang auto|en|..] [--threads N] [--dtw auto|off|<preset>] [--beam N]
//!                          [--prompt TEXT] [--start SEC] [--legacy-ts] [--tokens]
//!                          [--stdin-control] [--low-priority] [--verbose]
//!
//! Audio: a 16 kHz WAV (PCM 16-bit or float 32-bit; channels are averaged), or `-` for raw
//! little-endian f32 mono 16 kHz on stdin. With --stdin-control (audio from a file) stdin is the
//! control channel: a line "cancel" or end of file stops the work at the next checkpoint, so the
//! sidecar also stops when its parent dies.
//!
//! Times in the output are seconds from the start of the audio.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::io::{BufRead, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use whisper_rs_sys as sys;

static ABORT: AtomicBool = AtomicBool::new(false);
static VERBOSE: AtomicBool = AtomicBool::new(false);
const SAMPLE_RATE: usize = 16_000;

// ---------------------------------------------------------------- JSON output

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn num(v: f64) -> String {
    if v.is_finite() {
        format!("{:.3}", v)
    } else {
        "null".into()
    }
}

fn emit(line: &str) {
    let out = std::io::stdout();
    let mut lock = out.lock();
    let _ = lock.write_all(line.as_bytes());
    let _ = lock.write_all(b"\n");
    let _ = lock.flush();
}

fn fail(msg: &str) -> ! {
    emit(&format!("{{\"type\":\"error\",\"message\":{}}}", esc(msg)));
    std::process::exit(1);
}

// ---------------------------------------------------------------- arguments

#[derive(Default)]
struct Args {
    cmd: String,
    model: Option<String>,
    audio: Option<String>,
    vad_model: Option<String>,
    lang: String,
    threads: i32,
    dtw: String,
    beam: i32,
    prompt: Option<String>,
    start: f64,
    legacy_ts: bool,
    tokens: bool,
    stdin_control: bool,
    low_priority: bool,
    threshold: f32,
    min_speech_ms: i32,
    min_silence_ms: i32,
    pad_ms: i32,
    max_chunk: f64,
    repeat: usize,
}

fn parse_args() -> Args {
    let mut a = Args {
        lang: "auto".into(),
        threads: 4,
        dtw: "auto".into(),
        beam: 0,
        threshold: 0.5,
        min_speech_ms: 250,
        min_silence_ms: 100,
        pad_ms: 30,
        max_chunk: 29.0,
        repeat: 1,
        ..Default::default()
    };
    let mut it = std::env::args().skip(1);
    a.cmd = it.next().unwrap_or_default();
    while let Some(k) = it.next() {
        let mut val = || it.next().unwrap_or_else(|| fail(&format!("{k} needs a value")));
        match k.as_str() {
            "--model" => a.model = Some(val()),
            "--audio" => a.audio = Some(val()),
            "--vad-model" => a.vad_model = Some(val()),
            "--lang" => a.lang = val(),
            "--threads" => a.threads = val().parse().unwrap_or_else(|_| fail("bad --threads")),
            "--dtw" => a.dtw = val(),
            "--beam" => a.beam = val().parse().unwrap_or_else(|_| fail("bad --beam")),
            "--prompt" => a.prompt = Some(val()),
            "--start" => a.start = val().parse().unwrap_or_else(|_| fail("bad --start")),
            "--threshold" => a.threshold = val().parse().unwrap_or_else(|_| fail("bad --threshold")),
            "--min-speech-ms" => a.min_speech_ms = val().parse().unwrap_or_else(|_| fail("bad --min-speech-ms")),
            "--min-silence-ms" => a.min_silence_ms = val().parse().unwrap_or_else(|_| fail("bad --min-silence-ms")),
            "--pad-ms" => a.pad_ms = val().parse().unwrap_or_else(|_| fail("bad --pad-ms")),
            "--max-chunk" => a.max_chunk = val().parse().unwrap_or_else(|_| fail("bad --max-chunk")),
            "--repeat" => a.repeat = val().parse().unwrap_or_else(|_| fail("bad --repeat")),
            "--legacy-ts" => a.legacy_ts = true,
            "--tokens" => a.tokens = true,
            "--stdin-control" => a.stdin_control = true,
            "--low-priority" => a.low_priority = true,
            "--verbose" => VERBOSE.store(true, Ordering::Relaxed),
            _ => fail(&format!("unknown argument {k}")),
        }
    }
    if !(1..=64).contains(&a.threads) {
        fail("--threads must be 1..64");
    }
    a
}

// ---------------------------------------------------------------- audio

fn read_audio(path: &str) -> Vec<f32> {
    let bytes = if path == "-" {
        let mut b = Vec::new();
        std::io::stdin().lock().read_to_end(&mut b).unwrap_or_else(|e| fail(&format!("stdin: {e}")));
        return b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    } else {
        std::fs::read(path).unwrap_or_else(|e| fail(&format!("cannot read {path}: {e}")))
    };
    parse_wav(&bytes).unwrap_or_else(|e| fail(&e))
}

fn parse_wav(b: &[u8]) -> Result<Vec<f32>, String> {
    let u16le = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]);
    let u32le = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err("not a WAV file".into());
    }
    let (mut fmt, mut channels, mut rate, mut bits) = (0u16, 0u16, 0u32, 0u16);
    let mut pos = 12;
    while pos + 8 <= b.len() {
        let id = &b[pos..pos + 4];
        let size = u32le(pos + 4) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= b.len() {
            fmt = u16le(body);
            channels = u16le(body + 2);
            rate = u32le(body + 4);
            bits = u16le(body + 14);
            if fmt == 0xFFFE && size >= 26 && body + 26 <= b.len() {
                fmt = u16le(body + 24); // WAVE_FORMAT_EXTENSIBLE: the sub-format's first two bytes
            }
        } else if id == b"data" {
            if channels == 0 {
                return Err("WAV data before fmt".into());
            }
            if rate as usize != SAMPLE_RATE {
                return Err(format!("WAV must be 16000 Hz (got {rate})"));
            }
            // A streamed WAV can carry 0 or 0xFFFFFFFF as the data size: read to the end.
            let end = if size == 0 || body + size > b.len() { b.len() } else { body + size };
            let data = &b[body..end];
            let ch = channels as usize;
            let frames: Vec<f32> = match (fmt, bits) {
                (1, 16) => data
                    .chunks_exact(2 * ch)
                    .map(|f| f.chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0).sum::<f32>() / ch as f32)
                    .collect(),
                (3, 32) => data
                    .chunks_exact(4 * ch)
                    .map(|f| f.chunks_exact(4).map(|s| f32::from_le_bytes([s[0], s[1], s[2], s[3]])).sum::<f32>() / ch as f32)
                    .collect(),
                _ => return Err(format!("unsupported WAV format {fmt}/{bits}-bit (use PCM 16-bit or float 32-bit)")),
            };
            return Ok(frames);
        }
        pos = body + size + (size & 1);
    }
    Err("WAV has no data chunk".into())
}

// ---------------------------------------------------------------- whisper.cpp glue

unsafe extern "C" fn log_cb(_level: sys::ggml_log_level, text: *const c_char, _ud: *mut c_void) {
    if VERBOSE.load(Ordering::Relaxed) && !text.is_null() {
        eprint!("{}", CStr::from_ptr(text).to_string_lossy());
    }
}

unsafe extern "C" fn abort_cb(_ud: *mut c_void) -> bool {
    ABORT.load(Ordering::Relaxed)
}

fn start_control_thread() {
    std::thread::spawn(|| {
        let stdin = std::io::stdin();
        let mut line = String::new();
        loop {
            line.clear();
            match stdin.lock().read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.trim() == "cancel" => break,
                Ok(_) => {}
            }
        }
        ABORT.store(true, Ordering::Relaxed);
    });
}

#[cfg(unix)]
fn lower_priority() {
    extern "C" {
        fn setpriority(which: c_int, who: u32, prio: c_int) -> c_int;
    }
    unsafe {
        setpriority(0 /* PRIO_PROCESS */, 0, 10);
    }
}

#[cfg(windows)]
fn lower_priority() {
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn SetPriorityClass(h: *mut c_void, class: u32) -> i32;
    }
    unsafe {
        SetPriorityClass(GetCurrentProcess(), 0x0000_4000 /* BELOW_NORMAL_PRIORITY_CLASS */);
    }
}

/// Model facts from the ggml header (magic, then 11 int32 hyper-parameters).
struct ModelInfo {
    kind: &'static str,
    english_only: bool,
    n_mels: i32,
    ftype: i32,
    preset: sys::whisper_alignment_heads_preset,
    preset_name: &'static str,
}

fn model_info(path: &str) -> ModelInfo {
    let mut f = std::fs::File::open(path).unwrap_or_else(|e| fail(&format!("cannot open model: {e}")));
    let mut h = [0u8; 48];
    f.read_exact(&mut h).unwrap_or_else(|_| fail("model file too short"));
    let i = |n: usize| i32::from_le_bytes([h[4 * n], h[4 * n + 1], h[4 * n + 2], h[4 * n + 3]]);
    if i(0) as u32 != 0x6767_6d6c {
        fail("not a ggml whisper model");
    }
    let (n_vocab, n_audio_layer, n_text_layer, n_mels, ftype) = (i(1), i(5), i(9), i(10), i(11));
    let en = n_vocab == 51864;
    use sys::*;
    let (kind, preset, name) = match (n_audio_layer, en) {
        (4, true) => ("tiny.en", whisper_alignment_heads_preset_WHISPER_AHEADS_TINY_EN, "tiny.en"),
        (4, false) => ("tiny", whisper_alignment_heads_preset_WHISPER_AHEADS_TINY, "tiny"),
        (6, true) => ("base.en", whisper_alignment_heads_preset_WHISPER_AHEADS_BASE_EN, "base.en"),
        (6, false) => ("base", whisper_alignment_heads_preset_WHISPER_AHEADS_BASE, "base"),
        (12, true) => ("small.en", whisper_alignment_heads_preset_WHISPER_AHEADS_SMALL_EN, "small.en"),
        (12, false) => ("small", whisper_alignment_heads_preset_WHISPER_AHEADS_SMALL, "small"),
        (24, true) => ("medium.en", whisper_alignment_heads_preset_WHISPER_AHEADS_MEDIUM_EN, "medium.en"),
        (24, false) => ("medium", whisper_alignment_heads_preset_WHISPER_AHEADS_MEDIUM, "medium"),
        (32, _) if n_text_layer == 4 => ("large-v3-turbo", whisper_alignment_heads_preset_WHISPER_AHEADS_LARGE_V3_TURBO, "large-v3-turbo"),
        (32, _) if n_mels == 128 => ("large-v3", whisper_alignment_heads_preset_WHISPER_AHEADS_LARGE_V3, "large-v3"),
        (32, _) => ("large-v2", whisper_alignment_heads_preset_WHISPER_AHEADS_LARGE_V2, "large-v2"),
        _ => ("unknown", whisper_alignment_heads_preset_WHISPER_AHEADS_NONE, "off"),
    };
    ModelInfo { kind, english_only: en, n_mels, ftype, preset, preset_name: name }
}

fn preset_by_name(name: &str, auto: &ModelInfo) -> (sys::whisper_alignment_heads_preset, &'static str) {
    use sys::*;
    match name {
        "auto" => (auto.preset, auto.preset_name),
        "off" => (whisper_alignment_heads_preset_WHISPER_AHEADS_NONE, "off"),
        "tiny.en" => (whisper_alignment_heads_preset_WHISPER_AHEADS_TINY_EN, "tiny.en"),
        "tiny" => (whisper_alignment_heads_preset_WHISPER_AHEADS_TINY, "tiny"),
        "base.en" => (whisper_alignment_heads_preset_WHISPER_AHEADS_BASE_EN, "base.en"),
        "base" => (whisper_alignment_heads_preset_WHISPER_AHEADS_BASE, "base"),
        "small.en" => (whisper_alignment_heads_preset_WHISPER_AHEADS_SMALL_EN, "small.en"),
        "small" => (whisper_alignment_heads_preset_WHISPER_AHEADS_SMALL, "small"),
        "large-v3-turbo" => (whisper_alignment_heads_preset_WHISPER_AHEADS_LARGE_V3_TURBO, "large-v3-turbo"),
        "large-v3" => (whisper_alignment_heads_preset_WHISPER_AHEADS_LARGE_V3, "large-v3"),
        _ => fail(&format!("unknown --dtw preset {name}")),
    }
}

// ---------------------------------------------------------------- VAD

struct Vad(*mut sys::whisper_vad_context);
impl Drop for Vad {
    fn drop(&mut self) {
        unsafe { sys::whisper_vad_free(self.0) }
    }
}

fn vad_open(path: &str, threads: i32) -> Vad {
    let p = CString::new(path).unwrap_or_else(|_| fail("bad path"));
    let mut cp = unsafe { sys::whisper_vad_default_context_params() };
    cp.n_threads = threads;
    cp.use_gpu = false;
    let ctx = unsafe { sys::whisper_vad_init_from_file_with_params(p.as_ptr(), cp) };
    if ctx.is_null() {
        fail("cannot load the VAD model");
    }
    Vad(ctx)
}

fn vad_params(a: &Args) -> sys::whisper_vad_params {
    let mut p = unsafe { sys::whisper_vad_default_params() };
    p.threshold = a.threshold;
    p.min_speech_duration_ms = a.min_speech_ms;
    p.min_silence_duration_ms = a.min_silence_ms;
    p.speech_pad_ms = a.pad_ms;
    p
}

/// Speech ranges in seconds, and the time spent on the network vs. the post-processing.
fn vad_segments(v: &Vad, p: sys::whisper_vad_params, pcm: &[f32]) -> (Vec<(f64, f64)>, f64, f64) {
    let t0 = Instant::now();
    if !unsafe { sys::whisper_vad_detect_speech(v.0, pcm.as_ptr(), pcm.len() as c_int) } {
        fail("VAD failed");
    }
    let net_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let t1 = Instant::now();
    let segs = unsafe { sys::whisper_vad_segments_from_probs(v.0, p) };
    if segs.is_null() {
        fail("VAD segments failed");
    }
    let n = unsafe { sys::whisper_vad_segments_n_segments(segs) };
    // whisper.cpp reports VAD segment times in centiseconds.
    let out = (0..n)
        .map(|i| unsafe {
            (
                sys::whisper_vad_segments_get_segment_t0(segs, i) as f64 / 100.0,
                sys::whisper_vad_segments_get_segment_t1(segs, i) as f64 / 100.0,
            )
        })
        .collect();
    unsafe { sys::whisper_vad_free_segments(segs) };
    (out, net_ms, t1.elapsed().as_secs_f64() * 1000.0)
}

fn cmd_vad(a: &Args) {
    let path = a.vad_model.as_deref().unwrap_or_else(|| fail("--vad-model is required"));
    let mut pcm = read_audio(a.audio.as_deref().unwrap_or_else(|| fail("--audio is required")));
    if a.repeat > 1 {
        let one = pcm.clone();
        for _ in 1..a.repeat {
            pcm.extend_from_slice(&one);
        }
    }
    let tl = Instant::now();
    let v = vad_open(path, a.threads);
    let load_ms = tl.elapsed().as_secs_f64() * 1000.0;
    let (segs, net_ms, post_ms) = vad_segments(&v, vad_params(a), &pcm);
    let n_probs = unsafe { sys::whisper_vad_n_probs(v.0) };
    let audio_s = pcm.len() as f64 / SAMPLE_RATE as f64;
    let speech: f64 = segs.iter().map(|(s, e)| e - s).sum();
    let list: Vec<String> = segs.iter().map(|(s, e)| format!("[{},{}]", num(*s), num(*e))).collect();
    emit(&format!(
        "{{\"type\":\"vad\",\"audio_s\":{},\"speech_s\":{},\"n_probs\":{},\"load_ms\":{},\"detect_ms\":{},\"segments_ms\":{},\"x_realtime\":{},\"segments\":[{}]}}",
        num(audio_s),
        num(speech),
        n_probs,
        num(load_ms),
        num(net_ms),
        num(post_ms),
        num(audio_s * 1000.0 / (net_ms + post_ms)),
        list.join(",")
    ));
}

// ---------------------------------------------------------------- transcription

struct Word {
    text: String,
    start: f64,
    end: f64,
    prob: f64,
    legacy: (f64, f64),
}

struct Segment {
    start: f64,
    end: f64,
    text: String,
    words: Vec<Word>,
}

struct Progress {
    chunk_start: f64,
    chunk_len: f64,
    done: f64,
    total: f64,
    last: i32,
}

unsafe extern "C" fn progress_cb(_c: *mut sys::whisper_context, _s: *mut sys::whisper_state, pct: c_int, ud: *mut c_void) {
    let p = &mut *(ud as *mut Progress);
    let overall = ((p.done + p.chunk_len * pct as f64 / 100.0) / p.total.max(1e-9) * 100.0).floor() as i32;
    if overall > p.last {
        p.last = overall;
        emit(&format!("{{\"type\":\"progress\",\"percent\":{},\"at\":{}}}", overall.min(100), num(p.chunk_start + p.chunk_len * pct as f64 / 100.0)));
    }
}

/// Raw token bytes as whisper stores them (a token can hold part of a UTF-8 sequence).
unsafe fn token_bytes(ctx: *mut sys::whisper_context, id: sys::whisper_token) -> Vec<u8> {
    let p = sys::whisper_token_to_str(ctx, id);
    if p.is_null() {
        Vec::new()
    } else {
        CStr::from_ptr(p).to_bytes().to_vec()
    }
}

/// Words of the segments whisper produced for one chunk. DTW gives each text token the moment it was
/// emitted (about the END of the token), so a word ends at its last token's DTW time and starts where
/// the previous word ended (or at the segment start); a start after a pause is pulled in to at most
/// `max_word` seconds before the end.
unsafe fn collect(ctx: *mut sys::whisper_context, st: *mut sys::whisper_state, offset: f64, use_dtw: bool, tokens_out: bool) -> Vec<Segment> {
    let eot = sys::whisper_token_eot(ctx);
    let n = sys::whisper_full_n_segments_from_state(st);
    let mut segs = Vec::new();
    let mut prev_end = f64::NEG_INFINITY;
    for i in 0..n {
        let s0 = sys::whisper_full_get_segment_t0_from_state(st, i) as f64 / 100.0 + offset;
        let s1 = sys::whisper_full_get_segment_t1_from_state(st, i) as f64 / 100.0 + offset;
        let text = CStr::from_ptr(sys::whisper_full_get_segment_text_from_state(st, i)).to_string_lossy().trim().to_string();
        struct Acc {
            bytes: Vec<u8>,
            end: f64,
            probs: Vec<f32>,
            l0: f64,
            l1: f64,
        }
        let mut raw: Vec<Acc> = Vec::new();
        let nt = sys::whisper_full_n_tokens_from_state(st, i);
        for j in 0..nt {
            let d = sys::whisper_full_get_token_data_from_state(st, i, j);
            if d.id >= eot {
                continue;
            }
            let b = token_bytes(ctx, d.id);
            if tokens_out {
                eprintln!(
                    "tok seg={i} {:>8} dtw={:>7.2} t0={:>7.2} t1={:>7.2} p={:.2}",
                    format!("{:?}", String::from_utf8_lossy(&b)),
                    d.t_dtw as f64 / 100.0 + offset,
                    d.t0 as f64 / 100.0 + offset,
                    d.t1 as f64 / 100.0 + offset,
                    d.p
                );
            }
            let new_word = raw.is_empty() || b.first() == Some(&b' ');
            if new_word {
                raw.push(Acc { bytes: Vec::new(), end: 0.0, probs: Vec::new(), l0: d.t0 as f64 / 100.0 + offset, l1: 0.0 });
            }
            let w = raw.last_mut().unwrap();
            w.bytes.extend_from_slice(&b);
            // A trailing "." or "," is emitted late; the word ends with its last letter or digit.
            if w.end == 0.0 || b.iter().any(|c| c.is_ascii_alphanumeric() || *c >= 0x80) {
                w.end = d.t_dtw as f64 / 100.0 + offset;
            }
            w.l1 = d.t1 as f64 / 100.0 + offset;
            w.probs.push(d.p);
        }
        let mut words = Vec::new();
        for (k, w) in raw.into_iter().enumerate() {
            let t = String::from_utf8_lossy(&w.bytes).trim().to_string();
            if t.is_empty() {
                continue;
            }
            let prob = w.probs.iter().map(|p| *p as f64).sum::<f64>() / w.probs.len().max(1) as f64;
            let (start, end) = if use_dtw {
                let end = w.end.clamp(s0, s1.max(s0));
                let start = if k == 0 { s0.max(prev_end) } else { prev_end.max(s0) };
                (start.min(end), end)
            } else {
                (w.l0, w.l1)
            };
            words.push(Word { text: t, start, end, prob, legacy: (w.l0, w.l1) });
            prev_end = end;
        }
        segs.push(Segment { start: s0, end: s1, text, words });
    }
    segs
}

/// Pull in the starts of words that swallowed a pause: at most twice the median word length
/// (capped at 0.7 s like the reference implementation), and never before the previous word's end.
fn tidy(segs: &mut [Segment], speech: Option<&[(f64, f64)]>) {
    let mut durs: Vec<f64> = segs.iter().flat_map(|s| s.words.iter().map(|w| w.end - w.start)).filter(|d| *d > 0.0).collect();
    if durs.is_empty() {
        return;
    }
    durs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = durs[durs.len() / 2].min(0.7);
    let max_word = (median * 2.0).max(0.3);
    let mut last_end = f64::NEG_INFINITY;
    for s in segs.iter_mut() {
        for w in s.words.iter_mut() {
            if w.end - w.start > max_word {
                w.start = w.end - max_word;
            }
            // Speech that resumes inside the word (VAD onset after a pause): the word starts there.
            if let Some(sp) = speech {
                if let Some(on) = sp.iter().map(|r| r.0).filter(|on| *on > w.start && *on < w.end - 0.05).last() {
                    w.start = on;
                }
            }
            if w.start < last_end {
                w.start = last_end;
            }
            if w.end < w.start {
                w.end = w.start;
            }
            last_end = w.end;
        }
        if let (Some(f), Some(l)) = (s.words.first(), s.words.last()) {
            s.start = f.start;
            s.end = s.end.max(l.end);
        }
    }
}

fn word_json(w: &Word, legacy: bool) -> String {
    let mut s = format!(
        "{{\"text\":{},\"start\":{},\"end\":{},\"prob\":{}",
        esc(&w.text),
        num(w.start),
        num(w.end),
        format!("{:.3}", w.prob)
    );
    if legacy {
        s.push_str(&format!(",\"legacy\":[{},{}]", num(w.legacy.0), num(w.legacy.1)));
    }
    s.push('}');
    s
}

/// Chunks (start, end) in seconds: whole audio without VAD; with VAD, speech ranges packed into
/// windows of at most `max_chunk` seconds (whisper encodes 30 s windows), split in the silences.
fn plan_chunks(speech: Option<&[(f64, f64)]>, audio_s: f64, from: f64, max_chunk: f64) -> Vec<(f64, f64)> {
    let Some(speech) = speech else {
        return vec![(from.min(audio_s), audio_s)];
    };
    let mut out: Vec<(f64, f64)> = Vec::new();
    for &(s, e) in speech.iter().filter(|(_, e)| *e > from) {
        let s = s.max(from);
        match out.last_mut() {
            Some(c) if e - c.0 <= max_chunk => c.1 = e,
            _ => out.push((s, e)),
        }
    }
    // A little context on both sides, without reaching into the neighbours.
    let pad = 0.25;
    let n = out.len();
    let mut padded = out.clone();
    for i in 0..n {
        let lo = if i > 0 { (out[i - 1].1 + out[i].0) / 2.0 } else { 0.0 };
        let hi = if i + 1 < n { (out[i].1 + out[i + 1].0) / 2.0 } else { audio_s };
        padded[i] = ((out[i].0 - pad).max(lo).max(0.0), (out[i].1 + pad).min(hi).min(audio_s));
    }
    padded
}

fn cmd_transcribe(a: &Args) {
    let model = a.model.as_deref().unwrap_or_else(|| fail("--model is required"));
    let audio = a.audio.as_deref().unwrap_or_else(|| fail("--audio is required"));
    if a.stdin_control && audio != "-" {
        start_control_thread();
    }
    if a.low_priority {
        lower_priority();
    }
    let info = model_info(model);
    let (preset, preset_name) = preset_by_name(&a.dtw, &info);
    let use_dtw = preset != sys::whisper_alignment_heads_preset_WHISPER_AHEADS_NONE;
    let lang = if info.english_only { "en".to_string() } else { a.lang.clone() };

    let t_read = Instant::now();
    let pcm = read_audio(audio);
    let read_ms = t_read.elapsed().as_secs_f64() * 1000.0;
    let audio_s = pcm.len() as f64 / SAMPLE_RATE as f64;

    let t_load = Instant::now();
    let mpath = CString::new(model).unwrap_or_else(|_| fail("bad path"));
    let mut cp = unsafe { sys::whisper_context_default_params() };
    cp.use_gpu = false;
    cp.flash_attn = false; // DTW needs the attention weights; whisper.cpp turns DTW off with flash attention
    cp.dtw_token_timestamps = use_dtw;
    cp.dtw_aheads_preset = preset;
    // _no_state: the plain variant also allocates a default state (a second set of KV caches and
    // compute buffers, about 400 MB for small) that whisper_full_with_state would never use.
    let ctx = unsafe { sys::whisper_init_from_file_with_params_no_state(mpath.as_ptr(), cp) };
    if ctx.is_null() {
        fail("cannot load the model");
    }
    let st = unsafe { sys::whisper_init_state(ctx) };
    if st.is_null() {
        fail("cannot allocate the model state");
    }
    let load_ms = t_load.elapsed().as_secs_f64() * 1000.0;
    let sysinfo = unsafe { CStr::from_ptr(sys::whisper_print_system_info()) }.to_string_lossy().trim().to_string();
    emit(&format!(
        "{{\"type\":\"ready\",\"model\":{},\"english_only\":{},\"n_mels\":{},\"ftype\":{},\"dtw\":{},\"audio_s\":{},\"system\":{}}}",
        esc(info.kind),
        info.english_only,
        info.n_mels,
        info.ftype,
        esc(preset_name),
        num(audio_s),
        esc(&sysinfo)
    ));

    // Speech ranges first (optional).
    let mut vad_ms = 0.0;
    let speech = a.vad_model.as_deref().map(|p| {
        // One thread: Silero runs one 32 ms chunk at a time, and more threads only add sync cost
        // (measured: 1 thread 404x realtime, 4 threads 21-91x).
        let v = vad_open(p, 1);
        let (segs, n_ms, p_ms) = vad_segments(&v, vad_params(a), &pcm);
        vad_ms = n_ms + p_ms;
        let list: Vec<String> = segs.iter().map(|(s, e)| format!("[{},{}]", num(*s), num(*e))).collect();
        emit(&format!("{{\"type\":\"speech\",\"ms\":{},\"segments\":[{}]}}", num(vad_ms), list.join(",")));
        segs
    });
    let chunks = plan_chunks(speech.as_deref(), audio_s, a.start.max(0.0), a.max_chunk);
    let total: f64 = chunks.iter().map(|(s, e)| e - s).sum();

    let mut lang_c = CString::new(lang.clone()).unwrap_or_else(|_| fail("bad --lang"));
    let prompt_c = a.prompt.as_ref().map(|p| CString::new(p.as_str()).unwrap_or_else(|_| fail("bad --prompt")));
    let mut progress = Progress { chunk_start: 0.0, chunk_len: 0.0, done: 0.0, total, last: -1 };
    let mut all: Vec<Segment> = Vec::new();
    let mut detected: Option<String> = None;
    let t_asr = Instant::now();

    for &(c0, c1) in &chunks {
        if ABORT.load(Ordering::Relaxed) {
            break;
        }
        let i0 = ((c0 * SAMPLE_RATE as f64) as usize).min(pcm.len());
        let i1 = ((c1 * SAMPLE_RATE as f64) as usize).min(pcm.len());
        if i1 <= i0 + SAMPLE_RATE / 10 {
            continue;
        }
        let strategy = if a.beam > 1 { sys::whisper_sampling_strategy_WHISPER_SAMPLING_BEAM_SEARCH } else { sys::whisper_sampling_strategy_WHISPER_SAMPLING_GREEDY };
        let mut p = unsafe { sys::whisper_full_default_params(strategy) };
        p.n_threads = a.threads;
        p.translate = false;
        p.print_progress = false;
        p.print_realtime = false;
        p.print_special = false;
        p.print_timestamps = false;
        p.token_timestamps = a.legacy_ts || !use_dtw;
        p.language = lang_c.as_ptr();
        p.detect_language = false;
        if a.beam > 1 {
            p.beam_search.beam_size = a.beam;
        }
        if let Some(pc) = &prompt_c {
            p.initial_prompt = pc.as_ptr();
        }
        progress.chunk_start = c0;
        progress.chunk_len = c1 - c0;
        p.progress_callback = Some(progress_cb);
        p.progress_callback_user_data = &mut progress as *mut Progress as *mut c_void;
        p.abort_callback = Some(abort_cb);
        p.abort_callback_user_data = std::ptr::null_mut();
        let rc = unsafe { sys::whisper_full_with_state(ctx, st, p, pcm[i0..i1].as_ptr(), (i1 - i0) as c_int) };
        if ABORT.load(Ordering::Relaxed) {
            break;
        }
        if rc != 0 {
            fail(&format!("whisper_full failed ({rc})"));
        }
        if detected.is_none() {
            let id = unsafe { sys::whisper_full_lang_id_from_state(st) };
            let code = unsafe { CStr::from_ptr(sys::whisper_lang_str(id)) }.to_string_lossy().to_string();
            // Later chunks keep the language of the first one (no second detection pass per chunk).
            lang_c = CString::new(code.clone()).unwrap();
            detected = Some(code);
        }
        let mut segs = unsafe { collect(ctx, st, c0, use_dtw, a.tokens) };
        // Each chunk is final once whisper returns: stream it so a long job can resume from the last end.
        for s in &segs {
            let ws: Vec<String> = s.words.iter().map(|w| word_json(w, a.legacy_ts)).collect();
            emit(&format!(
                "{{\"type\":\"segment\",\"start\":{},\"end\":{},\"text\":{},\"words\":[{}]}}",
                num(s.start),
                num(s.end),
                esc(&s.text),
                ws.join(",")
            ));
        }
        all.append(&mut segs);
        progress.done += c1 - c0;
    }
    let asr_ms = t_asr.elapsed().as_secs_f64() * 1000.0;

    if ABORT.load(Ordering::Relaxed) {
        emit(&format!("{{\"type\":\"cancelled\",\"done_until\":{}}}", num(all.last().map(|s| s.end).unwrap_or(a.start))));
        unsafe {
            sys::whisper_free_state(st);
            sys::whisper_free(ctx);
        }
        std::process::exit(2);
    }
    if use_dtw {
        tidy(&mut all, speech.as_deref());
    }
    let words: Vec<String> = all.iter().flat_map(|s| s.words.iter().map(|w| word_json(w, a.legacy_ts))).collect();
    let segs: Vec<String> = all.iter().map(|s| format!("{{\"start\":{},\"end\":{},\"text\":{}}}", num(s.start), num(s.end), esc(&s.text))).collect();
    emit(&format!(
        "{{\"type\":\"result\",\"language\":{},\"duration\":{},\"timing\":{{\"read_ms\":{},\"load_ms\":{},\"vad_ms\":{},\"asr_ms\":{},\"rtf\":{}}},\"segments\":[{}],\"words\":[{}]}}",
        esc(detected.as_deref().unwrap_or(&lang)),
        num(audio_s),
        num(read_ms),
        num(load_ms),
        num(vad_ms),
        num(asr_ms),
        format!("{:.4}", (asr_ms + vad_ms) / 1000.0 / audio_s.max(1e-9)),
        segs.join(","),
        words.join(",")
    ));
    unsafe {
        sys::whisper_free_state(st);
        sys::whisper_free(ctx);
    }
}

fn main() {
    unsafe { sys::whisper_log_set(Some(log_cb), std::ptr::null_mut()) };
    let a = parse_args();
    match a.cmd.as_str() {
        "info" => {
            let m = model_info(a.model.as_deref().unwrap_or_else(|| fail("--model is required")));
            emit(&format!(
                "{{\"type\":\"info\",\"model\":{},\"english_only\":{},\"n_mels\":{},\"ftype\":{},\"dtw\":{}}}",
                esc(m.kind),
                m.english_only,
                m.n_mels,
                m.ftype,
                esc(m.preset_name)
            ));
        }
        "vad" => cmd_vad(&a),
        "transcribe" => cmd_transcribe(&a),
        _ => fail("usage: ssw-speech info|vad|transcribe [options]"),
    }
}
