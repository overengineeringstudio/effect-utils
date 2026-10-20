//! Private peers are the two installed launchd job incarnations, not merely any
//! execution of the signed binary. Identity comes only from sealed bundle bytes.
use super::Role;
use crate::HostError;
use macos_app_security::{AuditToken, CompiledRequirement, PeerPolicy, authenticate_token};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

const OUTPUT_LIMIT: usize = 64 * 1024;
static IDENTITY: parking_lot::Mutex<Option<Arc<Identity>>> = parking_lot::Mutex::new(None);

pub(super) struct Identity {
    uid: u32,
    supervisor_label: String,
    gui_label: String,
    requirement: CompiledRequirement,
    policy: Vec<u8>,
    policy_digest: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Declaration { version: u32, target_uid: u32, supervisor_label: String, gui_label: String, host_requirement: String }
fn denied(message: &'static str) -> HostError { HostError::new("caller-denied", message) }

pub(super) fn identity() -> Result<Arc<Identity>, HostError> {
    let mut selected = IDENTITY.lock();
    if let Some(identity) = selected.as_ref() { return Ok(Arc::clone(identity)); }
    let executable = std::fs::canonicalize(std::env::current_exe()?)?;
    let bundle = executable.parent().and_then(std::path::Path::parent).and_then(std::path::Path::parent)
        .ok_or_else(|| denied("Managed host must execute from its sealed bundle"))?;
    // Never resolve this resource through --config, an environment variable, a
    // generation pointer, or a caller-writable identity declaration.
    let resource = bundle.join("Contents/Resources/runtime-identity.json");
    let bytes = read_resource(&resource, OUTPUT_LIMIT)?;
    let policy_path = bundle.join("Contents/Resources/policy.json");
    let policy = read_resource(&policy_path, 1024 * 1024)?;
    let declaration: Declaration = serde_json::from_slice(&bytes).map_err(|_| denied("Invalid managed runtime identity declaration"))?;
    if declaration.version != 1 || !valid_label(&declaration.supervisor_label) || !valid_label(&declaration.gui_label)
        || declaration.supervisor_label == declaration.gui_label {
        return Err(denied("Managed runtime labels are invalid"));
    }
    let requirement = CompiledRequirement::compile(&declaration.host_requirement).map_err(|_| denied("Invalid sealed host requirement"))?;
    requirement.verify_path(bundle).map_err(|_| denied("Managed runtime bundle seal verification failed"))?;
    // Detect replacement during seal verification. Concurrent mutation of the
    // admitted signed bundle is separately excluded by release placement policy.
    let after = read_resource(&resource, OUTPUT_LIMIT)?;
    if after != bytes || read_resource(&policy_path, 1024 * 1024)? != policy {
        return Err(denied("Managed runtime resources changed during verification"));
    }
    let identity = Arc::new(Identity { uid: declaration.target_uid, supervisor_label: declaration.supervisor_label,
        gui_label: declaration.gui_label, requirement, policy_digest: hex::encode(Sha256::digest(&policy)), policy });
    *selected = Some(Arc::clone(&identity));
    Ok(identity)
}
fn read_resource(path: &std::path::Path, limit: usize) -> Result<Vec<u8>, HostError> {
    let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path).map_err(|_| denied("Sealed managed runtime identity is unavailable"))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > limit as u64 { return Err(denied("Invalid sealed runtime resource")); }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit { return Err(denied("Sealed runtime resource exceeds byte bound")); }
    Ok(bytes)
}
fn require_sealed_policy(supplied: &[u8], sealed: &[u8]) -> Result<(), HostError> {
    if supplied != sealed {
        return Err(HostError::new("policy-denied", "Caller-selected policy differs from the bundle-sealed policy"));
    }
    Ok(())
}
fn valid_label(label: &str) -> bool {
    !label.is_empty() && label.len() <= 255 && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}
impl Identity {
    pub(super) fn load_config(&self, supplied: &std::path::Path) -> Result<crate::Config, HostError> {
        let bytes = read_resource(supplied, 1024 * 1024)?;
        require_sealed_policy(&bytes, &self.policy)?;
        let mut config = crate::Config::from_bytes(&self.policy, &crate::child_operations())?;
        config.sealed_policy_digest = Some(self.policy_digest.clone());
        self.check_config(&config)?;
        Ok(config)
    }
    pub(super) fn check_config(&self, config: &crate::Config) -> Result<(), HostError> {
        if config.sealed_policy_digest.as_deref() != Some(self.policy_digest.as_str()) {
            return Err(HostError::new("policy-denied", "Production role requires bundle-sealed policy authority"));
        }
        Ok(())
    }
    fn target(&self, role: Role) -> String {
        match role {
            Role::Supervisor => format!("system/{}", self.supervisor_label),
            Role::GuiAgent => format!("gui/{}/{}", self.uid, self.gui_label),
        }
    }
    pub(super) fn check_self(&self, role: Role) -> Result<(), HostError> {
        // SAFETY: these getters take no pointers and read this process's UIDs.
        if unsafe { libc::getuid() } != self.uid || unsafe { libc::geteuid() } != self.uid {
            return Err(denied("Managed host real and effective UIDs must match sealed target user"));
        }
        self.check_pid(role, std::process::id())
    }
    fn check_pid(&self, role: Role, pid: u32) -> Result<(), HostError> {
        let observed = managed_pid(&self.target(role))?;
        if observed != pid { return Err(denied("Private peer is not the current owning launchd job incarnation")); }
        Ok(())
    }
    pub(super) fn authenticate(&self, token: AuditToken, role: Role) -> Result<(), HostError> {
        let peer = authenticate_token(token, PeerPolicy { allowed_uids: &[self.uid], requirement: &self.requirement })
            .map_err(|_| denied("Private managed peer UID or sealed code identity denied"))?;
        self.check_pid(role, token.pid())?;
        // The kernel-captured incarnation must survive the launchctl observation;
        // matching a recycled PID alone never grants admission.
        peer.recheck_freshness().map_err(|_| denied("Managed peer incarnation changed during admission"))
    }
}
struct Reap(Child);
impl Drop for Reap {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}
fn managed_pid(target: &str) -> Result<u32, HostError> {
    // /bin/launchctl is the fixed public management surface. Never consult PATH,
    // shell commands, caller arguments, private launchd symbols or readable secrets.
    let child = Command::new("/bin/launchctl").args(["print", target]).env_clear()
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
        .map_err(|_| denied("Cannot observe owning launchd job"))?;
    let mut child = Reap(child);
    let mut stdout = child.0.stdout.take().ok_or_else(|| denied("Cannot capture launchd job evidence"))?;
    let fd = stdout.as_raw_fd();
    // SAFETY: fcntl changes only the live owned pipe's status flags.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(denied("Cannot bound launchd job observation"));
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut bytes = Vec::with_capacity(4096);
    let mut buffer = [0_u8; 4096];
    let mut eof = false;
    loop {
        if Instant::now() >= deadline { return Err(denied("Owning launchd job observation timed out")); }
        if !eof {
            match stdout.read(&mut buffer) {
                Ok(0) => eof = true,
                Ok(count) => {
                    if bytes.len() + count > OUTPUT_LIMIT { return Err(denied("Launchd job evidence exceeds byte bound")); }
                    bytes.extend_from_slice(&buffer[..count]);
                }
                Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) => {},
                Err(_) => return Err(denied("Cannot read owning launchd job evidence")),
            }
        }
        let status = child.0.try_wait().map_err(|_| denied("Cannot reap launchd job observer"))?;
        if let Some(status) = status {
            if !status.success() { return Err(denied("Expected launchd job is not loaded")); }
            if eof { return parse_pid(&bytes, target); }
        }
        if !eof {
            let mut poll = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
            // SAFETY: one owned pipe descriptor record lives for the poll call.
            unsafe { libc::poll(&mut poll, 1, 20); }
        } else { std::thread::sleep(Duration::from_millis(5)); }
    }
}
fn parse_pid(bytes: &[u8], target: &str) -> Result<u32, HostError> {
    let text = std::str::from_utf8(bytes).map_err(|_| denied("Malformed launchd job evidence"))?;
    if text.lines().next() != Some(format!("{target} = {{").as_str()) {
        return Err(denied("Launchd job evidence names a different target"));
    }
    let mut pids = text.lines().filter_map(|line| line.strip_prefix("\tpid = "));
    let pid = pids.next().and_then(|value| value.parse::<u32>().ok())
        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u32)
        .ok_or_else(|| denied("Owning launchd job has no live PID"))?;
    if pids.next().is_some() { return Err(denied("Ambiguous launchd job PID evidence")); }
    Ok(pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn managed_gui_modified_policy_is_refused_even_with_unchanged_revisions() {
        // A same-UID process can own the real GUI label. The production loader
        // therefore admits bytes before checking any job PID, independently of
        // whether launchd currently reports the attacker-selected incarnation.
        let sealed = br#"{"policyRevision":"same","releaseRevision":"same","supervisedChildren":[{"argv":["declared"]}]}"#;
        let modified = br#"{"policyRevision":"same","releaseRevision":"same","supervisedChildren":[{"argv":["attacker"]}]}"#;
        assert!(require_sealed_policy(sealed, sealed).is_ok());
        assert_eq!(require_sealed_policy(modified, sealed).unwrap_err().code, "policy-denied");
        assert_ne!(Sha256::digest(sealed), Sha256::digest(modified));
        let path = std::env::temp_dir().join(format!("managed-policy-{}", crate::opaque_id().unwrap()));
        std::fs::write(&path, modified).unwrap();
        let identity = Identity {
            uid: unsafe { libc::getuid() }, supervisor_label: "org.example.host".into(),
            gui_label: "org.example.host.gui".into(),
            requirement: CompiledRequirement::compile("anchor apple").unwrap(),
            policy: sealed.to_vec(), policy_digest: hex::encode(Sha256::digest(sealed)),
        };
        // Mandatory for both roles, before any managed-PID observation.
        assert_eq!(identity.load_config(&path).err().unwrap().code, "policy-denied");
        std::fs::remove_file(path).unwrap();
    }
    #[test] fn managed_job_pid_parser_ignores_nested_pids_and_rejects_ambiguity() {
        assert_eq!(parse_pid(b"system/org.example.host = {\n\tpid = 42\n\tchild = {\n\t\tpid = 99\n\t}\n}\n", "system/org.example.host").unwrap(), 42);
        assert!(parse_pid(b"system/org.example.host = {\n\tpid = 42\n\tpid = 99\n}\n", "system/org.example.host").is_err());
        assert!(parse_pid(b"gui/501/org.example.host = {\n\tpid = 42\n}\n", "system/org.example.host").is_err());
    }
    #[test] fn same_signed_standalone_peer_is_not_the_managed_job() {
        let (input, _output) = std::os::unix::net::UnixStream::pair().unwrap();
        let token = AuditToken::from_stream(&input).unwrap();
        // Both socket ends are this exact test executable, not a wrong-signature
        // substitute. Establish real kernel/code admission before rejecting its
        // missing managed-job incarnation using the actual public launchctl tool.
        let executable = std::env::current_exe().unwrap();
        let signature = Command::new("/usr/bin/codesign").args(["-d", "--verbose=4"]).arg(executable).output().unwrap();
        assert!(signature.status.success(), "The regression requires a code-signed test executable");
        let diagnostic = std::str::from_utf8(&signature.stderr).unwrap();
        let cdhash = diagnostic.lines().find_map(|line| line.strip_prefix("CDHash=")).unwrap();
        let requirement = CompiledRequirement::compile(&format!("cdhash H\"{cdhash}\"")).unwrap();
        authenticate_token(token, PeerPolicy { allowed_uids: &[token.real_uid()], requirement: &requirement }).unwrap();
        let identity = Identity { uid: token.real_uid(), supervisor_label: format!("org.example.permissions-host-impostor-{}", std::process::id()),
            gui_label: "org.example.permissions-host-impostor.gui".into(), requirement, policy: Vec::new(), policy_digest: String::new() };
        assert_eq!(identity.authenticate(token, Role::Supervisor).unwrap_err().code, "caller-denied");
    }
}
