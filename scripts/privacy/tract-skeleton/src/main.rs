//! Skeleton of the screen-text reader helper (ssw-ocr), to measure the size tract adds and to
//! smoke-test the whole read on a real frame: pinned size + SHA-256 checked before any model is
//! parsed, PP-OCRv6 detection on one tile of at most 1920x1088, DB map -> boxes (connected
//! components), each box cropped and read by the recogniser (symbolic width), CTC decode, one
//! JSON line per text line on stdout. No ffmpeg, QR, look/follow passes or Windows APIs.
//! Plans are concrete (tract runs symbolic widths 6-7 times slower): the detector for one tile
//! shape, the recogniser once per line width rounded up to a multiple of 64 (zero padding, as
//! PaddleOCR pads a batch). The files' value_info is ignored: it names the batch
//! DynamicDimension.0 in every intermediate shape, which tract cannot unify with a declared 1.
//!
//!   skeleton <models_dir> <frame.rgb> <width> <height> [rec=tiny|small]
use sha2::{Digest, Sha256};
use std::io::Write;
use std::time::Instant;
use tract_onnx::prelude::*;

struct Pinned {
    file: &'static str,
    size: u64,
    sha256: &'static str,
}

const DET: Pinned = Pinned { file: "PP-OCRv6_tiny_det_onnx/inference.onnx", size: 1_780_590, sha256: "193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8" };
const REC_TINY: Pinned = Pinned { file: "PP-OCRv6_tiny_rec_onnx/inference.onnx", size: 4_462_639, sha256: "9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6" };
const REC_SMALL: Pinned = Pinned { file: "PP-OCRv6_small_rec_onnx/inference.onnx", size: 21_159_378, sha256: "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634" };
const TILE_W: usize = 1920;
const TILE_H: usize = 1088;

fn verified(dir: &str, p: &Pinned) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(format!("{dir}/{}", p.file)).map_err(|e| format!("{}: {e}", p.file))?;
    if bytes.len() as u64 != p.size {
        return Err(format!("{}: {} bytes, pinned {}", p.file, bytes.len(), p.size));
    }
    let hex: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if hex != p.sha256 {
        return Err(format!("{}: sha256 {hex} is not the pinned one", p.file));
    }
    Ok(bytes)
}

/// The recogniser's character list from its inference.yml (PostProcess.character_dict), plus
/// the CTC blank at 0 and the space PaddleOCR appends at the end.
fn char_list(yml: &str) -> Vec<String> {
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
        let Some(item) = line.strip_prefix("  - ") else {
            if !line.starts_with("  ") {
                break;
            }
            continue;
        };
        let s = if item.len() >= 2 && item.starts_with('\'') && item.ends_with('\'') {
            item[1..item.len() - 1].replace("''", "'")
        } else if item.len() >= 2 && item.starts_with('"') && item.ends_with('"') {
            item[1..item.len() - 1].replace("\\\\", "\\").replace("\\\"", "\"")
        } else {
            item.to_string()
        };
        out.push(s);
    }
    out.push(" ".into());
    out
}

fn plan(bytes: &[u8], shape: &[usize]) -> TractResult<Arc<TypedRunnableModel>> {
    tract_onnx::onnx()
        .with_ignore_value_info(true)
        .model_for_read(&mut &bytes[..])?
        .with_input_fact(0, f32::fact(shape.to_vec()).into())?
        .into_optimized()?
        .into_runnable()
}

#[derive(Clone, Copy)]
struct Bx {
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
}

/// DB post-processing, simplified: threshold the probability map, 4-connected components, keep
/// those whose mean probability passes box_thresh, grow each box by the DB unclip distance.
fn boxes(prob: &[f32], w: usize, h: usize, thresh: f32, box_thresh: f32, unclip: f32) -> Vec<Bx> {
    let mut seen = vec![false; w * h];
    let mut out = vec![];
    let mut stack = vec![];
    for start in 0..w * h {
        if seen[start] || prob[start] <= thresh {
            continue;
        }
        seen[start] = true;
        stack.push(start);
        let (mut x0, mut y0, mut x1, mut y1, mut sum, mut n) = (w, h, 0, 0, 0f32, 0usize);
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            x0 = x0.min(x);
            x1 = x1.max(x);
            y0 = y0.min(y);
            y1 = y1.max(y);
            sum += prob[i];
            n += 1;
            let mut push = |j: usize| {
                if !seen[j] && prob[j] > thresh {
                    seen[j] = true;
                    stack.push(j);
                }
            };
            if x > 0 {
                push(i - 1);
            }
            if x + 1 < w {
                push(i + 1);
            }
            if y > 0 {
                push(i - w);
            }
            if y + 1 < h {
                push(i + w);
            }
        }
        let (bw, bh) = ((x1 - x0 + 1) as f32, (y1 - y0 + 1) as f32);
        if bw.min(bh) < 3.0 || sum / (n as f32) < box_thresh {
            continue;
        }
        let d = (bw * bh * unclip / (2.0 * (bw + bh))).round() as usize;
        out.push(Bx { x0: x0.saturating_sub(d), y0: y0.saturating_sub(d), x1: (x1 + d).min(w - 1), y1: (y1 + d).min(h - 1) });
    }
    out.sort_by_key(|b| (b.y0 / 8, b.x0));
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 4 {
        eprintln!("usage: skeleton <models_dir> <frame.rgb> <width> <height> [tiny|small]");
        std::process::exit(2);
    }
    let (dir, frame, fw, fh) = (&args[0], &args[1], args[2].parse::<usize>().unwrap(), args[3].parse::<usize>().unwrap());
    let rec_pin = if args.get(4).map(|s| s.as_str()) == Some("small") { &REC_SMALL } else { &REC_TINY };
    let t0 = Instant::now();
    // Every file is checked before any is parsed.
    let det_bytes = verified(dir, &DET).unwrap_or_else(|e| fail(&e));
    let rec_bytes = verified(dir, rec_pin).unwrap_or_else(|e| fail(&e));
    let yml_path = format!("{dir}/{}", rec_pin.file.replace("inference.onnx", "inference.yml"));
    let chars = char_list(&std::fs::read_to_string(yml_path).unwrap_or_else(|e| fail(&e.to_string())));
    let det = plan(&det_bytes, &[1, 3, TILE_H, TILE_W]).unwrap_or_else(|e| fail(&format!("det: {e:#}")));
    let mut recs: std::collections::HashMap<usize, Arc<TypedRunnableModel>> = Default::default();
    let open_ms = t0.elapsed().as_secs_f64() * 1e3;

    let rgb = std::fs::read(frame).unwrap_or_else(|e| fail(&e.to_string()));
    assert_eq!(rgb.len(), fw * fh * 3, "frame size");
    assert!(fw <= TILE_W && fh <= TILE_H, "one tile only in the skeleton");
    // Detection input: BGR order, ImageNet mean/std as PaddleOCR applies them, zero padding.
    let (mean, std) = ([0.485f32, 0.456, 0.406], [0.229f32, 0.224, 0.225]);
    let mut det_in = vec![0f32; 3 * TILE_H * TILE_W];
    for y in 0..fh {
        for x in 0..fw {
            let p = (y * fw + x) * 3;
            let bgr = [rgb[p + 2], rgb[p + 1], rgb[p]];
            for c in 0..3 {
                det_in[c * TILE_H * TILE_W + y * TILE_W + x] = (bgr[c] as f32 / 255.0 - mean[c]) / std[c];
            }
        }
    }
    let t1 = Instant::now();
    let out = det.run(tvec!(Tensor::from_shape(&[1, 3, TILE_H, TILE_W], &det_in).unwrap().into_tvalue())).unwrap_or_else(|e| fail(&format!("{e:#}")));
    let det_ms = t1.elapsed().as_secs_f64() * 1e3;
    let prob: Vec<f32> = out[0].to_plain_array_view::<f32>().unwrap().iter().copied().collect();
    let found = boxes(&prob, TILE_W, TILE_H, 0.2, 0.4, 1.4);

    let t2 = Instant::now();
    let stdout = std::io::stdout();
    let mut w = stdout.lock();
    for b in found.iter().filter(|b| b.x1 < fw && b.y1 < fh) {
        let (cw, ch) = (b.x1 - b.x0 + 1, b.y1 - b.y0 + 1);
        let rw = ((48.0 * cw as f32 / ch as f32).ceil() as usize).max(8);
        let iw = rw.max(320).div_ceil(64) * 64;
        let mut rec_in = vec![0f32; 3 * 48 * iw];
        for y in 0..48 {
            let sy = ((y as f32 + 0.5) * ch as f32 / 48.0 - 0.5).clamp(0.0, (ch - 1) as f32);
            let (y0, fy) = (sy.floor() as usize, sy.fract());
            let y1 = (y0 + 1).min(ch - 1);
            for x in 0..rw {
                let sx = ((x as f32 + 0.5) * cw as f32 / rw as f32 - 0.5).clamp(0.0, (cw - 1) as f32);
                let (x0, fx) = (sx.floor() as usize, sx.fract());
                let x1 = (x0 + 1).min(cw - 1);
                for c in 0..3 {
                    let px = |xx: usize, yy: usize| rgb[((b.y0 + yy) * fw + b.x0 + xx) * 3 + (2 - c)] as f32;
                    let v = (px(x0, y0) * (1.0 - fx) + px(x1, y0) * fx) * (1.0 - fy) + (px(x0, y1) * (1.0 - fx) + px(x1, y1) * fx) * fy;
                    rec_in[c * 48 * iw + y * iw + x] = (v / 255.0 - 0.5) / 0.5;
                }
            }
        }
        let rec = recs.entry(iw).or_insert_with(|| plan(&rec_bytes, &[1, 3, 48, iw]).unwrap_or_else(|e| fail(&format!("rec: {e:#}"))));
        let r = rec.run(tvec!(Tensor::from_shape(&[1, 3, 48, iw], &rec_in).unwrap().into_tvalue())).unwrap_or_else(|e| fail(&format!("{e:#}")));
        let view = r[0].to_plain_array_view::<f32>().unwrap();
        let (steps, classes) = (view.shape()[1], view.shape()[2]);
        let flat: Vec<f32> = view.iter().copied().collect();
        let (mut text, mut last, mut conf, mut n) = (String::new(), 0usize, 0f32, 0usize);
        for t in 0..steps {
            let row = &flat[t * classes..(t + 1) * classes];
            let (best, p) = row.iter().enumerate().fold((0, f32::MIN), |a, (i, &v)| if v > a.1 { (i, v) } else { a });
            if best != 0 && best != last {
                text.push_str(chars.get(best).map(|s| s.as_str()).unwrap_or("?"));
                conf += p;
                n += 1;
            }
            last = best;
        }
        let line = serde_json::json!({ "box": [b.x0, b.y0, cw, ch], "text": text, "conf": if n > 0 { conf / n as f32 } else { 0.0 } });
        writeln!(w, "{line}").unwrap();
    }
    let rec_ms = t2.elapsed().as_secs_f64() * 1e3;
    eprintln!("{}", serde_json::json!({ "openMs": open_ms, "detMs": det_ms, "recMs": rec_ms, "lines": found.len(), "chars": chars.len(), "recPlans": recs.len() }));
}

fn fail(msg: &str) -> ! {
    eprintln!("{}", serde_json::json!({ "error": msg }));
    std::process::exit(1)
}
