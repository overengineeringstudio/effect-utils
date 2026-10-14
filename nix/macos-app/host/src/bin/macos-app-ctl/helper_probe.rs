//! Feature-only real-kernel security probe. No signing, arbitrary execution or production command.
use super::{Ctl, Result, fail};
use macos_app_host::{AuditToken, CompiledRequirement, PeerPolicy, SecurityError, authenticate_token};
use macos_app_host::endpoint::{self, EndpointPolicy};
use serde_json::{Value, json};
use std::io::{self, Read, Write};
use std::os::unix::{net::UnixStream, process::CommandExt};
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

const BOUND: Duration = Duration::from_secs(5);
fn security(error: SecurityError) -> super::Failure { fail(22, "helper-authentication-failed", error.to_string()) }
fn identity(token: AuditToken) -> Value {
    json!({"effectiveUid": token.effective_uid(), "realUid": token.real_uid(), "pid": token.pid(), "pidVersion": token.pid_version()})
}
fn configure(stream: &UnixStream) -> Result<()> {
    stream.set_read_timeout(Some(BOUND))?;
    stream.set_write_timeout(Some(BOUND))?;
    Ok(())
}
fn byte(stream: &mut UnixStream, expected: u8) -> Result<()> {
    let mut value = [0u8; 1];
    stream.read_exact(&mut value)?;
    if value[0] != expected { return Err(fail(22, "helper-protocol-failed", "Unexpected probe handshake")); }
    Ok(())
}
pub(super) fn run(ctl: &Ctl) -> Result<Value> {
    let evidence = ctl.arg("evidence")?;
    if !["fresh", "exit", "exec"].contains(&evidence) { return Err(fail(64, "invalid-input", "Unsupported helper evidence")); }
    let socket = Path::new(ctl.arg("socket")?);
    let uid = ctl.arg("target-uid")?.parse::<u32>().map_err(|_| fail(64, "invalid-input", "Invalid target UID"))?;
    let requirement = CompiledRequirement::compile(ctl.arg("requirement")?).map_err(security)?;
    match ctl.arg("mode")? {
        "server" => {
            // SAFETY: geteuid has no pointers and identifies the endpoint owner, independently of caller policy UID.
            let owner_uid = unsafe { libc::geteuid() };
            let (listener, _guard) = endpoint::bind(socket, EndpointPolicy { owner_uid, socket_mode: 0o600 }).map_err(security)?;
            listener.set_nonblocking(true)?;
            let deadline = Instant::now() + BOUND;
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock || error.kind() == io::ErrorKind::Interrupted => {
                        if Instant::now() >= deadline { return Err(fail(23, "helper-timeout", "Probe accept timed out")); }
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => return Err(error.into()),
                }
            };
            configure(&stream)?;
            // Capture once from the kernel, before the transition handshake. Never recapture after exec.
            let token = AuditToken::from_stream(&stream).map_err(security)?;
            let peer = authenticate_token(token, PeerPolicy { allowed_uids: &[uid], requirement: &requirement }).map_err(security)?;
            stream.write_all(b"H")?;
            let mut result = identity(token);
            if evidence == "fresh" {
                peer.recheck_freshness().map_err(security)?;
                stream.write_all(b"A")?;
                result["authenticated"] = json!(true);
                return Ok(result);
            }
            let deadline = Instant::now() + BOUND;
            loop {
                match peer.recheck_freshness() {
                    Err(SecurityError::StaleToken(_)) => {
                        result["staleRejected"] = json!(true);
                        result["evidence"] = json!(evidence);
                        return Ok(result);
                    }
                    Err(error) => return Err(security(error)),
                    Ok(()) => {
                        if Instant::now() >= deadline { return Err(fail(22, "helper-stale-not-rejected", "Captured token remained fresh after requested transition")); }
                        thread::sleep(Duration::from_millis(10));
                    }
                }
            }
        }
        "client" => {
            let deadline = Instant::now() + BOUND;
            let mut stream = loop {
                match UnixStream::connect(socket) {
                    Ok(stream) => break stream,
                    Err(error) if error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ECONNREFUSED) => {
                        if Instant::now() >= deadline { return Err(fail(23, "helper-timeout", "Probe connect timed out")); }
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => return Err(error.into()),
                }
            };
            configure(&stream)?;
            byte(&mut stream, b'H')?;
            match evidence {
                "fresh" => {
                    byte(&mut stream, b'A')?;
                    Ok(json!({"clientCompleted": true, "evidence": evidence}))
                }
                "exit" => Ok(json!({"clientExiting": true, "evidence": evidence})),
                "exec" => {
                    // Feature-only fixed transition oracle, not an arbitrary executable capability.
                    let error = Command::new("/usr/bin/true").exec();
                    Err(error.into())
                }
                _ => unreachable!("Evidence was validated before transport creation"),
            }
        }
        _ => Err(fail(64, "invalid-input", "Unsupported helper probe mode")),
    }
}
