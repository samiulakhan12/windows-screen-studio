//! Output geometry and bitrate.

/// H.264 level 5.1/5.2 limit on frame size, in 16x16 macroblocks; hardware
/// encoders also cap each side at 4096 px. Larger monitors (5K, 8K, super-wide)
/// are scaled down to fit instead of failing to record.
pub const MAX_MACROBLOCKS: u64 = 36_864;
pub const MAX_SIDE: u32 = 4096;

fn macroblocks(w: u32, h: u32) -> u64 {
    (w as u64).div_ceil(16) * (h as u64).div_ceil(16)
}

fn fits(w: u32, h: u32) -> bool {
    w <= MAX_SIDE && h <= MAX_SIDE && macroblocks(w, h) <= MAX_MACROBLOCKS
}

fn even(v: f64) -> u32 {
    ((v.floor() as u32) & !1).max(2)
}

/// Encoded size for a capture of `w` x `h` physical pixels: even dimensions
/// (4:2:0 chroma needs them; an odd last row/column is cropped, not scaled) and
/// within the H.264 limits above (scaled down keeping the aspect ratio).
pub fn output_size(w: u32, h: u32) -> (u32, u32) {
    let (w, h) = (w.max(2), h.max(2));
    let cropped = (w & !1, h & !1);
    if fits(cropped.0, cropped.1) {
        return cropped;
    }
    let (fw, fh) = (w as f64, h as f64);
    let mut scale = (MAX_SIDE as f64 / fw)
        .min(MAX_SIDE as f64 / fh)
        .min(((MAX_MACROBLOCKS * 256) as f64 / (fw * fh)).sqrt())
        .min(1.0);
    loop {
        let (ow, oh) = (even(fw * scale), even(fh * scale));
        if fits(ow, oh) {
            return (ow, oh);
        }
        scale *= 0.995;
    }
}

/// True when `output_size` had to scale (not just crop) the capture.
pub fn is_scaled(capture: (u32, u32), output: (u32, u32)) -> bool {
    output.0 < (capture.0 & !1) || output.1 < (capture.1 & !1)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn sized(w: u32, h: u32) -> Self {
        Self { left: 0, top: 0, right: w as i32, bottom: h as i32 }
    }
}

/// Where content of one size lands when fitted into an output of another size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fit {
    pub scale: f64,
    /// Offset and size of the content inside the output, in output pixels.
    pub dx: f64,
    pub dy: f64,
    pub width: f64,
    pub height: f64,
}

/// Fits `content` inside `output` keeping its aspect ratio, centred, with bars on the other
/// axis. THE fit rule of window recordings, shared with the app: `fitContent()` in
/// src/shared/recording/windowGeometry.ts (scale = min(W/w, H/h), offset ((W-w*s)/2, (H-h*s)/2)).
pub fn fit_content(content: (u32, u32), output: (u32, u32)) -> Fit {
    let (cw, ch) = (content.0.max(1) as f64, content.1.max(1) as f64);
    let (ow, oh) = (output.0 as f64, output.1 as f64);
    let scale = (ow / cw).min(oh / ch);
    let (width, height) = (cw * scale, ch * scale);
    Fit { scale, dx: (ow - width) / 2.0, dy: (oh - height) / 2.0, width, height }
}

/// Source and destination rectangles for converting a `content`-sized frame into
/// an `output`-sized video frame. When the output is the content cropped to even
/// dimensions, the odd row/column is cropped (pixel exact, no resampling);
/// otherwise the content is scaled to fit, centred, keeping its aspect ratio
/// (`fit_content`, rounded to whole pixels).
pub fn fit_rects(content: (u32, u32), output: (u32, u32)) -> (Rect, Rect) {
    let (cw, ch) = (content.0.max(1), content.1.max(1));
    let (ow, oh) = output;
    if cw >= ow && ch >= oh && cw - ow <= 1 && ch - oh <= 1 {
        return (Rect::sized(ow, oh), Rect::sized(ow, oh));
    }
    let fit = fit_content((cw, ch), output);
    let dw = (fit.width.round() as u32).clamp(1, ow);
    let dh = (fit.height.round() as u32).clamp(1, oh);
    let left = ((ow - dw) / 2) as i32;
    let top = ((oh - dh) / 2) as i32;
    (Rect::sized(cw, ch), Rect { left, top, right: left + dw as i32, bottom: top + dh as i32 })
}

/// Default average bitrate: about 0.07 bits per pixel per frame, which keeps
/// text crisp in screen recordings (1080p60 = 8.7 Mbps, 4K60 = 34.8 Mbps).
pub fn default_bitrate(w: u32, h: u32, fps: u32) -> u32 {
    let bps = w as f64 * h as f64 * fps as f64 * 0.07;
    bps.clamp(MIN_BITRATE as f64, DEFAULT_MAX_BITRATE as f64).round() as u32
}

pub const MIN_BITRATE: u32 = 1_000_000;
pub const DEFAULT_MAX_BITRATE: u32 = 50_000_000;
/// Range accepted from --bitrate.
pub const BITRATE_RANGE: (u32, u32) = (250_000, 200_000_000);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_sizes_pass_through() {
        assert_eq!(output_size(1920, 1080), (1920, 1080));
        assert_eq!(output_size(2560, 1440), (2560, 1440));
        assert_eq!(output_size(3840, 2160), (3840, 2160));
        assert_eq!(output_size(1366, 768), (1366, 768));
        assert_eq!(output_size(1080, 1920), (1080, 1920));
    }

    #[test]
    fn odd_sizes_are_cropped_to_even() {
        assert_eq!(output_size(1365, 767), (1364, 766));
        assert_eq!(output_size(3, 1), (2, 2));
        assert!(!is_scaled((1365, 767), (1364, 766)));
    }

    #[test]
    fn oversized_monitors_are_scaled_within_h264_limits() {
        for &(w, h) in &[(5120, 2880), (7680, 4320), (5120, 1440), (6880, 2880), (3840, 4096), (4096, 2304)] {
            let (ow, oh) = output_size(w, h);
            assert!(ow % 2 == 0 && oh % 2 == 0, "{w}x{h} -> {ow}x{oh} not even");
            assert!(fits(ow, oh), "{w}x{h} -> {ow}x{oh} exceeds limits");
            let aspect = (w as f64 / h as f64) / (ow as f64 / oh as f64);
            assert!((aspect - 1.0).abs() < 0.01, "{w}x{h} -> {ow}x{oh} distorts");
            // Not needlessly small: within ~2% of the macroblock budget or a side limit.
            let budget = macroblocks(ow, oh) as f64 / MAX_MACROBLOCKS as f64;
            assert!(budget > 0.97 || ow > 4000 || oh > 4000, "{w}x{h} -> {ow}x{oh} too small ({budget})");
        }
        assert_eq!(output_size(4096, 2304), (4096, 2304));
        assert!(is_scaled((5120, 2880), output_size(5120, 2880)));
    }

    #[test]
    fn matching_content_is_cropped_not_scaled() {
        assert_eq!(fit_rects((1920, 1080), (1920, 1080)), (Rect::sized(1920, 1080), Rect::sized(1920, 1080)));
        assert_eq!(fit_rects((1365, 767), (1364, 766)), (Rect::sized(1364, 766), Rect::sized(1364, 766)));
    }

    #[test]
    fn other_content_is_scaled_to_fit_and_centred() {
        // 5K scaled into its encodable size: fills the frame.
        let out = output_size(5120, 2880);
        let (src, dst) = fit_rects((5120, 2880), out);
        assert_eq!(src, Rect::sized(5120, 2880));
        assert!(dst.left <= 1 && dst.top <= 1 && dst.right >= out.0 as i32 - 1 && dst.bottom >= out.1 as i32 - 1);
        // The monitor was rotated mid-recording: portrait content pillarboxed in a landscape video.
        let (src, dst) = fit_rects((1080, 1920), (1920, 1080));
        assert_eq!(src, Rect::sized(1080, 1920));
        assert_eq!(dst, Rect { left: 656, top: 0, right: 1264, bottom: 1080 });
        // A smaller resolution is scaled up to fill the height.
        let (_, dst) = fit_rects((1280, 720), (1920, 1080));
        assert_eq!(dst, Rect::sized(1920, 1080));
    }

    /// The vectors of tests/windowGeometry.test.ts (fitContent): the helper and the app must
    /// agree on where a resized window's content lands in the video.
    #[test]
    fn fit_content_matches_the_app() {
        let identity = fit_content((1280, 720), (1280, 720));
        assert_eq!(identity, Fit { scale: 1.0, dx: 0.0, dy: 0.0, width: 1280.0, height: 720.0 });
        let wide = fit_content((2560, 720), (1280, 720));
        assert_eq!(wide, Fit { scale: 0.5, dx: 0.0, dy: 180.0, width: 1280.0, height: 360.0 });
        let tall = fit_content((640, 1440), (1280, 720));
        assert_eq!(tall, Fit { scale: 0.5, dx: 480.0, dy: 0.0, width: 320.0, height: 720.0 });
        // mapPointToWindowVideo "maps into the fitted content after a resize": 2000x500 in 1000x500.
        let f = fit_content((2000, 500), (1000, 500));
        assert_eq!((f.dx, f.dy, f.width, f.height), (0.0, 125.0, 1000.0, 250.0));
        // A zero-sized content is treated as 1x1 (as Math.max(1, ...) does).
        assert_eq!(fit_content((0, 0), (10, 10)).scale, 10.0);
    }

    #[test]
    fn fit_rects_round_fit_content_to_pixels() {
        let (src, dst) = fit_rects((2560, 720), (1280, 720));
        assert_eq!(src, Rect::sized(2560, 720));
        assert_eq!(dst, Rect { left: 0, top: 180, right: 1280, bottom: 540 });
        let (_, dst) = fit_rects((640, 1440), (1280, 720));
        assert_eq!(dst, Rect { left: 480, top: 0, right: 800, bottom: 720 });
        // A window made smaller keeps its aspect and is centred, never stretched.
        let (_, dst) = fit_rects((801, 599), (1280, 720));
        let f = fit_content((801, 599), (1280, 720));
        assert!((dst.left as f64 - f.dx).abs() <= 1.0 && (dst.top as f64 - f.dy).abs() <= 1.0);
        assert!(((dst.right - dst.left) as f64 - f.width).abs() <= 1.0);
        assert!(((dst.bottom - dst.top) as f64 - f.height).abs() <= 1.0);
    }

    #[test]
    fn bitrate_scales_with_pixels_and_is_capped() {
        assert_eq!(default_bitrate(1920, 1080, 60), 8_709_120);
        assert_eq!(default_bitrate(1920, 1080, 30), 4_354_560);
        assert_eq!(default_bitrate(3840, 2160, 60), 34_836_480);
        assert_eq!(default_bitrate(320, 240, 30), MIN_BITRATE);
        assert_eq!(default_bitrate(4096, 4096, 60), DEFAULT_MAX_BITRATE);
    }
}
