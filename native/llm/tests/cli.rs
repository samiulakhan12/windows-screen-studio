//! The built helper without a model (docs/design/smart-tools.md §9.1): arguments, bad lines, the
//! end of stdin and the parent watch. The tests with a model are tests/llmHelper.test.ts
//! (SSW_LLM_TEST_MODEL).

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const EXE: &str = env!("CARGO_BIN_EXE_ssw-llm");

fn spawn(args: &[&str]) -> std::process::Child {
    Command::new(EXE).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().expect("start ssw-llm")
}

fn wait(child: &mut std::process::Child, limit: Duration) -> Option<std::process::ExitStatus> {
    let start = Instant::now();
    while start.elapsed() < limit {
        if let Some(s) = child.try_wait().unwrap() {
            return Some(s);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    None
}

#[test]
fn an_unknown_argument_is_refused() {
    let mut child = spawn(&["--shell"]);
    let status = wait(&mut child, Duration::from_secs(10)).expect("exits");
    assert_eq!(status.code(), Some(64));
}

#[test]
fn bad_lines_get_error_lines_and_the_helper_goes_on() {
    let mut child = spawn(&["--low-priority"]);
    let mut stdin = child.stdin.take().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    for (input, code, id) in [
        ("not json\n", "internal", None),
        ("{\"op\":\"exec\",\"cmd\":\"calc\"}\n", "internal", None),
        ("{\"op\":\"run\",\"id\":\"r1\",\"parts\":[{\"t\":\"x\",\"special\":false}],\"grammar\":\"root ::= \\\"x\\\"\",\"maxTokens\":4,\"temperature\":0.2,\"topP\":0.9,\"seed\":1}\n", "model", Some("r1")),
        ("{\"op\":\"load\",\"model\":\"/no/such/model.gguf\",\"ctx\":512,\"threads\":1,\"mmap\":false}\n", "model", None),
    ] {
        stdin.write_all(input.as_bytes()).unwrap();
        stdin.flush().unwrap();
        line.clear();
        out.read_line(&mut line).unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ev"], "error", "{line}");
        assert_eq!(v["code"], code, "{line}");
        assert_eq!(v["id"].as_str(), id, "{line}");
    }
    drop(stdin);
    assert_eq!(wait(&mut child, Duration::from_secs(5)).expect("exits").code(), Some(0));
}

#[test]
fn closing_stdin_ends_it_at_once() {
    let mut child = spawn(&[]);
    std::thread::sleep(Duration::from_millis(200));
    let start = Instant::now();
    drop(child.stdin.take());
    let status = wait(&mut child, Duration::from_secs(5)).expect("exits");
    assert!(status.success());
    assert!(start.elapsed() < Duration::from_secs(1), "took {:?}", start.elapsed());
}

#[cfg(target_os = "linux")]
#[test]
fn a_parent_pid_that_is_not_the_parent_is_refused() {
    // Process 1 lives on and is never this helper's parent.
    let mut child = spawn(&["--parent-pid", "1"]);
    let mut out = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut out).unwrap();
    assert!(out.contains("is not this helper's parent"), "{out}");
    assert_eq!(wait(&mut child, Duration::from_secs(5)).expect("exits").code(), Some(1));
}
