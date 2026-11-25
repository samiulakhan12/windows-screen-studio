//! The bundled ffmpeg, as the helper runs it (docs/design/auto-blur.md §5.2, §5.5, §5.8, §10.4):
//! one process for each look pass, each group of reads and each piece of a follow session, with
//! `-threads 1` (2 for the look pass), below-normal priority, no window, and on Windows inside a
//! job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the helper's end ends them all. Frames
//! come raw on stdout; `showinfo` lines on stderr give each frame's time and whether it is a key
//! frame. Nothing else of stderr is kept, and none of it is ever passed on: a run that ends early
//! (a broken or cut video, the time limit) is `video`.

use crate::control;
use crate::protocol::Failure;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// One frame as a `showinfo` filter saw it.
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    /// Which showinfo of the graph (its index among the filters).
    pub filter: u32,
    pub n: u64,
    pub t: f64,
    pub key: bool,
    pub w: usize,
    pub h: usize,
}

static CHILDREN: Mutex<Vec<(u64, u32)>> = Mutex::new(Vec::new());
static NEXT: AtomicU64 = AtomicU64::new(1);

/// Kills every ffmpeg still running (the helper is ending).
pub fn kill_all() {
    let list = CHILDREN.lock().map(|c| c.clone()).unwrap_or_default();
    for (_, pid) in list {
        kill_pid(pid);
    }
}

#[cfg(unix)]
fn kill_pid(pid: u32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    if let Ok(p) = i32::try_from(pid) {
        unsafe { kill(p, 9) };
    }
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !h.is_null() {
            TerminateProcess(h, 1);
            CloseHandle(h);
        }
    }
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};

    /// The helper's job object, kept open for the life of the process: when the helper ends, for
    /// any reason, Windows closes it and kills every ffmpeg in it.
    static JOB: OnceLock<usize> = OnceLock::new();

    fn job() -> usize {
        *JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return 0;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
            h as usize
        })
    }

    pub fn assign(child: &std::process::Child) {
        let j = job();
        if j != 0 {
            unsafe { AssignProcessToJobObject(j as _, child.as_raw_handle() as _) };
        }
    }
}

/// A running ffmpeg: its frames on stdout, its showinfo lines on a channel.
pub struct Run {
    key: u64,
    child: Child,
    stdout: ChildStdout,
    infos: Receiver<Info>,
    done: Arc<AtomicBool>,
}

/// The value of ` key:` in a showinfo line (spaces after the colon skipped).
fn field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let pat = format!(" {key}:");
    let at = line.find(&pat)? + pat.len();
    let rest = line[at..].trim_start();
    Some(rest.split_whitespace().next().unwrap_or(""))
}

/// The showinfo filter a line is from, when it is one.
fn filter_of(line: &str) -> Option<u32> {
    let at = line.find("Parsed_showinfo_")? + "Parsed_showinfo_".len();
    line[at..].split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

/// A showinfo `config in time_base: N/D` line: its filter and time base.
pub fn parse_time_base(line: &str) -> Option<(u32, f64)> {
    let filter = filter_of(line)?;
    let at = line.find("config in time_base:")? + "config in time_base:".len();
    let (n, d) = line[at..].trim_start().split(|c: char| c == ',' || c.is_whitespace()).next()?.split_once('/')?;
    let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
    (n > 0.0 && d > 0.0).then_some((filter, n / d))
}

/// One showinfo frame line; None for any other line. The time is the frame's pts times its
/// filter's time base when that is known (`pts_time` has only six significant digits, which is a
/// hundredth of a second past 1,000 s), else `pts_time`.
pub fn parse_info(line: &str, time_base: Option<f64>) -> Option<Info> {
    let filter = filter_of(line)?;
    let body = &line[line.find(']')?..];
    let n = field(body, "n")?.parse().ok()?;
    let pts: Option<i64> = field(body, "pts").and_then(|v| v.parse().ok());
    let t = match (pts, time_base) {
        (Some(p), Some(tb)) => p as f64 * tb,
        _ => field(body, "pts_time")?.parse().ok()?,
    };
    let key = field(body, "iskey")? == "1";
    let (w, h) = field(body, "s")?.split_once('x')?;
    Some(Info { filter, n, t, key, w: w.parse().ok()?, h: h.parse().ok()? })
}

impl Run {
    /// Starts ffmpeg with `args` (after `-hide_banner -nostdin -loglevel info`); `limit` ends it.
    pub fn spawn(ffmpeg: &str, args: &[String], threads: u32, limit: Duration) -> Result<Run, Failure> {
        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-hide_banner", "-nostdin", "-loglevel", "info", "-threads", &threads.to_string(), "-filter_threads", "1"]);
        cmd.args(args);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
            cmd.creation_flags(0x0800_0000 | 0x0000_4000);
        }
        let mut child = cmd.spawn().map_err(|_| Failure::Video)?;
        #[cfg(windows)]
        job::assign(&child);
        let key = NEXT.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut c) = CHILDREN.lock() {
            c.push((key, child.id()));
        }
        let stdout = child.stdout.take().ok_or(Failure::Video)?;
        let stderr = child.stderr.take().ok_or(Failure::Video)?;
        let (tx, infos) = channel();
        std::thread::spawn(move || {
            let mut r = BufReader::new(stderr);
            let mut buf = Vec::new();
            let mut bases: std::collections::HashMap<u32, f64> = Default::default();
            loop {
                buf.clear();
                match r.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                // Lines can be long; only showinfo and the error kinds are looked at.
                let line = String::from_utf8_lossy(&buf);
                if let Some((f, tb)) = parse_time_base(&line) {
                    bases.insert(f, tb);
                    continue;
                }
                let tb = filter_of(&line).and_then(|f| bases.get(&f).copied());
                if let Some(info) = parse_info(&line, tb) {
                    if tx.send(info).is_err() {
                        break;
                    }
                }
            }
        });
        let done = Arc::new(AtomicBool::new(false));
        let (d2, pid) = (done.clone(), child.id());
        std::thread::spawn(move || {
            // Only time the helper is not paused counts: while Flown records, the helper reads none of
            // ffmpeg's output and ffmpeg waits on its full pipe by design, and the run goes on when it
            // resumes (§5.11). Each tick's time goes to the state the tick ends in.
            let mut used = Duration::ZERO;
            let mut last = Instant::now();
            while !d2.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(200));
                let now = Instant::now();
                if !control::is_paused() {
                    used += now - last;
                }
                last = now;
                if used > limit && !d2.load(Ordering::SeqCst) {
                    kill_pid(pid);
                    break;
                }
            }
        });
        Ok(Run { key, child, stdout, infos, done })
    }

    /// The next showinfo line, waiting at most `wait`; None when ffmpeg ended or took too long.
    pub fn next_info(&self, wait: Duration) -> Option<Info> {
        match self.infos.recv_timeout(wait) {
            Ok(i) => Some(i),
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => None,
        }
    }

    /// Reads one raw frame into `buf` (blocking while paused, so ffmpeg's pipe fills and it waits).
    pub fn read_frame(&mut self, buf: &mut [u8]) -> Result<(), Failure> {
        control::wait_if_paused();
        self.stdout.read_exact(buf).map_err(|_| self.failure())
    }

    /// Why the run ended early: a broken or cut video, or the time limit.
    pub fn failure(&self) -> Failure {
        Failure::Video
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        self.done.store(true, Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Ok(mut c) = CHILDREN.lock() {
            c.retain(|(k, _)| *k != self.key);
        }
    }
}

/// A time for ffmpeg's command line (it reads plain decimals).
pub fn secs(t: f64) -> String {
    format!("{:.6}", t.max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_showinfo_line() {
        let line = "[Parsed_showinfo_0 @ 0x5581c0a2b4c0] n:  12 pts:  12288 pts_time:0.2     duration:   1024 duration_time:0.0166667 fmt:yuv420p cl:left sar:1/1 s:1920x1080 i:P iskey:0 type:P";
        assert_eq!(parse_info(line, None), Some(Info { filter: 0, n: 12, t: 0.2, key: false, w: 1920, h: 1080 }));
        let key = "[Parsed_showinfo_2 @ 0x1] n:   0 pts:      0 pts_time:0       duration:   512 duration_time:0.0166667 fmt:gray cl:unspecified sar:1/1 s:480x270 i:P iskey:1 type:I";
        assert_eq!(parse_info(key, None).map(|i| (i.filter, i.key, i.w)), Some((2, true, 480)));
        assert_eq!(parse_info("[Parsed_showinfo_0 @ 0x1]   color_range:tv color_space:bt709", None), None);
        assert_eq!(parse_info("frame=  10 fps=0.0 q=-0.0 size=N/A", None), None);
    }

    #[test]
    fn times_come_from_the_pts_and_the_time_base() {
        assert_eq!(parse_time_base("[Parsed_showinfo_0 @ 0x56] config in time_base: 1/15360, frame_rate: 30/1"), Some((0, 1.0 / 15360.0)));
        assert_eq!(parse_time_base("[Parsed_showinfo_0 @ 0x56] config out time_base: 0/0, frame_rate: 0/0"), None);
        // 1140.333… s: pts_time reads 1140.33, a frame earlier than the frame's own time.
        let line = "[Parsed_showinfo_0 @ 0x1] n: 5 pts: 17515520 pts_time:1140.33 duration: 512 duration_time:0.0333333 fmt:yuv420p cl:left sar:1/1 s:320x180 i:P iskey:0 type:P";
        let t = parse_info(line, Some(1.0 / 15360.0)).unwrap().t;
        assert!((t - 1140.0 - 1.0 / 3.0).abs() < 1e-9, "{t}");
    }

    /// A folder of a test's own, removed when the test ends, also when it fails.
    #[cfg(unix)]
    struct Scratch(std::path::PathBuf);

    #[cfg(unix)]
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A stand-in for ffmpeg that writes `aaaa` at once, `bbbb` 0.8 s later, then nothing for 30 s.
    #[cfg(unix)]
    fn slow_ffmpeg() -> (Scratch, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = Scratch(std::env::temp_dir().join(format!("ssw-ocr-limit-{}", std::process::id())));
        std::fs::create_dir_all(&dir.0).unwrap();
        let script = dir.0.join("slow-ffmpeg");
        // The last sleep is the process itself (exec), so ending it closes the pipe as ending ffmpeg does.
        std::fs::write(&script, "#!/bin/sh\nprintf aaaa\nsleep 0.8\nprintf bbbb\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, script)
    }

    /// While Flown records the helper is paused (§5.11): it reads none of ffmpeg's output, so ffmpeg
    /// waits on its full pipe by design, and Find goes on when it resumes. Time paused does not count
    /// against the run's limit (found by review: a read, a follow piece or the look pass paused past its
    /// limit was killed, and answered `video` once resumed); time running still does.
    #[cfg(unix)]
    #[test]
    fn time_paused_does_not_count_against_the_limit() {
        let (_scratch, script) = slow_ffmpeg();
        let mut run = Run::spawn(script.to_str().unwrap(), &[], 1, Duration::from_millis(500)).unwrap();
        let mut frame = [0u8; 4];
        run.read_frame(&mut frame).unwrap();
        assert_eq!(&frame, b"aaaa");
        // Paused for 2 s, four times the limit; the second frame comes meanwhile.
        control::pause(true);
        let resume = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(2000));
            control::pause(false);
        });
        assert!(run.read_frame(&mut frame).is_ok(), "a run paused past its limit was ended");
        assert_eq!(&frame, b"bbbb");
        resume.join().unwrap();
        // Running again, its limit still holds: nothing more comes, and the run is ended within it.
        let t0 = Instant::now();
        assert!(run.read_frame(&mut frame).is_err());
        assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
    }
}
