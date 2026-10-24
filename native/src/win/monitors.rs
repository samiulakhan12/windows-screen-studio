//! Monitor enumeration (physical pixel rectangles; the process is per-monitor DPI aware).

use std::collections::HashMap;
use std::mem::size_of;

use windows::core::BOOL;
use windows::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
    DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SOURCE_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
};
use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayDevicesW, EnumDisplayMonitors, GetMonitorInfoW, DISPLAY_DEVICEW, HDC, HMONITOR, MONITORINFO,
    MONITORINFOEXW,
};
use windows::Win32::UI::WindowsAndMessaging::MONITORINFOF_PRIMARY;

use super::{Failure, Result};
use crate::cli::MonitorSelector;
use crate::exit;
use crate::protocol::JsonObject;

#[derive(Debug, Clone)]
pub struct MonitorInfo {
    pub handle: HMONITOR,
    pub index: usize,
    /// GDI device name, e.g. `\\.\DISPLAY1`.
    pub device: String,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub primary: bool,
}

impl MonitorInfo {
    pub fn to_json(&self) -> String {
        JsonObject::new()
            .int("index", self.index as i64)
            .str("device", &self.device)
            .str("name", &self.name)
            .int("x", self.x as i64)
            .int("y", self.y as i64)
            .int("width", self.width as i64)
            .int("height", self.height as i64)
            .bool("primary", self.primary)
            .finish()
    }
}

fn wide_to_string(w: &[u16]) -> String {
    let end = w.iter().position(|&c| c == 0).unwrap_or(w.len());
    String::from_utf16_lossy(&w[..end])
}

unsafe extern "system" fn collect(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
    let list = unsafe { &mut *(data.0 as *mut Vec<HMONITOR>) };
    list.push(monitor);
    BOOL(1)
}

pub fn enumerate() -> Result<Vec<MonitorInfo>> {
    let mut handles: Vec<HMONITOR> = Vec::new();
    let ok = unsafe { EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut handles as *mut _ as isize)) };
    if !ok.as_bool() {
        return Err(Failure::runtime("EnumDisplayMonitors failed"));
    }
    let names = friendly_names();
    let mut monitors = Vec::with_capacity(handles.len());
    for handle in handles {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        if !unsafe { GetMonitorInfoW(handle, &mut info.monitorInfo as *mut MONITORINFO) }.as_bool() {
            continue;
        }
        let device = wide_to_string(&info.szDevice);
        let r = info.monitorInfo.rcMonitor;
        let name =
            names.get(&device).cloned().filter(|n| !n.is_empty()).or_else(|| adapter_monitor_name(&info.szDevice));
        monitors.push(MonitorInfo {
            handle,
            index: monitors.len(),
            name: name.unwrap_or_else(|| device.clone()),
            device,
            x: r.left,
            y: r.top,
            width: r.right - r.left,
            height: r.bottom - r.top,
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
        });
    }
    Ok(monitors)
}

pub fn select(selector: &MonitorSelector) -> Result<MonitorInfo> {
    let monitors = enumerate()?;
    let found = match selector {
        MonitorSelector::Index(i) => monitors.get(*i).cloned(),
        MonitorSelector::Device(name) => monitors.iter().find(|m| m.device.eq_ignore_ascii_case(name)).cloned(),
    };
    found.ok_or_else(|| {
        let available: Vec<String> = monitors.iter().map(|m| format!("{} {}", m.index, m.device)).collect();
        Failure::new(exit::NOT_FOUND, format!("Monitor {selector:?} not found (available: {})", available.join(", ")))
    })
}

/// EDID friendly names ("DELL U2720Q") keyed by GDI device name, via the DisplayConfig API.
fn friendly_names() -> HashMap<String, String> {
    let mut names = HashMap::new();
    let mut paths: Vec<DISPLAYCONFIG_PATH_INFO> = Vec::new();
    let mut modes: Vec<DISPLAYCONFIG_MODE_INFO> = Vec::new();
    for _ in 0..3 {
        let (mut np, mut nm) = (0u32, 0u32);
        if unsafe { GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut np, &mut nm) } != ERROR_SUCCESS {
            return names;
        }
        paths.resize(np as usize, DISPLAYCONFIG_PATH_INFO::default());
        modes.resize(nm as usize, DISPLAYCONFIG_MODE_INFO::default());
        let rc = unsafe {
            QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &mut np, paths.as_mut_ptr(), &mut nm, modes.as_mut_ptr(), None)
        };
        if rc == ERROR_INSUFFICIENT_BUFFER {
            continue; // The topology changed between the two calls.
        }
        if rc != ERROR_SUCCESS {
            return names;
        }
        paths.truncate(np as usize);
        break;
    }
    for path in &paths {
        let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
            header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                size: size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                adapterId: path.sourceInfo.adapterId,
                id: path.sourceInfo.id,
            },
            ..Default::default()
        };
        if unsafe { DisplayConfigGetDeviceInfo(&mut source.header) } != 0 {
            continue;
        }
        let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME {
            header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
                size: size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32,
                adapterId: path.targetInfo.adapterId,
                id: path.targetInfo.id,
            },
            ..Default::default()
        };
        if unsafe { DisplayConfigGetDeviceInfo(&mut target.header) } != 0 {
            continue;
        }
        names
            .entry(wide_to_string(&source.viewGdiDeviceName))
            .or_insert_with(|| wide_to_string(&target.monitorFriendlyDeviceName));
    }
    names
}

/// Fallback: the monitor's PnP description ("Generic PnP Monitor").
fn adapter_monitor_name(device: &[u16; 32]) -> Option<String> {
    let mut dd = DISPLAY_DEVICEW { cb: size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
    let ok = unsafe { EnumDisplayDevicesW(windows::core::PCWSTR(device.as_ptr()), 0, &mut dd, 0) };
    if ok.as_bool() {
        Some(wide_to_string(&dd.DeviceString)).filter(|s| !s.is_empty())
    } else {
        None
    }
}
