//! Follow sessions (docs/design/auto-blur.md §5.8): one session decodes what it is asked of a span
//! of the recording once, at half size in grey (the template scale), forward in order or backward
//! one piece at a time, newest first, keeping at most two pieces. A walk asks only the frames where
//! its text could have moved, so the session seeks over a stretch it is not asked (more than a
//! second forward, more than a piece backward) instead of decoding it, and works out a frame's
//! gradient only when it is asked. Main registers each hit as a track (its parts' templates cut at
//! one frame), then asks for every track of a frame at once: each part is matched by normalised
//! cross-correlation of Sobel gradient magnitude (which a selection, a highlight or dark mode does
//! not change) within ±4 template pixels of where each candidate move puts it.
//!
//! A candidate (dx, dy, scale) moves a track as a whole: a point p of the track at its template
//! frame goes to C + scale·(p − C) + (dx, dy), C being the centre of the track's parts then; dx and
//! dy are video pixels. A match answers, for the best candidate, its refined move, each asked
//! part's score at that one placement (so parts that disagree score low), and `second`: the best
//! score of any other place more than 2 video pixels away (another candidate, or another peak of
//! the search), so main can refuse a match that is not clearly the best (§5.8 step 4).

use crate::decode::{gray_bytes, Stream, EPS};
use crate::protocol::{r2, BoxF, Candidate, Failure, TrackAsk};
use crate::stats;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Search radius around each candidate's place, in template (half-size) pixels.
pub const RADIUS: i64 = 4;
/// A backward piece reaches at least this far below its end: from the key frame at or before it.
const PIECE_S: f64 = 0.5;
/// A backward piece keeps at most this much (a key-frame interval of up to a second, and PIECE_S).
const PIECE_MAX_S: f64 = 1.5;
/// A forward session seeks to a frame asked more than this after the newest it decoded, as reads
/// less than a second apart share one ffmpeg run (§5.5): seeking costs a process and at most one
/// key-frame interval, decoding on costs every frame between.
const SEEK_AHEAD_S: f64 = 1.0;
/// Frames a forward session keeps behind the newest one asked for.
const KEEP_FORWARD: usize = 8;
/// Gradients kept: a walk asks one frame several times in a row (near places, the rest, searches).
const KEEP_GRADIENTS: usize = 2;

/// A decoded frame: half size, grey.
pub struct Gray {
    pub t: f64,
    pub w: usize,
    pub h: usize,
    pub img: Vec<u8>,
}

/// A frame's Sobel gradient magnitude, what parts are cut from and matched against.
pub struct Grad {
    pub w: usize,
    pub h: usize,
    pub grad: Vec<f32>,
}

/// Sobel gradient magnitude, |gx| + |gy|.
pub fn sobel(img: &[u8], w: usize, h: usize) -> Vec<f32> {
    let mut g = vec![0f32; w * h];
    let at = |x: usize, y: usize| img[y * w + x] as f32;
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let gx = at(x + 1, y - 1) + 2.0 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2.0 * at(x - 1, y) - at(x - 1, y + 1);
            let gy = at(x - 1, y + 1) + 2.0 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2.0 * at(x, y - 1) - at(x + 1, y - 1);
            g[y * w + x] = gx.abs() + gy.abs();
        }
    }
    g
}

struct Template {
    /// Top-left at the track's frame, template pixels.
    x: f32,
    y: f32,
    w: usize,
    h: usize,
    /// Zero-mean gradient and its norm.
    data: Vec<f32>,
    norm: f32,
}

impl Template {
    fn new(x: f32, y: f32, w: usize, h: usize, raw: Vec<f32>) -> Option<Template> {
        let n = raw.len() as f32;
        if n < 4.0 {
            return None;
        }
        let mean = raw.iter().sum::<f32>() / n;
        let data: Vec<f32> = raw.iter().map(|v| v - mean).collect();
        let norm = data.iter().map(|v| v * v).sum::<f32>().sqrt();
        (norm > 1e-3).then_some(Template { x, y, w, h, data, norm })
    }

    /// The same template scaled by `s` (bilinear), about its own top-left.
    fn scaled(&self, s: f32) -> Option<Template> {
        let (w, h) = (((self.w as f32) * s).round().max(2.0) as usize, ((self.h as f32) * s).round().max(2.0) as usize);
        let mut raw = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (((x as f32 + 0.5) / s - 0.5).clamp(0.0, (self.w - 1) as f32), ((y as f32 + 0.5) / s - 0.5).clamp(0.0, (self.h - 1) as f32));
                let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
                let (x1, y1) = ((x0 + 1).min(self.w - 1), (y0 + 1).min(self.h - 1));
                let (ax, ay) = (fx - x0 as f32, fy - y0 as f32);
                let v = |xx: usize, yy: usize| self.data[yy * self.w + xx];
                raw[y * w + x] = (v(x0, y0) * (1.0 - ax) + v(x1, y0) * ax) * (1.0 - ay) + (v(x0, y1) * (1.0 - ax) + v(x1, y1) * ax) * ay;
            }
        }
        Template::new(self.x, self.y, w, h, raw)
    }

    /// NCC at top-left (x, y) of `g`; None outside the frame.
    fn score(&self, g: &Grad, x: i64, y: i64) -> Option<f32> {
        if x < 0 || y < 0 || x as usize + self.w > g.w || y as usize + self.h > g.h {
            return None;
        }
        stats::add(&stats::MATCHES, 1);
        let (x, y) = (x as usize, y as usize);
        let n = (self.w * self.h) as f32;
        let (mut sum, mut sum2, mut cross) = (0f32, 0f32, 0f32);
        for r in 0..self.h {
            let row = &g.grad[(y + r) * g.w + x..(y + r) * g.w + x + self.w];
            let t = &self.data[r * self.w..(r + 1) * self.w];
            for c in 0..self.w {
                let v = row[c];
                sum += v;
                sum2 += v * v;
                cross += v * t[c];
            }
        }
        let var = sum2 - sum * sum / n;
        if var <= 1e-3 {
            return Some(0.0);
        }
        // Σ t·(v − mean v) = Σ t·v, since t has zero mean.
        Some(cross / (self.norm * var.sqrt()))
    }
}

struct Track {
    cx: f32,
    cy: f32,
    parts: Vec<Option<Template>>,
}

pub struct Session {
    ffmpeg: String,
    video: String,
    dir: i32,
    from: f64,
    to: f64,
    /// Kept frames, oldest first.
    frames: VecDeque<Arc<Gray>>,
    forward: Option<Stream>,
    /// Frames the forward stream had decoded when last counted.
    forward_counted: u64,
    /// Backward: the kept frames are every frame of [low, high) (contiguous pieces).
    low: f64,
    high: f64,
    /// Backward: the kept pieces as [start, end), newest first, at most two.
    pieces: VecDeque<(f64, f64)>,
    /// Backward: the kept span reaches the span's start (nothing below it is decoded).
    reached: bool,
    grads: VecDeque<(f64, Arc<Grad>)>,
    tracks: HashMap<u64, Track>,
    pub decoded: u64,
}

fn half_vf(select: &str) -> String {
    format!("select='{select}',scale=trunc(iw/2):trunc(ih/2):flags=area,format=gray,showinfo=checksum=0")
}

impl Session {
    pub fn open(ffmpeg: &str, video: &str, key: f64, from: f64, to: f64, dir: i32) -> Result<Session, Failure> {
        if !(to >= from) {
            return Err(Failure::BadCommand);
        }
        let mut s = Session { ffmpeg: ffmpeg.into(), video: video.into(), dir, from, to, frames: VecDeque::new(), forward: None, forward_counted: 0, low: to + EPS, high: to + EPS, pieces: VecDeque::new(), reached: false, grads: VecDeque::new(), tracks: HashMap::new(), decoded: 0 };
        if dir > 0 {
            s.start_forward(key.min(from), from)?;
            // The first frame now, so a broken video fails the open.
            s.pull_forward()?.ok_or(Failure::Video)?;
        } else {
            crate::decode::check_size(video)?;
            s.decode_piece()?;
        }
        Ok(s)
    }

    pub fn json(&self, id: u64) -> Value {
        json!({ "id": id, "session": { "from": self.from, "to": self.to, "frames": self.decoded } })
    }

    fn keep(&mut self, img: Vec<u8>, t: f64, w: usize, h: usize) -> Arc<Gray> {
        self.decoded += 1;
        stats::add(&stats::FOLLOW_FRAMES, 1);
        Arc::new(Gray { t, w, h, img })
    }

    fn note_kept(&self) {
        stats::FOLLOW_KEPT_MAX.fetch_max(self.frames.len() as u64, std::sync::atomic::Ordering::Relaxed);
    }

    /// The gradient of a frame asked, worked out once (the last few are kept).
    fn grad(&mut self, g: &Gray) -> Arc<Grad> {
        if let Some((_, d)) = self.grads.iter().find(|(t, _)| (t - g.t).abs() < EPS) {
            return d.clone();
        }
        stats::add(&stats::FOLLOW_GRADIENTS, 1);
        let d = Arc::new(Grad { w: g.w, h: g.h, grad: sobel(&g.img, g.w, g.h) });
        self.grads.push_front((g.t, d.clone()));
        self.grads.truncate(KEEP_GRADIENTS);
        d
    }

    /// Forward: a stream of the span's frames from `from` on, decoded from the key frame at or before `seek`.
    fn start_forward(&mut self, seek: f64, from: f64) -> Result<(), Failure> {
        self.count_forward();
        self.forward = None;
        let select = format!("gte(t\\,{})*lte(t\\,{})", crate::ffmpeg::secs(from - EPS), crate::ffmpeg::secs(self.to + EPS));
        let limit = Duration::from_secs_f64(60.0 + (self.to - seek).max(0.0));
        self.forward = Some(Stream::open(&self.ffmpeg, &self.video, seek, &half_vf(&select), 1, limit, gray_bytes)?);
        self.forward_counted = 0;
        stats::add(&stats::FOLLOW_RUNS, 1);
        Ok(())
    }

    fn count_forward(&mut self) {
        if let Some(stream) = self.forward.as_ref() {
            stats::add(&stats::FOLLOW_DECODED, stream.decoded - self.forward_counted);
            self.forward_counted = stream.decoded;
        }
    }

    fn pull_forward(&mut self) -> Result<Option<Arc<Gray>>, Failure> {
        let Some(stream) = self.forward.as_mut() else { return Ok(None) };
        let next = stream.next();
        self.count_forward();
        match next? {
            Some((info, img)) => {
                let g = self.keep(img, info.t, info.w, info.h);
                self.frames.push_back(g.clone());
                while self.frames.len() > KEEP_FORWARD {
                    self.frames.pop_front();
                }
                self.note_kept();
                Ok(Some(g))
            }
            None => {
                self.forward = None;
                Ok(None)
            }
        }
    }

    /// Backward: the piece just below the kept span: every frame from the key frame at or before
    /// PIECE_S below it (at most PIECE_MAX_S of them) up to it, so the piece below this one starts
    /// where this one did and no frame is decoded twice. A piece reaching the span's start seeks to
    /// the start itself: nothing before it is wanted. False once the span's start is reached.
    fn decode_piece(&mut self) -> Result<bool, Failure> {
        if self.reached {
            return Ok(false);
        }
        let hi = self.low;
        let want = hi - PIECE_S;
        let reaches_from = want <= self.from;
        let keep_from = if reaches_from { self.from - EPS } else { (hi - PIECE_MAX_S).max(self.from - EPS) };
        // The selection reaches past the piece (`PAST`) and the run ends at the first frame of it after
        // the piece: ffmpeg holds a frame's pixels until the next selected one, and with the selection
        // ending at the piece's end, the piece's last frame came only once the rest of the recording was
        // decoded (10.8 s a piece of a 144 s recording against 0.13 s; a backward session over it did not
        // finish in 20 minutes).
        let select = format!("gte(t\\,{})*lt(t\\,{})", crate::ffmpeg::secs(keep_from), crate::ffmpeg::secs(hi + crate::decode::PAST));
        let vf = half_vf(&select);
        let limit = Duration::from_secs(60);
        let stream = if reaches_from { Stream::open(&self.ffmpeg, &self.video, keep_from.max(0.0), &vf, 1, limit, gray_bytes) } else { Stream::open_from_key(&self.ffmpeg, &self.video, want.max(0.0), &vf, 1, limit, gray_bytes) };
        let mut stream = stream?.until(hi);
        stats::add(&stats::FOLLOW_RUNS, 1);
        let mut got = vec![];
        let ended = loop {
            match stream.next() {
                Ok(Some((info, img))) => {
                    if info.t >= hi {
                        break Ok(());
                    }
                    got.push(self.keep(img, info.t, info.w, info.h));
                }
                Ok(None) => break Ok(()),
                Err(f) => break Err(f),
            }
        };
        stats::add(&stats::FOLLOW_DECODED, stream.decoded);
        drop(stream);
        ended?;
        // The piece starts at its first frame (the key frame it was decoded from), or where it was asked
        // to when it holds none; a piece reaching the span's start ends the session's pieces.
        let lo = if reaches_from { self.from - EPS } else { got.first().map_or(want, |g| g.t) };
        self.low = lo;
        self.reached = reaches_from;
        if self.pieces.is_empty() {
            self.high = hi;
        }
        self.pieces.push_back((lo, hi));
        // Keep the newest two pieces: drop the frames of anything newer.
        while self.pieces.len() > 2 {
            self.pieces.pop_front();
            self.high = self.pieces[0].1;
        }
        let high = self.high;
        self.frames.retain(|f| f.t < high);
        for g in got.into_iter().rev() {
            self.frames.push_front(g);
        }
        self.note_kept();
        Ok(true)
    }

    /// Backward: drops what is kept and starts again with the piece holding `t` (the walk asks
    /// nothing between, §5.8): its frames from the key frame at or before it to just past it.
    fn jump_back(&mut self, t: f64) -> Result<(), Failure> {
        self.frames.clear();
        self.pieces.clear();
        self.reached = false;
        self.high = (t + crate::decode::PAST).min(self.to + EPS);
        self.low = self.high;
        if !self.decode_piece()? {
            return Err(Failure::Video);
        }
        Ok(())
    }

    /// The frame at `t` (the first at or after it within the span).
    fn frame_at(&mut self, t: f64) -> Result<Arc<Gray>, Failure> {
        if self.dir > 0 {
            return self.frame_forward(t);
        }
        let mut jumped = false;
        loop {
            if t >= self.low - EPS && t < self.high {
                // Pieces are contiguous: the first kept frame at or after t is the one at t, never a
                // frame of a newer piece standing in for it.
                if let Some(f) = self.frames.iter().find(|f| f.t >= t - EPS && f.t < t + 0.1).cloned() {
                    // A walk back never asks above this again: what is kept is one piece and the
                    // frames just above the frame asked (an ask above them starts again there).
                    let cut = t + 0.1 + EPS;
                    if cut < self.high {
                        self.frames.retain(|g| g.t < cut);
                        self.high = cut;
                    }
                    return Ok(f);
                }
                if self.high >= self.to + EPS {
                    return Err(Failure::Video);
                }
            } else if t < self.low - EPS && t >= self.low - PIECE_S - EPS {
                // The next piece down holds it.
                if !self.decode_piece()? {
                    return Err(Failure::Video);
                }
                continue;
            }
            if jumped || t < self.from - EPS || t > self.to + EPS {
                return Err(Failure::Video);
            }
            self.jump_back(t)?;
            jumped = true;
        }
    }

    /// Forward: decodes on to `t`, or seeks to it when it is more than SEEK_AHEAD_S after the newest
    /// frame decoded.
    fn frame_forward(&mut self, t: f64) -> Result<Arc<Gray>, Failure> {
        let mut sought = false;
        loop {
            if let Some(f) = self.frames.iter().find(|f| f.t >= t - EPS && f.t < t + 0.1) {
                return Ok(f.clone());
            }
            let newest = self.frames.back().map_or(f64::MIN, |f| f.t);
            if newest > t + 0.1 {
                return Err(Failure::Video);
            }
            if !sought && t - newest > SEEK_AHEAD_S && t <= self.to + EPS {
                self.start_forward((t - EPS).max(0.0), t)?;
                self.frames.clear();
                sought = true;
            }
            if self.pull_forward()?.is_none() {
                return Err(Failure::Video);
            }
        }
    }

    /// Registers `track` with its parts (video pixels) cut at the frame at `t`.
    pub fn track(&mut self, track: u64, t: f64, parts: &[BoxF]) -> Result<(), Failure> {
        let frame = self.frame_at(t)?;
        let g = self.grad(&frame);
        let mut union = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
        let mut temps = vec![];
        for p in parts {
            let (x, y, w, h) = ((p[0] / 2.0) as f32, (p[1] / 2.0) as f32, (p[2] / 2.0) as f32, (p[3] / 2.0) as f32);
            union = [union[0].min(x), union[1].min(y), union[2].max(x + w), union[3].max(y + h)];
            let pad = 0.25 * h;
            let x0 = (x - pad).floor().max(0.0) as usize;
            let y0 = (y - pad).floor().max(0.0) as usize;
            let x1 = ((x + w + pad).ceil() as usize).min(g.w);
            let y1 = ((y + h + pad).ceil() as usize).min(g.h);
            let t = if x1 > x0 + 1 && y1 > y0 + 1 {
                let mut raw = Vec::with_capacity((x1 - x0) * (y1 - y0));
                for yy in y0..y1 {
                    raw.extend_from_slice(&g.grad[yy * g.w + x0..yy * g.w + x1]);
                }
                Template::new(x0 as f32, y0 as f32, x1 - x0, y1 - y0, raw)
            } else {
                None
            };
            temps.push(t);
        }
        if temps.is_empty() {
            return Err(Failure::BadCommand);
        }
        self.tracks.insert(track, Track { cx: (union[0] + union[2]) / 2.0, cy: (union[1] + union[3]) / 2.0, parts: temps });
        Ok(())
    }

    /// Every asked track at the frame at `t` (one `matched` answer).
    pub fn match_all(&mut self, t: f64, asks: &[TrackAsk]) -> Result<Value, Failure> {
        let frame = self.frame_at(t)?;
        let g = self.grad(&frame);
        let started = Instant::now();
        let mut out = vec![];
        for ask in asks {
            let Some(track) = self.tracks.get(&ask.track) else { return Err(Failure::BadCommand) };
            out.push(match_track(track, &g, ask));
        }
        stats::add(&stats::MATCH_NS, started.elapsed().as_nanos() as u64);
        Ok(Value::Array(out))
    }
}

/// Where candidate `c` puts the top-left of a template of `track` (template pixels).
fn place(track: &Track, tp: &Template, c: &Candidate) -> (f32, f32) {
    let s = c.scale as f32;
    (track.cx + s * (tp.x - track.cx) + c.dx as f32 / 2.0, track.cy + s * (tp.y - track.cy) + c.dy as f32 / 2.0)
}

fn match_track(track: &Track, g: &Grad, ask: &TrackAsk) -> Value {
    let parts: Vec<usize> = ask.parts.iter().copied().filter(|&i| track.parts.get(i).is_some_and(Option::is_some)).collect();
    // Per candidate: the best part score, its refined move, and the other peaks of its windows.
    struct Best {
        score: f32,
        dx: f64,
        dy: f64,
        cand: usize,
    }
    let mut results: Vec<Best> = vec![];
    let mut peaks: Vec<(f64, f64, f32)> = vec![];
    let mut scaled: HashMap<(usize, u64), Template> = HashMap::new();
    for (ci, c) in ask.candidates.iter().enumerate() {
        let mut best: Option<Best> = None;
        for &pi in &parts {
            let base = track.parts[pi].as_ref().unwrap();
            let key = (pi, c.scale.to_bits());
            let tp = if (c.scale - 1.0).abs() < 1e-6 {
                base
            } else {
                if !scaled.contains_key(&key) {
                    match base.scaled(c.scale as f32) {
                        Some(s) => {
                            scaled.insert(key, s);
                        }
                        None => continue,
                    }
                }
                &scaled[&key]
            };
            let (px, py) = place(track, tp, c);
            let (bx, by) = (px.round() as i64, py.round() as i64);
            let side = (2 * RADIUS + 1) as usize;
            let mut grid = vec![f32::MIN; side * side];
            for oy in -RADIUS..=RADIUS {
                for ox in -RADIUS..=RADIUS {
                    if let Some(v) = tp.score(g, bx + ox, by + oy) {
                        grid[((oy + RADIUS) as usize) * side + (ox + RADIUS) as usize] = v;
                    }
                }
            }
            for gy in 0..side {
                for gx in 0..side {
                    let v = grid[gy * side + gx];
                    if v == f32::MIN {
                        continue;
                    }
                    let local = (gy.saturating_sub(1)..=(gy + 1).min(side - 1)).all(|yy| (gx.saturating_sub(1)..=(gx + 1).min(side - 1)).all(|xx| grid[yy * side + xx] <= v));
                    // The move this place means, in video pixels.
                    let dx = c.dx + 2.0 * ((bx + gx as i64 - RADIUS) as f64 - px as f64);
                    let dy = c.dy + 2.0 * ((by + gy as i64 - RADIUS) as f64 - py as f64);
                    if local {
                        peaks.push((dx, dy, v));
                    }
                    if best.as_ref().is_none_or(|b| v > b.score) {
                        best = Some(Best { score: v, dx, dy, cand: ci });
                    }
                }
            }
        }
        if let Some(b) = best {
            results.push(b);
        }
    }
    let Some(top) = results.iter().max_by(|a, b| a.score.total_cmp(&b.score)) else {
        return json!({ "track": ask.track, "parts": ask.parts.iter().map(|_| Value::Null).collect::<Vec<_>>(), "best": Value::Null, "second": 0 });
    };
    let c = ask.candidates[top.cand];
    let refined = Candidate { dx: top.dx, dy: top.dy, scale: c.scale };
    let second = results
        .iter()
        .map(|r| (r.dx, r.dy, r.score))
        .chain(peaks.iter().copied())
        .filter(|(dx, dy, _)| (dx - top.dx).abs().max((dy - top.dy).abs()) > 2.0)
        .map(|p| p.2)
        .fold(0f32, f32::max);
    // Every asked part's score at the one placement the best move gives.
    let part_scores: Vec<Value> = ask
        .parts
        .iter()
        .map(|&pi| {
            let Some(Some(base)) = track.parts.get(pi) else { return Value::Null };
            let tp = if (c.scale - 1.0).abs() < 1e-6 { Some(base) } else { scaled.get(&(pi, c.scale.to_bits())) };
            let Some(tp) = tp else { return Value::Null };
            let (px, py) = place(track, tp, &refined);
            tp.score(g, px.round() as i64, py.round() as i64).map_or(Value::Null, |v| json!(r2(v as f64)))
        })
        .collect();
    json!({
        "track": ask.track,
        "parts": part_scores,
        "best": { "dx": r2(top.dx), "dy": r2(top.dy), "scale": c.scale },
        "second": r2(second.max(0.0) as f64),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_like(w: usize, h: usize, at: (usize, usize), invert: bool) -> Vec<u8> {
        let mut v = vec![if invert { 20u8 } else { 235 }; w * h];
        for i in 0..12 {
            for y in 0..10 {
                for x in 0..4 {
                    // Glyph-like strokes of varying shape.
                    if (x + y * (i % 3 + 1)) % 5 < 2 {
                        let (xx, yy) = (at.0 + i * 6 + x, at.1 + y);
                        v[yy * w + xx] = if invert { 235 } else { 20 };
                    }
                }
            }
        }
        v
    }

    fn gray(img: Vec<u8>, w: usize, h: usize) -> Grad {
        Grad { w, h, grad: sobel(&img, w, h) }
    }

    #[test]
    fn places_parts_on_inverted_text_and_refines_the_move() {
        let (w, h) = (200, 80);
        let a = gray(text_like(w, h, (40, 30), false), w, h);
        let raw: Vec<f32> = {
            let (x0, y0, tw, th) = (37, 27, 78, 16);
            (y0..y0 + th).flat_map(|y| a.grad[y * w + x0..y * w + x0 + tw].to_vec()).collect()
        };
        let track = Track { cx: 76.0, cy: 35.0, parts: vec![Template::new(37.0, 27.0, 78, 16, raw)] };
        let b = gray(text_like(w, h, (43, 28), true), w, h);
        let ask = TrackAsk { track: 1, parts: vec![0], candidates: vec![Candidate { dx: 0.0, dy: 0.0, scale: 1.0 }] };
        let m = match_track(&track, &b, &ask);
        assert!(m["parts"][0].as_f64().unwrap() > 0.9, "{m}");
        assert_eq!((m["best"]["dx"].as_f64().unwrap(), m["best"]["dy"].as_f64().unwrap()), (6.0, -4.0));
    }
}
