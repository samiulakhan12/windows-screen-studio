//! `record`: capture -> newest-frame texture -> NV12 (GPU) -> H.264 MP4, paced on
//! a constant frame grid with paused time removed (see pacer.rs).

use std::io::{self, BufRead};
use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use windows::core::BOOL;
use windows::Win32::Graphics::Direct3D11::{ID3D11Texture2D, D3D11_BOX};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::System::Console::SetConsoleCtrlHandler;

use super::capture::{Capture, Frame};
use super::clock;
use super::cursor::CursorWatcher;
use super::d3d::{self, Device};
use super::encoder::{Encoder, EncoderSettings};
use super::monitors;
use super::processor::Processor;
use super::{init_winrt, output_path, support, Failure, MediaFoundation, PartialFile, Result};
use crate::cli::RecordArgs;
use crate::exit;
use crate::output;
use crate::pacer::{Pacer, Timebase};
use crate::protocol::{self, Command, StartedInfo, StoppedInfo};
use crate::sizing;

/// WGC delivers the current screen right after StartCapture; no frame by then means it is broken.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(5);
/// Upper bound on one wait, so commands are handled within this time even while paused.
const MAX_WAIT_TICKS: i64 = 150_000; // 15 ms
/// How long the last frames wait for the encoder to accept them.
const TAIL_WAIT: Duration = Duration::from_secs(1);

enum Input {
    Command(Command),
    Invalid(String),
    Eof,
}

/// Set by Ctrl+C / Ctrl+Break / closing the console when run by hand: stop and finalise
/// the file instead of dying with an unplayable MP4.
static INTERRUPTED: AtomicBool = AtomicBool::new(false);

unsafe extern "system" fn on_console_ctrl(_kind: u32) -> BOOL {
    INTERRUPTED.store(true, Ordering::SeqCst);
    BOOL(1)
}

pub fn run(args: &RecordArgs) -> i32 {
    match record(args) {
        Ok(()) => exit::OK,
        Err(failure) => {
            output::emit(&protocol::event_error(&failure.message));
            output::log(&failure.message);
            failure.code
        }
    }
}

fn spawn_stdin_reader() -> Receiver<Input> {
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new().name("stdin".into()).spawn(move || {
        let stdin = io::stdin();
        let mut lock = stdin.lock();
        let mut line = Vec::new();
        loop {
            line.clear();
            match lock.read_until(b'\n', &mut line) {
                // EOF: the app closed our stdin or died. Either way, finish the file.
                Ok(0) | Err(_) => {
                    let _ = tx.send(Input::Eof);
                    return;
                }
                Ok(_) => {
                    let text = String::from_utf8_lossy(&line);
                    let text = text.trim();
                    if text.is_empty() {
                        continue;
                    }
                    let input = match protocol::parse_command(text) {
                        Ok(c) => Input::Command(c),
                        Err(e) => Input::Invalid(e),
                    };
                    if tx.send(input).is_err() {
                        return;
                    }
                }
            }
        }
    });
    if spawned.is_err() {
        output::log("could not start the stdin reader; only closing the process stops the recording");
    }
    rx
}

/// The newest captured frame, copied out of the capture pool so WGC can reuse its buffers.
struct Latest {
    texture: Option<ID3D11Texture2D>,
    size: (u32, u32),
}

impl Latest {
    fn update(&mut self, device: &Device, processor: &mut Processor, frame: &Frame) -> Result<()> {
        let size = (frame.width, frame.height);
        if self.texture.is_none() || self.size != size {
            let texture = d3d::create_texture(&device.device, size.0, size.1, DXGI_FORMAT_B8G8R8A8_UNORM)?;
            if processor.input_size() != size {
                processor.resize_input(size)?;
            }
            processor.set_input(&texture)?;
            self.texture = Some(texture);
            self.size = size;
        }
        if let Some(texture) = &self.texture {
            let region = D3D11_BOX { left: 0, top: 0, front: 0, right: size.0, bottom: size.1, back: 1 };
            unsafe { device.context.CopySubresourceRegion(texture, 0, 0, 0, 0, &frame.texture, 0, Some(&region)) };
        }
        Ok(())
    }
}

struct Session {
    device: Device,
    capture: Capture,
    processor: Processor,
    latest: Latest,
    pacer: Pacer,
    timebase: Timebase,
}

impl Session {
    fn refresh_frame(&mut self) -> Result<()> {
        if let Some(frame) = self.capture.newest()? {
            self.latest.update(&self.device, &mut self.processor, &frame)?;
        }
        Ok(())
    }

    /// Encodes the newest frame into `slots`. While recording, a slot the encoder has no
    /// room for is skipped; the final slots (`patient`) wait for room so the video reaches
    /// the stop instant.
    fn write(&mut self, encoder: &Encoder, slots: Range<u64>, patient: bool) -> Result<()> {
        for index in slots {
            let mut target = encoder.next_slot()?;
            let deadline = Instant::now() + TAIL_WAIT;
            while patient && target.is_none() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(2));
                target = encoder.next_slot()?;
            }
            match target {
                // The encoder is behind; skipping keeps memory and latency bounded.
                None => self.pacer.missed(index),
                Some(target) => {
                    self.processor.convert(&target.texture, target.subresource)?;
                    let slot = self.pacer.slot(index);
                    encoder.write(target, slot.time, slot.duration)?;
                    self.pacer.wrote(index);
                }
            }
        }
        Ok(())
    }

    fn epoch_ms(&self, ticks: i64) -> f64 {
        self.timebase.epoch_ms_at(ticks)
    }

    fn ticks(&self, at: Option<f64>, now: i64) -> i64 {
        at.map(|ms| self.timebase.ticks_at(ms)).unwrap_or(now)
    }

    fn apply(&mut self, command: Command, now: i64) -> Option<i64> {
        match command {
            Command::Pause(at) => {
                if let Some(t) = self.pacer.pause(self.ticks(at, now), now) {
                    output::emit(&protocol::event_paused(self.epoch_ms(t)));
                }
                None
            }
            Command::Resume(at) => {
                if let Some(t) = self.pacer.resume(self.ticks(at, now), now) {
                    output::emit(&protocol::event_resumed(self.epoch_ms(t)));
                }
                None
            }
            Command::Stop(at) => Some(self.ticks(at, now)),
        }
    }
}

fn record(args: &RecordArgs) -> Result<()> {
    // Declared first so it is dropped last, after the encoder and Media Foundation released the file.
    let mut partial = PartialFile::default();
    let _ = unsafe { SetConsoleCtrlHandler(Some(on_console_ctrl), true) };
    init_winrt()?;
    let _mf = MediaFoundation::start()?;
    match support::capture_supported() {
        Ok(true) => {}
        Ok(false) => {
            return Err(Failure::new(exit::UNSUPPORTED, "Windows.Graphics.Capture is not available on this system"))
        }
        Err(e) => return Err(Failure::new(exit::UNSUPPORTED, e)),
    }
    if !support::cursor_toggle_supported() {
        return Err(Failure::new(
            exit::UNSUPPORTED,
            "Recording without the cursor needs Windows 10 version 2004 or later",
        ));
    }
    let path = output_path(&args.out)?;
    let monitor = monitors::select(&args.monitor)?;

    let device = d3d::create_device(Some(monitor.handle))?;
    let capture = Capture::new(&device, monitor.handle, args.fps)?;
    let input = capture.size();
    let (width, height) = sizing::output_size(input.0, input.1);
    let processor = Processor::new(&device, input, (width, height), args.fps)?;
    let settings = EncoderSettings {
        width,
        height,
        fps: args.fps,
        bitrate: args.bitrate.unwrap_or_else(|| sizing::default_bitrate(width, height, args.fps)),
    };
    partial.arm(&path);
    let encoder = Encoder::create(&path, &device, &settings)?;
    if sizing::is_scaled(input, (width, height)) {
        output::emit(&protocol::event_warning(&format!(
            "The {}x{} monitor is recorded at {width}x{height}, the largest size H.264 encoders accept",
            input.0, input.1
        )));
    }

    let inputs = spawn_stdin_reader();
    output::emit(&protocol::event_ready());
    capture.start()?;

    let mut capture = capture;
    let mut queued: Vec<(Command, i64)> = Vec::new();
    let deadline = Instant::now() + FIRST_FRAME_TIMEOUT;
    let first = loop {
        if let Some(frame) = capture.newest()? {
            break frame;
        }
        while let Ok(input) = inputs.try_recv() {
            match input {
                Input::Command(Command::Stop(_)) | Input::Eof => {
                    // Nothing was recorded; `partial` removes the empty file.
                    output::emit(&protocol::event_stopped(&StoppedInfo {
                        frames: 0,
                        dropped: 0,
                        duration: 0.0,
                        reason: "stop",
                    }));
                    return Ok(());
                }
                Input::Command(c) => queued.push((c, clock::now_ticks())),
                Input::Invalid(e) => {
                    output::emit(&protocol::event_warning(&e));
                }
            }
        }
        if INTERRUPTED.load(Ordering::SeqCst) {
            output::emit(&protocol::event_stopped(&StoppedInfo {
                frames: 0,
                dropped: 0,
                duration: 0.0,
                reason: "interrupt",
            }));
            return Ok(());
        }
        if capture.is_closed() {
            return Err(Failure::runtime("The monitor was disconnected before recording started"));
        }
        if Instant::now() > deadline {
            return Err(Failure::runtime("Windows.Graphics.Capture delivered no frame within 5 seconds"));
        }
        std::thread::sleep(Duration::from_millis(2));
    };

    let now = clock::now_ticks();
    let timebase = clock::timebase();
    // SystemRelativeTime shares the QPC timebase; fall back to "now" if it looks off.
    let start = if first.time > 0 && first.time <= now && now - first.time < 10_000_000 { first.time } else { now };
    let mut session = Session {
        device,
        capture,
        processor,
        latest: Latest { texture: None, size: (0, 0) },
        pacer: Pacer::new(args.fps, start),
        timebase,
    };
    session.latest.update(&session.device, &mut session.processor, &first)?;
    drop(first);

    output::emit(&protocol::event_started(&StartedInfo {
        at: session.epoch_ms(start),
        width,
        height,
        fps: args.fps,
        encoder: &encoder.name,
        hardware: encoder.hardware,
    }));
    let cursor = CursorWatcher::spawn(timebase);

    let mut stop: Option<(i64, &str)> = None;
    for (command, received) in queued {
        if let Some(at) = session.apply(command, received) {
            stop = Some((at, "stop"));
        }
    }

    let result = run_loop(&mut session, &encoder, &inputs, stop);
    cursor.stop();
    match result {
        Ok(reason) => {
            encoder.finish()?;
            partial.keep();
            output::emit(&protocol::event_stopped(&StoppedInfo {
                frames: session.pacer.written(),
                dropped: session.pacer.dropped(),
                duration: session.pacer.duration() as f64 / 10_000_000.0,
                reason,
            }));
            Ok(())
        }
        Err(failure) => {
            // Keep whatever was recorded playable.
            if session.pacer.written() > 0 {
                match encoder.finish() {
                    Ok(()) => partial.keep(),
                    Err(e) => output::log(&format!("could not finalise the partial recording: {e}")),
                }
            }
            Err(failure)
        }
    }
}

fn run_loop(
    session: &mut Session,
    encoder: &Encoder,
    inputs: &Receiver<Input>,
    mut stop: Option<(i64, &'static str)>,
) -> Result<&'static str> {
    loop {
        while stop.is_none() {
            let Ok(input) = inputs.try_recv() else { break };
            let now = clock::now_ticks();
            match input {
                Input::Command(command) => {
                    if let Some(at) = session.apply(command, now) {
                        stop = Some((at, "stop"));
                    }
                }
                Input::Invalid(e) => {
                    output::emit(&protocol::event_warning(&e));
                }
                Input::Eof => stop = Some((now, "eof")),
            }
        }
        if stop.is_none() && session.capture.is_closed() {
            stop = Some((clock::now_ticks(), "closed"));
        }
        if stop.is_none() && output::stdout_broken() {
            stop = Some((clock::now_ticks(), "eof"));
        }
        if stop.is_none() && INTERRUPTED.load(Ordering::SeqCst) {
            stop = Some((clock::now_ticks(), "interrupt"));
        }

        if let Err(e) = session.refresh_frame() {
            // Reading frames fails once the monitor is gone; end the recording normally then.
            if !session.capture.is_closed() {
                return Err(e);
            }
            stop.get_or_insert((clock::now_ticks(), "closed"));
        }

        if let Some((at, reason)) = stop {
            let tail = session.pacer.finish(at, clock::now_ticks());
            session.write(encoder, tail, true)?;
            return Ok(reason);
        }

        let due = session.pacer.due(clock::now_ticks());
        session.write(encoder, due, false)?;

        let now = clock::now_ticks();
        let wait = match session.pacer.next_due() {
            Some(t) => (t - now).clamp(0, MAX_WAIT_TICKS),
            None => MAX_WAIT_TICKS,
        };
        if wait > 0 {
            std::thread::sleep(Duration::from_nanos(wait as u64 * 100));
        }
    }
}
