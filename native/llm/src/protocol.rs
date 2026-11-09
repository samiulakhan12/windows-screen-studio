//! The helper's side of the protocol (src/shared/localAi/protocol.ts,
//! docs/design/smart-tools.md §9.1): one JSON object per line on stdin (`load`, `run`, `cancel`)
//! and on stdout (`loaded`, `read`, `write`, `done`, `cancelled`, `error`). Every input line is read
//! strictly: a line that does not parse, names an unknown `op` or breaks a limit is answered with
//! an `error` line and changes nothing.

use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::PathBuf;

/// The longest input line read (a `run` line carries the whole prompt and its grammar).
pub const INPUT_LINE_MAX: usize = 16 << 20;
/// Characters of prompt text a `run` takes, all parts together.
pub const PROMPT_TEXT_MAX: usize = 4 << 20;
/// Characters of grammar a `run` takes.
pub const GRAMMAR_MAX: usize = 1 << 20;
/// Parts a `run` takes.
pub const PARTS_MAX: usize = 4096;
/// The longest answer: a `done` line's `text` (the app refuses longer ones).
pub const TEXT_MAX: usize = 256 * 1024;
/// Prompt tokens read between two checks for `cancel` (PROMPT_BATCH in budget.ts).
pub const PROMPT_BATCH: usize = 64;
/// A `write` line every this many tokens written.
pub const WRITE_EVERY: u32 = 16;

/// One piece of the chat: `special` says whether special tokens are parsed in it (only the chat
/// template's own pieces; never the user's text).
#[derive(Debug, Clone, PartialEq)]
pub struct Part {
    pub t: String,
    pub special: bool,
}

/// One request (§9.1).
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub id: String,
    pub parts: Vec<Part>,
    pub grammar: String,
    pub max_tokens: u32,
    pub temperature: f32,
    pub top_p: f32,
    pub seed: u32,
}

/// A line from the app.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Load { model: PathBuf, ctx: u32, threads: i32, mmap: bool },
    Run(Run),
    Cancel { id: String },
}

/// Error codes of `error` lines (§9.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    /// The prompt does not fit in the context.
    Context,
    /// The model could not be loaded, or none is loaded.
    Model,
    /// The context could not be made (not enough memory).
    Memory,
    /// Anything else (a bad line, a grammar llama.cpp refuses, a failed decode).
    Internal,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::Context => "context",
            Code::Model => "model",
            Code::Memory => "memory",
            Code::Internal => "internal",
        }
    }
}

/// A failure answered with an `error` line.
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub code: Code,
    pub message: String,
}

impl Failure {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Failure { code, message: message.into() }
    }
}

/// A request id: 1–64 of A-Z, a-z, 0-9, `_` and `-` (as the app's readRequestId).
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn field<'a>(o: &'a Map<String, Value>, key: &str) -> Result<&'a Value, Failure> {
    o.get(key).ok_or_else(|| Failure::new(Code::Internal, format!("`{key}` is missing")))
}

fn uint(o: &Map<String, Value>, key: &str, min: u64, max: u64) -> Result<u64, Failure> {
    match field(o, key)?.as_u64() {
        Some(n) if (min..=max).contains(&n) => Ok(n),
        _ => Err(Failure::new(Code::Internal, format!("`{key}` must be a whole number from {min} to {max}"))),
    }
}

fn float(o: &Map<String, Value>, key: &str, min: f64, max: f64) -> Result<f32, Failure> {
    match field(o, key)?.as_f64() {
        Some(n) if n.is_finite() && n >= min && n <= max => Ok(n as f32),
        _ => Err(Failure::new(Code::Internal, format!("`{key}` must be a number from {min} to {max}"))),
    }
}

fn id_of(o: &Map<String, Value>) -> Result<String, Failure> {
    match field(o, "id")?.as_str() {
        Some(id) if valid_id(id) => Ok(id.to_string()),
        _ => Err(Failure::new(Code::Internal, "`id` must be 1 to 64 letters, digits, _ or -")),
    }
}

/// Only these keys, so a misspelt option is an error rather than silently ignored.
fn only(o: &Map<String, Value>, keys: &[&str]) -> Result<(), Failure> {
    match o.keys().find(|k| !keys.contains(&k.as_str())) {
        Some(k) => Err(Failure::new(Code::Internal, format!("unknown key `{k}`"))),
        None => Ok(()),
    }
}

/// Reads one input line strictly. The id of a `run` or `cancel` comes back with a failure when it
/// could be read, so the app hears which request failed.
pub fn read_command(line: &str) -> Result<Command, (Option<String>, Failure)> {
    let fail = |m: &str| (None, Failure::new(Code::Internal, m));
    if line.len() > INPUT_LINE_MAX {
        return Err(fail("the line is too long"));
    }
    let value: Value = serde_json::from_str(line).map_err(|_| fail("the line is not JSON"))?;
    let Value::Object(o) = value else { return Err(fail("the line is not a JSON object")) };
    let op = o.get("op").and_then(Value::as_str).ok_or_else(|| fail("`op` is missing"))?;
    match op {
        "load" => {
            only(&o, &["op", "model", "ctx", "threads", "mmap"]).map_err(|f| (None, f))?;
            let model = match field(&o, "model").map_err(|f| (None, f))?.as_str() {
                Some(p) if !p.is_empty() && p.len() <= 4096 && !p.contains('\0') => PathBuf::from(p),
                _ => return Err(fail("`model` must be a file path")),
            };
            let ctx = uint(&o, "ctx", 256, 32768).map_err(|f| (None, f))? as u32;
            let threads = uint(&o, "threads", 1, 64).map_err(|f| (None, f))? as i32;
            let mmap = field(&o, "mmap").map_err(|f| (None, f))?.as_bool().ok_or_else(|| fail("`mmap` must be true or false"))?;
            Ok(Command::Load { model, ctx, threads, mmap })
        }
        "cancel" => {
            only(&o, &["op", "id"]).map_err(|f| (None, f))?;
            Ok(Command::Cancel { id: id_of(&o).map_err(|f| (None, f))? })
        }
        "run" => {
            let id = id_of(&o).map_err(|f| (None, f))?;
            let with_id = |f: Failure| (Some(id.clone()), f);
            only(&o, &["op", "id", "parts", "grammar", "maxTokens", "temperature", "topP", "seed"]).map_err(with_id)?;
            let Some(list) = field(&o, "parts").map_err(with_id)?.as_array() else {
                return Err(with_id(Failure::new(Code::Internal, "`parts` must be a list")));
            };
            if list.is_empty() || list.len() > PARTS_MAX {
                return Err(with_id(Failure::new(Code::Internal, format!("`parts` must hold 1 to {PARTS_MAX} parts"))));
            }
            let mut parts = Vec::with_capacity(list.len());
            let mut chars = 0usize;
            for p in list {
                let Some(p) = p.as_object() else { return Err(with_id(Failure::new(Code::Internal, "a part is not an object"))) };
                only(p, &["t", "special"]).map_err(with_id)?;
                let (Some(t), Some(special)) = (p.get("t").and_then(Value::as_str), p.get("special").and_then(Value::as_bool)) else {
                    return Err(with_id(Failure::new(Code::Internal, "a part needs `t` and `special`")));
                };
                chars += t.len();
                parts.push(Part { t: t.to_string(), special });
            }
            if chars > PROMPT_TEXT_MAX {
                return Err(with_id(Failure::new(Code::Context, "the prompt is too long")));
            }
            let grammar = match field(&o, "grammar").map_err(with_id)?.as_str() {
                Some(g) if g.len() <= GRAMMAR_MAX => g.to_string(),
                _ => return Err(with_id(Failure::new(Code::Internal, "`grammar` must be text of at most 1 MB"))),
            };
            let max_tokens = uint(&o, "maxTokens", 1, 32768).map_err(with_id)? as u32;
            let temperature = float(&o, "temperature", 0.0, 2.0).map_err(with_id)?;
            let top_p = float(&o, "topP", 0.01, 1.0).map_err(with_id)?;
            let seed = uint(&o, "seed", 0, u32::MAX as u64).map_err(with_id)? as u32;
            Ok(Command::Run(Run { id, parts, grammar, max_tokens, temperature, top_p, seed }))
        }
        _ => Err(fail("unknown `op`")),
    }
}

/// Text from the engine's bytes: invalid UTF-8 (a code point split by the tokenizer and never
/// completed) becomes U+FFFD.
pub fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

pub fn loaded_line(ms: u64, ctx_train: u32) -> String {
    json!({ "ev": "loaded", "ms": ms, "ctxTrain": ctx_train }).to_string()
}

pub fn read_line(id: &str, done: usize, total: usize) -> String {
    json!({ "ev": "read", "id": id, "done": done, "total": total }).to_string()
}

pub fn write_line(id: &str, tokens: u32) -> String {
    json!({ "ev": "write", "id": id, "tokens": tokens }).to_string()
}

pub struct Answer<'a> {
    pub id: &'a str,
    pub text: &'a str,
    pub prompt: usize,
    pub output: u32,
    pub read_ms: u64,
    pub write_ms: u64,
}

pub fn done_line(a: &Answer) -> String {
    json!({ "ev": "done", "id": a.id, "text": a.text, "prompt": a.prompt, "output": a.output, "readMs": a.read_ms, "writeMs": a.write_ms }).to_string()
}

pub fn cancelled_line(id: &str) -> String {
    json!({ "ev": "cancelled", "id": id }).to_string()
}

/// An `error` line; `id` is absent for a failure that belongs to no request (a bad `load`).
pub fn error_line(id: Option<&str>, f: &Failure) -> String {
    let mut o = Map::new();
    o.insert("ev".into(), "error".into());
    if let Some(id) = id {
        o.insert("id".into(), id.into());
    }
    o.insert("code".into(), f.code.as_str().into());
    o.insert("message".into(), f.message.chars().take(500).collect::<String>().into());
    Value::Object(o).to_string()
}

/// Writes one line to stdout and flushes it; a closed stdout (the app is gone) ends the helper.
pub fn emit(line: &str) {
    let out = std::io::stdout();
    let mut lock = out.lock();
    if writeln!(lock, "{line}").and_then(|_| lock.flush()).is_err() {
        hard_exit(0);
    }
}

extern "C" {
    /// The C runtime's _exit (glibc and msvcrt): ends the process without running atexit
    /// handlers or static destructors, which could wait on ggml's worker threads.
    fn _exit(code: i32) -> !;
}

/// Ends the process at once.
pub fn hard_exit(code: i32) -> ! {
    let _ = std::io::stdout().flush();
    unsafe { _exit(code) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Value {
        serde_json::from_str(line).unwrap()
    }

    #[test]
    fn a_load_line_is_read() {
        let c = read_command(r#"{"op":"load","model":"C:\\m\\a.gguf","ctx":8192,"threads":4,"mmap":false}"#).unwrap();
        assert_eq!(c, Command::Load { model: PathBuf::from("C:\\m\\a.gguf"), ctx: 8192, threads: 4, mmap: false });
    }

    #[test]
    fn a_run_line_is_read() {
        let c = read_command(r#"{"op":"run","id":"r7","parts":[{"t":"<|im_start|>","special":true},{"t":"hi","special":false}],"grammar":"root ::= \"{}\"","maxTokens":400,"temperature":0.2,"topP":0.9,"seed":1}"#).unwrap();
        let Command::Run(r) = c else { panic!("not a run") };
        assert_eq!(r.id, "r7");
        assert_eq!(r.parts, vec![Part { t: "<|im_start|>".into(), special: true }, Part { t: "hi".into(), special: false }]);
        assert_eq!((r.max_tokens, r.seed), (400, 1));
        assert!((r.temperature - 0.2).abs() < 1e-6 && (r.top_p - 0.9).abs() < 1e-6);
    }

    #[test]
    fn bad_lines_are_refused() {
        for line in [
            "",
            "not json",
            "[1,2]",
            r#"{"op":"exec"}"#,
            r#"{"op":"load","model":"a.gguf","ctx":8192,"threads":4}"#,
            r#"{"op":"load","model":"a.gguf","ctx":8192,"threads":0,"mmap":false}"#,
            r#"{"op":"load","model":"a.gguf","ctx":8192,"threads":4,"mmap":false,"url":"http://x"}"#,
            r#"{"op":"cancel","id":"a b"}"#,
            r#"{"op":"cancel"}"#,
        ] {
            let (id, f) = read_command(line).unwrap_err();
            assert_eq!(id, None, "{line}");
            assert_eq!(f.code, Code::Internal, "{line}");
        }
    }

    #[test]
    fn a_bad_run_names_its_id() {
        let base = r#"{"op":"run","id":"r1","parts":PARTS,"grammar":"root ::= \"x\"","maxTokens":MAX,"temperature":0.2,"topP":0.9,"seed":1}"#;
        for (parts, max) in [("[]", "10"), (r#"[{"t":"x"}]"#, "10"), (r#"[{"t":"x","special":false}]"#, "0"), (r#"[{"t":"x","special":"no"}]"#, "10")] {
            let line = base.replace("PARTS", parts).replace("MAX", max);
            let (id, _) = read_command(&line).unwrap_err();
            assert_eq!(id.as_deref(), Some("r1"), "{line}");
        }
    }

    #[test]
    fn a_prompt_over_the_cap_is_a_context_error() {
        let long = "a".repeat(PROMPT_TEXT_MAX + 1);
        let line = format!(r#"{{"op":"run","id":"r1","parts":[{{"t":"{long}","special":false}}],"grammar":"","maxTokens":1,"temperature":0.2,"topP":0.9,"seed":1}}"#);
        assert_eq!(read_command(&line).unwrap_err().1.code, Code::Context);
    }

    #[test]
    fn ids_are_short_and_plain() {
        assert!(valid_id("r7") && valid_id("a_B-9") && valid_id(&"x".repeat(64)));
        assert!(!valid_id("") && !valid_id(&"x".repeat(65)) && !valid_id("a b") && !valid_id("ä"));
    }

    #[test]
    fn output_lines_are_json_objects() {
        assert_eq!(parse(&loaded_line(1840, 131072)), json!({ "ev": "loaded", "ms": 1840, "ctxTrain": 131072 }));
        assert_eq!(parse(&read_line("r7", 512, 1478)), json!({ "ev": "read", "id": "r7", "done": 512, "total": 1478 }));
        assert_eq!(parse(&write_line("r7", 48)), json!({ "ev": "write", "id": "r7", "tokens": 48 }));
        let text = "{\"a\":\"line\nবাংলা।\"}";
        let done = done_line(&Answer { id: "r7", text, prompt: 1478, output: 212, read_ms: 11700, write_ms: 38200 });
        assert!(!done.contains('\n'));
        assert_eq!(parse(&done)["text"], text);
        assert_eq!(parse(&cancelled_line("r7")), json!({ "ev": "cancelled", "id": "r7" }));
        assert_eq!(parse(&error_line(Some("r7"), &Failure::new(Code::Context, "too long"))), json!({ "ev": "error", "id": "r7", "code": "context", "message": "too long" }));
        assert_eq!(parse(&error_line(None, &Failure::new(Code::Model, "no"))), json!({ "ev": "error", "code": "model", "message": "no" }));
    }

    #[test]
    fn split_code_points_become_replacement_characters() {
        assert_eq!(lossy(&[0x61, 0xE0, 0xA6]), "a\u{FFFD}");
    }
}
