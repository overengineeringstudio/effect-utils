use std::io::{self, Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use super::linux;

pub fn decode(executable: &str, filter: &'static str, input: Vec<u8>, deadline: Instant) -> io::Result<Vec<u8>> {
    run(executable, &["--exit-status", "--raw-output", "--compact-output", filter], Some(input), deadline)
}

/// Callers supply only compile-bound immutable executables and literal
/// metadata arguments. This is not an API for caller-selected commands.
pub fn metadata(executable: &str, args: &[&str], deadline: Instant) -> io::Result<Vec<u8>> {
    run(executable, args, None, deadline)
}

fn run(executable: &str, args: &[&str], input: Option<Vec<u8>>, deadline: Instant) -> io::Result<Vec<u8>> {
    if input.as_ref().is_some_and(|bytes| bytes.len() > 8 * 1024 * 1024) {
        return Err(io::Error::other("fixed command input bound"));
    }
    let mut command = Command::new(executable);
    command.args(args).env_clear().env("LC_ALL", "C")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::piped());
    linux::bind_child_lifetime(&mut command);
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let (send, receive) = mpsc::channel();
    let has_input = input.is_some();
    if let Some(input) = input {
        let mut stdin = child.stdin.take().expect("piped stdin");
        let writer = send.clone();
        std::thread::spawn(move || {
            let result = stdin.write_all(&input).map(|_| Vec::new());
            drop(stdin);
            let _ = writer.send((0_u8, result));
        });
    }
    fn reader<R: Read + Send + 'static>(pipe: R, limit: usize, kind: u8,
        send: mpsc::Sender<(u8, io::Result<Vec<u8>>)>) {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.take((limit + 1) as u64).read_to_end(&mut bytes).and_then(|_| {
                if bytes.len() > limit { Err(io::Error::other("fixed command output bound")) }
                else { Ok(bytes) }
            });
            let _ = send.send((kind, result));
        });
    }
    reader(stdout, 256 * 1024, 1, send.clone());
    reader(stderr, 4096, 2, send);
    let result = (|| {
        let mut output = Vec::new();
        let mut received = [!has_input, false, false];
        let completion_count = if has_input { 3 } else { 2 };
        for _ in 0..completion_count {
            let (kind, bytes) = receive.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "fixed command deadline"))?;
            let bytes = bytes?;
            let slot = received.get_mut(kind as usize).ok_or_else(|| io::Error::other("fixed command channel kind"))?;
            if *slot {
                return Err(io::Error::other("duplicate fixed command completion"));
            }
            *slot = true;
            if kind == 1 { output = bytes; }
        }
        loop {
            if let Some(status) = child.try_wait()? {
                if !status.success() || output.is_empty() || !output.ends_with(b"\n") {
                    return Err(io::Error::other("fixed metadata command refused input"));
                }
                return Ok(output);
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "fixed command exit deadline"));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

/// Decode jq @tsv's escaping exactly before checking the admitted path grammar;
/// opening an escaped spelling would refer to the wrong object.
pub fn fields(line: &str) -> io::Result<Vec<String>> {
    line.split('\t').map(|field| {
        let mut output = String::with_capacity(field.len());
        let mut characters = field.chars();
        while let Some(character) = characters.next() {
            if character != '\\' {
                output.push(character);
                continue;
            }
            output.push(match characters.next() {
                Some('t') => '\t', Some('n') => '\n', Some('r') => '\r', Some('\\') => '\\',
                _ => return Err(io::Error::other("invalid fixed decoder TSV escape")),
            });
        }
        if output.contains('\0') {
            return Err(io::Error::other("NUL in decoded field"));
        }
        Ok(output)
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_tsv_before_path_admission() {
        assert_eq!(fields("a\\tb\tc\\\\d").unwrap(), ["a\tb", "c\\d"]);
        assert!(fields("bad\\q").is_err());
        assert!(fields("bad\\").is_err());
    }
}
