//! Opt-in example product operations. Never compiled into the default product.
use crate::children::{ProbeOperation, ProbeOutcome, Registry, ScheduledOperation};
use crate::{Config, HostError};
use macos_app_security::children::Child;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::thread;
use std::time::{Duration, Instant};

pub fn registry() -> Registry {
    Registry {
        probes: vec![ProbeOperation { id: "example.ready", requires_session: "none", run: ready }],
        scheduled: vec![ScheduledOperation { id: "example.run", child_id: "headless-worker", requires_session: "none" }],
    }
}

fn ready(_config: &Config, child: &Child, _instance: &str, deadline: Instant) -> Result<ProbeOutcome, HostError> {
    let path = child.client_socket.as_deref().ok_or_else(|| HostError::new("example-probe-missing-socket", "Example readiness requires a declared clientSocket"))?;
    Ok(probe(path, deadline))
}

// Nonblocking local connect: a saturated backlog must not extend the probe deadline.
fn connect(path: &str) -> io::Result<UnixStream> {
    // SAFETY: zero is valid initialization for sockaddr_un; all fields read by
    // connect are initialized below, and its size is passed explicitly.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if path.len() >= address.sun_path.len() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "example socket path too long"));
    }
    address.sun_family = libc::AF_UNIX as _;
    #[cfg(target_os = "macos")]
    { address.sun_len = std::mem::size_of_val(&address) as _; }
    for (destination, source) in address.sun_path.iter_mut().zip(path.bytes()) { *destination = source as _; }
    // SAFETY: socket returns a fresh owned descriptor; from_raw_fd takes it exactly once.
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if raw < 0 { return Err(io::Error::last_os_error()); }
    let stream = unsafe { UnixStream::from_raw_fd(raw) };
    stream.set_nonblocking(true)?;
    // SAFETY: raw remains owned and open; no pointer arguments are used by fcntl.
    if unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: address is initialized and valid for the supplied size.
    if unsafe { libc::connect(raw, (&raw const address).cast(), std::mem::size_of_val(&address) as _) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(stream)
}

fn probe(path: &str, deadline: Instant) -> ProbeOutcome {
    let mut stream = loop {
        if Instant::now() >= deadline { return failed("example-readiness-timeout"); }
        match connect(path) {
            Ok(stream) => break stream,
            Err(error) if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused | io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) || error.raw_os_error() == Some(libc::EINPROGRESS) => pause(deadline),
            Err(_) => return failed("example-connect-failed"),
        }
    };
    let request = b"ready?\n";
    let mut sent = 0;
    while sent < request.len() {
        if Instant::now() >= deadline { return failed("example-readiness-timeout"); }
        match stream.write(&request[sent..]) {
            Ok(0) => return failed("example-protocol-failed"),
            Ok(count) => sent += count,
            Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => pause(deadline),
            Err(_) => return failed("example-protocol-failed"),
        }
    }
    let mut response = [0; 6];
    let mut received = 0;
    while received < response.len() {
        if Instant::now() >= deadline { return failed("example-readiness-timeout"); }
        match stream.read(&mut response[received..]) {
            Ok(0) => return failed("example-protocol-failed"),
            Ok(count) => received += count,
            Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => pause(deadline),
            Err(_) => return failed("example-protocol-failed"),
        }
    }
    if response == *b"ready\n" { ProbeOutcome::Ready } else { failed("example-protocol-failed") }
}
fn failed(code: &str) -> ProbeOutcome { ProbeOutcome::Failed { code: code.into() } }
fn pause(deadline: Instant) { thread::sleep(deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(5))); }

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    fn exchange(response: &'static [u8]) -> ProbeOutcome {
        // Keep below sockaddr_un's path limit even when macOS TMPDIR is long.
        let path = std::path::Path::new("/tmp").join(format!("example-probe-{}.sock", crate::opaque_id().unwrap()));
        let listener = UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(1);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline => pause(deadline),
                    Err(error) => panic!("example fixture accept failed: {error}"),
                }
            };
            stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
            let mut request = [0; 7];
            stream.read_exact(&mut request).unwrap();
            assert_eq!(&request, b"ready?\n");
            stream.write_all(response).unwrap();
        });
        let outcome = probe(path.to_str().unwrap(), Instant::now() + Duration::from_secs(1));
        worker.join().unwrap();
        std::fs::remove_file(path).unwrap();
        outcome
    }
    #[test]
    fn real_protocol_reports_ready_and_failed_without_permission_evidence() {
        assert!(matches!(exchange(b"ready\n"), ProbeOutcome::Ready));
        assert!(matches!(exchange(b"wrong\n"), ProbeOutcome::Failed { code } if code == "example-protocol-failed"));
    }
    #[test]
    fn unavailable_endpoint_has_a_bounded_failure() {
        assert!(matches!(probe("/nonexistent/example-probe.sock", Instant::now()), ProbeOutcome::Failed { code } if code == "example-readiness-timeout"));
    }
    #[test]
    fn registry_is_exact_and_session_bound() {
        let registry = registry();
        assert_eq!(registry.probes.len(), 1);
        assert_eq!(registry.probes[0].id, "example.ready");
        assert_eq!(registry.probes[0].requires_session, "none");
        assert_eq!(registry.scheduled.len(), 1);
        assert_eq!(registry.scheduled[0].id, "example.run");
        assert_eq!(registry.scheduled[0].child_id, "headless-worker");
        assert_eq!(registry.scheduled[0].requires_session, "none");
    }
    fn config(child: serde_json::Value) -> Config {
        serde_json::from_value(serde_json::json!({
            "uid":501,"socket":"/example/control.sock","audit":"/example/audit","staging":"/example/staging",
            "policyRevision":"test","releaseRevision":"test","enabledGrants":[],"automationTargets":[],
            "products":{},"auditMaxBytes":1024,
            "documents":{"sources":{},"maxItems":1,"maxBytes":1,"timeoutMs":100},
            "helperRequirements":{"Contents/Helpers/headless-worker":"test","Contents/Helpers/session-worker":"test"},
            "jobProcessTypes":{"none":"Background","gui":"Background"},"supervisedChildren":[child]
        })).unwrap()
    }
    fn resident() -> serde_json::Value {
        serde_json::json!({
            "id":"headless-worker","helperPath":"Contents/Helpers/headless-worker","argv":[],"env":{},"cwd":"/",
            "requiredTccServices":[],"requiresSession":"none","readiness":{"kind":"probe-op","op":"example.ready","timeoutMs":100},
            "restart":{"kind":"never"},"stop":{"signal":"term","graceMs":100},"schedule":{"kind":"resident"},
            "rlimitNofile":{"soft":256,"hard":256},"nice":5,"processType":"Background",
            "directories":{"state":{"path":"/example/state"},"run":{"path":"/example/run"},"log":{"path":"/example/log"}}
        })
    }
    #[test]
    fn admission_rejects_unknown_probe_and_session_mismatch() {
        assert!(registry().validate(&config(resident())).is_ok());
        let mut child = resident();
        child["readiness"]["op"] = serde_json::json!("unknown.probe");
        assert_eq!(registry().validate(&config(child)).unwrap_err().code, "unregistered-child-probe");
        let mut child = resident();
        child["requiresSession"] = serde_json::json!("gui");
        assert_eq!(registry().validate(&config(child)).unwrap_err().code, "unregistered-child-probe");
    }
    #[test]
    fn scheduled_admission_binds_operation_child_and_session() {
        let mut child = resident();
        child["schedule"] = serde_json::json!({"kind":"launchd-scheduled","op":"example.run"});
        assert!(registry().validate(&config(child.clone())).is_ok());
        let mut wrong_session = child.clone();
        wrong_session["readiness"] = serde_json::json!({"kind":"none"});
        wrong_session["requiresSession"] = serde_json::json!("gui");
        assert_eq!(registry().validate(&config(wrong_session)).unwrap_err().code, "unregistered-child-schedule");
        child["id"] = serde_json::json!("another-child");
        assert_eq!(registry().validate(&config(child)).unwrap_err().code, "unregistered-child-schedule");
    }
}
