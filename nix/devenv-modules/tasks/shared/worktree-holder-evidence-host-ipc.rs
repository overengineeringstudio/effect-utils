//! Bind the declared managed byte-only host seam to actual immutable artifacts.
//! The Nix producer supplies runner/backend/source together; accepted source
//! digests are reviewed build policy, never values read from the request/env.
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Instant;
use super::{client, decode, linux, objects};

const RUNNER: &str = env!("HOLDER_EVIDENCE_IPC_RUNNER");
const BACKEND: &str = env!("HOLDER_EVIDENCE_IPC_BACKEND");
const PYTHON: &str = env!("HOLDER_EVIDENCE_IPC_PYTHON");
const RUNNER_SOURCE: &str = env!("HOLDER_EVIDENCE_IPC_RUNNER_SOURCE");
const RPC_SOURCE: &str = env!("HOLDER_EVIDENCE_IPC_RPC_SOURCE");
const SSHD: &str = env!("HOLDER_EVIDENCE_IPC_SSHD");
const SSHD_CONFIG: &str = env!("HOLDER_EVIDENCE_IPC_SSHD_CONFIG");
const AUTH_SOURCE: &str = env!("HOLDER_EVIDENCE_IPC_AUTH_SOURCE");
const AUTH_RUNTIME: &str = env!("HOLDER_EVIDENCE_IPC_AUTH_RUNTIME");
const UNIT: &str = env!("HOLDER_EVIDENCE_IPC_UNIT");
const CGROUP: &str = env!("HOLDER_EVIDENCE_IPC_CGROUP");

struct Immutable {
    requested: String,
    resolved: PathBuf,
    file: File,
}

fn store_path(path: &Path) -> bool {
    let Some(relative) = path.strip_prefix("/nix/store").ok() else { return false; };
    let Some(component) = relative.components().next().and_then(|value| value.as_os_str().to_str()) else { return false; };
    component.len() > 33 && component.as_bytes()[32] == b'-'
        && component.as_bytes()[..32].iter().all(|value| b"0123456789abcdfghijklmnpqrsvwxyz".contains(value))
}

impl Immutable {
    fn pin(path: &str) -> io::Result<Self> {
        if !store_path(Path::new(path)) {
            return Err(io::Error::other("IPC artifact is outside immutable store policy"));
        }
        let resolved = fs::canonicalize(path)?;
        if !store_path(&resolved) {
            return Err(io::Error::other("IPC artifact resolves outside immutable store"));
        }
        let store = File::open("/nix/store")?;
        let file = objects::pin_beneath(&store, resolved.strip_prefix("/nix/store")
            .map_err(|_| io::Error::other("invalid IPC store path"))?.as_os_str())?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0
            || !objects::native_filesystem(&file)?
        {
            return Err(io::Error::other("IPC artifact is not a root-owned immutable native file"));
        }
        Ok(Self { requested: path.to_owned(), resolved, file })
    }

    fn bytes(&self, limit: usize) -> io::Result<Vec<u8>> {
        use std::io::Read;
        let mut reader = File::open(format!("/proc/self/fd/{}", self.file.as_raw_fd()))?;
        if objects::identity(&reader)? != objects::identity(&self.file)? || reader.metadata()?.len() > limit as u64 {
            return Err(io::Error::other("IPC read binding or size changed"));
        }
        let mut bytes = Vec::new();
        reader.by_ref().take((limit + 1) as u64).read_to_end(&mut bytes)?;
        if bytes.len() > limit { return Err(io::Error::other("IPC source exceeds bound")); }
        Ok(bytes)
    }

    fn recheck(&self) -> io::Result<()> {
        let current = Self::pin(&self.requested)?;
        if current.resolved != self.resolved || objects::identity(&current.file)? != objects::identity(&self.file)?
            || objects::mount_id(&current.file)? != objects::mount_id(&self.file)?
        {
            return Err(io::Error::other("immutable IPC artifact binding changed"));
        }
        Ok(())
    }
}

fn unit_at(deadline: Instant) -> io::Result<String> {
    String::from_utf8(decode::metadata(env!("HOLDER_EVIDENCE_SYSTEMCTL"), &[
        "--system", "show", "--no-pager",
        "--property=ActiveState,MainPID,InvocationID,ControlGroup,FragmentPath,ExecStart", UNIT
    ], deadline)?).map_err(|_| io::Error::other("non-UTF-8 IPC unit metadata"))
}

fn fields(value: &str) -> io::Result<BTreeMap<&str, &str>> {
    let mut output = BTreeMap::new();
    for line in value.lines() {
        let (key, value) = line.split_once('=').ok_or_else(|| io::Error::other("malformed IPC unit metadata"))?;
        if !["ActiveState", "MainPID", "InvocationID", "ControlGroup", "FragmentPath", "ExecStart"].contains(&key)
            || output.insert(key, value).is_some()
        {
            return Err(io::Error::other("unexpected or duplicate IPC unit property"));
        }
    }
    if output.len() != 6 || output.get("ActiveState") != Some(&"active") {
        return Err(io::Error::other("IPC unit is not completely active"));
    }
    Ok(output)
}

fn actual_process(process: &client::Process, executable: &File) -> io::Result<()> {
    let now = client::process(process.pid)?;
    if !now.same_identity(process) || matches!(now.state, b'Z' | b'X') || client::uids(process.pid)? != [0; 4] {
        return Err(io::Error::other("IPC daemon process identity changed"));
    }
    let prefix = format!("/proc/{}", process.pid);
    let actual = objects::pin_magic(format!("{prefix}/exe"))?;
    let root = objects::pin_magic(format!("{prefix}/root"))?;
    if objects::identity(&actual)? != objects::identity(executable)?
        || objects::identity(&root)? != objects::identity(&File::open("/")?)?
        || objects::bounded_text(format!("{prefix}/cgroup"), 4096)? != format!("0::{CGROUP}\n")
    {
        return Err(io::Error::other("IPC daemon executable, root or cgroup differs"));
    }
    for kind in ["user", "pid", "net"] {
        let daemon = objects::pin_magic(format!("{prefix}/ns/{kind}"))?;
        let host = objects::pin_magic(format!("/proc/self/ns/{kind}"))?;
        if objects::identity(&daemon)? != objects::identity(&host)? {
            return Err(io::Error::other("IPC daemon host namespace differs"));
        }
    }
    Ok(())
}

pub struct Proof {
    unit: String,
    process: client::Process,
    _pidfd: OwnedFd,
    artifacts: Vec<Immutable>,
    authorization: Vec<u8>,
    runtime_authorization: File,
}

impl Proof {
    pub fn attest(deadline: Instant) -> io::Result<Self> {
        let mut artifacts = Vec::new();
        for path in [RUNNER, BACKEND, PYTHON, RUNNER_SOURCE, RPC_SOURCE, SSHD, SSHD_CONFIG, AUTH_SOURCE] {
            artifacts.push(Immutable::pin(path)?);
        }
        let launcher = String::from_utf8(artifacts[0].bytes(64 * 1024)?)
            .map_err(|_| io::Error::other("non-UTF-8 IPC launcher"))?;
        let expected_backend = format!("export {}={BACKEND}", env!("HOLDER_EVIDENCE_IPC_BACKEND_VARIABLE"));
        let expected_exec = format!("exec {PYTHON} -P {RUNNER_SOURCE}");
        if launcher.lines().filter(|line| *line == expected_backend).count() != 1
            || launcher.lines().filter(|line| *line == expected_exec).count() != 1
            || launcher.lines().filter(|line| *line == env!("HOLDER_EVIDENCE_IPC_ENVIRONMENT_LINE")).count() != 1
        {
            return Err(io::Error::other("IPC launcher does not bind the declared fixed byte client"));
        }
        for (index, expected) in [
            (3, env!("HOLDER_EVIDENCE_IPC_RUNNER_DIGEST")),
            (4, env!("HOLDER_EVIDENCE_IPC_RPC_DIGEST")),
        ] {
            if decode::digest(artifacts[index].bytes(256 * 1024)?, deadline)? != expected {
                return Err(io::Error::other("reviewed IPC source digest differs"));
            }
        }
        let authorization = artifacts[7].bytes(64 * 1024)?;
        let authorization_text = std::str::from_utf8(&authorization)
            .map_err(|_| io::Error::other("non-UTF-8 IPC authorization"))?;
        if authorization_text.lines().filter(|line| !line.trim().is_empty()).count() != 1
            || !authorization_text.contains(&format!("restrict,no-user-rc,command=\"{RUNNER}\" "))
        {
            return Err(io::Error::other("IPC authorization is not the fixed restricted command"));
        }
        let runtime_authorization = objects::pin_beneath(&File::open("/run")?,
            Path::new(AUTH_RUNTIME).strip_prefix("/run").map_err(|_| io::Error::other("invalid runtime authorization path"))?.as_os_str())?;
        let snapshot = unit_at(deadline)?;
        let values = fields(&snapshot)?;
        let invocation = values["InvocationID"];
        let executable_prefix = format!("{{ path={SSHD} ; argv[]={SSHD} -D -e -f {SSHD_CONFIG} ; ignore_errors=no ;");
        if invocation.len() != 32 || !invocation.bytes().all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
            || values["ControlGroup"] != CGROUP
            || !values["ExecStart"].starts_with(&executable_prefix)
        {
            return Err(io::Error::other("IPC unit invocation or executable policy differs"));
        }
        let fragment = values["FragmentPath"].to_owned();
        if !store_path(&fs::canonicalize(&fragment)?) {
            return Err(io::Error::other("IPC unit fragment is not immutable"));
        }
        let pid = values["MainPID"].parse::<u32>().map_err(|_| io::Error::other("invalid IPC daemon PID"))?;
        if pid == 0 { return Err(io::Error::other("IPC daemon has no live PID")); }
        let pidfd = linux::pin_process(pid)?;
        let process = client::process(pid)?;
        actual_process(&process, &artifacts[5].file)?;
        let proof = Self { unit: snapshot, process, _pidfd: pidfd, artifacts, authorization, runtime_authorization };
        proof.recheck(deadline)?;
        Ok(proof)
    }

    pub fn recheck(&self, deadline: Instant) -> io::Result<()> {
        if unit_at(deadline)? != self.unit {
            return Err(io::Error::other("IPC unit generation changed"));
        }
        actual_process(&self.process, &self.artifacts[5].file)?;
        for artifact in &self.artifacts { artifact.recheck()?; }
        let current = objects::pin_beneath(&File::open("/run")?,
            Path::new(AUTH_RUNTIME).strip_prefix("/run").map_err(|_| io::Error::other("invalid runtime authorization path"))?.as_os_str())?;
        let metadata = current.metadata()?;
        if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0
            || objects::identity(&current)? != objects::identity(&self.runtime_authorization)?
            || objects::bounded_text(format!("/proc/self/fd/{}", current.as_raw_fd()), 64 * 1024)?.as_bytes() != self.authorization
            || Instant::now() >= deadline
        {
            return Err(io::Error::other("IPC runtime authorization or deadline changed"));
        }
        Ok(())
    }
}

/// The deployed alias and desired artifact must both resolve inside the
/// immutable store, with equal bounded bytes and stable path/object bindings.
pub(super) fn same_immutable_bytes(current_name: &str, desired: &str, deadline: Instant) -> io::Result<()> {
    if Instant::now() >= deadline { return Err(io::Error::other("managed artifact deadline")); }
    let current_path = fs::canonicalize(current_name)?;
    let current = Immutable::pin(current_path.to_str().ok_or_else(|| io::Error::other("non-text deployed artifact"))?)?;
    let desired = Immutable::pin(desired)?;
    if current.bytes(1024 * 1024)? != desired.bytes(1024 * 1024)? {
        return Err(io::Error::other("deployed managed artifact differs from desired manifest"));
    }
    current.recheck()?;
    desired.recheck()?;
    if fs::canonicalize(current_name)? != current_path {
        return Err(io::Error::other("deployed managed artifact alias changed"));
    }
    if Instant::now() >= deadline { return Err(io::Error::other("managed artifact deadline")); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::store_path;
    use std::path::Path;

    #[test]
    fn immutable_artifacts_require_store_object_names() {
        assert!(store_path(Path::new("/nix/store/00000000000000000000000000000000-client/bin/client")));
        for value in ["/tmp/client", "/nix/store/client", "/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-client"] {
            assert!(!store_path(Path::new(value)));
        }
    }
}
