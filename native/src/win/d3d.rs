//! Direct3D 11 device shared by capture, colour conversion and the encoder.

use std::ffi::c_void;

use windows::core::{s, w, IInspectable, Interface, HRESULT};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_10_0,
    D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter, IDXGIAdapter1, IDXGIDevice, IDXGIFactory1};
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};

use super::{Context, Failure, Result};

pub struct Device {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
}

/// The GPU that drives `monitor`. Capturing and encoding there avoids copying every
/// frame between GPUs on hybrid laptops and multi-GPU desktops, and makes the encoder
/// that Media Foundation picks for the device belong to the same GPU.
fn adapter_for(monitor: HMONITOR) -> Option<IDXGIAdapter1> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
    for i in 0.. {
        let adapter = unsafe { factory.EnumAdapters1(i) }.ok()?;
        for j in 0.. {
            let Ok(output) = (unsafe { adapter.EnumOutputs(j) }) else { break };
            if unsafe { output.GetDesc() }.is_ok_and(|desc| desc.Monitor == monitor) {
                return Some(adapter);
            }
        }
    }
    None
}

/// Creates the device on the GPU driving `monitor` when known, else on the default GPU.
pub fn create_device(monitor: Option<HMONITOR>) -> Result<Device> {
    if let Some(adapter) = monitor.and_then(adapter_for) {
        if let Ok(device) = create_on(Some(&adapter.cast().context("Querying IDXGIAdapter")?)) {
            return Ok(device);
        }
    }
    create_on(None)
}

fn create_on(adapter: Option<&IDXGIAdapter>) -> Result<Device> {
    let levels: [D3D_FEATURE_LEVEL; 4] =
        [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0];
    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            adapter,
            // An explicit adapter requires the "unknown" driver type.
            if adapter.is_some() { D3D_DRIVER_TYPE_UNKNOWN } else { D3D_DRIVER_TYPE_HARDWARE },
            HMODULE::default(),
            // Video support is needed by the colour-conversion video processor and the encoder.
            D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .context("Creating the Direct3D 11 device")?;
    let device = device.ok_or_else(|| Failure::runtime("Direct3D 11 returned no device"))?;
    let context = context.ok_or_else(|| Failure::runtime("Direct3D 11 returned no device context"))?;

    // Media Foundation and the capture worker use the device from their own threads.
    let mt: ID3D11Multithread = context.cast().context("Querying ID3D11Multithread")?;
    unsafe {
        let _ = mt.SetMultithreadProtected(true);
    }
    Ok(Device { device, context })
}

type CreateDirect3D11DeviceFromDXGIDeviceFn = unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> HRESULT;

/// WinRT wrapper of the device for Windows.Graphics.Capture. Resolved at run time
/// so the helper still starts (and can report "unsupported") where the export is missing.
pub fn winrt_device(device: &ID3D11Device) -> Result<IDirect3DDevice> {
    let dxgi: IDXGIDevice = device.cast().context("Querying IDXGIDevice")?;
    unsafe {
        let module =
            LoadLibraryExW(w!("d3d11.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).context("Loading d3d11.dll")?;
        let proc = GetProcAddress(module, s!("CreateDirect3D11DeviceFromDXGIDevice")).ok_or_else(|| {
            Failure::new(crate::exit::UNSUPPORTED, "CreateDirect3D11DeviceFromDXGIDevice is not available")
        })?;
        let create: CreateDirect3D11DeviceFromDXGIDeviceFn = std::mem::transmute(proc);
        let mut raw = std::ptr::null_mut();
        create(dxgi.as_raw(), &mut raw).ok().context("Creating the WinRT Direct3D device")?;
        if raw.is_null() {
            return Err(Failure::runtime("CreateDirect3D11DeviceFromDXGIDevice returned nothing"));
        }
        let inspectable = IInspectable::from_raw(raw);
        inspectable.cast().context("Querying IDirect3DDevice")
    }
}

pub fn texture_desc(texture: &ID3D11Texture2D) -> D3D11_TEXTURE2D_DESC {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut desc) };
    desc
}

/// A GPU-only texture usable as a copy destination and video processor input.
pub fn create_texture(device: &ID3D11Device, width: u32, height: u32, format: DXGI_FORMAT) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut texture = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }.context("Creating a frame texture")?;
    texture.ok_or_else(|| Failure::runtime("CreateTexture2D returned no texture"))
}
