//! Command line (§5.2), read with `args_os` so Windows arguments stay UTF-16 clean: paths are
//! kept as `OsString`, everything else must be UTF-8. Anything unknown is error `args`.
//!
//!   ssw-speech cpu
//!   ssw-speech vad --vad-model P --audio <wav|-> [--format f32le] [--threads 1] [--low-priority] [--parent-pid N]
//!   ssw-speech transcribe --model-dir D --model F --audio W --vad-model P [--lang auto|xx] [--threads N]
//!                         [--max-chunk S] [--no-timestamps] [--low-priority] [--stdin-control] [--parent-pid N]
//!   debug only: --dtw auto|off|<preset>, --beam N, --prompt S, --verbose
//!
//! `--max-chunk S` (1..29.5 s, default 29) is the longest chunk handed to whisper.cpp, and
//! `--no-timestamps` decodes without timestamp tokens (word times come from DTW either way); the
//! app passes them for a model that asks for them (the Bangla model: 20 s and no timestamp tokens,
//! docs/design/offline-captions.md §14).

use std::ffi::OsString;
use std::path::PathBuf;

use crate::protocol::{Code, Failure};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cmd {
    Cpu,
    Vad,
    Transcribe,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Audio {
    File(PathBuf),
    Stdin,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Args {
    pub cmd: Cmd,
    pub model_dir: Option<PathBuf>,
    pub model: Option<String>,
    pub audio: Option<Audio>,
    pub vad_model: Option<PathBuf>,
    pub lang: String,
    pub threads: i32,
    pub low_priority: bool,
    pub stdin_control: bool,
    pub parent_pid: Option<u32>,
    pub dtw: String,
    pub beam: i32,
    pub prompt: Option<String>,
    pub max_chunk: f64,
    pub no_timestamps: bool,
    pub verbose: bool,
}

fn bad(msg: impl Into<String>) -> Failure {
    Failure::new(Code::Args, msg)
}

/// A catalog file name: `[A-Za-z0-9._-]+`, never `.` or `..`, so joining it to the models
/// folder can never leave it.
pub fn valid_model_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// `auto` or a language code as whisper knows it (lowercase letters, "haw", "yue"...); whether
/// the model knows it is checked when the model is loaded (error `language`).
pub fn plausible_lang(lang: &str) -> bool {
    lang == "auto" || (2..=8).contains(&lang.len()) && lang.bytes().all(|c| c.is_ascii_lowercase())
}

pub fn parse(argv: Vec<OsString>) -> Result<Args, Failure> {
    let mut it = argv.into_iter();
    let cmd = match it.next().as_ref().and_then(|s| s.to_str()) {
        Some("cpu") => Cmd::Cpu,
        Some("vad") => Cmd::Vad,
        Some("transcribe") => Cmd::Transcribe,
        Some(other) => return Err(bad(format!("unknown subcommand {other}; use cpu, vad or transcribe"))),
        None => return Err(bad("usage: ssw-speech cpu | vad | transcribe [options]")),
    };
    let mut a = Args {
        cmd,
        model_dir: None,
        model: None,
        audio: None,
        vad_model: None,
        lang: "auto".into(),
        threads: if cmd == Cmd::Vad { 1 } else { 4 },
        low_priority: false,
        stdin_control: false,
        parent_pid: None,
        dtw: "auto".into(),
        beam: 0,
        prompt: None,
        max_chunk: 29.0,
        no_timestamps: false,
        verbose: false,
    };
    let mut format: Option<String> = None;
    let mut seen: Vec<String> = Vec::new();
    while let Some(k) = it.next() {
        let key = k.to_str().ok_or_else(|| bad("an argument is not valid Unicode"))?.to_string();
        if seen.contains(&key) {
            return Err(bad(format!("{key} given twice")));
        }
        seen.push(key.clone());
        let mut os = || it.next().ok_or_else(|| bad(format!("{key} needs a value")));
        macro_rules! text {
            () => {
                os()?.into_string().map_err(|_| bad(format!("{key} is not valid Unicode")))?
            };
        }
        macro_rules! number {
            () => {{
                let v = text!();
                v.parse().map_err(|_| bad(format!("{key} must be a number, got {v:?}")))?
            }};
        }
        let flag_ok = |cmds: &[Cmd]| {
            if cmds.contains(&cmd) {
                Ok(())
            } else {
                Err(bad(format!("{key} does not apply to this subcommand")))
            }
        };
        use Cmd::*;
        match key.as_str() {
            "--model-dir" => {
                flag_ok(&[Transcribe])?;
                a.model_dir = Some(PathBuf::from(os()?))
            }
            "--model" => {
                flag_ok(&[Transcribe])?;
                let m = text!();
                if !valid_model_name(&m) {
                    return Err(bad(format!("--model must be a file name ([A-Za-z0-9._-]+), got {m:?}")));
                }
                a.model = Some(m)
            }
            "--audio" => {
                flag_ok(&[Vad, Transcribe])?;
                let v = os()?;
                a.audio = Some(if v == "-" { Audio::Stdin } else { Audio::File(PathBuf::from(v)) })
            }
            "--format" => {
                flag_ok(&[Vad])?;
                format = Some(text!())
            }
            "--vad-model" => {
                flag_ok(&[Vad, Transcribe])?;
                a.vad_model = Some(PathBuf::from(os()?))
            }
            "--lang" => {
                flag_ok(&[Transcribe])?;
                a.lang = text!()
            }
            "--threads" => {
                flag_ok(&[Vad, Transcribe])?;
                a.threads = number!()
            }
            "--low-priority" => {
                flag_ok(&[Vad, Transcribe])?;
                a.low_priority = true
            }
            "--stdin-control" => {
                flag_ok(&[Transcribe])?;
                a.stdin_control = true
            }
            "--parent-pid" => {
                flag_ok(&[Cpu, Vad, Transcribe])?;
                let pid: u32 = number!();
                if pid == 0 {
                    return Err(bad("--parent-pid must be a process id"));
                }
                a.parent_pid = Some(pid)
            }
            "--dtw" => {
                flag_ok(&[Transcribe])?;
                a.dtw = text!()
            }
            "--beam" => {
                flag_ok(&[Transcribe])?;
                a.beam = number!()
            }
            "--prompt" => {
                flag_ok(&[Transcribe])?;
                a.prompt = Some(text!())
            }
            "--max-chunk" => {
                flag_ok(&[Transcribe])?;
                a.max_chunk = number!()
            }
            "--no-timestamps" => {
                flag_ok(&[Transcribe])?;
                a.no_timestamps = true
            }
            "--verbose" => a.verbose = true,
            _ => return Err(bad(format!("unknown argument {key}"))),
        }
    }
    if !(1..=64).contains(&a.threads) {
        return Err(bad("--threads must be 1..64"));
    }
    if !(0..=16).contains(&a.beam) {
        return Err(bad("--beam must be 0..16"));
    }
    if !(a.max_chunk.is_finite() && (1.0..=29.5).contains(&a.max_chunk)) {
        return Err(bad("--max-chunk must be 1..29.5 seconds"));
    }
    if let Some(p) = &a.prompt {
        if p.contains('\0') {
            return Err(bad("--prompt holds a NUL character"));
        }
    }
    match cmd {
        Cmd::Cpu => {}
        Cmd::Vad => {
            if a.vad_model.is_none() || a.audio.is_none() {
                return Err(bad("vad needs --vad-model and --audio"));
            }
            match (&a.audio, format.as_deref()) {
                (_, Some(f)) if f != "f32le" => return Err(bad(format!("--format must be f32le, got {f:?}"))),
                (Some(Audio::File(_)), Some(_)) => return Err(bad("--format applies to --audio - only")),
                _ => {}
            }
        }
        Cmd::Transcribe => {
            if a.model_dir.is_none() || a.model.is_none() || a.vad_model.is_none() {
                return Err(bad("transcribe needs --model-dir, --model, --audio and --vad-model"));
            }
            if !matches!(a.audio, Some(Audio::File(_))) {
                return Err(bad("transcribe needs --audio with a WAV file"));
            }
            if !plausible_lang(&a.lang) {
                return Err(Failure::new(Code::Language, format!("unknown language {:?}", a.lang)));
            }
        }
    }
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(v: &[&str]) -> Result<Args, Failure> {
        parse(v.iter().map(OsString::from).collect())
    }

    #[test]
    fn reads_the_three_subcommands() {
        assert_eq!(p(&["cpu"]).unwrap().cmd, Cmd::Cpu);
        let v = p(&[
            "vad",
            "--vad-model",
            "m.bin",
            "--audio",
            "-",
            "--format",
            "f32le",
            "--threads",
            "1",
            "--low-priority",
            "--parent-pid",
            "42",
        ])
        .unwrap();
        assert_eq!(v.audio, Some(Audio::Stdin));
        assert_eq!(v.parent_pid, Some(42));
        assert!(v.low_priority);
        let t = p(&[
            "transcribe",
            "--model-dir",
            "/m",
            "--model",
            "ggml-base-q5_1.bin",
            "--audio",
            "part-1.wav",
            "--vad-model",
            "v.bin",
            "--lang",
            "en",
            "--threads",
            "3",
            "--low-priority",
            "--stdin-control",
            "--parent-pid",
            "7",
        ])
        .unwrap();
        assert_eq!(t.model.as_deref(), Some("ggml-base-q5_1.bin"));
        assert_eq!(t.lang, "en");
        assert_eq!(t.threads, 3);
        assert!(t.stdin_control);
        assert_eq!(p(&["vad", "--vad-model", "m", "--audio", "x.wav"]).unwrap().threads, 1);
    }

    #[test]
    fn rejects_unknown_flags_and_bad_values() {
        for argv in [
            vec![],
            vec!["info"],
            vec!["cpu", "--bogus"],
            vec!["cpu", "--audio", "x"],
            vec!["vad", "--vad-model", "m"],
            vec!["vad", "--vad-model", "m", "--audio", "-", "--format", "s16le"],
            vec!["vad", "--vad-model", "m", "--audio", "x.wav", "--format", "f32le"],
            vec!["vad", "--vad-model", "m", "--audio", "-", "--threads", "0"],
            vec!["vad", "--vad-model", "m", "--audio", "-", "--threads", "x"],
            vec!["vad", "--vad-model", "m", "--audio", "-", "--parent-pid", "-3"],
            vec!["transcribe", "--model-dir", "d", "--model", "m.bin", "--audio", "-", "--vad-model", "v"],
            vec!["transcribe", "--model-dir", "d", "--model", "m.bin", "--vad-model", "v"],
            vec![
                "transcribe",
                "--model-dir",
                "d",
                "--model",
                "m.bin",
                "--audio",
                "a.wav",
                "--vad-model",
                "v",
                "--threads",
            ],
            vec![
                "transcribe",
                "--model-dir",
                "d",
                "--model",
                "m.bin",
                "--model",
                "n.bin",
                "--audio",
                "a.wav",
                "--vad-model",
                "v",
            ],
        ] {
            assert_eq!(p(&argv).map(|_| ()).unwrap_err().code, Code::Args, "{argv:?}");
        }
        let lang = p(&[
            "transcribe",
            "--model-dir",
            "d",
            "--model",
            "m.bin",
            "--audio",
            "a.wav",
            "--vad-model",
            "v",
            "--lang",
            "EN!",
        ]);
        assert_eq!(lang.unwrap_err().code, Code::Language);
    }

    #[test]
    fn reads_max_chunk_for_transcribe_within_its_bounds() {
        let base = ["transcribe", "--model-dir", "d", "--model", "m.bin", "--audio", "a.wav", "--vad-model", "v"];
        let with = |s: &str| {
            let mut v = base.to_vec();
            v.extend(["--max-chunk", s]);
            p(&v)
        };
        assert_eq!(p(&base).unwrap().max_chunk, 29.0);
        assert_eq!(with("20").unwrap().max_chunk, 20.0);
        assert_eq!(with("1").unwrap().max_chunk, 1.0);
        assert_eq!(with("29.5").unwrap().max_chunk, 29.5);
        for bad in ["0.5", "30", "NaN", "inf", "x", "-20"] {
            assert_eq!(with(bad).unwrap_err().code, Code::Args, "{bad}");
        }
        let vad = p(&["vad", "--vad-model", "m", "--audio", "-", "--max-chunk", "20"]);
        assert_eq!(vad.unwrap_err().code, Code::Args);
    }

    #[test]
    fn reads_no_timestamps_for_transcribe_only() {
        let base = ["transcribe", "--model-dir", "d", "--model", "m.bin", "--audio", "a.wav", "--vad-model", "v"];
        assert!(!p(&base).unwrap().no_timestamps);
        let mut on = base.to_vec();
        on.push("--no-timestamps");
        assert!(p(&on).unwrap().no_timestamps);
        on.push("--no-timestamps");
        assert_eq!(p(&on).unwrap_err().code, Code::Args, "given twice");
        let vad = p(&["vad", "--vad-model", "m", "--audio", "-", "--no-timestamps"]);
        assert_eq!(vad.unwrap_err().code, Code::Args);
    }

    #[test]
    fn model_names_outside_the_safe_set_are_rejected() {
        for bad_name in ["../ggml-base.bin", "a/b.bin", "a\\b.bin", "..", ".", "", "C:x.bin", "mo dèle.bin", "x.bin\0"]
        {
            assert!(!valid_model_name(bad_name), "{bad_name:?}");
            let r = p(&["transcribe", "--model-dir", "d", "--model", bad_name, "--audio", "a.wav", "--vad-model", "v"]);
            assert_eq!(r.unwrap_err().code, Code::Args, "{bad_name:?}");
        }
        for ok in ["ggml-tiny-q8_0.bin", "ggml-large-v3-turbo-q5_0.bin", "A.b_c-1"] {
            assert!(valid_model_name(ok));
        }
    }

    #[cfg(unix)]
    #[test]
    fn paths_are_kept_as_os_strings() {
        use std::os::unix::ffi::OsStringExt;
        // A path that is not UTF-8 is still a path; a flag value that is text must be UTF-8.
        let raw = OsString::from_vec(vec![b'/', b't', 0xff, b'.', b'w', b'a', b'v']);
        let argv = vec![OsString::from("vad"), "--vad-model".into(), "m".into(), "--audio".into(), raw.clone()];
        assert_eq!(parse(argv).unwrap().audio, Some(Audio::File(PathBuf::from(raw.clone()))));
        let argv = vec![
            OsString::from("transcribe"),
            "--model-dir".into(),
            "d".into(),
            "--model".into(),
            raw,
            "--audio".into(),
            "a.wav".into(),
            "--vad-model".into(),
            "v".into(),
        ];
        assert_eq!(parse(argv).unwrap_err().code, Code::Args);
    }
}
