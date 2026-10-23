//! Feature detection for `probe` and `record`.

use windows::core::{HSTRING, PWSTR};
use windows::Foundation::Metadata::ApiInformation;
use windows::Graphics::Capture::GraphicsCaptureSession;
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, MFMediaType_Video, MFShutdown, MFStartup, MFTEnumEx, MFT_FRIENDLY_NAME_Attribute, MFVideoFormat_H264,
    MFSTARTUP_LITE, MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG, MFT_ENUM_FLAG_ASYNCMFT, MFT_ENUM_FLAG_HARDWARE,
    MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_SYNCMFT, MFT_REGISTER_TYPE_INFO, MF_VERSION,
};
use windows::Win32::System::Com::CoTaskMemFree;

use crate::protocol::{json_array, push_json_string, JsonObject};

const SESSION_CLASS: &str = "Windows.Graphics.Capture.GraphicsCaptureSession";

#[derive(Debug, Default)]
pub struct Report {
    pub supported: bool,
    pub capture: bool,
    pub cursor_toggle: bool,
    pub border_toggle: bool,
    pub min_update_interval: bool,
    pub hardware_encoders: Vec<String>,
    pub software_encoder: bool,
    pub reason: Option<String>,
}

impl Report {
    pub fn failed(reason: &str) -> Self {
        Self { reason: Some(reason.to_string()), ..Self::default() }
    }

    pub fn to_json(&self) -> String {
        let encoders: Vec<String> = self
            .hardware_encoders
            .iter()
            .map(|n| {
                let mut s = String::new();
                push_json_string(&mut s, n);
                s
            })
            .collect();
        JsonObject::new()
            .bool("supported", self.supported)
            .bool("cursorToggle", self.cursor_toggle)
            .bool("borderToggle", self.border_toggle)
            .bool("capture", self.capture)
            .bool("minUpdateInterval", self.min_update_interval)
            .raw("hardwareEncoders", &json_array(&encoders))
            .bool("softwareEncoder", self.software_encoder)
            .opt_str("reason", self.reason.as_deref())
            .finish()
    }
}

fn property_present(property: &str) -> bool {
    ApiInformation::IsPropertyPresent(&HSTRING::from(SESSION_CLASS), &HSTRING::from(property)).unwrap_or(false)
}

/// Windows.Graphics.Capture exists (Windows 10 1903+) and is usable on this machine.
pub fn capture_supported() -> Result<bool, String> {
    let contract =
        ApiInformation::IsApiContractPresentByMajor(&HSTRING::from("Windows.Foundation.UniversalApiContract"), 8)
            .map_err(|e| super::describe("Checking the Windows API contract", &e))?;
    if !contract {
        return Ok(false);
    }
    GraphicsCaptureSession::IsSupported().map_err(|e| super::describe("Checking Windows.Graphics.Capture", &e))
}

/// IsCursorCaptureEnabled appeared in Windows 10 2004.
pub fn cursor_toggle_supported() -> bool {
    property_present("IsCursorCaptureEnabled")
}

/// IsBorderRequired appeared in Windows 11.
pub fn border_toggle_supported() -> bool {
    property_present("IsBorderRequired")
}

/// MinUpdateInterval only exists on recent Windows 11 builds.
pub fn min_update_interval_supported() -> bool {
    property_present("MinUpdateInterval")
}

pub fn probe() -> Report {
    let mut report = Report::default();
    match capture_supported() {
        Ok(v) => report.capture = v,
        Err(e) => {
            report.reason = Some(e);
            return report;
        }
    }
    if report.capture {
        report.cursor_toggle = cursor_toggle_supported();
        report.border_toggle = border_toggle_supported();
        report.min_update_interval = min_update_interval_supported();
    }
    match unsafe { MFStartup(MF_VERSION, MFSTARTUP_LITE) } {
        Ok(()) => {
            report.hardware_encoders = h264_encoders(MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER);
            report.software_encoder =
                !h264_encoders(MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER).is_empty();
            let _ = unsafe { MFShutdown() };
        }
        Err(e) => report.reason = Some(super::describe("Starting Media Foundation", &e)),
    }
    let has_encoder = !report.hardware_encoders.is_empty() || report.software_encoder;
    report.supported = report.capture && report.cursor_toggle && has_encoder;
    if !report.supported && report.reason.is_none() {
        report.reason = Some(
            if !report.capture {
                "Windows.Graphics.Capture is not available (Windows 10 1903 or later is required)"
            } else if !report.cursor_toggle {
                "Hiding the cursor during capture needs Windows 10 version 2004 or later"
            } else {
                "No H.264 video encoder is installed (Windows N editions need the Media Feature Pack)"
            }
            .to_string(),
        );
    }
    report
}

/// Friendly names of the registered H.264 encoder MFTs matching `flags`. MF must be started.
pub fn h264_encoders(flags: MFT_ENUM_FLAG) -> Vec<String> {
    let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
    let mut array: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    let mut names = Vec::new();
    unsafe {
        if MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags, None, Some(&output), &mut array, &mut count).is_err()
            || array.is_null()
        {
            return names;
        }
        for i in 0..count as usize {
            // Taking each element releases it when it goes out of scope.
            if let Some(activate) = std::ptr::replace(array.add(i), None) {
                names.push(friendly_name(&activate).unwrap_or_else(|| "H.264 encoder".to_string()));
            }
        }
        CoTaskMemFree(Some(array as *const _));
    }
    names
}

fn friendly_name(activate: &IMFActivate) -> Option<String> {
    unsafe {
        let mut value = PWSTR::null();
        let mut len = 0u32;
        activate.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut value, &mut len).ok()?;
        let name = value.to_string().ok();
        CoTaskMemFree(Some(value.0 as *const _));
        name
    }
}
