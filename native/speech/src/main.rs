//! ssw-speech: Flown's speech helper. Offline transcription with word timings (whisper.cpp 1.8.3
//! with DTW token times) and the Silero speech detector, as a short-lived child process that
//! prints JSON lines on stdout (docs/design/offline-captions.md §5.2, src/shared/speech/protocol.ts).
//!
//!   ssw-speech cpu
//!   ssw-speech vad --vad-model P --audio <wav|-> [--format f32le] [--threads 1] [--low-priority] [--parent-pid N]
//!   ssw-speech transcribe --model-dir D --model F --audio W --vad-model P [--lang auto|xx]
//!                         [--threads N] [--low-priority] [--stdin-control] [--parent-pid N]
//!
//! Exit codes: 0 ok, 1 error (an `error` line), 2 cancelled (a `cancelled` line). With
//! --stdin-control a `cancel` line or the end of stdin cancels at the next checkpoint.

mod args;
mod chunks;
mod guard;
mod lang;
mod loader;
mod protocol;
mod vad;
mod wav;
mod words;

#[cfg(test)]
mod testjson;

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::io::BufRead;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use whisper_rs_sys as sys;

use args::{Args, Audio, Cmd};
use protocol::{emit, fail, num, Code, Failure};

static ABORT: AtomicBool = AtomicBool::new(false);

unsafe extern "C" fn log_cb(_level: sys::ggml_log_level, text: *const c_char, _ud: *mut c_void) {
    if guard::verbose() && !text.is_null() {
        eprint!("{}", CStr::from_ptr(text).to_string_lossy());
    }
}

unsafe extern "C" fn abort_cb(_ud: *mut c_void) -> bool {
    ABORT.load(Ordering::Relaxed)
}

/// stdin as the control channel: a `cancel` line or its end (the app died or gave up) stops
/// the work at the next checkpoint.
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

fn main() {
    unsafe { sys::whisper_log_set(Some(log_cb), std::ptr::null_mut()) };
    let a = args::parse(std::env::args_os().skip(1).collect()).unwrap_or_else(|f| fail(f));
    guard::set_verbose(a.verbose);
    // First, before any other thread: the engine's threads inherit the priority.
    if a.low_priority {
        guard::lower_priority();
    }
    guard::harden();
    if let Some(pid) = a.parent_pid {
        guard::watch_parent(pid);
    }
    if a.cmd == Cmd::Cpu {
        emit(&guard::cpu_line(&guard::cpu()));
        return;
    }
    // The standard build's own check. Only a second line: ggml's static initialisers, compiled
    // for AVX2, ran before main; an illegal-instruction exit means the same to the app.
    if guard::BUILD == "standard" {
        let missing = guard::missing_for_standard(&guard::cpu());
        if !missing.is_empty() {
            fail(Failure::new(Code::Cpu, format!("this processor lacks {} for this build", missing.join(", "))));
        }
    }
    match a.cmd {
        Cmd::Vad => cmd_vad(&a).unwrap_or_else(|f| fail(f)),
        Cmd::Transcribe => cmd_transcribe(&a).unwrap_or_else(|f| fail(f)),
        Cmd::Cpu => unreachable!(),
    }
}

// ------------------------------------------------------------------------------------- vad

fn cmd_vad(a: &Args) -> Result<(), Failure> {
    let model = vad::VadModel::open(a.vad_model.as_ref().unwrap(), a.threads)?;
    let t = Instant::now();
    let (probs, audio_s) = match a.audio.as_ref().unwrap() {
        Audio::Stdin => vad::probs_from_reader(&model, &mut std::io::stdin().lock())?,
        Audio::File(p) => vad::probs_from_samples(&model, &wav::read_wav(p)?)?,
    };
    let line = protocol::vad_line(audio_s, &probs, t.elapsed().as_secs_f64() * 1000.0);
    if line.len() > protocol::LINE_MAX {
        // About 7 hours of sound; the app falls back to the level-based detector.
        return Err(Failure::new(
            Code::Audio,
            format!("{audio_s:.0} s of sound is too long for one speech detector line"),
        ));
    }
    emit(&line);
    Ok(())
}

// ------------------------------------------------------------------------------ transcribe

struct Engine {
    ctx: *mut sys::whisper_context,
    st: *mut sys::whisper_state,
}

impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            if !self.st.is_null() {
                sys::whisper_free_state(self.st);
            }
            sys::whisper_free(self.ctx);
        }
    }
}

struct Progress {
    chunk_start: f64,
    chunk_len: f64,
    done: f64,
    total: f64,
    last: i32,
}

impl Progress {
    fn percent(&self, chunk_pct: f64) -> i32 {
        ((self.done + self.chunk_len * chunk_pct / 100.0) / self.total.max(1e-9) * 100.0).floor().clamp(0.0, 100.0)
            as i32
    }
}

unsafe extern "C" fn progress_cb(
    _c: *mut sys::whisper_context,
    _s: *mut sys::whisper_state,
    pct: c_int,
    ud: *mut c_void,
) {
    let p = &mut *(ud as *mut Progress);
    let overall = p.percent(pct as f64);
    if overall > p.last {
        p.last = overall;
        protocol::progress(overall, p.chunk_start + p.chunk_len * pct.clamp(0, 100) as f64 / 100.0);
    }
}

/// The segments of the last `whisper_full_with_state`, with their text tokens, `offset` seconds
/// added.
unsafe fn read_segments(e: &Engine, offset: f64, use_dtw: bool) -> Vec<words::RawSegment> {
    let eot = sys::whisper_token_eot(e.ctx);
    let n = sys::whisper_full_n_segments_from_state(e.st);
    let mut out = Vec::new();
    for i in 0..n {
        let t0 = sys::whisper_full_get_segment_t0_from_state(e.st, i) as f64 / 100.0 + offset;
        let t1 = sys::whisper_full_get_segment_t1_from_state(e.st, i) as f64 / 100.0 + offset;
        let tp = sys::whisper_full_get_segment_text_from_state(e.st, i);
        let text = if tp.is_null() { Vec::new() } else { CStr::from_ptr(tp).to_bytes().to_vec() };
        let mut tokens = Vec::new();
        for j in 0..sys::whisper_full_n_tokens_from_state(e.st, i) {
            let d = sys::whisper_full_get_token_data_from_state(e.st, i, j);
            if d.id >= eot {
                continue;
            }
            let p = sys::whisper_token_to_str(e.ctx, d.id);
            let bytes = if p.is_null() { Vec::new() } else { CStr::from_ptr(p).to_bytes().to_vec() };
            let t = if use_dtw { d.t_dtw } else { d.t1 };
            tokens.push(words::Token { bytes, dtw: if t >= 0 { t as f64 / 100.0 + offset } else { t0 }, p: d.p });
        }
        out.push(words::RawSegment { t0, t1: t1.max(t0), text, tokens });
    }
    out
}

fn cmd_transcribe(a: &Args) -> Result<(), Failure> {
    if a.stdin_control {
        start_control_thread();
    }
    let model_path = a.model_dir.as_ref().unwrap().join(a.model.as_ref().unwrap());
    let info = loader::model_info(&model_path)?;
    let (preset, preset_name) = match a.dtw.as_str() {
        "auto" => loader::preset_value(info.preset).unwrap(),
        other => loader::preset_value(other)
            .ok_or_else(|| Failure::new(Code::Args, format!("unknown --dtw preset {other}")))?,
    };
    let use_dtw = preset_name != "off";
    let asked = if !info.multilingual { "en".to_string() } else { a.lang.clone() };
    if asked != "auto" && !lang::known(&asked) {
        return Err(Failure::new(Code::Language, format!("the model does not know the language {asked:?}")));
    }
    let Some(Audio::File(audio)) = a.audio.as_ref() else { unreachable!() };
    let pcm = wav::read_wav(audio)?;
    let audio_s = pcm.len() as f64 / wav::SAMPLE_RATE as f64;
    if ABORT.load(Ordering::Relaxed) {
        protocol::cancelled(0.0);
    }

    let t_load = Instant::now();
    let mut cp = unsafe { sys::whisper_context_default_params() };
    cp.use_gpu = false;
    cp.flash_attn = false; // DTW needs the attention weights
    cp.dtw_token_timestamps = use_dtw;
    cp.dtw_aheads_preset = preset;
    let mut ld = loader::Loader::open(&model_path)?;
    // _no_state and one whisper_init_state: the plain init allocates a state that is never used.
    let ctx = unsafe { sys::whisper_init_with_params_no_state(&mut ld.raw, cp) };
    if ctx.is_null() {
        return Err(Failure::new(Code::Model, "cannot load the speech model"));
    }
    let mut e = Engine { ctx, st: std::ptr::null_mut() };
    if ld.truncated() {
        return Err(Failure::new(Code::Model, "the speech model file is cut short"));
    }
    drop(ld);
    e.st = unsafe { sys::whisper_init_state(e.ctx) };
    if e.st.is_null() {
        return Err(Failure::new(Code::Memory, "not enough memory for the speech model's working state"));
    }
    let load_ms = t_load.elapsed().as_secs_f64() * 1000.0;
    let system = unsafe { CStr::from_ptr(sys::whisper_print_system_info()) }.to_string_lossy().trim().to_string();
    emit(&format!(
        "{{\"type\":\"ready\",\"model\":{},\"multilingual\":{},\"dtw\":{},\"build\":{},\"system\":{}}}",
        protocol::esc(info.kind),
        info.multilingual,
        protocol::esc(preset_name),
        protocol::esc(guard::BUILD),
        protocol::esc(&system)
    ));
    protocol::start_heartbeat();

    // Speech ranges of the part (one thread: more only add synchronisation).
    let t_vad = Instant::now();
    let detector = vad::VadModel::open(a.vad_model.as_ref().unwrap(), 1)?;
    detector.detect(&pcm)?;
    let speech = detector.segments((a.max_chunk - 2.0 * chunks::PAD - 0.5) as f32)?;
    drop(detector);
    let vad_ms = t_vad.elapsed().as_secs_f64() * 1000.0;
    emit(&protocol::speech_line(&speech));
    let plan: Vec<(f64, f64)> =
        chunks::plan(&speech, audio_s, a.max_chunk).into_iter().filter(|(s, e)| e - s >= 0.1).collect();
    let total: f64 = plan.iter().map(|(s, e)| e - s).sum();
    protocol::progress(0, 0.0);

    let slice = |c: (f64, f64)| {
        let i0 = ((c.0 * wav::SAMPLE_RATE as f64) as usize).min(pcm.len());
        let i1 = ((c.1 * wav::SAMPLE_RATE as f64) as usize).min(pcm.len());
        &pcm[i0..i1]
    };

    let t_asr = Instant::now();
    // The language: asked for, or detected once on the chunk that hears the most of it.
    let (language, language_s) = if asked != "auto" {
        (asked.clone(), 0.0)
    } else {
        match lang::detection_chunk(&plan, &speech) {
            None => (String::new(), 0.0),
            Some((i, heard)) => {
                if ABORT.load(Ordering::Relaxed) {
                    protocol::cancelled(0.0);
                }
                (lang::detect(e.ctx, e.st, slice(plan[i]), a.threads)?, heard)
            }
        }
    };
    let lang_c = CString::new(if language.is_empty() { "en".to_string() } else { language.clone() }).unwrap();
    let prompt_c = a.prompt.as_ref().map(|p| CString::new(p.as_str()).unwrap());

    let mut progress = Progress { chunk_start: 0.0, chunk_len: 0.0, done: 0.0, total, last: 0 };
    let mut refiner = words::Refiner::default();
    let mut done_until = 0.0;
    for &(c0, c1) in &plan {
        if ABORT.load(Ordering::Relaxed) {
            protocol::cancelled(done_until);
        }
        let strategy = if a.beam > 1 {
            sys::whisper_sampling_strategy_WHISPER_SAMPLING_BEAM_SEARCH
        } else {
            sys::whisper_sampling_strategy_WHISPER_SAMPLING_GREEDY
        };
        let mut p = unsafe { sys::whisper_full_default_params(strategy) };
        p.n_threads = a.threads;
        p.translate = false;
        p.print_progress = false;
        p.print_realtime = false;
        p.print_special = false;
        p.print_timestamps = false;
        p.token_timestamps = !use_dtw;
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
        let pcm_c = slice((c0, c1));
        let rc = unsafe { sys::whisper_full_with_state(e.ctx, e.st, p, pcm_c.as_ptr(), pcm_c.len() as c_int) };
        if ABORT.load(Ordering::Relaxed) {
            protocol::cancelled(done_until);
        }
        if rc != 0 {
            return Err(Failure::new(Code::Internal, format!("transcription failed ({rc})")));
        }
        let raw = unsafe { read_segments(&e, c0, use_dtw) };
        let mut segs = words::raw_words(&raw);
        refiner.chunk(&mut segs, &speech);
        for s in segs.iter().filter(|s| !s.words.is_empty()) {
            emit(&protocol::segment_line(s));
        }
        progress.done += c1 - c0;
        done_until = c1;
        let pct = progress.percent(0.0);
        progress.last = pct;
        protocol::progress(pct, c1);
    }
    let asr_ms = t_asr.elapsed().as_secs_f64() * 1000.0;
    let rtf = if audio_s > 0.0 { (asr_ms + vad_ms) / 1000.0 / audio_s } else { 0.0 };
    emit(&format!(
        "{{\"type\":\"result\",\"language\":{},\"language_s\":{},\"duration\":{},\"timing\":{{\"load_ms\":{},\"vad_ms\":{},\"asr_ms\":{},\"rtf\":{:.4},\"peak_rss_mb\":{}}}}}",
        protocol::esc(&language),
        num(language_s),
        num(audio_s),
        num(load_ms),
        num(vad_ms),
        num(asr_ms),
        if rtf.is_finite() { rtf } else { 0.0 },
        num(guard::peak_rss_mb())
    ));
    drop(e);
    Ok(())
}
