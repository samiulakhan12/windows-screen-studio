//! Geometry for the detector's post-processing (docs/design/auto-blur.md §5.5): the convex hull
//! and minimum-area rectangle of a text blob (OpenCV's `minAreaRect`, as PP-OCRv6's DBPostProcess
//! uses it), filling a rotated rectangle, and bilinear sampling with the edge pixels repeated.

/// A rotated rectangle: centre, size along its own axes, angle of its width axis (radians).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RRect {
    pub cx: f32,
    pub cy: f32,
    pub w: f32,
    pub h: f32,
    pub angle: f32,
}

impl RRect {
    /// Its corners in reading order: top-left, top-right, bottom-right, bottom-left.
    pub fn corners(&self) -> [[f32; 2]; 4] {
        let (s, c) = self.angle.sin_cos();
        let (hw, hh) = (self.w / 2.0, self.h / 2.0);
        let p = |a: f32, b: f32| [self.cx + a * c - b * s, self.cy + a * s + b * c];
        [p(-hw, -hh), p(hw, -hh), p(hw, hh), p(-hw, hh)]
    }

    /// The same rectangle with its width axis within ±45° of x (the angle of a text line).
    pub fn upright(self) -> RRect {
        let mut r = self;
        let quarter = std::f32::consts::FRAC_PI_2;
        while r.angle > quarter / 2.0 {
            r = RRect { w: r.h, h: r.w, angle: r.angle - quarter, ..r };
        }
        while r.angle <= -quarter / 2.0 {
            r = RRect { w: r.h, h: r.w, angle: r.angle + quarter, ..r };
        }
        r
    }

    pub fn grown(&self, d: f32) -> RRect {
        RRect { w: self.w + 2.0 * d, h: self.h + 2.0 * d, ..*self }
    }

    /// Axis-aligned bounds: x0, y0, x1, y1.
    pub fn bounds(&self) -> [f32; 4] {
        let c = self.corners();
        let xs = c.iter().map(|p| p[0]);
        let ys = c.iter().map(|p| p[1]);
        [xs.clone().fold(f32::MAX, f32::min), ys.clone().fold(f32::MAX, f32::min), xs.fold(f32::MIN, f32::max), ys.fold(f32::MIN, f32::max)]
    }
}

fn cross(o: [f32; 2], a: [f32; 2], b: [f32; 2]) -> f32 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/// Convex hull (Andrew's monotone chain), counter-clockwise, no repeated point.
pub fn hull(mut pts: Vec<[f32; 2]>) -> Vec<[f32; 2]> {
    pts.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let mut lower: Vec<[f32; 2]> = vec![];
    for &p in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], p) <= 0.0 {
            lower.pop();
        }
        lower.push(p);
    }
    let mut upper: Vec<[f32; 2]> = vec![];
    for &p in pts.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], p) <= 0.0 {
            upper.pop();
        }
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// The minimum-area rectangle around `pts` (rotating calipers over the hull's edges).
pub fn min_area_rect(pts: Vec<[f32; 2]>) -> RRect {
    let h = hull(pts);
    match h.len() {
        0 => return RRect { cx: 0.0, cy: 0.0, w: 0.0, h: 0.0, angle: 0.0 },
        1 => return RRect { cx: h[0][0], cy: h[0][1], w: 0.0, h: 0.0, angle: 0.0 },
        2 => {
            let (dx, dy) = (h[1][0] - h[0][0], h[1][1] - h[0][1]);
            return RRect { cx: (h[0][0] + h[1][0]) / 2.0, cy: (h[0][1] + h[1][1]) / 2.0, w: (dx * dx + dy * dy).sqrt(), h: 0.0, angle: dy.atan2(dx) };
        }
        _ => {}
    }
    let mut best: Option<(f32, RRect)> = None;
    for i in 0..h.len() {
        let a = h[i];
        let b = h[(i + 1) % h.len()];
        let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
        if len == 0.0 {
            continue;
        }
        let (ux, uy) = ((b[0] - a[0]) / len, (b[1] - a[1]) / len);
        let (mut u0, mut u1, mut v0, mut v1) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
        for p in &h {
            let (px, py) = (p[0] - a[0], p[1] - a[1]);
            let u = px * ux + py * uy;
            let v = -px * uy + py * ux;
            u0 = u0.min(u);
            u1 = u1.max(u);
            v0 = v0.min(v);
            v1 = v1.max(v);
        }
        let area = (u1 - u0) * (v1 - v0);
        if best.as_ref().is_none_or(|(b, _)| area < *b) {
            let (cu, cv) = ((u0 + u1) / 2.0, (v0 + v1) / 2.0);
            let r = RRect { cx: a[0] + cu * ux - cv * uy, cy: a[1] + cu * uy + cv * ux, w: u1 - u0, h: v1 - v0, angle: uy.atan2(ux) };
            best = Some((area, r));
        }
    }
    best.map(|b| b.1).unwrap_or(RRect { cx: 0.0, cy: 0.0, w: 0.0, h: 0.0, angle: 0.0 })
}

/// Whether (x, y) is inside the convex quad `q` (corners in order, either winding).
pub fn in_quad(q: &[[f32; 2]; 4], x: f32, y: f32) -> bool {
    let mut sign = 0.0f32;
    for i in 0..4 {
        let c = cross(q[i], q[(i + 1) % 4], [x, y]);
        if c != 0.0 {
            if sign == 0.0 {
                sign = c.signum();
            } else if c.signum() != sign {
                return false;
            }
        }
    }
    true
}

/// Bilinear sample of channel `ch` of an interleaved image (`chans` channels), the edge repeated.
pub fn sample(img: &[u8], w: usize, h: usize, chans: usize, ch: usize, x: f32, y: f32) -> f32 {
    let x = x.clamp(0.0, (w - 1) as f32);
    let y = y.clamp(0.0, (h - 1) as f32);
    let (x0, y0) = (x.floor() as usize, y.floor() as usize);
    let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    let at = |xx: usize, yy: usize| img[(yy * w + xx) * chans + ch] as f32;
    (at(x0, y0) * (1.0 - fx) + at(x1, y0) * fx) * (1.0 - fy) + (at(x0, y1) * (1.0 - fx) + at(x1, y1) * fx) * fy
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_rectangle_of_a_tilted_bar() {
        let mut pts = vec![];
        let a = 10f32.to_radians();
        for i in 0..100 {
            for j in 0..10 {
                let (u, v) = (i as f32, j as f32);
                pts.push([50.0 + u * a.cos() - v * a.sin(), 20.0 + u * a.sin() + v * a.cos()]);
            }
        }
        let r = min_area_rect(pts).upright();
        assert!((r.angle - a).abs() < 0.01, "{r:?}");
        assert!((r.w - 99.0).abs() < 0.5 && (r.h - 9.0).abs() < 0.5, "{r:?}");
    }

    #[test]
    fn keeps_an_axis_aligned_box_upright() {
        let pts = vec![[0.0, 0.0], [40.0, 0.0], [40.0, 10.0], [0.0, 10.0]];
        let r = min_area_rect(pts).upright();
        assert!(r.angle.abs() < 1e-6 && (r.w - 40.0).abs() < 1e-4 && (r.h - 10.0).abs() < 1e-4, "{r:?}");
        assert_eq!(r.corners()[0], [0.0, 0.0]);
        assert!(in_quad(&r.corners(), 20.0, 5.0) && !in_quad(&r.corners(), 41.0, 5.0));
    }
}
