// Optional fresh, fixed-command evidence. This module grants no root authority.
use std::fs;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::process::{Command, Stdio};

const VERSION: &str = "pnpm-store-evidence-v1";
const COMMAND: Option<&str> = option_env!("PNPM_GC_PROCESS_EVIDENCE_COMMAND");

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
    let errors = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.take(4097).read_to_end(&mut bytes).map(|_| bytes)
    });
    let mut bytes = Vec::new();
    let read = stdout.take(257).read_to_end(&mut bytes);
    if read.is_err() || bytes.len() > 256 { let _ = child.kill(); }
    let status = child.wait().map_err(|error| error.to_string())?;
    let errors = errors.join().map_err(|_| "process evidence stderr reader failed")?
        .map_err(|error| error.to_string())?;
    read.map_err(|error| error.to_string())?;
    if !status.success() || bytes.len() > 256 || errors.len() > 4096 {
        return Err("process evidence command failed or exceeded output bounds".into());
    }
    Ok(bytes)
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
