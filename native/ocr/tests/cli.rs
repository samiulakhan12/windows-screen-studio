//! The helper's tests R1-R26 (docs/design/auto-blur.md §17.1), against the fixture build:
//!
//!   SSW_OCR_MODELS=<folder with the five pinned files> SSW_OCR_PYTHON=<python with numpy,
//!   opencv-python-headless, pyyaml> cargo test --profile test-fast --features fixture
//!
//! They fail (never skip) without the models, ffmpeg (SSW_OCR_FFMPEG or `ffmpeg` on PATH) or, for
//! the scored ones (R4, R17, R18), the Python the scorer needs. R8 and R10 need Windows and run on
//! the reference PC (decision 8); elsewhere they are marked ignored with that reason.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PINS: [(&str, u64, &str); 5] = [
    ("PP-OCRv6_tiny_det_onnx/inference.onnx", 1_780_590, "193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8"),
    ("PP-OCRv6_tiny_rec_onnx/inference.onnx", 4_462_639, "9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6"),
    ("PP-OCRv6_tiny_rec_onnx/inference.yml", 55_571, "66170210bad538e83fff3c4a3867e547d6bf20b50d64b20347c4b913f3034ea1"),
    ("PP-OCRv6_small_rec_onnx/inference.onnx", 21_159_378, "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634"),
    ("PP-OCRv6_small_rec_onnx/inference.yml", 150_579, "ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1"),
];

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn eval_png(name: &str) -> PathBuf {
    repo().join("tests/fixtures/privacy-eval").join(name)
}

fn models() -> PathBuf {
    PathBuf::from(std::env::var("SSW_OCR_MODELS").expect("set SSW_OCR_MODELS to the folder holding the five pinned model files (native/ocr/README.md)"))
}

fn ffmpeg() -> String {
    std::env::var("SSW_OCR_FFMPEG").unwrap_or_else(|_| "ffmpeg".into())
}

fn python() -> String {
    std::env::var("SSW_OCR_PYTHON").expect("set SSW_OCR_PYTHON to a Python with numpy, opencv-python-headless and pyyaml (scripts/privacy/README.md)")
}

/// A private folder for one test.
fn work(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ssw-ocr-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn pins_in(dir: &Path) -> Value {
    Value::Array(PINS.iter().map(|(f, b, s)| json!({ "file": f, "path": dir.join(f).to_string_lossy(), "bytes": b, "sha256": s })).collect())
}

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    events: Receiver<(Instant, Value)>,
    stderr: Arc<Mutex<Vec<u8>>>,
    next: u64,
    alive: Vec<Instant>,
}

impl Helper {
    fn start() -> Helper {
        let mut child = Command::new(env!("CARGO_BIN_EXE_ssw-ocr")).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, events) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let v: Value = serde_json::from_str(&line).expect("every stdout line is JSON");
                if tx.send((Instant::now(), v)).is_err() {
                    break;
                }
            }
        });
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let mut err = child.stderr.take().unwrap();
        let sink = stderr.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = std::io::Read::read(&mut err, &mut buf) {
                if n == 0 {
                    break;
                }
                sink.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        });
        Helper { stdin: child.stdin.take(), child, events, stderr, next: 0, alive: vec![] }
    }

    fn send_raw(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(line.as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
    }

    fn send(&mut self, mut cmd: Value) -> u64 {
        self.next += 1;
        cmd["id"] = json!(self.next);
        self.send_raw(&cmd.to_string());
        self.next
    }

    /// The next event answering `id` (heartbeats are counted on the way).
    fn wait(&mut self, id: u64, within: Duration) -> Value {
        let end = Instant::now() + within;
        loop {
            let left = end.saturating_duration_since(Instant::now());
            let (at, e) = self.events.recv_timeout(left).unwrap_or_else(|_| panic!("no answer to {id} within {within:?}"));
            if e.get("alive").is_some() {
                self.alive.push(at);
                continue;
            }
            if e["id"].as_u64() == Some(id) {
                return e;
            }
        }
    }

    fn open(&mut self, dir: &Path) -> Value {
        let id = self.send(json!({ "op": "open", "protocol": 1, "reader": "paddle", "models": pins_in(dir), "ffmpeg": ffmpeg() }));
        self.wait(id, Duration::from_secs(120))
    }

    fn stats(&mut self) -> Value {
        let id = self.send(json!({ "op": "stats" }));
        self.wait(id, Duration::from_secs(10))["stats"].clone()
    }

    fn read_png(&mut self, png: &Path, areas: Value) -> (u64, Value) {
        let id = self.send(json!({ "op": "readImage", "png": png.to_string_lossy(), "areas": areas }));
        (id, self.wait(id, Duration::from_secs(300)))
    }

    fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr.lock().unwrap()).into_owned()
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn opened() -> Helper {
    let mut h = Helper::start();
    let e = h.open(&models());
    assert!(e.get("opened").is_some(), "{e}");
    h
}

fn texts(read: &Value) -> Vec<String> {
    read["read"]["lines"].as_array().unwrap().iter().map(|l| l["variants"][0]["text"].as_str().unwrap().to_string()).collect()
}

/// A PNG of `w` × `h` RGB pixels.
fn write_png(path: &Path, w: usize, h: usize, rgb: &[u8]) {
    let f = std::fs::File::create(path).unwrap();
    let mut e = png::Encoder::new(std::io::BufWriter::new(f), w as u32, h as u32);
    e.set_color(png::ColorType::Rgb);
    e.set_depth(png::BitDepth::Eight);
    e.write_header().unwrap().write_image_data(rgb).unwrap();
}

/// An evaluation frame's RGB pixels.
fn load_rgb(path: &Path) -> (usize, usize, Vec<u8>) {
    let mut d = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).unwrap()));
    d.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut r = d.read_info().unwrap();
    let mut buf = vec![0u8; r.output_buffer_size().unwrap()];
    let info = r.next_frame(&mut buf).unwrap();
    let (w, h) = (info.width as usize, info.height as usize);
    let ch = buf.len() / (w * h);
    let rgb = buf.chunks(ch).flat_map(|p| [p[0], p[1], p[2]]).collect();
    (w, h, rgb)
}

/// Copies `src` (w × h) into `dst` (dw wide) at (x, y), clipped.
fn blit(dst: &mut [u8], dw: usize, dh: usize, src: &[u8], w: usize, h: usize, x: i64, y: i64) {
    for sy in 0..h {
        let ty = y + sy as i64;
        if ty < 0 || ty >= dh as i64 {
            continue;
        }
        for sx in 0..w {
            let tx = x + sx as i64;
            if tx < 0 || tx >= dw as i64 {
                continue;
            }
            let (s, d) = ((sy * w + sx) * 3, (ty as usize * dw + tx as usize) * 3);
            dst[d..d + 3].copy_from_slice(&src[s..s + 3]);
        }
    }
}

fn run_ffmpeg(args: &[&str]) {
    let out = Command::new(ffmpeg()).args(["-hide_banner", "-loglevel", "error", "-y"]).args(args).output().expect("ffmpeg (SSW_OCR_FFMPEG)");
    assert!(out.status.success(), "ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr));
}

/// A minimal MP4 header declaring a `w` × `h` video track and nothing to decode.
fn header_only_mp4(w: u32, h: u32) -> Vec<u8> {
    fn bx(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut v = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(payload);
        v
    }
    let mut tkhd = vec![0u8; 84];
    tkhd[76..80].copy_from_slice(&(w << 16).to_be_bytes());
    tkhd[80..84].copy_from_slice(&(h << 16).to_be_bytes());
    let mut hdlr = vec![0u8; 24];
    hdlr[8..12].copy_from_slice(b"vide");
    let mdia = bx(b"mdia", &bx(b"hdlr", &hdlr));
    let trak = bx(b"trak", &[bx(b"tkhd", &tkhd), mdia].concat());
    [bx(b"ftyp", b"isom\0\0\0\0isom"), bx(b"moov", &trak)].concat()
}

/// eval_reads.py's numbers for one set and mode.
fn scored(set: &Path, mode: &str, name: &str) -> Value {
    let w = work(name);
    let out = Command::new(python())
        .args(["-I", "-B"])
        .arg(repo().join("native/ocr/tests/eval_reads.py"))
        .args(["--helper", env!("CARGO_BIN_EXE_ssw-ocr"), "--models"])
        .arg(models())
        .arg("--set")
        .arg(set)
        .arg("--work")
        .arg(&w)
        .args(["--areas", mode])
        .output()
        .unwrap();
    assert!(out.status.success(), "eval_reads.py failed: {}", String::from_utf8_lossy(&out.stderr));
    let last = String::from_utf8_lossy(&out.stdout).lines().last().unwrap_or("").to_string();
    let v: Value = serde_json::from_str(&last).unwrap();
    eprintln!("{name}: {v}");
    let _ = std::fs::remove_dir_all(w);
    v
}

#[test]
fn r01_open_answers_opened_with_every_plan_built_once_and_the_heartbeat_running() {
    let mut h = Helper::start();
    let sent = Instant::now();
    let e = h.open(&models());
    let took = sent.elapsed();
    assert_eq!(e["opened"]["protocol"], 1, "{e}");
    assert_eq!(e["opened"]["reader"], "paddle");
    let s = h.stats();
    assert_eq!(s["planBuilds"], 13, "three detector buckets and ten recogniser widths: {s}");
    assert_eq!(s["parses"], 3);
    assert_eq!(s["fileReads"], 5);
    // Reads build no plan.
    h.read_png(&eval_png("01-editor-0-dark-100.png"), json!([]));
    h.read_png(&eval_png("13-inbox-0-light-100.png"), json!([[100, 100, 300, 80]]));
    assert_eq!(h.stats()["planBuilds"], 13);
    // The heartbeat runs from the start and throughout, every 2 s.
    std::thread::sleep(Duration::from_millis(4500));
    h.stats();
    assert!(h.alive.len() >= 3, "{} heartbeats", h.alive.len());
    assert!(h.alive.windows(2).all(|w| w[1] - w[0] < Duration::from_millis(3000)));
    if took > Duration::from_millis(2500) {
        assert!(h.alive.iter().any(|t| *t > sent && *t < sent + took), "a heartbeat while open ran");
    }
}

#[test]
fn r02_one_changed_byte_in_any_model_answers_model_and_parses_nothing() {
    let src = models();
    for (i, (file, _, _)) in PINS.iter().enumerate() {
        let w = work(&format!("r02-{i}"));
        for (f, _, _) in PINS {
            std::fs::create_dir_all(w.join(f).parent().unwrap()).unwrap();
            std::fs::copy(src.join(f), w.join(f)).unwrap();
        }
        let mut bytes = std::fs::read(w.join(file)).unwrap();
        let at = bytes.len() / 2;
        bytes[at] ^= 0x01;
        std::fs::write(w.join(file), bytes).unwrap();
        let mut h = Helper::start();
        let e = h.open(&w);
        assert_eq!(e["error"], "model", "{file}: {e}");
        let s = h.stats();
        assert_eq!(s["parses"], 0, "{file}: nothing parsed");
        assert_eq!(s["fileReads"], 5, "{file}: each file read once, all before any parse");
        let _ = std::fs::remove_dir_all(w);
    }
}

#[test]
fn r03_too_large_before_ffmpeg_starts() {
    let w = work("r03");
    let mut h = Helper::start();
    // An ffmpeg that does not exist: answering tooLarge (not video) shows it was never started.
    let id = h.send(json!({ "op": "open", "protocol": 1, "reader": "paddle", "models": pins_in(&models()), "ffmpeg": "/nonexistent/ffmpeg" }));
    assert!(h.wait(id, Duration::from_secs(120)).get("opened").is_some());
    for (name, (vw, vh)) in [("wide.mp4", (7681, 4320)), ("big.mp4", (6500, 6500))] {
        let p = w.join(name);
        std::fs::write(&p, header_only_mp4(vw, vh)).unwrap();
        let v = p.to_string_lossy().to_string();
        let r = h.send(json!({ "op": "read", "video": v, "key": 0, "t": 0, "areas": [] }));
        assert_eq!(h.wait(r, Duration::from_secs(20))["error"], "tooLarge", "{name}");
        let l = h.send(json!({ "op": "look", "video": v, "k": 16, "step": 1, "from": 0, "to": 1 }));
        assert_eq!(h.wait(l, Duration::from_secs(20))["error"], "tooLarge", "{name}");
        let f = h.send(json!({ "op": "followOpen", "video": v, "key": 0, "from": 0, "to": 1, "dir": -1 }));
        assert_eq!(h.wait(f, Duration::from_secs(20))["error"], "tooLarge", "{name}");
    }
    let ok = w.join("ok.mp4");
    std::fs::write(&ok, header_only_mp4(7680, 4320)).unwrap();
    let r = h.send(json!({ "op": "read", "video": ok.to_string_lossy(), "key": 0, "t": 0, "areas": [] }));
    assert_eq!(h.wait(r, Duration::from_secs(20))["error"], "video", "7680×4320 is allowed: it reaches ffmpeg");
    let _ = std::fs::remove_dir_all(w);
}

#[test]
fn r04_careful_long_on_the_evaluation_set_is_within_one_point_of_onnx_runtime() {
    let v = scored(&repo().join("tests/fixtures/privacy-eval"), "whole", "r04");
    // ONNX Runtime with careful-long: 100.0 and 100.0 (§5.6).
    assert!(v["patternRecall"].as_f64().unwrap() >= 99.0, "{v}");
    assert!(v["padded99"].as_f64().unwrap() >= 99.0, "{v}");
}

#[test]
fn r05_tiles_buckets_and_lines_across_a_seam() {
    let w = work("r05");
    let mut h = opened();
    let (fw, fh, frame) = load_rgb(&eval_png("01-editor-0-dark-100.png"));
    // A 3840×2160 frame is read as 4 tiles.
    let mut big = vec![0u8; 3840 * 2160 * 3];
    blit(&mut big, 3840, 2160, &frame, fw, fh, 1320, 0);
    let p = w.join("4k.png");
    write_png(&p, 3840, 2160, &big);
    let (_, r) = h.read_png(&p, json!([]));
    let runs = h.stats()["lastRuns"].clone();
    assert_eq!(runs.as_array().unwrap().len(), 4, "{runs}");
    assert!(runs.as_array().unwrap().iter().all(|r| r[0] == 2 && r[1] == 1));
    // The DATABASE_URL line (x 351-956 in the frame) now runs from 1671 to 2276, across x = 1920.
    let lines = r["read"]["lines"].as_array().unwrap();
    let across: Vec<&Value> = lines.iter().filter(|l| l["variants"][0]["text"].as_str().unwrap().contains("DATABASE")).collect();
    assert_eq!(across.len(), 1, "{:?}", texts(&r));
    let b = &across[0]["box"];
    assert!(b[0].as_f64().unwrap() < 1900.0 && b[0].as_f64().unwrap() + b[2].as_f64().unwrap() > 1940.0, "{b}");
    assert!(across[0]["variants"][0]["text"].as_str().unwrap().contains("5432"), "{}", across[0]);
    // A 300×80 area runs the 640×352 bucket; three small areas share it.
    h.read_png(&eval_png("01-editor-0-dark-100.png"), json!([[340, 90, 300, 80]]));
    assert_eq!(h.stats()["lastRuns"], json!([[0, 1]]));
    h.read_png(&eval_png("01-editor-0-dark-100.png"), json!([[340, 90, 300, 80], [340, 300, 200, 60], [60, 40, 120, 40]]));
    assert_eq!(h.stats()["lastRuns"], json!([[0, 3]]));
    let _ = std::fs::remove_dir_all(w);
}

#[test]
fn r06_a_4333_pixel_line_is_read_in_chunks_and_matches_its_pieces_read_alone() {
    let w = work("r06");
    let mut h = opened();
    let png = eval_png("07-logs-0-dark-100.png");
    let (fw, fh, frame) = load_rgb(&png);
    let (_, r) = h.read_png(&png, json!([]));
    // The frame's widest line, laid end to end with a space's gap until the row is 4,333 px wide.
    let l = r["read"]["lines"].as_array().unwrap().iter().max_by(|a, b| a["box"][2].as_f64().unwrap().total_cmp(&b["box"][2].as_f64().unwrap())).unwrap().clone();
    let (bx, by, bw, bh) = (l["box"][0].as_f64().unwrap() as usize, l["box"][1].as_f64().unwrap() as usize, l["box"][2].as_f64().unwrap() as usize, l["box"][3].as_f64().unwrap() as usize);
    let piece = l["variants"][0]["text"].as_str().unwrap().replace(' ', "");
    let total = 4333usize;
    let gap = 8usize;
    let bg = [frame[(by * fw + bx) * 3], frame[(by * fw + bx) * 3 + 1], frame[(by * fw + bx) * 3 + 2]];
    let ch = bh + 60;
    let mut canvas = vec![0u8; total * ch * 3];
    for px in canvas.chunks_mut(3) {
        px.copy_from_slice(&bg);
    }
    let mut crop = vec![0u8; bw * bh * 3];
    for y in 0..bh {
        crop[y * bw * 3..(y + 1) * bw * 3].copy_from_slice(&frame[((by + y).min(fh - 1) * fw + bx) * 3..((by + y).min(fh - 1) * fw + bx + bw) * 3]);
    }
    let mut x = 0usize;
    let mut want = String::new();
    let mut copies = 0;
    while x + bw <= total {
        blit(&mut canvas, total, ch, &crop, bw, bh, x as i64, 30);
        want.push_str(&piece);
        copies += 1;
        x += bw + gap;
    }
    assert!(copies >= 3);
    let p = w.join("long.png");
    write_png(&p, total, ch, &canvas);
    let (_, r) = h.read_png(&p, json!([]));
    let lines = r["read"]["lines"].as_array().unwrap();
    let widest = lines.iter().map(|l| l["box"][2].as_f64().unwrap()).fold(0.0, f64::max);
    assert!(widest > 2.0 * bw as f64, "the copies are read as one long line ({widest} px wide)");
    let got: String = texts(&r).join("").replace(' ', "");
    // Within the parity tolerance: the same characters, but for a few at chunk edges.
    let d = edit_distance(&got, &want);
    assert!(d * 50 <= want.chars().count(), "{d} edits of {} characters\n{got}\n{want}", want.chars().count());
    let _ = std::fs::remove_dir_all(w);
}

fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1]));
        }
        prev = cur;
    }
    prev[b.len()]
}

#[test]
fn r07_every_span_lies_inside_its_line_and_spans_increase() {
    let mut h = opened();
    for name in ["01-editor-0-dark-100.png", "11-crm-0-light-150.png", "21-chat-0-dark-100.png"] {
        let (id, r) = h.read_png(&eval_png(name), json!([]));
        let pick: Vec<usize> = (0..r["read"]["lines"].as_array().unwrap().len()).collect();
        let c = h.send(json!({ "op": "careful", "read": id, "lines": pick }));
        let careful = h.wait(c, Duration::from_secs(300));
        for (i, l) in r["read"]["lines"].as_array().unwrap().iter().enumerate() {
            let b = &l["box"];
            let (x0, x1) = (b[0].as_f64().unwrap(), b[0].as_f64().unwrap() + b[2].as_f64().unwrap());
            let mut variants = l["variants"].as_array().unwrap().clone();
            variants.extend(careful["careful"][i].as_array().unwrap().iter().cloned());
            for v in variants {
                let spans = v["spans"].as_array().unwrap();
                let units = v["text"].as_str().unwrap().encode_utf16().count();
                assert_eq!(spans.len(), units, "one span a UTF-16 unit: {v}");
                let mut last = f64::MIN;
                for s in spans {
                    let (a, z) = (s[0].as_f64().unwrap(), s[1].as_f64().unwrap());
                    assert!(a >= x0 - 0.5 && z <= x1 + 0.5 && a < z, "{name} line {i}: span {s} outside {b}");
                    assert!(a >= last - 0.01, "{name} line {i}: spans go back");
                    last = a;
                }
            }
        }
    }
}

#[test]
#[cfg_attr(not(windows), ignore = "Windows only: runs on the reference PC (decision 8)")]
fn r08_killing_the_helper_kills_its_ffmpeg() {
    let w = work("r08");
    let video = w.join("long.mp4");
    run_ffmpeg(&["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=120", "-c:v", "libx264", "-preset", "ultrafast", "-g", "15", "-pix_fmt", "yuv420p", video.to_str().unwrap()]);
    let mut h = opened();
    let l = h.send(json!({ "op": "look", "video": video.to_string_lossy(), "k": 4, "step": 1, "from": 0, "to": 120 }));
    // Its first batch shows the look ffmpeg runs.
    let _ = l;
    std::thread::sleep(Duration::from_secs(3));
    let before = ffmpeg_count();
    assert!(before >= 1);
    h.child.kill().unwrap();
    h.child.wait().unwrap();
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(ffmpeg_count(), before - 1, "the job object ended the look ffmpeg with the helper");
    let _ = std::fs::remove_dir_all(w);
}

#[cfg(windows)]
fn ffmpeg_count() -> usize {
    let out = Command::new("tasklist").args(["/FI", "IMAGENAME eq ffmpeg.exe", "/NH"]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).lines().filter(|l| l.contains("ffmpeg")).count()
}

#[cfg(not(windows))]
fn ffmpeg_count() -> usize {
    0
}

#[test]
fn r09_a_panicking_read_answers_panic_rebuilds_the_plans_and_the_next_read_is_the_same() {
    let mut h = opened();
    let png = eval_png("05-terminal-0-dark-100.png");
    let (_, first) = h.read_png(&png, json!([]));
    let marker = texts(&first).into_iter().find(|t| t.len() >= 8).unwrap();
    let id = h.send(json!({ "op": "panicOn", "text": marker }));
    h.wait(id, Duration::from_secs(10));
    let builds = h.stats()["planBuilds"].as_u64().unwrap();
    let (_, e) = h.read_png(&png, json!([]));
    assert_eq!(e["error"], "panic", "{e}");
    assert_eq!(h.stats()["planBuilds"].as_u64().unwrap(), builds + 13, "every plan built again");
    let id = h.send(json!({ "op": "panicOn", "text": null }));
    h.wait(id, Duration::from_secs(10));
    let (_, again) = h.read_png(&png, json!([]));
    assert_eq!(again["read"], first["read"]);
}

#[test]
#[cfg_attr(not(windows), ignore = "Windows only: the Windows reader is measured on the reference PC (decision 8, §5.13)")]
fn r10_the_windows_reader_on_the_evaluation_set() {
    // The Windows build reads the PNGs as the host build does (R4 run there), then the Windows
    // reader is scored: decision 8 asks 95% pattern recall and 99% padded coverage.
    let v = scored(&repo().join("tests/fixtures/privacy-eval"), "whole", "r10-paddle");
    assert!(v["patternRecall"].as_f64().unwrap() >= 99.0 && v["padded99"].as_f64().unwrap() >= 99.0, "{v}");
    let w = work("r10");
    let out = Command::new(python())
        .args(["-I", "-B"])
        .arg(repo().join("native/ocr/tests/eval_reads.py"))
        .args(["--helper", env!("CARGO_BIN_EXE_ssw-ocr"), "--models"])
        .arg(models())
        .arg("--set")
        .arg(repo().join("tests/fixtures/privacy-eval"))
        .arg("--work")
        .arg(&w)
        .args(["--reader", "windows"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let v: Value = serde_json::from_str(String::from_utf8_lossy(&out.stdout).lines().last().unwrap()).unwrap();
    eprintln!("windows reader: {v}");
    assert!(v["patternRecall"].as_f64().unwrap() >= 95.0, "{v}");
    assert!(v["padded99"].as_f64().unwrap() >= 99.0, "{v}");
}

/// A lossless 60 fps video of a tall page scrolled up by `speed` px a frame, and its page.
fn scroll_video(dir: &Path, speed: usize, frames: usize) -> PathBuf {
    let (fw, fh, a) = load_rgb(&eval_png("01-editor-0-dark-100.png"));
    let (_, _, b) = load_rgb(&eval_png("23-docs-0-light-100.png"));
    let mut tall = vec![0u8; fw * fh * 2 * 3];
    blit(&mut tall, fw, fh * 2, &a, fw, fh, 0, 0);
    blit(&mut tall, fw, fh * 2, &b, fw, fh, 0, fh as i64);
    let page = dir.join("tall.png");
    write_png(&page, fw, fh * 2, &tall);
    let video = dir.join("scroll.mp4");
    let crop = format!("crop=1920:1080:0:n*{speed}");
    run_ffmpeg(&["-loop", "1", "-framerate", "60", "-i", page.to_str().unwrap(), "-vf", &crop, "-frames:v", &frames.to_string(), "-c:v", "libx264rgb", "-qp", "0", "-g", "15", video.to_str().unwrap()]);
    video
}

/// Every look frame of `video`.
fn look(h: &mut Helper, video: &Path, k: u32, step: u32) -> Vec<Value> {
    let id = h.send(json!({ "op": "look", "video": video.to_string_lossy(), "k": k, "step": step, "from": 0, "to": 3600 }));
    let mut frames = vec![];
    loop {
        let e = h.wait(id, Duration::from_secs(300));
        assert!(e.get("error").is_none(), "{e}");
        frames.extend(e["look"].as_array().unwrap().iter().cloned());
        if e["done"] == true {
            return frames;
        }
    }
}

#[test]
fn r11_look_reports_a_scroll_within_a_pixel_and_prints_its_time() {
    let w = work("r11");
    let video = scroll_video(&w, 10, 40);
    let mut h = opened();
    let frames = look(&mut h, &video, 4, 1);
    assert_eq!(frames.len(), 40);
    assert_eq!(frames[0]["key"], true);
    for f in &frames[1..] {
        let m = f["moves"].as_array().unwrap().iter().max_by(|a, b| (a["box"][2].as_f64().unwrap() * a["box"][3].as_f64().unwrap()).total_cmp(&(b["box"][2].as_f64().unwrap() * b["box"][3].as_f64().unwrap()))).expect("a move");
        assert!((m["dy"].as_f64().unwrap() + 10.0).abs() <= 1.0 && m["dx"].as_f64().unwrap().abs() <= 1.0, "{m}");
    }
    let s = h.stats();
    let ms = s["lookNs"].as_f64().unwrap() / s["lookFrames"].as_f64().unwrap() / 1e6;
    println!("R11: look analysis {ms:.2} ms a look frame (480×270)");
    let _ = std::fs::remove_dir_all(w);
}

#[test]
fn r12_look_reports_both_dx_and_dy_of_a_window_dragged_diagonally() {
    let w = work("r12");
    let (_, _, a) = load_rgb(&eval_png("16-settings-1-dark-100.png"));
    // The window: a 900×600 part of a frame, on a plain desktop, dragged by (+12, +8) a frame.
    let mut win = vec![0u8; 900 * 600 * 3];
    for y in 0..600 {
        win[y * 900 * 3..(y + 1) * 900 * 3].copy_from_slice(&a[((y + 100) * 1920 + 300) * 3..((y + 100) * 1920 + 1200) * 3]);
    }
    let wp = w.join("window.png");
    write_png(&wp, 900, 600, &win);
    let video = w.join("drag.mp4");
    run_ffmpeg(&["-f", "lavfi", "-i", "color=c=0x3a6ea5:s=1920x1080:r=60:d=0.5", "-loop", "1", "-i", wp.to_str().unwrap(), "-filter_complex", "[0][1]overlay=x='200+n*12':y='100+n*8':shortest=1", "-frames:v", "30", "-c:v", "libx264rgb", "-qp", "0", video.to_str().unwrap()]);
    let mut h = opened();
    let frames = look(&mut h, &video, 4, 1);
    let mut good = 0;
    for f in &frames[1..] {
        let moves = f["moves"].as_array().unwrap();
        let hit = moves.iter().any(|m| {
            std::iter::once((m["dx"].as_f64().unwrap(), m["dy"].as_f64().unwrap()))
                .chain(m["alt"].as_array().unwrap().iter().map(|c| (c[0].as_f64().unwrap(), c[1].as_f64().unwrap())))
                .any(|(dx, dy)| (dx - 12.0).abs() <= 1.5 && (dy - 8.0).abs() <= 1.5)
        });
        good += usize::from(hit);
    }
    assert!(good + 2 >= frames.len() - 1, "{good} of {} frames report (12, 8)", frames.len() - 1);
    let _ = std::fs::remove_dir_all(w);
}

/// One line of `read` usable as a track: its box, as one part.
fn line_part(read: &Value, contains: &str) -> Value {
    read["read"]["lines"].as_array().unwrap().iter().find(|l| l["variants"][0]["text"].as_str().unwrap().contains(contains)).map(|l| l["box"].clone()).unwrap_or_else(|| panic!("no line holds {contains}: {:?}", texts(read)))
}

#[test]
fn r13_follow_places_parts_on_a_selected_inverted_copy_of_the_text() {
    let w = work("r13");
    let png = eval_png("01-editor-0-dark-100.png");
    let video = w.join("select.mp4");
    // 30 frames as recorded, then 30 with the text selected: the line's pixels inverted.
    run_ffmpeg(&["-loop", "1", "-framerate", "60", "-i", png.to_str().unwrap(), "-vf", "negate=enable='gte(n,30)'", "-frames:v", "60", "-c:v", "libx264rgb", "-qp", "0", "-g", "15", video.to_str().unwrap()]);
    let mut h = opened();
    let (_, r) = h.read_png(&png, json!([]));
    let part = line_part(&r, "DATABASE");
    let v = video.to_string_lossy();
    let s = h.send(json!({ "op": "followOpen", "video": v, "key": 0, "from": 0, "to": 1, "dir": 1 }));
    let opened = h.wait(s, Duration::from_secs(60));
    assert!(opened.get("session").is_some(), "{opened}");
    let t = h.send(json!({ "op": "track", "session": s, "track": 1, "t": 0, "parts": [part] }));
    assert_eq!(h.wait(t, Duration::from_secs(60))["done"], true);
    let m = h.send(json!({ "op": "match", "session": s, "t": 40.0 / 60.0, "tracks": [{ "track": 1, "parts": [0], "candidates": [{ "dx": 0, "dy": 0, "scale": 1 }] }] }));
    let e = h.wait(m, Duration::from_secs(60));
    let got = &e["matched"][0];
    assert!(got["parts"][0].as_f64().unwrap() >= 0.6, "{e}");
    assert!(got["best"]["dx"].as_f64().unwrap().abs() <= 2.0 && got["best"]["dy"].as_f64().unwrap().abs() <= 2.0, "{e}");
    let _ = std::fs::remove_dir_all(w);
}

#[test]
fn r14_follow_reports_a_second_place_within_0_15_when_two_places_match() {
    let w = work("r14");
    let (fw, fh, mut frame) = load_rgb(&eval_png("01-editor-0-dark-100.png"));
    let mut h = opened();
    let (_, r) = h.read_png(&eval_png("01-editor-0-dark-100.png"), json!([]));
    let b = line_part(&r, "DATABASE");
    let (bx, by, bw, bh) = (b[0].as_f64().unwrap() as usize, b[1].as_f64().unwrap() as usize, b[2].as_f64().unwrap() as usize, b[3].as_f64().unwrap() as usize);
    // The same line drawn a second time, 400 px lower.
    let mut copy = vec![0u8; bw * (bh + 8) * 3];
    for y in 0..bh + 8 {
        copy[y * bw * 3..(y + 1) * bw * 3].copy_from_slice(&frame[((by + y - 4) * fw + bx) * 3..((by + y - 4) * fw + bx + bw) * 3]);
    }
    blit(&mut frame, fw, fh, &copy, bw, bh + 8, bx as i64, (by + 400 - 4) as i64);
    let p = w.join("twice.png");
    write_png(&p, fw, fh, &frame);
    let video = w.join("twice.mp4");
    run_ffmpeg(&["-loop", "1", "-framerate", "60", "-i", p.to_str().unwrap(), "-frames:v", "4", "-c:v", "libx264rgb", "-qp", "0", video.to_str().unwrap()]);
    let s = h.send(json!({ "op": "followOpen", "video": video.to_string_lossy(), "key": 0, "from": 0, "to": 0.05, "dir": 1 }));
    h.wait(s, Duration::from_secs(60));
    let t = h.send(json!({ "op": "track", "session": s, "track": 7, "t": 0, "parts": [b] }));
    h.wait(t, Duration::from_secs(60));
    let m = h.send(json!({ "op": "match", "session": s, "t": 1.0 / 60.0, "tracks": [{ "track": 7, "parts": [0], "candidates": [{ "dx": 0, "dy": 0, "scale": 1 }, { "dx": 0, "dy": 400, "scale": 1 }] }] }));
    let e = h.wait(m, Duration::from_secs(60));
    let got = &e["matched"][0];
    let best = got["parts"][0].as_f64().unwrap();
    let second = got["second"].as_f64().unwrap();
    assert!(best >= 0.9, "{e}");
    assert!(best - second < 0.15, "two places score within 0.15, so main refuses the match: {e}");
    let _ = std::fs::remove_dir_all(w);
}

#[test]
fn r15_qr_codes_are_read_and_their_payloads_go_only_to_the_answer() {
    let mut h = opened();
    let mut found = 0;
    let mut payloads = vec![];
    for name in ["17-twofa-0-light-100.png", "18-twofa-1-dark-125.png"] {
        let (_, r) = h.read_png(&eval_png(name), json!([]));
        for q in r["read"]["qr"].as_array().unwrap() {
            found += 1;
            if let Some(p) = q["payload"].as_str() {
                payloads.push(p.to_string());
            }
        }
    }
    assert_eq!(found, 6, "the six codes of the set");
    assert!(payloads.len() >= 5, "{payloads:?}");
    assert!(payloads.iter().any(|p| p.starts_with("otpauth://")));
    let err = h.stderr_text();
    for p in &payloads {
        assert!(!err.contains(p.as_str()));
    }
}

#[test]
fn r16_a_read_at_19_minutes_decodes_at_most_one_key_frame_interval() {
    let w = work("r16");
    let video = w.join("twenty.mp4");
    run_ffmpeg(&["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=1200", "-c:v", "libx264", "-preset", "ultrafast", "-g", "15", "-pix_fmt", "yuv420p", video.to_str().unwrap()]);
    let mut h = opened();
    // The key frame at 1140 s (every 15 frames at 30 fps), and a frame 10 frames after it.
    let t = 1140.0 + 10.0 / 30.0;
    let r = h.send(json!({ "op": "read", "video": video.to_string_lossy(), "key": 1140.0, "t": t, "areas": [[0, 0, 320, 180]] }));
    let e = h.wait(r, Duration::from_secs(120));
    assert!((e["read"]["t"].as_f64().unwrap() - t).abs() < 0.002, "{e}");
    let decoded = h.stats()["lastReadDecoded"].as_u64().unwrap();
    assert!(decoded <= 15, "decoded {decoded} frames");
    let _ = std::fs::remove_dir_all(w);
}

#[test]
fn r17_through_the_planned_areas_within_half_a_point_of_whole_frames() {
    let set = repo().join("tests/fixtures/privacy-eval");
    let whole = scored(&set, "whole", "r17-whole");
    let planned = scored(&set, "planned", "r17-planned");
    for k in ["patternRecall", "padded99"] {
        let (a, b) = (whole[k].as_f64().unwrap(), planned[k].as_f64().unwrap());
        assert!(b >= a - 0.5, "{k}: planned {b}, whole {a}");
    }
}

/// R18's second half, the typing box of `planReads` at that scale, is part P4's (plan.ts, test 138).
#[test]
fn r18_frames_at_150_and_200_percent_keep_every_item_under_its_lines() {
    let base = scored(&repo().join("tests/fixtures/privacy-eval"), "whole", "r18-100");
    for scale in ["1.5", "2"] {
        let dir = work(&format!("r18-{scale}"));
        let out = Command::new("node").arg(repo().join("scripts/privacy/make-eval-set.mjs")).arg(&dir).args(["--scale", scale]).current_dir(repo()).output().expect("node");
        assert!(out.status.success(), "make-eval-set.mjs --scale {scale}: {}", String::from_utf8_lossy(&out.stderr));
        let v = scored(&dir, "whole", &format!("r18-{scale}-scored"));
        // Each planted item's ink under its lines' padded boxes, as at 100%. (The scorer's stand-in
        // rules measure distances in pixels at 100%; the product's rules are P3's, at any scale.)
        assert!(v["inReaderLines99"].as_f64().unwrap() >= base["inReaderLines99"].as_f64().unwrap() - 1.0, "{scale}: {v} against {base}");
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn r19_a_panic_and_a_malformed_command_holding_a_marker_leave_no_marker_on_stderr() {
    let mut h = opened();
    let png = eval_png("21-chat-0-dark-100.png");
    let (_, r) = h.read_png(&png, json!([]));
    let marker = texts(&r).into_iter().find(|t| t.len() >= 10).unwrap();
    let id = h.send(json!({ "op": "panicOn", "text": marker }));
    h.wait(id, Duration::from_secs(10));
    let (_, e) = h.read_png(&png, json!([]));
    assert_eq!(e["error"], "panic");
    h.send_raw(&format!("{{\"op\":\"read\",\"id\":99,\"video\":\"{marker}\",\"t\":\"{marker}\"}}"));
    assert_eq!(h.wait(99, Duration::from_secs(10))["error"], "bad-command");
    h.send_raw(&format!("not json {marker}"));
    std::thread::sleep(Duration::from_millis(300));
    let err = h.stderr_text();
    assert!(err.contains("panic at "), "{err}");
    assert!(!err.contains(&marker), "stderr holds the marker: {err}");
    assert!(!err.contains("holds the marker"), "the panic's message reached stderr");
}

#[test]
fn r20_the_helper_exits_when_stdin_ends_or_stdout_closes() {
    let mut h = Helper::start();
    std::thread::sleep(Duration::from_millis(300));
    drop(h.stdin.take());
    let start = Instant::now();
    loop {
        if h.child.try_wait().unwrap().is_some() {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(2), "still running 2 s after stdin closed");
        std::thread::sleep(Duration::from_millis(50));
    }
    // stdout closed: the next heartbeat fails and the helper ends.
    let mut child = Command::new(env!("CARGO_BIN_EXE_ssw-ocr")).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    drop(child.stdout.take());
    let start = Instant::now();
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(5), "still running after stdout closed");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn r21_a_frame_of_1500_short_lines_answers_partial_and_its_areas_hold_the_rest() {
    let w = work("r21");
    let (fw, _, frame) = load_rgb(&eval_png("13-inbox-0-light-100.png"));
    let mut h = opened();
    let (_, r) = h.read_png(&eval_png("13-inbox-0-light-100.png"), json!([]));
    // A short word of the frame, tiled 1,500 times over 3840×2160.
    let l = r["read"]["lines"].as_array().unwrap().iter().find(|l| (40.0..72.0).contains(&l["box"][2].as_f64().unwrap()) && l["box"][3].as_f64().unwrap() < 30.0).unwrap().clone();
    let (bx, by, bw, bh) = (l["box"][0].as_f64().unwrap() as usize, l["box"][1].as_f64().unwrap() as usize, l["box"][2].as_f64().unwrap() as usize, l["box"][3].as_f64().unwrap() as usize);
    let mut word = vec![0u8; bw * bh * 3];
    for y in 0..bh {
        word[y * bw * 3..(y + 1) * bw * 3].copy_from_slice(&frame[((by + y) * fw + bx) * 3..((by + y) * fw + bx + bw) * 3]);
    }
    let bg = [frame[(by * fw + bx) * 3], frame[(by * fw + bx) * 3 + 1], frame[(by * fw + bx) * 3 + 2]];
    let (cw, ch) = (3840usize, 2160usize);
    let mut canvas = vec![0u8; cw * ch * 3];
    for px in canvas.chunks_mut(3) {
        px.copy_from_slice(&bg);
    }
    let (cols, rows) = (30usize, 50usize);
    for i in 0..1500 {
        let (c, rr) = (i % cols, i / cols);
        blit(&mut canvas, cw, ch, &word, bw, bh, (c * (cw / cols) + 6) as i64, (rr * (ch / rows) + 6) as i64);
    }
    let p = w.join("dense.png");
    write_png(&p, cw, ch, &canvas);
    let (_, r) = h.read_png(&p, json!([]));
    let first = r["read"]["lines"].as_array().unwrap().len();
    let partial = r["read"]["partial"].as_array().expect("partial").clone();
    assert_eq!(first, 1000, "the line cap");
    let mut more = 0;
    for a in &partial {
        let (_, e) = h.read_png(&p, json!([a]));
        assert!(e["read"].get("partial").is_none(), "{e}");
        more += e["read"]["lines"].as_array().unwrap().len();
    }
    // Lines the first read already had can be read again near an area's edge; none is lost.
    assert!(first + more >= 1500, "{first} + {more}");
    let _ = std::fs::remove_dir_all(w);
}

#[test]
fn r22_a_follow_session_decodes_each_frame_once_for_twenty_tracks() {
    let w = work("r22");
    let video = scroll_video(&w, 3, 300);
    let mut h = opened();
    let (_, r) = h.read_png(&eval_png("01-editor-0-dark-100.png"), json!([]));
    // Each line's first part, as main cuts them: at most six line heights wide (§5.8).
    let boxes: Vec<Value> = r["read"]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|l| l["box"][2].as_f64().unwrap() > 30.0)
        .take(20)
        .map(|l| {
            let b = &l["box"];
            let hh = b[3].as_f64().unwrap();
            json!([b[0], b[1], b[2].as_f64().unwrap().min(6.0 * hh), hh])
        })
        .collect();
    assert_eq!(boxes.len(), 20);
    let before = h.stats();
    let s = h.send(json!({ "op": "followOpen", "video": video.to_string_lossy(), "key": 0, "from": 0, "to": 299.0 / 60.0 + 0.001, "dir": 1 }));
    h.wait(s, Duration::from_secs(60));
    for (i, b) in boxes.iter().enumerate() {
        let t = h.send(json!({ "op": "track", "session": s, "track": i, "t": 0, "parts": [b] }));
        assert_eq!(h.wait(t, Duration::from_secs(60))["done"], true);
    }
    let mut placed = 0;
    for f in 1..300 {
        let tracks: Vec<Value> = (0..20).map(|i| json!({ "track": i, "parts": [0], "candidates": [{ "dx": 0, "dy": -3.0 * f as f64, "scale": 1 }] })).collect();
        let m = h.send(json!({ "op": "match", "session": s, "t": f as f64 / 60.0, "tracks": tracks }));
        let e = h.wait(m, Duration::from_secs(60));
        let got = e["matched"].as_array().unwrap();
        assert_eq!(got.len(), 20, "every track in one answer");
        placed += got.iter().filter(|g| g["parts"][0].as_f64().is_some_and(|v| v >= 0.6)).count();
    }
    let after = h.stats();
    let frames = after["followFrames"].as_u64().unwrap() - before["followFrames"].as_u64().unwrap();
    assert_eq!(frames, 300, "each frame decoded once");
    let ns = after["matchNs"].as_f64().unwrap() - before["matchNs"].as_f64().unwrap();
    let per = ns / 1e6 / (299.0 * 20.0);
    println!("R22: {per:.4} ms a part a frame, {placed} of {} placed", 299 * 20);
    assert!(per < 0.1, "{per} ms a part a frame");
    let _ = std::fs::remove_dir_all(w);
}

/// A part of a line of the editor frame whose top lies in [y0, y1), at most six line heights wide (§5.8), as a box.
fn editor_part(h: &mut Helper, y0: f64, y1: f64) -> Value {
    let (_, r) = h.read_png(&eval_png("01-editor-0-dark-100.png"), json!([]));
    let l = r["read"]["lines"].as_array().unwrap().iter().find(|l| {
        let b = &l["box"];
        let y = b[1].as_f64().unwrap();
        y >= y0 && y < y1 && b[2].as_f64().unwrap() > 120.0
    });
    let b = &l.unwrap_or_else(|| panic!("a line between {y0} and {y1}: {:?}", texts(&r)))["box"];
    let hh = b[3].as_f64().unwrap();
    json!([b[0], b[1], b[2].as_f64().unwrap().min(6.0 * hh), hh])
}

/// `part` (a box of the frame scrolled by 0) where the scroll video shows it at frame `n` (`speed` px a frame).
fn scrolled(part: &Value, speed: f64, n: usize) -> Value {
    json!([part[0], part[1].as_f64().unwrap() - speed * n as f64, part[2], part[3]])
}

#[test]
fn r23_a_backward_session_over_one_instant_holds_its_frame() {
    let w = work("r23");
    let video = scroll_video(&w, 10, 40);
    let mut h = opened();
    let part = editor_part(&mut h, 300.0, 900.0);
    // Every hit of a span read at one frame walks back from that frame alone: [t, t].
    let t = 20.0 / 60.0;
    let s = h.send(json!({ "op": "followOpen", "video": video.to_string_lossy(), "key": 0, "from": t, "to": t, "dir": -1 }));
    let opened = h.wait(s, Duration::from_secs(60));
    assert_eq!(opened["session"]["frames"], 1, "{opened}");
    let tr = h.send(json!({ "op": "track", "session": s, "track": 1, "t": t, "parts": [scrolled(&part, 10.0, 20)] }));
    assert_eq!(h.wait(tr, Duration::from_secs(60))["done"], true);
    let m = h.send(json!({ "op": "match", "session": s, "t": t, "tracks": [{ "track": 1, "parts": [0], "candidates": [{ "dx": 0, "dy": 0, "scale": 1 }] }] }));
    let e = h.wait(m, Duration::from_secs(60));
    assert!(e["matched"][0]["parts"][0].as_f64().unwrap_or(0.0) >= 0.99, "{e}");
    let _ = std::fs::remove_dir_all(w);
}

#[test]
fn r24_a_backward_session_answers_each_frame_itself_across_its_pieces() {
    let w = work("r24");
    // 60 frames scrolling 5 px a frame: the walk back from the last frame crosses a piece's edge.
    let video = scroll_video(&w, 5, 60);
    let mut h = opened();
    let part = editor_part(&mut h, 340.0, 700.0);
    let last = 59.0 / 60.0;
    let s = h.send(json!({ "op": "followOpen", "video": video.to_string_lossy(), "key": 0, "from": 0, "to": last, "dir": -1 }));
    h.wait(s, Duration::from_secs(60));
    let tr = h.send(json!({ "op": "track", "session": s, "track": 1, "t": last, "parts": [scrolled(&part, 5.0, 59)] }));
    assert_eq!(h.wait(tr, Duration::from_secs(60))["done"], true);
    for n in (0..59).rev() {
        // Going back, the page was 5 px lower a frame earlier.
        let dy = 5.0 * (59 - n) as f64;
        let m = h.send(json!({ "op": "match", "session": s, "t": n as f64 / 60.0, "tracks": [{ "track": 1, "parts": [0], "candidates": [{ "dx": 0, "dy": dy, "scale": 1 }] }] }));
        let e = h.wait(m, Duration::from_secs(60));
        let got = &e["matched"][0];
        assert!(got["parts"][0].as_f64().unwrap_or(0.0) >= 0.75 && (got["best"]["dy"].as_f64().unwrap_or(f64::NAN) - dy).abs() <= 2.0, "frame {n}: {e}");
    }
    let _ = std::fs::remove_dir_all(w);
}

#[test]
fn r25_look_reports_the_scroll_of_a_column_four_tiles_wide() {
    let w = work("r25");
    let (fw, fh, a) = load_rgb(&eval_png("01-editor-0-dark-100.png"));
    let (_, _, b) = load_rgb(&eval_png("23-docs-0-light-100.png"));
    let mut tall = vec![0u8; fw * fh * 2 * 3];
    blit(&mut tall, fw, fh * 2, &a, fw, fh, 0, 0);
    blit(&mut tall, fw, fh * 2, &b, fw, fh, 0, fh as i64);
    let page = w.join("tall.png");
    write_png(&page, fw, fh * 2, &tall);
    let still = eval_png("16-settings-1-dark-100.png");
    // A 128 px column (4 tiles at k = 4) of the tall page scrolling 6 px a frame over a still frame.
    let video = w.join("column.mp4");
    run_ffmpeg(&["-loop", "1", "-framerate", "60", "-i", still.to_str().unwrap(), "-loop", "1", "-framerate", "60", "-i", page.to_str().unwrap(), "-filter_complex", "[1]crop=128:1080:384:n*6[c];[0][c]overlay=384:0", "-frames:v", "30", "-c:v", "libx264rgb", "-qp", "0", video.to_str().unwrap()]);
    let mut h = opened();
    let frames = look(&mut h, &video, 4, 1);
    let mut good = 0;
    for f in &frames[1..] {
        let hit = f["moves"].as_array().unwrap().iter().any(|m| m["box"][2].as_f64().unwrap() <= 192.0 && (m["dy"].as_f64().unwrap() + 6.0).abs() <= 1.0 && m["dx"].as_f64().unwrap().abs() <= 1.0);
        good += usize::from(hit);
    }
    assert!(good + 2 >= frames.len() - 1, "{good} of {} frames report the column's move (0, -6)", frames.len() - 1);
    let _ = std::fs::remove_dir_all(w);
}

#[test]
fn r26_a_backward_piece_decodes_from_its_key_frame_to_its_own_end_only() {
    let w = work("r26");
    // Four minutes at 30 fps, 1280x720, a key frame every 15 frames: decoding all of it takes seconds.
    let video = w.join("long.mp4");
    run_ffmpeg(&["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=240", "-c:v", "libx264", "-preset", "ultrafast", "-g", "15", "-pix_fmt", "yuv420p", video.to_str().unwrap()]);
    let mut h = opened();
    let before = h.stats()["followDecoded"].as_u64().unwrap();
    // A backward session over [10, 10.4]: one piece, from the key frame at 9.5 s up to its end.
    let started = Instant::now();
    let s = h.send(json!({ "op": "followOpen", "video": video.to_string_lossy(), "key": 9.5, "from": 10.0, "to": 10.4, "dir": -1 }));
    let opened = h.wait(s, Duration::from_secs(120));
    let took = started.elapsed();
    assert!(opened["session"]["frames"].as_u64().unwrap() >= 12, "{opened}");
    let decoded = h.stats()["followDecoded"].as_u64().unwrap() - before;
    // The piece's 13 frames and at most a key-frame interval before them; not the 230 s after it,
    // neither decoded nor waited for (ffmpeg holds a frame's pixels until the next one is selected).
    assert!(decoded <= 15 + 13, "decoded {decoded} frames for one piece");
    assert!(took < Duration::from_secs(3), "one piece took {took:?}");
    let _ = std::fs::remove_dir_all(w);
}
