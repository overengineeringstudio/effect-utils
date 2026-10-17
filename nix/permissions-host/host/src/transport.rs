use crate::{Host, HostError, failure};
use macos_app_security::{AuditToken, endpoint};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
use std::time::{Duration, Instant};

const REQUEST_LIMIT: usize = 64 * 1024;
const RESPONSE_LIMIT: usize = 1024 * 1024;
fn read_frame(stream: &mut UnixStream) -> Result<Vec<u8>, HostError> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut frame = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 4096];
    loop {
        let left = deadline.checked_duration_since(Instant::now()).ok_or_else(|| HostError::new("deadline-exceeded", "Frame deadline exceeded"))?;
        stream.set_read_timeout(Some(left))?;
        let count = stream.read(&mut buffer).map_err(|_| HostError::new("invalid-request", "Incomplete request frame"))?;
        if count == 0 { return Err(HostError::new("invalid-request", "Incomplete request frame")); }
        if frame.len() + count > REQUEST_LIMIT { return Err(HostError::new("invalid-request", "Request exceeds 64 KiB")); }
        if let Some(newline) = buffer[..count].iter().position(|b| *b == b'\n') {
            if newline + 1 != count { return Err(HostError::new("invalid-request", "Trailing request data")); }
            frame.extend_from_slice(&buffer[..newline]);
            // Reject already pending second frames without blocking on a client waiting for response.
            let mut extra = [0_u8; 1];
            // SAFETY: recv writes at most one byte to a valid buffer; no ancillary descriptors are received.
            if unsafe { libc::recv(stream.as_raw_fd(), extra.as_mut_ptr().cast(), 1, libc::MSG_PEEK | libc::MSG_DONTWAIT) } > 0 { return Err(HostError::new("invalid-request", "Multiple requests are forbidden")); }
            return Ok(frame);
        }
        frame.extend_from_slice(&buffer[..count]);
    }
}
fn peer(stream: &UnixStream, uid: u32) -> Result<Value, HostError> {
    let token = AuditToken::from_stream(stream).map_err(|_| HostError::new("caller-denied", "Kernel peer audit token unavailable"))?;
    if token.effective_uid() != uid || token.real_uid() != uid { return Err(HostError::new("caller-denied", "Caller real and effective UIDs must match host")); }
    let mut path = [0_i8; 4096];
    // SAFETY: proc_pidpath writes at most buffer length; PID is kernel-captured, never request supplied.
    let length = unsafe { libc::proc_pidpath(token.pid() as i32, path.as_mut_ptr().cast(), path.len() as u32) };
    let executable = if length > 0 {
        // SAFETY: successful proc_pidpath yields a NUL-terminated path in the supplied buffer.
        json!({"path":unsafe { std::ffi::CStr::from_ptr(path.as_ptr()) }.to_string_lossy(),"unavailableReason":null})
    } else { json!({"path":null,"unavailableReason":"kernel executable lookup unavailable"}) };
    Ok(json!({"auditToken":token.0,"pid":token.pid(),"pidVersion":token.pid_version(),"realUid":token.real_uid(),"effectiveUid":token.effective_uid(),"executable":executable}))
}
struct Admission(Arc<AtomicUsize>);
impl Drop for Admission { fn drop(&mut self) { self.0.fetch_sub(1, Ordering::AcqRel); } }
pub fn serve(host: Arc<Host>) -> Result<(), HostError> {
    let (listener, _guard) = endpoint::bind(&host.config.socket, endpoint::EndpointPolicy { owner_uid: host.config.uid, socket_mode: 0o600 }).map_err(|_| HostError::new("policy-denied", "Socket endpoint unavailable or unsafe"))?;
    let active = Arc::new(AtomicUsize::new(0));
fn disconnected(stream: &UnixStream) -> bool {
    let mut descriptor = libc::pollfd { fd: stream.as_raw_fd(), events: libc::POLLIN, revents: 0 };
    // SAFETY: poll receives one live descriptor record and does not retain it.
    if unsafe { libc::poll(&mut descriptor, 1, 0) } < 0 { return true; }
    if descriptor.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 { return true; }
    if descriptor.revents & libc::POLLIN != 0 {
        let mut byte = 0_u8;
        // EOF cancels; extra input violates the one-request connection contract.
        return unsafe { libc::recv(stream.as_raw_fd(), (&mut byte as *mut u8).cast(), 1, libc::MSG_PEEK | libc::MSG_DONTWAIT) } >= 0;
    }
    false
}
    for incoming in listener.incoming() {
        let mut stream = incoming?;
        if active.fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| (n < 32).then_some(n + 1)).is_err() { continue; }
        let admission = Admission(Arc::clone(&active));
        let host = Arc::clone(&host);
        std::thread::spawn(move || {
            let _admission = admission;
            let observed = peer(&stream, host.config.uid);
            let response = match observed {
                Ok(peer) => {
                    let frame = read_frame(&mut stream);
                    host.respond(frame, peer, &|| disconnected(&stream))
                },
                Err(error) => host.respond(Err(error), json!({"unavailableReason":"peer admission failed"}), &|| true),
            };
            let response = serde_json::to_vec(&response).unwrap_or_default();
            let mut bytes = if response.len() < RESPONSE_LIMIT { response } else { serde_json::to_vec(&failure(None, HostError::new("operation-failed", "Response bound exceeded"))).unwrap_or_default() };
            bytes.push(b'\n');
            let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
            let _ = stream.write_all(&bytes);
        });
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_second_frame() {
        let (mut input, mut output) = UnixStream::pair().unwrap();
        output.write_all(b"{}\n{}\n").unwrap();
        assert!(read_frame(&mut input).is_err());
    }
    #[test] fn rejects_oversize_frame() {
        let (mut input, mut output) = UnixStream::pair().unwrap();
        let sender = std::thread::spawn(move || { let _ = output.write_all(&vec![b'x'; REQUEST_LIMIT + 1]); });
        assert!(read_frame(&mut input).is_err());
        drop(input); sender.join().unwrap();
    }
    #[test] fn accepts_one_frame() {
        let (mut input, mut output) = UnixStream::pair().unwrap();
        output.write_all(b"{}\n").unwrap();
        assert_eq!(read_frame(&mut input).unwrap(), b"{}");
    }
}
