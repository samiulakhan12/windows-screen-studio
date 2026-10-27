//! Model files are opened by Rust (`std::fs::File`: Unicode paths on Windows) and handed to
//! whisper.cpp through `whisper_model_loader`, because MinGW's whisper.cpp opens paths with a
//! narrow `std::ifstream` (wide paths only under `_MSC_VER`): a non-ASCII user name would break
//! both models otherwise (§5.2).
//!
//! whisper.cpp does not check how many bytes a read returned, so a short read is filled with
//! zeros (no uninitialised data reaches it) and remembered: a truncated file is error `model`
//! even when whisper.cpp would accept it.

use std::ffi::c_void;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use whisper_rs_sys as sys;

use crate::protocol::{Code, Failure};

pub struct Source {
    reader: BufReader<File>,
    eof: bool,
    truncated: bool,
}

/// Owns the reader state the loader's callbacks point at; keep it alive (and unmoved: it is
/// boxed) until whisper.cpp's init returns.
pub struct Loader {
    src: Box<Source>,
    pub raw: sys::whisper_model_loader,
}

unsafe extern "C" fn read_cb(ctx: *mut c_void, out: *mut c_void, size: usize) -> usize {
    let s = &mut *(ctx as *mut Source);
    if size == 0 {
        return 0;
    }
    let buf = std::slice::from_raw_parts_mut(out as *mut u8, size);
    let mut got = 0;
    while got < size {
        match s.reader.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    if got < size {
        buf[got..].fill(0);
        s.eof = true;
        // whisper.cpp probes the end with small header reads (4 bytes that find nothing); a
        // partial read, or a short read of anything larger, means the file was cut.
        if got > 0 || size > 4 {
            s.truncated = true;
        }
    }
    got
}

unsafe extern "C" fn eof_cb(ctx: *mut c_void) -> bool {
    let s = &mut *(ctx as *mut Source);
    if s.eof {
        return true;
    }
    // Peek: at the end of the file the next read finds nothing.
    match s.reader.fill_buf_peek() {
        Some(0) => {
            s.eof = true;
            true
        }
        _ => false,
    }
}

unsafe extern "C" fn close_cb(_ctx: *mut c_void) {}

trait Peek {
    fn fill_buf_peek(&mut self) -> Option<usize>;
}

impl Peek for BufReader<File> {
    fn fill_buf_peek(&mut self) -> Option<usize> {
        use std::io::BufRead;
        self.fill_buf().ok().map(|b| b.len())
    }
}

impl Loader {
    pub fn open(path: &Path) -> Result<Loader, Failure> {
        let f = File::open(path).map_err(|e| Failure::new(Code::Model, format!("cannot open the model: {e}")))?;
        let mut src = Box::new(Source { reader: BufReader::with_capacity(1 << 20, f), eof: false, truncated: false });
        let raw = sys::whisper_model_loader {
            context: &mut *src as *mut Source as *mut c_void,
            read: Some(read_cb),
            eof: Some(eof_cb),
            close: Some(close_cb),
        };
        Ok(Loader { src, raw })
    }

    /// Whether whisper.cpp read past the end of a cut file.
    pub fn truncated(&self) -> bool {
        self.src.truncated
    }
}

/// What the model's ggml header says (magic, then 11 int32 hyper-parameters).
#[derive(Debug, Clone, PartialEq)]
pub struct ModelInfo {
    /// "tiny", "base", "small", "large-v3-turbo"... ("unknown" otherwise).
    pub kind: &'static str,
    pub multilingual: bool,
    /// The DTW alignment-heads preset whisper.cpp names ("BASE"), or "off".
    pub preset: &'static str,
}

pub fn model_info(path: &Path) -> Result<ModelInfo, Failure> {
    let mut f = File::open(path).map_err(|e| Failure::new(Code::Model, format!("cannot open the model: {e}")))?;
    let mut h = [0u8; 48];
    f.read_exact(&mut h).map_err(|_| Failure::new(Code::Model, "the model file is too short"))?;
    info_from_header(&h)
}

pub fn info_from_header(h: &[u8; 48]) -> Result<ModelInfo, Failure> {
    let i = |n: usize| i32::from_le_bytes([h[4 * n], h[4 * n + 1], h[4 * n + 2], h[4 * n + 3]]);
    if i(0) as u32 != 0x6767_6d6c {
        return Err(Failure::new(Code::Model, "not a ggml speech model"));
    }
    let (n_vocab, n_audio_layer, n_text_layer, n_mels) = (i(1), i(5), i(9), i(10));
    let en = n_vocab == 51864;
    let (kind, preset) = match (n_audio_layer, en) {
        (4, true) => ("tiny.en", "TINY_EN"),
        (4, false) => ("tiny", "TINY"),
        (6, true) => ("base.en", "BASE_EN"),
        (6, false) => ("base", "BASE"),
        (12, true) => ("small.en", "SMALL_EN"),
        (12, false) => ("small", "SMALL"),
        (24, true) => ("medium.en", "MEDIUM_EN"),
        (24, false) => ("medium", "MEDIUM"),
        (32, _) if n_text_layer == 4 => ("large-v3-turbo", "LARGE_V3_TURBO"),
        (32, _) if n_mels == 128 => ("large-v3", "LARGE_V3"),
        (32, _) => ("large-v2", "LARGE_V2"),
        _ => ("unknown", "off"),
    };
    Ok(ModelInfo { kind, multilingual: !en, preset })
}

/// The whisper.cpp enum value of a preset name (the `ready` line's spelling or the debug
/// `--dtw` spelling, "base" or "large-v3-turbo").
pub fn preset_value(name: &str) -> Option<(sys::whisper_alignment_heads_preset, &'static str)> {
    use sys::*;
    let n = name.to_ascii_uppercase().replace(['-', '.'], "_");
    Some(match n.as_str() {
        "OFF" | "NONE" => (whisper_alignment_heads_preset_WHISPER_AHEADS_NONE, "off"),
        "TINY_EN" => (whisper_alignment_heads_preset_WHISPER_AHEADS_TINY_EN, "TINY_EN"),
        "TINY" => (whisper_alignment_heads_preset_WHISPER_AHEADS_TINY, "TINY"),
        "BASE_EN" => (whisper_alignment_heads_preset_WHISPER_AHEADS_BASE_EN, "BASE_EN"),
        "BASE" => (whisper_alignment_heads_preset_WHISPER_AHEADS_BASE, "BASE"),
        "SMALL_EN" => (whisper_alignment_heads_preset_WHISPER_AHEADS_SMALL_EN, "SMALL_EN"),
        "SMALL" => (whisper_alignment_heads_preset_WHISPER_AHEADS_SMALL, "SMALL"),
        "MEDIUM_EN" => (whisper_alignment_heads_preset_WHISPER_AHEADS_MEDIUM_EN, "MEDIUM_EN"),
        "MEDIUM" => (whisper_alignment_heads_preset_WHISPER_AHEADS_MEDIUM, "MEDIUM"),
        "LARGE_V2" => (whisper_alignment_heads_preset_WHISPER_AHEADS_LARGE_V2, "LARGE_V2"),
        "LARGE_V3" => (whisper_alignment_heads_preset_WHISPER_AHEADS_LARGE_V3, "LARGE_V3"),
        "LARGE_V3_TURBO" => (whisper_alignment_heads_preset_WHISPER_AHEADS_LARGE_V3_TURBO, "LARGE_V3_TURBO"),
        _ => return None,
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::path::PathBuf;

    pub fn vad_model() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/speech/ggml-silero-v6.2.0.bin")
    }

    pub fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ssw-speech-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn read_all(path: &Path) -> (Vec<u8>, bool) {
        let l = Loader::open(path).unwrap();
        let mut out = Vec::new();
        let mut buf = [0u8; 8];
        unsafe {
            while !(l.raw.eof.unwrap())(l.raw.context) {
                let n = (l.raw.read.unwrap())(l.raw.context, buf.as_mut_ptr() as *mut c_void, buf.len());
                out.extend_from_slice(&buf[..n]);
            }
        }
        (out, l.truncated())
    }

    #[test]
    fn the_loader_reads_a_file_at_a_non_ascii_path() {
        let dir = temp_dir("loader").join("modèle-тест");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("données.bin");
        let data: Vec<u8> = (0..1000u32).map(|i| (i * 7 % 251) as u8).collect();
        std::fs::write(&p, &data).unwrap();
        let (out, truncated) = read_all(&p);
        assert_eq!(out, data);
        assert!(!truncated);
    }

    #[test]
    fn a_cut_read_is_zero_filled_and_flagged() {
        let dir = temp_dir("cut");
        let p = dir.join("m.bin");
        std::fs::write(&p, [1u8, 2, 3]).unwrap();
        let l = Loader::open(&p).unwrap();
        let mut buf = [9u8; 8];
        let n = unsafe { (l.raw.read.unwrap())(l.raw.context, buf.as_mut_ptr() as *mut c_void, 8) };
        assert_eq!(n, 3);
        assert_eq!(buf, [1, 2, 3, 0, 0, 0, 0, 0]);
        assert!(l.truncated());
        // A 4-byte probe at a clean end is not a cut.
        std::fs::write(&p, [1u8, 2, 3, 4]).unwrap();
        let l = Loader::open(&p).unwrap();
        let mut b4 = [0u8; 4];
        unsafe {
            (l.raw.read.unwrap())(l.raw.context, b4.as_mut_ptr() as *mut c_void, 4);
            assert_eq!((l.raw.read.unwrap())(l.raw.context, b4.as_mut_ptr() as *mut c_void, 4), 0);
            assert!((l.raw.eof.unwrap())(l.raw.context));
        }
        assert!(!l.truncated());
    }

    #[test]
    fn reads_the_model_header() {
        let mut h = [0u8; 48];
        let put = |h: &mut [u8; 48], n: usize, v: i32| h[4 * n..4 * n + 4].copy_from_slice(&v.to_le_bytes());
        put(&mut h, 0, 0x6767_6d6c);
        put(&mut h, 1, 51865);
        put(&mut h, 5, 6);
        put(&mut h, 10, 80);
        assert_eq!(info_from_header(&h).unwrap(), ModelInfo { kind: "base", multilingual: true, preset: "BASE" });
        put(&mut h, 5, 32);
        put(&mut h, 9, 4);
        put(&mut h, 10, 128);
        assert_eq!(info_from_header(&h).unwrap().preset, "LARGE_V3_TURBO");
        put(&mut h, 0, 0);
        assert_eq!(info_from_header(&h).unwrap_err().code, Code::Model);
        assert_eq!(preset_value("large-v3-turbo").unwrap().1, "LARGE_V3_TURBO");
        assert_eq!(preset_value("off").unwrap().1, "off");
        assert!(preset_value("huge").is_none());
    }
}
