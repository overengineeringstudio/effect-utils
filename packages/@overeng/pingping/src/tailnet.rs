//! Bounded, process-free Tailscale status shared by completion and path notes.
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::IpAddr;
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use nix::fcntl::{fcntl, FcntlArg, OFlag};
use serde::Deserialize;

const LIMIT: usize = 4 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_millis(100);
const SOCKET: &str = "/var/run/tailscale/tailscaled.sock";

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Status {
    #[serde(rename = "Self")]
    pub self_peer: Option<Peer>,
    #[serde(rename = "Peer")]
    pub peers: BTreeMap<String, Peer>,
    #[serde(rename = "ExitNodeStatus")]
    pub exit_node: Option<ExitNodeStatus>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct ExitNodeStatus {}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
pub struct Peer {
    #[serde(rename = "DNSName")]
    pub dns_name: String,
    #[serde(rename = "TailscaleIPs")]
    pub ips: Vec<IpAddr>,
    #[serde(rename = "sshHostKeys")]
    pub ssh_host_keys: Vec<String>,
    pub online: bool,
    pub active: bool,
    pub cur_addr: String,
    pub relay: String,
    #[allow(
        clippy::struct_field_names,
        reason = "Tailscale PeerRelay is distinct from DERP Relay"
    )]
    pub peer_relay: String,
}

pub fn status() -> Option<Status> {
    let start = Instant::now();
    let connect = (|| {
        let socket = socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None)?;
        socket.connect_timeout(&socket2::SockAddr::unix(SOCKET)?, DEADLINE)?;
        let descriptor: std::os::fd::OwnedFd = socket.into();
        Ok::<_, std::io::Error>(UnixStream::from(descriptor))
    })();
    match connect {
        Ok(mut stream) => {
            stream
                .set_write_timeout(Some(DEADLINE.checked_sub(start.elapsed())?))
                .ok()?;
            stream.write_all(b"GET /localapi/v0/status?peers=true HTTP/1.0\r\nHost: local-tailscaled.sock\r\n\r\n").ok()?;
            let mut bytes = Vec::new();
            let mut buffer = [0; 8192];
            loop {
                let remaining = DEADLINE.checked_sub(start.elapsed())?;
                stream.set_read_timeout(Some(remaining)).ok()?;
                let count = stream.read(&mut buffer).ok()?;
                if count == 0 {
                    break;
                }
                if bytes.len() + count > LIMIT {
                    return None;
                }
                bytes.extend_from_slice(&buffer[..count]);
            }
            parse_http(&bytes)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => cli_status(start),
        Err(_) => None,
    }
}

fn parse_http(bytes: &[u8]) -> Option<Status> {
    let split = bytes.windows(4).position(|part| part == b"\r\n\r\n")?;
    let headers = std::str::from_utf8(&bytes[..split]).ok()?;
    let mut lines = headers.split("\r\n");
    let mut status = lines.next()?.split_whitespace();
    if !matches!(status.next()?, "HTTP/1.0" | "HTTP/1.1") || status.next()? != "200" {
        return None;
    }
    // HTTP/1.0 requests do not negotiate chunking. Refuse an unexpected encoding.
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("transfer-encoding")
                && !value.trim().eq_ignore_ascii_case("identity")
            {
                return None;
            }
            if key.eq_ignore_ascii_case("content-length")
                && value.trim().parse::<usize>().ok()? != bytes.len() - split - 4
            {
                return None;
            }
        }
    }
    serde_json::from_slice(&bytes[split + 4..]).ok()
}

fn cli_status(start: Instant) -> Option<Status> {
    let mut child = Command::new("tailscale")
        .args(["status", "--json"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    let result = (|| {
        let mut stdout = child.stdout.take()?;
        let flags = OFlag::from_bits_truncate(fcntl(&stdout, FcntlArg::F_GETFL).ok()?);
        fcntl(&stdout, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK)).ok()?;
        let mut bytes = Vec::new();
        let mut buffer = [0; 8192];
        loop {
            if start.elapsed() >= DEADLINE {
                return None;
            }
            match stdout.read(&mut buffer) {
                Ok(0) => {
                    if let Some(exit) = child.try_wait().ok()? {
                        return exit
                            .success()
                            .then(|| serde_json::from_slice(&bytes).ok())
                            .flatten();
                    }
                }
                Ok(count) => {
                    if bytes.len() + count > LIMIT {
                        return None;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                    continue;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => return None,
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_advertised_ssh_host_keys() {
        let peer: Peer = serde_json::from_str(
            r#"{"DNSName":"host-a.example.ts.net.","sshHostKeys":["ssh-ed25519 AAAA"]}"#,
        )
        .unwrap();
        assert_eq!(peer.ssh_host_keys, ["ssh-ed25519 AAAA"]);
        assert!(serde_json::from_str::<Peer>("{}")
            .unwrap()
            .ssh_host_keys
            .is_empty());
    }

    #[test]
    fn http_status_and_framing() {
        let expected = Status::default();
        assert_eq!(
            parse_http(b"HTTP/1.0 200 OK\r\nContent-Length: 11\r\n\r\n{\"Peer\":{}}"),
            Some(expected.clone())
        );
        assert_eq!(
            parse_http(b"HTTP/1.1 200 OK\r\n\r\n{\"Peer\":{}}"),
            Some(expected)
        );
        for response in [
            b"HTTP/1.0 403 Forbidden\r\n\r\n{}".as_slice(),
            b"HTTP/1.0 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n",
            b"HTTP/1.0 200 OK\r\nContent-Length: 99\r\n\r\n{}",
            b"garbage",
        ] {
            assert_eq!(parse_http(response), None);
        }
    }
}
