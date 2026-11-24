//! Frames out of the recording (docs/design/auto-blur.md §5.5, §5.8, §5.11): ffmpeg seeks to the
//! key frame at or before what is wanted (`-ss` before `-i`, with `-copyts` so every time is the
//! file's own), decodes from there and keeps only the frames selected by time. A first `showinfo`
//! counts every decoded frame (R16) and a second, after the selection, gives each kept frame's
//! exact time. A read never decodes from the start of the recording.

use crate::ffmpeg::{secs, Info, Run};
use crate::mp4;
use crate::protocol::Failure;
use crate::read::{too_large, Frame};
use crate::stats;
use std::time::Duration;

/// Half a millisecond: a frame time from `showinfo` (six decimals) is within this of the frame.
pub const EPS: f64 = 0.0005;
/// How far a selection meant to end at a time reaches past it (`Stream::until`): a frame or more at
/// 10 frames a second and up.
pub const PAST: f64 = 0.1;
const INFO_WAIT: Duration = Duration::from_secs(60);

/// Refuses a recording that is too large, from its header when it is an MP4 (before ffmpeg starts).
pub fn check_size(video: &str) -> Result<(), Failure> {
    match mp4::size(video) {
        Some((w, h)) if too_large(w, h) => Err(Failure::TooLarge),
        _ => Ok(()),
    }
}

/// A stream of selected frames, `bytes(w, h)` each.
pub struct Stream {
    run: Run,
    bytes_per: fn(usize, usize) -> usize,
    pub size: Option<(usize, usize)>,
    pub decoded: u64,
    ended: bool,
    /// Ends the stream at the first frame at or after this time (see `until`).
    until: Option<f64>,
}

impl Stream {
    /// `vf`: the filters after the first showinfo: the selection, a second showinfo, then the
    /// scale and format. The first frame's size is checked (`tooLarge`) before its pixels are read.
    pub fn open(ffmpeg: &str, video: &str, seek: f64, vf: &str, threads: u32, limit: Duration, bytes_per: fn(usize, usize) -> usize) -> Result<Stream, Failure> {
        Stream::spawn(ffmpeg, video, seek, true, vf, threads, limit, bytes_per)
    }

    /// As `open`, but every frame from the key frame at or before `seek` goes through the filters
    /// (`-noaccurate_seek`): ffmpeg decodes those frames either way, and a backward follow piece
    /// keeps them, so the piece before it never decodes them again (§5.8).
    pub fn open_from_key(ffmpeg: &str, video: &str, seek: f64, vf: &str, threads: u32, limit: Duration, bytes_per: fn(usize, usize) -> usize) -> Result<Stream, Failure> {
        Stream::spawn(ffmpeg, video, seek, false, vf, threads, limit, bytes_per)
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn(ffmpeg: &str, video: &str, seek: f64, accurate: bool, vf: &str, threads: u32, limit: Duration, bytes_per: fn(usize, usize) -> usize) -> Result<Stream, Failure> {
        check_size(video)?;
        let mut args: Vec<String> = vec![];
        if !accurate {
            args.push("-noaccurate_seek".into());
        }
        args.extend(["-ss", &secs(seek), "-copyts", "-i", video, "-map", "0:v:0", "-vf", &format!("showinfo=checksum=0,{vf}"), "-fps_mode", "passthrough", "-f", "rawvideo", "-"].iter().map(|s| s.to_string()));
        let run = Run::spawn(ffmpeg, &args, threads, limit)?;
        Ok(Stream { run, bytes_per, size: None, decoded: 0, ended: false, until: None })
    }

    /// Ends the stream at the first selected frame at or after `t`, before its pixels are read, or at
    /// the first decoded frame `PAST` after `t`. ffmpeg holds a selected frame's pixels until the next
    /// selected frame or the end of the recording, so a selection meant to end at `t` must reach past
    /// it (by `PAST`): without the frame after, the last frame wanted came only once ffmpeg had decoded
    /// the rest of the recording for nothing.
    pub fn until(mut self, t: f64) -> Stream {
        self.until = Some(t);
        self
    }

    /// The next selected frame: its showinfo (time, key flag, output size) and its pixels.
    pub fn next(&mut self) -> Result<Option<(Info, Vec<u8>)>, Failure> {
        if self.ended {
            return Ok(None);
        }
        loop {
            let Some(info) = self.run.next_info(INFO_WAIT) else {
                self.ended = true;
                return Ok(None);
            };
            if info.filter == 0 {
                if self.until.is_some_and(|u| info.t >= u + PAST) {
                    self.ended = true;
                    return Ok(None);
                }
                self.decoded += 1;
                if self.size.is_none() {
                    if too_large(info.w, info.h) {
                        return Err(Failure::TooLarge);
                    }
                    self.size = Some((info.w, info.h));
                }
                continue;
            }
            if self.until.is_some_and(|u| info.t >= u) {
                self.ended = true;
                return Ok(None);
            }
            let mut buf = vec![0u8; (self.bytes_per)(info.w, info.h)];
            self.run.read_frame(&mut buf)?;
            return Ok(Some((info, buf)));
        }
    }
}

fn rgb_bytes(w: usize, h: usize) -> usize {
    w * h * 3
}

pub fn gray_bytes(w: usize, h: usize) -> usize {
    w * h
}

/// The frames at `times` (sorted, within about a second of each other), decoded in one run from
/// `key`: for each time the first frame at or after it (§5.5, reads less than 1.0 s apart share
/// one ffmpeg). A time past the end gives Err(video) for that time.
pub fn frames_at(ffmpeg: &str, video: &str, key: f64, times: &[f64], check: &dyn Fn() -> Result<(), Failure>) -> Vec<Result<(f64, Frame), Failure>> {
    let mut out: Vec<Option<Result<(f64, Frame), Failure>>> = times.iter().map(|_| None).collect();
    let windows: Vec<(f64, f64)> = times.iter().enumerate().map(|(i, &t)| (t - EPS, times.get(i + 1).map_or(t + 0.1, |&n| (n - EPS).min(t + 0.1).max(t + EPS)))).collect();
    let select = windows.iter().map(|(a, b)| format!("between(t\\,{}\\,{})", secs(*a), secs(*b))).collect::<Vec<_>>().join("+");
    let vf = format!("select='{select}',showinfo=checksum=0,format=rgb24");
    let seek = key.min(times.first().copied().unwrap_or(key));
    let limit = Duration::from_secs_f64(60.0 + (times.last().copied().unwrap_or(seek) - seek).max(0.0));
    let mut stream = match Stream::open(ffmpeg, video, seek, &vf, 1, limit, rgb_bytes) {
        Ok(s) => s,
        Err(f) => return times.iter().map(|_| Err(f)).collect(),
    };
    let mut fail = None;
    while out.iter().any(Option::is_none) {
        if let Err(f) = check() {
            fail = Some(f);
            break;
        }
        match stream.next() {
            Ok(Some((info, rgb))) => {
                if let Some(i) = windows.iter().position(|(a, b)| info.t >= *a && info.t < *b) {
                    if out[i].is_none() {
                        out[i] = Some(Ok((info.t, Frame { w: info.w, h: info.h, rgb })));
                    }
                }
            }
            Ok(None) => break,
            Err(f) => {
                fail = Some(f);
                break;
            }
        }
    }
    stats::set(&stats::LAST_READ_DECODED, stream.decoded);
    stats::add(&stats::READ_DECODED, stream.decoded);
    let fail = fail.unwrap_or(Failure::Video);
    out.into_iter().map(|o| o.unwrap_or(Err(fail))).collect()
}
