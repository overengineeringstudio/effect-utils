//! A closed Unix-socket action host. No shell, generic exec, or responsibility disclaim.
use regex::Regex;
use serde::Deserialize;
use parking_lot::Mutex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::ffi::CString;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const SOURCE_HASH: &str = env!("HOST_SOURCE_HASH");
const VERSION: &str = "1";
const MAX_REQUEST_FRAME: usize = 65536;
// JSON escaping can expand both 16-KiB output tails by six times.
const MAX_RESPONSE_FRAME: usize = 262144;
const TAIL_LIMIT: usize = 16384;
const MAX_CONNECTIONS: usize = 32;
const READ_TIMEOUT: Duration = Duration::from_secs(5);
static STOP: AtomicBool = AtomicBool::new(false);
extern "C" fn stop(_: libc::c_int) { STOP.store(true, Ordering::Relaxed); }
#[derive(Debug)]
struct Failure { code: &'static str, message: String }
type Result<T, E = Failure> = std::result::Result<T, E>;
fn failure(code: &'static str, message: impl Into<String>) -> Failure { Failure { code, message: message.into() } }
impl From<io::Error> for Failure { fn from(e: io::Error) -> Self { failure("io", e.to_string()) } }
impl From<serde_json::Error> for Failure { fn from(e: serde_json::Error) -> Self { failure("invalidRequest", e.to_string()) } }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request { #[serde(rename = "wireVersion")] wire_version: u32, action: String, args: BTreeMap<String, Value> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Manifest { manifest_version: u32, generation: String, actions: BTreeMap<String, Action>, status_allowed_uids: Vec<u32>, socket_mode: u32 }
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Action { executable: PathBuf, sha256: String, argv: Vec<String>, args: Vec<Arg>, allowed_uids: Vec<u32>, timeout_ms: u64, concurrency: u32 }
#[derive(Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Arg {
    #[serde(rename = "enum")]
    Enum { name: String, values: Vec<String> },
    #[serde(rename = "string")]
    String { name: String, #[serde(rename = "maxLength")] max_length: usize, pattern: String },
    #[serde(rename = "integer")]
    Integer { name: String, min: i64, max: i64 },
}
impl Arg {
    fn name(&self) -> &str { match self { Self::Enum { name, .. } | Self::String { name, .. } | Self::Integer { name, .. } => name } }
    fn validate(&self, value: &Value) -> Result<String> {
        let invalid = || failure("invalidArgs", format!("Invalid argument {}", self.name()));
        let result = match self {
            Self::Enum { values, .. } => {
                let text = value.as_str().ok_or_else(invalid)?;
                if !values.iter().any(|v| v == text) { return Err(invalid()); }
                text.to_owned()
            }
            Self::String { max_length, pattern, .. } => {
                let text = value.as_str().ok_or_else(invalid)?;
                if text.chars().count() > *max_length { return Err(invalid()); }
                let regex = Regex::new(&format!("\\A(?:{pattern})\\z")).map_err(|e| failure("manifest", e.to_string()))?;
                if !regex.is_match(text) { return Err(invalid()); }
                text.to_owned()
            }
            Self::Integer { min, max, .. } => {
                // The CLI preserves strings; integer declarations parse canonical decimal strings.
                let number = value.as_i64().or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok().filter(|n| n.to_string() == text))).ok_or_else(invalid)?;
                if number < *min || number > *max { return Err(invalid()); }
                number.to_string()
            }
        };
        if result.contains('\0') { return Err(invalid()); }
        Ok(result)
    }
}
fn read_frame(stream: &UnixStream, limit: usize, deadline: Option<Instant>) -> Result<Vec<u8>> {
    let mut reader = BufReader::new(stream);
    let mut bytes = Vec::new();
    loop {
        if let Some(end) = deadline {
            let remaining = end.checked_duration_since(Instant::now()).filter(|d| !d.is_zero())
                .ok_or_else(|| failure("requestTimeout", "Frame read deadline exceeded"))?;
            stream.set_read_timeout(Some(remaining))?;
        }
        let available = reader.fill_buf().map_err(|error| {
            if deadline.is_some() && matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock) {
                failure("requestTimeout", "Frame read deadline exceeded")
            } else { error.into() }
        })?;
        if available.is_empty() { return Err(failure("invalidRequest", "Incomplete frame")); }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |index| index + 1);
        if bytes.len() + count > limit { return Err(failure("invalidRequest", "Oversized frame")); }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if newline.is_some() { return Ok(bytes); }
    }
}
fn write_frame(mut stream: &UnixStream, response: &Value) -> Result<()> {
    serde_json::to_writer(&mut stream, response)?; stream.write_all(b"\n")?; Ok(())
}
// The unsafe boundary is limited to Darwin identity/spawn/wait APIs. All descriptors
// are owned, C strings are checked, and native structures are initialized before use.
fn peer_uid(stream: &UnixStream) -> Result<u32> {
    let mut uid = 0; let mut gid = 0;
    // SAFETY: the connected descriptor is live and both output pointers are valid.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 { return Err(failure("unauthorized", "Cannot authenticate peer")); }
    Ok(uid)
}
fn pipe() -> Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    // SAFETY: pipe receives space for exactly two descriptors.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 { return Err(io::Error::last_os_error().into()); }
    // SAFETY: successful pipe returned two fresh owned descriptors.
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}
fn tail(fd: OwnedFd, deadline: Instant) -> thread::JoinHandle<io::Result<String>> {
    thread::spawn(move || {
        let mut input = File::from(fd); let mut bytes = VecDeque::with_capacity(TAIL_LIMIT); let mut buffer = [0; 4096];
        loop {
            if Instant::now() >= deadline { break; }
            let mut ready = libc::pollfd { fd: input.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            // SAFETY: poll borrows one initialized entry and the file remains live.
            let polled = unsafe { libc::poll(&mut ready, 1, 100) };
            if polled == 0 { continue; }
            if polled < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted { continue; }
                return Err(error);
            }
            let count = match input.read(&mut buffer) { Ok(n) => n, Err(e) if e.kind() == io::ErrorKind::Interrupted => continue, Err(e) => return Err(e) };
            if count == 0 { break; }
            let excess = (bytes.len() + count).saturating_sub(TAIL_LIMIT);
            bytes.drain(..excess); bytes.extend(&buffer[..count]);
        }
        Ok(String::from_utf8_lossy(bytes.make_contiguous()).into_owned())
    })
}
#[link(name = "Security", kind = "framework")]
unsafe extern "C" { fn SessionGetInfo(session: u32, id: *mut u32, attributes: *mut u32) -> i32; }
/// The host's own security (audit) session: GUI login sessions carry graphic access;
/// the root session holds startup/system programs with no user session.
fn session_kind(status: i32, attributes: u32) -> &'static str {
    const IS_ROOT: u32 = 0x0001;
    const HAS_GRAPHIC_ACCESS: u32 = 0x0010;
    if status != 0 || attributes & IS_ROOT != 0 { "no-session" } else if attributes & HAS_GRAPHIC_ACCESS != 0 { "gui" } else { "background-only" }
}
fn session() -> &'static str {
    let (mut id, mut attributes) = (0, 0);
    // SAFETY: callerSecuritySession (u32::MAX) asks about this process; both outputs are valid.
    let status = unsafe { SessionGetInfo(u32::MAX, &mut id, &mut attributes) };
    session_kind(status, attributes)
}
fn native_result(code: i32) -> Result<()> { if code == 0 { Ok(()) } else { Err(failure("spawn", io::Error::from_raw_os_error(code).to_string())) } }
fn spawn(path: &Path, args: Vec<String>, timeout_ms: u64) -> Result<Value> {
    use std::os::unix::ffi::OsStrExt;
    let executable = CString::new(path.as_os_str().as_bytes()).map_err(|_| failure("manifest", "NUL in executable"))?;
    let mut strings = vec![executable.clone()];
    for arg in args { strings.push(CString::new(arg).map_err(|_| failure("manifest", "NUL in argv"))?); }
    let mut argv: Vec<_> = strings.iter().map(|s| s.as_ptr().cast_mut()).collect(); argv.push(std::ptr::null_mut());
    let environment = [CString::new("PATH=/usr/bin:/bin").unwrap(), CString::new("LANG=C").unwrap()];
    let mut env: Vec<_> = environment.iter().map(|s| s.as_ptr().cast_mut()).collect(); env.push(std::ptr::null_mut());
    let (out_read, out_write) = pipe()?; let (err_read, err_write) = pipe()?;
    // SAFETY: Darwin initialization APIs write these opaque structs before use.
    let mut files = unsafe { std::mem::zeroed() }; let mut attr = unsafe { std::mem::zeroed() };
    unsafe { native_result(libc::posix_spawn_file_actions_init(&mut files))?; }
    struct Files(libc::posix_spawn_file_actions_t);
    impl Drop for Files { fn drop(&mut self) { unsafe { libc::posix_spawn_file_actions_destroy(&mut self.0); } } }
    let mut files = Files(files);
    unsafe { native_result(libc::posix_spawnattr_init(&mut attr))?; }
    struct Attr(libc::posix_spawnattr_t);
    impl Drop for Attr { fn drop(&mut self) { unsafe { libc::posix_spawnattr_destroy(&mut self.0); } } }
    let mut attr = Attr(attr);
    // SAFETY: initialized structures, live descriptors, and NUL-terminated strings
    // remain valid until posix_spawn returns. No responsibility-disclaim flag is set.
    let mut pid = 0;
    unsafe {
        native_result(libc::posix_spawn_file_actions_addopen(&mut files.0, 0, c"/dev/null".as_ptr(), libc::O_RDONLY, 0))?;
        native_result(libc::posix_spawn_file_actions_adddup2(&mut files.0, out_write.as_raw_fd(), 1))?;
        native_result(libc::posix_spawn_file_actions_adddup2(&mut files.0, err_write.as_raw_fd(), 2))?;
        for fd in [&out_read, &out_write, &err_read, &err_write] { native_result(libc::posix_spawn_file_actions_addclose(&mut files.0, fd.as_raw_fd()))?; }
        native_result(libc::posix_spawnattr_setflags(&mut attr.0, (libc::POSIX_SPAWN_SETPGROUP | libc::POSIX_SPAWN_CLOEXEC_DEFAULT) as i16))?;
        native_result(libc::posix_spawnattr_setpgroup(&mut attr.0, 0))?;
        native_result(libc::posix_spawn(&mut pid, executable.as_ptr(), &files.0, &attr.0, argv.as_ptr(), env.as_ptr()))?;
    }
    drop(out_write); drop(err_write);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let out = tail(out_read, deadline); let err = tail(err_read, deadline);
    let mut status = 0; let mut timed_out = false;
    loop {
        // SAFETY: pid belongs to this invocation; status points to a valid integer.
        let waited = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if waited == pid { break; }
        if waited < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            unsafe { libc::kill(-pid, libc::SIGKILL); }
            return Err(failure("spawn", "waitpid failed"));
        }
        if Instant::now() >= deadline {
            timed_out = true;
            unsafe { libc::kill(-pid, libc::SIGKILL); }
            while unsafe { libc::waitpid(pid, &mut status, 0) } < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {}
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    // Kill descendants in the invocation's process group; capture is independently bounded.
    unsafe { libc::kill(-pid, libc::SIGKILL); }
    let stdout = out.join().map_err(|_| failure("spawn", "stdout reader panicked"))??;
    let stderr = err.join().map_err(|_| failure("spawn", "stderr reader panicked"))??;
    if timed_out { return Err(failure("timeout", "Action exceeded timeout")); }
    let exit_code = if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 128 + libc::WTERMSIG(status) };
    Ok(json!({"exitCode": exit_code, "stdoutTail": stdout, "stderrTail": stderr}))
}
struct Server { pointer: PathBuf, running: Mutex<HashSet<String>> }
struct Permit<'a> { server: &'a Server, action: String }
impl Drop for Permit<'_> { fn drop(&mut self) { self.server.running.lock().remove(&self.action); } }
impl Server {
    fn respond(&self, request: Request, uid: u32) -> Result<Value> {
        if request.wire_version != 1 || !request.args.values().all(|v| v.is_string() || v.as_i64().is_some()) { return Err(failure("invalidRequest", "Unsupported wire version or argument value")); }
        let manifest = load_manifest(&self.pointer)?;
        if manifest.manifest_version != 1 { return Err(failure("manifest", "Unsupported manifest version")); }
        if request.action == "status" {
            if !manifest.status_allowed_uids.contains(&uid) { return Err(failure("unauthorized", "Caller UID not allowed")); }
            if !request.args.is_empty() { return Err(failure("invalidArgs", "Status accepts no arguments")); }
            return Ok(json!({"wireVersion": 1, "ok": true, "status": {"hostVersion": VERSION, "hostSourceHash": SOURCE_HASH, "generation": manifest.generation, "pid": std::process::id(), "session": session()}}));
        }
        let action = manifest.actions.get(&request.action).ok_or_else(|| failure("unknownAction", "Action not declared"))?;
        if !action.allowed_uids.contains(&uid) { return Err(failure("unauthorized", "Caller UID not allowed")); }
        if action.concurrency != 1 || action.timeout_ms == 0 { return Err(failure("manifest", "Invalid concurrency or timeout")); }
        let names: HashSet<_> = action.args.iter().map(Arg::name).collect();
        if names.len() != action.args.len() || names.len() != request.args.len() || !request.args.keys().all(|k| names.contains(k.as_str())) { return Err(failure("invalidArgs", "Unexpected or missing arguments")); }
        let mut args = action.argv.clone();
        for schema in &action.args { args.push(schema.validate(&request.args[schema.name()])?); }
        if !self.running.lock().insert(request.action.clone()) { return Err(failure("busy", "Action already running")); }
        let _permit = Permit { server: self, action: request.action };
        let resolved = fs::canonicalize(&action.executable)?;
        if !action.executable.starts_with("/nix/store") || !resolved.starts_with("/nix/store") { return Err(failure("payload", "Payload outside Nix store")); }
        let mut payload = File::open(&resolved)?; let mut hash = Sha256::new(); let mut buffer = [0; 65536];
        loop { let n = payload.read(&mut buffer)?; if n == 0 { break; } hash.update(&buffer[..n]); }
        if format!("{:x}", hash.finalize()) != action.sha256 { return Err(failure("payloadHashMismatch", "Payload hash differs")); }
        let mut result = spawn(&resolved, args, action.timeout_ms)?; result["generation"] = json!(manifest.generation);
        Ok(json!({"wireVersion": 1, "ok": true, "result": result}))
    }
}
fn load_manifest(pointer: &Path) -> Result<Manifest> {
    serde_json::from_reader(File::open(pointer.join("manifest.json"))?)
        .map_err(|e| failure("manifest", e.to_string()))
}
struct SocketGuard { path: PathBuf, device: u64, inode: u64 }
impl Drop for SocketGuard {
    fn drop(&mut self) {
        if let Ok(metadata) = fs::symlink_metadata(&self.path) {
            if metadata.dev() == self.device && metadata.ino() == self.inode {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}
fn bind_socket(path: &Path) -> Result<(UnixListener, SocketGuard)> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_socket() { return Err(failure("socket", "Existing path is not a socket")); }
            match UnixStream::connect(path) {
                Ok(_) => return Err(failure("socket", "A listener already owns the socket")),
                Err(error) if error.raw_os_error() == Some(libc::ECONNREFUSED) => {
                    let current = fs::symlink_metadata(path)?;
                    if current.dev() != metadata.dev() || current.ino() != metadata.ino() {
                        return Err(failure("socket", "Socket changed during stale-listener check"));
                    }
                    fs::remove_file(path)?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let listener = UnixListener::bind(path)?;
    let metadata = fs::symlink_metadata(path)?;
    Ok((listener, SocketGuard { path: path.to_owned(), device: metadata.dev(), inode: metadata.ino() }))
}
struct ConnectionPermit(Arc<AtomicUsize>);
impl Drop for ConnectionPermit {
    fn drop(&mut self) { self.0.fetch_sub(1, Ordering::Relaxed); }
}
fn main_impl() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() < 3 || args[1] != "--socket" { return Err(failure("usage", "serve --socket PATH --generation-pointer PATH | call --socket PATH ACTION [--arg k=v]")); }
    match args[0].as_str() {
        "serve" => {
            if args.len() != 5 || args[3] != "--generation-pointer" { return Err(failure("usage", "Missing generation pointer")); }
            let pointer = PathBuf::from(&args[4]);
            let manifest = load_manifest(&pointer)?;
            if ![0o600, 0o660, 0o666].contains(&manifest.socket_mode) {
                return Err(failure("manifest", "Unsupported socket mode"));
            }
            // SAFETY: the handler only stores a lock-free atomic flag.
            unsafe { libc::signal(libc::SIGTERM, stop as *const () as libc::sighandler_t); }
            let (listener, _socket_guard) = bind_socket(Path::new(&args[2]))?;
            fs::set_permissions(&args[2], fs::Permissions::from_mode(manifest.socket_mode))?;
            listener.set_nonblocking(true)?;
            let server = Arc::new(Server { pointer, running: Mutex::new(HashSet::new()) });
            let connections = Arc::new(AtomicUsize::new(0));
            while !STOP.load(Ordering::Relaxed) {
                let stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20)); continue;
                    }
                    Err(error) if matches!(error.raw_os_error(), Some(libc::EINTR | libc::ECONNABORTED | libc::EMFILE | libc::ENFILE | libc::ENOBUFS | libc::ENOMEM)) => {
                        thread::sleep(Duration::from_millis(100)); continue;
                    }
                    Err(error) => return Err(error.into()),
                };
                if connections.load(Ordering::Relaxed) >= MAX_CONNECTIONS { continue; }
                connections.fetch_add(1, Ordering::Relaxed);
                let permit = ConnectionPermit(Arc::clone(&connections));
                let server = Arc::clone(&server);
                let deadline = Instant::now() + READ_TIMEOUT;
                if thread::Builder::new().spawn(move || {
                    let _permit = permit;
                    let result = (|| {
                        let uid = peer_uid(&stream)?;
                        stream.set_nonblocking(false)?;
                        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
                        server.respond(serde_json::from_slice(&read_frame(&stream, MAX_REQUEST_FRAME, Some(deadline))?)?, uid)
                    })();
                    let response = match result { Ok(value) => value, Err(e) => json!({"wireVersion": 1, "ok": false, "error": {"code": e.code, "message": e.message}}) };
                    let _ = write_frame(&stream, &response);
                }).is_err() {
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
        "call" => {
            if args.len() < 4 { return Err(failure("usage", "Missing action")); }
            let mut values = BTreeMap::new();
            for pair in args[4..].chunks(2) {
                if pair.len() != 2 || pair[0] != "--arg" { return Err(failure("usage", "Expected --arg k=v")); }
                let (key, value) = pair[1].split_once('=').ok_or_else(|| failure("usage", "Expected --arg k=v"))?;
                if values.insert(key, value).is_some() { return Err(failure("usage", "Duplicate argument")); }
            }
            let stream = UnixStream::connect(&args[2])?;
            write_frame(&stream, &json!({"wireVersion": 1, "action": args[3], "args": values}))?;
            let response: Value = serde_json::from_slice(&read_frame(&stream, MAX_RESPONSE_FRAME, None)?)?;
            println!("{response}");
            if response["ok"] != true { std::process::exit(1); }
        }
        _ => return Err(failure("usage", "Unknown mode")),
    }
    Ok(())
}
fn main() { if let Err(e) = main_impl() { eprintln!("{}: {}", e.code, e.message); std::process::exit(1); } }

#[cfg(test)]
mod tests {
    #[test]
    fn session_kind_follows_audit_session_bits() {
        assert_eq!(super::session_kind(0, 0x0010 | 0x0020), "gui");
        assert_eq!(super::session_kind(0, 0x0020), "background-only");
        assert_eq!(super::session_kind(0, 0x0001), "no-session");
        assert_eq!(super::session_kind(0, 0x0001 | 0x0010), "no-session");
        assert_eq!(super::session_kind(-1, 0x0010), "no-session");
    }
}
