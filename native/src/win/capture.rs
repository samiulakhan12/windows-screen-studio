//! Windows.Graphics.Capture of one monitor, cursor excluded.
//!
//! The frame pool is free-threaded and polled from the recording loop, so no
//! message pump or callback thread is needed and frames never pile up.

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
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

use super::d3d::{self, Device};
use super::{support, Context, Failure, Result};
use crate::output;
use crate::protocol;

const PIXEL_FORMAT: DirectXPixelFormat = DirectXPixelFormat::B8G8R8A8UIntNormalized;
const POOL_BUFFERS: i32 = 2;

/// A captured frame; returned to the pool when dropped.
pub struct Frame {
    frame: Direct3D11CaptureFrame,
    pub texture: ID3D11Texture2D,
    /// Size of the valid content (top-left aligned) within `texture`.
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
    pool_size: SizeInt32,
    /// New content size seen in a frame; the pool is recreated once that frame is released.
    pending_resize: Option<SizeInt32>,
    closed: Arc<AtomicBool>,
    closed_token: Option<i64>,
}

impl Capture {
    pub fn new(device: &Device, monitor: HMONITOR, fps: u32) -> Result<Self> {
        let winrt_device = d3d::winrt_device(&device.device)?;
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
            .context("Getting the GraphicsCaptureItem factory")?;
        let item: GraphicsCaptureItem =
            unsafe { interop.CreateForMonitor(monitor) }.context("Creating the capture item for the monitor")?;
        let size = item.Size().context("Reading the monitor size")?;
        if size.Width <= 0 || size.Height <= 0 {
            return Err(Failure::runtime(format!(
                "The monitor reports an invalid size {}x{}",
                size.Width, size.Height
            )));
        }
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt_device, PIXEL_FORMAT, POOL_BUFFERS, size)
            .context("Creating the capture frame pool")?;
        let session = pool.CreateCaptureSession(&item).context("Creating the capture session")?;

        // The whole point of this helper: the app draws its own smooth cursor.
        session.SetIsCursorCaptureEnabled(false).context("Excluding the cursor from the capture")?;

        if support::border_toggle_supported() {
            request_borderless_access();
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
            pool_size: size,
            pending_resize: None,
            closed,
            closed_token,
        })
    }

    /// Physical size of the monitor when capture was set up.
    pub fn size(&self) -> (u32, u32) {
        (self.pool_size.Width as u32, self.pool_size.Height as u32)
    }

    pub fn start(&self) -> Result<()> {
        self.session.StartCapture().context("Starting the capture")
    }

    /// True once the monitor was disconnected or the capture was revoked.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// The newest frame waiting in the pool, if any; older ones are released.
    pub fn newest(&mut self) -> Result<Option<Frame>> {
        if let Some(size) = self.pending_resize.take() {
            // Resolution or orientation changed: later frames get buffers of the new size.
            self.pool
                .Recreate(&self.device, PIXEL_FORMAT, POOL_BUFFERS, size)
                .context("Resizing the capture frame pool")?;
            self.pool_size = size;
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
        let content = frame.ContentSize().context("Reading the frame size")?;
        let time = frame.SystemRelativeTime().context("Reading the frame time")?.Duration;
        let surface = frame.Surface().context("Reading the frame surface")?;
        let access: IDirect3DDxgiInterfaceAccess = surface.cast().context("Querying the frame surface")?;
        let texture: ID3D11Texture2D = unsafe { access.GetInterface() }.context("Reading the frame texture")?;
        let desc = d3d::texture_desc(&texture);
        let width = (content.Width.max(0) as u32).min(desc.Width);
        let height = (content.Height.max(0) as u32).min(desc.Height);

        if (content.Width != self.pool_size.Width || content.Height != self.pool_size.Height)
            && content.Width > 0
            && content.Height > 0
        {
            self.pending_resize = Some(content);
        }
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
