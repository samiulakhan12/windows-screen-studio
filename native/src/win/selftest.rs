//! `selftest`: the record pipeline minus screen capture. Encodes a generated colour
//! sweep through the GPU colour conversion and the H.264 encoder, so encoder or
//! driver problems can be told apart from capture problems on a user's machine.

use std::time::{Duration, Instant};

use windows::Win32::Graphics::Direct3D11::ID3D11RenderTargetView;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;

use super::d3d;
use super::encoder::{Encoder, EncoderSettings};
use super::processor::Processor;
use super::{init_winrt, output_path, Context, Failure, MediaFoundation, PartialFile, Result};
use crate::cli::SelftestArgs;
use crate::exit;
use crate::output;
use crate::pacer::Pacer;
use crate::protocol::{self, JsonObject};
use crate::sizing;

const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;
/// How long to wait for the encoder to hand back an input texture before giving up.
const SLOT_TIMEOUT: Duration = Duration::from_secs(5);

pub fn run(args: &SelftestArgs) -> i32 {
    match selftest(args) {
        Ok(report) => {
            output::emit(&report);
            exit::OK
        }
        Err(failure) => {
            output::emit(&protocol::event_error(&failure.message));
            output::log(&failure.message);
            failure.code
        }
    }
}

/// A saturated hue for frame `n` (full cycle every 2 seconds at 30 fps).
fn colour(n: u64) -> [f32; 4] {
    let h = (n % 60) as f32 / 10.0;
    let x = 1.0 - (h % 2.0 - 1.0).abs();
    let (r, g, b) = match h as u32 {
        0 => (1.0, x, 0.0),
        1 => (x, 1.0, 0.0),
        2 => (0.0, 1.0, x),
        3 => (0.0, x, 1.0),
        4 => (x, 0.0, 1.0),
        _ => (1.0, 0.0, x),
    };
    [r, g, b, 1.0]
}

fn selftest(args: &SelftestArgs) -> Result<String> {
    let mut partial = PartialFile::default();
    init_winrt()?;
    let _mf = MediaFoundation::start()?;
    let path = output_path(&args.out)?;
    let device = d3d::create_device(None)?;
    let settings = EncoderSettings {
        width: WIDTH,
        height: HEIGHT,
        fps: args.fps,
        bitrate: sizing::default_bitrate(WIDTH, HEIGHT, args.fps),
    };
    // Encoder first: it is what this command is mostly about.
    partial.arm(&path);
    let encoder = Encoder::create(&path, &device, &settings)?;
    let mut processor = Processor::new(&device, (WIDTH, HEIGHT), (WIDTH, HEIGHT), args.fps)?;

    let source = d3d::create_texture(&device.device, WIDTH, HEIGHT, DXGI_FORMAT_B8G8R8A8_UNORM)?;
    let mut view: Option<ID3D11RenderTargetView> = None;
    unsafe { device.device.CreateRenderTargetView(&source, None, Some(&mut view)) }
        .context("Creating a render target")?;
    let view = view.ok_or_else(|| Failure::runtime("No render target view"))?;
    processor.set_input(&source)?;

    let pacer = Pacer::new(args.fps, 0);
    let frames = (args.fps * args.seconds) as u64;
    let began = Instant::now();
    for n in 0..frames {
        unsafe { device.context.ClearRenderTargetView(&view, &colour(n)) };
        // Unlike live capture, wait for the encoder instead of dropping frames.
        let deadline = Instant::now() + SLOT_TIMEOUT;
        let target = loop {
            if let Some(target) = encoder.next_slot()? {
                break target;
            }
            if Instant::now() > deadline {
                return Err(Failure::runtime("The encoder stopped accepting frames"));
            }
            std::thread::sleep(Duration::from_millis(1));
        };
        processor.convert(&target.texture, target.subresource)?;
        let slot = pacer.slot(n);
        encoder.write(target, slot.time, slot.duration)?;
    }
    let name = encoder.name.clone();
    let hardware = encoder.hardware;
    encoder.finish()?;
    partial.keep();
    let elapsed = began.elapsed().as_secs_f64();
    Ok(JsonObject::new()
        .str("event", "selftest")
        .bool("ok", true)
        .str("file", &path.display().to_string())
        .int("frames", frames as i64)
        .int("width", WIDTH as i64)
        .int("height", HEIGHT as i64)
        .int("fps", args.fps as i64)
        .str("encoder", &name)
        .bool("hardware", hardware)
        .num("seconds", elapsed)
        // How many times faster than real time the pipeline ran (must be > 1 to record live).
        .num("speed", args.seconds as f64 / elapsed.max(1e-6))
        .finish())
}
