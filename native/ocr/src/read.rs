//! Reading one frame (docs/design/auto-blur.md §5.5): the areas main planned are padded to the
//! smallest of the three detector buckets, small ones packed together into one bucket (shelf
//! packing, 32 px apart, none cut) and large ones cut into 1920×1088 tiles; PP-OCRv6's detector
//! finds the text lines (DBPostProcess with its own `inference.yml` numbers); lines that meet at a
//! tile seam are joined and read again; each line is read by the tiny recogniser at height 48,
//! padded to the next width bucket (lines wider than 1280 are read in overlapping chunks), and CTC
//! decoding gives each character's x-range. Each line also gets the colour of a ring just outside
//! its padded box (§8.4). A read that reaches a cap answers `partial` with what it did not finish.
//!
//! The text never leaves this process except in the read's answer on stdout.

use crate::ctc::{self, Piece};
use crate::geom::{self, RRect};
use crate::models::{Plans, BUCKETS, REC_HEIGHT, WIDTHS};
use crate::protocol::{r2, BoxF, Failure};
use crate::qr;
use serde_json::{json, Value};
use tract_onnx::prelude::*;

/// PP-OCRv6 tiny detector's post-processing, from its pinned `inference.yml` (test 85 compares).
pub const DET_THRESH: f32 = 0.2;
pub const DET_BOX_THRESH: f32 = 0.4;
pub const DET_UNCLIP_RATIO: f32 = 1.4;
pub const DET_MAX_CANDIDATES: usize = 3000;

/// Caps of one read (§5.5, §10.3): detector runs, lines.
pub const MAX_TILES: usize = 64;
pub const MAX_LINES: usize = 1000;
/// Larger recordings are refused before anything is decoded (`tooLarge`).
pub const MAX_SIDE: usize = 7680;
pub const MAX_PIXELS: u64 = 40_000_000;

const PACK_GAP: usize = 32;
/// Lines from neighbouring tiles that meet within this band around a seam are one line.
const SEAM_BAND: f32 = 64.0;
const CHUNK_W: usize = 1280;
const CHUNK_OVERLAP: usize = 64;
/// A line tilted more than this is cut with a rotated crop.
const TILT_MAX_DEG: f32 = 2.0;
const DET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const DET_STD: [f32; 3] = [0.229, 0.224, 0.225];

/// An RGB24 frame.
pub struct Frame {
    pub w: usize,
    pub h: usize,
    pub rgb: Vec<u8>,
}

pub fn too_large(w: usize, h: usize) -> bool {
    w > MAX_SIDE || h > MAX_SIDE || (w as u64) * (h as u64) > MAX_PIXELS
}

/// A line's pixels, kept until main asks for the careful pass or releases the read (§5.6).
pub struct Crop {
    pub w: usize,
    pub h: usize,
    /// BGR, as the recognisers were trained.
    pub bgr: Vec<u8>,
    /// Where the crop's x = 0 is in the frame, and how far one crop pixel goes along x.
    pub x0: f32,
    pub cos: f32,
    /// Read turned a quarter (text running down): no character ranges.
    pub vertical: bool,
    /// The line's width in the frame (the span of each character of a line turned a quarter).
    pub span_w: f32,
}

pub struct Variant {
    pub model: &'static str,
    pub text: String,
    pub conf: f32,
    /// Frame x-ranges, one a UTF-16 code unit of `text`.
    pub spans: Vec<(f32, f32)>,
}

pub struct Line {
    pub quad: [[f32; 2]; 4],
    pub variants: Vec<Variant>,
    pub ring: String,
    pub spread: f32,
}

pub struct ReadOut {
    pub lines: Vec<Line>,
    pub crops: Vec<Crop>,
    pub qr: Vec<qr::Code>,
    pub partial: Vec<BoxF>,
}

/// What a read checks between tiles and lines: Err ends it (cancelled, stopped).
pub type Check<'a> = &'a dyn Fn() -> Result<(), Failure>;

/// Test builds: a read panics while recognising a line whose text holds this (R9, R19).
#[cfg(feature = "fixture")]
pub static PANIC_ON: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// An integer rectangle: x, y, w, h.
type IRect = [usize; 4];

struct Placement {
    area: IRect,
    at: (usize, usize),
    /// (area index, column, row) for a tile of a large area.
    tile: Option<(usize, usize, usize)>,
}

struct Run {
    bucket: usize,
    places: Vec<Placement>,
}

struct Found {
    rect: RRect,
    quad: [[f32; 2]; 4],
    /// The placement it came from (index into `places`).
    place: usize,
}

pub struct Engine<'a> {
    pub plans: &'a Plans,
    pub chars_tiny: &'a [String],
    pub chars_small: &'a [String],
}

fn clip_area(b: &BoxF, w: usize, h: usize) -> Option<IRect> {
    if !(b[2] > 0.0 && b[3] > 0.0) {
        return None;
    }
    let x0 = b[0].floor().max(0.0) as usize;
    let y0 = b[1].floor().max(0.0) as usize;
    let x1 = ((b[0] + b[2]).ceil().max(0.0) as usize).min(w);
    let y1 = ((b[1] + b[3]).ceil().max(0.0) as usize).min(h);
    (x1 > x0 && y1 > y0).then_some([x0, y0, x1 - x0, y1 - y0])
}

/// The smallest bucket that holds w × h.
fn bucket_for(w: usize, h: usize) -> Option<usize> {
    BUCKETS.iter().position(|&(bw, bh)| w <= bw && h <= bh)
}

/// Starts of `n` tiles of `size` spread evenly over `len` (as few as cover it).
fn tile_starts(len: usize, size: usize) -> Vec<usize> {
    if len <= size {
        return vec![0];
    }
    let n = len.div_ceil(size);
    (0..n).map(|i| ((i * (len - size)) as f64 / (n - 1) as f64).round() as usize).collect()
}

/// The detector runs for `areas`: large areas cut into tiles (each its own run), small ones
/// shelf-packed into as few buckets as hold them (§5.4, §5.5).
fn plan_runs(areas: &[IRect]) -> Vec<Run> {
    let (bw, bh) = BUCKETS[BUCKETS.len() - 1];
    let mut runs = vec![];
    let mut small = vec![];
    for (i, a) in areas.iter().enumerate() {
        if a[2] <= bw && a[3] <= bh {
            small.push(*a);
            continue;
        }
        let (tw, th) = (a[2].min(bw), a[3].min(bh));
        for (row, &ty) in tile_starts(a[3], bh).iter().enumerate() {
            for (col, &tx) in tile_starts(a[2], bw).iter().enumerate() {
                let bucket = bucket_for(tw, th).unwrap_or(BUCKETS.len() - 1);
                runs.push(Run { bucket, places: vec![Placement { area: [a[0] + tx, a[1] + ty, tw, th], at: (0, 0), tile: Some((i, col, row)) }] });
            }
        }
    }
    // Shelf packing, tallest first.
    small.sort_by(|a, b| b[3].cmp(&a[3]).then(b[2].cmp(&a[2])));
    struct Bin {
        bucket: usize,
        shelves: Vec<(usize, usize, usize)>, // y, height, next x
        bottom: usize,
        places: Vec<Placement>,
    }
    let mut bins: Vec<Bin> = vec![];
    'next: for a in small {
        let (w, h) = (a[2], a[3]);
        for bin in bins.iter_mut() {
            let (bw, bh) = BUCKETS[bin.bucket];
            for shelf in bin.shelves.iter_mut() {
                let x = if shelf.2 == 0 { 0 } else { shelf.2 + PACK_GAP };
                if h <= shelf.1 && x + w <= bw {
                    bin.places.push(Placement { area: a, at: (x, shelf.0), tile: None });
                    shelf.2 = x + w;
                    continue 'next;
                }
            }
            let y = if bin.shelves.is_empty() { 0 } else { bin.bottom + PACK_GAP };
            if y + h <= bh && w <= bw {
                bin.shelves.push((y, h, w));
                bin.bottom = y + h;
                bin.places.push(Placement { area: a, at: (0, y), tile: None });
                continue 'next;
            }
        }
        let bucket = bucket_for(w, h).unwrap_or(BUCKETS.len() - 1);
        bins.push(Bin { bucket, shelves: vec![(0, h, w)], bottom: h, places: vec![Placement { area: a, at: (0, 0), tile: None }] });
    }
    runs.extend(bins.into_iter().map(|b| Run { bucket: b.bucket, places: b.places }));
    runs
}

/// The detector's input for one run: BGR, ImageNet mean and deviation, zeros around the areas.
fn det_input(frame: &Frame, run: &Run) -> Tensor {
    let (bw, bh) = BUCKETS[run.bucket];
    let mut data = vec![0f32; 3 * bw * bh];
    let plane = bw * bh;
    for p in &run.places {
        let [ax, ay, aw, ah] = p.area;
        for y in 0..ah {
            let src = ((ay + y) * frame.w + ax) * 3;
            let dst = (p.at.1 + y) * bw + p.at.0;
            for x in 0..aw {
                let px = &frame.rgb[src + x * 3..src + x * 3 + 3];
                // Channel 0 is blue (the models read BGR).
                for c in 0..3 {
                    let v = px[2 - c] as f32 / 255.0;
                    data[c * plane + dst + x] = (v - DET_MEAN[c]) / DET_STD[c];
                }
            }
        }
    }
    Tensor::from_shape(&[1, 3, bh, bw], &data).expect("detector input shape")
}

/// DBPostProcess inside one placement of a run's probability map: 8-connected blobs over the
/// threshold, their minimum-area rectangles, scored by the mean probability inside, grown by the
/// unclip distance. Ok(false) when the blob count reached the cap (the placement is partial).
fn boxes_in(prob: &[f32], map_w: usize, p: &Placement, out: &mut Vec<(RRect, [[f32; 2]; 4])>) -> bool {
    let [_, _, w, h] = p.area;
    let (ox, oy) = p.at;
    let at = |x: usize, y: usize| prob[(oy + y) * map_w + ox + x];
    let mut seen = vec![false; w * h];
    let mut stack = vec![];
    let mut candidates = 0usize;
    for start in 0..w * h {
        if seen[start] || at(start % w, start / w) <= DET_THRESH {
            continue;
        }
        candidates += 1;
        if candidates > DET_MAX_CANDIDATES {
            return false;
        }
        // The blob, as each row's leftmost and rightmost pixel.
        let mut rows: std::collections::BTreeMap<usize, (usize, usize)> = Default::default();
        seen[start] = true;
        stack.push(start);
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            let e = rows.entry(y).or_insert((x, x));
            e.0 = e.0.min(x);
            e.1 = e.1.max(x);
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                    if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                        continue;
                    }
                    let j = ny as usize * w + nx as usize;
                    if !seen[j] && at(nx as usize, ny as usize) > DET_THRESH {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
        }
        let pts: Vec<[f32; 2]> = rows.iter().flat_map(|(&y, &(a, b))| [[a as f32, y as f32], [b as f32, y as f32]]).collect();
        let rect = geom::min_area_rect(pts);
        if rect.w.min(rect.h) < 3.0 {
            continue;
        }
        // Mean probability inside the rectangle.
        let q = rect.corners();
        let b = rect.bounds();
        let (bx0, by0) = (b[0].floor().max(0.0) as usize, b[1].floor().max(0.0) as usize);
        let (bx1, by1) = ((b[2].ceil().max(0.0) as usize).min(w - 1), (b[3].ceil().max(0.0) as usize).min(h - 1));
        let (mut sum, mut n) = (0f32, 0usize);
        for y in by0..=by1 {
            for x in bx0..=bx1 {
                if geom::in_quad(&q, x as f32, y as f32) {
                    sum += at(x, y);
                    n += 1;
                }
            }
        }
        if n == 0 || (sum / n as f32) < DET_BOX_THRESH {
            continue;
        }
        let perimeter = 2.0 * (rect.w + rect.h);
        let d = rect.w * rect.h * DET_UNCLIP_RATIO / perimeter;
        let grown = rect.grown(d).upright();
        if grown.w.min(grown.h) < 5.0 {
            continue;
        }
        let mut quad = grown.corners();
        for c in quad.iter_mut() {
            c[0] = c[0].clamp(0.0, w as f32).round() + p.area[0] as f32;
            c[1] = c[1].clamp(0.0, h as f32).round() + p.area[1] as f32;
        }
        let side = |a: [f32; 2], b: [f32; 2]| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt();
        if side(quad[0], quad[1]) <= 3.0 || side(quad[0], quad[3]) <= 3.0 {
            continue;
        }
        out.push((grown, quad));
    }
    true
}

fn quad_bounds(q: &[[f32; 2]; 4]) -> [f32; 4] {
    let xs = q.iter().map(|p| p[0]);
    let ys = q.iter().map(|p| p[1]);
    [xs.clone().fold(f32::MAX, f32::min), ys.clone().fold(f32::MAX, f32::min), xs.fold(f32::MIN, f32::max), ys.fold(f32::MIN, f32::max)]
}

fn axis_quad(b: [f32; 4]) -> [[f32; 2]; 4] {
    [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]
}

/// Joins lines of neighbouring tiles of one area that meet at their seam (§5.5): side by side on
/// the same baseline (within 25% of their height), or one above the other over the same columns.
/// Lines of one tile are never joined.
fn join_seams(found: Vec<Found>, places: &[Placement]) -> Vec<Found> {
    let mut items: Vec<(Found, Vec<usize>)> = found.into_iter().map(|f| {
        let p = f.place;
        (f, vec![p])
    }).collect();
    loop {
        let mut merged = None;
        'search: for i in 0..items.len() {
            for j in i + 1..items.len() {
                if let Some(u) = seam_union(&items[i], &items[j], places) {
                    merged = Some((i, j, u));
                    break 'search;
                }
            }
        }
        let Some((i, j, u)) = merged else { break };
        let (_, mut pb) = items.remove(j);
        let (_, mut pa) = items.remove(i);
        pa.append(&mut pb);
        items.push((Found { rect: RRect { cx: (u[0] + u[2]) / 2.0, cy: (u[1] + u[3]) / 2.0, w: u[2] - u[0], h: u[3] - u[1], angle: 0.0 }, quad: axis_quad(u), place: pa[0] }, pa));
    }
    items.into_iter().map(|(f, _)| f).collect()
}

fn seam_union(a: &(Found, Vec<usize>), b: &(Found, Vec<usize>), places: &[Placement]) -> Option<[f32; 4]> {
    // Lines of tiles of one area only, and never two pieces of the same tile.
    let mut pairs = vec![];
    for &pa in &a.1 {
        for &pb in &b.1 {
            let (Some(ta), Some(tb)) = (places[pa].tile, places[pb].tile) else { return None };
            if ta.0 != tb.0 {
                return None;
            }
            if pa == pb {
                return None;
            }
            pairs.push((pa, pb, ta, tb));
        }
    }
    let ba = quad_bounds(&a.0.quad);
    let bb = quad_bounds(&b.0.quad);
    let (ha, hb) = (ba[3] - ba[1], bb[3] - bb[1]);
    for (pa, pb, ta, tb) in pairs {
        let (ra, rb) = (places[pa].area, places[pb].area);
        let side = ta.2 == tb.2 && ta.1.abs_diff(tb.1) == 1;
        let stacked = ta.1 == tb.1 && ta.2.abs_diff(tb.2) == 1;
        if side {
            // The seam: the middle of the two tiles' overlap (or where they touch).
            let (left, right) = if ra[0] <= rb[0] { (ra, rb) } else { (rb, ra) };
            let seam = (right[0] as f32 + (left[0] + left[2]) as f32) / 2.0;
            let band = (seam - SEAM_BAND / 2.0, seam + SEAM_BAND / 2.0);
            let near = |b: &[f32; 4]| b[2] >= band.0 && b[0] <= band.1;
            let touch = ba[0] <= bb[2] + 4.0 && bb[0] <= ba[2] + 4.0;
            let baseline = (ba[3] - bb[3]).abs() <= 0.25 * ha.max(hb);
            if near(&ba) && near(&bb) && touch && baseline {
                return Some([ba[0].min(bb[0]), ba[1].min(bb[1]), ba[2].max(bb[2]), ba[3].max(bb[3])]);
            }
        } else if stacked {
            let (top, bottom) = if ra[1] <= rb[1] { (ra, rb) } else { (rb, ra) };
            let seam = (bottom[1] as f32 + (top[1] + top[3]) as f32) / 2.0;
            let band = (seam - SEAM_BAND / 2.0, seam + SEAM_BAND / 2.0);
            let near = |b: &[f32; 4]| b[3] >= band.0 && b[1] <= band.1;
            let touch = ba[1] <= bb[3] + 4.0 && bb[1] <= ba[3] + 4.0;
            let cols = (ba[2].min(bb[2]) - ba[0].max(bb[0])) >= 0.5 * (ba[2] - ba[0]).min(bb[2] - bb[0]);
            if near(&ba) && near(&bb) && touch && cols {
                return Some([ba[0].min(bb[0]), ba[1].min(bb[1]), ba[2].max(bb[2]), ba[3].max(bb[3])]);
            }
        }
    }
    None
}

/// Reading order, as PaddleOCR sorts boxes: by top, then left among lines within 10 px.
fn sort_lines(found: &mut [Found]) {
    found.sort_by(|a, b| a.quad[0][1].total_cmp(&b.quad[0][1]).then(a.quad[0][0].total_cmp(&b.quad[0][0])));
    for i in 0..found.len().saturating_sub(1) {
        let mut j = i as i64;
        while j >= 0 {
            let (ju, jn) = (j as usize, j as usize + 1);
            if (found[jn].quad[0][1] - found[ju].quad[0][1]).abs() < 10.0 && found[jn].quad[0][0] < found[ju].quad[0][0] {
                found.swap(ju, jn);
                j -= 1;
            } else {
                break;
            }
        }
    }
}

/// The line's pixels: an axis-aligned cut when it is level within 2°, else a rotated one; turned a
/// quarter when it is 1.5 times taller than wide (as ppocr.py `rotate_crop`).
fn crop_line(frame: &Frame, f: &Found) -> Option<Crop> {
    let tilt = f.rect.angle.to_degrees().abs();
    let q = f.quad;
    let (mut w, mut h, mut bgr, x0, cos);
    if tilt <= TILT_MAX_DEG {
        let b = quad_bounds(&q);
        let (cx0, cy0) = (b[0].max(0.0) as usize, b[1].max(0.0) as usize);
        let (cx1, cy1) = ((b[2].max(0.0) as usize).min(frame.w), (b[3].max(0.0) as usize).min(frame.h));
        if cx1 <= cx0 + 1 || cy1 <= cy0 + 1 {
            return None;
        }
        w = cx1 - cx0;
        h = cy1 - cy0;
        bgr = Vec::with_capacity(w * h * 3);
        for y in cy0..cy1 {
            for x in cx0..cx1 {
                let p = (y * frame.w + x) * 3;
                bgr.extend_from_slice(&[frame.rgb[p + 2], frame.rgb[p + 1], frame.rgb[p]]);
            }
        }
        x0 = cx0 as f32;
        cos = 1.0;
    } else {
        let d = |a: [f32; 2], b: [f32; 2]| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt();
        w = d(q[0], q[1]).max(d(q[2], q[3])) as usize;
        h = d(q[0], q[3]).max(d(q[1], q[2])) as usize;
        if w < 2 || h < 2 {
            return None;
        }
        bgr = Vec::with_capacity(w * h * 3);
        let (ux, uy) = ((q[1][0] - q[0][0]) / w as f32, (q[1][1] - q[0][1]) / w as f32);
        let (vx, vy) = ((q[3][0] - q[0][0]) / h as f32, (q[3][1] - q[0][1]) / h as f32);
        for j in 0..h {
            for i in 0..w {
                let (sx, sy) = (q[0][0] + i as f32 * ux + j as f32 * vx, q[0][1] + i as f32 * uy + j as f32 * vy);
                for c in [2, 1, 0] {
                    bgr.push(geom::sample(&frame.rgb, frame.w, frame.h, 3, c, sx, sy).round().clamp(0.0, 255.0) as u8);
                }
            }
        }
        x0 = q[0][0];
        cos = f.rect.angle.cos();
    }
    let vertical = h as f32 / w.max(1) as f32 >= 1.5;
    let span_w = {
        let b = quad_bounds(&q);
        b[2] - b[0]
    };
    if vertical {
        // A quarter turn counter-clockwise (np.rot90).
        let mut r = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let (nx, ny) = (y, w - 1 - x);
                r[(ny * h + nx) * 3..(ny * h + nx) * 3 + 3].copy_from_slice(&bgr[(y * w + x) * 3..(y * w + x) * 3 + 3]);
            }
        }
        bgr = r;
        std::mem::swap(&mut w, &mut h);
    }
    Some(Crop { w, h, bgr, x0: if vertical { quad_bounds(&q)[0] } else { x0 }, cos, vertical, span_w })
}

/// The 2 px ring just outside the line's padded box (§8.4): its median colour and the largest
/// per-channel median absolute deviation.
fn ring_colour(frame: &Frame, q: &[[f32; 2]; 4]) -> (String, f32) {
    let b = quad_bounds(q);
    let pad = (0.35 * (b[3] - b[1])).max(3.0);
    let (ix0, iy0, ix1, iy1) = (b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad);
    let clampx = |v: f32| v.round().clamp(0.0, frame.w as f32) as usize;
    let clampy = |v: f32| v.round().clamp(0.0, frame.h as f32) as usize;
    let (ox0, oy0, ox1, oy1) = (clampx(ix0 - 2.0), clampy(iy0 - 2.0), clampx(ix1 + 2.0), clampy(iy1 + 2.0));
    let (inx0, iny0, inx1, iny1) = (clampx(ix0), clampy(iy0), clampx(ix1), clampy(iy1));
    let mut hist = [[0u32; 256]; 3];
    let mut n = 0u32;
    for y in oy0..oy1 {
        for x in ox0..ox1 {
            if x >= inx0 && x < inx1 && y >= iny0 && y < iny1 {
                continue;
            }
            let p = (y * frame.w + x) * 3;
            for c in 0..3 {
                hist[c][frame.rgb[p + c] as usize] += 1;
            }
            n += 1;
        }
    }
    if n == 0 {
        return ("#000000".into(), 0.0);
    }
    let median = |h: &[u32; 256], n: u32| -> usize {
        let mut acc = 0;
        for (v, &c) in h.iter().enumerate() {
            acc += c;
            if acc * 2 >= n {
                return v;
            }
        }
        255
    };
    let mut med = [0usize; 3];
    let mut spread = 0usize;
    for c in 0..3 {
        med[c] = median(&hist[c], n);
        let mut dev = [0u32; 256];
        for (v, &cnt) in hist[c].iter().enumerate() {
            dev[v.abs_diff(med[c])] += cnt;
        }
        spread = spread.max(median(&dev, n));
    }
    (format!("#{:02x}{:02x}{:02x}", med[0], med[1], med[2]), spread as f32)
}

impl Engine<'_> {
    /// Reads `areas` of `frame` (the whole frame when there are none).
    pub fn read(&self, frame: &Frame, areas: &[BoxF], check: Check) -> Result<ReadOut, Failure> {
        let whole = [0.0, 0.0, frame.w as f64, frame.h as f64];
        let areas: Vec<IRect> = if areas.is_empty() { vec![clip_area(&whole, frame.w, frame.h)].into_iter().flatten().collect() } else { areas.iter().filter_map(|a| clip_area(a, frame.w, frame.h)).collect() };
        let mut runs = plan_runs(&areas);
        crate::stats::set_runs(runs.iter().map(|r| (r.bucket, r.places.len())).collect());
        let mut partial: Vec<BoxF> = vec![];
        if runs.len() > MAX_TILES {
            for r in runs.drain(MAX_TILES..) {
                partial.extend(r.places.iter().map(|p| p.area.map(|v| v as f64)));
            }
        }
        let mut places: Vec<Placement> = vec![];
        let mut found: Vec<Found> = vec![];
        for run in runs {
            check()?;
            let (bw, _) = BUCKETS[run.bucket];
            let input = det_input(frame, &run);
            let out = self.plans.det[run.bucket].run(tvec!(input.into_tvalue())).map_err(|_| Failure::Read)?;
            let view = out[0].to_plain_array_view::<f32>().map_err(|_| Failure::Read)?;
            let prob = view.as_slice().ok_or(Failure::Read)?;
            for p in run.places {
                let mut boxes = vec![];
                if !boxes_in(prob, bw, &p, &mut boxes) {
                    partial.push(p.area.map(|v| v as f64));
                }
                let index = places.len();
                found.extend(boxes.into_iter().map(|(rect, quad)| Found { rect, quad, place: index }));
                places.push(p);
            }
        }
        let mut found = join_seams(found, &places);
        sort_lines(&mut found);
        if found.len() > MAX_LINES {
            // What was not read: each placement's unread lines, as one box.
            let rest = found.split_off(MAX_LINES);
            let mut by_place: std::collections::BTreeMap<usize, [f32; 4]> = Default::default();
            for f in rest {
                let b = quad_bounds(&f.quad);
                let e = by_place.entry(f.place).or_insert(b);
                *e = [e[0].min(b[0]), e[1].min(b[1]), e[2].max(b[2]), e[3].max(b[3])];
            }
            for (place, b) in by_place {
                let a = places[place].area;
                let x0 = (b[0] - 8.0).max(a[0] as f32);
                let y0 = (b[1] - 8.0).max(a[1] as f32);
                let x1 = (b[2] + 8.0).min((a[0] + a[2]) as f32);
                let y1 = (b[3] + 8.0).min((a[1] + a[3]) as f32);
                partial.push([x0 as f64, y0 as f64, (x1 - x0) as f64, (y1 - y0) as f64]);
            }
        }
        let mut lines = vec![];
        let mut crops = vec![];
        for (i, f) in found.iter().enumerate() {
            if i % 16 == 0 {
                check()?;
            }
            let Some(crop) = crop_line(frame, f) else { continue };
            let v = self.recognise(&crop, false);
            let (ring, spread) = ring_colour(frame, &f.quad);
            lines.push(Line { quad: f.quad, variants: vec![v], ring, spread });
            crops.push(crop);
        }
        let mut codes = vec![];
        for a in &areas {
            codes.extend(qr::find(frame, *a));
        }
        Ok(ReadOut { lines, crops, qr: codes, partial })
    }

    /// One recogniser's reading of a crop (tiny, or small for the careful pass).
    pub fn recognise(&self, crop: &Crop, small: bool) -> Variant {
        let (plans, chars, model) = if small { (&self.plans.small, self.chars_small, "small") } else { (&self.plans.tiny, self.chars_tiny, "tiny") };
        let ratio = crop.w as f32 / crop.h.max(1) as f32;
        let img_w = (REC_HEIGHT as f32 * (320.0 / REC_HEIGHT as f32).max(ratio)) as usize;
        let rw = img_w.min((REC_HEIGHT as f32 * ratio).ceil() as usize).max(1);
        let resized = resize_bgr(crop, rw, REC_HEIGHT);
        let mut all: Vec<Piece> = vec![];
        let mut start = 0usize;
        loop {
            let cw = (rw - start).min(CHUNK_W);
            let bucket = WIDTHS.iter().position(|&w| w >= cw.max(if start == 0 { img_w.min(CHUNK_W) } else { 0 })).unwrap_or(WIDTHS.len() - 1);
            let width = WIDTHS[bucket];
            let mut data = vec![0f32; 3 * REC_HEIGHT * width];
            let plane = REC_HEIGHT * width;
            for y in 0..REC_HEIGHT {
                for x in 0..cw {
                    let p = (y * rw + start + x) * 3;
                    for c in 0..3 {
                        data[c * plane + y * width + x] = (resized[p + c] as f32 / 255.0 - 0.5) / 0.5;
                    }
                }
            }
            let input = Tensor::from_shape(&[1, 3, REC_HEIGHT, width], &data).expect("recogniser input shape");
            let pieces = match plans[bucket].run(tvec!(input.into_tvalue())) {
                Ok(out) => match out[0].to_plain_array_view::<f32>() {
                    Ok(view) if view.ndim() == 3 => match view.as_slice() {
                        Some(probs) => ctc::pieces(probs, view.shape()[1], view.shape()[2], chars, width as f32),
                        None => vec![],
                    },
                    _ => vec![],
                },
                Err(_) => vec![],
            };
            let last = start + cw >= rw;
            let next = start + CHUNK_W - CHUNK_OVERLAP;
            let lo = if start == 0 { f32::MIN } else { (start + CHUNK_OVERLAP / 2) as f32 };
            let hi = if last { f32::MAX } else { (next + CHUNK_OVERLAP / 2) as f32 };
            for mut p in pieces {
                p.a += start as f32;
                p.b += start as f32;
                let mid = (p.a + p.b) / 2.0;
                if mid >= lo && mid < hi {
                    all.push(p);
                }
            }
            if last {
                break;
            }
            start = next;
        }
        let d = ctc::assemble(&all, crop.w as f32 / rw as f32, 8.0, crop.w as f32);
        #[cfg(feature = "fixture")]
        if let Some(marker) = PANIC_ON.lock().unwrap_or_else(|e| e.into_inner()).as_deref() {
            if d.text.contains(marker) {
                panic!("line {} holds the marker", d.text);
            }
        }
        // A line read turned a quarter has no x-range per character: each gets the line's width.
        let spans = if crop.vertical { d.spans.iter().map(|_| (crop.x0, crop.x0 + crop.span_w)).collect() } else { d.spans.iter().map(|&(a, b)| (crop.x0 + a * crop.cos, crop.x0 + b * crop.cos)).collect() };
        Variant { model, text: d.text, conf: d.conf, spans }
    }
}

/// cv2.resize with INTER_LINEAR (half-pixel centres), for a BGR crop.
fn resize_bgr(crop: &Crop, w: usize, h: usize) -> Vec<u8> {
    let mut out = vec![0u8; w * h * 3];
    let (sx, sy) = (crop.w as f32 / w as f32, crop.h as f32 / h as f32);
    for y in 0..h {
        let fy = (y as f32 + 0.5) * sy - 0.5;
        for x in 0..w {
            let fx = (x as f32 + 0.5) * sx - 0.5;
            for c in 0..3 {
                out[(y * w + x) * 3 + c] = geom::sample(&crop.bgr, crop.w, crop.h, 3, c, fx, fy).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

fn variant_json(v: &Variant) -> Value {
    json!({
        "model": v.model,
        "text": v.text,
        "conf": (v.conf as f64 * 10000.0).round() / 10000.0,
        "spans": v.spans.iter().map(|&(a, b)| json!([r2(a as f64), r2(b as f64)])).collect::<Vec<_>>(),
    })
}

pub fn variants_json(vs: &[Variant]) -> Value {
    Value::Array(vs.iter().map(variant_json).collect())
}

/// The `read` answer's body (protocol.ts `ReadResult`).
pub fn result_json(t: f64, out: &ReadOut) -> Value {
    let lines: Vec<Value> = out
        .lines
        .iter()
        .map(|l| {
            let b = quad_bounds(&l.quad);
            json!({
                "box": [r2(b[0] as f64), r2(b[1] as f64), r2((b[2] - b[0]) as f64), r2((b[3] - b[1]) as f64)],
                "quad": l.quad.iter().map(|p| json!([r2(p[0] as f64), r2(p[1] as f64)])).collect::<Vec<_>>(),
                "variants": variants_json(&l.variants),
                "ring": l.ring,
                "spread": l.spread,
            })
        })
        .collect();
    let mut body = json!({ "t": t, "lines": lines, "qr": out.qr.iter().map(qr::Code::json).collect::<Vec<_>>() });
    if !out.partial.is_empty() {
        body["partial"] = Value::Array(out.partial.iter().map(|b| json!([r2(b[0]), r2(b[1]), r2(b[2]), r2(b[3])])).collect());
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_4k_frame_is_four_tiles_and_7680_by_2160_is_eight() {
        assert_eq!(plan_runs(&[[0, 0, 3840, 2160]]).len(), 4);
        assert_eq!(plan_runs(&[[0, 0, 7680, 2160]]).len(), 8);
        assert_eq!(plan_runs(&[[0, 0, 1920, 1080]]).len(), 1);
        assert_eq!(tile_starts(3840, 1920), vec![0, 1920]);
        assert_eq!(tile_starts(2160, 1088), vec![0, 1072]);
    }

    #[test]
    fn three_small_areas_share_the_smallest_bucket() {
        let runs = plan_runs(&[[0, 0, 300, 80], [500, 400, 300, 80], [900, 900, 200, 60]]);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].bucket, 0);
        assert_eq!(runs[0].places.len(), 3);
        // 32 px apart, none overlapping, all inside 640×352.
        let ps = &runs[0].places;
        for (i, a) in ps.iter().enumerate() {
            assert!(a.at.0 + a.area[2] <= 640 && a.at.1 + a.area[3] <= 352);
            for b in &ps[i + 1..] {
                let apart_x = a.at.0 + a.area[2] + PACK_GAP <= b.at.0 || b.at.0 + b.area[2] + PACK_GAP <= a.at.0;
                let apart_y = a.at.1 + a.area[3] + PACK_GAP <= b.at.1 || b.at.1 + b.area[3] + PACK_GAP <= a.at.1;
                assert!(apart_x || apart_y);
            }
        }
        // A 1200×500 area takes the largest bucket.
        assert_eq!(plan_runs(&[[0, 0, 1200, 500]])[0].bucket, 2);
    }

    #[test]
    fn caps_and_sizes() {
        assert!(too_large(7681, 4320));
        assert!(too_large(6500, 6500));
        assert!(!too_large(7680, 4320));
        assert!(!too_large(4320, 7680));
    }
}
