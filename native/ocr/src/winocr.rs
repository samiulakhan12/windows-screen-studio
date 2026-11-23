//! The Windows reader (docs/design/auto-blur.md §5.13): `Windows.Media.Ocr` for the user's profile
//! languages, as a second reader behind `reader: 'windows'`, so decision 8's check (R10) can be run
//! on the reference PC. The app never asks for it while `WINDOWS_READER_ALLOWED` is false.
//! Windows OCR gives word boxes but no character positions: each word's characters get equal
//! shares of its box (the own-span padding of §6.1 covers the difference; R10 measures it).

use crate::protocol::Failure;
use crate::read::{Frame, Line, Variant};

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;

    pub struct WinReader {
        engine: OcrEngine,
        max: usize,
    }

    impl WinReader {
        pub fn new() -> Result<WinReader, Failure> {
            unsafe {
                let _ = windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED);
            }
            let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_| Failure::Model)?;
            let max = OcrEngine::MaxImageDimension().map(|m| m as usize).unwrap_or(2600).max(64);
            Ok(WinReader { engine, max })
        }

        /// Reads `area` (x, y, w, h) of `frame`, in tiles no larger than the engine takes.
        pub fn read(&self, frame: &Frame, area: [usize; 4]) -> Result<Vec<Line>, Failure> {
            let mut out = vec![];
            let [ax, ay, aw, ah] = area;
            let mut ty = 0;
            while ty < ah {
                let th = (ah - ty).min(self.max);
                let mut tx = 0;
                while tx < aw {
                    let tw = (aw - tx).min(self.max);
                    out.extend(self.read_tile(frame, [ax + tx, ay + ty, tw, th])?);
                    tx += tw;
                }
                ty += th;
            }
            Ok(out)
        }

        fn read_tile(&self, frame: &Frame, r: [usize; 4]) -> Result<Vec<Line>, Failure> {
            let [x0, y0, w, h] = r;
            let mut bgra = Vec::with_capacity(w * h * 4);
            for y in y0..y0 + h {
                for x in x0..x0 + w {
                    let p = (y * frame.w + x) * 3;
                    bgra.extend_from_slice(&[frame.rgb[p + 2], frame.rgb[p + 1], frame.rgb[p], 255]);
                }
            }
            let writer = DataWriter::new().map_err(|_| Failure::Read)?;
            writer.WriteBytes(&bgra).map_err(|_| Failure::Read)?;
            let buffer = writer.DetachBuffer().map_err(|_| Failure::Read)?;
            let bitmap = SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w as i32, h as i32).map_err(|_| Failure::Read)?;
            let result = self.engine.RecognizeAsync(&bitmap).map_err(|_| Failure::Read)?.join().map_err(|_| Failure::Read)?;
            let mut lines = vec![];
            for line in result.Lines().map_err(|_| Failure::Read)? {
                let mut words = vec![];
                for word in line.Words().map_err(|_| Failure::Read)? {
                    let rect = word.BoundingRect().map_err(|_| Failure::Read)?;
                    let text = word.Text().map_err(|_| Failure::Read)?.to_string_lossy();
                    words.push((x0 as f32 + rect.X, y0 as f32 + rect.Y, rect.Width, rect.Height, text));
                }
                if let Some(l) = super::line_of(&words) {
                    lines.push(l);
                }
            }
            Ok(lines)
        }
    }
}

/// One line from its words (x, y, w, h, text): their union box, the words joined by spaces, and
/// each character an equal share of its word (the space between two words gets the gap).
pub fn line_of(words: &[(f32, f32, f32, f32, String)]) -> Option<Line> {
    if words.is_empty() {
        return None;
    }
    let x0 = words.iter().map(|w| w.0).fold(f32::MAX, f32::min);
    let y0 = words.iter().map(|w| w.1).fold(f32::MAX, f32::min);
    let x1 = words.iter().map(|w| w.0 + w.2).fold(f32::MIN, f32::max);
    let y1 = words.iter().map(|w| w.1 + w.3).fold(f32::MIN, f32::max);
    let mut text = String::new();
    let mut spans = vec![];
    for (i, (x, _, w, _, t)) in words.iter().enumerate() {
        if i > 0 {
            let prev_end = words[i - 1].0 + words[i - 1].2;
            text.push(' ');
            spans.push((prev_end, *x));
        }
        let units: Vec<u16> = t.encode_utf16().collect();
        let n = units.len().max(1) as f32;
        for k in 0..units.len() {
            spans.push((x + w * k as f32 / n, x + w * (k + 1) as f32 / n));
        }
        text.push_str(t);
    }
    Some(Line { quad: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], variants: vec![Variant { model: "windows", text, conf: 1.0, spans }], ring: String::new(), spread: 0.0 })
}

#[cfg(windows)]
pub use imp::WinReader;

/// Elsewhere there is no Windows reader.
#[cfg(not(windows))]
pub struct WinReader;

#[cfg(not(windows))]
impl WinReader {
    pub fn new() -> Result<WinReader, Failure> {
        Err(Failure::BadCommand)
    }

    pub fn read(&self, _frame: &Frame, _area: [usize; 4]) -> Result<Vec<Line>, Failure> {
        Err(Failure::BadCommand)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_each_word_among_its_characters() {
        let l = line_of(&[(10.0, 5.0, 40.0, 12.0, "abcd".into()), (60.0, 5.0, 20.0, 12.0, "ef".into())]).unwrap();
        let v = &l.variants[0];
        assert_eq!(v.text, "abcd ef");
        assert_eq!(v.spans.len(), 7);
        assert_eq!(v.spans[0], (10.0, 20.0));
        assert_eq!(v.spans[4], (50.0, 60.0));
        assert_eq!(v.spans[6], (70.0, 80.0));
        assert_eq!(l.quad[2], [80.0, 17.0]);
    }
}
