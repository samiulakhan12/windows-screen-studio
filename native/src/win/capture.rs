//! Windows.Graphics.Capture of one monitor or one window, cursor excluded.
//!
//! The frame pool is free-threaded and polled from the recording loop, so no
//! message pump or callback thread is needed and frames never pile up.
//!
//! Buffers and resizing: WGC renders each frame at the top-left of a pool buffer and crops
//! content larger than the buffer. A window's buffers are therefore created with room for it
//! to grow up to the largest monitor (`sizing::window_buffer_size`), so maximising it or
//! dragging it larger never yields a cropped frame. Content that still outgrows them (a window
//! spanning monitors) makes the buffers grow at once, with headroom, in the same call; they
//! never shrink. A cropped frame is never shown, and since WGC only sends a frame when the
//! content changes, the session is restarted (which always sends the current picture) if no
//! full frame follows soon: the video never keeps the pre-resize picture of a window that does
//! not repaint.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::core::Interface;
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureAccess, GraphicsCaptureAccessKind,
    GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

use super::d3d::{self, Device};
use super::{monitors, support, Context, Failure, Result};
use crate::output;
use crate::protocol;
use crate::sizing;

const PIXEL_FORMAT: DirectXPixelFormat = DirectXPixelFormat::B8G8R8A8UIntNormalized;
const POOL_BUFFERS: i32 = 2;
/// After a cropped frame made the buffers grow, how long to wait for a full frame before
/// restarting the session to get one (a window that does not repaint sends none).
const FULL_FRAME_WAIT: Duration = Duration::from_millis(100);

/// What is captured.
#[derive(Clone, Copy)]
pub enum Source {
    Monitor(HMONITOR),
    Window(HWND),
}

impl Source {
    /// "monitor" / "window", for messages.
    pub fn noun(self) -> &'static str {
        match self {
            Source::Monitor(_) => "monitor",
            Source::Window(_) => "window",
        }
    }
}

/// A captured frame; returned to the pool when dropped. Always the whole content (cropped
/// frames are never returned).
pub struct Frame {
    frame: Direct3D11CaptureFrame,
    pub texture: ID3D11Texture2D,
    /// Size of the content (top-left aligned) within `texture`, which may be larger.
    pub width: u32,
    pub height: u32,
    /// Capture time, 100 ns QPC ticks.
    pub time: i64,
}

impl Drop for Frame {
    fn drop(&mut self) {
        let _ = self.frame.Close();
    }
}

pub struct Capture {
    item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    device: IDirect3DDevice,
    fps: u32,
    /// A window: its buffers get headroom when they grow.
    window: bool,
    /// Size of the monitor or window when capture was set up (the recording's size).
    item_size: (u32, u32),
    /// Size of the pool's buffers: content up to this size arrives whole.
    buffer_size: (u32, u32),
    /// When a cropped frame made the buffers grow, while no full frame has arrived since.
    cropped_since: Option<Instant>,
    closed: Arc<AtomicBool>,
    closed_token: Option<i64>,
}

fn dims(size: SizeInt32) -> (u32, u32) {
    (size.Width.max(0) as u32, size.Height.max(0) as u32)
}

fn size_int(size: (u32, u32)) -> SizeInt32 {
    SizeInt32 { Width: size.0 as i32, Height: size.1 as i32 }
}

/// A capture session on `pool` set up the way this helper wants it (not started yet).
fn create_session(
    pool: &Direct3D11CaptureFramePool,
    item: &GraphicsCaptureItem,
    fps: u32,
) -> Result<GraphicsCaptureSession> {
    let session = pool.CreateCaptureSession(item).context("Creating the capture session")?;

    // The whole point of this helper: the app draws its own smooth cursor.
    session.SetIsCursorCaptureEnabled(false).context("Excluding the cursor from the capture")?;

    if support::border_toggle_supported() {
        if let Err(e) = session.SetIsBorderRequired(false) {
            output::emit(&protocol::event_warning(&super::describe("Hiding the capture border", &e)));
        }
    }
    if support::min_update_interval_supported() {
        // Twice the output rate: fresh content for every output frame without
        // composing 144-240 frames per second on high refresh rate monitors.
        let interval = TimeSpan { Duration: 10_000_000 / (2 * fps as i64) };
        let _ = session.SetMinUpdateInterval(interval);
    }
    Ok(session)
}

impl Capture {
    pub fn new(device: &Device, source: Source, fps: u32) -> Result<Self> {
        let winrt_device = d3d::winrt_device(&device.device)?;
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
            .context("Getting the GraphicsCaptureItem factory")?;
        let item: GraphicsCaptureItem = match source {
            Source::Monitor(monitor) => {
                unsafe { interop.CreateForMonitor(monitor) }.context("Creating the capture item for the monitor")?
            }
            // Fails for windows that cannot be captured (e.g. the shell's own, or another
            // desktop's); the app then records the window with Chromium instead.
            Source::Window(window) => {
                unsafe { interop.CreateForWindow(window) }.context("Creating the capture item for the window")?
            }
        };
        let noun = source.noun();
        let size = item.Size().context(&format!("Reading the {noun} size"))?;
        if size.Width <= 0 || size.Height <= 0 {
            return Err(Failure::runtime(format!("The {noun} reports an invalid size {}x{}", size.Width, size.Height)));
        }
        let item_size = dims(size);
        let window = matches!(source, Source::Window(_));
        let buffer_size =
            if window { sizing::window_buffer_size(item_size, monitors::largest_size()) } else { item_size };
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &winrt_device,
            PIXEL_FORMAT,
            POOL_BUFFERS,
            size_int(buffer_size),
        )
        .context("Creating the capture frame pool")?;
        if support::border_toggle_supported() {
            request_borderless_access();
        }
        let session = create_session(&pool, &item, fps)?;

        let closed = Arc::new(AtomicBool::new(false));
        let flag = closed.clone();
        let closed_token = item
            .Closed(&TypedEventHandler::new(move |_, _| {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            }))
            .ok();

        Ok(Self {
            item,
            pool,
            session,
            device: winrt_device,
            fps,
            window,
            item_size,
            buffer_size,
            cropped_since: None,
            closed,
            closed_token,
        })
    }

    /// Physical size of the monitor or window when capture was set up: the recording's size,
    /// whatever size the buffers grow to.
    pub fn size(&self) -> (u32, u32) {
        self.item_size
    }

    pub fn start(&self) -> Result<()> {
        self.session.StartCapture().context("Starting the capture")
    }

    /// True once the monitor was disconnected, the window closed, or the capture was revoked.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// A new session on the same pool: StartCapture always sends the current picture, also of a
    /// window that does not repaint.
    fn restart(&mut self) -> Result<()> {
        let _ = self.session.Close();
        self.session = create_session(&self.pool, &self.item, self.fps)?;
        self.start()
    }

    /// The newest frame waiting in the pool, if any; older ones are released. A frame whose
    /// content outgrew the buffers (cropped) is released too, and the buffers grow right away.
    pub fn newest(&mut self) -> Result<Option<Frame>> {
        if self.cropped_since.is_some_and(|t| t.elapsed() >= FULL_FRAME_WAIT) {
            self.cropped_since = None;
            self.restart()?;
        }
        let mut newest: Option<Direct3D11CaptureFrame> = None;
        for _ in 0..16 {
            match self.pool.TryGetNextFrame() {
                Ok(frame) => {
                    if let Some(old) = newest.replace(frame) {
                        let _ = old.Close();
                    }
                }
                // A null frame (nothing new) surfaces as an "empty" error.
                Err(e) if e.code() == windows::core::Error::empty().code() => break,
                Err(e) => return Err(Failure::runtime(super::describe("Reading a captured frame", &e))),
            }
        }
        let Some(frame) = newest else {
            return Ok(None);
        };
        let content = dims(frame.ContentSize().context("Reading the frame size")?);
        let time = frame.SystemRelativeTime().context("Reading the frame time")?.Duration;
        let surface = frame.Surface().context("Reading the frame surface")?;
        let access: IDirect3DDxgiInterfaceAccess = surface.cast().context("Querying the frame surface")?;
        let texture: ID3D11Texture2D = unsafe { access.GetInterface() }.context("Reading the frame texture")?;
        let desc = d3d::texture_desc(&texture);
        if !sizing::fits_in(content, (desc.Width, desc.Height)) {
            // Cropped: the window grew past the buffers (or the monitor's resolution grew, or it
            // was rotated). Drop the frame and grow the buffers for the following ones now
            // (Recreate also discards the frames still queued, drawn into the old buffers).
            drop((texture, access, surface));
            let _ = frame.Close();
            if let Some(grown) = sizing::grown_buffer_size(self.buffer_size, content, self.window) {
                self.pool
                    .Recreate(&self.device, PIXEL_FORMAT, POOL_BUFFERS, size_int(grown))
                    .context("Growing the capture frame pool")?;
                self.buffer_size = grown;
            }
            self.cropped_since.get_or_insert_with(Instant::now);
            return Ok(None);
        }
        self.cropped_since = None;
        let (width, height) = content;
        if width < 2 || height < 2 {
            let _ = frame.Close();
            return Ok(None);
        }
        Ok(Some(Frame { frame, texture, width, height, time }))
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if let Some(token) = self.closed_token.take() {
            let _ = self.item.RemoveClosed(token);
        }
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

/// Windows 11 lets apps hide the yellow capture border after asking for "borderless"
/// access, which unpackaged desktop apps are granted without a prompt. Never blocks
/// for more than a second.
fn request_borderless_access() {
    let Ok(op) = GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless) else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline {
        match op.Status() {
            Ok(status) if status.0 == 0 => std::thread::sleep(Duration::from_millis(5)), // Started
            _ => return,
        }
    }
}
