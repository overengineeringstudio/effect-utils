//! ICMP echo over unprivileged datagram sockets (`SOCK_DGRAM` + `IPPROTO_ICMP{,V6}`).
//!
//! Platform differences this module absorbs:
//! - Linux rewrites the echo identifier to the socket's local port and filters
//!   replies per socket. Access is gated by `net.ipv4.ping_group_range`.
//! - macOS keeps our identifier, delivers echo replies to every ICMP datagram
//!   socket, and prefixes IPv4 replies with the IP header.
//!
//! Replies are therefore matched by a per-host random token in the payload, not
//! by the identifier.

use std::io::{self, Read};
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::os::fd::{AsFd, BorrowedFd};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use nix::poll::{poll, PollFd, PollFlags, PollTimeout};
use socket2::{Domain, Protocol, Socket, Type};

const ECHO_REQUEST_V4: u8 = 8;
const ECHO_REPLY_V4: u8 = 0;
const ECHO_REQUEST_V6: u8 = 128;
const ECHO_REPLY_V6: u8 = 129;
const HEADER_LEN: usize = 8;
/// Same default payload size as `ping` (56 bytes, 64 bytes on the wire).
const PAYLOAD_LEN: usize = 56;

pub struct EchoSocket {
    socket: UdpSocket,
    target: SocketAddr,
    ident: u16,
    token: u64,
}

pub enum Receive {
    Reply(u16),
    Idle,
    Stopped,
}

#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    /// The OS refuses unprivileged ICMP sockets for this user.
    NotPermitted(String),
    Other(String),
}

impl EchoSocket {
    pub fn open(addr: IpAddr, token: u64) -> Result<Self, OpenError> {
        let (domain, protocol) = match addr {
            IpAddr::V4(_) => (Domain::IPV4, Protocol::ICMPV4),
            IpAddr::V6(_) => (Domain::IPV6, Protocol::ICMPV6),
        };
        let socket =
            Socket::new(domain, Type::DGRAM, Some(protocol)).map_err(|err| match err.kind() {
                io::ErrorKind::PermissionDenied => OpenError::NotPermitted(err.to_string()),
                _ => OpenError::Other(err.to_string()),
            })?;
        // A datagram socket fd is all `UdpSocket` needs for `send_to`/`recv`;
        // this keeps the receive path free of `MaybeUninit` handling.
        let socket = UdpSocket::from(socket);
        socket
            .set_nonblocking(true)
            .map_err(|err| OpenError::Other(err.to_string()))?;
        Ok(Self {
            socket,
            target: SocketAddr::new(addr, 0),
            #[allow(
                clippy::cast_possible_truncation,
                reason = "any 16 bits of the token work as identifier"
            )]
            ident: token as u16,
            token,
        })
    }

    pub fn send(&self, seq: u16) -> io::Result<()> {
        let packet = encode_request(self.target.is_ipv4(), self.ident, seq, self.token);
        self.socket.send_to(&packet, self.target).map(|_| ())
    }

    /// Waits until a datagram, the scheduled deadline, or worker cancellation.
    /// The socket stays nonblocking so readiness races cannot delay shutdown.
    pub fn recv(&self, deadline: Instant, interrupt: &UnixStream) -> io::Result<Receive> {
        match wait_readable(self.socket.as_fd(), interrupt, deadline)? {
            Readiness::Stopped => return Ok(Receive::Stopped),
            Readiness::Deadline => return Ok(Receive::Idle),
            Readiness::Ready => {}
        }
        let mut buf = [0u8; 2048];
        let (len, from) = self.socket.recv_from(&mut buf)?;
        if from.ip() != self.target.ip() {
            return Ok(Receive::Idle);
        }
        Ok(decode_reply(&buf[..len], self.target.is_ipv4(), self.token)
            .map_or(Receive::Idle, Receive::Reply))
    }
}

enum Readiness {
    Ready,
    Deadline,
    Stopped,
}

/// Rounds positive waits up to poll's millisecond precision, avoiding early
/// deadline wakeups. Very long waits are split only at poll's platform limit.
fn poll_timeout(wait: Duration) -> PollTimeout {
    PollTimeout::try_from(wait.as_nanos().div_ceil(1_000_000)).unwrap_or(PollTimeout::MAX)
}

fn wait_readable(
    socket: BorrowedFd<'_>,
    interrupt: &UnixStream,
    deadline: Instant,
) -> io::Result<Readiness> {
    let mut fds = [
        PollFd::new(socket, PollFlags::POLLIN),
        PollFd::new(interrupt.as_fd(), PollFlags::POLLIN),
    ];
    loop {
        let wait = deadline.saturating_duration_since(Instant::now());
        if wait.is_zero() {
            return Ok(Readiness::Deadline);
        }
        match poll(&mut fds, poll_timeout(wait)) {
            Ok(_) => {
                // Prioritize shutdown even if a reply becomes ready with it.
                // A rate change writes a byte; shutdown closes the endpoint.
                if fds[1].any().unwrap_or(false) {
                    let mut interrupt = interrupt;
                    let mut bytes = [0; 256];
                    return match interrupt.read(&mut bytes) {
                        Ok(0) => Ok(Readiness::Stopped),
                        Ok(_) => Ok(Readiness::Deadline),
                        Err(err) => Err(err),
                    };
                }
                if fds[0].any().unwrap_or(false) {
                    return Ok(Readiness::Ready);
                }
            }
            Err(nix::errno::Errno::EINTR) => {}
            Err(err) => return Err(err.into()),
        }
    }
}

pub fn encode_request(
    ipv4: bool,
    ident: u16,
    seq: u16,
    token: u64,
) -> [u8; HEADER_LEN + PAYLOAD_LEN] {
    let mut packet = [0u8; HEADER_LEN + PAYLOAD_LEN];
    packet[0] = if ipv4 {
        ECHO_REQUEST_V4
    } else {
        ECHO_REQUEST_V6
    };
    packet[4..6].copy_from_slice(&ident.to_be_bytes());
    packet[6..8].copy_from_slice(&seq.to_be_bytes());
    packet[8..16].copy_from_slice(&token.to_be_bytes());
    // ICMPv6 checksums cover a pseudo-header and are always filled in by the kernel.
    if ipv4 {
        let sum = checksum(&packet);
        packet[2..4].copy_from_slice(&sum.to_be_bytes());
    }
    packet
}

pub fn decode_reply(datagram: &[u8], ipv4: bool, token: u64) -> Option<u16> {
    let icmp = if ipv4 && datagram.first().is_some_and(|b| b >> 4 == 4) {
        // macOS includes the IPv4 header; Linux does not.
        let header_len = usize::from(datagram[0] & 0x0f) * 4;
        datagram.get(header_len..)?
    } else {
        datagram
    };
    let reply_type = if ipv4 { ECHO_REPLY_V4 } else { ECHO_REPLY_V6 };
    if icmp.len() < HEADER_LEN + 8 || icmp[0] != reply_type {
        return None;
    }
    let reply_token = u64::from_be_bytes(icmp[8..16].try_into().ok()?);
    (reply_token == token).then(|| u16::from_be_bytes([icmp[6], icmp[7]]))
}

fn checksum(data: &[u8]) -> u16 {
    let mut sum: u32 = data
        .chunks(2)
        .map(|pair| u32::from(u16::from_be_bytes([pair[0], *pair.get(1).unwrap_or(&0)])))
        .sum();
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    #[allow(clippy::cast_possible_truncation, reason = "folded to 16 bits above")]
    !(sum as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn as_reply(
        mut packet: [u8; HEADER_LEN + PAYLOAD_LEN],
        ipv4: bool,
    ) -> [u8; HEADER_LEN + PAYLOAD_LEN] {
        packet[0] = if ipv4 { ECHO_REPLY_V4 } else { ECHO_REPLY_V6 };
        packet
    }

    #[test]
    fn checksum_of_encoded_v4_packet_verifies_to_zero() {
        let packet = encode_request(true, 0x1234, 7, 0xdead_beef_cafe_f00d);
        assert_eq!(checksum(&packet), 0);
    }

    #[test]
    fn decodes_linux_style_reply_without_ip_header() {
        let reply = as_reply(encode_request(true, 1, 42, 99), true);
        assert_eq!(decode_reply(&reply, true, 99), Some(42));
    }

    #[test]
    fn decodes_macos_style_reply_with_ip_header() {
        let mut datagram = vec![0x45u8];
        datagram.extend([0u8; 19]);
        datagram.extend(as_reply(encode_request(true, 1, 3, 5), true));
        assert_eq!(decode_reply(&datagram, true, 5), Some(3));
    }

    #[test]
    fn rejects_foreign_token_and_requests() {
        let reply = as_reply(encode_request(true, 1, 3, 5), true);
        assert_eq!(decode_reply(&reply, true, 6), None);
        assert_eq!(decode_reply(&encode_request(true, 1, 3, 5), true, 5), None);
    }

    #[test]
    fn poll_waits_round_up_and_never_become_infinite() {
        assert_eq!(poll_timeout(Duration::ZERO), PollTimeout::ZERO);
        assert_eq!(poll_timeout(Duration::from_nanos(1)).as_millis(), Some(1));
        assert_eq!(
            poll_timeout(Duration::from_micros(1_001)).as_millis(),
            Some(2)
        );
        assert_eq!(
            poll_timeout(Duration::from_secs(30)).as_millis(),
            Some(30_000)
        );
        assert_eq!(poll_timeout(Duration::MAX), PollTimeout::MAX);
    }

    #[test]
    fn decodes_v6_reply() {
        let reply = as_reply(encode_request(false, 1, 9, 5), false);
        assert_eq!(decode_reply(&reply, false, 5), Some(9));
    }
}
