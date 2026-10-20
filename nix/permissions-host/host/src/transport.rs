use crate::{ActionRequired, Config, Host, HostError};
use macos_app_security::{AuditToken, CompiledRequirement, PeerPolicy, authenticate_peer, endpoint};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant};
mod managed;

const REQUEST_LIMIT: usize = 64 * 1024;
const RESPONSE_LIMIT: usize = 1024 * 1024;
static STOPPING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role { Supervisor, GuiAgent }

/// Reject standalone launches before they can expose either role's endpoints.
pub fn verify_managed_role(role: Role) -> Result<(), HostError> {
    managed::identity()?.check_self(role)
}

/// Both directions admit only the target UID and the release-pinned outer code identity.
/// No client-provided identity, PID-only lookup, or weaker fallback is used.
pub struct GuiChannel {
    path: PathBuf, uid: u32, requirement: CompiledRequirement,
    policy_revision: String, release_revision: String,
}
impl GuiChannel {
    pub fn new(config: &Config, path: PathBuf) -> Result<Self, HostError> {
        if path == config.socket { return Err(HostError::new("policy-denied", "Public and private endpoints must differ")); }
        let requirement = CompiledRequirement::compile(&config.host_requirement)
            .map_err(|_| HostError::new("policy-denied", "Pinned host requirement is invalid"))?;
        Ok(Self { path, uid: config.uid, requirement,
            policy_revision: config.policy_revision.clone(), release_revision: config.release_revision.clone() })
    }
    fn authenticate(&self, stream: &UnixStream, expected_role: Role) -> Result<macos_app_security::AuthenticatedPeer, HostError> {
        let peer = authenticate_peer(stream, PeerPolicy { allowed_uids: &[self.uid], requirement: &self.requirement })
            .map_err(|_| HostError::new("caller-denied", "Private peer UID or pinned code identity denied"))?;
        managed::identity()?.authenticate(peer.token(), expected_role)?;
        Ok(peer)
    }
    pub fn call(&self, request: &Value, cancelled: &dyn Fn() -> bool) -> Result<Value, HostError> {
        if cancelled() || STOPPING.load(Ordering::Acquire) { return Err(HostError::new("cancelled", "Request cancelled")); }
        let mut stream = UnixStream::connect(&self.path)
            .map_err(|_| HostError::new("session-unavailable", "Authenticated GUI agent is unavailable"))?;
        let peer = self.authenticate(&stream, Role::GuiAgent)?;
        peer.recheck_freshness().map_err(|_| HostError::new("caller-denied", "Private peer incarnation changed"))?;
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Envelope<'a> { wire_version: u32, policy_revision: &'a str, release_revision: &'a str, request: &'a Value }
        write_frame(&mut stream, &Envelope { wire_version: 1, policy_revision: &self.policy_revision,
            release_revision: &self.release_revision, request }, REQUEST_LIMIT)?;
        let bytes = read_bounded_frame(&mut stream, RESPONSE_LIMIT, Duration::from_secs(65), cancelled)?;
        peer.recheck_freshness().map_err(|_| HostError::new("caller-denied", "Private peer incarnation changed"))?;
        self.authenticate(&stream, Role::GuiAgent)?;
        decode_private_response(&bytes, &self.policy_revision, &self.release_revision)
    }
}

fn decode_private_request(bytes: &[u8], policy_revision: &str, release_revision: &str) -> Result<Value, HostError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Envelope { wire_version: u32, policy_revision: String, release_revision: String, request: Value }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| HostError::new("invalid-request", "Malformed private release envelope"))?;
    if envelope.wire_version != 1 { return Err(HostError::new("invalid-request", "Unsupported private request version")); }
    if envelope.policy_revision != policy_revision || envelope.release_revision != release_revision {
        return Err(HostError::new("gui-release-mismatch", "Private peers must select the same policy and release revisions"));
    }
    Ok(envelope.request)
}

fn decode_private_response(bytes: &[u8], policy_revision: &str, release_revision: &str) -> Result<Value, HostError> {
    let response: Value = serde_json::from_slice(bytes).map_err(|_| HostError::new("operation-failed", "Malformed private response"))?;
    if response["policyRevision"].as_str() != Some(policy_revision) || response["releaseRevision"].as_str() != Some(release_revision) {
        return Err(HostError::new("gui-release-mismatch", "GUI response does not match the selected policy and release revisions"));
    }
    let object = response.as_object().ok_or_else(|| HostError::new("operation-failed", "Malformed private response"))?;
    let success = response["ok"].as_bool().ok_or_else(|| HostError::new("operation-failed", "Malformed private outcome"))?;
    if object.keys().any(|key| !["wireVersion", "policyRevision", "releaseRevision", "ok", "result", "error"].contains(&key.as_str()))
        || (success && (!object.contains_key("result") || object.contains_key("error")))
        || (!success && (!response["error"].is_object() || object.contains_key("result"))) {
        return Err(HostError::new("operation-failed", "Malformed private outcome"));
    }
    if response["wireVersion"] != 1 { return Err(HostError::new("operation-failed", "Unsupported private response")); }
    if response["ok"] == true {
        return response.get("result").cloned().ok_or_else(|| HostError::new("operation-failed", "Missing private result"));
    }
    Err(private_error(&response["error"]))
}

pub(crate) fn private_error(value: &Value) -> HostError {
    let code = match value["code"].as_str() {
        Some("permission-required") => "permission-required", Some("session-unavailable") => "session-unavailable",
        Some("policy-denied") => "policy-denied", Some("invalid-request") => "invalid-request",
        Some("busy") => "busy", Some("cancelled") => "cancelled", Some("caller-denied") => "caller-denied",
        Some("deadline-exceeded") => "deadline-exceeded", Some("audit-unavailable") => "audit-unavailable",
        Some("gui-release-mismatch") => "gui-release-mismatch",
        _ => "operation-failed",
    };
    let mut error = HostError::new(code, value["message"].as_str().unwrap_or("GUI operation failed"));
    if let (Some(category), Some(next_step)) = (value["actionRequired"]["category"].as_str(), value["actionRequired"]["nextStep"].as_str()) {
        error.action_required = Some(ActionRequired { category: category.into(), next_step: next_step.into() });
    }
    error
}

fn read_bounded_frame(stream: &mut UnixStream, limit: usize, timeout: Duration, cancelled: &dyn Fn() -> bool) -> Result<Vec<u8>, HostError> {
    let deadline = Instant::now() + timeout;
    let mut frame = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 4096];
    loop {
        if cancelled() || STOPPING.load(Ordering::Acquire) { return Err(HostError::new("cancelled", "Request cancelled")); }
        let left = deadline.checked_duration_since(Instant::now()).ok_or_else(|| HostError::new("deadline-exceeded", "Frame deadline exceeded"))?;
        stream.set_read_timeout(Some(left.min(Duration::from_millis(100))))?;
        let count = match stream.read(&mut buffer) {
            Ok(count) => count,
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted) => continue,
            Err(_) => return Err(HostError::new("invalid-request", "Incomplete frame")),
        };
        if count == 0 { return Err(HostError::new("invalid-request", "Incomplete frame")); }
        if frame.len() + count > limit { return Err(HostError::new("invalid-request", "Frame exceeds byte bound")); }
        if let Some(newline) = buffer[..count].iter().position(|b| *b == b'\n') {
            if newline + 1 != count { return Err(HostError::new("invalid-request", "Trailing frame data")); }
            frame.extend_from_slice(&buffer[..newline]);
            let mut extra = [0_u8; 1];
            // SAFETY: recv peeks at most one byte into a live buffer without receiving descriptors.
            if unsafe { libc::recv(stream.as_raw_fd(), extra.as_mut_ptr().cast(), 1, libc::MSG_PEEK | libc::MSG_DONTWAIT) } > 0 { return Err(HostError::new("invalid-request", "Multiple frames are forbidden")); }
            return Ok(frame);
        }
        frame.extend_from_slice(&buffer[..count]);
    }
}
fn read_frame(stream: &mut UnixStream) -> Result<Vec<u8>, HostError> {
    read_bounded_frame(stream, REQUEST_LIMIT, Duration::from_secs(5), &|| false)
}
fn write_frame(stream: &mut UnixStream, value: &impl serde::Serialize, limit: usize) -> Result<(), HostError> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| HostError::new("operation-failed", "Frame encoding failed"))?;
    if bytes.len() >= limit { return Err(HostError::new("operation-failed", "Response bound exceeded")); }
    bytes.push(b'\n');
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    stream.write_all(&bytes)?;
    Ok(())
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
fn disconnected(stream: &UnixStream) -> bool {
    if STOPPING.load(Ordering::Acquire) { return true; }
    let mut descriptor = libc::pollfd { fd: stream.as_raw_fd(), events: libc::POLLIN, revents: 0 };
    // SAFETY: poll receives one live descriptor record and does not retain it.
    if unsafe { libc::poll(&mut descriptor, 1, 0) } < 0 { return true; }
    if descriptor.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 { return true; }
    if descriptor.revents & libc::POLLIN != 0 {
        let mut byte = 0_u8;
        // SAFETY: one-byte peek detects EOF or forbidden additional request bytes.
        return unsafe { libc::recv(stream.as_raw_fd(), (&mut byte as *mut u8).cast(), 1, libc::MSG_PEEK | libc::MSG_DONTWAIT) } >= 0;
    }
    false
}
extern "C" fn terminate(_: libc::c_int) { STOPPING.store(true, Ordering::Release); }
struct Signals { term: libc::sighandler_t, int: libc::sighandler_t }
impl Signals {
    fn install() -> Result<Self, HostError> {
        STOPPING.store(false, Ordering::Release);
        // SAFETY: handlers only store an atomic flag; old dispositions are restored on scope exit.
        let term = unsafe { libc::signal(libc::SIGTERM, terminate as *const () as libc::sighandler_t) };
        if term == libc::SIG_ERR { return Err(HostError::new("operation-failed", "Cannot install shutdown handler")); }
        let int = unsafe { libc::signal(libc::SIGINT, terminate as *const () as libc::sighandler_t) };
        if int == libc::SIG_ERR {
            unsafe { libc::signal(libc::SIGTERM, term); }
            return Err(HostError::new("operation-failed", "Cannot install shutdown handler"));
        }
        Ok(Self { term, int })
    }
}
impl Drop for Signals {
    fn drop(&mut self) {
        // SAFETY: restoring dispositions captured by this process's single server scope.
        unsafe { libc::signal(libc::SIGTERM, self.term); libc::signal(libc::SIGINT, self.int); }
    }
}
fn handle_private(host: &Host, stream: &mut UnixStream) -> Result<Value, HostError> {
    let authenticated = host.gui_channel.authenticate(stream, Role::Supervisor)?;
    let frame = read_frame(stream)?;
    let request = decode_private_request(&frame, &host.config.policy_revision, &host.config.release_revision)?;
    authenticated.recheck_freshness().map_err(|_| HostError::new("caller-denied", "Private caller incarnation changed"))?;
    host.gui_channel.authenticate(stream, Role::Supervisor)?;
    if disconnected(stream) { return Err(HostError::new("cancelled", "Private caller disconnected")); }
    let result = host.respond_private(request, &|| disconnected(stream));
    host.gui_channel.authenticate(stream, Role::Supervisor)?;
    authenticated.recheck_freshness().map_err(|_| HostError::new("caller-denied", "Private caller incarnation changed before response"))?;
    result
}

/// The GUI role never binds the public endpoint. Shutdown stops admission, cancels
/// active operations, joins every worker and only then removes the endpoint.
pub fn serve(host: Arc<Host>) -> Result<(), HostError> {
    verify_managed_role(host.role)?;
    if host.role == Role::GuiAgent { crate::native::require_gui_session()?; }
    let _signals = Signals::install()?;
    let path = if host.role == Role::Supervisor { &host.config.socket } else { &host.gui_channel.path };
    let (listener, _guard) = endpoint::bind(path, endpoint::EndpointPolicy { owner_uid: host.config.uid, socket_mode: 0o600 })
        .map_err(|_| HostError::new("policy-denied", "Socket endpoint unavailable or unsafe"))?;
    listener.set_nonblocking(true)?;
    host.children.activate();
    let mut workers: Vec<std::thread::JoinHandle<()>> = Vec::new();
    let mut outcome = Ok(());
    while !STOPPING.load(Ordering::Acquire) {
        let mut index = 0;
        while index < workers.len() {
            if workers[index].is_finished() { let _ = workers.swap_remove(index).join(); } else { index += 1; }
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                if workers.len() >= 32 { continue; }
                let host = Arc::clone(&host);
                match std::thread::Builder::new().name("host-request".into()).spawn(move || {
                    let response = if host.role == Role::GuiAgent {
                        match handle_private(&host, &mut stream) {
                            Ok(result) => json!({"wireVersion":1,"policyRevision":host.config.policy_revision,"releaseRevision":host.config.release_revision,"ok":true,"result":result}),
                            Err(error) => json!({"wireVersion":1,"policyRevision":host.config.policy_revision,"releaseRevision":host.config.release_revision,"ok":false,"error":error}),
                        }
                    } else {
                        match peer(&stream, host.config.uid) {
                            Ok(peer) => { let frame = read_frame(&mut stream); host.respond(frame, peer, &|| disconnected(&stream)) },
                            Err(error) => host.respond(Err(error), json!({"unavailableReason":"peer admission failed"}), &|| true),
                        }
                    };
                    let _ = write_frame(&mut stream, &response, RESPONSE_LIMIT);
                }) {
                    Ok(worker) => workers.push(worker),
                    Err(error) => { outcome = Err(error.into()); break; }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::park_timeout(Duration::from_millis(20)),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {},
            Err(error) => { outcome = Err(error.into()); break; }
        }
    }
    STOPPING.store(true, Ordering::Release);
    for worker in workers { let _ = worker.join(); }
    host.children.shutdown();
    outcome
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
    #[test] fn private_response_preserves_session_error() {
        let error = decode_test_response(br#"{"wireVersion":1,"ok":false,"error":{"code":"session-unavailable","message":"No GUI"}}"#).unwrap_err();
        assert_eq!(error.code, "session-unavailable");
    }
    #[test] fn private_response_preserves_permission_action() {
        let error = decode_test_response(br#"{"wireVersion":1,"ok":false,"error":{"code":"permission-required","message":"Not granted","actionRequired":{"category":"notifications","nextStep":"Explicit onboarding"}}}"#).unwrap_err();
        assert_eq!(error.action_required.unwrap().category, "notifications");
    }
    #[test] fn bounded_reader_observes_cancellation() {
        let (mut input, _output) = UnixStream::pair().unwrap();
        let error = read_bounded_frame(&mut input, REQUEST_LIMIT, Duration::from_secs(5), &|| true).unwrap_err();
        assert_eq!(error.code, "cancelled");
    }
    #[test] fn private_response_rejects_ambiguous_envelopes() {
        for value in [
            json!({"wireVersion":1,"ok":true,"result":{},"error":{}}),
            json!({"wireVersion":1,"ok":false,"result":{},"error":{}}),
            json!({"wireVersion":2,"ok":true,"result":{}}),
            json!({"wireVersion":1,"ok":"true","result":{}}),
            json!({"wireVersion":1,"ok":true,"result":{},"extra":true}),
        ] {
            assert!(decode_test_response(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }
    #[test] fn private_channel_rejects_wrong_signed_identity() {
        let (input, _output) = UnixStream::pair().unwrap();
        let channel = GuiChannel {
            path: PathBuf::from("/unused-private-peer"),
            // SAFETY: geteuid reads this process's effective UID without pointers.
            uid: unsafe { libc::geteuid() },
            requirement: CompiledRequirement::compile("anchor apple and identifier \"org.example.permissions-host-test.denied\"").unwrap(),
            policy_revision: "policy".into(), release_revision: "release".into(),
        };
        assert!(channel.authenticate(&input, Role::Supervisor).is_err());
    }
    #[test] fn private_channel_rejects_foreign_uid() {
        let (input, _output) = UnixStream::pair().unwrap();
        let channel = GuiChannel {
            path: PathBuf::from("/unused-private-peer"),
            // SAFETY: getuid reads this process's real UID without pointers.
            uid: unsafe { libc::getuid() }.wrapping_add(1),
            requirement: CompiledRequirement::compile("anchor apple").unwrap(),
            policy_revision: "policy".into(), release_revision: "release".into(),
        };
        assert!(channel.authenticate(&input, Role::Supervisor).is_err());
    }
    fn decode_test_response(bytes: &[u8]) -> Result<Value, HostError> {
        let mut response: Value = serde_json::from_slice(bytes).unwrap();
        response["policyRevision"] = json!("policy");
        response["releaseRevision"] = json!("release");
        decode_private_response(&serde_json::to_vec(&response).unwrap(), "policy", "release")
    }
    #[test] fn private_request_rejects_stale_policy_or_release_before_dispatch() {
        for (policy, release) in [("old-policy", "release"), ("policy", "old-release")] {
            let bytes = serde_json::to_vec(&json!({"wireVersion":1,"policyRevision":policy,
                "releaseRevision":release,"request":{"operation":"notify","input":{}}})).unwrap();
            assert_eq!(decode_private_request(&bytes, "policy", "release").unwrap_err().code, "gui-release-mismatch");
        }
        let request = json!({"operation":"children.status","input":{}});
        let bytes = serde_json::to_vec(&json!({"wireVersion":1,"policyRevision":"policy",
            "releaseRevision":"release","request":request})).unwrap();
        assert_eq!(decode_private_request(&bytes, "policy", "release").unwrap(), request);
    }
    #[test] fn private_response_rejects_stale_and_unbound_revisions() {
        for value in [
            json!({"wireVersion":1,"policyRevision":"old-policy","releaseRevision":"release","ok":true,"result":{}}),
            json!({"wireVersion":1,"policyRevision":"policy","releaseRevision":"old-release","ok":true,"result":{}}),
            json!({"wireVersion":1,"ok":true,"result":{}}),
        ] {
            assert_eq!(decode_private_response(&serde_json::to_vec(&value).unwrap(), "policy", "release").unwrap_err().code, "gui-release-mismatch");
        }
    }
}
