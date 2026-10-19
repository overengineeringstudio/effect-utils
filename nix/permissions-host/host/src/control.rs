//! macos-app controller wire v1. This socket reports identity only; it never executes actions.
use crate::{Config, HostError};
use macos_app_security::{AuditToken, endpoint};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const FRAME_LIMIT: usize = 64 * 1024;
const MANIFEST_LIMIT: u64 = 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    #[serde(rename = "wireVersion")]
    wire_version: u32,
    action: String,
    args: BTreeMap<String, Value>,
}

// Action declarations remain controller-owned metadata, not executable capabilities.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    manifest_version: u32,
    generation: String,
    #[serde(rename = "actions")]
    _actions: BTreeMap<String, Value>,
    status_allowed_uids: Vec<u32>,
    socket_mode: u32,
}

fn manifest(pointer: &Path) -> Result<Manifest, HostError> {
    let invalid = || HostError::new("manifest", "Cannot read a valid selected generation manifest");
    // The pointer intentionally follows the controller's atomically selected generation.
    // O_NONBLOCK plus the regular-file check prevents a special file from blocking shutdown.
    let file = OpenOptions::new().read(true).custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(pointer.join("manifest.json")).map_err(|_| invalid())?;
    if !file.metadata().map_err(|_| invalid())?.is_file() { return Err(invalid()); }
    let mut bytes = Vec::new();
    file.take(MANIFEST_LIMIT + 1).read_to_end(&mut bytes).map_err(|_| invalid())?;
    if bytes.len() as u64 > MANIFEST_LIMIT { return Err(invalid()); }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if manifest.manifest_version != 1 || manifest.generation.is_empty()
        || manifest.generation.len() > 1024
        || ![0o600, 0o660, 0o666].contains(&manifest.socket_mode) {
        return Err(invalid());
    }
    Ok(manifest)
}

fn decode(bytes: &[u8]) -> Result<(), HostError> {
    let request: Request = serde_json::from_slice(bytes)
        .map_err(|_| HostError::new("invalidRequest", "Malformed controller request"))?;
    if request.wire_version != 1 {
        return Err(HostError::new("invalidRequest", "Unsupported wire version"));
    }
    if request.action != "status" {
        return Err(HostError::new("unknownAction", "Only status is supported"));
    }
    if !request.args.is_empty() {
        return Err(HostError::new("invalidArgs", "Status accepts no arguments"));
    }
    Ok(())
}

fn read_frame(stream: &mut UnixStream, deadline: Instant) -> Result<Vec<u8>, HostError> {
    let mut frame = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 4096];
    loop {
        let remaining = deadline.checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| HostError::new("requestTimeout", "Controller read deadline expired"))?;
        stream.set_read_timeout(Some(remaining))?;
        let count = stream.read(&mut buffer).map_err(|_| HostError::new("invalidRequest", "Incomplete controller frame"))?;
        if count == 0 { return Err(HostError::new("invalidRequest", "Incomplete controller frame")); }
        if frame.len() + count > FRAME_LIMIT {
            return Err(HostError::new("invalidRequest", "Controller frame exceeds 64 KiB"));
        }
        if let Some(newline) = buffer[..count].iter().position(|byte| *byte == b'\n') {
            if newline + 1 != count { return Err(HostError::new("invalidRequest", "Trailing controller data")); }
            frame.extend_from_slice(&buffer[..newline]);
            let mut extra = 0_u8;
            // SAFETY: recv only peeks into one valid byte on the live connected socket.
            if unsafe { libc::recv(stream.as_raw_fd(), (&mut extra as *mut u8).cast(), 1, libc::MSG_PEEK | libc::MSG_DONTWAIT) } > 0 {
                return Err(HostError::new("invalidRequest", "Only one controller request is allowed"));
            }
            return Ok(frame);
        }
        frame.extend_from_slice(&buffer[..count]);
    }
}

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SessionGetInfo(session: u32, id: *mut u32, attributes: *mut u32) -> i32;
}
fn session_kind(status: i32, attributes: u32) -> &'static str {
    if status != 0 || attributes & 0x0001 != 0 { "no-session" }
    else if attributes & 0x0010 != 0 { "gui" }
    else { "background-only" }
}
fn session() -> &'static str {
    let (mut id, mut attributes) = (0, 0);
    // SAFETY: callerSecuritySession requests this process; both output pointers are valid.
    let status = unsafe { SessionGetInfo(u32::MAX, &mut id, &mut attributes) };
    session_kind(status, attributes)
}

fn respond(stream: &mut UnixStream, pointer: &Path, uid: u32) -> Result<Value, HostError> {
    let deadline = Instant::now() + IO_TIMEOUT;
    let token = AuditToken::from_stream(stream)
        .map_err(|_| HostError::new("unauthorized", "Kernel peer credentials unavailable"))?;
    if token.real_uid() != uid || token.effective_uid() != uid {
        return Err(HostError::new("unauthorized", "Caller UID not allowed"));
    }
    decode(&read_frame(stream, deadline)?)?;
    // Refresh both generation and authorization from the same manifest on every call.
    let selected = manifest(pointer)?;
    if !selected.status_allowed_uids.contains(&uid) {
        return Err(HostError::new("unauthorized", "Caller UID not allowed"));
    }
    let hash = option_env!("HOST_SOURCE_HASH")
        .ok_or_else(|| HostError::new("hostIdentity", "No compiled host source hash"))?;
    Ok(json!({"wireVersion":1,"ok":true,"status":{
        "hostVersion":"1","hostSourceHash":hash,"generation":selected.generation,
        "pid":std::process::id(),"session":session()
    }}))
}

fn handle(stream: &mut UnixStream, pointer: &Path, uid: u32) -> Result<(), HostError> {
    let response = match respond(stream, pointer, uid) {
        Ok(response) => response,
        Err(error) => json!({"wireVersion":1,"ok":false,"error":{"code":error.code,"message":error.message}}),
    };
    let mut bytes = serde_json::to_vec(&response)
        .map_err(|_| HostError::new("operation-failed", "Controller response encoding failed"))?;
    if bytes.len() >= FRAME_LIMIT {
        return Err(HostError::new("operation-failed", "Controller response exceeds frame bound"));
    }
    bytes.push(b'\n');
    let deadline = Instant::now() + IO_TIMEOUT;
    let mut remaining = bytes.as_slice();
    while !remaining.is_empty() {
        let timeout = deadline.checked_duration_since(Instant::now()).filter(|timeout| !timeout.is_zero())
            .ok_or_else(|| HostError::new("requestTimeout", "Controller write deadline expired"))?;
        stream.set_write_timeout(Some(timeout))?;
        let count = stream.write(remaining)?;
        if count == 0 { return Err(HostError::new("operation-failed", "Controller peer closed")); }
        remaining = &remaining[count..];
    }
    Ok(())
}

/// Owns the controller thread and endpoint guard. Dropping cancels any active socket
/// before joining; an idle listener is nonblocking and explicitly unparked.
pub struct ControlServer {
    stop: Arc<AtomicBool>,
    active: Arc<Mutex<Option<UnixStream>>>,
    thread: Option<JoinHandle<()>>,
}
impl Drop for ControlServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(stream) = self.active.lock().as_ref() { let _ = stream.shutdown(Shutdown::Both); }
        if let Some(thread) = self.thread.take() {
            thread.thread().unpark();
            let _ = thread.join();
        }
    }
}

/// Start the distinct controller listener before entering the typed RPC server.
/// Retain this value until the typed server exits. No permission-bearing work runs here.
pub fn serve(socket: PathBuf, generation_pointer: PathBuf, config: &Config) -> Result<ControlServer, HostError> {
    if socket == config.socket {
        return Err(HostError::new("policy-denied", "Controller and typed RPC sockets must differ"));
    }
    let selected = manifest(&generation_pointer)?;
    let (listener, guard) = endpoint::bind(&socket, endpoint::EndpointPolicy {
        owner_uid: config.uid, socket_mode: selected.socket_mode,
    }).map_err(|_| HostError::new("policy-denied", "Controller endpoint unavailable or unsafe"))?;
    listener.set_nonblocking(true)?;
    let stop = Arc::new(AtomicBool::new(false));
    let active = Arc::new(Mutex::new(None::<UnixStream>));
    let stopped = Arc::clone(&stop);
    let connection = Arc::clone(&active);
    let uid = config.uid;
    let thread = thread::Builder::new().name("host-control".into()).spawn(move || {
        let _guard = guard;
        while !stopped.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let Ok(cancel) = stream.try_clone() else { continue; };
                    {
                        let mut current = connection.lock();
                        if stopped.load(Ordering::Acquire) { break; }
                        *current = Some(cancel);
                    }
                    let _ = handle(&mut stream, &generation_pointer, uid);
                    *connection.lock() = None;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::park_timeout(Duration::from_millis(20)),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
                Err(error) => { eprintln!("permissions-host controller listener failed: {error}"); break; }
            }
        }
    })?;
    Ok(ControlServer { stop, active, thread: Some(thread) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controller_accepts_only_empty_status_v1() {
        assert!(decode(br#"{"wireVersion":1,"action":"status","args":{}}"#).is_ok());
        for (request, code) in [
            (br#"{"wireVersion":2,"action":"status","args":{}}"#.as_slice(), "invalidRequest"),
            (br#"{"wireVersion":1,"action":"execute","args":{}}"#.as_slice(), "unknownAction"),
            (br#"{"wireVersion":1,"action":"status","args":{"path":"x"}}"#.as_slice(), "invalidArgs"),
            (br#"{"wireVersion":1,"action":"status","args":{},"extra":true}"#.as_slice(), "invalidRequest"),
        ] {
            assert_eq!(decode(request).unwrap_err().code, code);
        }
    }

    #[test]
    fn audit_session_matches_controller_contract() {
        assert_eq!(session_kind(0, 0x0010), "gui");
        assert_eq!(session_kind(0, 0x0020), "background-only");
        assert_eq!(session_kind(0, 0x0001 | 0x0010), "no-session");
        assert_eq!(session_kind(-1, 0x0010), "no-session");
    }
}
