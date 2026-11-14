//! Noninteractive, bounded SSH uptime reads for known tailnet peers only.
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::os::unix::{
    fs::{MetadataExt, OpenOptionsExt},
    net::UnixStream,
};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc::Sender,
    Arc,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::probe::ProbeEvent;
use nix::fcntl::{fcntl, FcntlArg, OFlag};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum State {
    #[default]
    Disabled,
    Pending,
    Failed(Failure),
    Boot(SystemTime),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    HostKey,
    Auth,
    Timeout,
    Unreachable,
    Failed,
    RemoteCommand,
    Unparseable,
    IdentityPermissions,
    IdentityUnsafe,
}

impl Failure {
    pub fn reason(self) -> &'static str {
        match self {
            Self::HostKey => "host key unknown",
            Self::Auth => "authentication denied",
            Self::Timeout => "timed out",
            Self::Unreachable => "unreachable",
            Self::Failed => "failed",
            Self::RemoteCommand => "remote command failed",
            Self::Unparseable => "unparseable output",
            Self::IdentityPermissions => {
                "identity key is group/world readable or writable; use chmod 600"
            }
            Self::IdentityUnsafe => {
                "identity path is unsafe or unreadable (symlinks are not allowed)"
            }
        }
    }
}

const DEADLINE: Duration = Duration::from_secs(8);
const REFRESH: Duration = Duration::from_secs(600);
const LIMIT: usize = 4096;
const REMOTE: &str = "cat /proc/uptime 2>/dev/null || sysctl -n kern.boottime";

/// Owns cancellation and final shutdown of an active SSH child.
pub struct Worker {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Worker {
    /// Signal cancellation immediately; final release waits for child reaping.
    pub fn cancel(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = &self.thread {
            thread.thread().unpark();
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.cancel();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn spawn(
    index: crate::target::TargetId,
    host: String,
    events: Sender<(crate::target::TargetId, ProbeEvent)>,
    wake: Arc<UnixStream>,
    stop: Arc<AtomicBool>,
) -> Worker {
    let worker_stop = Arc::new(AtomicBool::new(false));
    let local_stop = Arc::clone(&worker_stop);
    let thread = std::thread::spawn(move || {
        let stopped = || stop.load(Ordering::Relaxed) || local_stop.load(Ordering::Relaxed);
        let Some(status) = crate::tailnet::status() else {
            return;
        };
        // Select the peer's authenticated DNS name, never the user-supplied SSH target.
        let Some(peer) = status.peers.values().find(|peer| {
            let name = peer.dns_name.trim_end_matches('.');
            host.eq_ignore_ascii_case(name)
                || name
                    .split('.')
                    .next()
                    .is_some_and(|short| host.eq_ignore_ascii_case(short))
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| peer.ips.contains(&ip))
        }) else {
            return;
        };
        let target = peer.dns_name.trim_end_matches('.');
        if !valid_host(target) {
            return;
        }
        // Publish eligibility immediately; a slow SSH read cannot delay the placeholder.
        if !emit(index, State::Pending, &events, &wake) {
            return;
        }
        let user_known_hosts = user_known_hosts(target, &stopped);
        while !stopped() {
            let boot = read(
                target,
                &peer.ssh_host_keys,
                user_known_hosts.as_deref(),
                &stopped,
            )
            .map_or_else(State::Failed, State::Boot);
            if stopped() || !emit(index, boot, &events, &wake) {
                return;
            }
            std::thread::park_timeout(REFRESH);
        }
    });
    Worker {
        stop: worker_stop,
        thread: Some(thread),
    }
}

fn emit(
    index: crate::target::TargetId,
    state: State,
    events: &Sender<(crate::target::TargetId, ProbeEvent)>,
    wake: &UnixStream,
) -> bool {
    if events.send((index, ProbeEvent::Boot(state))).is_err() {
        return false;
    }
    let mut wake = wake;
    let _ = wake.write_all(&[1]);
    true
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && !host.starts_with('-')
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
}

/// Private per-read trust material; never changes the user's SSH files.
struct KnownHosts(PathBuf);

impl KnownHosts {
    fn create(host: &str, keys: &[String]) -> std::io::Result<Option<Self>> {
        Self::create_in(host, keys, &std::env::temp_dir())
    }

    fn create_in(
        host: &str,
        keys: &[String],
        directory: &std::path::Path,
    ) -> std::io::Result<Option<Self>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        if keys.is_empty() {
            return Ok(None);
        }
        if !valid_host(host) || !keys.iter().all(|key| valid_key(key)) {
            return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
        }
        loop {
            let path = directory.join(format!(
                "pingping-known-hosts-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            if !safe_path(&path.to_string_lossy()) {
                return Ok(None);
            }
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path);
            match file {
                Ok(mut file) => {
                    let guard = Self(path);
                    for key in keys {
                        writeln!(file, "{host} {key}")?;
                    }
                    return Ok(Some(guard));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
    }
}

impl Drop for KnownHosts {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn valid_key(key: &str) -> bool {
    let Some((kind, data)) = key.split_once(' ') else {
        return false;
    };
    kind.starts_with(|c: char| c.is_ascii_alphabetic())
        && kind
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'@' | b'.'))
        && !data.is_empty()
        && data
            .trim_end_matches('=')
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
        && data.len() - data.trim_end_matches('=').len() <= 2
        && !data.trim_end_matches('=').is_empty()
}

// OpenSSH parses and expands this list again when passed through -o. Skip the
// override rather than changing the interpretation of any configured path.
fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && !path
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '%' | '$' | '\\'))
}

fn identity_path(config: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    config
        .filter(|path| path.is_absolute())
        .or_else(|| home.map(|home| home.join(".config")))
        .map(|config| config.join("pingping/uptime_ed25519"))
}

fn trusted_owner(owner: u32, uid: u32) -> bool {
    owner == uid || owner == 0
}

fn trusted_directory(owner: u32, mode: u32, uid: u32) -> bool {
    trusted_owner(owner, uid) && mode & 0o022 == 0
}

/// Reject symlinks and mutable ancestors before handing the path to OpenSSH.
/// The key is opened without following a final symlink, including on races.
fn identity(path: &Path) -> Result<Option<PathBuf>, Failure> {
    let uid = nix::unistd::Uid::current().as_raw();
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_symlink() || !trusted_owner(metadata.uid(), uid) => {
            return Err(Failure::IdentityUnsafe);
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Failure::IdentityUnsafe),
    }
    for ancestor in path.ancestors().skip(1) {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata)
                if metadata.is_dir() && trusted_directory(metadata.uid(), metadata.mode(), uid) => {
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            _ => return Err(Failure::IdentityUnsafe),
        }
    }
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Failure::IdentityUnsafe),
    };
    let metadata = file.metadata().map_err(|_| Failure::IdentityUnsafe)?;
    if !metadata.is_file() || !trusted_owner(metadata.uid(), uid) {
        return Err(Failure::IdentityUnsafe);
    }
    if metadata.mode() & 0o077 != 0 {
        return Err(Failure::IdentityPermissions);
    }
    // -i still undergoes OpenSSH's percent/tilde expansion.
    if !path.to_str().is_some_and(safe_path) {
        return Err(Failure::IdentityUnsafe);
    }
    Ok(Some(path.to_owned()))
}

fn configured_identity() -> Result<Option<PathBuf>, Failure> {
    identity_path(
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
    )
    .map(|path| identity(&path))
    .transpose()
    .map(Option::flatten)
}

fn user_known_hosts(host: &str, stopped: &impl Fn() -> bool) -> Option<String> {
    if stopped() {
        return None;
    }
    let identity = configured_identity().ok()?;
    let child = command(host, None, identity.as_deref(), true)
        .spawn()
        .ok()?;
    // Effective SSH configuration is larger than the remote uptime response.
    let output = child_output(child, stopped, 64 * 1024).ok()?;
    configured_hosts(std::str::from_utf8(&output).ok()?)
}

fn configured_hosts(config: &str) -> Option<String> {
    let paths = config
        .lines()
        .find_map(|line| line.strip_prefix("userknownhostsfile "))?;
    let paths: Vec<_> = paths.split_whitespace().collect();
    // -G loses quoting around spaced paths; missing tokens must not hide revocations.
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    (!paths.is_empty()
        && paths.iter().all(|path| {
            safe_path(path)
                && (std::path::Path::new(path).is_file()
                    || [
                        home.join(".ssh/known_hosts"),
                        home.join(".ssh/known_hosts2"),
                    ]
                    .iter()
                    .any(|default| default == std::path::Path::new(path)))
        }))
    .then(|| paths.join(" "))
}

fn known_hosts_option(known_hosts: &KnownHosts, paths: &str) -> Option<String> {
    let path = known_hosts.0.to_str()?;
    (safe_path(path) && paths.split(' ').all(safe_path))
        .then(|| format!("UserKnownHostsFile={path} {paths}"))
}

fn command(
    host: &str,
    known_hosts: Option<&str>,
    identity: Option<&Path>,
    config: bool,
) -> Command {
    let mut command = Command::new("ssh");
    if config {
        command.arg("-G");
    }
    command.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=3",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "IdentityAgent=none",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
    ]);
    if let Some(known_hosts) = known_hosts {
        command.arg("-o").arg(known_hosts);
    }
    if let Some(identity) = identity {
        command
            .arg("-i")
            .arg(identity)
            .args(["-o", "IdentitiesOnly=yes"]);
    }
    command
        .args([host, REMOTE])
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped());
    command
}

fn read(
    host: &str,
    keys: &[String],
    paths: Option<&str>,
    stopped: &impl Fn() -> bool,
) -> Result<SystemTime, Failure> {
    if stopped() {
        return Err(Failure::Failed);
    }
    let known_hosts = paths
        .filter(|paths| paths.split(' ').all(safe_path))
        .map(|_| KnownHosts::create(host, keys))
        .transpose()
        .map_err(|_| Failure::Failed)?
        .flatten();
    let option = known_hosts
        .as_ref()
        .zip(paths)
        .and_then(|(known_hosts, paths)| known_hosts_option(known_hosts, paths));
    let identity = configured_identity()?;
    let child = command(host, option.as_deref(), identity.as_deref(), false)
        .spawn()
        .map_err(|_| Failure::Failed)?;
    read_child(child, stopped)
}

fn classify(status: std::process::ExitStatus, stderr: &[u8]) -> Failure {
    // SSH reserves 255 for transport/auth failures; other failures are remote.
    if status.code().is_some_and(|code| code != 255) {
        return Failure::RemoteCommand;
    }
    let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if text.contains("host key verification failed")
        || text.contains("no ed25519 host key is known")
        || text.contains("remote host identification has changed")
    {
        Failure::HostKey
    } else if text.contains("permission denied") || text.contains("authentication failed") {
        Failure::Auth
    } else if text.contains("timed out") || text.contains("timeout") {
        Failure::Timeout
    } else if [
        "no route to host",
        "network is unreachable",
        "connection refused",
        "could not resolve hostname",
        "connection closed",
        "connection reset",
    ]
    .iter()
    .any(|message| text.contains(message))
    {
        Failure::Unreachable
    } else {
        Failure::Failed
    }
}

/// Drain only up to the bound per poll so either pipe cannot starve cancellation.
fn drain(pipe: &mut impl Read, output: &mut Vec<u8>, limit: usize) -> Result<(), Failure> {
    let mut buffer = [0_u8; 1024];
    for _ in 0..=limit / buffer.len() {
        match pipe.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                if output.len() + n > limit {
                    return Err(Failure::Failed);
                }
                output.extend_from_slice(&buffer[..n]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(_) => return Err(Failure::Failed),
        }
    }
    Ok(())
}

fn read_child(child: Child, stopped: &impl Fn() -> bool) -> Result<SystemTime, Failure> {
    let output = child_output(child, stopped, LIMIT)?;
    parse(
        std::str::from_utf8(&output).map_err(|_| Failure::Unparseable)?,
        SystemTime::now(),
    )
    .ok_or(Failure::Unparseable)
}

fn child_output(
    mut child: Child,
    stopped: &impl Fn() -> bool,
    limit: usize,
) -> Result<Vec<u8>, Failure> {
    let result = (|| {
        let mut stdout = child.stdout.take().ok_or(Failure::Failed)?;
        let mut stderr = child.stderr.take().ok_or(Failure::Failed)?;
        fcntl(&stdout, FcntlArg::F_SETFL(OFlag::O_NONBLOCK)).map_err(|_| Failure::Failed)?;
        fcntl(&stderr, FcntlArg::F_SETFL(OFlag::O_NONBLOCK)).map_err(|_| Failure::Failed)?;
        let start = Instant::now();
        let mut output = Vec::new();
        let mut errors = Vec::new();
        loop {
            if stopped() {
                return Err(Failure::Failed);
            }
            if start.elapsed() >= DEADLINE {
                return Err(Failure::Timeout);
            }
            drain(&mut stdout, &mut output, limit)?;
            drain(&mut stderr, &mut errors, LIMIT)?;
            if let Some(status) = child.try_wait().map_err(|_| Failure::Failed)? {
                drain(&mut stdout, &mut output, limit)?;
                drain(&mut stderr, &mut errors, LIMIT)?;
                if !status.success() {
                    return Err(classify(status, &errors));
                }
                return Ok(output);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn parse(text: &str, now: SystemTime) -> Option<SystemTime> {
    let text = text.trim();
    if let Some(rest) = text.strip_prefix("{ sec = ") {
        let secs: u64 = rest.split(',').next()?.trim().parse().ok()?;
        let boot = UNIX_EPOCH.checked_add(Duration::from_secs(secs))?;
        return (boot <= now).then_some(boot);
    }
    let up: f64 = text.split_whitespace().next()?.parse().ok()?;
    now.checked_sub(Duration::try_from_secs_f64(up).ok()?)
}

#[cfg(test)]
mod tests {
    #[test]
    fn identity_ancestors_require_trusted_ownership_and_no_shared_writes() {
        let uid = 1000;
        assert!(trusted_directory(uid, 0o755, uid));
        assert!(trusted_directory(0, 0o755, uid));
        assert!(!trusted_directory(1001, 0o755, uid));
        assert!(!trusted_owner(1001, uid));
        for owner in [0, uid, 1001] {
            for mode in [0o1777, 0o1775, 0o775, 0o757] {
                assert!(!trusted_directory(owner, mode, uid));
            }
        }
    }

    #[test]
    fn dedicated_identity_path_and_arguments() {
        let home = PathBuf::from("/home/example");
        let fallback = home.join(".config/pingping/uptime_ed25519");
        assert_eq!(
            identity_path(None, Some(home.clone())),
            Some(fallback.clone())
        );
        assert_eq!(
            identity_path(Some(PathBuf::new()), Some(home)),
            Some(fallback)
        );
        let path = identity_path(Some("/config".into()), None).unwrap();
        assert_eq!(path, Path::new("/config/pingping/uptime_ed25519"));
        let command = command("example.ts.net", None, Some(&path), false);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect();
        assert_eq!(
            &args[14..18],
            [
                "-i",
                "/config/pingping/uptime_ed25519",
                "-o",
                "IdentitiesOnly=yes"
            ]
        );
        assert!(args.contains(&"IdentityAgent=none"));
        assert!(args.contains(&"BatchMode=yes"));
        assert!(args.contains(&"StrictHostKeyChecking=yes"));
    }

    #[test]
    fn identity_refuses_permissions_and_symlinks() {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap())
            .canonicalize()
            .unwrap();
        let file = KnownHosts::create_in("example.ts.net", &["ssh-ed25519 AAAA".into()], &home)
            .unwrap()
            .unwrap();
        let path = file.0.canonicalize().unwrap();
        assert_eq!(identity(&path), Ok(Some(path.clone())));
        for mode in [0o640, 0o604, 0o620] {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            assert_eq!(identity(&path), Err(Failure::IdentityPermissions));
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = path.with_extension("symlink");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert_eq!(identity(&link), Err(Failure::IdentityUnsafe));
        std::fs::remove_file(&link).unwrap();
        let parent_link = path.with_extension("directory-symlink");
        std::os::unix::fs::symlink(path.parent().unwrap(), &parent_link).unwrap();
        assert_eq!(
            identity(&parent_link.join(path.file_name().unwrap())),
            Err(Failure::IdentityUnsafe)
        );
        std::fs::remove_file(&parent_link).unwrap();
        drop(file);
        assert_eq!(identity(&path), Ok(None));
    }

    #[test]
    fn discovery_uses_the_read_arguments_including_remote_command() {
        let discovery = command("example.ts.net", None, None, true);
        let read = command("example.ts.net", None, None, false);
        let args: Vec<_> = discovery.get_args().collect();
        assert_eq!(args[0], "-G");
        assert_eq!(args[1..], read.get_args().collect::<Vec<_>>());
        let child = match command("example.ts.net", None, None, true).spawn() {
            Ok(child) => child,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => panic!("ssh -G failed: {error}"),
        };
        let output = child_output(child, &|| false, 64 * 1024).unwrap();
        assert!(std::str::from_utf8(&output)
            .unwrap()
            .lines()
            .any(|line| line.starts_with("userknownhostsfile ")));
    }

    #[test]
    fn discovery_output_is_bounded_and_hung_children_time_out() {
        for (limit, expected) in [(64 * 1024, Ok(32768)), (LIMIT, Err(Failure::Failed))] {
            let child = Command::new("sh")
                .args(["-c", "printf '%32768s' x"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            assert_eq!(
                child_output(child, &|| false, limit).map(|bytes| bytes.len()),
                expected
            );
        }
        let child = Command::new("sleep")
            .arg("60")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let pid = child.id();
        assert_eq!(
            child_output(child, &|| false, 64 * 1024),
            Err(Failure::Timeout)
        );
        assert!(!Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .unwrap()
            .status
            .success());
    }

    #[test]
    fn unsafe_paths_skip_the_temporary_trust_file() {
        for path in [
            "/tmp/100%/",
            "/tmp/quoted\"/",
            "/tmp/${HOME}/",
            "/tmp/back\\slash/",
            "/tmp/single'/",
            "/tmp/with space/",
        ] {
            assert!(KnownHosts::create_in(
                "host-a.example.ts.net",
                &["ssh-ed25519 AAAA".into()],
                std::path::Path::new(path),
            )
            .unwrap()
            .is_none());
            assert!(configured_hosts(&format!("userknownhostsfile {path}\n")).is_none());
        }
    }

    #[test]
    fn openssh_preserves_configured_trust_files_after_temporary_file() {
        let custom = KnownHosts::create("example.ts.net", &["ssh-ed25519 AAAA".into()])
            .unwrap()
            .unwrap();
        let revoked = KnownHosts::create("example.ts.net", &["ssh-ed25519 AAAA".into()])
            .unwrap()
            .unwrap();
        let configured = format!(
            "UserKnownHostsFile={} {}",
            custom.0.display(),
            revoked.0.display()
        );
        let output = match Command::new("ssh")
            .args(["-G", "-o", &configured, "example.ts.net", REMOTE])
            .output()
        {
            Ok(output) => output,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => panic!("ssh -G failed: {error}"),
        };
        assert!(output.status.success());
        let paths = configured_hosts(std::str::from_utf8(&output.stdout).unwrap()).unwrap();
        assert_eq!(
            paths,
            format!("{} {}", custom.0.display(), revoked.0.display())
        );
        let file = KnownHosts::create("example.ts.net", &["ssh-ed25519 AAAA".into()])
            .unwrap()
            .unwrap();
        let option = known_hosts_option(&file, &paths).unwrap();
        let output = Command::new("ssh")
            .args([
                "-G",
                "-o",
                &option,
                "-o",
                &configured,
                "example.ts.net",
                REMOTE,
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        let effective = configured_hosts(std::str::from_utf8(&output.stdout).unwrap()).unwrap();
        assert_eq!(effective, format!("{} {paths}", file.0.display()));
    }

    #[test]
    fn missing_configured_file_disables_override_but_stock_defaults_are_allowed() {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        let defaults = format!(
            "{} {}",
            home.join(".ssh/known_hosts").display(),
            home.join(".ssh/known_hosts2").display()
        );
        assert_eq!(
            configured_hosts(&format!("userknownhostsfile {defaults}\n")),
            Some(defaults.clone())
        );
        let missing =
            std::env::temp_dir().join(format!("pingping-missing-trust-{}", std::process::id()));
        assert!(!missing.exists());
        assert!(configured_hosts(&format!(
            "userknownhostsfile {defaults} {}\n",
            missing.display()
        ))
        .is_none());
    }

    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn known_hosts_are_private_formatted_and_removed() {
        let keys = vec![
            "ssh-ed25519 AAAA==".into(),
            "ecdsa-sha2-nistp256 BBBB".into(),
        ];
        let file = KnownHosts::create("host-a.example.ts.net", &keys)
            .unwrap()
            .unwrap();
        let path = file.0.clone();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "host-a.example.ts.net ssh-ed25519 AAAA==\nhost-a.example.ts.net ecdsa-sha2-nistp256 BBBB\n"
        );
        drop(file);
        assert!(!path.exists());
        assert!(KnownHosts::create("host-a.example.ts.net", &[])
            .unwrap()
            .is_none());
    }

    #[test]
    fn rejects_malformed_keys() {
        for key in [
            "",
            "ssh-ed25519",
            "ssh-ed25519 AAAA\nother AAAA",
            "ssh-ed25519 AAAA comment",
            "ssh-ed25519\tAAAA",
            "ssh-ed25519 A=AA",
            "ssh-ed25519 AAAA===",
            "ssh-ed25519 ====",
            "@cert-authority AAAA",
        ] {
            assert!(
                KnownHosts::create("host-a.example.ts.net", &[key.into()]).is_err(),
                "{key:?}"
            );
        }
    }

    #[test]
    fn classifies_ssh_failures() {
        for (message, reason) in [
            (
                "No ED25519 host key is known for host-a.example.ts.net and you have requested strict checking.\r\nHost key verification failed.",
                Failure::HostKey,
            ),
            (
                "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!",
                Failure::HostKey,
            ),
            (
                "user@host-a.example.ts.net: Permission denied (publickey).",
                Failure::Auth,
            ),
            ("Authentication failed.", Failure::Auth),
            (
                "ssh: connect to host host-a.example.ts.net port 22: Operation timed out",
                Failure::Timeout,
            ),
            (
                "ssh: connect to host host-a.example.ts.net port 22: No route to host",
                Failure::Unreachable,
            ),
            (
                "ssh: connect to host host-a.example.ts.net port 22: Connection refused",
                Failure::Unreachable,
            ),
            ("remote command failed", Failure::Failed),
        ] {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(
                classify(
                    std::process::ExitStatus::from_raw(255 << 8),
                    message.as_bytes()
                ),
                reason
            );
        }
    }

    #[test]
    fn failed_child_reports_stderr_and_success_requires_valid_output() {
        for (script, expected) in [
            (
                "printf 'Permission denied' >&2; exit 255",
                Err(Failure::Auth),
            ),
            ("printf invalid", Err(Failure::Unparseable)),
            ("exit 1", Err(Failure::RemoteCommand)),
        ] {
            let child = Command::new("sh")
                .args(["-c", script])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            assert_eq!(read_child(child, &|| false), expected);
        }
    }

    #[test]
    fn shutdown_kills_and_reaps_an_active_child() {
        let mut command = Command::new("sleep");
        command
            .arg("60")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command.spawn().unwrap();
        let pid = child.id();
        let stop = Arc::new(AtomicBool::new(false));
        let run_stop = Arc::new(AtomicBool::new(false));
        let reader_run_stop = Arc::clone(&run_stop);
        let reader_stop = Arc::clone(&stop);
        let (ready, started) = std::sync::mpsc::channel();
        let worker = Worker {
            stop,
            thread: Some(std::thread::spawn(move || {
                ready.send(()).unwrap();
                assert_eq!(
                    child_output(
                        child,
                        &|| {
                            reader_stop.load(Ordering::Relaxed)
                                || reader_run_stop.load(Ordering::Relaxed)
                        },
                        64 * 1024,
                    ),
                    Err(Failure::Failed)
                );
            })),
        };
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        let start = Instant::now();
        drop(worker);
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(
            !run_stop.load(Ordering::Relaxed),
            "cancelling one uptime worker must not stop its peers"
        );
        assert!(
            !Command::new("kill")
                .args(["-0", &pid.to_string()])
                .output()
                .unwrap()
                .status
                .success(),
            "shutdown must reap the child, not just terminate it"
        );
    }

    #[test]
    fn shutdown_interrupts_refresh_sleep() {
        let stop = Arc::new(AtomicBool::new(false));
        let sleeper_stop = Arc::clone(&stop);
        let (ready, started) = std::sync::mpsc::channel();
        let worker = Worker {
            stop,
            thread: Some(std::thread::spawn(move || {
                ready.send(()).unwrap();
                while !sleeper_stop.load(Ordering::Relaxed) {
                    std::thread::park_timeout(REFRESH);
                }
            })),
        };
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        let start = Instant::now();
        drop(worker);
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn parses_linux_uptime() {
        let now = UNIX_EPOCH + Duration::from_secs(10_000);
        assert_eq!(
            parse("100.5 200.0\n", now),
            Some(now - Duration::from_millis(100_500))
        );
    }

    #[test]
    fn ssh_arguments_never_request_interactive_authentication() {
        let command = command("host-a.example.ts.net", None, None, false);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect();
        assert_eq!(command.get_program(), "ssh");
        assert_eq!(
            args,
            [
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=3",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "LogLevel=ERROR",
                "-o",
                "IdentityAgent=none",
                "-o",
                "PasswordAuthentication=no",
                "-o",
                "KbdInteractiveAuthentication=no",
                "host-a.example.ts.net",
                REMOTE
            ]
        );
        let file = KnownHosts::create("host-a.example.ts.net", &["ssh-ed25519 AAAA".into()])
            .unwrap()
            .unwrap();
        let option =
            known_hosts_option(&file, "/tmp/configured-known-hosts /tmp/other-known-hosts")
                .unwrap();
        let command = super::command("host-a.example.ts.net", Some(&option), None, false);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect();
        assert_eq!(
            args[15],
            format!(
                "UserKnownHostsFile={} /tmp/configured-known-hosts /tmp/other-known-hosts",
                file.0.display()
            )
        );
    }

    #[test]
    fn parses_macos_boot_time() {
        let now = UNIX_EPOCH + Duration::from_secs(2_000_000_000);
        assert_eq!(
            parse("{ sec = 1794000123, usec = 0 } Fri Nov 6", now),
            Some(UNIX_EPOCH + Duration::from_secs(1_794_000_123))
        );
    }

    #[test]
    fn rejects_invalid_and_future_times() {
        for text in [
            "garbage",
            "-1",
            "NaN",
            "inf",
            "1e300",
            "{ sec = 20000, usec = 0 }",
        ] {
            assert_eq!(parse(text, UNIX_EPOCH + Duration::from_secs(10_000)), None);
        }
    }
}
