//! The stdin/stdout protocol spoken with the Electron main process
//! (see src/main/nativeCapture.ts). Events are newline-delimited JSON objects on
//! stdout; commands are plain text lines on stdin.

/// A command read from stdin. The optional value is the epoch-ms instant the app
/// paused/resumed/stopped at, so the video timeline matches the app's own clock
/// even though the line arrives a few milliseconds later.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Command {
    Pause(Option<f64>),
    Resume(Option<f64>),
    Stop(Option<f64>),
}

pub fn parse_command(line: &str) -> Result<Command, String> {
    let mut parts = line.split_whitespace();
    let name = parts.next().ok_or_else(|| "empty command".to_string())?;
    let at = match parts.next() {
        None => None,
        Some(v) => match v.parse::<f64>() {
            Ok(n) if n.is_finite() && n > 0.0 => Some(n),
            _ => return Err(format!("invalid timestamp: {v}")),
        },
    };
    if parts.next().is_some() {
        return Err(format!("unexpected arguments: {line}"));
    }
    match name.to_ascii_lowercase().as_str() {
        "pause" => Ok(Command::Pause(at)),
        "resume" => Ok(Command::Resume(at)),
        "stop" => Ok(Command::Stop(at)),
        other => Err(format!("unknown command: {other}")),
    }
}

/// Minimal JSON object writer; the helper has no dependencies besides `windows`.
pub struct JsonObject {
    buf: String,
    empty: bool,
}

impl JsonObject {
    pub fn new() -> Self {
        Self { buf: String::from("{"), empty: true }
    }

    fn key(&mut self, key: &str) {
        if !self.empty {
            self.buf.push(',');
        }
        self.empty = false;
        push_json_string(&mut self.buf, key);
        self.buf.push(':');
    }

    pub fn str(mut self, key: &str, value: &str) -> Self {
        self.key(key);
        push_json_string(&mut self.buf, value);
        self
    }

    pub fn opt_str(self, key: &str, value: Option<&str>) -> Self {
        match value {
            Some(v) => self.str(key, v),
            None => self.raw(key, "null"),
        }
    }

    pub fn int(mut self, key: &str, value: i64) -> Self {
        self.key(key);
        self.buf.push_str(&value.to_string());
        self
    }

    /// Finite numbers only; non-finite values are written as null (JSON has no NaN).
    pub fn num(mut self, key: &str, value: f64) -> Self {
        self.key(key);
        if value.is_finite() {
            // Millisecond timestamps need no more than microsecond precision.
            let rounded = (value * 1000.0).round() / 1000.0;
            if rounded == rounded.trunc() && rounded.abs() < 9.0e15 {
                self.buf.push_str(&format!("{}", rounded as i64));
            } else {
                self.buf.push_str(&format!("{rounded}"));
            }
        } else {
            self.buf.push_str("null");
        }
        self
    }

    pub fn bool(mut self, key: &str, value: bool) -> Self {
        self.key(key);
        self.buf.push_str(if value { "true" } else { "false" });
        self
    }

    /// Inserts an already-serialised JSON value.
    pub fn raw(mut self, key: &str, json: &str) -> Self {
        self.key(key);
        self.buf.push_str(json);
        self
    }

    pub fn finish(mut self) -> String {
        self.buf.push('}');
        self.buf
    }
}

impl Default for JsonObject {
    fn default() -> Self {
        Self::new()
    }
}

pub fn json_array(items: &[String]) -> String {
    format!("[{}]", items.join(","))
}

pub fn push_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn event_ready() -> String {
    JsonObject::new().str("event", "ready").finish()
}

pub struct StartedInfo<'a> {
    pub at: f64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub encoder: &'a str,
    pub hardware: bool,
    /// Fragmented MP4: playable up to the last ~1 s fragment even if the helper dies.
    pub fragmented: bool,
}

pub fn event_started(info: &StartedInfo) -> String {
    JsonObject::new()
        .str("event", "started")
        .num("at", info.at)
        .int("width", info.width as i64)
        .int("height", info.height as i64)
        .int("fps", info.fps as i64)
        .str("encoder", info.encoder)
        .bool("hardware", info.hardware)
        .bool("fragmented", info.fragmented)
        .finish()
}

pub fn event_cursor(at: f64, shape: &str) -> String {
    JsonObject::new().str("event", "cursor").num("at", at).str("shape", shape).finish()
}

pub fn event_paused(at: f64) -> String {
    JsonObject::new().str("event", "paused").num("at", at).finish()
}

pub fn event_resumed(at: f64) -> String {
    JsonObject::new().str("event", "resumed").num("at", at).finish()
}

pub struct StoppedInfo<'a> {
    pub frames: u64,
    pub dropped: u64,
    /// Seconds of video written (paused time excluded).
    pub duration: f64,
    /// Why recording ended: "stop" (command), "eof" (stdin or stdout closed), "closed" (monitor
    /// went away), "interrupt" (Ctrl+C or closing the console) or "shutdown" (sign-out/shutdown).
    pub reason: &'a str,
}

pub fn event_stopped(info: &StoppedInfo) -> String {
    JsonObject::new()
        .str("event", "stopped")
        .int("frames", info.frames as i64)
        .int("dropped", info.dropped as i64)
        .num("duration", info.duration)
        .str("reason", info.reason)
        .finish()
}

pub fn event_error(message: &str) -> String {
    JsonObject::new().str("event", "error").str("message", message).finish()
}

pub fn event_warning(message: &str) -> String {
    JsonObject::new().str("event", "warning").str("message", message).finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commands_with_and_without_timestamps() {
        assert_eq!(parse_command("pause"), Ok(Command::Pause(None)));
        assert_eq!(parse_command("  RESUME  "), Ok(Command::Resume(None)));
        assert_eq!(parse_command("stop 1700000000123.5"), Ok(Command::Stop(Some(1700000000123.5))));
        assert_eq!(parse_command("pause 1700000000000\r"), Ok(Command::Pause(Some(1700000000000.0))));
    }

    #[test]
    fn rejects_malformed_commands() {
        assert!(parse_command("").is_err());
        assert!(parse_command("   ").is_err());
        assert!(parse_command("jump").is_err());
        assert!(parse_command("pause soon").is_err());
        assert!(parse_command("pause -5").is_err());
        assert!(parse_command("pause NaN").is_err());
        assert!(parse_command("stop 1 2").is_err());
    }

    #[test]
    fn escapes_json_strings() {
        let mut s = String::new();
        push_json_string(&mut s, "a\"b\\c\nd\u{1}é\u{2028}");
        assert_eq!(s, "\"a\\\"b\\\\c\\nd\\u0001é\\u2028\"");
    }

    #[test]
    fn writes_events_as_single_line_json() {
        let started = event_started(&StartedInfo {
            at: 1700000000123.0,
            width: 1920,
            height: 1080,
            fps: 60,
            encoder: "NVIDIA H.264 Encoder MFT",
            hardware: true,
            fragmented: true,
        });
        assert_eq!(
            started,
            r#"{"event":"started","at":1700000000123,"width":1920,"height":1080,"fps":60,"encoder":"NVIDIA H.264 Encoder MFT","hardware":true,"fragmented":true}"#
        );
        assert_eq!(event_ready(), r#"{"event":"ready"}"#);
        assert_eq!(event_cursor(12.25, "text"), r#"{"event":"cursor","at":12.25,"shape":"text"}"#);
        assert_eq!(
            event_stopped(&StoppedInfo { frames: 120, dropped: 0, duration: 2.0, reason: "stop" }),
            r#"{"event":"stopped","frames":120,"dropped":0,"duration":2,"reason":"stop"}"#
        );
        assert_eq!(event_error("bad \"thing\""), r#"{"event":"error","message":"bad \"thing\""}"#);
        assert!(!event_error("line1\nline2").contains('\n'));
    }

    #[test]
    fn numbers_are_finite_json() {
        let s = JsonObject::new().num("a", f64::NAN).num("b", 0.1234567).num("c", -3.0).finish();
        assert_eq!(s, r#"{"a":null,"b":0.123,"c":-3}"#);
        let s = JsonObject::new().opt_str("x", None).opt_str("y", Some("z")).finish();
        assert_eq!(s, r#"{"x":null,"y":"z"}"#);
        assert_eq!(json_array(&["1".into(), "{}".into()]), "[1,{}]");
    }
}
