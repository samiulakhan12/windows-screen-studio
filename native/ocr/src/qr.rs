//! QR codes in a read's areas (docs/design/auto-blur.md §6.9, §10.3). The finder patterns (the
//! three 1:1:3:1:1 squares in a code's corners) are found first by a scan of the area's rows and
//! columns, dark on light and light on dark (a dark theme draws codes inverted); rqrr then reads
//! the square around each group of them, at twice the size when the modules are small. A group of
//! three finder patterns that rqrr cannot read is still reported, with no payload, so it is
//! covered as a code that could not be read.
//!
//! A code's payload goes back only in the read's answer, where main classes it and forgets it; it
//! is never written anywhere else. Codes whose version is over 40 are dropped, and a payload over
//! 4,096 bytes (or one that is not text) comes back as null.

use crate::read::Frame;
use serde_json::{json, Value};

pub const MAX_PAYLOAD: usize = 4096;
pub const MAX_VERSION: usize = 40;

pub struct Code {
    pub quad: [[f64; 2]; 4],
    pub payload: Option<String>,
}

impl Code {
    pub fn json(&self) -> Value {
        json!({ "quad": self.quad.iter().map(|p| json!([p[0], p[1]])).collect::<Vec<_>>(), "payload": self.payload })
    }
}

/// A finder pattern: its centre (area pixels) and module size.
#[derive(Clone, Copy, Debug)]
struct Stone {
    x: f32,
    y: f32,
    unit: f32,
}

/// Whether run lengths `r` (dark, light, dark, light, dark) are 1:1:3:1:1; the module size.
fn finder_runs(r: &[usize]) -> Option<f32> {
    let total: usize = r.iter().sum();
    if total < 7 {
        return None;
    }
    let u = total as f32 / 7.0;
    let ok1 = |v: usize| (v as f32 - u).abs() <= 0.6 * u;
    (ok1(r[0]) && ok1(r[1]) && (r[2] as f32 - 3.0 * u).abs() <= 1.2 * u && ok1(r[3]) && ok1(r[4])).then_some(u)
}

/// Finder-pattern hits along one line of `n` pixels (`dark(i)`): (centre, module size).
fn line_hits(n: usize, dark: impl Fn(usize) -> bool) -> Vec<(f32, f32)> {
    let mut runs: Vec<(bool, usize, usize)> = vec![]; // colour, start, length
    for i in 0..n {
        let d = dark(i);
        match runs.last_mut() {
            Some(r) if r.0 == d => r.2 += 1,
            _ => runs.push((d, i, 1)),
        }
    }
    let mut out = vec![];
    for w in runs.windows(5) {
        if !w[0].0 {
            continue;
        }
        let lens = [w[0].2, w[1].2, w[2].2, w[3].2, w[4].2];
        if let Some(u) = finder_runs(&lens) {
            out.push((w[2].1 as f32 + w[2].2 as f32 / 2.0, u));
        }
    }
    out
}

/// The finder patterns of a grey image (`dark` true where a module is dark): row hits confirmed by
/// a column through their centre, then merged.
fn stones(w: usize, h: usize, dark: &dyn Fn(usize, usize) -> bool) -> Vec<Stone> {
    let mut found: Vec<(Stone, usize)> = vec![];
    for y in 0..h {
        for (cx, u) in line_hits(w, |x| dark(x, y)) {
            let x = cx as usize;
            // The column through the centre must show the same pattern around this row.
            let col = line_hits(h, |yy| dark(x, yy));
            if !col.iter().any(|&(cy, cu)| (cy - y as f32).abs() <= 1.5 * cu && (cu - u).abs() <= 0.5 * u.max(cu)) {
                continue;
            }
            match found.iter_mut().find(|(s, _)| (s.x - cx).abs() <= s.unit.max(1.5) && (s.y - y as f32).abs() <= 4.0 * s.unit && (s.unit - u).abs() <= 0.5 * s.unit) {
                Some((s, n)) => {
                    s.x = (s.x * *n as f32 + cx) / (*n + 1) as f32;
                    s.y = (s.y * *n as f32 + y as f32) / (*n + 1) as f32;
                    s.unit = (s.unit * *n as f32 + u) / (*n + 1) as f32;
                    *n += 1;
                }
                None => found.push((Stone { x: cx, y: y as f32, unit: u }, 1)),
            }
        }
    }
    // A real pattern is hit on about three modules' worth of rows.
    found.into_iter().filter(|(s, n)| *n as f32 >= (1.5 * s.unit).max(2.0)).map(|(s, _)| s).collect()
}

/// Groups of finder patterns that can be one code: three in an L (a corner and two at right
/// angles from it, as far apart, with similar module sizes), best fits first; what is left, alone
/// or with neighbours within reach, as smaller groups.
fn groups(stones: &[Stone]) -> Vec<Vec<Stone>> {
    let similar = |a: &Stone, b: &Stone| (a.unit - b.unit).abs() <= 0.35 * a.unit.max(b.unit);
    let mut triples: Vec<(f32, [usize; 3])> = vec![];
    for a in 0..stones.len() {
        for b in 0..stones.len() {
            for c in b + 1..stones.len() {
                if a == b || a == c {
                    continue;
                }
                let (sa, sb, sc) = (&stones[a], &stones[b], &stones[c]);
                if !similar(sa, sb) || !similar(sa, sc) {
                    continue;
                }
                let (v1, v2) = ((sb.x - sa.x, sb.y - sa.y), (sc.x - sa.x, sc.y - sa.y));
                let (l1, l2) = ((v1.0 * v1.0 + v1.1 * v1.1).sqrt(), (v2.0 * v2.0 + v2.1 * v2.1).sqrt());
                let u = sa.unit;
                if l1 < 10.0 * u || l2 < 10.0 * u || l1 > 180.0 * u || l2 > 180.0 * u {
                    continue;
                }
                let cos = (v1.0 * v2.0 + v1.1 * v2.1) / (l1 * l2);
                let ratio = (l1 - l2).abs() / l1.max(l2);
                if cos.abs() < 0.2 && ratio < 0.2 {
                    triples.push((cos.abs() + ratio, [a, b, c]));
                }
            }
        }
    }
    triples.sort_by(|x, y| x.0.total_cmp(&y.0));
    let mut used = vec![false; stones.len()];
    let mut out = vec![];
    for (_, t) in triples {
        if t.iter().any(|&i| used[i]) {
            continue;
        }
        for &i in &t {
            used[i] = true;
        }
        out.push(t.iter().map(|&i| stones[i]).collect());
    }
    for i in 0..stones.len() {
        if used[i] {
            continue;
        }
        used[i] = true;
        let mut g = vec![stones[i]];
        for j in i + 1..stones.len() {
            let (a, b) = (stones[i], stones[j]);
            let reach = 60.0 * a.unit.max(b.unit);
            if !used[j] && similar(&a, &b) && (a.x - b.x).abs() <= reach && (a.y - b.y).abs() <= reach {
                used[j] = true;
                g.push(b);
            }
        }
        out.push(g);
    }
    out
}

/// rqrr over `win` (area pixels) of the grey image, at `scale`.
fn decode_window(grey: &[u8], aw: usize, win: [usize; 4], scale: usize, invert: bool) -> Vec<([[f64; 2]; 4], Option<String>)> {
    let [wx, wy, ww, wh] = win;
    let mut img = rqrr::PreparedImage::prepare_from_greyscale(ww * scale, wh * scale, |x, y| {
        let v = grey[(wy + y / scale) * aw + wx + x / scale];
        if invert {
            255 - v
        } else {
            v
        }
    });
    let mut out = vec![];
    for grid in img.detect_grids() {
        let quad = grid.bounds.map(|p| [wx as f64 + p.x as f64 / scale as f64, wy as f64 + p.y as f64 / scale as f64]);
        let mut bytes = Vec::new();
        let payload = match grid.decode_to(&mut bytes) {
            Ok(meta) if meta.version.0 > MAX_VERSION => continue,
            Ok(_) if bytes.len() <= MAX_PAYLOAD => String::from_utf8(bytes).ok(),
            _ => None,
        };
        out.push((quad, payload));
    }
    out
}

/// The QR codes inside `area` (x, y, w, h) of `frame`.
pub fn find(frame: &Frame, area: [usize; 4]) -> Vec<Code> {
    let [ax, ay, aw, ah] = area;
    if aw < 21 || ah < 21 {
        return vec![];
    }
    let mut grey = vec![0u8; aw * ah];
    for y in 0..ah {
        for x in 0..aw {
            let p = ((ay + y) * frame.w + ax + x) * 3;
            let (r, g, b) = (frame.rgb[p] as u32, frame.rgb[p + 1] as u32, frame.rgb[p + 2] as u32);
            grey[y * aw + x] = ((r * 299 + g * 587 + b * 114) / 1000) as u8;
        }
    }
    let mut codes: Vec<Code> = vec![];
    for invert in [false, true] {
        let dark = |x: usize, y: usize| (grey[y * aw + x] < 128) != invert;
        for g in groups(&stones(aw, ah, &dark)) {
            let unit = g.iter().map(|s| s.unit).fold(0f32, f32::max);
            let pad = 8.0 * unit;
            let x0 = (g.iter().map(|s| s.x).fold(f32::MAX, f32::min) - pad).max(0.0) as usize;
            let y0 = (g.iter().map(|s| s.y).fold(f32::MAX, f32::min) - pad).max(0.0) as usize;
            let x1 = ((g.iter().map(|s| s.x).fold(f32::MIN, f32::max) + pad) as usize).min(aw);
            let y1 = ((g.iter().map(|s| s.y).fold(f32::MIN, f32::max) + pad) as usize).min(ah);
            if x1 <= x0 + 20 || y1 <= y0 + 20 {
                continue;
            }
            let win = [x0, y0, x1 - x0, y1 - y0];
            let mut got = decode_window(&grey, aw, win, 1, invert);
            if !got.iter().any(|c| c.1.is_some()) {
                let twice = decode_window(&grey, aw, win, 2, invert);
                if twice.iter().any(|c| c.1.is_some()) || got.is_empty() {
                    got = twice;
                }
            }
            if got.is_empty() && g.len() >= 3 {
                // Three finder patterns: a code, even unread.
                let q = [[x0 as f64, y0 as f64], [x1 as f64, y0 as f64], [x1 as f64, y1 as f64], [x0 as f64, y1 as f64]];
                got.push((q, None));
            }
            for (quad, payload) in got {
                let quad = quad.map(|p| [p[0] + ax as f64, p[1] + ay as f64]);
                let c = centre(&quad);
                match codes.iter_mut().find(|o| {
                    let d = centre(&o.quad);
                    (d[0] - c[0]).abs() < 4.0 * unit as f64 && (d[1] - c[1]).abs() < 4.0 * unit as f64
                }) {
                    Some(o) => {
                        if o.payload.is_none() && payload.is_some() {
                            *o = Code { quad, payload };
                        }
                    }
                    None => codes.push(Code { quad, payload }),
                }
            }
        }
    }
    codes
}

fn centre(q: &[[f64; 2]; 4]) -> [f64; 2] {
    [q.iter().map(|p| p[0]).sum::<f64>() / 4.0, q.iter().map(|p| p[1]).sum::<f64>() / 4.0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_finder_ratio() {
        assert!(finder_runs(&[4, 4, 12, 4, 4]).is_some());
        assert!(finder_runs(&[4, 4, 4, 4, 4]).is_none());
        let line = [vec![false; 10], vec![true; 3], vec![false; 3], vec![true; 9], vec![false; 3], vec![true; 3], vec![false; 10]].concat();
        let hits = line_hits(line.len(), |i| line[i]);
        assert_eq!(hits.len(), 1);
        assert!((hits[0].0 - 20.5).abs() < 1.0 && (hits[0].1 - 3.0).abs() < 0.01);
    }
}

