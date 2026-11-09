//! Process hardening (docs/design/smart-tools.md §9.1, as the speech helper's guard.rs):
//! below-normal priority, a watch on the app's process, Windows process mitigations, and
//! `PR_SET_NO_NEW_PRIVS` and `PR_SET_PDEATHSIG` on Linux. The helper writes no files and opens no
//! sockets.

#[cfg(target_os = "linux")]
mod os {
    use std::ffi::c_int;
    extern "C" {
        fn setpriority(which: c_int, who: u32, prio: c_int) -> c_int;
        fn prctl(option: c_int, arg2: u64, arg3: u64, arg4: u64, arg5: u64) -> c_int;
        fn getppid() -> c_int;
        fn kill(pid: c_int, sig: c_int) -> c_int;
    }
    const PR_SET_PDEATHSIG: c_int = 1;
    const PR_SET_NO_NEW_PRIVS: c_int = 38;
    const SIGKILL: u64 = 9;
    const EPERM: i32 = 1;

    pub fn lower_priority() {
        // Before any other thread exists: on Linux the nice value is per thread, and ggml's
        // threads inherit it from this one.
        unsafe { setpriority(0 /* PRIO_PROCESS */, 0, 10) };
    }

    pub fn harden() {
        unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    }

    /// Err when `pid` lives on and is not this helper's parent (its death would go unnoticed).
    pub fn watch_parent(pid: u32) -> Result<(), String> {
        unsafe { prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) };
        if unsafe { getppid() } as u32 != pid {
            if exists(pid) {
                return Err(format!("--parent-pid {pid} is not this helper's parent"));
            }
            super::parent_gone();
        }
        Ok(())
    }

    /// Whether process `pid` exists: signal 0 sends nothing, EPERM is another user's process.
    fn exists(pid: u32) -> bool {
        let Ok(p) = c_int::try_from(pid) else { return false };
        let rc = unsafe { kill(p, 0) };
        rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(EPERM)
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
mod os {
    pub fn lower_priority() {}
    pub fn harden() {}
    pub fn watch_parent(_pid: u32) -> Result<(), String> {
        Ok(())
    }
}

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

    /// Extension points disabled; image loads: no remote images, no low-mandatory-label images,
    /// System32 first. Looked up at run time; a failure is logged and ignored (wine ignores them).
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
        let extension_points: u32 = 0x1;
        let image_load: u32 = 0x1 | 0x2 | 0x4;
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
    pub fn watch_parent(pid: u32) -> Result<(), String> {
        let h = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
        if h.is_null() {
            let err = unsafe { GetLastError() };
            if err == ERROR_INVALID_PARAMETER {
                super::parent_gone();
            }
            super::log(&format!("parent watch: cannot open process {pid} (error {err})"));
            return Ok(());
        }
        let h = h as usize;
        std::thread::spawn(move || {
            unsafe { WaitForSingleObject(h as Handle, INFINITE) };
            super::parent_gone();
        });
        Ok(())
    }
}

/// The app's process is gone: nobody reads the answer, so the helper ends at once.
fn parent_gone() {
    crate::protocol::hard_exit(0)
}

/// A diagnostic for the app's log (stderr; never part of the protocol).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn log(msg: &str) {
    eprintln!("ssw-llm: {msg}");
}

pub fn lower_priority() {
    os::lower_priority()
}

pub fn harden() {
    os::harden()
}

pub fn watch_parent(pid: u32) -> Result<(), String> {
    os::watch_parent(pid)
}
