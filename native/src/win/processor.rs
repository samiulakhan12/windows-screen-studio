//! BGRA -> NV12 conversion (BT.709, limited range) and optional scaling on the GPU
//! with the Direct3D 11 video processor, so the encoder gets the exact input it
//! wants and no colour conversion runs on the CPU.

use std::collections::HashMap;
use std::mem::ManuallyDrop;

use windows::core::Interface;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoContext1, ID3D11VideoDevice, ID3D11VideoProcessor,
    ID3D11VideoProcessorEnumerator, ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView,
    D3D11_TEX2D_ARRAY_VPOV, D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_VIDEO_COLOR, D3D11_VIDEO_COLOR_0,
    D3D11_VIDEO_COLOR_RGBA, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_COLOR_SPACE,
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC, D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT,
    D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
    D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2DARRAY,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709, DXGI_FORMAT,
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL,
};

use super::d3d::{self, Device};
use super::{Context, Failure, Result};
use crate::sizing::{fit_rects, Rect};

/// Legacy colour space bits (D3D11_VIDEO_PROCESSOR_COLOR_SPACE): YCbCr_Matrix = BT.709
/// (bit 2) and Nominal_Range = 16-235 (bits 4-5 = 1). RGB input: all zero = full range.
const LEGACY_OUTPUT_BT709_LIMITED: u32 = (1 << 2) | (1 << 4);

pub struct Processor {
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    fps: u32,
    input_size: (u32, u32),
    output_size: (u32, u32),
    input_view: Option<(usize, ID3D11VideoProcessorInputView)>,
    output_views: HashMap<(usize, u32), ID3D11VideoProcessorOutputView>,
    frame_index: u32,
}

impl Processor {
    pub fn new(device: &Device, input: (u32, u32), output: (u32, u32), fps: u32) -> Result<Self> {
        let video_device: ID3D11VideoDevice =
            device.device.cast().context("Querying the Direct3D video device (the GPU driver lacks video support)")?;
        let video_context: ID3D11VideoContext = device.context.cast().context("Querying the Direct3D video context")?;
        let (enumerator, processor) = create(&video_device, input, output, fps)?;
        let p = Self {
            video_device,
            video_context,
            enumerator,
            processor,
            fps,
            input_size: input,
            output_size: output,
            input_view: None,
            output_views: HashMap::new(),
            frame_index: 0,
        };
        p.configure();
        Ok(p)
    }

    pub fn input_size(&self) -> (u32, u32) {
        self.input_size
    }

    /// The captured content changed size (resolution change or rotation).
    pub fn resize_input(&mut self, input: (u32, u32)) -> Result<()> {
        let (enumerator, processor) = create(&self.video_device, input, self.output_size, self.fps)?;
        self.enumerator = enumerator;
        self.processor = processor;
        self.input_size = input;
        // Views belong to the enumerator they were created with.
        self.input_view = None;
        self.output_views.clear();
        self.configure();
        Ok(())
    }

    fn configure(&self) {
        let vc = &self.video_context;
        let p = &self.processor;
        let (src, dst) = fit_rects(self.input_size, self.output_size);
        let target = Rect::sized(self.output_size.0, self.output_size.1);
        unsafe {
            vc.VideoProcessorSetStreamFrameFormat(p, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
            // No driver "enhancements" (denoise, edge enhancement...) on screen content.
            vc.VideoProcessorSetStreamAutoProcessingMode(p, 0, false);
            vc.VideoProcessorSetStreamSourceRect(p, 0, true, Some(&to_rect(src)));
            vc.VideoProcessorSetStreamDestRect(p, 0, true, Some(&to_rect(dst)));
            vc.VideoProcessorSetOutputTargetRect(p, true, Some(&to_rect(target)));
            let black = D3D11_VIDEO_COLOR {
                Anonymous: D3D11_VIDEO_COLOR_0 { RGBA: D3D11_VIDEO_COLOR_RGBA { R: 0.0, G: 0.0, B: 0.0, A: 1.0 } },
            };
            vc.VideoProcessorSetOutputBackgroundColor(p, false, &black);
            match vc.cast::<ID3D11VideoContext1>() {
                Ok(vc1) => {
                    vc1.VideoProcessorSetStreamColorSpace1(p, 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
                    vc1.VideoProcessorSetOutputColorSpace1(p, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
                }
                Err(_) => {
                    vc.VideoProcessorSetStreamColorSpace(p, 0, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: 0 });
                    vc.VideoProcessorSetOutputColorSpace(
                        p,
                        &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: LEGACY_OUTPUT_BT709_LIMITED },
                    );
                }
            }
        }
    }

    /// Uses `texture` (BGRA, `input_size`) as the source of the following conversions.
    pub fn set_input(&mut self, texture: &ID3D11Texture2D) -> Result<()> {
        let key = texture.as_raw() as usize;
        if self.input_view.as_ref().is_some_and(|(k, _)| *k == key) {
            return Ok(());
        }
        let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 },
            },
        };
        let mut view = None;
        unsafe { self.video_device.CreateVideoProcessorInputView(texture, &self.enumerator, &desc, Some(&mut view)) }
            .context("Creating the video processor input view")?;
        let view = view.ok_or_else(|| Failure::runtime("No video processor input view"))?;
        self.input_view = Some((key, view));
        Ok(())
    }

    fn output_view(&mut self, texture: &ID3D11Texture2D, subresource: u32) -> Result<ID3D11VideoProcessorOutputView> {
        let key = (texture.as_raw() as usize, subresource);
        if let Some(view) = self.output_views.get(&key) {
            return Ok(view.clone());
        }
        let array = d3d::texture_desc(texture).ArraySize > 1;
        let desc = if array {
            D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2DARRAY,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2DArray: D3D11_TEX2D_ARRAY_VPOV { MipSlice: 0, FirstArraySlice: subresource, ArraySize: 1 },
                },
            }
        } else {
            D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
            }
        };
        let mut view = None;
        unsafe { self.video_device.CreateVideoProcessorOutputView(texture, &self.enumerator, &desc, Some(&mut view)) }
            .context("Creating the video processor output view")?;
        let view = view.ok_or_else(|| Failure::runtime("No video processor output view"))?;
        // The encoder's sample pool is small and fixed, so this cache stays small.
        if self.output_views.len() > 64 {
            self.output_views.clear();
        }
        self.output_views.insert(key, view.clone());
        Ok(view)
    }

    /// Converts the current input into `output` (an NV12 texture or array slice).
    pub fn convert(&mut self, output: &ID3D11Texture2D, subresource: u32) -> Result<()> {
        let input = match &self.input_view {
            Some((_, view)) => view.clone(),
            None => return Err(Failure::runtime("No frame to convert yet")),
        };
        let view = self.output_view(output, subresource)?;
        let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: ManuallyDrop::new(Some(input)),
            ..Default::default()
        };
        let result = unsafe {
            self.video_context.VideoProcessorBlt(
                &self.processor,
                &view,
                self.frame_index,
                std::slice::from_ref(&stream),
            )
        };
        unsafe { ManuallyDrop::drop(&mut stream.pInputSurface) };
        self.frame_index = self.frame_index.wrapping_add(1);
        result.context("Converting the frame to NV12")
    }
}

fn to_rect(r: Rect) -> RECT {
    RECT { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

fn create(
    device: &ID3D11VideoDevice,
    input: (u32, u32),
    output: (u32, u32),
    fps: u32,
) -> Result<(ID3D11VideoProcessorEnumerator, ID3D11VideoProcessor)> {
    let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
        InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
        InputFrameRate: DXGI_RATIONAL { Numerator: fps, Denominator: 1 },
        InputWidth: input.0,
        InputHeight: input.1,
        OutputFrameRate: DXGI_RATIONAL { Numerator: fps, Denominator: 1 },
        OutputWidth: output.0,
        OutputHeight: output.1,
        Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
    };
    let enumerator =
        unsafe { device.CreateVideoProcessorEnumerator(&desc) }.context("Creating the video processor enumerator")?;
    require_format(
        &enumerator,
        DXGI_FORMAT_B8G8R8A8_UNORM,
        D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT.0 as u32,
        "BGRA input",
    )?;
    require_format(&enumerator, DXGI_FORMAT_NV12, D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT.0 as u32, "NV12 output")?;
    let processor = unsafe { device.CreateVideoProcessor(&enumerator, 0) }.context("Creating the video processor")?;
    Ok((enumerator, processor))
}

fn require_format(
    enumerator: &ID3D11VideoProcessorEnumerator,
    format: DXGI_FORMAT,
    flag: u32,
    what: &str,
) -> Result<()> {
    let support =
        unsafe { enumerator.CheckVideoProcessorFormat(format) }.context("Checking video processor formats")?;
    if support & flag == 0 {
        return Err(Failure::runtime(format!("The GPU video processor does not support {what}")));
    }
    Ok(())
}
