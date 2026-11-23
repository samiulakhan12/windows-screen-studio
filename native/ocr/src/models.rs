//! The reader's models (docs/design/auto-blur.md §5.12, §10.2): the pins compiled in (the same as
//! `src/shared/privacy/readerCatalog.ts`, which main sends with `open`; both must agree), each
//! file read into memory once, every buffer hashed before any is parsed, and the hashed buffer
//! itself parsed (`model_for_read`), so a file swapped on disk between the check and the parse is
//! never parsed. The plans (three detector buckets, five widths for each recogniser) are built once
//! here and kept for the whole Find; after a caught panic they are built again from the parsed
//! models (§5.6).

use crate::protocol::Pin;
use crate::stats;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tract_onnx::prelude::*;

pub struct Pinned {
    pub file: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

pub const DET: Pinned = Pinned { file: "PP-OCRv6_tiny_det_onnx/inference.onnx", bytes: 1_780_590, sha256: "193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8" };
pub const REC_TINY: Pinned = Pinned { file: "PP-OCRv6_tiny_rec_onnx/inference.onnx", bytes: 4_462_639, sha256: "9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6" };
pub const YML_TINY: Pinned = Pinned { file: "PP-OCRv6_tiny_rec_onnx/inference.yml", bytes: 55_571, sha256: "66170210bad538e83fff3c4a3867e547d6bf20b50d64b20347c4b913f3034ea1" };
pub const REC_SMALL: Pinned = Pinned { file: "PP-OCRv6_small_rec_onnx/inference.onnx", bytes: 21_159_378, sha256: "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634" };
pub const YML_SMALL: Pinned = Pinned { file: "PP-OCRv6_small_rec_onnx/inference.yml", bytes: 150_579, sha256: "ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1" };

/// Every file the reader opens, in the order `open` reads them.
pub const PINS: [&Pinned; 5] = [&DET, &REC_TINY, &YML_TINY, &REC_SMALL, &YML_SMALL];

/// The detector's fixed input buckets (width, height), smallest first (§5.5).
pub const BUCKETS: [(usize, usize); 3] = [(640, 352), (960, 544), (1920, 1088)];
/// The recognisers' fixed input widths at height 48 (§5.5).
pub const WIDTHS: [usize; 5] = [320, 448, 640, 896, 1280];
pub const REC_HEIGHT: usize = 48;

pub type Plan = Arc<TypedRunnableModel>;

/// What `open` parsed: the three graphs and the two character lists.
pub struct Parsed {
    det: InferenceModel,
    tiny: InferenceModel,
    small: InferenceModel,
    pub chars_tiny: Vec<String>,
    pub chars_small: Vec<String>,
}

/// The plans every read uses; built once at open, and again only after a panic.
pub struct Plans {
    pub det: Vec<Plan>,
    pub tiny: Vec<Plan>,
    pub small: Vec<Plan>,
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Reads every pinned file once, checks the pins main sent against the compiled ones, and hashes
/// every buffer; only when all of them match is anything parsed. Err(()) is `error: 'model'`.
pub fn open(pins: &[Pin]) -> Result<Parsed, ()> {
    if pins.len() != PINS.len() {
        return Err(());
    }
    let mut buffers: Vec<Vec<u8>> = Vec::with_capacity(PINS.len());
    for want in PINS {
        let got = pins.iter().find(|p| p.file == want.file).ok_or(())?;
        if got.bytes != want.bytes || got.sha256 != want.sha256 {
            return Err(());
        }
        stats::add(&stats::FILE_READS, 1);
        let buf = std::fs::read(&got.path).map_err(|_| ())?;
        buffers.push(buf);
    }
    // Every buffer is checked before any is parsed (§10.2).
    for (want, buf) in PINS.iter().zip(&buffers) {
        if buf.len() as u64 != want.bytes || hex(buf) != want.sha256 {
            return Err(());
        }
    }
    let parse = |buf: &[u8]| -> Result<InferenceModel, ()> {
        stats::add(&stats::PARSES, 1);
        tract_onnx::onnx().with_ignore_value_info(true).model_for_read(&mut &buf[..]).map_err(|_| ())
    };
    let det = parse(&buffers[0])?;
    let tiny = parse(&buffers[1])?;
    let chars_tiny = char_list(std::str::from_utf8(&buffers[2]).map_err(|_| ())?);
    let small = parse(&buffers[3])?;
    let chars_small = char_list(std::str::from_utf8(&buffers[4]).map_err(|_| ())?);
    if chars_tiny.len() < 3 || chars_small.len() < 3 {
        return Err(());
    }
    Ok(Parsed { det, tiny, small, chars_tiny, chars_small })
}

fn plan(model: &InferenceModel, shape: [usize; 4]) -> TractResult<Plan> {
    stats::add(&stats::PLAN_BUILDS, 1);
    model.clone().with_input_fact(0, f32::fact(shape.to_vec()).into())?.into_optimized()?.into_runnable()
}

impl Parsed {
    /// Every plan a read can need: 3 detector buckets, 5 widths for each recogniser.
    pub fn plans(&self) -> Result<Plans, ()> {
        let det = BUCKETS.iter().map(|&(w, h)| plan(&self.det, [1, 3, h, w])).collect::<TractResult<Vec<_>>>().map_err(|_| ())?;
        let tiny = WIDTHS.iter().map(|&w| plan(&self.tiny, [1, 3, REC_HEIGHT, w])).collect::<TractResult<Vec<_>>>().map_err(|_| ())?;
        let small = WIDTHS.iter().map(|&w| plan(&self.small, [1, 3, REC_HEIGHT, w])).collect::<TractResult<Vec<_>>>().map_err(|_| ())?;
        Ok(Plans { det, tiny, small })
    }
}

/// The recogniser's character list from its inference.yml (`PostProcess.character_dict`), with the
/// CTC blank at 0 and the space PaddleOCR appends at the end (scripts/privacy/ppocr.py).
pub fn char_list(yml: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut inside = false;
    for line in yml.lines() {
        if line.trim_start().starts_with("character_dict:") {
            inside = true;
            continue;
        }
        if !inside {
            continue;
        }
        // The list ends at the first line that is not one of its items.
        let Some(item) = line.strip_prefix("  - ") else {
            break;
        };
        let s = if item.len() >= 2 && item.starts_with('\'') && item.ends_with('\'') {
            item[1..item.len() - 1].replace("''", "'")
        } else if item.len() >= 2 && item.starts_with('"') && item.ends_with('"') {
            unescape_double(&item[1..item.len() - 1])
        } else {
            item.to_string()
        };
        out.push(s);
    }
    out.push(" ".into());
    out
}

/// YAML double-quoted escapes the character lists use (`\\`, `\"`, `\uXXXX`).
fn unescape_double(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('u') => {
                let code: String = (0..4).filter_map(|_| it.next()).collect();
                if let Some(ch) = u32::from_str_radix(&code, 16).ok().and_then(char::from_u32) {
                    out.push(ch);
                }
            }
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some(o) => out.push(o),
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_character_list() {
        let yml = "Global:\n  x: 1\nPostProcess:\n  name: CTCLabelDecode\n  character_dict:\n  - a\n  - '''\n  - \"\\\\\"\n  - \"\\\"\"\n  - ' '\nOther: 2\n";
        assert_eq!(char_list(yml), vec!["", "a", "'", "\\", "\"", " ", " "]);
    }

    #[test]
    fn refuses_pins_that_are_not_the_compiled_ones() {
        let mut pins: Vec<Pin> = PINS.iter().map(|p| Pin { file: p.file.into(), path: "/nonexistent".into(), bytes: p.bytes, sha256: p.sha256.into() }).collect();
        pins[1].bytes += 1;
        let reads = stats::get(&stats::FILE_READS);
        assert!(open(&pins).is_err());
        // Refused before reading anything past the mismatch.
        assert!(stats::get(&stats::FILE_READS) - reads <= 1);
    }
}
