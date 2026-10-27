//! Process hardening and the processor (§2.4, §5.3): below-normal priority, a parent watch,
//! Windows process mitigations (extension points disabled; image loads: no remote images, no
//! low-label images, System32 first), `PR_SET_NO_NEW_PRIVS` and `PR_SET_PDEATHSIG` on Linux,
//! the CPU probe, the standard build's CPUID check and the peak memory.
//!
//! The helper writes no files and opens no sockets.

/// Which build this is: "standard" (AVX2 and friends forced on in ggml), "compatible" (every
/// extension off) or "host" (a native development build). Set by build.rs.
pub const BUILD: &str = env!("SSW_SPEECH_BUILD");

/// What the processor offers. Rust's feature detection only runs CPUID and XGETBV, never SIMD
/// code, so this is safe on any x64 processor (the compatible build runs it).
pub struct Cpu {
    pub sse42: bool,
    pub avx: bool,
    pub avx2: bool,
    pub fma: bool,
    pub f16c: bool,
    pub bmi2: bool,
    pub logical: usize,
}

#[cfg(target_arch = "x86_64")]
pub fn cpu() -> Cpu {
    Cpu {
        sse42: std::arch::is_x86_feature_detected!("sse4.2"),
        avx: std::arch::is_x86_feature_detected!("avx"),
        avx2: std::arch::is_x86_feature_detected!("avx2"),
        fma: std::arch::is_x86_feature_detected!("fma"),
        f16c: std::arch::is_x86_feature_detected!("f16c"),
        bmi2: std::arch::is_x86_feature_detected!("bmi2"),
        logical: logical(),
    }
}

#[cfg(not(target_arch = "x86_64"))]
pub fn cpu() -> Cpu {
    Cpu { sse42: false, avx: false, avx2: false, fma: false, f16c: false, bmi2: false, logical: logical() }
}

fn logical() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
}

pub fn cpu_line(c: &Cpu) -> String {
    format!(
        "{{\"type\":\"cpu\",\"sse42\":{},\"avx\":{},\"avx2\":{},\"fma\":{},\"f16c\":{},\"bmi2\":{},\"logical\":{}}}",
        c.sse42, c.avx, c.avx2, c.fma, c.f16c, c.bmi2, c.logical
    )
}

/// What the standard build needs and this processor lacks (empty: it may run).
pub fn missing_for_standard(c: &Cpu) -> Vec<&'static str> {
    [("SSE4.2", c.sse42), ("AVX", c.avx), ("AVX2", c.avx2), ("FMA", c.fma), ("F16C", c.f16c), ("BMI2", c.bmi2)]
        .into_iter()
        .filter(|(_, ok)| !ok)
        .map(|(n, _)| n)
        .collect()
}

// ------------------------------------------------------------------------------- Linux

#[cfg(target_os = "linux")]
mod os {
    use std::ffi::c_int;
    extern "C" {
        fn setpriority(which: c_int, who: u32, prio: c_int) -> c_int;
        fn prctl(option: c_int, arg2: u64, arg3: u64, arg4: u64, arg5: u64) -> c_int;
        fn getppid() -> c_int;
        fn getrusage(who: c_int, usage: *mut [i64; 18]) -> c_int;
        fn kill(pid: c_int, sig: c_int) -> c_int;
    }
    const PR_SET_PDEATHSIG: c_int = 1;
    const PR_SET_NO_NEW_PRIVS: c_int = 38;
    const SIGKILL: u64 = 9;
    const EPERM: i32 = 1;

    pub fn lower_priority() {
        // Before any other thread exists: on Linux the nice value is per thread, and the
        // engine's threads inherit it from this one.
        unsafe {
            setpriority(0 /* PRIO_PROCESS */, 0, 10)
        };
    }

    pub fn harden() {
        unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    }

    pub fn watch_parent(pid: u32) {
        unsafe { prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) };
        // The parent may have died before the call above (this process then has another one),
        // or `pid` was never the parent: a process that lives on is a wrong argument, since its
        // death would go unnoticed.
        if unsafe { getppid() } as u32 != pid {
            if exists(pid) {
                crate::protocol::fail(crate::protocol::Failure::new(
                    crate::protocol::Code::Args,
                    format!("--parent-pid {pid} is not this helper's parent"),
                ));
            }
            super::parent_gone();
        }
    }

    /// Whether process `pid` exists: signal 0 sends nothing, EPERM is another user's process.
    fn exists(pid: u32) -> bool {
        let Ok(p) = c_int::try_from(pid) else { return false };
        let rc = unsafe { kill(p, 0) };
        rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(EPERM)
    }

    pub fn peak_rss_bytes() -> u64 {
        let mut ru = [0i64; 18];
        if unsafe {
            getrusage(0 /* RUSAGE_SELF */, &mut ru)
        } != 0
        {
            return 0;
        }
        // struct rusage: two struct timevals (4 longs), then ru_maxrss in KiB.
        ru[4].max(0) as u64 * 1024
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
mod os {
    pub fn lower_priority() {}
    pub fn harden() {}
    pub fn watch_parent(_pid: u32) {}
    pub fn peak_rss_bytes() -> u64 {
        0
    }
}

// ------------------------------------------------------------------------------- Windows

#[cfg(windows)]
mod os {
    use std::ffi::c_void;

    type Handle = *mut c_void;
    extern "system" {
        fn GetCurrentProcess() -> Handle;
        fn SetPriorityClass(h: Handle, class: u32) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn WaitForSingleObject(h: Handle, ms: u32) -> u32;
        fn GetLastError() -> u32;
        fn GetModuleHandleW(name: *const u16) -> Handle;
        fn GetProcAddress(module: Handle, name: *const u8) -> *mut c_void;
    }
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const INFINITE: u32 = 0xFFFF_FFFF;
    const ERROR_INVALID_PARAMETER: u32 = 87;

    fn kernel32(name: &[u8]) -> *mut c_void {
        let k: Vec<u16> = "kernel32.dll\0".encode_utf16().collect();
        unsafe {
            let m = GetModuleHandleW(k.as_ptr());
            if m.is_null() {
                return std::ptr::null_mut();
            }
            GetProcAddress(m, name.as_ptr())
        }
    }

    pub fn lower_priority() {
        unsafe { SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS) };
    }

    /// Extension points (AppInit DLLs, legacy IMEs, winsock LSPs) disabled; image loads: no
    /// remote images, no low-mandatory-label images, System32 first. Looked up at run time
    /// (Windows 8 and later); a failure is logged and ignored (wine ignores them).
    pub fn harden() {
        type SetPolicy = unsafe extern "system" fn(policy: i32, buf: *const c_void, len: usize) -> i32;
        let f = kernel32(b"SetProcessMitigationPolicy\0");
        if f.is_null() {
            super::log("process mitigations: SetProcessMitigationPolicy is not available");
            return;
        }
        let set: SetPolicy = unsafe { std::mem::transmute(f) };
        const PROCESS_EXTENSION_POINT_DISABLE_POLICY: i32 = 6;
        const PROCESS_IMAGE_LOAD_POLICY: i32 = 10;
        let extension_points: u32 = 0x1; // DisableExtensionPoints
        let image_load: u32 = 0x1 | 0x2 | 0x4; // NoRemoteImages, NoLowMandatoryLabelImages, PreferSystem32Images
        for (name, policy, flags) in [
            ("extension points", PROCESS_EXTENSION_POINT_DISABLE_POLICY, extension_points),
            ("image loads", PROCESS_IMAGE_LOAD_POLICY, image_load),
        ] {
            if unsafe { set(policy, &flags as *const u32 as *const c_void, 4) } == 0 {
                super::log(&format!("process mitigations: {name} not applied (error {})", unsafe { GetLastError() }));
            }
        }
    }

    /// Exits when the app's process ends (a wait on its handle).
    pub fn watch_parent(pid: u32) {
        let h = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
        if h.is_null() {
            let err = unsafe { GetLastError() };
            if err == ERROR_INVALID_PARAMETER {
                // No such process: the parent is already gone.
                super::parent_gone();
            }
            super::log(&format!("parent watch: cannot open process {pid} (error {err})"));
            return;
        }
        let h = h as usize;
        std::thread::spawn(move || {
            unsafe { WaitForSingleObject(h as Handle, INFINITE) };
            super::parent_gone();
        });
    }

    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    /// K32GetProcessMemoryInfo from kernel32 (never psapi.dll), looked up at run time.
    pub fn peak_rss_bytes() -> u64 {
        type GetInfo = unsafe extern "system" fn(h: Handle, c: *mut ProcessMemoryCounters, cb: u32) -> i32;
        let f = kernel32(b"K32GetProcessMemoryInfo\0");
        if f.is_null() {
            return 0;
        }
        let get: GetInfo = unsafe { std::mem::transmute(f) };
        let mut c: ProcessMemoryCounters = unsafe { std::mem::zeroed() };
        c.cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
        if unsafe { get(GetCurrentProcess(), &mut c, c.cb) } == 0 {
            return 0;
        }
        c.peak_working_set_size as u64
    }
}

static VERBOSE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_verbose(on: bool) {
    VERBOSE.store(on, std::sync::atomic::Ordering::Relaxed);
}

pub fn verbose() -> bool {
    VERBOSE.load(std::sync::atomic::Ordering::Relaxed)
}

/// The parent is gone: the run is cancelled as when the app ends stdin (a `cancelled` line, exit
/// code 2), never a silent exit, which the app would count as a crash. After the run's last line
/// it does nothing: that run is ending with its own exit code.
#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
fn parent_gone() {
    crate::protocol::cancel_now()
}

/// A diagnostic for the app's log (stderr; never part of the protocol).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn log(msg: &str) {
    eprintln!("ssw-speech: {msg}");
}

pub fn lower_priority() {
    os::lower_priority()
}

pub fn harden() {
    os::harden()
}

pub fn watch_parent(pid: u32) {
    os::watch_parent(pid)
}

pub fn peak_rss_mb() -> f64 {
    os::peak_rss_bytes() as f64 / (1024.0 * 1024.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testjson::parse;

    #[test]
    fn the_cpu_line_has_booleans_and_a_count() {
        let c = cpu();
        let v = parse(&cpu_line(&c)).unwrap();
        assert_eq!(v.keys(), vec!["avx", "avx2", "bmi2", "f16c", "fma", "logical", "sse42", "type"]);
        assert!(v.get("logical").unwrap().f() >= 1.0);
    }

    #[test]
    fn the_standard_build_needs_all_six() {
        let mut c = Cpu { sse42: true, avx: true, avx2: true, fma: true, f16c: true, bmi2: true, logical: 4 };
        assert!(missing_for_standard(&c).is_empty());
        c.bmi2 = false; // some virtual machines offer AVX2 without BMI2
        assert_eq!(missing_for_standard(&c), vec!["BMI2"]);
    }

    #[test]
    fn peak_memory_is_reported() {
        assert!(peak_rss_mb() > 1.0);
    }
}
