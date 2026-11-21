//! Fixed read-only Docker transport authenticated through systemd's actual listener.
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};
use super::{client, decode, linux, listener, objects};

const SOCKET: &str = "/run/docker.sock";
const MAX_RESPONSE: usize = 8 * 1024 * 1024;
const MAX_HEADER: usize = 32 * 1024;
fn invalid(message: &'static str) -> io::Error { io::Error::other(message) }
fn due(deadline: Instant) -> io::Result<()> {
    if Instant::now() >= deadline { Err(invalid("daemon evidence deadline")) } else { Ok(()) }
}

fn unit(name: &'static str, deadline: Instant) -> io::Result<BTreeMap<String, String>> {
    let properties = match name {
        "docker.socket" => "ActiveState,SubState,InvocationID,Triggers,SocketUser,SocketGroup,SocketMode,Listen",
        "docker.service" => "ActiveState,SubState,InvocationID,MainPID,ControlGroup,ExecStart",
        _ => return Err(invalid("unadmitted systemd unit")),
    };
    let bytes = decode::metadata(env!("HOLDER_EVIDENCE_SYSTEMCTL"),
        &["--no-pager", "show", "--property", properties, "--", name], deadline)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| invalid("non-text unit metadata"))?;
    let mut values = BTreeMap::new();
    for line in text.lines() {
        let (key, value) = line.split_once('=').ok_or_else(|| invalid("malformed unit metadata"))?;
        if let Some(previous) = values.get(key) {
            if key != "Listen" || previous != value { return Err(invalid("duplicate or distinct unit metadata")); }
        } else {
            values.insert(key.to_owned(), value.to_owned());
        }
    }
    if values.get("ActiveState").map(String::as_str) != Some("active")
        || !values.get("InvocationID").is_some_and(|id| id.len() == 32 && id.bytes().all(|c| c.is_ascii_hexdigit())) {
        return Err(invalid("inactive or unbound systemd unit"));
    }
    Ok(values)
}

struct HeldProcess {
    process: client::Process,
    pidfd: OwnedFd,
    namespaces: Vec<File>,
    executable: File,
    cgroup: String,
}
impl HeldProcess {
    fn pin(pid: u32) -> io::Result<Self> {
        let process = client::process(pid)?;
        let pidfd = linux::pin_process(pid)?;
        if client::uids(pid)? != [0; 4] { return Err(invalid("non-root activation process")); }
        let mut namespaces = Vec::new();
        for name in ["user", "pid", "mnt", "net"] {
            let actual = objects::pin_magic(format!("/proc/{pid}/ns/{name}"))?;
            let initial = objects::pin_magic(format!("/proc/1/ns/{name}"))?;
            if objects::identity(&actual)? != objects::identity(&initial)? { return Err(invalid("daemon outside initial namespaces")); }
            namespaces.push(actual);
        }
        let executable = objects::pin_magic(format!("/proc/{pid}/exe"))?;
        let cgroup = objects::bounded_text(format!("/proc/{pid}/cgroup"), 65536)?;
        let held = Self { process, pidfd, namespaces, executable, cgroup };
        held.recheck()?;
        Ok(held)
    }
    fn recheck(&self) -> io::Result<()> {
        let pid = self.process.pid;
        if !client::process(pid)?.same_identity(&self.process) || client::uids(pid)? != [0; 4]
            || objects::identity(&objects::pin_magic(format!("/proc/{pid}/exe"))?)? != objects::identity(&self.executable)?
            || objects::bounded_text(format!("/proc/{pid}/cgroup"), 65536)? != self.cgroup {
            return Err(invalid("activation process changed"));
        }
        for (name, held) in ["user", "pid", "mnt", "net"].iter().zip(&self.namespaces) {
            if objects::identity(&objects::pin_magic(format!("/proc/{pid}/ns/{name}"))?)? != objects::identity(held)? {
                return Err(invalid("activation namespace changed"));
            }
        }
        Ok(())
    }
}

pub struct Activation {
    socket_unit: BTreeMap<String, String>,
    daemon_unit: BTreeMap<String, String>,
    systemd: HeldProcess,
    daemon: HeldProcess,
    path: File,
    listeners: Vec<ActivationListener>,
}
struct ActivationListener {
    daemon_number: i32,
    manager_number: i32,
    daemon_socket: File,
    manager_socket: File,
    bound: listener::Listener,
}
fn socket_path() -> io::Result<File> {
    // Unlike /var/run, this fixed initial-host path needs no symlinks.
    let root = objects::pin_magic("/")?;
    let path = objects::pin_beneath(&root, std::ffi::OsStr::new("run/docker.sock"))?;
    let stat = path.metadata()?;
    if !stat.file_type().is_socket() || stat.uid() != 0 || stat.mode() & 0o7777 != 0o660 {
        return Err(invalid("unsafe Docker socket path"));
    }
    Ok(path)
}
fn fixed_listeners(process: &HeldProcess, deadline: Instant) -> io::Result<Vec<(i32, File, listener::Listener)>> {
    let mut result = Vec::new();
    for number in descriptor_numbers(process.process.pid, deadline)? {
        due(deadline)?;
        // This is only a cheap candidate filter. No pathname or sockfs inode
        // text authorizes identity: SIOCUNIXFILE and helper-local kcmp do that.
        let target = fs::read_link(format!("/proc/{}/fd/{number}", process.process.pid))?;
        if !target.as_os_str().as_encoded_bytes().starts_with(b"socket:[") { continue; }
        let socket = File::from(linux::duplicate_process_fd(&process.pidfd, number)?);
        if let Some(bound) = listener::query(&socket)? {
            if result.len() >= 256 { return Err(invalid("fixed listener bound")); }
            result.push((number, socket, bound));
        }
    }
    Ok(result)
}
fn descriptor_numbers(pid: u32, deadline: Instant) -> io::Result<Vec<i32>> {
    let mut numbers = Vec::new();
    for entry in fs::read_dir(format!("/proc/{pid}/fd"))? {
        due(deadline)?;
        if numbers.len() >= 65536 { return Err(invalid("activation FD census bound")); }
        let name = entry?.file_name();
        let number = name.to_str().and_then(|n| n.parse::<i32>().ok()).filter(|n| *n >= 0)
            .ok_or_else(|| invalid("invalid activation FD entry"))?;
        numbers.push(number);
    }
    numbers.sort_unstable();
    Ok(numbers)
}
impl Activation {
    pub fn attest(deadline: Instant) -> io::Result<Self> {
        due(deadline)?;
        linux::initial_namespace_ids()?;
        if !linux::is_real_root() { return Err(invalid("activation proof requires real root")); }
        let socket_unit = unit("docker.socket", deadline)?;
        if socket_unit.get("Triggers").map(String::as_str) != Some("docker.service")
            || socket_unit.get("SocketUser").map(String::as_str) != Some("root")
            || socket_unit.get("SocketGroup").map(String::as_str) != Some("docker")
            || socket_unit.get("SocketMode").map(String::as_str) != Some("0660")
            || !socket_unit.get("Listen").is_some_and(|v| !v.is_empty() && v.split(" (Stream)").filter(|s| !s.trim().is_empty()).all(|s| s.trim() == SOCKET) && v.ends_with(" (Stream)")) {
            return Err(invalid("unsupported Docker activation configuration"));
        }
        let daemon_unit = unit("docker.service", deadline)?;
        let pid = daemon_unit.get("MainPID").and_then(|v| v.parse::<u32>().ok()).filter(|p| *p > 1)
            .ok_or_else(|| invalid("missing daemon main process"))?;
        let systemd = HeldProcess::pin(1)?;
        let daemon = HeldProcess::pin(pid)?;
        if daemon.cgroup.trim() != "0::/system.slice/docker.service"
            || daemon_unit.get("ControlGroup").map(String::as_str) != Some("/system.slice/docker.service") {
            return Err(invalid("daemon cgroup mismatch"));
        }
        // ExecStart is system-manager metadata, but its path must also name the
        // actual immutable executable inode. Never execute this metadata.
        let exec = daemon_unit.get("ExecStart").ok_or_else(|| invalid("missing daemon executable metadata"))?;
        let exec_path = exec.split("path=").nth(1).and_then(|v| v.split(" ;").next())
            .filter(|v| v.starts_with("/nix/store/") && v.ends_with("/bin/dockerd") && !v.contains(char::is_whitespace))
            .ok_or_else(|| invalid("unsupported daemon executable"))?;
        let expected_exe = objects::pin_magic(exec_path)?;
        if expected_exe.metadata()?.uid() != 0 || expected_exe.metadata()?.mode() & 0o022 != 0
            || objects::identity(&expected_exe)? != objects::identity(&daemon.executable)? {
            return Err(invalid("daemon executable identity mismatch"));
        }
        let path = socket_path()?;
        let managers = fixed_listeners(&systemd, deadline)?;
        let mut listeners = Vec::new();
        for (number, socket, bound) in fixed_listeners(&daemon, deadline)? {
            let mut same = None;
            for (manager_number, manager_socket, _) in &managers {
                due(deadline)?;
                if linux::same_open_file(&socket, manager_socket)? {
                    bound.recheck(manager_socket)?;
                    same = Some((*manager_number, manager_socket.try_clone()?));
                    break;
                }
            }
            let (manager_number, manager_socket) = same.ok_or_else(|| invalid("fixed listener not shared by PID1 and dockerd"))?;
            listeners.push(ActivationListener { daemon_number: number, manager_number, daemon_socket: socket, manager_socket, bound });
        }
        // Trusted systemd/Docker normal descriptor delegation is a premise,
        // not an exhaustive host-wide sole-holder claim. Every discovered
        // fixed activation object must nevertheless be shared by both peers.
        for (_, manager_socket, _) in &managers {
            let mut shared = false;
            for held in &listeners {
                if linux::same_open_file(manager_socket, &held.daemon_socket)? { shared = true; break; }
            }
            if !shared { return Err(invalid("unexpected fixed activation delegation")); }
        }
        let mut current = 0;
        for (index, held) in listeners.iter().enumerate() {
            if held.bound.matches_path(&path)? {
                let mut alias = false;
                for previous in &listeners[..index] {
                    if linux::same_open_file(&held.daemon_socket, &previous.daemon_socket)? { alias = true; break; }
                }
                if !alias { current += 1; }
            }
        }
        if current != 1 { return Err(invalid("ambiguous or absent current Docker listener")); }
        let proof = Self { socket_unit, daemon_unit, systemd, daemon, path, listeners };
        proof.recheck(deadline)?;
        Ok(proof)
    }
    pub fn recheck(&self, deadline: Instant) -> io::Result<()> {
        due(deadline)?;
        self.systemd.recheck()?;
        self.daemon.recheck()?;
        let path = socket_path()?;
        if unit("docker.socket", deadline)? != self.socket_unit || unit("docker.service", deadline)? != self.daemon_unit
            || objects::identity(&path)? != objects::identity(&self.path)?
            || objects::mount_id(&path)? != objects::mount_id(&self.path)? {
            return Err(invalid("Docker activation generation changed"));
        }
        for held in &self.listeners {
            due(deadline)?;
            if !linux::same_open_file(&held.daemon_socket, &held.manager_socket)? {
                return Err(invalid("held activation OFDs differ"));
            }
            held.bound.recheck(&held.daemon_socket)?;
            held.bound.recheck(&held.manager_socket)?;
            for (process, number, socket) in [
                (&self.daemon, held.daemon_number, &held.daemon_socket),
                (&self.systemd, held.manager_number, &held.manager_socket),
            ] {
                let actual = File::from(linux::duplicate_process_fd(&process.pidfd, number)?);
                if !linux::same_open_file(&actual, socket)? {
                    return Err(invalid("Docker activation listener descriptor changed"));
                }
                held.bound.recheck(&actual)?;
            }
        }
        for process in [&self.daemon, &self.systemd] {
            for (_, socket, _) in fixed_listeners(process, deadline)? {
                let mut known = false;
                for held in &self.listeners {
                    if linux::same_open_file(&socket, &held.daemon_socket)? { known = true; break; }
                }
                if !known { return Err(invalid("unexpected new fixed activation object")); }
            }
        }
        Ok(())
    }
}

pub enum Resource { Container, Image }
pub struct Response { pub body: Vec<u8>, stream: UnixStream }
impl Response {
    pub fn recheck(&self, activation: &Activation, deadline: Instant) -> io::Result<()> {
        due(deadline)?;
        let peer = linux::socket_peer(&self.stream)?;
        if peer.pid != 1 || peer.uid != 0 || peer.gid != 0 { return Err(invalid("activated connection peer changed")); }
        activation.recheck(deadline)
    }
}
pub fn get(activation: &Activation, resource: Resource, deadline: Instant) -> io::Result<Response> {
    activation.recheck(deadline)?;
    let mut stream = linux::connect_unix(SOCKET, deadline)?;
    let peer = linux::socket_peer(&stream)?;
    if peer.pid != 1 || peer.uid != 0 || peer.gid != 0 { return Err(invalid("unattested activated Docker peer")); }
    activation.recheck(deadline)?;
    validate_policy()?;
    let resource = match resource {
        Resource::Container => format!("/containers/{}/json", env!("HOLDER_EVIDENCE_MANAGED_CONTAINER")),
        Resource::Image => format!("/images/{}/json", env!("HOLDER_EVIDENCE_MANAGED_IMAGE")),
    };
    stream.set_write_timeout(Some(deadline.saturating_duration_since(Instant::now()).min(Duration::from_secs(2))))?;
    let request = format!("GET {resource} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes())?;
    let mut bytes = Vec::with_capacity(16384);
    let mut buffer = [0; 16384];
    loop {
        due(deadline)?;
        stream.set_read_timeout(Some(deadline.saturating_duration_since(Instant::now()).min(Duration::from_secs(2))))?;
        let count = stream.read(&mut buffer)?;
        if count == 0 { break; }
        if bytes.len() + count > MAX_RESPONSE + MAX_HEADER { return Err(invalid("oversized daemon response")); }
        bytes.extend_from_slice(&buffer[..count]);
    }
    let response = Response { body: decode_response(bytes)?, stream };
    response.recheck(activation, deadline)?;
    Ok(response)
}
fn decode_response(mut bytes: Vec<u8>) -> io::Result<Vec<u8>> {
    let end = bytes.windows(4).position(|b| b == b"\r\n\r\n").ok_or_else(|| invalid("incomplete daemon header"))?;
    if end > MAX_HEADER { return Err(invalid("oversized daemon header")); }
    let header = std::str::from_utf8(&bytes[..end]).map_err(|_| invalid("non-text daemon header"))?;
    let mut lines = header.split("\r\n");
    if !matches!(lines.next(), Some("HTTP/1.0 200 OK" | "HTTP/1.1 200 OK")) { return Err(invalid("daemon response not successful")); }
    let mut length = None;
    let mut content_type = false;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or_else(|| invalid("malformed daemon header"))?;
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return Err(invalid("invalid daemon header name")); }
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) { return Err(invalid("ambiguous daemon length")); }
            length = Some(value.parse::<usize>().map_err(|_| invalid("daemon length overflow"))?);
        } else if name.eq_ignore_ascii_case("transfer-encoding") || (name.eq_ignore_ascii_case("content-encoding") && value != "identity") {
            return Err(invalid("encoded daemon response"));
        } else if name.eq_ignore_ascii_case("content-type") {
            if content_type || value.split(';').next().map(str::trim) != Some("application/json") { return Err(invalid("non-JSON daemon response")); }
            content_type = true;
        }
    }
    let actual = bytes.len() - end - 4;
    if !content_type || actual == 0 || actual > MAX_RESPONSE || length.is_some_and(|n| n != actual) { return Err(invalid("incomplete daemon body")); }
    bytes.drain(..end + 4);
    Ok(bytes)
}

pub(super) fn validate_policy() -> io::Result<()> {
    if !identifier(env!("HOLDER_EVIDENCE_MANAGED_CONTAINER"), false)
        || !identifier(env!("HOLDER_EVIDENCE_MANAGED_IMAGE"), true)
    { return Err(invalid("invalid compiled managed Docker identifier")); }
    Ok(())
}

fn identifier(value: &str, image: bool) -> bool {
    !value.is_empty() && value.len() <= 255
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric()
            || matches!(byte, b'_' | b'-' | b'.')
            || (image && matches!(byte, b'/' | b':' | b'@')))
        && !value.split('/').any(|part| part.is_empty() || part == "." || part == "..")
}

#[cfg(test)]
mod tests {
    use super::{decode_response, identifier};

    #[test]
    fn policy_identifiers_cannot_inject_jq_or_http() {
        assert!(identifier("managed-worker", false));
        assert!(identifier("registry.example/team/worker:current", true));
        for value in ["", "/worker", "worker\r\nX: y", "worker\" or true", "a/../b", "a//b"] {
            assert!(!identifier(value, true));
        }
        assert!(!identifier("team/worker", false));
    }

    #[test]
    fn response_requires_unambiguous_complete_json_bytes() {
        assert_eq!(decode_response(b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}".to_vec()).unwrap(), b"{}");
        for response in [
            "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: 3\r\n\r\n{}",
            "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
            "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n{}",
            "HTTP/1.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n{}",
        ] { assert!(decode_response(response.as_bytes().to_vec()).is_err()); }
    }
}
