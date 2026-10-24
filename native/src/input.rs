//! Commands from the app on stdin, read on a thread of their own.

use std::io::{self, BufRead};
use std::sync::mpsc::{self, Receiver};

use crate::output;
use crate::protocol::{self, Command};

pub enum Input {
    Command(Command),
    Invalid(String),
    /// stdin closed: the app closed it or died. Either way, finish up.
    Eof,
}

pub fn spawn_stdin_reader() -> Receiver<Input> {
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new().name("stdin".into()).spawn(move || {
        let stdin = io::stdin();
        let mut lock = stdin.lock();
        let mut line = Vec::new();
        loop {
            line.clear();
            match lock.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(Input::Eof);
                    return;
                }
                Ok(_) => {
                    let text = String::from_utf8_lossy(&line);
                    let text = text.trim();
                    if text.is_empty() {
                        continue;
                    }
                    let input = match protocol::parse_command(text) {
                        Ok(c) => Input::Command(c),
                        Err(e) => Input::Invalid(e),
                    };
                    if tx.send(input).is_err() {
                        return;
                    }
                }
            }
        }
    });
    if spawned.is_err() {
        output::log("could not start the stdin reader; only closing the process stops it");
    }
    rx
}
