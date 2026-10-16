//! Nonresident primitives. The consumer serializes calls and owns transaction policy.
use serde_json::{json, Value};
use std::{collections::BTreeMap, ffi::{c_char, c_void, CString}, fs::{self, File}, io::{self, BufRead, BufReader, Read, Write}, os::{fd::{AsRawFd, FromRawFd}, unix::{fs::{symlink, MetadataExt, PermissionsExt}, net::UnixStream}}, path::{Path, PathBuf}, process::{Command, Output}, time::{Duration, Instant}};

type Result<T, E = Failure> = std::result::Result<T, E>;
#[derive(Debug)]
struct Failure { code: i32, kind: &'static str, category: Option<&'static str>, reason: String }
fn fail(code: i32, kind: &'static str, reason: impl Into<String>) -> Failure { Failure { code, kind, category: None, reason: reason.into() } }
fn signing(category: &'static str, reason: impl Into<String>) -> Failure { Failure { code: 20, kind: "signing-failed", category: Some(category), reason: reason.into() } }
fn mismatch(reason: impl Into<String>) -> Failure { fail(22, "verification-failed", reason) }
impl From<io::Error> for Failure { fn from(e: io::Error) -> Self { fail(23, "operation-failed", e.to_string()) } }
impl From<serde_json::Error> for Failure { fn from(e: serde_json::Error) -> Self { fail(64, "invalid-input", e.to_string()) } }
struct Ctl { config: Value, args: BTreeMap<String, String> }
fn command(program: &str, args: &[&str]) -> Result<Output> { Ok(Command::new(program).args(args).output()?) }
fn checked(program: &str, args: &[&str]) -> Result<Output> { let out = command(program, args)?; if !out.status.success() { return Err(fail(23, "operation-failed", format!("{program}: {}", String::from_utf8_lossy(&out.stderr)))); } Ok(out) }
fn text(path: &Path) -> Result<&str> { path.to_str().ok_or_else(|| fail(64, "invalid-input", "Paths must be UTF-8")) }
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> { let tmp = path.with_extension(format!("tmp-{}", std::process::id())); let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?; f.write_all(bytes)?; f.sync_all()?; fs::rename(tmp, path)?; Ok(()) }
fn pointer(path: &Path) -> Option<PathBuf> { fs::read_link(path).ok() }
fn select(path: &Path, target: &Path) -> Result<()> { let tmp = path.with_extension(format!("tmp-{}", std::process::id())); symlink(target, &tmp)?; fs::rename(tmp, path)?; Ok(()) }
fn remove_if_present(path: &Path) -> Result<()> { match fs::remove_file(path) { Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()), _ => Ok(()) } }
fn hash(app: &Path) -> Option<String> { fs::read_to_string(app.join("Contents/Resources/host-source-hash")).ok().map(|s| s.trim().to_owned()) }
/// Session-dependent bundle metadata. Codesign seals but never rewrites Info.plist,
/// so the unsigned desired bundle and the signed installed bundle compare byte-equal.
fn metadata_digest(app: &Path) -> Option<String> { use sha2::Digest; fs::read(app.join("Contents/Info.plist")).ok().map(|b| format!("{:x}", sha2::Sha256::digest(b))) }
fn inode(path: &Path) -> Option<u64> { fs::symlink_metadata(path).ok().map(|m| m.ino()) }
fn socket_mode(path: &str) -> Option<u32> { fs::metadata(path).ok().map(|m| m.permissions().mode() & 0o777) }
fn signing_failure_marker(app: &Path) -> PathBuf { app.with_extension("signing-failed.json") }
fn archive_pointer(app: &Path) -> PathBuf { app.with_extension("previous") }
fn transaction_record(app: &Path) -> PathBuf { app.with_extension("txn.json") }
fn rollback_record(app: &Path) -> PathBuf { app.with_extension("rollback.json") }
fn read_json(path: &Path) -> Result<Option<Value>> { fs::read(path).ok().map(|b| serde_json::from_slice(&b)).transpose().map_err(Failure::from) }
/// The archive path, target generation and restored-host inode of a host-rollback record.
fn rollback_fields(record: &Value) -> Result<(PathBuf, PathBuf, Option<u64>)> {
    let corrupt = || fail(64, "invalid-input", "Corrupt host-rollback record");
    let archive = PathBuf::from(record["archive"].as_str().ok_or_else(corrupt)?);
    let target = PathBuf::from(record["targetGeneration"].as_str().ok_or_else(corrupt)?);
    Ok((archive, target, Some(record["restoredInode"].as_u64().ok_or_else(corrupt)?)))
}
/// Post-commit cleanup: a failure is reported as a leftover path and never undoes the commit.
fn remove_leftover(path: &Path) -> Option<PathBuf> {
    if !path.exists() { return None; }
    if failpoint("cleanup") || fs::remove_dir_all(path).is_err() { Some(path.to_owned()) } else { None }
}
/// Test-only failpoints can force failure or crash paths; they cannot make any check pass.
fn failpoint(name: &str) -> bool { std::env::var("MACOS_APP_CTL_TEST_FAILPOINT").is_ok_and(|v| v == name) }
fn exchange(a: &Path, b: &Path) -> Result<()> {
    let a = CString::new(text(a)?).map_err(|e| fail(64, "invalid-input", e.to_string()))?;
    let b = CString::new(text(b)?).map_err(|e| fail(64, "invalid-input", e.to_string()))?;
    // SAFETY: both C strings live for the call. RENAME_SWAP exchanges entries atomically
    // on one filesystem; no fallback may temporarily remove the installed bundle.
    if unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) } != 0 { return Err(io::Error::last_os_error().into()); }
    Ok(())
}
fn xml(s: &str) -> String { s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;") }
fn plist(value: &Value) -> Result<String> { Ok(match value {
    Value::Bool(v) => format!("<{} />", if *v { "true" } else { "false" }),
    Value::String(v) => format!("<string>{}</string>", xml(v)),
    Value::Number(v) if v.is_i64() || v.is_u64() => format!("<integer>{v}</integer>"),
    Value::Array(values) => format!("<array>{}</array>", values.iter().map(plist).collect::<Result<Vec<_>>>()?.join("")),
    Value::Object(values) => { let mut s = String::from("<dict>"); for (k, v) in values { s.push_str(&format!("<key>{}</key>{}", xml(k), plist(v)?)); } s.push_str("</dict>"); s },
    _ => return Err(fail(64, "invalid-input", "Unsupported plist value")),
}) }
/// Canonical requirement text, so equal requirements compare equal regardless of quoting.
fn canonical_requirement(requirement: &str) -> Result<String> {
    let out = checked("/usr/bin/csreq", &[&format!("-r={requirement}"), "-t"])?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}
/// Domain selection per session kind. Explicit overrides obey the same rules as `auto`.
fn resolve_domain(kind: &str, requested: &str, session: &str, uid: u32) -> Result<String> {
    let invalid = || Err(fail(64, "invalid-input", format!("Domain {requested} is not allowed for {kind}")));
    let gui = || if session == "gui" { Ok(format!("gui/{uid}")) } else { Err(fail(21, "gui-absent", "gui/<uid> is absent; no job operation was attempted")) };
    match (kind, requested) {
        ("system-daemon", "auto" | "system") => Ok("system".to_owned()),
        ("gui-agent", "auto" | "gui") | ("background-agent", "gui") => gui(),
        ("background-agent", "auto") if session == "gui" => Ok(format!("gui/{uid}")),
        ("background-agent", "auto" | "user") if session != "no-session" => Ok(format!("user/{uid}")),
        ("background-agent", "auto" | "user") => Err(fail(21, "no-session", "No user launchd domain")),
        _ => invalid(),
    }
}

/// Session loading is contract-owned, not a consumer extra: user domains are Background,
/// GUI domains are Aqua, and system daemons have no agent session restriction.
fn apply_launchd_session_type(object: &mut serde_json::Map<String, Value>, kind: &str, domain: &str) -> Result<()> {
    let session = match (kind, domain) {
        ("gui-agent" | "background-agent", domain) if domain.starts_with("gui/") => Some("Aqua"),
        ("background-agent", domain) if domain.starts_with("user/") => Some("Background"),
        ("system-daemon", "system") => None,
        _ => return Err(fail(64, "invalid-input", format!("Domain {domain} is not allowed for {kind}"))),
    };
    object.remove("LimitLoadToSessionType");
    if let Some(session) = session { object.insert("LimitLoadToSessionType".into(), json!(session)); }
    Ok(())
}

// A crate root's `mod` resolves beside it, where Cargo would also treat a file as a binary.
#[path = "macos-app-ctl/keys.rs"]
mod keys;
#[path = "macos-app-ctl/artifact.rs"]
mod artifact;
#[path = "macos-app-ctl/releases.rs"]
mod releases;
#[path = "macos-app-ctl/launchd.rs"]
mod launchd;
#[path = "macos-app-ctl/supplied.rs"]
mod supplied;
#[path = "macos-app-ctl/lifecycle.rs"]
mod lifecycle;
#[cfg(feature = "test-signing-cert")]
#[path = "macos-app-ctl/helper_probe.rs"]
mod helper_probe;

// A nonblocking self-pipe wakes the owning thread. The handler only stores a lock-free
// atomic and writes one byte; child teardown and checked locks happen outside the handler.
static STOP_SIGNAL: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static SIGNAL_READ: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);
static SIGNAL_WRITE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);
struct SignalPipe { _read: File, _write: File }
impl Drop for SignalPipe {
    fn drop(&mut self) {
        SIGNAL_READ.store(-1, std::sync::atomic::Ordering::Relaxed);
        SIGNAL_WRITE.store(-1, std::sync::atomic::Ordering::Relaxed);
    }
}
extern "C" fn request_stop(signal: i32) {
    STOP_SIGNAL.store(signal, std::sync::atomic::Ordering::Relaxed);
    let fd = SIGNAL_WRITE.load(std::sync::atomic::Ordering::Relaxed);
    if fd >= 0 {
        // SAFETY: write is async-signal-safe, nonblocking, and consumes one stack byte.
        // Preserve errno so interrupted main-thread framework calls see their own errors.
        unsafe {
            let saved = *libc::__error();
            let byte = signal as u8;
            libc::write(fd, (&byte as *const u8).cast(), 1);
            *libc::__error() = saved;
        }
    }
}
fn cancellation() -> Result<()> {
    let signal = STOP_SIGNAL.load(std::sync::atomic::Ordering::Relaxed);
    if signal == 0 { Ok(()) } else { Err(fail(23, "operation-failed", format!("Cancelled by signal {signal}"))) }
}
fn install_signal_handlers() -> Result<SignalPipe> {
    // SAFETY: pipe initializes both descriptors; ownership transfers immediately to File.
    let mut fds = [-1; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 { return Err(io::Error::last_os_error().into()); }
    let pipe = SignalPipe { _read: unsafe { File::from_raw_fd(fds[0]) }, _write: unsafe { File::from_raw_fd(fds[1]) } };
    // SAFETY: both descriptors are owned and live; sigaction is initialized before use.
    unsafe {
        for fd in fds {
            if libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK) != 0 || libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) != 0 {
                return Err(io::Error::last_os_error().into());
            }
        }
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = request_stop as *const () as usize;
        libc::sigemptyset(&mut action.sa_mask);
        SIGNAL_READ.store(fds[0], std::sync::atomic::Ordering::Relaxed);
        SIGNAL_WRITE.store(fds[1], std::sync::atomic::Ordering::Relaxed);
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGPIPE] {
            if libc::sigaction(signal, &action, std::ptr::null_mut()) != 0 { return Err(io::Error::last_os_error().into()); }
        }
    }
    Ok(pipe)
}

// Signing boundary: a dedicated keychain unlocked from an fd-supplied password.
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SecKeychainOpen(path: *const c_char, keychain: *mut *mut c_void) -> i32;
    fn SecKeychainUnlock(keychain: *mut c_void, length: u32, password: *const c_void, use_password: u8) -> i32;
    fn SecKeychainLock(keychain: *mut c_void) -> i32;
    fn SecKeychainSetUserInteractionAllowed(state: u8) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" { fn CFRelease(value: *const c_void); }
const PASSWORD_MAX: usize = 1024;
const PASSWORD_DEADLINE: Duration = Duration::from_secs(5);
/// Fixed-capacity buffer: never reallocates, so no stale copy of the password survives.
/// Two spare bytes detect an over-long password and its optional trailing newline.
struct Password { bytes: [u8; PASSWORD_MAX + 2], len: usize }
impl Password {
    /// The password is the descriptor's bytes up to EOF with exactly one trailing `\n`
    /// removed if present. Empty, over-long or not-at-EOF-by-the-deadline input is refused.
    fn read(fd: i32) -> Result<Self> {
        if fd < 3 { return Err(fail(64, "invalid-input", "Password fd must not be stdio")); }
        // SAFETY: the caller transfers this descriptor; File closes it when dropped.
        let mut file = unsafe { File::from_raw_fd(fd) };
        let mut password = Password { bytes: [0; PASSWORD_MAX + 2], len: 0 };
        let deadline = Instant::now() + PASSWORD_DEADLINE;
        loop {
            cancellation()?;
            let remaining = deadline.saturating_duration_since(Instant::now());
            let mut poll = libc::pollfd { fd: file.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            let timeout = i32::try_from(remaining.as_millis()).unwrap_or(i32::MAX);
            // SAFETY: poll reads exactly one valid pollfd for the duration of the call.
            let ready = unsafe { libc::poll(&mut poll, 1, timeout) };
            if ready < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted { continue; }
            if ready < 0 { return Err(io::Error::last_os_error().into()); }
            if ready == 0 { return Err(signing("password-invalid", "Password descriptor did not reach EOF before the deadline")); }
            let read = file.read(&mut password.bytes[password.len..])?;
            if read == 0 { break; }
            password.len += read;
            if password.len == password.bytes.len() { return Err(signing("password-invalid", format!("Password exceeds {PASSWORD_MAX} bytes"))); }
        }
        if password.len > 0 && password.bytes[password.len - 1] == b'\n' { password.len -= 1; }
        if password.len == 0 { return Err(signing("password-invalid", "Password is empty")); }
        if password.len > PASSWORD_MAX { return Err(signing("password-invalid", format!("Password exceeds {PASSWORD_MAX} bytes"))); }
        Ok(password)
    }
}
impl Drop for Password {
    fn drop(&mut self) {
        for byte in &mut self.bytes { unsafe { std::ptr::write_volatile(byte, 0) } }
        std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
    }
}
/// An opened dedicated keychain. Opening locks it unconditionally (a SIGKILLed earlier run
/// may have left it unlocked); dropping it locks again, best effort, before releasing it.
struct Keychain(*mut c_void);
impl Keychain {
    fn open_locked(path: &Path) -> Result<Self> {
        let c_path = CString::new(text(path)?).map_err(|e| fail(64, "invalid-input", e.to_string()))?;
        let mut reference = std::ptr::null_mut();
        // SAFETY: c_path is a valid C string; reference receives an owned keychain or stays null.
        let status = unsafe { SecKeychainOpen(c_path.as_ptr(), &mut reference) };
        if status != 0 || reference.is_null() { return Err(signing("keychain-missing", format!("SecKeychainOpen status {status}"))); }
        let keychain = Keychain(reference);
        // SAFETY: reference is a live keychain reference owned by `keychain`.
        let status = unsafe { SecKeychainLock(keychain.0) };
        if status != 0 { return Err(signing("relock-failed", format!("Initial SecKeychainLock status {status}"))); }
        Ok(keychain)
    }
    /// Checked final lock, including failed operations; lock failure overrides their result.
    fn finish<T>(&self, result: Result<T>) -> Result<T> {
        // SAFETY: self owns a live keychain reference.
        let status = unsafe { SecKeychainLock(self.0) };
        if status != 0 || failpoint("relock") { return Err(signing("relock-failed", format!("SecKeychainLock status {status}"))); }
        cancellation()?;
        result
    }
    /// Unlocks for one window. `close` must succeed before the result is used. The caller
    /// drops (and so zeroes) the password as soon as it has no further use for it.
    fn unlock(&self, password: &Password) -> Result<UnlockWindow<'_>> {
        cancellation()?;
        let length = u32::try_from(password.len).map_err(|_| signing("password-invalid", "Password too long"))?;
        // SAFETY: the password pointer is valid for length bytes; usePassword is true, so no UI is shown.
        let status = unsafe { SecKeychainUnlock(self.0, length, password.bytes.as_ptr().cast(), 1) };
        let window = UnlockWindow { keychain: self, open: true };
        if status != 0 {
            window.close()?;
            return Err(signing("unlock-failed", format!("SecKeychainUnlock status {status}")));
        }
        if let Err(error) = cancellation() {
            window.close()?;
            return Err(error);
        }
        Ok(window)
    }
}
impl Drop for Keychain {
    fn drop(&mut self) {
        // SAFETY: the reference came from SecKeychainOpen and is released exactly once.
        unsafe { SecKeychainLock(self.0); CFRelease(self.0); }
    }
}
struct UnlockWindow<'a> { keychain: &'a Keychain, open: bool }
impl UnlockWindow<'_> {
    /// Fallible relock; signing output is only used after this succeeds.
    fn close(mut self) -> Result<()> {
        self.open = false;
        // SAFETY: the borrowed keychain reference outlives the window.
        let status = unsafe { SecKeychainLock(self.keychain.0) };
        if status != 0 || failpoint("relock") { return Err(signing("relock-failed", format!("SecKeychainLock status {status}"))); }
        cancellation()?;
        Ok(())
    }
}
impl Drop for UnlockWindow<'_> {
    // Best-effort cleanup for early returns and unwinding; `close` is the checked path.
    // SAFETY: the borrowed keychain reference outlives the window.
    fn drop(&mut self) { if self.open { unsafe { SecKeychainLock(self.keychain.0); } } }
}
fn is_login_keychain(path: &Path) -> bool {
    let name_is_login = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.to_ascii_lowercase().starts_with("login.keychain"));
    let login = Command::new("/usr/bin/security").arg("login-keychain").output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().trim_matches('"').to_owned())
        .and_then(|p| fs::canonicalize(p).ok());
    name_is_login || login.is_some_and(|login| login == path)
}
/// Lists identities without unlocking: certificate and key attributes are readable while locked.
fn identity_in_keychain(keychain: &Path, identity: &str) -> Result<bool> {
    let out = checked("/usr/bin/security", &["find-identity", "-p", "codesigning", text(keychain)?])?;
    let listing = String::from_utf8_lossy(&out.stdout);
    let matching = listing.split("Valid identities only").next().unwrap_or_default();
    Ok(matching.lines().filter_map(|line| line.trim().split_once(") ").map(|(_, rest)| rest)).any(|rest| {
        let (hash, name) = rest.split_once(' ').unwrap_or((rest, ""));
        hash.eq_ignore_ascii_case(identity) || name.split('"').nth(1) == Some(identity)
    }))
}

impl Ctl {
    fn arg(&self, key: &str) -> Result<&str> { self.args.get(key).map(String::as_str).ok_or_else(|| fail(64, "invalid-input", format!("Missing --{key}"))) }
    fn field(&self, key: &str) -> Result<&str> { self.config[key].as_str().ok_or_else(|| fail(64, "invalid-input", format!("Invalid config {key}"))) }
    fn app(&self) -> Result<PathBuf> { Ok(PathBuf::from(self.arg("app-dir")?)) }
    fn state(&self) -> Result<PathBuf> { Ok(PathBuf::from(self.arg("state")?)) }
    fn password_fd(&self) -> Result<i32> { self.arg("keychain-password-fd")?.parse::<i32>().map_err(|_| fail(64, "invalid-input", "Invalid password fd")) }
    fn signature(&self, app: &Path) -> Result<String> { self.signature_with(app, self.field("requirement")?) }
    /// Evaluate the pinned predicate against the candidate, not its diagnostic DR text.
    fn signature_with(&self, app: &Path, requirement: &str) -> Result<String> {
        let predicate = macos_app_host::CompiledRequirement::compile(requirement)
            .map_err(|e| fail(64, "invalid-input", e.to_string()))?;
        predicate.verify_path(app).map_err(|e| mismatch(e.to_string()))?;
        let path = text(app)?;
        let strict = keys::bounded_codesign(&["--verify", "--strict", path])?;
        let details = keys::bounded_codesign(&["-d", "-r-", path])?;
        let details_text = format!("{}\n{}", String::from_utf8_lossy(&details.stdout), String::from_utf8_lossy(&details.stderr));
        let dr = details_text.lines().find_map(|line| line.strip_prefix("designated => ").map(str::to_owned)).unwrap_or_default();
        if !strict.status.success() || !details.status.success() { return Err(mismatch(format!("Invalid candidate signature: {dr}"))); }
        Ok(dr)
    }
    fn session(&self) -> Result<&'static str> {
        let uid = unsafe { libc::geteuid() }.to_string();
        if command("launchctl", &["print", &format!("gui/{uid}")])?.status.success() { Ok("gui") }
        else if command("launchctl", &["print", &format!("user/{uid}")])?.status.success() { Ok("background-only") }
        else { Ok("no-session") }
    }
    fn domain(&self) -> Result<String> {
        let requested = self.args.get("domain").map(String::as_str).unwrap_or("auto");
        resolve_domain(self.field("session")?, requested, self.session()?, unsafe { libc::geteuid() })
    }
    fn label(&self) -> Result<&str> { self.config["launchd"]["label"].as_str().ok_or_else(|| fail(64, "invalid-input", "Missing launchd label")) }
    fn job(&self, domain: &str) -> Result<(bool, Option<u32>)> {
        let out = command("launchctl", &["print", &format!("{domain}/{}", self.label()?)])?;
        let pid = String::from_utf8_lossy(&out.stdout).lines().find_map(|line| line.trim().strip_prefix("pid = ").and_then(|s| s.parse().ok()));
        Ok((out.status.success(), pid))
    }
    /// The startup-only socket mode declared by the active generation.
    fn desired_socket_mode(&self) -> Result<u32> {
        let manifest: Value = serde_json::from_slice(&fs::read(self.state()?.join("current/manifest.json"))?)?;
        manifest["socketMode"].as_u64().and_then(|m| u32::try_from(m).ok()).ok_or_else(|| fail(64, "invalid-input", "Manifest lacks socketMode"))
    }
    /// Signs the staged bundle. Identity lookup, predicate compilation and password
    /// read finish while locked; the unlocked interval preserves the codesign guards.
    fn sign(&self, keychain_path: &Path, keychain: &Keychain, stage: &Path) -> Result<()> {
        let identity = self.config["signer"]["identity"].as_str().filter(|s| !s.is_empty() && *s != "-").ok_or_else(|| fail(64, "invalid-input", "A certificate identity is required; ad-hoc signing is refused"))?;
        if !identity_in_keychain(keychain_path, identity)? { return Err(signing("identity-missing", "Identity not present in the dedicated keychain")); }
        let entries = artifact::signing_entries(&self.config)?;
        let predicates = entries.iter().map(|entry| macos_app_host::CompiledRequirement::compile(&entry.requirement)
            .map_err(|e| fail(64, "invalid-input", e.to_string()))).collect::<Result<Vec<_>>>()?;
        let password = Password::read(self.password_fd()?)?;
        let window = keychain.unlock(&password)?;
        drop(password);
        let result = (|| {
            for (entry, predicate) in entries.iter().zip(&predicates) {
                keys::require_codesign_ready(keychain_path, keychain, identity)?;
                let target = if entry.path.is_empty() { stage.to_owned() } else { stage.join(&entry.path) };
                let mut arguments = vec!["--force".to_owned(), "--keychain".to_owned(), text(keychain_path)?.to_owned(),
                    "--sign".to_owned(), identity.to_owned(), "--identifier".to_owned(), entry.identifier.clone(),
                    "--requirements".to_owned(), format!("=designated => {}", entry.requirement)];
                if let Some(entitlements) = &entry.entitlements { arguments.extend(["--entitlements".to_owned(), entitlements.clone()]); }
                arguments.extend(["--options".to_owned(), if entry.options.is_empty() { "0".to_owned() } else { entry.options.join(",") }]);
                arguments.push(text(&target)?.to_owned());
                let borrowed = arguments.iter().map(String::as_str).collect::<Vec<_>>();
                let signed = keys::bounded_codesign(&borrowed)?;
                if !signed.status.success() { return Err(signing("sign-failed", String::from_utf8_lossy(&signed.stderr).trim().to_owned())); }
                predicate.verify_path(&target).map_err(|e| signing("dr-mismatch", e.to_string()))?;
            }
            Ok(())
        })();
        window.close()?;
        result?;
        self.verify_bundle(stage).map_err(|e| signing("dr-mismatch", e.reason))
    }
    /// Roll-forward publication after the exchange, which is the install commit point. Every step
    /// is idempotent and `D.txn.json` is removed last, so a failure or crash here is completed by
    /// `reconcile`, never undone. Removing the superseded archive is post-commit cleanup.
    fn publish_archive(&self, app: &Path, txn: &Value) -> Result<Option<PathBuf>> {
        let stage = PathBuf::from(txn["stage"].as_str().ok_or_else(|| fail(64, "invalid-input", "Corrupt transaction record"))?);
        if txn["immutable"] == true { checked("/bin/chmod", &["-R", "a-w", text(&stage)?])?; }
        let state = self.state()?;
        fs::create_dir_all(&state)?;
        let recorded = state.join("host-previous-generation");
        match txn["generation"].as_str() { Some(generation) => select(&recorded, Path::new(generation))?, None => remove_if_present(&recorded)? }
        select(&archive_pointer(app), &stage)?;
        if failpoint("after-archive-pointer") { std::process::exit(137); }
        // A signed host is now installed, so an earlier signing failure no longer describes D.
        remove_if_present(&signing_failure_marker(app))?;
        remove_if_present(&transaction_record(app))?;
        // Legacy local-sign installs retain one archive; artifact imports omit
        // superseded and preserve every consumer-selected immutable incumbent.
        Ok(txn["superseded"].as_str().map(PathBuf::from).filter(|old| *old != stage).and_then(|old| remove_leftover(&old)))
    }
    /// Completes or discards an install exchange interrupted by a failure or crash. Runs before
    /// any no-op check in `install-host` and `rollback`.
    fn reconcile(&self, app: &Path) -> Result<(Option<&'static str>, Option<PathBuf>)> {
        let record = transaction_record(app);
        if let Ok(bytes) = fs::read(&record) {
            let txn: Value = serde_json::from_slice(&bytes)?;
            let stage = PathBuf::from(txn["stage"].as_str().ok_or_else(|| fail(64, "invalid-input", "Corrupt transaction record"))?);
            // renamex_np swaps directory entries, so the stage inode at the app path proves the exchange.
            if stage.exists() && inode(app) == txn["stageInode"].as_u64() {
                return Ok((Some("archive-published"), self.publish_archive(app, &txn)?));
            }
            if stage.exists() {
                let metadata = fs::symlink_metadata(&stage)?;
                if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
                    return Err(mismatch("Abandoned stage is not an owned directory"));
                }
                checked("/bin/chmod", &["-R", "u+w", text(&stage)?])?;
                fs::remove_dir_all(&stage)?;
            }
            remove_if_present(&record)?;
            return Ok((Some("stage-discarded"), None));
        }
        Ok((None, None))
    }
    /// `install-host` side of an interrupted host rollback (`rollback` resumes it fully instead).
    fn reconcile_rollback(&self, app: &Path) -> Result<(Option<&'static str>, Option<PathBuf>)> {
        let Some(rollback) = read_json(&rollback_record(app))? else { return Ok((None, None)) };
        let (archive, target, restored) = rollback_fields(&rollback)?;
        if inode(app) == rollback["rejectedInode"].as_u64() {
            // The rollback never exchanged; the archive pointers are still consistent.
            remove_if_present(&rollback_record(app))?;
            return Ok((Some("rollback-discarded"), None));
        }
        if inode(app) != restored { return Err(mismatch("Interrupted host rollback: the app holds neither recorded bundle")); }
        // The restored host is installed: select the generation it runs with so a later archive
        // records it, and retire the rolled-away bundle. Restart and verify are the consumer's next steps.
        let state = self.state()?;
        if pointer(&state.join("current")).as_ref() != Some(&target) { select(&state.join("current"), &target)?; }
        let leftover = self.finish_rollback(app, &archive)?;
        Ok((Some("rollback-host-restored"), leftover))
    }
    /// Drops host-rollback recovery state once the restored host is in place; the record goes last.
    fn finish_rollback(&self, app: &Path, rolled_away: &Path) -> Result<Option<PathBuf>> {
        remove_if_present(&archive_pointer(app))?;
        remove_if_present(&self.state()?.join("host-previous-generation"))?;
        let leftover = remove_leftover(rolled_away);
        remove_if_present(&rollback_record(app))?;
        Ok(leftover)
    }
    fn install(&self) -> Result<Value> {
        let app = self.app()?; let desired = PathBuf::from(self.arg("desired")?);
        let expected = hash(&desired).ok_or_else(|| fail(64, "invalid-input", "Unsigned app lacks source hash marker"))?;
        let expected_metadata = metadata_digest(&desired).ok_or_else(|| fail(64, "invalid-input", "Unsigned app lacks Info.plist"))?;
        let (reconciled, reconcile_leftover) = match self.reconcile(&app)? {
            (None, _) => self.reconcile_rollback(&app)?,
            done => done,
        };
        let failure_marker = signing_failure_marker(&app);
        let record = |error: Failure| -> Failure {
            if let Some(category) = error.category {
                let marker = json!({"category": category, "reason": error.reason, "desiredHostSourceHash": expected});
                if let Err(write) = serde_json::to_vec(&marker).map_err(Failure::from).and_then(|bytes| atomic_write(&failure_marker, &bytes)) { return write; }
            }
            error
        };
        let current = || hash(&app).as_ref() == Some(&expected) && metadata_digest(&app).as_ref() == Some(&expected_metadata) && self.signature(&app).is_ok();
        let unchanged = || json!({"changed": false, "hostSourceHash": expected, "bundleMetadataDigest": expected_metadata, "reconciled": reconciled, "leftovers": reconcile_leftover.iter().collect::<Vec<_>>()});
        if self.args.contains_key("signing-auth-pending") {
            // The consumer could not obtain the password; the keychain is not touched.
            if current() { return Ok(unchanged()); }
            return Err(record(signing("signing-auth-pending", "Consumer could not obtain the signing keychain password")));
        }
        // The login keychain is refused even on the no-op path, so misconfiguration is never silent.
        let keychain_arg = PathBuf::from(self.arg("keychain")?);
        if is_login_keychain(&fs::canonicalize(&keychain_arg).unwrap_or_else(|_| keychain_arg.clone())) { return Err(fail(64, "invalid-input", "The login keychain is never used for signing")); }
        // Elsewhere securityd creates no partition list, so codesign's exclusive access is unprovable.
        if keychain_arg.parent().and_then(|dir| fs::canonicalize(dir).ok()).is_some_and(|dir| !keys::partition_capable(&dir)) {
            return Err(fail(64, "invalid-input", "The signing keychain must live in a per-user Library/Keychains directory"));
        }
        let keychain_path = match fs::canonicalize(&keychain_arg) {
            Ok(path) if path.is_file() => path,
            Ok(_) => return Err(record(signing("keychain-missing", "Keychain path is not a file"))),
            Err(e) => return Err(record(signing("keychain-missing", e.to_string()))),
        };
        let keychain = Keychain::open_locked(&keychain_path).map_err(&record)?;
        if current() { return Ok(unchanged()); }
        let parent = app.parent().ok_or_else(|| fail(64, "invalid-input", "App requires parent"))?;
        fs::create_dir_all(parent)?;
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| fail(23, "operation-failed", e.to_string()))?.as_nanos();
        let stage = parent.join(format!(".{}.stage-{}-{nonce}", app.file_name().and_then(|s| s.to_str()).unwrap_or("app"), std::process::id()));
        checked("/bin/cp", &["-R", text(&desired)?, text(&stage)?])?;
        let result = (|| {
            checked("/bin/chmod", &["-R", "u+w", text(&stage)?])?;
            self.sign(&keychain_path, &keychain, &stage).map_err(&record)?;
            let mut leftovers: Vec<PathBuf> = reconcile_leftover.iter().cloned().collect();
            if app.exists() {
                // The record is durable before the exchange, so a crash at any point reconciles.
                let txn = json!({"stage": stage, "stageInode": inode(&stage), "generation": pointer(&self.state()?.join("current")), "superseded": pointer(&archive_pointer(&app))});
                atomic_write(&transaction_record(&app), &serde_json::to_vec(&txn)?)?;
                // Commit point: after this exchange the install only rolls forward. A publication
                // failure leaves D.txn.json for `reconcile` to complete; it never exchanges back.
                exchange(&stage, &app)?;
                if failpoint("after-exchange") { std::process::exit(137); }
                leftovers.extend(self.publish_archive(&app, &txn)?);
            } else { fs::rename(&stage, &app)?; }
            remove_if_present(&failure_marker)?;
            Ok(json!({"changed": true, "hostSourceHash": expected, "bundleMetadataDigest": expected_metadata, "archive": pointer(&archive_pointer(&app)), "reconciled": reconciled, "leftovers": leftovers}))
        })();
        if result.is_err() && stage.exists() && pointer(&archive_pointer(&app)).as_ref() != Some(&stage) && !transaction_record(&app).exists() { fs::remove_dir_all(stage)?; }
        result
    }
    fn generation(&self) -> Result<Value> {
        let state = self.state()?; let generation = PathBuf::from(self.arg("generation")?);
        if !generation.is_absolute() || !generation.join("manifest.json").is_file() { return Err(fail(64, "invalid-input", "Generation must be absolute and contain manifest.json")); }
        let current = state.join("current");
        if pointer(&current).as_ref() == Some(&generation) { return Ok(json!({"changed": false, "generation": generation})); }
        fs::create_dir_all(state.join("roots"))?;
        use sha2::Digest;
        let root = state.join("roots").join(format!("{:x}", sha2::Sha256::digest(text(&generation)?.as_bytes())));
        let rooted = match Command::new("nix-store").args(["--add-root", text(&root)?, "--indirect", "-r", text(&generation)?]).output() {
            Ok(out) if out.status.success() => true,
            Err(e) if e.kind() == io::ErrorKind::NotFound => { atomic_write(&root.with_extension("path"), text(&generation)?.as_bytes())?; false },
            Ok(out) => return Err(fail(23, "operation-failed", String::from_utf8_lossy(&out.stderr).into_owned())),
            Err(e) => return Err(e.into()),
        };
        if let Some(old) = pointer(&current) { select(&state.join("previous"), &old)?; }
        select(&current, &generation)?;
        Ok(json!({"changed": true, "generation": generation, "gcRootCreated": rooted, "consumerRootRequired": !rooted}))
    }
    fn converge(&self) -> Result<Value> {
        let domain = self.domain()?;
        let app = self.app()?; let state = self.state()?;
        let program = app.join("Contents/MacOS").join(self.field("hostExecutable")?);
        let socket = self.arg("socket")?;
        let mut data = self.config["launchd"].clone();
        let object = data.as_object_mut().ok_or_else(|| fail(64, "invalid-input", "launchd must be object"))?;
        object.remove("label"); object.remove("keepAlive"); object.remove("runAtLoad");
        apply_launchd_session_type(object, self.field("session")?, &domain)?;
        object.insert("Label".into(), json!(self.label()?)); object.insert("Program".into(), json!(program));
        object.insert("ProgramArguments".into(), json!([program, "serve", "--socket", socket, "--generation-pointer", state.join("current")]));
        object.insert("KeepAlive".into(), self.config["launchd"]["keepAlive"].clone()); object.insert("RunAtLoad".into(), self.config["launchd"]["runAtLoad"].clone());
        let bytes = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\">{}</plist>\n", plist(&data)?).into_bytes();
        let dir = PathBuf::from(self.arg("plist-dir")?); let path = dir.join(format!("{}.plist", self.label()?));
        let same = fs::read(&path).is_ok_and(|old| old == bytes); let (loaded, _) = self.job(&domain)?;
        // Any bundle exchange (host bytes or metadata) needs a restart: the running process was
        // launched from the bundle inode that is now archived. A generation-only change does not,
        // because the host rereads the pointer per request; the socket mode is its one
        // startup-only generation setting.
        let launched_record = state.join("launched-app-inode");
        let installed_inode = inode(&app).map(|i| i.to_string()).unwrap_or_default();
        let launched_inode = fs::read_to_string(&launched_record).unwrap_or_default();
        let running_hash = if loaded { self.ipc().ok().and_then(|v| v["status"]["hostSourceHash"].as_str().map(str::to_owned)) } else { None };
        let target = format!("{domain}/{}", self.label()?);
        if same && loaded && hash(&app) == running_hash && installed_inode == launched_inode {
            if socket_mode(socket) == Some(self.desired_socket_mode()?) { return Ok(json!({"changed": false, "domain": domain})); }
            checked("launchctl", &["kickstart", "-k", &target])?;
            return Ok(json!({"changed": true, "domain": domain, "restart": "socket-mode"}));
        }
        if loaded {
            checked("launchctl", &["bootout", &target])?;
            // launchd can still be tearing the job down when bootout returns; bootstrapping the
            // same label then fails with EIO (5). Wait, bounded, until print reports it gone.
            let deadline = Instant::now() + Duration::from_secs(10);
            while self.job(&domain)?.0 {
                if Instant::now() >= deadline { return Err(fail(23, "operation-failed", format!("{target} still loaded 10s after bootout"))); }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        if !same { fs::create_dir_all(&dir)?; atomic_write(&path, &bytes)?; }
        checked("launchctl", &["bootstrap", &domain, text(&path)?])?;
        fs::create_dir_all(&state)?;
        atomic_write(&launched_record, installed_inode.as_bytes())?;
        Ok(json!({"changed": true, "domain": domain}))
    }
    fn ipc(&self) -> Result<Value> {
        let mut stream = UnixStream::connect(self.arg("socket")?)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?; stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        stream.write_all(b"{\"wireVersion\":1,\"action\":\"status\",\"args\":{}}\n")?;
        let mut bytes = Vec::new();
        BufReader::new(stream).take(65536).read_until(b'\n', &mut bytes)?;
        Ok(serde_json::from_slice(&bytes)?)
    }
    fn verify_expected(&self, expected_hash: &str, expected_metadata: &str, generation: &Path) -> Result<Value> {
        let app = self.app()?; self.signature(&app)?;
        if hash(&app).as_deref() != Some(expected_hash) { return Err(mismatch("Installed host source differs")); }
        if metadata_digest(&app).as_deref() != Some(expected_metadata) { return Err(mismatch("Installed bundle metadata differs")); }
        if pointer(&self.state()?.join("current")).as_deref() != Some(generation) { return Err(mismatch("Generation pointer differs")); }
        let manifest: Value = serde_json::from_slice(&fs::read(generation.join("manifest.json"))?)?;
        let domain = self.domain()?; let (loaded, pid) = self.job(&domain)?; let ipc = self.ipc()?;
        if !loaded || pid.is_none() || ipc["ok"] != true || ipc["status"]["hostSourceHash"] != expected_hash || ipc["status"]["generation"] != manifest["generation"] || ipc["status"]["pid"].as_u64() != pid.map(u64::from) { return Err(mismatch("IPC host hash/generation/PID does not match desired and launchd")); }
        let mode = socket_mode(self.arg("socket")?);
        if mode.map(u64::from) != manifest["socketMode"].as_u64() { return Err(mismatch(format!("Socket mode {mode:?} differs from the generation's socketMode"))); }
        Ok(json!({"verified": true, "domain": domain, "pid": pid, "hostSourceHash": expected_hash, "bundleMetadataDigest": expected_metadata, "generation": generation}))
    }
    fn verify(&self) -> Result<Value> {
        let desired = Path::new(self.arg("desired")?);
        let expected = hash(desired).ok_or_else(|| fail(64, "invalid-input", "Desired app lacks source marker"))?;
        let metadata = metadata_digest(desired).ok_or_else(|| fail(64, "invalid-input", "Desired app lacks Info.plist"))?;
        self.verify_expected(&expected, &metadata, Path::new(self.arg("generation")?))
    }
    /// Generation-only rollback selects S/previous. Host rollback restores the archived host and
    /// the generation recorded when it was archived, independent of S/previous. A pending
    /// host-rollback record is always resumed first, whichever mode was requested.
    fn rollback(&self) -> Result<Value> {
        let state = self.state()?; let app = self.app()?;
        self.reconcile(&app)?;
        let pending = read_json(&rollback_record(&app))?;
        if pending.is_some() || self.args.contains_key("restore-host") { return self.restore_host(&app, &state, pending); }
        let target = pointer(&state.join("previous")).ok_or_else(|| mismatch("No previous generation"))?;
        if pointer(&state.join("current")).as_ref() != Some(&target) { select(&state.join("current"), &target)?; }
        self.converge()?;
        let expected = hash(&app).ok_or_else(|| mismatch("Installed host lacks marker"))?;
        let metadata = metadata_digest(&app).ok_or_else(|| mismatch("Installed host lacks Info.plist"))?;
        self.verify_expected(&expected, &metadata, &target)
    }
    /// Host-only rollback driven by `D.rollback.json`, written before the exchange. Each step is
    /// idempotent (exchange only while the rejected host is at D, select, converge, verify), and
    /// the recovery state (record, D.previous, host-previous-generation) is removed only after
    /// verify succeeds, so any failure or crash is retried to completion.
    fn restore_host(&self, app: &Path, state: &Path, pending: Option<Value>) -> Result<Value> {
        let resumed = pending.is_some();
        let record = match pending {
            Some(record) => record,
            None => {
                let archive = pointer(&archive_pointer(app)).ok_or_else(|| mismatch("No archived host"))?;
                let target = pointer(&state.join("host-previous-generation")).or_else(|| pointer(&state.join("current"))).ok_or_else(|| mismatch("No generation to run the restored host with"))?;
                self.signature(&archive)?;
                let record = json!({"direction": "restore-host", "archive": archive, "targetGeneration": target, "restoredInode": inode(&archive), "rejectedInode": inode(app)});
                atomic_write(&rollback_record(app), &serde_json::to_vec(&record)?)?;
                record
            }
        };
        let (archive, target, restored) = rollback_fields(&record)?;
        if inode(app) == record["rejectedInode"].as_u64() {
            exchange(&archive, app)?;
            if failpoint("rollback-after-exchange") { std::process::exit(137); }
        } else if inode(app) != restored {
            return Err(mismatch("Interrupted host rollback: the app holds neither recorded bundle"));
        }
        if pointer(&state.join("current")).as_ref() != Some(&target) { select(&state.join("current"), &target)?; }
        // The exchange changed D's inode, so converge restarts once; a retry after a restart does not.
        self.converge()?;
        let expected = hash(app).ok_or_else(|| mismatch("Restored host lacks marker"))?;
        let metadata = metadata_digest(app).ok_or_else(|| mismatch("Restored host lacks Info.plist"))?;
        let mut verified = self.verify_expected(&expected, &metadata, &target)?;
        // The rolled-away bundle is deleted only after the restart, so no process runs from it.
        let leftover = self.finish_rollback(app, &archive)?;
        verified["resumed"] = json!(resumed);
        verified["leftovers"] = json!(leftover.into_iter().collect::<Vec<_>>());
        Ok(verified)
    }
    fn status(&self) -> Result<Value> {
        let app = self.app()?; let state = self.state()?; let session = self.session()?;
        let domain = self.domain(); let job = domain.as_ref().ok().map(|d| self.job(d)).transpose()?;
        let dr = self.signature(&app);
        let signing_failure = fs::read(signing_failure_marker(&app)).ok().map(|b| serde_json::from_slice::<Value>(&b)).transpose()?;
        let ipc = self.ipc().ok();
        Ok(json!({"hostSourceHash": hash(&app), "bundleMetadataDigest": metadata_digest(&app), "drValid": dr.is_ok(), "requirement": dr.ok(), "activeGeneration": pointer(&state.join("current")), "previousGeneration": pointer(&state.join("previous")), "hostArchive": pointer(&archive_pointer(&app)), "hostArchiveGeneration": pointer(&state.join("host-previous-generation")), "interruptedTransaction": transaction_record(&app).exists(), "interruptedRollback": rollback_record(&app).exists(), "socketMode": socket_mode(self.arg("socket")?), "launchd": {"domain": domain.ok(), "loaded": job.map(|j| j.0).unwrap_or(false), "pid": job.and_then(|j| j.1)}, "session": session, "signingFailure": signing_failure, "running": ipc}))
    }
}
fn known_option(key: &str) -> bool {
    #[cfg(feature = "test-signing-cert")]
    if matches!(key, "test-self-signed-cert-out" | "mode") {
        return true;
    }
    matches!(
        key,
        "config"
            | "app-dir"
            | "state"
            | "socket"
            | "plist-dir"
            | "domain"
            | "desired"
            | "generation"
            | "keychain"
            | "keychain-password-fd"
            | "common-name-hint"
            | "csr-out"
            | "cert"
            | "restore-host"
            | "signing-auth-pending"
            | "replace"
            | "no-sign"
            | "certificate-sha1"
            | "requirement"
            | "target"
            | "inventory"
            | "identifier"
            | "production-requirements"
            | "artifact"
            | "incumbent"
            | "archive-dir"
            | "output"
            | "plist"
            | "target-uid"
            | "evidence"
            | "validate-only"
            | "lifecycle-fd"
    )
}
fn run() -> Result<Value> {
    let _signals = install_signal_handlers()?;
    let mut argv = std::env::args().skip(1);
    let action = argv
        .next()
        .ok_or_else(|| fail(64, "invalid-input", "Missing primitive"))?;
    let mut args = BTreeMap::new();
    while let Some(flag) = argv.next() {
        let key = flag
            .strip_prefix("--")
            .ok_or_else(|| fail(64, "invalid-input", "Expected --option"))?;
        if !known_option(key) {
            return Err(fail(64, "invalid-input", format!("Unknown option --{key}")));
        }
        if matches!(
            key,
            "restore-host" | "signing-auth-pending" | "replace" | "no-sign" | "validate-only"
        ) {
            if args.insert(key.to_owned(), String::new()).is_some() {
                return Err(fail(64, "invalid-input", "Duplicate option"));
            }
            continue;
        }
        let value = argv
            .next()
            .ok_or_else(|| fail(64, "invalid-input", "Missing option value"))?;
        if args.insert(key.to_owned(), value).is_some() {
            return Err(fail(64, "invalid-input", "Duplicate option"));
        }
    }
    if args.contains_key("validate-only")
        && (action != "converge-launchd" || !args.contains_key("plist"))
    {
        return Err(fail(
            64,
            "invalid-input",
            "--validate-only requires converge-launchd --plist",
        ));
    }
    if args.contains_key("incumbent") {
        if !matches!(action.as_str(), "install-host" | "rollback") || !args.contains_key("artifact")
        {
            return Err(fail(
                64,
                "invalid-input",
                "--incumbent requires install-host or rollback --artifact",
            ));
        }
        releases::Incumbent::parse(args.get("incumbent").map(String::as_str))?;
    }
    let config_path = args
        .get("config")
        .ok_or_else(|| fail(64, "invalid-input", "Missing --config"))?;
    let config = serde_json::from_slice(&fs::read(config_path)?)?;
    let ctl = Ctl { config, args };
    // Keychain calls in this process fail instead of showing UI (errSecInteractionNotAllowed).
    // SAFETY: a plain flag setter for this process's Security framework client state.
    let status = unsafe { SecKeychainSetUserInteractionAllowed(0) };
    if status != 0 {
        return Err(fail(
            23,
            "operation-failed",
            format!("SecKeychainSetUserInteractionAllowed status {status}"),
        ));
    }
    let _lifecycle = if matches!(
        action.as_str(),
        "install-host"
            | "select-generation"
            | "converge-launchd"
            | "rollback"
            | "provision-signing-key"
            | "import-signing-cert"
            | "prove-signing-key"
            | "sign-fixture"
    ) && !(action == "converge-launchd"
        && ctl.args.contains_key("plist")
        && ctl.args.contains_key("validate-only")
        && !ctl.args.contains_key("lifecycle-fd"))
    {
        lifecycle::verify(&ctl)?
    } else {
        None
    };
    let result = match action.as_str() {
        "describe-host" => ctl.describe_host(),
        "seal-host" => ctl.seal_host(),
        "install-host" if ctl.args.contains_key("artifact") => ctl.install_artifact(),
        "install-host" => ctl.install(),
        "select-generation" => ctl.generation(),
        "converge-launchd" if ctl.args.contains_key("plist") => ctl.converge_supplied(),
        "converge-launchd" => ctl.converge(),
        "verify" if ctl.args.contains_key("artifact") => ctl.verify_artifact(),
        "rollback" if ctl.args.contains_key("artifact") => ctl.rollback_artifact(),
        "status" if ctl.args.contains_key("artifact") => ctl.status_artifact(),
        "verify" => ctl.verify(),
        "rollback" => ctl.rollback(),
        "status" => ctl.status(),
        "provision-signing-key" => keys::provision(&ctl),
        "import-signing-cert" => keys::import_certificate(&ctl),
        "prove-signing-key" => keys::prove(&ctl),
        "sign-fixture" => keys::sign_fixture(&ctl),
        #[cfg(feature = "test-signing-cert")]
        "seal-fixture-artifact" => ctl.seal_fixture_artifact(),
        #[cfg(feature = "test-signing-cert")]
        "test-security-helper" => helper_probe::run(&ctl),
        _ => Err(fail(64, "invalid-input", "Unknown primitive")),
    }?;
    cancellation()?;
    Ok(json!({"ok": true, "primitive": action, "result": result}))
}
fn main() {
    match run() {
        Ok(v) => println!("{v}"),
        Err(e) => { println!("{}", json!({"ok": false, "error": {"kind": e.kind, "category": e.category, "reason": e.reason}})); std::process::exit(e.code); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pipe_with(bytes: &[u8], close_writer: bool) -> (i32, Option<File>) {
        let mut fds = [0; 2];
        // SAFETY: fds has room for the two descriptors pipe writes.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        // SAFETY: fds[1] is the freshly created write end, owned here.
        let mut writer = unsafe { File::from_raw_fd(fds[1]) };
        writer.write_all(bytes).unwrap_or_else(|_| panic!("pipe write"));
        (fds[0], if close_writer { None } else { Some(writer) })
    }
    fn category(result: Result<Password>) -> Option<&'static str> { result.err().and_then(|e| e.category) }
    #[test]
    fn password_strips_exactly_one_newline() {
        let (fd, _) = pipe_with(b"secret\n\n", true);
        let password = Password::read(fd).unwrap_or_else(|_| panic!("valid password"));
        assert_eq!(&password.bytes[..password.len], b"secret\n");
        let (fd, _) = pipe_with(b" secret ", true);
        let password = Password::read(fd).unwrap_or_else(|_| panic!("valid password"));
        assert_eq!(&password.bytes[..password.len], b" secret ");
    }
    #[test]
    fn password_rejects_empty_long_and_unterminated_input() {
        assert_eq!(category(Password::read(pipe_with(b"", true).0)), Some("password-invalid"));
        assert_eq!(category(Password::read(pipe_with(b"\n", true).0)), Some("password-invalid"));
        assert!(Password::read(pipe_with(&[b'a'; PASSWORD_MAX], true).0).is_ok());
        assert!(Password::read(pipe_with(&[[b'a'; PASSWORD_MAX].as_slice(), b"\n"].concat(), true).0).is_ok());
        assert_eq!(category(Password::read(pipe_with(&[b'a'; PASSWORD_MAX + 1], true).0)), Some("password-invalid"));
        let (fd, _writer) = pipe_with(b"partial", false);
        assert_eq!(category(Password::read(fd)), Some("password-invalid"));
    }
    #[test]
    fn domains_follow_session_kind() {
        let ok = |kind, requested, session| resolve_domain(kind, requested, session, 501).ok();
        let code = |kind, requested, session| resolve_domain(kind, requested, session, 501).err().map(|e| e.code);
        assert_eq!(ok("gui-agent", "auto", "gui").as_deref(), Some("gui/501"));
        assert_eq!(code("gui-agent", "auto", "background-only"), Some(21));
        assert_eq!(code("gui-agent", "user", "background-only"), Some(64));
        assert_eq!(code("gui-agent", "user", "gui"), Some(64));
        assert_eq!(code("gui-agent", "system", "gui"), Some(64));
        assert_eq!(ok("background-agent", "auto", "background-only").as_deref(), Some("user/501"));
        assert_eq!(ok("background-agent", "user", "gui").as_deref(), Some("user/501"));
        assert_eq!(code("background-agent", "gui", "background-only"), Some(21));
        assert_eq!(code("background-agent", "system", "gui"), Some(64));
        assert_eq!(ok("system-daemon", "auto", "no-session").as_deref(), Some("system"));
        assert_eq!(code("system-daemon", "user", "gui"), Some(64));
    }
    #[test]
    fn launchd_session_type_is_derived_and_cannot_be_overridden() {
        for (kind, domain, expected) in [
            ("gui-agent", "gui/501", Some("Aqua")),
            ("background-agent", "user/501", Some("Background")),
            ("background-agent", "gui/501", Some("Aqua")),
            ("system-daemon", "system", None),
        ] {
            let mut data = json!({"LimitLoadToSessionType": ["Wrong"], "ProcessType": "Background"});
            let object = data.as_object_mut().unwrap();
            apply_launchd_session_type(object, kind, domain).unwrap_or_else(|_| panic!("valid session domain"));
            assert_eq!(object.get("LimitLoadToSessionType"), expected.map(|value| json!(value)).as_ref());
            assert_eq!(object["ProcessType"], "Background");
            let rendered = plist(&data).unwrap_or_else(|_| panic!("valid plist"));
            assert_eq!(rendered.contains("<key>LimitLoadToSessionType</key>"), expected.is_some());
        }
        let mut object = serde_json::Map::new();
        assert!(apply_launchd_session_type(&mut object, "gui-agent", "user/501").is_err());
        assert!(apply_launchd_session_type(&mut object, "background-agent", "system").is_err());
    }
    #[test]
    fn plist_encodes_data_not_markup() {
        let encoded = plist(&json!({"Program": "/tmp/<app>&", "RunAtLoad": true, "ProgramArguments": ["host", "serve"], "Umask": 63})).unwrap_or_else(|_| panic!("valid plist"));
        assert!(encoded.contains("<string>/tmp/&lt;app&gt;&amp;</string>"));
        assert!(encoded.contains("<true />"));
        assert!(encoded.contains("<integer>63</integer>"));
        assert!(encoded.contains("<array><string>host</string><string>serve</string></array>"));
    }
    #[test]
    fn plist_rejects_null_and_floats() {
        assert!(plist(&Value::Null).is_err());
        assert!(plist(&json!(1.5)).is_err());
    }
    #[test]
    fn login_keychain_names_are_refused() {
        assert!(is_login_keychain(Path::new("/x/Library/Keychains/login.keychain-db")));
        assert!(is_login_keychain(Path::new("/x/LOGIN.keychain")));
        assert!(!is_login_keychain(Path::new("/x/product-signing.keychain-db")));
    }
}
