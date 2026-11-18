// Optional fresh, fixed-command evidence. This module grants no root authority.
use std::fs;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::process::{Command, Stdio};

const VERSION: &str = "pnpm-store-evidence-v1";
const COMMAND: Option<&str> = option_env!("PNPM_GC_PROCESS_EVIDENCE_COMMAND");

pub(super) fn configured() -> bool { COMMAND.is_some() }

pub(super) enum Failure {
    Active(String),
    Incomplete(String),
}

pub(super) fn classify(result: Result<(), String>, active: bool) -> Result<(), Failure> {
    result.map_err(|message| if active { Failure::Active(message) } else { Failure::Incomplete(message) })
}

fn validate(bytes: &[u8], nonce: &str, device: u64, inode: u64, start: &str) -> Result<(), String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "non-UTF8 process evidence")?;
    let fields: Vec<_> = text.strip_suffix('\n').ok_or("unterminated process evidence")?.split('\t').collect();
    if fields.len() != 7 || fields[0] != VERSION || fields[1] != nonce
        || fields[2] != device.to_string() || fields[3] != inode.to_string()
        || fields[4] != "absent" || fields[6] != start || fields[5].len() != 64
        || !fields[5].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("process evidence scope or verdict mismatch".into());
    }
    Ok(())
}

pub(super) fn prove(root: &Path, directory: &fs::File, lease: Option<&fs::File>) -> Result<(), String> {
    let command = COMMAND.ok_or("no fixed process evidence command configured")?;
    let lease = lease.ok_or("process evidence requires the held exclusive maintenance lease")?;
    // Rootless UID0 and namespaced root-owned paths are not host-root authority.
    let mapping = fs::read_to_string("/proc/self/uid_map").map_err(|error| error.to_string())?;
    if mapping.split_whitespace().collect::<Vec<_>>() != ["0", "0", "4294967295"] {
        return Err("process evidence requires the initial host user namespace".into());
    }
    let stat = fs::read_to_string("/proc/self/stat").map_err(|error| error.to_string())?;
    let start = stat.rsplit_once(')').ok_or("invalid client stat")?.1
        .split_whitespace().nth(19).ok_or("missing client start time")?;
    let mut random = [0u8; 16];
    fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut random))
        .map_err(|error| error.to_string())?;
    use std::fmt::Write;
    let mut nonce = String::with_capacity(32);
    for byte in random { write!(&mut nonce, "{byte:02x}").expect("writing to String"); }
    let metadata = directory.metadata().map_err(|error| error.to_string())?;
    let bytes = run(command, &[
        std::ffi::OsStr::new("--pnpm-store-evidence-v1"), root.as_os_str(),
        std::ffi::OsStr::new(&metadata.dev().to_string()), std::ffi::OsStr::new(&metadata.ino().to_string()),
        std::ffi::OsStr::new(&directory.as_raw_fd().to_string()), std::ffi::OsStr::new(&lease.as_raw_fd().to_string()),
        std::ffi::OsStr::new(&nonce), std::ffi::OsStr::new(start),
    ])?;
    validate(&bytes, &nonce, metadata.dev(), metadata.ino(), start)
}

fn run(command: &str, args: &[&std::ffi::OsStr]) -> Result<Vec<u8>, String> {
    let mut child = Command::new(command).args(args)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|error| format!("fixed process evidence command: {error}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    // Drain both pipes concurrently. Neither a full stderr pipe nor a privileged
    // descendant retaining a pipe may block the collector indefinitely.
    let (send, receive) = std::sync::mpsc::channel();
    fn reader<R: Read + Send + 'static>(pipe: R, limit: u64, output: bool,
        send: std::sync::mpsc::Sender<(bool, Result<Vec<u8>, String>)>) {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.take(limit + 1).read_to_end(&mut bytes)
                .map_err(|error| error.to_string()).and_then(|_| {
                    if bytes.len() as u64 > limit { Err("process evidence output limit".into()) }
                    else { Ok(bytes) }
                });
            let _ = send.send((output, result));
        });
    }
    reader(stdout, 256, true, send.clone());
    reader(stderr, 4096, false, send);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let result = (|| {
        let mut output = Vec::new();
        for _ in 0..2 {
            let (is_output, bytes) = receive.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .map_err(|_| "process evidence command timed out")?;
            let bytes = bytes?;
            if is_output { output = bytes; }
        }
        loop {
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                return if status.success() { Ok(output) } else { Err("process evidence command failed".into()) };
            }
            if std::time::Instant::now() >= deadline { return Err("process evidence command timed out".into()); }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.try_wait();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_protocol_scope_and_verdict() {
        let nonce = "a".repeat(32);
        let digest = "b".repeat(64);
        let valid = format!("{VERSION}\t{nonce}\t32\t123\tabsent\t{digest}\t456\n");
        assert!(validate(valid.as_bytes(), &nonce, 32, 123, "456").is_ok());
        for invalid in [valid.replace("absent", "unknown"), valid.replace("\t123\t", "\t124\t"),
            valid.replace("\t456\n", "\t457\n"), valid.replace(&digest, &"B".repeat(64)),
            format!("{valid}extra\n"), valid.trim_end().into(), valid.replace(&nonce, &"c".repeat(32))] {
            assert!(validate(invalid.as_bytes(), &nonce, 32, 123, "456").is_err());
        }
    }

    #[test]
    fn native_veto_is_structured_not_text_classification() {
        assert!(matches!(classify(Err("permission denied".into()), true), Err(Failure::Active(_))));
        assert!(matches!(classify(Err("live process".into()), false), Err(Failure::Incomplete(_))));
        assert!(classify(Ok(()), false).is_ok());
    }

    #[test]
    fn nonprivileged_command_bounds_and_exit_status() {
        let invoke = |script: &str| run("/bin/sh", &[std::ffi::OsStr::new("-c"), std::ffi::OsStr::new(script)]);
        assert_eq!(invoke("printf 'fixture\\n'").unwrap(), b"fixture\n");
        assert!(invoke("printf 'fixture\\n'; exit 1").is_err());
        assert!(invoke("i=0; while [ \"$i\" -lt 257 ]; do printf x; i=$((i+1)); done").is_err());
        assert!(invoke("i=0; while [ \"$i\" -lt 4097 ]; do printf x >&2; i=$((i+1)); done").is_err());
    }
}
