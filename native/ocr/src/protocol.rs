//! The helper's protocol (docs/design/auto-blur.md §16.0 `protocol.ts`): one JSON object a line
//! each way. Commands are read strictly, as `parseHelperCommand` reads them: an unknown key, a
//! wrong type or a line over 16 MB is refused (`bad-command`). Events are written whole, one line
//! each, under one lock, so the heartbeat never splits an answer. Nothing a command or an answer
//! holds is ever written to stderr.

use serde_json::{json, Map, Value};
use std::io::Write;
use std::sync::Mutex;

pub const PROTOCOL: u64 = 1;
/// Longest line either side accepts (`MAX_LINE` in protocol.ts).
pub const MAX_LINE: usize = 16 * 1024 * 1024;

/// A rectangle in video pixels: x, y, width, height.
pub type BoxF = [f64; 4];

#[derive(Clone, Debug, PartialEq)]
pub struct Pin {
    pub file: String,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Candidate {
    pub dx: f64,
    pub dy: f64,
    pub scale: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TrackAsk {
    pub track: u64,
    pub parts: Vec<usize>,
    pub candidates: Vec<Candidate>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reader {
    Paddle,
    Windows,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    Open { id: u64, reader: Reader, models: Vec<Pin>, ffmpeg: String },
    Look { id: u64, video: String, k: u32, step: u32, from: f64, to: f64 },
    Read { id: u64, video: String, key: f64, t: f64, areas: Vec<BoxF> },
    Careful { id: u64, read: u64, lines: Vec<usize> },
    Release { id: u64, read: u64 },
    FollowOpen { id: u64, video: String, key: f64, from: f64, to: f64, dir: i32 },
    Track { id: u64, session: u64, track: u64, t: f64, parts: Vec<BoxF> },
    Match { id: u64, session: u64, t: f64, tracks: Vec<TrackAsk> },
    CloseSession { id: u64, session: u64 },
    Cancel { id: u64, target: u64 },
    Pause { id: u64 },
    Resume { id: u64 },
    Stop { id: u64 },
    /// Test builds only: read a PNG file as a frame at t = 0.
    #[cfg(feature = "fixture")]
    ReadImage { id: u64, png: String, areas: Vec<BoxF> },
    /// Test builds only: the counters of `stats.rs`.
    #[cfg(feature = "fixture")]
    Stats { id: u64 },
    /// Test builds only: panic while recognising a line whose text holds `text` (null: never).
    #[cfg(feature = "fixture")]
    PanicOn { id: u64, text: Option<String> },
}

impl Command {
    pub fn id(&self) -> u64 {
        match self {
            Command::Open { id, .. }
            | Command::Look { id, .. }
            | Command::Read { id, .. }
            | Command::Careful { id, .. }
            | Command::Release { id, .. }
            | Command::FollowOpen { id, .. }
            | Command::Track { id, .. }
            | Command::Match { id, .. }
            | Command::CloseSession { id, .. }
            | Command::Cancel { id, .. }
            | Command::Pause { id }
            | Command::Resume { id }
            | Command::Stop { id } => *id,
            #[cfg(feature = "fixture")]
            Command::ReadImage { id, .. } | Command::Stats { id } | Command::PanicOn { id, .. } => *id,
        }
    }
}

/// Exactly `keys` (all present, nothing else).
fn keys_are(o: &Map<String, Value>, keys: &[&str]) -> bool {
    o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k))
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

fn uint(v: &Value) -> Option<u64> {
    v.as_u64()
}

fn string(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}

fn boxes(v: &Value) -> Option<Vec<BoxF>> {
    v.as_array()?
        .iter()
        .map(|b| {
            let a = b.as_array().filter(|a| a.len() == 4)?;
            Some([num(&a[0])?, num(&a[1])?, num(&a[2])?, num(&a[3])?])
        })
        .collect()
}

fn indices(v: &Value) -> Option<Vec<usize>> {
    v.as_array()?.iter().map(|x| uint(x).and_then(|n| usize::try_from(n).ok())).collect()
}

fn candidate(v: &Value) -> Option<Candidate> {
    let o = v.as_object().filter(|o| keys_are(o, &["dx", "dy", "scale"]))?;
    Some(Candidate { dx: num(&o["dx"])?, dy: num(&o["dy"])?, scale: num(&o["scale"]).filter(|s| *s > 0.0)? })
}

fn pin(v: &Value) -> Option<Pin> {
    let o = v.as_object().filter(|o| keys_are(o, &["file", "path", "bytes", "sha256"]))?;
    let sha = string(&o["sha256"]).filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))?;
    Some(Pin { file: string(&o["file"])?, path: string(&o["path"])?, bytes: uint(&o["bytes"])?, sha256: sha })
}

/// One command line, read strictly; Err carries the command's id when one could be read (to
/// answer `bad-command` to it), never any of the line's text.
pub fn parse_command(line: &str) -> Result<Command, Option<u64>> {
    if line.len() > MAX_LINE {
        return Err(None);
    }
    let v: Value = serde_json::from_str(line).map_err(|_| None)?;
    let o = v.as_object().ok_or(None)?;
    let id = o.get("id").and_then(uint).ok_or(None)?;
    let op = o.get("op").and_then(Value::as_str).ok_or(Some(id))?;
    let bad = || Some(id);
    let cmd = match op {
        "open" => {
            if !keys_are(o, &["op", "id", "protocol", "reader", "models", "ffmpeg"]) || o["protocol"].as_u64() != Some(PROTOCOL) {
                return Err(bad());
            }
            let reader = match o["reader"].as_str() {
                Some("paddle") => Reader::Paddle,
                Some("windows") => Reader::Windows,
                _ => return Err(bad()),
            };
            let models = o["models"].as_array().ok_or(bad())?.iter().map(pin).collect::<Option<Vec<_>>>().ok_or(bad())?;
            Command::Open { id, reader, models, ffmpeg: string(&o["ffmpeg"]).ok_or(bad())? }
        }
        "look" => {
            if !keys_are(o, &["op", "id", "video", "k", "step", "from", "to"]) {
                return Err(bad());
            }
            let k = uint(&o["k"]).filter(|k| (1..=64).contains(k)).ok_or(bad())? as u32;
            let step = uint(&o["step"]).filter(|s| (1..=16).contains(s)).ok_or(bad())? as u32;
            Command::Look { id, video: string(&o["video"]).ok_or(bad())?, k, step, from: num(&o["from"]).ok_or(bad())?, to: num(&o["to"]).ok_or(bad())? }
        }
        "read" => {
            if !keys_are(o, &["op", "id", "video", "key", "t", "areas"]) {
                return Err(bad());
            }
            Command::Read { id, video: string(&o["video"]).ok_or(bad())?, key: num(&o["key"]).ok_or(bad())?, t: num(&o["t"]).ok_or(bad())?, areas: boxes(&o["areas"]).ok_or(bad())? }
        }
        "careful" => {
            if !keys_are(o, &["op", "id", "read", "lines"]) {
                return Err(bad());
            }
            Command::Careful { id, read: uint(&o["read"]).ok_or(bad())?, lines: indices(&o["lines"]).ok_or(bad())? }
        }
        "release" => {
            if !keys_are(o, &["op", "id", "read"]) {
                return Err(bad());
            }
            Command::Release { id, read: uint(&o["read"]).ok_or(bad())? }
        }
        "followOpen" => {
            if !keys_are(o, &["op", "id", "video", "key", "from", "to", "dir"]) {
                return Err(bad());
            }
            let dir = match o["dir"].as_i64() {
                Some(1) => 1,
                Some(-1) => -1,
                _ => return Err(bad()),
            };
            Command::FollowOpen { id, video: string(&o["video"]).ok_or(bad())?, key: num(&o["key"]).ok_or(bad())?, from: num(&o["from"]).ok_or(bad())?, to: num(&o["to"]).ok_or(bad())?, dir }
        }
        "track" => {
            if !keys_are(o, &["op", "id", "session", "track", "t", "parts"]) {
                return Err(bad());
            }
            Command::Track { id, session: uint(&o["session"]).ok_or(bad())?, track: uint(&o["track"]).ok_or(bad())?, t: num(&o["t"]).ok_or(bad())?, parts: boxes(&o["parts"]).ok_or(bad())? }
        }
        "match" => {
            if !keys_are(o, &["op", "id", "session", "t", "tracks"]) {
                return Err(bad());
            }
            let tracks = o["tracks"]
                .as_array()
                .ok_or(bad())?
                .iter()
                .map(|t| {
                    let t = t.as_object().filter(|t| keys_are(t, &["track", "parts", "candidates"]))?;
                    Some(TrackAsk { track: uint(&t["track"])?, parts: indices(&t["parts"])?, candidates: t["candidates"].as_array()?.iter().map(candidate).collect::<Option<Vec<_>>>()? })
                })
                .collect::<Option<Vec<_>>>()
                .ok_or(bad())?;
            Command::Match { id, session: uint(&o["session"]).ok_or(bad())?, t: num(&o["t"]).ok_or(bad())?, tracks }
        }
        "closeSession" => {
            if !keys_are(o, &["op", "id", "session"]) {
                return Err(bad());
            }
            Command::CloseSession { id, session: uint(&o["session"]).ok_or(bad())? }
        }
        "cancel" => {
            if !keys_are(o, &["op", "id", "target"]) {
                return Err(bad());
            }
            Command::Cancel { id, target: uint(&o["target"]).ok_or(bad())? }
        }
        "pause" | "resume" | "stop" => {
            if !keys_are(o, &["op", "id"]) {
                return Err(bad());
            }
            match op {
                "pause" => Command::Pause { id },
                "resume" => Command::Resume { id },
                _ => Command::Stop { id },
            }
        }
        #[cfg(feature = "fixture")]
        "readImage" => {
            if !keys_are(o, &["op", "id", "png", "areas"]) {
                return Err(bad());
            }
            Command::ReadImage { id, png: string(&o["png"]).ok_or(bad())?, areas: boxes(&o["areas"]).ok_or(bad())? }
        }
        #[cfg(feature = "fixture")]
        "stats" => {
            if !keys_are(o, &["op", "id"]) {
                return Err(bad());
            }
            Command::Stats { id }
        }
        #[cfg(feature = "fixture")]
        "panicOn" => {
            if !keys_are(o, &["op", "id", "text"]) {
                return Err(bad());
            }
            let text = match &o["text"] {
                Value::Null => None,
                Value::String(s) => Some(s.clone()),
                _ => return Err(bad()),
            };
            Command::PanicOn { id, text }
        }
        _ => return Err(bad()),
    };
    Ok(cmd)
}

/// The error kinds of `HelperEvent` (protocol.ts).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Model,
    Read,
    Video,
    TooLarge,
    /// In the protocol for an ffmpeg ended by `stop`; the helper exits on `stop` itself.
    #[allow(dead_code)]
    Stopped,
    Cancelled,
    Panic,
    BadCommand,
}

impl Failure {
    pub fn code(self) -> &'static str {
        match self {
            Failure::Model => "model",
            Failure::Read => "read",
            Failure::Video => "video",
            Failure::TooLarge => "tooLarge",
            Failure::Stopped => "stopped",
            Failure::Cancelled => "cancelled",
            Failure::Panic => "panic",
            Failure::BadCommand => "bad-command",
        }
    }
}

/// stdout, one whole line at a time. A failed write (main is gone) ends the helper (§10.4).
pub struct Out {
    lock: Mutex<()>,
}

impl Out {
    pub const fn new() -> Self {
        Out { lock: Mutex::new(()) }
    }

    /// Writes `v` as one line; Err when stdout is closed.
    pub fn emit(&self, v: &Value) -> std::io::Result<()> {
        let mut line = serde_json::to_vec(v).map_err(std::io::Error::other)?;
        line.push(b'\n');
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let stdout = std::io::stdout();
        let mut w = stdout.lock();
        w.write_all(&line)?;
        w.flush()
    }

    /// Writes `v`; when stdout is closed the helper ends (nobody reads its answers).
    pub fn send(&self, v: Value) {
        if self.emit(&v).is_err() {
            crate::guard::exit_now(0);
        }
    }

    pub fn error(&self, id: u64, f: Failure) {
        self.send(json!({ "id": id, "error": f.code() }));
    }

    pub fn done(&self, id: u64) {
        self.send(json!({ "id": id, "done": true }));
    }
}

/// Rounds a pixel value for the answers (two decimals keep the lines short).
pub fn r2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_command_strictly() {
        assert!(matches!(parse_command(r#"{"op":"read","id":3,"video":"v.mp4","key":1.5,"t":1.75,"areas":[[0,0,10,10]]}"#), Ok(Command::Read { id: 3, .. })));
        assert_eq!(parse_command(r#"{"op":"read","id":3,"video":"v.mp4","key":1.5,"t":1.75,"areas":[[0,0,10,10]],"x":1}"#), Err(Some(3)));
        assert_eq!(parse_command(r#"{"op":"read","id":3,"video":"v.mp4","key":1.5,"t":"1","areas":[]}"#), Err(Some(3)));
        assert_eq!(parse_command("not json"), Err(None));
        assert_eq!(parse_command(r#"{"op":"nope","id":9}"#), Err(Some(9)));
        assert_eq!(parse_command(r#"{"op":"open","id":1,"protocol":2,"reader":"paddle","models":[],"ffmpeg":"f"}"#), Err(Some(1)));
        assert!(matches!(parse_command(r#"{"op":"followOpen","id":4,"video":"v","key":0,"from":0,"to":2,"dir":-1}"#), Ok(Command::FollowOpen { dir: -1, .. })));
        assert_eq!(parse_command(r#"{"op":"followOpen","id":4,"video":"v","key":0,"from":0,"to":2,"dir":0}"#), Err(Some(4)));
        assert!(matches!(
            parse_command(r#"{"op":"match","id":5,"session":4,"t":1,"tracks":[{"track":0,"parts":[0,1],"candidates":[{"dx":0,"dy":-3,"scale":1}]}]}"#),
            Ok(Command::Match { id: 5, .. })
        ));
        assert!(matches!(parse_command(r#"{"op":"cancel","id":6,"target":3}"#), Ok(Command::Cancel { target: 3, .. })));
        let long = format!(r#"{{"op":"stop","id":1,"pad":"{}"}}"#, "x".repeat(MAX_LINE));
        assert_eq!(parse_command(&long), Err(None));
    }

    #[test]
    fn a_pin_needs_a_lower_case_sha256() {
        let ok = format!(r#"{{"op":"open","id":1,"protocol":1,"reader":"paddle","models":[{{"file":"a","path":"/m/a","bytes":3,"sha256":"{}"}}],"ffmpeg":"f"}}"#, "a".repeat(64));
        assert!(parse_command(&ok).is_ok());
        let upper = ok.replace(&"a".repeat(64), &"A".repeat(64));
        assert_eq!(parse_command(&upper), Err(Some(1)));
    }
}
