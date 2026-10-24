//! `record`: capture -> newest-frame texture -> NV12 (GPU) -> H.264 MP4, paced on
//! a constant frame grid with paused time removed (see pacer.rs).
//!
//! A window (`--window`) is recorded at its initial size; later sizes are scaled to fit
//! inside it (processor.rs, `sizing::fit_rects`), and its rectangle is reported as `window`
//! events (cursor.rs polls it). While it is minimised the last frame is repeated.

use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::{ID3D11Texture2D, D3D11_BOX};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;

use super::capture::{Capture, Frame, Source};
use super::clock;
use super::cursor::{CursorWatcher, FollowWindow};
use super::d3d::{self, Device};
use super::encoder::{Container, Encoder, EncoderSettings};
use super::monitors;
use super::processor::Processor;
use super::session_end::{self, SETTLED};
use super::window;
use super::{init_winrt, output_path, support, Failure, MediaFoundation, PartialFile, Result};
use crate::cli::{RecordArgs, Target};
use crate::exit;
use crate::input::{spawn_stdin_reader, Input};
use crate::interrupt::SetOnDrop;
use crate::output;
use crate::pacer::{Pacer, Timebase};
use crate::protocol::{self, Command, StartedInfo, StoppedInfo};
use crate::sizing;
use crate::window::{Change, WindowTracker};

/// WGC delivers the current screen right after StartCapture; no frame by then means it is broken.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(5);
/// Upper bound on one wait, so commands are handled within this time even while paused.
const MAX_WAIT_TICKS: i64 = 150_000; // 15 ms
/// How long the last frames wait for the encoder to accept them.
const TAIL_WAIT: Duration = Duration::from_secs(1);

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

/// The newest captured frame, copied out of the capture pool so WGC can reuse its buffers.
/// The texture holds the content at its top-left and only grows (to the largest content seen),
/// so a window being resized costs a copy per frame, not a new texture and video processor.
#[derive(Default)]
struct Latest {
    texture: Option<ID3D11Texture2D>,
    /// The texture's size: the largest content seen.
    capacity: (u32, u32),
}

impl Latest {
    fn update(&mut self, device: &Device, processor: &mut Processor, frame: &Frame) -> Result<()> {
        let size = (frame.width, frame.height);
        // The processor first: content larger than ever before rebuilds it (and drops its views).
        processor.set_content(size)?;
        let texture = match &self.texture {
            Some(texture) if sizing::fits_in(size, self.capacity) => texture.clone(),
            _ => {
                let capacity = sizing::covering(self.capacity, size);
                let texture = d3d::create_texture(&device.device, capacity.0, capacity.1, DXGI_FORMAT_B8G8R8A8_UNORM)?;
                self.capacity = capacity;
                self.texture = Some(texture.clone());
                texture
            }
        };
        // Cached per texture: only a new texture or a rebuilt processor creates a view.
        processor.set_input(&texture)?;
        let region = D3D11_BOX { left: 0, top: 0, front: 0, right: size.0, bottom: size.1, back: 1 };
        unsafe { device.context.CopySubresourceRegion(&texture, 0, 0, 0, 0, &frame.texture, 0, Some(&region)) };
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
    /// The recorded window, if recording one.
    window: Option<HWND>,
    /// Set by the cursor thread once the recorded window no longer exists.
    window_gone: Arc<AtomicBool>,
}

impl Session {
    fn refresh_frame(&mut self) -> Result<()> {
        if let Some(frame) = self.capture.newest()? {
            // Keep showing the last picture rather than whatever Windows may hand over for a
            // minimised window. (Cropped frames of a window that outgrew the capture buffers
            // never get here: capture.rs drops them and grows the buffers.)
            let have_frame = self.latest.texture.is_some();
            let skip = have_frame && self.window.is_some_and(window::is_minimized);
            if !skip {
                self.latest.update(&self.device, &mut self.processor, &frame)?;
            }
        }
        Ok(())
    }

    fn window_closed(&self) -> bool {
        self.window_gone.load(Ordering::SeqCst)
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
    // Declared first so it is dropped last: once the file is settled, a console close or
    // session end waiting in session_end.rs may let Windows end the process.
    let _settled = SetOnDrop(&SETTLED);
    // Dropped right before, after the encoder and Media Foundation released the file.
    let mut partial = PartialFile::default();
    session_end::watch();
    // A window that does not exist is "not found" (exit 4) on any system, like an unknown monitor.
    let window = match args.target {
        Target::Window(handle) => Some(window::find(handle)?),
        Target::Monitor(_) => None,
    };
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
    let (source, gpu_monitor) = match (window, &args.target) {
        (Some(w), _) => (Source::Window(w), window::monitor(w)),
        (None, Target::Monitor(selector)) => {
            let monitor = monitors::select(selector)?;
            (Source::Monitor(monitor.handle), monitor.handle)
        }
        (None, Target::Window(_)) => unreachable!("the window was looked up above"),
    };
    let noun = source.noun();

    let device = d3d::create_device(Some(gpu_monitor))?;
    let capture = Capture::new(&device, source, args.fps)?;
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
    if encoder.container != Container::Fragmented {
        output::emit(&protocol::event_warning(
            "Writing a plain MP4 (fragmented MP4 could not be set up): \
             the recording is lost if the capture helper is killed before it finishes",
        ));
    }
    if sizing::is_scaled(input, (width, height)) {
        output::emit(&protocol::event_warning(&format!(
            "The {}x{} {noun} is recorded at {width}x{height}, the largest size H.264 encoders accept",
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
        if let Some(reason) = session_end::requested() {
            output::emit(&protocol::event_stopped(&StoppedInfo { frames: 0, dropped: 0, duration: 0.0, reason }));
            return Ok(());
        }
        if capture.is_closed() {
            return Err(Failure::runtime(match source {
                Source::Monitor(_) => "The monitor was disconnected before recording started",
                Source::Window(_) => "The window was closed before recording started",
            }));
        }
        if Instant::now() > deadline {
            if window.is_some_and(window::is_minimized) {
                return Err(Failure::runtime(
                    "The window is minimised: Windows.Graphics.Capture shows nothing of it until it is restored",
                ));
            }
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
        latest: Latest::default(),
        pacer: Pacer::new(args.fps, start),
        timebase,
        window,
        window_gone: Arc::new(AtomicBool::new(false)),
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
        fragmented: encoder.container == Container::Fragmented,
    }));
    // The window's rectangle: once now (before any cursor event), then on change (cursor.rs).
    let follow = window.map(|w| {
        let mut tracker = WindowTracker::new();
        match tracker.update(window::observe(w), window::cursor_over(w)) {
            Change::Changed(state) => {
                output::emit(&protocol::event_window(session.epoch_ms(clock::now_ticks()), &state));
            }
            Change::Closed => session.window_gone.store(true, Ordering::SeqCst),
            Change::Unchanged => {}
        }
        FollowWindow { handle: w.0 as isize as i64, tracker, gone: session.window_gone.clone() }
    });
    let cursor = CursorWatcher::spawn(timebase, follow);

    let mut stop: Option<(i64, &str)> = None;
    for (command, received) in queued {
        if let Some(at) = session.apply(command, received) {
            stop = Some((at, "stop"));
        }
    }

    let result = run_loop(&mut session, &encoder, &inputs, stop);
    cursor.stop();
    let written = session.pacer.written();
    // A fragmented MP4 that could not be finalised still plays up to its last complete
    // fragment, so it is kept for recovery; a plain one has no index and is useless.
    let keep_unfinalised = encoder.container == Container::Fragmented && written > 0;
    match result {
        Ok(reason) => {
            if let Err(e) = encoder.finish() {
                if keep_unfinalised {
                    partial.keep();
                }
                return Err(e);
            }
            partial.keep();
            output::emit(&protocol::event_stopped(&StoppedInfo {
                frames: written,
                dropped: session.pacer.dropped(),
                duration: session.pacer.duration() as f64 / 10_000_000.0,
                reason,
            }));
            Ok(())
        }
        Err(failure) => {
            // Keep whatever was recorded playable.
            if written > 0 {
                match encoder.finish() {
                    Ok(()) => partial.keep(),
                    Err(e) => {
                        output::log(&format!("could not finalise the partial recording: {e}"));
                        if keep_unfinalised {
                            partial.keep();
                        }
                    }
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
        if stop.is_none() && (session.capture.is_closed() || session.window_closed()) {
            stop = Some((clock::now_ticks(), "closed"));
        }
        if stop.is_none() && output::stdout_broken() {
            stop = Some((clock::now_ticks(), "eof"));
        }
        if stop.is_none() {
            if let Some(reason) = session_end::requested() {
                stop = Some((clock::now_ticks(), reason));
            }
        }

        if let Err(e) = session.refresh_frame() {
            // Reading frames fails once the monitor or window is gone; end the recording normally then.
            if !session.capture.is_closed() && !session.window_closed() {
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
