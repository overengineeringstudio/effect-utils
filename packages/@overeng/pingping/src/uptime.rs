//! Noninteractive, bounded SSH uptime reads for known tailnet peers only.
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::sync::{mpsc::Sender, Arc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::probe::ProbeEvent;
use nix::fcntl::{fcntl, FcntlArg, OFlag};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum State {
    #[default]
    Disabled,
    Unavailable,
    Boot(SystemTime),
}

const DEADLINE: Duration = Duration::from_secs(8);
const REFRESH: Duration = Duration::from_secs(600);
const REMOTE: &str = "cat /proc/uptime 2>/dev/null || sysctl -n kern.boottime";

pub fn spawn(
    index: usize,
    host: String,
    events: Sender<(usize, ProbeEvent)>,
    wake: Arc<UnixStream>,
) {
    std::thread::spawn(move || {
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
        if target.is_empty() || target.starts_with('-') {
            return;
        }
        // Publish eligibility immediately; a slow SSH read cannot delay the placeholder.
        if !emit(index, ProbeEvent::Boot(None), &events, &wake) {
            return;
        }
        loop {
            let boot = read(target);
            if !emit(index, ProbeEvent::Boot(boot), &events, &wake) {
                return;
            }
            std::thread::sleep(REFRESH);
        }
    });
}

fn emit(
    index: usize,
    event: ProbeEvent,
    events: &Sender<(usize, ProbeEvent)>,
    wake: &UnixStream,
) -> bool {
    if events.send((index, event)).is_err() {
        return false;
    }
    let mut wake = wake;
    let _ = wake.write_all(&[1]);
    true
}

fn command(host: &str) -> Command {
    let mut command = Command::new("ssh");
    command
        .args([
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
            host,
            REMOTE,
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped());
    command
}

fn read(host: &str) -> Option<SystemTime> {
    let mut child = command(host).spawn().ok()?;
    // Nonblocking bounded output prevents a malicious or broken remote from filling the pipe.
    let result = (|| {
        let mut stdout = child.stdout.take()?;
        fcntl(&stdout, FcntlArg::F_SETFL(OFlag::O_NONBLOCK)).ok()?;
        let start = Instant::now();
        let mut output = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            match stdout.read(&mut buffer) {
                Ok(n) => output.extend_from_slice(&buffer[..n]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => return None,
            }
            if output.len() > 4096 {
                return None;
            }
            if let Some(status) = child.try_wait().ok()? {
                if !status.success() {
                    return None;
                }
                // Drain bytes written immediately before the process exited.
                loop {
                    match stdout.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => output.extend_from_slice(&buffer[..n]),
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(_) => return None,
                    }
                    if output.len() > 4096 {
                        return None;
                    }
                }
                return parse(std::str::from_utf8(&output).ok()?, SystemTime::now());
            }
            if start.elapsed() >= DEADLINE {
                return None;
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
        let command = command("host-a.example.ts.net");
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
                REMOTE,
            ]
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
