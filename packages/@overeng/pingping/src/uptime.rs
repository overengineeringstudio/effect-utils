//! Noninteractive, bounded SSH uptime reads for known tailnet peers only.
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::os::unix::{fs::OpenOptionsExt, net::UnixStream};
use std::path::PathBuf;
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
}

impl Failure {
    pub fn reason(self) -> &'static str {
        match self {
            Self::HostKey => "host key unknown",
            Self::Auth => "auth refused",
            Self::Timeout => "timed out",
            Self::Unreachable => "unreachable",
            Self::Failed => "failed",
        }
    }
}

const DEADLINE: Duration = Duration::from_secs(8);
const REFRESH: Duration = Duration::from_secs(600);
const LIMIT: usize = 4096;
const REMOTE: &str = "cat /proc/uptime 2>/dev/null || sysctl -n kern.boottime";

/// Owns shutdown: interrupt refresh sleep, then cancel and reap an active SSH child.
pub struct Worker {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            thread.thread().unpark();
            let _ = thread.join();
        }
    }
}

pub fn spawn(
    index: usize,
    host: String,
    events: Sender<(usize, ProbeEvent)>,
    wake: Arc<UnixStream>,
    stop: Arc<AtomicBool>,
) -> Worker {
    let worker_stop = Arc::clone(&stop);
    let thread = std::thread::spawn(move || {
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
        while !stop.load(Ordering::Relaxed) {
            let boot =
                read(target, &peer.ssh_host_keys, &stop).map_or_else(State::Failed, State::Boot);
            if stop.load(Ordering::Relaxed) || !emit(index, boot, &events, &wake) {
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
    index: usize,
    state: State,
    events: &Sender<(usize, ProbeEvent)>,
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
        static NEXT: AtomicU64 = AtomicU64::new(0);
        if keys.is_empty() {
            return Ok(None);
        }
        if !valid_host(host) || !keys.iter().all(|key| valid_key(key)) {
            return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
        }
        loop {
            let path = std::env::temp_dir().join(format!(
                "pingping-known-hosts-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
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

fn command(host: &str, known_hosts: Option<&KnownHosts>) -> Command {
    let mut command = Command::new("ssh");
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
        // OpenSSH expands ~ in its space-separated UserKnownHostsFile list.
        // Quote the temporary filename to support temp directories containing spaces.
        command.arg("-o").arg(format!(
            "UserKnownHostsFile=\"{}\" ~/.ssh/known_hosts ~/.ssh/known_hosts2",
            known_hosts.0.display()
        ));
    }
    command
        .args([host, REMOTE])
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped());
    command
}

fn read(host: &str, keys: &[String], stop: &AtomicBool) -> Result<SystemTime, Failure> {
    if stop.load(Ordering::Relaxed) {
        return Err(Failure::Failed);
    }
    let known_hosts = KnownHosts::create(host, keys).map_err(|_| Failure::Failed)?;
    let child = command(host, known_hosts.as_ref())
        .spawn()
        .map_err(|_| Failure::Failed)?;
    read_child(child, stop)
}

fn classify(stderr: &[u8]) -> Failure {
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
fn drain(pipe: &mut impl Read, output: &mut Vec<u8>) -> Result<(), Failure> {
    let mut buffer = [0_u8; 1024];
    for _ in 0..=LIMIT / buffer.len() {
        match pipe.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                if output.len() + n > LIMIT {
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

fn read_child(mut child: Child, stop: &AtomicBool) -> Result<SystemTime, Failure> {
    let result = (|| {
        let mut stdout = child.stdout.take().ok_or(Failure::Failed)?;
        let mut stderr = child.stderr.take().ok_or(Failure::Failed)?;
        fcntl(&stdout, FcntlArg::F_SETFL(OFlag::O_NONBLOCK)).map_err(|_| Failure::Failed)?;
        fcntl(&stderr, FcntlArg::F_SETFL(OFlag::O_NONBLOCK)).map_err(|_| Failure::Failed)?;
        let start = Instant::now();
        let mut output = Vec::new();
        let mut errors = Vec::new();
        loop {
            if stop.load(Ordering::Relaxed) {
                return Err(Failure::Failed);
            }
            if start.elapsed() >= DEADLINE {
                return Err(Failure::Timeout);
            }
            drain(&mut stdout, &mut output)?;
            drain(&mut stderr, &mut errors)?;
            if let Some(status) = child.try_wait().map_err(|_| Failure::Failed)? {
                drain(&mut stdout, &mut output)?;
                drain(&mut stderr, &mut errors)?;
                if !status.success() {
                    return Err(classify(&errors));
                }
                return parse(
                    std::str::from_utf8(&output).map_err(|_| Failure::Failed)?,
                    SystemTime::now(),
                )
                .ok_or(Failure::Failed);
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
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "host-a.example.ts.net ssh-ed25519 AAAA==\nhost-a.example.ts.net ecdsa-sha2-nistp256 BBBB\n");
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
            ("No ED25519 host key is known for host-a.example.ts.net and you have requested strict checking.\r\nHost key verification failed.", Failure::HostKey),
            ("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!", Failure::HostKey),
            ("user@host-a.example.ts.net: Permission denied (publickey).", Failure::Auth),
            ("Authentication failed.", Failure::Auth),
            ("ssh: connect to host host-a.example.ts.net port 22: Operation timed out", Failure::Timeout),
            ("ssh: connect to host host-a.example.ts.net port 22: No route to host", Failure::Unreachable),
            ("ssh: connect to host host-a.example.ts.net port 22: Connection refused", Failure::Unreachable),
            ("remote command failed", Failure::Failed),
        ] {
            assert_eq!(classify(message.as_bytes()), reason);
        }
    }

    #[test]
    fn failed_child_reports_stderr_and_success_requires_valid_output() {
        for (script, expected) in [
            (
                "printf 'Permission denied' >&2; exit 255",
                Err(Failure::Auth),
            ),
            ("printf invalid", Err(Failure::Failed)),
        ] {
            let child = Command::new("sh")
                .args(["-c", script])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            assert_eq!(read_child(child, &AtomicBool::new(false)), expected);
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
        let reader_stop = Arc::clone(&stop);
        let (ready, started) = std::sync::mpsc::channel();
        let worker = Worker {
            stop,
            thread: Some(std::thread::spawn(move || {
                ready.send(()).unwrap();
                assert_eq!(read_child(child, &reader_stop), Err(Failure::Failed));
            })),
        };
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        let start = Instant::now();
        drop(worker);
        assert!(start.elapsed() < Duration::from_secs(2));
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
        let command = command("host-a.example.ts.net", None);
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
        let command = super::command("host-a.example.ts.net", Some(&file));
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect();
        assert_eq!(
            args[15],
            format!(
                "UserKnownHostsFile=\"{}\" ~/.ssh/known_hosts ~/.ssh/known_hosts2",
                file.0.display()
            )
        );
    }

    #[test]
    fn parses_macos_boot_time() {
        let now = UNIX_EPOCH + Duration::from_secs(2_000_000_000);
        assert_eq!(
            parse("{ sec = 1790835536, usec = 727691 } Thu Oct 1", now),
            Some(UNIX_EPOCH + Duration::from_secs(1_790_835_536))
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
