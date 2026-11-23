//! The look pass (docs/design/auto-blur.md §5.2): every frame is decoded once, every analysed frame
//! (each `step`-th) scaled to the look size (1/k) in grey, and compared with the last analysed one.
//! It answers, per analysed frame, its time, whether it is a key frame, which 8×8 look-pixel tiles
//! changed, and how each changed region of at least 12×6 tiles moved. No pixels and no text leave
//! the pass.
//!
//! Conventions main reads (P4 `look.ts`):
//! - `tiles` is base64 of a bit string over the tile grid (ceil(w/8) × ceil(h/8) of the look
//!   frame, row by row); tile i is bit (i % 8) of byte i / 8, least significant bit first. The
//!   first analysed frame has every tile changed.
//! - a move's `box` is in video pixels; `dx`, `dy` are how far the region's content moved from the
//!   last analysed frame to this one, in video pixels, positive to the right and down, refined to a
//!   fraction of a look pixel. `alt` holds up to two other candidates scoring at least 0.85 of the
//!   best, and the diagonal one when its 2-D score is 0.9 or more.

use crate::control;
use crate::decode::{gray_bytes, Stream, EPS};
use crate::protocol::{r2, Failure, Out};
use crate::stats;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub const TILE: usize = 8;
const CHANGED_MEAN: f32 = 2.0;
const CHANGED_MAX: u8 = 24;
const MIN_REGION: (usize, usize) = (12, 6);
const BATCH_FRAMES: usize = 1000;
const BATCH_BYTES: usize = 1 << 20;

pub fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Gradient magnitude (|dx| + |dy| of central differences), the measure moves are matched on.
pub fn gradient(img: &[u8], w: usize, h: usize) -> Vec<f32> {
    let mut g = vec![0f32; w * h];
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let i = y * w + x;
            let dx = img[i + 1] as f32 - img[i - 1] as f32;
            let dy = img[i + w] as f32 - img[i - w] as f32;
            g[i] = dx.abs() + dy.abs();
        }
    }
    g
}

/// Normalised cross-correlation of two equal-length series.
fn ncc(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    if n < 2 {
        return 0.0;
    }
    let (ma, mb) = (a[..n].iter().sum::<f32>() / n as f32, b[..n].iter().sum::<f32>() / n as f32);
    let (mut sab, mut saa, mut sbb) = (0f32, 0f32, 0f32);
    for i in 0..n {
        let (da, db) = (a[i] - ma, b[i] - mb);
        sab += da * db;
        saa += da * da;
        sbb += db * db;
    }
    if saa <= 1e-6 || sbb <= 1e-6 {
        0.0
    } else {
        sab / (saa * sbb).sqrt()
    }
}

/// The NCC of `cur` (the region's profile, starting at `start`) against `prev` (the whole frame's
/// profile) for every shift up to `max`: cur[i] against prev[i - shift].
fn profile_scores(cur: &[f32], prev: &[f32], start: usize, max: i64) -> Vec<(i64, f32)> {
    let n = cur.len() as i64;
    let mut out = vec![];
    for s in -max..=max {
        let lo = (0i64).max(s - start as i64);
        let hi = n.min(prev.len() as i64 + s - start as i64);
        if hi - lo < (n / 2).max(4) {
            continue;
        }
        let a = &cur[lo as usize..hi as usize];
        let b = &prev[(start as i64 + lo - s) as usize..(start as i64 + hi - s) as usize];
        out.push((s, ncc(a, b)));
    }
    out
}

/// Up to three best local maxima of `scores`, refined by a parabola through their neighbours.
fn peaks(scores: &[(i64, f32)]) -> Vec<(f32, f32)> {
    let mut out = vec![];
    for i in 0..scores.len() {
        let v = scores[i].1;
        let left = if i > 0 { scores[i - 1].1 } else { f32::MIN };
        let right = scores.get(i + 1).map_or(f32::MIN, |s| s.1);
        if v >= left && v >= right {
            let mut s = scores[i].0 as f32;
            if i > 0 && i + 1 < scores.len() {
                let d = left - 2.0 * v + right;
                if d < 0.0 {
                    s += (0.5 * (left - right) / d).clamp(-0.5, 0.5);
                }
            }
            out.push((s, v));
        }
    }
    out.sort_by(|a, b| b.1.total_cmp(&a.1));
    out.truncate(3);
    out
}

/// The 2-D NCC of the region's gradient against the last frame's moved by (dx, dy).
fn ncc2(cur: &[f32], prev: &[f32], w: usize, h: usize, r: [usize; 4], dx: i64, dy: i64) -> f32 {
    let [x0, y0, rw, rh] = r;
    let (mut a, mut b) = (Vec::with_capacity(rw * rh), Vec::with_capacity(rw * rh));
    for y in y0..y0 + rh {
        let py = y as i64 - dy;
        if py < 0 || py >= h as i64 {
            continue;
        }
        for x in x0..x0 + rw {
            let px = x as i64 - dx;
            if px < 0 || px >= w as i64 {
                continue;
            }
            a.push(cur[y * w + x]);
            b.push(prev[py as usize * w + px as usize]);
        }
    }
    if a.len() < rw * rh / 2 {
        return 0.0;
    }
    ncc(&a, &b)
}

/// Changed tiles joined into regions (8-connected, then boxes within 2 tiles merged), in tiles.
pub fn regions(bits: &[bool], tx: usize, ty: usize) -> Vec<[usize; 4]> {
    let mut seen = vec![false; bits.len()];
    let mut boxes: Vec<[usize; 4]> = vec![];
    for start in 0..bits.len() {
        if !bits[start] || seen[start] {
            continue;
        }
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
        let mut stack = vec![start];
        seen[start] = true;
        while let Some(i) = stack.pop() {
            let (x, y) = (i % tx, i / tx);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
            for ny in y.saturating_sub(1)..=(y + 1).min(ty - 1) {
                for nx in x.saturating_sub(1)..=(x + 1).min(tx - 1) {
                    let j = ny * tx + nx;
                    if bits[j] && !seen[j] {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
        }
        boxes.push([x0, y0, x1 + 1, y1 + 1]);
    }
    // Boxes within 2 tiles of each other are one region.
    loop {
        let mut merged = false;
        'outer: for i in 0..boxes.len() {
            for j in i + 1..boxes.len() {
                let (a, b) = (boxes[i], boxes[j]);
                let near = a[0] <= b[2] + 2 && b[0] <= a[2] + 2 && a[1] <= b[3] + 2 && b[1] <= a[3] + 2;
                if near {
                    boxes[i] = [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])];
                    boxes.remove(j);
                    merged = true;
                    break 'outer;
                }
            }
        }
        if !merged {
            break;
        }
    }
    boxes.into_iter().map(|b| [b[0], b[1], b[2] - b[0], b[3] - b[1]]).collect()
}

pub struct Analyser {
    k: usize,
    w: usize,
    h: usize,
    prev: Option<(Vec<u8>, Vec<f32>)>,
}

impl Analyser {
    pub fn new(k: usize, w: usize, h: usize) -> Self {
        Analyser { k, w, h, prev: None }
    }

    /// One analysed frame: its changed tiles (bits) and its moves.
    pub fn frame(&mut self, img: Vec<u8>) -> (Vec<bool>, Vec<Value>) {
        let (w, h) = (self.w, self.h);
        let (tx, ty) = (w.div_ceil(TILE), h.div_ceil(TILE));
        let grad = gradient(&img, w, h);
        let Some((prev, pgrad)) = self.prev.take() else {
            self.prev = Some((img, grad));
            return (vec![true; tx * ty], vec![]);
        };
        let mut bits = vec![false; tx * ty];
        for t in 0..tx * ty {
            let (x0, y0) = ((t % tx) * TILE, (t / tx) * TILE);
            let (mut sum, mut max, mut n) = (0u32, 0u8, 0u32);
            for y in y0..(y0 + TILE).min(h) {
                for x in x0..(x0 + TILE).min(w) {
                    let d = img[y * w + x].abs_diff(prev[y * w + x]);
                    sum += d as u32;
                    max = max.max(d);
                    n += 1;
                }
            }
            bits[t] = n > 0 && (sum as f32 / n as f32 > CHANGED_MEAN || max > CHANGED_MAX);
        }
        let mut moves = vec![];
        for r in regions(&bits, tx, ty) {
            if r[2] < MIN_REGION.0 || r[3] < MIN_REGION.1 {
                continue;
            }
            let px = [r[0] * TILE, r[1] * TILE, (r[2] * TILE).min(w - r[0] * TILE), (r[3] * TILE).min(h - r[1] * TILE)];
            if let Some(m) = self.move_of(&grad, &pgrad, px) {
                moves.push(m);
            }
        }
        self.prev = Some((img, grad));
        (bits, moves)
    }

    fn move_of(&self, cur: &[f32], prev: &[f32], r: [usize; 4]) -> Option<Value> {
        let (w, h, k) = (self.w, self.h, self.k as f32);
        let [x0, y0, rw, rh] = r;
        // Row profiles over the region's columns, and column profiles over its rows.
        let row = |g: &[f32], y: usize| (x0..x0 + rw).map(|x| g[y * w + x]).sum::<f32>();
        let col = |g: &[f32], x: usize| (y0..y0 + rh).map(|y| g[y * w + x]).sum::<f32>();
        let cur_rows: Vec<f32> = (y0..y0 + rh).map(|y| row(cur, y)).collect();
        let prev_rows: Vec<f32> = (0..h).map(|y| row(prev, y)).collect();
        let cur_cols: Vec<f32> = (x0..x0 + rw).map(|x| col(cur, x)).collect();
        let prev_cols: Vec<f32> = (0..w).map(|x| col(prev, x)).collect();
        let dys = peaks(&profile_scores(&cur_rows, &prev_rows, y0, (rh / 2) as i64));
        let dxs = peaks(&profile_scores(&cur_cols, &prev_cols, x0, (rw / 2) as i64));
        let mut cands: Vec<(f32, f32, f32)> = vec![];
        let push = |dx: f32, dy: f32, cands: &mut Vec<(f32, f32, f32)>| {
            if cands.iter().any(|c| (c.0 - dx).abs() < 0.5 && (c.1 - dy).abs() < 0.5) {
                return;
            }
            let s = ncc2(cur, prev, w, h, r, dx.round() as i64, dy.round() as i64);
            cands.push((dx, dy, s));
        };
        for &(dy, _) in &dys {
            push(0.0, dy, &mut cands);
        }
        for &(dx, _) in &dxs {
            push(dx, 0.0, &mut cands);
        }
        push(0.0, 0.0, &mut cands);
        let diagonal = match (dxs.first(), dys.first()) {
            (Some(&(dx, _)), Some(&(dy, _))) if dx.round() != 0.0 && dy.round() != 0.0 => {
                push(dx, dy, &mut cands);
                cands.last().copied().filter(|c| (c.0 - dx).abs() < 0.5 && (c.1 - dy).abs() < 0.5)
            }
            _ => None,
        };
        cands.sort_by(|a, b| b.2.total_cmp(&a.2));
        let best = *cands.first()?;
        let mut alt: Vec<(f32, f32, f32)> = cands.iter().skip(1).filter(|c| c.2 >= 0.85 * best.2).take(2).copied().collect();
        if let Some(d) = diagonal {
            if d.2 >= 0.9 && d != best && !alt.contains(&d) {
                alt.push(d);
            }
        }
        let v = |x: f32| r2((x * k) as f64);
        Some(json!({
            "box": [(x0 as f32 * k) as f64, (y0 as f32 * k) as f64, (rw as f32 * k) as f64, (rh as f32 * k) as f64],
            "dx": v(best.0),
            "dy": v(best.1),
            "score": r2(best.2 as f64 * 100.0) / 100.0,
            "alt": alt.iter().map(|c| json!([v(c.0), v(c.1), r2(c.2 as f64 * 100.0) / 100.0])).collect::<Vec<_>>(),
        }))
    }
}

fn pack(bits: &[bool]) -> String {
    let mut bytes = vec![0u8; bits.len().div_ceil(8)];
    for (i, &b) in bits.iter().enumerate() {
        if b {
            bytes[i / 8] |= 1 << (i % 8);
        }
    }
    base64(&bytes)
}

/// The look pass over [from, to] of `video`, answered in batches.
pub fn run(id: u64, ffmpeg: &str, video: &str, k: u32, step: u32, from: f64, to: f64, out: &Out) -> Result<(), Failure> {
    let vf = format!("select='not(mod(n\\,{step}))',scale=trunc(iw/{k}):trunc(ih/{k}):flags=area,format=gray,showinfo=checksum=0");
    let limit = Duration::from_secs_f64(60.0 + (to - from).max(0.0));
    let mut stream = Stream::open(ffmpeg, video, from, &vf, 2, limit, gray_bytes)?;
    let mut analyser: Option<Analyser> = None;
    let mut batch: Vec<Value> = vec![];
    let mut bytes = 0usize;
    while let Some((info, img)) = stream.next()? {
        control::checkpoint(id)?;
        if info.t > to + EPS {
            break;
        }
        let a = analyser.get_or_insert_with(|| Analyser::new(k as usize, info.w, info.h));
        if (a.w, a.h) != (info.w, info.h) {
            return Err(Failure::Video);
        }
        let t0 = Instant::now();
        let (bits, moves) = a.frame(img);
        stats::add(&stats::LOOK_NS, t0.elapsed().as_nanos() as u64);
        stats::add(&stats::LOOK_FRAMES, 1);
        let f = json!({ "t": info.t, "key": info.key, "tiles": pack(&bits), "moves": moves });
        bytes += f.to_string().len();
        batch.push(f);
        if batch.len() >= BATCH_FRAMES || bytes >= BATCH_BYTES {
            out.send(json!({ "id": id, "look": std::mem::take(&mut batch), "done": false }));
            bytes = 0;
        }
    }
    if analyser.is_none() && stream.size.is_none() {
        return Err(Failure::Video);
    }
    out.send(json!({ "id": id, "look": batch, "done": true }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(&[0xff]), "/w==");
        assert_eq!(pack(&[true, false, false, false, false, false, false, false, false, true]), base64(&[1, 2]));
    }

    fn stripes(w: usize, h: usize, shift_x: i64, shift_y: i64) -> Vec<u8> {
        let mut v = vec![0u8; w * h];
        for y in 0..h {
            for x in 0..w {
                let (sx, sy) = (x as i64 - shift_x, y as i64 - shift_y);
                // Blocks of varied sizes, like words on lines, that do not repeat in the search range.
                let (bx, by) = (sx.div_euclid(5), sy.div_euclid(3));
                let hsh = (bx.wrapping_mul(73_856_093) ^ by.wrapping_mul(19_349_663)).rem_euclid(101);
                v[y * w + x] = if hsh < 45 && sy.rem_euclid(3) != 2 { 220 } else { 30 };
            }
        }
        v
    }

    #[test]
    fn finds_a_vertical_and_a_diagonal_move() {
        let (w, h) = (160, 96);
        let mut a = Analyser::new(4, w, h);
        a.frame(stripes(w, h, 0, 0));
        let (bits, moves) = a.frame(stripes(w, h, 0, -5));
        assert!(bits.iter().any(|&b| b));
        let m = &moves[0];
        assert!((m["dy"].as_f64().unwrap() - -20.0).abs() <= 1.0 && m["dx"].as_f64().unwrap().abs() <= 1.0, "{m}");
        let (_, moves) = a.frame(stripes(w, h, 3, -9));
        let m = &moves[0];
        let all: Vec<(f64, f64)> = std::iter::once((m["dx"].as_f64().unwrap(), m["dy"].as_f64().unwrap())).chain(m["alt"].as_array().unwrap().iter().map(|c| (c[0].as_f64().unwrap(), c[1].as_f64().unwrap()))).collect();
        assert!(all.iter().any(|&(dx, dy)| (dx - 12.0).abs() <= 1.0 && (dy - -16.0).abs() <= 1.0), "{m}");
    }

    #[test]
    fn joins_tiles_within_two_into_one_region() {
        let (tx, ty) = (20, 10);
        let mut bits = vec![false; tx * ty];
        bits[0] = true;
        bits[3] = true; // 2 tiles apart: one region
        bits[15] = true; // far: its own
        let r = regions(&bits, tx, ty);
        assert_eq!(r.len(), 2);
        assert!(r.contains(&[0, 0, 4, 1]));
    }
}
