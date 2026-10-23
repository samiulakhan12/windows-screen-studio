//! H.264 MP4 writer: a Media Foundation sink writer fed with NV12 Direct3D 11
//! textures, so a hardware encoder (NVENC, Quick Sync, AMF) consumes GPU frames
//! directly. Falls back to the Microsoft software encoder.

use std::path::{Path, PathBuf};

use windows::core::{Interface, GUID, HSTRING, PWSTR};
use windows::Win32::Graphics::Direct3D11::{ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_USAGE_DEFAULT};
use windows::Win32::Media::MediaFoundation::{
    eAVEncCommonRateControlMode_UnconstrainedVBR, eAVEncH264VProfile_High, CODECAPI_AVEncCommonMeanBitRate,
    CODECAPI_AVEncCommonRateControlMode, CODECAPI_AVEncMPVDefaultBPictureCount, CODECAPI_AVEncMPVGOPSize, IMF2DBuffer,
    IMFAttributes, IMFByteStream, IMFDXGIBuffer, IMFDXGIDeviceManager, IMFMediaSink, IMFMediaType, IMFSample,
    IMFSinkWriter, IMFSinkWriterEx, IMFTransform, IMFVideoSampleAllocatorEx, MFCreateAttributes,
    MFCreateDXGIDeviceManager, MFCreateFile, MFCreateMediaType, MFCreateSinkWriterFromURL,
    MFCreateVideoSampleAllocatorEx, MFMediaType_Video, MFNominalRange_16_235, MFT_ENUM_HARDWARE_URL_Attribute,
    MFT_FRIENDLY_NAME_Attribute, MFTranscodeContainerType_MPEG4, MFVideoFormat_H264, MFVideoFormat_NV12,
    MFVideoInterlace_Progressive, MFVideoPrimaries_BT709, MFVideoTransFunc_709, MFVideoTransferMatrix_BT709,
    MFT_CATEGORY_VIDEO_ENCODER, MF_ACCESSMODE_WRITE, MF_E_SAMPLEALLOCATOR_EMPTY, MF_FILEFLAGS_NONE,
    MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE,
    MF_MT_MAJOR_TYPE, MF_MT_MPEG2_PROFILE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_MT_TRANSFER_FUNCTION,
    MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES, MF_MT_YUV_MATRIX, MF_OPENMODE_DELETE_IF_EXIST,
    MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SA_D3D11_BINDFLAGS, MF_SA_D3D11_USAGE, MF_SINK_WRITER_D3D_MANAGER,
    MF_SINK_WRITER_MEDIASINK, MF_TRANSCODE_CONTAINERTYPE, MF_TRANSFORM_ASYNC,
};
use windows::Win32::System::Com::CoTaskMemFree;

use super::d3d::Device;
use super::{describe, Context, Failure, Result};
use crate::output;

/// Samples (NV12 textures) the encoder may hold at once. When all are in use the
/// encoder is behind and the frame is dropped rather than queued without bound.
const MAX_SAMPLES_IN_FLIGHT: u32 = 16;

pub struct EncoderSettings {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
}

/// A sink writer and the file it writes. Media Foundation releases a writer's file
/// asynchronously, so an abandoned writer (a failed setup attempt, an error) would keep
/// the file locked for a while; dropping this shuts the sink down and closes the file.
struct FileWriter {
    writer: IMFSinkWriter,
    file: IMFByteStream,
}

impl FileWriter {
    unsafe fn open(path: &Path, attributes: &IMFAttributes) -> Result<Self> {
        unsafe {
            let url = HSTRING::from(path.as_os_str());
            let file = MFCreateFile(MF_ACCESSMODE_WRITE, MF_OPENMODE_DELETE_IF_EXIST, MF_FILEFLAGS_NONE, &url)
                .context("Creating the output file")?;
            match MFCreateSinkWriterFromURL(&url, &file, attributes) {
                Ok(writer) => Ok(Self { writer, file }),
                Err(e) => {
                    let _ = file.Close();
                    Err(Failure::runtime(describe("Creating the MP4 writer", &e)))
                }
            }
        }
    }
}

impl Drop for FileWriter {
    fn drop(&mut self) {
        unsafe {
            let mut sink = std::ptr::null_mut();
            let id = MF_SINK_WRITER_MEDIASINK.0;
            if self.writer.GetServiceForStream(id, &GUID::zeroed(), &IMFMediaSink::IID, &mut sink).is_ok()
                && !sink.is_null()
            {
                // Already shut down after a successful Finalize; then this is a no-op.
                let _ = IMFMediaSink::from_raw(sink).Shutdown();
            }
            let _ = self.file.Close();
        }
    }
}

pub struct Encoder {
    output: FileWriter,
    stream: u32,
    allocator: IMFVideoSampleAllocatorEx,
    _manager: IMFDXGIDeviceManager,
    /// Encoder-check files that could not be deleted yet (still open by a failed attempt).
    leftovers: Vec<PathBuf>,
    pub name: String,
    pub hardware: bool,
}

impl Drop for Encoder {
    fn drop(&mut self) {
        remove_files(&mut self.leftovers);
    }
}

fn remove_files(files: &mut Vec<PathBuf>) {
    files.retain(|f| std::fs::remove_file(f).is_err() && f.exists());
    for f in files.iter() {
        output::log(&format!("could not delete {}", f.display()));
    }
}

/// A pooled NV12 sample and the texture (or array slice) to render into.
pub struct Slot {
    pub sample: IMFSample,
    pub texture: ID3D11Texture2D,
    pub subresource: u32,
}

/// Encoder configuration, from most to least specific. Some encoders reject a
/// property or media type attribute they do not support, which makes the whole
/// setup fail; each next level leaves more to the encoder's defaults.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tuning {
    /// VBR at the target bitrate, 1 s GOP, no B-frames, High profile, BT.709 tags.
    Full,
    /// Encoder's rate control; GOP and B-frames as above.
    GopOnly,
    /// Encoder defaults with BT.709 tags.
    Defaults,
    /// Bare media types: size, rate and bitrate only.
    Bare,
}

const TUNINGS: [Tuning; 4] = [Tuning::Full, Tuning::GopOnly, Tuning::Defaults, Tuning::Bare];

impl Encoder {
    pub fn create(path: &Path, device: &Device, settings: &EncoderSettings) -> Result<Self> {
        let mut reset_token = 0u32;
        let mut manager = None;
        unsafe { MFCreateDXGIDeviceManager(&mut reset_token, &mut manager) }
            .context("Creating the DXGI device manager")?;
        let manager = manager.ok_or_else(|| Failure::runtime("No DXGI device manager"))?;
        unsafe { manager.ResetDevice(&device.device, reset_token) }
            .context("Sharing the Direct3D device with Media Foundation")?;

        // Some failures only show once frames flow (e.g. Media Foundation picking a hardware
        // encoder of another GPU), so each configuration first encodes a few frames into a
        // throwaway file; the recording then uses the first one that works end to end.
        // Every attempt gets its own file in case a failed one still holds its file open.
        let mut leftovers = Vec::new();
        let mut last_error = String::new();
        let attempts = [true, false].into_iter().flat_map(|hw| TUNINGS.into_iter().map(move |t| (hw, t)));
        for (n, (hardware, tuning)) in attempts.enumerate() {
            let mut check = path.as_os_str().to_owned();
            check.push(format!(".encoder-check-{n}.mp4"));
            let check = PathBuf::from(check);
            let checked = Self::try_create(&check, &manager, settings, hardware, tuning).and_then(|e| e.smoke_test());
            if std::fs::remove_file(&check).is_err() && check.exists() {
                leftovers.push(check);
            }
            match checked.and_then(|()| Self::try_create(path, &manager, settings, hardware, tuning)) {
                Ok(mut encoder) => {
                    encoder.leftovers = leftovers;
                    return Ok(encoder);
                }
                Err(e) => {
                    output::log(&format!("encoder setup (hardware: {hardware}, {tuning:?}) failed: {e}"));
                    last_error = e.message;
                }
            }
        }
        remove_files(&mut leftovers);
        let _ = std::fs::remove_file(path);
        Err(Failure::runtime(format!("No H.264 encoder could be set up: {last_error}")))
    }

    /// Encodes a few frames and finalises; errors from asynchronous hardware encoders
    /// surface by then.
    fn smoke_test(self) -> Result<()> {
        let frame = 10_000_000 / 30;
        for n in 0..3 {
            let slot = self.next_slot()?.ok_or_else(|| Failure::runtime("The encoder accepted no input"))?;
            self.write(slot, n * frame, frame)?;
        }
        self.finish()
    }

    fn try_create(
        path: &Path,
        manager: &IMFDXGIDeviceManager,
        s: &EncoderSettings,
        hardware: bool,
        tuning: Tuning,
    ) -> Result<Self> {
        unsafe {
            let attributes = new_attributes(4)?;
            attributes
                .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, hardware as u32)
                .context("Configuring the writer")?;
            attributes.SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, manager).context("Configuring the writer")?;
            attributes
                .SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)
                .context("Configuring the writer")?;
            let output = FileWriter::open(path, &attributes)?;
            let writer = &output.writer;

            let tagged = tuning != Tuning::Bare;
            let output_type = video_type(s, &MFVideoFormat_H264, tagged)?;
            output_type.SetUINT32(&MF_MT_AVG_BITRATE, s.bitrate).context("Configuring H.264")?;
            if tagged {
                output_type
                    .SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)
                    .context("Configuring H.264")?;
            }
            let stream = writer.AddStream(&output_type).context("Adding the H.264 stream")?;

            let input_type = video_type(s, &MFVideoFormat_NV12, tagged)?;
            input_type.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1).context("Configuring NV12 input")?;
            let params = encoding_parameters(s, tuning)?;
            writer.SetInputMediaType(stream, &input_type, params.as_ref()).context("Setting up the H.264 encoder")?;

            let mut raw = std::ptr::null_mut();
            MFCreateVideoSampleAllocatorEx(&IMFVideoSampleAllocatorEx::IID, &mut raw)
                .context("Creating the sample allocator")?;
            let allocator = IMFVideoSampleAllocatorEx::from_raw(raw);
            allocator.SetDirectXManager(manager).context("Configuring the sample allocator")?;
            let pool = new_attributes(2)?;
            // Render target: the video processor writes the NV12 frame straight into the sample.
            pool.SetUINT32(&MF_SA_D3D11_BINDFLAGS, D3D11_BIND_RENDER_TARGET.0 as u32)
                .context("Configuring the sample allocator")?;
            pool.SetUINT32(&MF_SA_D3D11_USAGE, D3D11_USAGE_DEFAULT.0 as u32)
                .context("Configuring the sample allocator")?;
            allocator
                .InitializeSampleAllocatorEx(4, MAX_SAMPLES_IN_FLIGHT, &pool, &input_type)
                .context("Allocating encoder input textures")?;

            writer.BeginWriting().context("Starting the encoder")?;
            let (name, is_hardware) = describe_encoder(writer, stream, hardware);
            Ok(Self {
                output,
                stream,
                allocator,
                _manager: manager.clone(),
                leftovers: Vec::new(),
                name,
                hardware: is_hardware,
            })
        }
    }

    /// A free NV12 sample, or None when the encoder still holds all of them.
    pub fn next_slot(&self) -> Result<Option<Slot>> {
        let sample = match unsafe { self.allocator.AllocateSample() } {
            Ok(sample) => sample,
            Err(e) if e.code() == MF_E_SAMPLEALLOCATOR_EMPTY => return Ok(None),
            Err(e) => return Err(Failure::runtime(describe("Getting an encoder input texture", &e))),
        };
        unsafe {
            let buffer = sample.GetBufferByIndex(0).context("Reading the encoder sample")?;
            // Some encoders ignore buffers whose current length is zero.
            if let Ok(buffer2d) = buffer.cast::<IMF2DBuffer>() {
                if let Ok(len) = buffer2d.GetContiguousLength() {
                    let _ = buffer.SetCurrentLength(len);
                }
            }
            let dxgi: IMFDXGIBuffer = buffer.cast().context("Reading the encoder texture")?;
            let mut raw = std::ptr::null_mut();
            dxgi.GetResource(&ID3D11Texture2D::IID, &mut raw).context("Reading the encoder texture")?;
            let texture = ID3D11Texture2D::from_raw(raw);
            let subresource = dxgi.GetSubresourceIndex().context("Reading the encoder texture")?;
            Ok(Some(Slot { sample, texture, subresource }))
        }
    }

    pub fn write(&self, slot: Slot, time: i64, duration: i64) -> Result<()> {
        unsafe {
            slot.sample.SetSampleTime(time).context("Timestamping the frame")?;
            slot.sample.SetSampleDuration(duration).context("Timestamping the frame")?;
            self.output.writer.WriteSample(self.stream, &slot.sample).context("Encoding a frame")
        }
    }

    /// Drains the encoder and writes the MP4 index. Without it the file is unplayable.
    pub fn finish(self) -> Result<()> {
        unsafe { self.output.writer.Finalize() }.context("Finalising the MP4")
        // Dropping `self` closes the file.
    }
}

unsafe fn new_attributes(capacity: u32) -> Result<IMFAttributes> {
    let mut attributes = None;
    unsafe { MFCreateAttributes(&mut attributes, capacity) }.context("Creating Media Foundation attributes")?;
    attributes.ok_or_else(|| Failure::runtime("No Media Foundation attributes"))
}

fn pack(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | lo as u64
}

unsafe fn video_type(s: &EncoderSettings, subtype: &GUID, colour_tags: bool) -> Result<IMFMediaType> {
    unsafe {
        let t = MFCreateMediaType().context("Creating a media type")?;
        let what = "Describing the video format";
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).context(what)?;
        t.SetGUID(&MF_MT_SUBTYPE, subtype).context(what)?;
        t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).context(what)?;
        t.SetUINT64(&MF_MT_FRAME_SIZE, pack(s.width, s.height)).context(what)?;
        t.SetUINT64(&MF_MT_FRAME_RATE, pack(s.fps, 1)).context(what)?;
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)).context(what)?;
        if !colour_tags {
            return Ok(t);
        }
        // Matches the video processor's output colour space; players decode HD as BT.709 too.
        t.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32).context(what)?;
        t.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32).context(what)?;
        t.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32).context(what)?;
        t.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32).context(what)?;
        Ok(t)
    }
}

unsafe fn encoding_parameters(s: &EncoderSettings, tuning: Tuning) -> Result<Option<IMFAttributes>> {
    if matches!(tuning, Tuning::Defaults | Tuning::Bare) {
        return Ok(None);
    }
    unsafe {
        let p = new_attributes(4)?;
        let what = "Configuring the encoder";
        // One keyframe per second and no B-frames: cheap, accurate seeking in the editor.
        p.SetUINT32(&CODECAPI_AVEncMPVGOPSize, s.fps).context(what)?;
        p.SetUINT32(&CODECAPI_AVEncMPVDefaultBPictureCount, 0).context(what)?;
        if matches!(tuning, Tuning::Full) {
            // Static screens cost almost nothing; scrolling and video get the bits.
            p.SetUINT32(&CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_UnconstrainedVBR.0 as u32)
                .context(what)?;
            p.SetUINT32(&CODECAPI_AVEncCommonMeanBitRate, s.bitrate).context(what)?;
        }
        Ok(Some(p))
    }
}

/// Name of the encoder the sink writer picked and whether it is a hardware MFT.
unsafe fn describe_encoder(writer: &IMFSinkWriter, stream: u32, requested_hardware: bool) -> (String, bool) {
    let fallback = || {
        let kind =
            if requested_hardware { "Media Foundation H.264 encoder" } else { "Microsoft H.264 software encoder" };
        (kind.to_string(), false)
    };
    let Ok(ex) = writer.cast::<IMFSinkWriterEx>() else {
        return fallback();
    };
    for index in 0..8 {
        let mut category = GUID::zeroed();
        let mut transform: Option<IMFTransform> = None;
        if unsafe { ex.GetTransformForStream(stream, index, Some(&mut category), &mut transform) }.is_err() {
            break;
        }
        if category != MFT_CATEGORY_VIDEO_ENCODER {
            continue;
        }
        let Some(transform) = transform else { continue };
        let Ok(attrs) = (unsafe { transform.GetAttributes() }) else {
            return fallback();
        };
        let hardware = unsafe { attrs.GetStringLength(&MFT_ENUM_HARDWARE_URL_Attribute) }.is_ok()
            || unsafe { attrs.GetUINT32(&MF_TRANSFORM_ASYNC) }.unwrap_or(0) != 0;
        let name = unsafe { allocated_string(&attrs, &MFT_FRIENDLY_NAME_Attribute) }.unwrap_or_else(|| {
            if hardware { "Hardware H.264 encoder" } else { "Microsoft H.264 software encoder" }.to_string()
        });
        return (name, hardware);
    }
    fallback()
}

unsafe fn allocated_string(attrs: &IMFAttributes, key: &GUID) -> Option<String> {
    unsafe {
        let mut value = PWSTR::null();
        let mut len = 0u32;
        attrs.GetAllocatedString(key, &mut value, &mut len).ok()?;
        let s = value.to_string().ok();
        CoTaskMemFree(Some(value.0 as *const _));
        s.filter(|s| !s.is_empty())
    }
}
