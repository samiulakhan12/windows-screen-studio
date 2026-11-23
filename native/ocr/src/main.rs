//! ssw-ocr: Flown's text reader helper (docs/design/auto-blur.md §5, §10.4). It reads text on
//! screen in a recording with PaddlePaddle's PP-OCRv6 models through tract, on this PC, for Find
//! private info. One JSON command a line on stdin, one JSON answer a line on stdout
//! (`src/shared/privacy/protocol.ts`); it opens no port, writes no file and runs nothing it
//! downloaded (the models are data, checked by size and SHA-256 before they are parsed).
//!
//!   ssw-ocr [--low-priority]
//!
//! Threads (§5.5): this one reads stdin and handles `careful` (to the front of the queue),
//! `release`, `cancel`, `pause`, `resume` and `stop` between commands; a look worker runs the look
//! pass with its own ffmpeg; one inference worker runs `open`, reads, careful re-reads and follow
//! sessions from one queue, decoding the next read's frame while the current one is read. A
//! heartbeat line goes out every 2 s from the start, also while `open` hashes and parses. The
//! helper ends when stdin ends or a write to stdout fails, so nothing it holds outlives the app.

mod control;
mod ctc;
mod decode;
mod ffmpeg;
mod follow;
mod geom;
mod guard;
mod look;
mod models;
mod mp4;
mod protocol;
mod qr;
mod read;
mod stats;
mod winocr;

use protocol::{parse_command, BoxF, Command, Failure, Out, Reader};
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, Read as _};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Reads less than this far apart share one ffmpeg run (§5.5).
const SHARE_DECODE_S: f64 = 1.0;

static OUT: Out = Out::new();

fn out() -> &'static Out {
    &OUT
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A command queue a worker waits on.
struct Queue {
    q: Mutex<VecDeque<Command>>,
    cv: Condvar,
}

impl Queue {
    const fn new() -> Self {
        Queue { q: Mutex::new(VecDeque::new()), cv: Condvar::new() }
    }

    fn push(&self, c: Command, front: bool) {
        let mut q = lock(&self.q);
        if front {
            q.push_front(c);
        } else {
            q.push_back(c);
        }
        self.cv.notify_all();
    }

    /// Takes command `id` out of the queue when it is still waiting.
    fn remove(&self, id: u64) -> bool {
        let mut q = lock(&self.q);
        match q.iter().position(|c| c.id() == id) {
            Some(i) => {
                q.remove(i);
                true
            }
            None => false,
        }
    }
}

static INFER: Queue = Queue::new();
static LOOK: Queue = Queue::new();
/// The ffmpeg `open` named; the look worker reads it too.
static FFMPEG: Mutex<Option<String>> = Mutex::new(None);
/// Each answered read's line crops, until `careful` or `release` (§5.6).
static CROPS: Mutex<Option<HashMap<u64, Vec<read::Crop>>>> = Mutex::new(None);

fn ffmpeg_path() -> Option<String> {
    lock(&FFMPEG).clone()
}

enum Engine {
    Paddle { parsed: models::Parsed, plans: Option<models::Plans> },
    Windows(winocr::WinReader),
}

/// A read taken from the queue: its id, time and areas.
#[derive(Clone)]
struct Ask {
    id: u64,
    t: f64,
    areas: Vec<BoxF>,
}

type Decoded = Vec<Result<(f64, read::Frame), Failure>>;

struct Worker {
    engine: Option<Engine>,
    sessions: HashMap<u64, follow::Session>,
    ready: VecDeque<(Ask, Result<(f64, read::Frame), Failure>)>,
    prefetch: Option<(Vec<Ask>, JoinHandle<Decoded>)>,
}

impl Worker {
    fn new() -> Self {
        Worker { engine: None, sessions: HashMap::new(), ready: VecDeque::new(), prefetch: None }
    }

    fn run(mut self) {
        loop {
            let job = {
                let mut q = lock(&INFER.q);
                loop {
                    if let Some(i) = q.iter().position(|c| matches!(c, Command::Careful { .. })) {
                        break q.remove(i);
                    }
                    if !self.ready.is_empty() || self.prefetch.is_some() {
                        break None;
                    }
                    if let Some(c) = q.pop_front() {
                        break Some(c);
                    }
                    q = INFER.cv.wait(q).unwrap_or_else(|e| e.into_inner());
                }
            };
            match job {
                Some(Command::Read { id, video, key, t, areas }) => {
                    let group = take_group(Ask { id, t, areas }, &video);
                    let frames = decode_group(&video, key, &group);
                    self.ready.extend(group.into_iter().zip(frames));
                }
                Some(c) => self.handle(c),
                None => {
                    if self.ready.is_empty() {
                        if let Some((group, handle)) = self.prefetch.take() {
                            let frames = handle.join().unwrap_or_else(|_| group.iter().map(|_| Err(Failure::Panic)).collect());
                            self.ready.extend(group.into_iter().zip(frames));
                        }
                        continue;
                    }
                    self.start_prefetch();
                    if let Some((ask, frame)) = self.ready.pop_front() {
                        self.read(ask, frame);
                    }
                }
            }
        }
    }

    /// The next waiting read's frames are decoded on another thread while this one is read.
    fn start_prefetch(&mut self) {
        if self.prefetch.is_some() {
            return;
        }
        let next = {
            let mut q = lock(&INFER.q);
            match q.front() {
                Some(Command::Read { .. }) => q.pop_front(),
                _ => None,
            }
        };
        let Some(Command::Read { id, video, key, t, areas }) = next else { return };
        let group = take_group(Ask { id, t, areas }, &video);
        let g2 = group.clone();
        let handle = std::thread::spawn(move || decode_group(&video, key, &g2));
        self.prefetch = Some((group, handle));
    }

    fn read(&mut self, ask: Ask, frame: Result<(f64, read::Frame), Failure>) {
        let id = ask.id;
        let result = frame.and_then(|(t, f)| {
            control::checkpoint(id)?;
            self.read_frame(id, t, &f, &ask.areas)
        });
        if let Err(f) = result {
            out().error(id, f);
        }
        control::end(id);
    }

    /// Reads one frame inside catch_unwind; after a panic the plans are built again (§5.6).
    fn read_frame(&mut self, id: u64, t: f64, frame: &read::Frame, areas: &[BoxF]) -> Result<(), Failure> {
        let check = || control::checkpoint(id);
        let outcome = match self.engine.as_ref() {
            None => return Err(Failure::BadCommand),
            Some(Engine::Paddle { plans: None, .. }) => return Err(Failure::Read),
            Some(Engine::Paddle { parsed, plans: Some(p) }) => {
                let e = read::Engine { plans: p, chars_tiny: &parsed.chars_tiny, chars_small: &parsed.chars_small };
                catch_unwind(AssertUnwindSafe(|| e.read(frame, areas, &check)))
            }
            Some(Engine::Windows(w)) => catch_unwind(AssertUnwindSafe(|| read_windows(w, frame, areas, &check))),
        };
        match outcome {
            Ok(Ok(o)) => {
                let body = read::result_json(t, &o);
                if !o.crops.is_empty() {
                    lock(&CROPS).get_or_insert_with(HashMap::new).insert(id, o.crops);
                }
                out().send(json!({ "id": id, "read": body }));
                Ok(())
            }
            Ok(Err(f)) => Err(f),
            Err(_) => {
                stats::add(&stats::PANICS, 1);
                self.rebuild();
                Err(Failure::Panic)
            }
        }
    }

    /// Drops the plans and builds them again from the parsed models: tract's state inside a
    /// panicked run is not trusted.
    fn rebuild(&mut self) {
        if let Some(Engine::Paddle { parsed, plans }) = self.engine.as_mut() {
            *plans = None;
            *plans = parsed.plans().ok();
        }
    }

    fn careful(&mut self, id: u64, read_id: u64, lines: &[usize]) {
        let taken = lock(&CROPS).as_mut().and_then(|m| m.remove(&read_id));
        let Some(cs) = taken else {
            out().error(id, Failure::Read);
            return;
        };
        let Some(Engine::Paddle { parsed, plans: Some(p) }) = self.engine.as_ref() else {
            out().send(json!({ "id": id, "careful": lines.iter().map(|_| json!([])).collect::<Vec<_>>() }));
            return;
        };
        let e = read::Engine { plans: p, chars_tiny: &parsed.chars_tiny, chars_small: &parsed.chars_small };
        let outcome = catch_unwind(AssertUnwindSafe(|| lines.iter().map(|&i| cs.get(i).map_or(json!([]), |c| read::variants_json(&[e.recognise(c, true)]))).collect::<Vec<_>>()));
        match outcome {
            Ok(v) => out().send(json!({ "id": id, "careful": v })),
            Err(_) => {
                stats::add(&stats::PANICS, 1);
                self.rebuild();
                out().error(id, Failure::Panic);
            }
        }
    }

    fn handle(&mut self, c: Command) {
        let id = c.id();
        control::begin(id);
        match c {
            Command::Open { reader, models, ffmpeg, .. } => {
                *lock(&FFMPEG) = Some(ffmpeg);
                self.engine = None;
                let engine = match reader {
                    Reader::Paddle => models::open(&models).and_then(|parsed| {
                        let plans = parsed.plans()?;
                        Ok(Engine::Paddle { parsed, plans: Some(plans) })
                    }),
                    Reader::Windows => winocr::WinReader::new().map(Engine::Windows).map_err(|_| ()),
                };
                match engine {
                    Ok(e) => {
                        self.engine = Some(e);
                        let r = if reader == Reader::Paddle { "paddle" } else { "windows" };
                        out().send(json!({ "id": id, "opened": { "protocol": protocol::PROTOCOL, "version": VERSION, "reader": r } }));
                    }
                    Err(()) => out().error(id, if reader == Reader::Windows && !cfg!(windows) { Failure::BadCommand } else { Failure::Model }),
                }
            }
            Command::Careful { read, lines, .. } => self.careful(id, read, &lines),
            Command::FollowOpen { video, key, from, to, dir, .. } => match ffmpeg_path() {
                None => out().error(id, Failure::BadCommand),
                Some(f) => match catch_unwind(AssertUnwindSafe(|| follow::Session::open(&f, &video, key, from, to, dir))) {
                    Ok(Ok(s)) => {
                        out().send(s.json(id));
                        self.sessions.insert(id, s);
                    }
                    Ok(Err(e)) => out().error(id, e),
                    Err(_) => out().error(id, Failure::Panic),
                },
            },
            Command::Track { session, track, t, parts, .. } => match self.sessions.get_mut(&session) {
                None => out().error(id, Failure::BadCommand),
                Some(s) => match catch_unwind(AssertUnwindSafe(|| s.track(track, t, &parts))) {
                    Ok(Ok(())) => out().done(id),
                    Ok(Err(e)) => out().error(id, e),
                    Err(_) => out().error(id, Failure::Panic),
                },
            },
            Command::Match { session, t, tracks, .. } => match self.sessions.get_mut(&session) {
                None => out().error(id, Failure::BadCommand),
                Some(s) => match catch_unwind(AssertUnwindSafe(|| s.match_all(t, &tracks))) {
                    Ok(Ok(m)) => out().send(json!({ "id": id, "matched": m })),
                    Ok(Err(e)) => out().error(id, e),
                    Err(_) => out().error(id, Failure::Panic),
                },
            },
            Command::CloseSession { session, .. } => {
                self.sessions.remove(&session);
                out().done(id);
            }
            #[cfg(feature = "fixture")]
            Command::ReadImage { png, areas, .. } => {
                let frame = load_png(&png).ok_or(Failure::Read).map(|f| (0.0, f));
                self.read(Ask { id, t: 0.0, areas }, frame);
                return;
            }
            _ => out().error(id, Failure::BadCommand),
        }
        control::end(id);
    }
}

/// `first` and the reads waiting right behind it in the queue that are of the same video and
/// less than a second after it: decoded in one ffmpeg run.
fn take_group(first: Ask, video: &str) -> Vec<Ask> {
    control::begin(first.id);
    let t = first.t;
    let mut group = vec![first];
    let mut q = lock(&INFER.q);
    while let Some(Command::Read { video: nv, t: nt, .. }) = q.front() {
        if nv != video || *nt < t || *nt - t >= SHARE_DECODE_S {
            break;
        }
        if let Some(Command::Read { id, t, areas, .. }) = q.pop_front() {
            control::begin(id);
            group.push(Ask { id, t, areas });
        }
    }
    group
}

fn decode_group(video: &str, key: f64, group: &[Ask]) -> Decoded {
    let Some(ffmpeg) = ffmpeg_path() else { return group.iter().map(|_| Err(Failure::BadCommand)).collect() };
    let times: Vec<f64> = group.iter().map(|a| a.t).collect();
    let first = group[0].id;
    let check = || control::checkpoint(first);
    catch_unwind(AssertUnwindSafe(|| decode::frames_at(&ffmpeg, video, key, &times, &check))).unwrap_or_else(|_| group.iter().map(|_| Err(Failure::Panic)).collect())
}

fn read_windows(w: &winocr::WinReader, frame: &read::Frame, areas: &[BoxF], check: read::Check) -> Result<read::ReadOut, Failure> {
    let list: Vec<[usize; 4]> = if areas.is_empty() {
        vec![[0, 0, frame.w, frame.h]]
    } else {
        areas
            .iter()
            .filter_map(|a| {
                let x0 = a[0].max(0.0).floor() as usize;
                let y0 = a[1].max(0.0).floor() as usize;
                let x1 = ((a[0] + a[2]).ceil().max(0.0) as usize).min(frame.w);
                let y1 = ((a[1] + a[3]).ceil().max(0.0) as usize).min(frame.h);
                (x1 > x0 && y1 > y0).then_some([x0, y0, x1 - x0, y1 - y0])
            })
            .collect()
    };
    let mut lines = vec![];
    let mut codes = vec![];
    for a in list {
        check()?;
        lines.extend(w.read(frame, a)?);
        codes.extend(qr::find(frame, a));
    }
    Ok(read::ReadOut { lines, crops: vec![], qr: codes, partial: vec![] })
}

#[cfg(feature = "fixture")]
fn load_png(path: &str) -> Option<read::Frame> {
    let file = std::fs::File::open(path).ok()?;
    let mut dec = png::Decoder::new(std::io::BufReader::new(file));
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = dec.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buf).ok()?;
    let (w, h) = (info.width as usize, info.height as usize);
    let chans = match info.color_type {
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        _ => return None,
    };
    let mut rgb = Vec::with_capacity(w * h * 3);
    for p in buf[..w * h * chans].chunks(chans) {
        match chans {
            1 | 2 => rgb.extend_from_slice(&[p[0], p[0], p[0]]),
            _ => rgb.extend_from_slice(&p[..3]),
        }
    }
    Some(read::Frame { w, h, rgb })
}

fn look_worker() {
    loop {
        let job = {
            let mut q = lock(&LOOK.q);
            loop {
                if let Some(c) = q.pop_front() {
                    break c;
                }
                q = LOOK.cv.wait(q).unwrap_or_else(|e| e.into_inner());
            }
        };
        if let Command::Look { id, video, k, step, from, to } = job {
            control::begin(id);
            let result = match ffmpeg_path() {
                None => Err(Failure::BadCommand),
                Some(f) => catch_unwind(AssertUnwindSafe(|| look::run(id, &f, &video, k, step, from, to, out()))).unwrap_or(Err(Failure::Panic)),
            };
            if let Err(e) = result {
                out().error(id, e);
            }
            control::end(id);
        }
    }
}

/// Reads one line of at most MAX_LINE bytes: Ok(None) at the end of input, Ok(Some(false)) for a
/// longer line (its rest skipped).
fn read_line(r: &mut impl BufRead, buf: &mut Vec<u8>) -> std::io::Result<Option<bool>> {
    buf.clear();
    let n = r.by_ref().take(protocol::MAX_LINE as u64 + 1).read_until(b'\n', buf)?;
    if n == 0 {
        return Ok(None);
    }
    if buf.last() != Some(&b'\n') && buf.len() > protocol::MAX_LINE {
        let mut rest = Vec::new();
        loop {
            rest.clear();
            let m = r.by_ref().take(1 << 20).read_until(b'\n', &mut rest)?;
            if m == 0 || rest.last() == Some(&b'\n') {
                break;
            }
        }
        return Ok(Some(false));
    }
    Ok(Some(true))
}

fn main() {
    guard::panic_hook();
    guard::crash_reports();
    for a in std::env::args().skip(1) {
        match a.as_str() {
            "--low-priority" => guard::lower_priority(),
            _ => {
                eprintln!("ssw-ocr: unknown argument");
                guard::exit_now(64);
            }
        }
    }
    // The heartbeat runs from the start (also while `open` hashes and parses, §10.4).
    std::thread::spawn(|| {
        let mut n = 0u64;
        loop {
            if out().emit(&json!({ "alive": n })).is_err() {
                guard::exit_now(0);
            }
            n += 1;
            std::thread::sleep(Duration::from_secs(2));
        }
    });
    std::thread::spawn(look_worker);
    std::thread::spawn(|| Worker::new().run());

    let stdin = std::io::stdin();
    let mut r = stdin.lock();
    let mut buf = Vec::new();
    loop {
        match read_line(&mut r, &mut buf) {
            Ok(None) | Err(_) => guard::exit_now(0),
            Ok(Some(false)) => {
                out().error(0, Failure::BadCommand);
                continue;
            }
            Ok(Some(true)) => {}
        }
        let Ok(text) = std::str::from_utf8(&buf) else {
            out().error(0, Failure::BadCommand);
            continue;
        };
        let text = text.trim_end_matches(['\n', '\r']);
        if text.trim().is_empty() {
            continue;
        }
        let cmd = match parse_command(text) {
            Ok(c) => c,
            Err(id) => {
                out().error(id.unwrap_or(0), Failure::BadCommand);
                continue;
            }
        };
        match cmd {
            Command::Careful { .. } => INFER.push(cmd, true),
            Command::Release { read, .. } => {
                if let Some(m) = lock(&CROPS).as_mut() {
                    m.remove(&read);
                }
            }
            Command::Cancel { target, .. } => {
                if INFER.remove(target) || LOOK.remove(target) {
                    out().error(target, Failure::Cancelled);
                } else {
                    control::cancel(target);
                }
            }
            Command::Pause { .. } => control::pause(true),
            Command::Resume { .. } => control::pause(false),
            Command::Stop { id } => {
                out().done(id);
                guard::exit_now(0);
            }
            Command::Look { .. } => LOOK.push(cmd, false),
            #[cfg(feature = "fixture")]
            Command::Stats { id } => out().send(json!({ "id": id, "stats": stats::json() })),
            #[cfg(feature = "fixture")]
            Command::PanicOn { id, text } => {
                *lock(&read::PANIC_ON) = text;
                out().done(id);
            }
            other => INFER.push(other, false),
        }
    }
}
