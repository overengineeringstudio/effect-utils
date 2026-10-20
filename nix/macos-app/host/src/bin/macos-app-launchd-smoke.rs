//! Explicit, user-level real-launchd acceptance test. Never built into production primitives.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, error::Error, ffi::c_void, fs::{self, File, OpenOptions}, io::{BufRead, BufReader, Read, Write}, os::unix::{fs::{MetadataExt, OpenOptionsExt, PermissionsExt}, io::{AsRawFd, FromRawFd}, net::UnixStream, process::{CommandExt, ExitStatusExt}}, path::{Path, PathBuf}, process::{Command, ExitStatus, Output, Stdio}, sync::atomic::{AtomicI32, Ordering}, thread, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
type Result<T> = std::result::Result<T, Box<dyn Error>>;
type Ref = *const c_void;
const LABEL: &str = "dev.overeng.macos-app.smoke";
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGWindowListCopyWindowInfo(options: u32, relative: u32) -> Ref;
    static kCGWindowOwnerName: Ref;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFArrayGetCount(array: Ref) -> isize;
    fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
    fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
    fn CFStringGetCString(string: Ref, buffer: *mut i8, size: isize, encoding: u32) -> u8;
    fn CFRelease(value: Ref);
}
#[link(name = "Security", kind = "framework")]
unsafe extern "C" { fn SessionGetInfo(session: u32, id: *mut u32, attributes: *mut u32) -> i32; }
fn ensure(ok: bool, message: impl Into<String>) -> Result<()> { if ok { Ok(()) } else { Err(message.into().into()) } }
fn text(path: &Path) -> &str { path.to_str().expect("smoke paths are UTF-8") }
static STOP: AtomicI32 = AtomicI32::new(0);
extern "C" fn on_signal(signal: libc::c_int) { STOP.store(signal, Ordering::SeqCst); }
fn signal_name(signal: i32) -> &'static str {
    match signal { libc::SIGINT => "SIGINT", libc::SIGTERM => "SIGTERM", libc::SIGHUP => "SIGHUP", libc::SIGKILL => "SIGKILL", _ => "signal" }
}
/// SIGINT/SIGTERM/SIGHUP only record the request; the control flow stops the active child and runs
/// the owned-job cleanup. SIGKILL is unrecoverable in-process; the next run's sweep handles it.
fn install_signal_handlers() -> Result<()> {
    for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
        // SAFETY: the handler only stores into an atomic, which is async-signal-safe.
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
            action.sa_flags = libc::SA_RESTART;
            libc::sigemptyset(&mut action.sa_mask);
            if libc::sigaction(signal, &action, std::ptr::null_mut()) != 0 { return Err(std::io::Error::last_os_error().into()); }
        }
    }
    Ok(())
}
fn interrupted() -> Result<()> {
    match STOP.load(Ordering::SeqCst) { 0 => Ok(()), signal => Err(format!("interrupted by {}", signal_name(signal)).into()) }
}
/// Polls an observable state; launchd can still report a job for a while after bootout returns.
fn retry_until<T>(timeout: Duration, interval: Duration, mut probe: impl FnMut() -> Result<T>) -> Result<T> {
    let deadline = Instant::now() + timeout;
    loop {
        match probe() {
            Ok(value) => return Ok(value),
            Err(error) if Instant::now() >= deadline => return Err(error),
            Err(_) => thread::sleep(interval),
        }
    }
}
/// Attempts every teardown and the scratch removal even after failures, then names what remains.
fn cleanup_all(targets: &[String], work: &Path, mut teardown: impl FnMut(&str) -> Result<()>) -> Result<()> {
    let (mut errors, mut left) = (Vec::new(), Vec::new());
    for target in targets {
        if let Err(error) = teardown(target) { errors.push(format!("{target}: {error}")); left.push(target.clone()); }
    }
    if let Err(error) = fs::remove_dir_all(work) && error.kind() != std::io::ErrorKind::NotFound { errors.push(format!("{}: {error}", work.display())); }
    if work.exists() { left.push(work.display().to_string()); }
    if errors.is_empty() && left.is_empty() { return Ok(()); }
    Err(format!("cleanup incomplete: {}; left behind: {}", errors.join("; "), left.join(", ")).into())
}
/// The launchd label is per user, so every checkout serializes on one per-user lock keyed to it,
/// in the Darwin per-user temp dir (resolved via confstr, independent of an overridden $TMPDIR).
/// Children inherit the lock, so an orphan of a SIGKILLed run keeps it until it exits and no
/// sweep, from any checkout, races a live run.
fn lock_path() -> Result<PathBuf> {
    let mut buffer = [0_u8; 1024];
    // SAFETY: confstr writes at most buffer.len() bytes, NUL-terminated.
    let length = unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, buffer.as_mut_ptr().cast(), buffer.len()) };
    ensure(length > 1 && length <= buffer.len(), "Cannot resolve the per-user temp dir")?;
    let dir = std::str::from_utf8(&buffer[..length - 1])?;
    Ok(Path::new(dir).join(format!("{LABEL}.lock")))
}
fn acquire_lock() -> Result<File> {
    let path = lock_path()?;
    let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600).open(&path)?;
    // SAFETY: lock owns this descriptor; clearing FD_CLOEXEC only affects inheritance.
    ensure(unsafe { libc::fcntl(lock.as_raw_fd(), libc::F_SETFD, 0) } == 0, "Cannot make the run lock inheritable")?;
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        interrupted()?;
        // SAFETY: lock is a live descriptor.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 { return Ok(lock); }
        ensure(Instant::now() < deadline, format!("Another smoke run (any checkout), or an orphaned child of one, held {} for 90s", path.display()))?;
        thread::sleep(Duration::from_millis(100));
    }
}
fn smoke_dirs(root: &Path) -> Result<Vec<PathBuf>> {
    let mut dirs = Vec::new();
    for entry in fs::read_dir(root.join("tmp"))? {
        let path = entry?.path();
        if path.is_dir() && path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("macos-app-smoke-")) { dirs.push(path); }
    }
    Ok(dirs)
}
fn security_window() -> Result<bool> {
    // SAFETY: CoreGraphics returns a retained array; borrowed dictionaries/strings live until release.
    unsafe {
        let windows = CGWindowListCopyWindowInfo(1, 0);
        ensure(!windows.is_null(), "Cannot inspect on-screen windows; refusing the smoke")?;
        let mut found = false;
        for index in 0..CFArrayGetCount(windows) {
            let owner = CFDictionaryGetValue(CFArrayGetValueAtIndex(windows, index), kCGWindowOwnerName);
            let mut name = [0_i8; 256];
            if !owner.is_null() && CFStringGetCString(owner, name.as_mut_ptr(), name.len() as isize, 0x08000100) != 0 {
                found |= std::ffi::CStr::from_ptr(name.as_ptr()).to_bytes() == b"SecurityAgent";
            }
        }
        CFRelease(windows);
        Ok(found)
    }
}
struct Smoke {
    root: PathBuf, work: PathBuf, assets: PathBuf, ctl: PathBuf,
    password: Vec<u8>, claimed: Vec<String>, command_number: u32,
    /// Set once cleanup starts: pending signals no longer abort its commands.
    cleaning: bool,
    _lock: File,
}
impl Drop for Smoke { fn drop(&mut self) { self.password.fill(0); } }
impl Smoke {
    fn command(&mut self, program: &Path, args: &[&str], password: bool, watch: bool) -> Result<Output> {
        if !self.cleaning { interrupted()?; }
        if watch { ensure(!security_window()?, "ABORT before command: SecurityAgent window present")?; }
        self.command_number += 1;
        let stdout_path = self.work.join(format!("command-{}.out", self.command_number));
        let stderr_path = self.work.join(format!("command-{}.err", self.command_number));
        let mut command = Command::new(program);
        command.args(args).current_dir(&self.root).process_group(0).stdin(Stdio::null())
            .stdout(File::create(&stdout_path)?).stderr(File::create(&stderr_path)?);
        let password_file = if password {
            let mut fds = [-1; 2];
            // SAFETY: pipe initializes both descriptors; Files immediately take their ownership.
            if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 { return Err(std::io::Error::last_os_error().into()); }
            let file = unsafe { File::from_raw_fd(fds[0]) };
            let mut writer = unsafe { File::from_raw_fd(fds[1]) };
            writer.write_all(&self.password)?;
            drop(writer);
            let fd = file.as_raw_fd();
            command.args(["--keychain-password-fd", &fd.to_string()]);
            Some(file)
        } else { None };
        let mut child = command.spawn()?;
        drop(password_file);
        let deadline = Instant::now() + Duration::from_secs(60);
        let status = loop {
            let stop = !self.cleaning && STOP.load(Ordering::SeqCst) != 0;
            if stop || (watch && security_window().unwrap_or(true)) || Instant::now() >= deadline {
                // SAFETY: child is not yet reaped and owns this process group. Let ctl relock first.
                unsafe { libc::kill(child.id() as i32, libc::SIGTERM); }
                let grace = Instant::now() + Duration::from_secs(2);
                loop {
                    if child.try_wait()?.is_some() { break; }
                    if Instant::now() >= grace {
                        // SAFETY: the unreaped child still reserves the group's numeric identity.
                        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
                        child.wait()?;
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                if stop { interrupted()?; }
                return Err("ABORT: SecurityAgent window or command deadline; smoke stopped".into());
            }
            if let Some(status) = child.try_wait()? { break status; }
            thread::sleep(Duration::from_millis(10));
        };
        if watch { ensure(!security_window()?, "ABORT after command: SecurityAgent window present")?; }
        Ok(Output { status, stdout: fs::read(stdout_path)?, stderr: fs::read(stderr_path)? })
    }
    fn checked(&mut self, program: &Path, args: &[&str]) -> Result<Output> {
        let out = self.command(program, args, false, true)?;
        ensure(out.status.success(), format!("{} failed: {}", program.display(), String::from_utf8_lossy(&out.stderr)))?;
        Ok(out)
    }
    fn ctl(&mut self, action: &str, config: &Path, app: &Path, state: &Path, socket: &Path, plists: &Path, domain: &str, extra: &[&str], password: bool) -> Result<Value> {
        let mut args = vec![action, "--config", text(config), "--app-dir", text(app), "--state", text(state), "--socket", text(socket), "--plist-dir", text(plists), "--domain", domain];
        args.extend_from_slice(extra);
        let out = self.command(&self.ctl.clone(), &args, password, true)?;
        ensure(out.status.success(), format!("{action} failed: {} {}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))?;
        let result: Value = serde_json::from_slice(&out.stdout)?;
        ensure(result["ok"] == true, format!("{action}: {result}"))?;
        Ok(result["result"].clone())
    }
    fn absent(&mut self, target: &str, watch: bool) -> Result<()> {
        let out = self.command(Path::new("/bin/launchctl"), &["print", target], false, watch)?;
        let error = String::from_utf8_lossy(&out.stderr);
        ensure(out.status.code() == Some(113) && error.contains("Could not find service"), format!("Expected exit 113 for absent smoke label {target}: {error}"))
    }
    /// Bootout's own status is irrelevant (the label may already be gone); the observed state decides.
    fn teardown(&mut self, target: &str, watch: bool) -> Result<()> {
        self.command(Path::new("/bin/launchctl"), &["bootout", target], false, watch)?;
        retry_until(Duration::from_secs(10), Duration::from_millis(100), || self.absent(target, watch))
    }
    fn cleanup(&mut self) -> Result<()> {
        self.cleaning = true;
        let targets = std::mem::take(&mut self.claimed);
        let work = self.work.clone();
        cleanup_all(&targets, &work, |target| {
            self.teardown(target, false)?;
            println!("PASS cleanup {target}: launchctl print exit 113");
            Ok(())
        })?;
        println!("PASS cleanup: launchctl print reports not found; plist, bundle, state, socket and K removed");
        Ok(())
    }
    /// Removes what a SIGKILLed run left: the reserved label, only when loaded from a smoke scratch
    /// plist, and stale scratch dirs (the held lock proves no other run owns them).
    fn sweep(&mut self, targets: &[String]) -> Result<()> {
        for target in targets {
            let out = self.command(Path::new("/bin/launchctl"), &["print", target], false, true)?;
            if out.status.code() == Some(113) { continue; }
            ensure(out.status.success(), format!("Cannot inspect {target} for a stale smoke job: {}", String::from_utf8_lossy(&out.stderr)))?;
            let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
            let path = stdout.lines().find_map(|line| line.trim().strip_prefix("path = ")).unwrap_or_default().to_owned();
            ensure(path.contains("/tmp/macos-app-smoke-"), format!("Refusing to sweep {target}: loaded from {path:?}, not a smoke scratch plist"))?;
            self.teardown(target, true)?;
            println!("SWEEP {target}: stale smoke job from {path} booted out; launchctl print exit 113");
        }
        for path in smoke_dirs(&self.root)? {
            if path == self.work { continue; }
            fs::remove_dir_all(&path)?;
            println!("SWEEP removed {} (stale scratch and K)", path.strip_prefix(&self.root)?.display());
        }
        Ok(())
    }
    fn session(&mut self, domain: &str) -> Result<String> {
        let out = self.checked(Path::new("/bin/launchctl"), &["print", domain])?;
        let asid: u32 = String::from_utf8_lossy(&out.stdout).lines().find_map(|line| line.trim().strip_prefix("asid = ").and_then(|v| v.parse().ok())).ok_or("Domain has no security-context ASID")?;
        let (mut id, mut attributes) = (0, 0);
        // SAFETY: this is the real domain's security-session ID; both outputs are live.
        ensure(unsafe { SessionGetInfo(asid, &mut id, &mut attributes) } == 0, "Cannot query domain audit session")?;
        Ok(if attributes & 1 != 0 { "no-session" } else if attributes & 0x10 != 0 { "gui" } else { "background-only" }.into())
    }
    fn wire(&self, socket: &Path, generation: &str, expected_session: &str) -> Result<Value> {
        let until = Instant::now() + Duration::from_secs(15);
        loop {
            interrupted()?;
            ensure(!security_window()?, "ABORT during readiness: SecurityAgent window present")?;
            let read = (|| -> Result<Value> {
                // Relative to the runner's cwd (the checkout root), as for ctl and the host; an
                // absolute checkout path can exceed SUN_LEN.
                let mut stream = UnixStream::connect(socket)?;
                stream.set_read_timeout(Some(Duration::from_secs(1)))?;
                stream.set_write_timeout(Some(Duration::from_secs(1)))?;
                stream.write_all(b"{\"wireVersion\":1,\"action\":\"status\",\"args\":{}}\n")?;
                let mut bytes = Vec::new();
                BufReader::new(stream).take(65536).read_until(b'\n', &mut bytes)?;
                let value: Value = serde_json::from_slice(&bytes)?;
                ensure(value["ok"] == true && value["status"]["generation"] == generation, "Host generation is not ready")?;
                ensure(value["status"]["session"] == expected_session, format!("Host session does not match domain audit API: {value}"))?;
                Ok(value["status"].clone())
            })();
            match read {
                Ok(value) => return Ok(value),
                Err(error) if Instant::now() >= until => return Err(error),
                Err(_) => thread::sleep(Duration::from_millis(50)),
            }
        }
    }
    fn fingerprint(&mut self, app: &Path) -> Result<(String, String)> {
        let hash = format!("{:x}", Sha256::digest(fs::read(app.join("Contents/MacOS/macos-app-host"))?));
        let out = self.checked(Path::new("/usr/bin/codesign"), &["-d", "--verbose=4", text(app)])?;
        let cdhash = String::from_utf8_lossy(&out.stderr).lines().find_map(|line| line.strip_prefix("CDHash=").map(str::to_owned)).ok_or("codesign did not report a cdhash")?;
        Ok((hash, cdhash))
    }
    fn run_domain(&mut self, kind: &str, domain: &str, leaf: &str, keychain: &Path) -> Result<()> {
        let folder = self.work.join(kind);
        fs::create_dir(&folder)?;
        let app = folder.join("apps/Launchd Smoke.app");
        let state = folder.join("state");
        let plists = folder.join("plists");
        let socket = folder.strip_prefix(&self.root)?.join("host.sock");
        let config = folder.join("config.json");
        let desired = self.assets.join("hostApp/SmokeHost.app");
        let changed_host = self.assets.join("changedHostApp/SmokeHost.app");
        let first = folder.join("first");
        let second = folder.join("second");
        let uid = unsafe { libc::geteuid() };
        let mut generations = Vec::new();
        for (source, target) in [("generation", &first), ("secondGeneration", &second)] {
            fs::create_dir(target)?;
            let mut manifest: Value = serde_json::from_slice(&fs::read(self.assets.join(source).join("manifest.json"))?)?;
            manifest["statusAllowedUids"] = json!([uid]);
            for action in manifest["actions"].as_object_mut().ok_or("Missing actions")?.values_mut() { action["allowedUids"] = json!([uid]); }
            manifest.as_object_mut().unwrap().remove("generation");
            let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&manifest)?));
            manifest["generation"] = json!(hash);
            fs::write(target.join("manifest.json"), serde_json::to_vec(&manifest)?)?;
            generations.push(hash);
        }
        // Only public manifests enter the store; select-generation roots immutable store paths.
        let first = PathBuf::from(String::from_utf8(self.checked(Path::new("nix-store"), &["--add", text(&first)])?.stdout)?.trim());
        let second = PathBuf::from(String::from_utf8(self.checked(Path::new("nix-store"), &["--add", text(&second)])?.stdout)?.trim());
        fs::write(&config, serde_json::to_vec(&json!({
            "bundleId": LABEL, "appBundleName": "Launchd Smoke.app", "session": kind, "hostExecutable": "macos-app-host",
            "requirement": format!("identifier \"{LABEL}\" and certificate leaf = H\"{leaf}\""),
            "signer": {"teamId": "TEST", "identity": leaf},
            "launchd": {"label": LABEL, "keepAlive": true, "runAtLoad": true, "WorkingDirectory": self.root}
        }))?)?;
        let expected_session = self.session(domain)?;
        let common = (&config, &app, &state, &socket, &plists);
        let domain_kind = domain.split_once('/').ok_or("Malformed domain")?.0;
        macro_rules! ctl { ($action:expr, $extra:expr, $password:expr) => { self.ctl($action, common.0, common.1, common.2, common.3, common.4, domain_kind, $extra, $password) }; }
        ensure(ctl!("install-host", &["--desired", text(&desired), "--keychain", text(keychain)], true)?["changed"] == true, "Initial host was not installed")?;
        ctl!("select-generation", &["--generation", text(&first)], false)?;
        let converged = ctl!("converge-launchd", &[], false)?;
        ensure(converged["domain"] == domain, format!("Converged to wrong domain: {converged}"))?;
        let initial = self.wire(&socket, &generations[0], &expected_session)?;
        ctl!("verify", &["--desired", text(&desired), "--generation", text(&first)], false)?;
        println!("PASS {domain}: wire generation={}, session={}, pid={}", generations[0], expected_session, initial["pid"]);
        let fingerprint = self.fingerprint(&app)?;
        ctl!("select-generation", &["--generation", text(&second)], false)?;
        let switched = self.wire(&socket, &generations[1], &expected_session)?;
        ensure(switched["pid"] == initial["pid"] && self.fingerprint(&app)? == fingerprint, "Generation switch restarted or re-signed the host")?;
        ctl!("verify", &["--desired", text(&desired), "--generation", text(&second)], false)?;
        let before = snapshots(&[&app, &state, &plists])?;
        ensure(ctl!("converge-launchd", &[], false)?["changed"] == false, "No-op converge changed launchd")?;
        ensure(snapshots(&[&app, &state, &plists])? == before, "No-op converge wrote files")?;
        ctl!("rollback", &[], false)?;
        self.wire(&socket, &generations[0], &expected_session)?;
        ensure(self.fingerprint(&app)? == fingerprint, "Generation rollback re-signed the host")?;
        println!("PASS {domain}: generation-only swap preserved PID/host bytes/cdhash; no-op wrote nothing; generation rollback verified");
        ensure(ctl!("install-host", &["--desired", text(&changed_host), "--keychain", text(keychain)], true)?["changed"] == true, "Host change did not install")?;
        ensure(self.fingerprint(&app)?.1 != fingerprint.1, "Host metadata change did not re-sign")?;
        ctl!("converge-launchd", &[], false)?;
        self.wire(&socket, &generations[0], &expected_session)?;
        ctl!("verify", &["--desired", text(&changed_host), "--generation", text(&first)], false)?;
        ctl!("rollback", &["--restore-host"], false)?;
        self.wire(&socket, &generations[0], &expected_session)?;
        ctl!("verify", &["--desired", text(&desired), "--generation", text(&first)], false)?;
        ensure(self.fingerprint(&app)? == fingerprint, "Host rollback did not restore original bytes/cdhash")?;
        println!("PASS {domain}: host change re-signed; restore-host restored original bytes/cdhash and generation");
        let target = format!("{domain}/{LABEL}");
        self.teardown(&target, true)?;
        fs::remove_dir_all(&folder)?;
        ensure(!folder.exists(), "Per-domain plist/bundle/state/socket remain")?;
        println!("PASS {domain}: bootout, not-found print, no per-domain files");
        Ok(())
    }
    fn run(&mut self, sweep_only: bool) -> Result<()> {
        let uid = unsafe { libc::geteuid() };
        ensure(uid != 0, "Run the smoke as an unprivileged user, never sudo")?;
        let user = format!("user/{uid}");
        let gui = format!("gui/{uid}");
        let gui_exists = self.command(Path::new("/bin/launchctl"), &["print", &gui], false, true)?.status.success();
        let mut targets = vec![format!("{user}/{LABEL}")];
        if gui_exists { targets.push(format!("{gui}/{LABEL}")); }
        self.sweep(&targets)?;
        if sweep_only { return Ok(()); }
        for target in &targets { self.absent(target, true)?; }
        // Both labels were absent: cleanup owns both possible user-level targets, even on failure.
        self.claimed = targets;
        let search = self.checked(Path::new("/usr/bin/security"), &["list-keychains", "-d", "user"])?.stdout;
        let keychain = self.work.join("Library/Keychains/smoke.keychain-db");
        fs::create_dir_all(keychain.parent().unwrap())?;
        let csr = self.work.join("request.pem");
        let cert = self.work.join("leaf.pem");
        let config = self.work.join("provision.json");
        fs::write(&config, b"{}")?;
        let ctl = self.ctl.clone();
        let out = self.command(&ctl, &["provision-signing-key", "--config", text(&config), "--keychain", text(&keychain), "--common-name-hint", "macos-app launchd smoke test", "--csr-out", text(&csr), "--test-self-signed-cert-out", text(&cert)], true, true)?;
        ensure(out.status.success(), format!("Provision failed: {}", String::from_utf8_lossy(&out.stdout)))?;
        ensure(fs::metadata(&keychain)?.permissions().mode() & 0o777 == 0o600, "K is not 0600")?;
        let out = self.command(&ctl, &["import-signing-cert", "--config", text(&config), "--keychain", text(&keychain), "--cert", text(&cert)], true, true)?;
        ensure(out.status.success(), format!("Import failed: {}", String::from_utf8_lossy(&out.stdout)))?;
        let imported: Value = serde_json::from_slice(&out.stdout)?;
        let leaf = imported["result"]["certificateSha1"].as_str().ok_or("Missing leaf identity")?.to_owned();
        let out = self.command(&ctl, &["prove-signing-key", "--config", text(&config), "--keychain", text(&keychain), "--no-sign"], true, true)?;
        ensure(out.status.success(), format!("Dry guard failed: {}", String::from_utf8_lossy(&out.stdout)))?;
        let proof: Value = serde_json::from_slice(&out.stdout)?;
        ensure(proof["result"]["guardReady"] == true && proof["result"]["partitionCapable"] == true && proof["result"]["exportStatus"] == -25316 && proof["result"]["lockedAfterWindow"] == true, "Dry signing-key proof failed")?;
        self.run_domain("background-agent", &user, &leaf, &keychain)?;
        if gui_exists && self.session(&gui)? == "gui" {
            // The exact same generic host remains LSBackgroundOnly=true and opens no UI in either domain.
            self.run_domain("gui-agent", &gui, &leaf, &keychain)?;
        } else { println!("SKIP gui-agent: no graphic-access GUI domain"); }
        ensure(self.checked(Path::new("/usr/bin/security"), &["list-keychains", "-d", "user"])?.stdout == search, "User keychain search list changed")?;
        println!("PASS search list unchanged; no login keychain, system trust, real app labels or sudo used");
        Ok(())
    }
}
fn snapshots(paths: &[&Path]) -> Result<BTreeMap<PathBuf, (u64, i64, i64, u32, String)>> {
    fn visit(path: &Path, map: &mut BTreeMap<PathBuf, (u64, i64, i64, u32, String)>) -> Result<()> {
        let meta = fs::symlink_metadata(path)?;
        let content = if meta.file_type().is_symlink() { fs::read_link(path)?.display().to_string() } else if meta.is_file() { format!("{:x}", Sha256::digest(fs::read(path)?)) } else { String::new() };
        map.insert(path.to_owned(), (meta.ino(), meta.mtime(), meta.mtime_nsec(), meta.mode(), content));
        if meta.is_dir() { for entry in fs::read_dir(path)? { visit(&entry?.path(), map)?; } }
        Ok(())
    }
    let mut result = BTreeMap::new();
    for path in paths { visit(path, &mut result)?; }
    Ok(result)
}
/// Runs the runner as a child, interrupting it with `signal` once the user-domain job is loaded.
fn interrupt_run(exe: &Path, assets: &str, signal: i32) -> Result<(ExitStatus, String, String)> {
    let mut child = Command::new(exe).arg(assets).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().ok_or("Runner stdout missing")?);
    let mut seen = String::new();
    loop {
        let mut line = String::new();
        if stdout.read_line(&mut line)? == 0 { child.wait()?; return Err(format!("Runner exited before a job was loaded: {seen}").into()); }
        seen.push_str(&line);
        // Printed once the user-domain job is bootstrapped, verified and serving the wire.
        if line.starts_with("PASS user/") && line.contains("wire generation=") { break; }
    }
    // SAFETY: the child is unreaped, so its PID cannot be reused.
    unsafe { libc::kill(child.id() as i32, signal); }
    stdout.read_to_string(&mut seen)?;
    let mut stderr = String::new();
    child.stderr.take().ok_or("Runner stderr missing")?.read_to_string(&mut stderr)?;
    Ok((child.wait()?, seen, stderr))
}
fn print_status(target: &str) -> Result<Option<i32>> { Ok(Command::new("/bin/launchctl").args(["print", target]).output()?.status.code()) }
fn assert_clean(root: &Path, targets: &[String]) -> Result<()> {
    for target in targets { ensure(print_status(target)? == Some(113), format!("{target} is still known to launchd"))?; }
    let left = smoke_dirs(root)?;
    ensure(left.is_empty(), format!("Smoke scratch left behind: {left:?}"))
}
/// Interrupts real runs with SIGTERM/SIGINT/SIGHUP (in-process cleanup) and SIGKILL (next-run sweep).
fn signal_matrix(assets: &str) -> Result<()> {
    let exe = std::env::current_exe()?;
    let root = std::env::current_dir()?;
    let uid = unsafe { libc::geteuid() };
    let user = format!("user/{uid}/{LABEL}");
    let mut targets = vec![user.clone()];
    if print_status(&format!("gui/{uid}"))? == Some(0) { targets.push(format!("gui/{uid}/{LABEL}")); }
    let result = (|| -> Result<()> {
        assert_clean(&root, &targets)?;
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            let name = signal_name(signal);
            let (status, stdout, stderr) = interrupt_run(&exe, assets, signal)?;
            ensure(status.code() == Some(1) && stderr.contains(&format!("interrupted by {name}")), format!("{name}: unexpected exit {status}: {stderr}"))?;
            for target in &targets { ensure(stdout.contains(&format!("PASS cleanup {target}: launchctl print exit 113")), format!("{name}: no cleanup proof for {target}: {stdout}"))?; }
            ensure(stdout.contains("PASS cleanup: "), format!("{name}: scratch cleanup missing: {stdout}"))?;
            assert_clean(&root, &targets)?;
            println!("PASS {name} mid-run: child stopped, claimed labels booted out (print exit 113), scratch and K removed");
        }
        let (status, _, _) = interrupt_run(&exe, assets, libc::SIGKILL)?;
        ensure(status.signal() == Some(libc::SIGKILL), format!("SIGKILL run ended with {status}"))?;
        ensure(print_status(&user)? == Some(0), "SIGKILL left no loaded job; nothing proves the sweep")?;
        ensure(smoke_dirs(&root)?.len() == 1, "SIGKILL did not leave exactly one scratch dir")?;
        println!("PASS SIGKILL mid-run left {user} loaded and its scratch dir behind");
        let next = Command::new(&exe).arg(assets).stdin(Stdio::null()).output()?;
        let stdout = String::from_utf8_lossy(&next.stdout);
        ensure(next.status.success(), format!("Run after SIGKILL failed: {stdout}{}", String::from_utf8_lossy(&next.stderr)))?;
        ensure(stdout.contains(&format!("SWEEP {user}: stale smoke job")) && stdout.contains("SWEEP removed tmp/macos-app-smoke-"), format!("Next run did not sweep: {stdout}"))?;
        print!("{stdout}");
        assert_clean(&root, &targets)?;
        println!("PASS next run swept the SIGKILLed job and scratch, then passed in full");
        Ok(())
    })();
    if result.is_err() { let _ = Command::new(&exe).args([assets, "--sweep-only"]).stdin(Stdio::null()).status(); }
    result
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(2).map(String::as_str) == Some("--signal-matrix") {
        if let Err(error) = signal_matrix(&args[1]) { eprintln!("macOS real-launchd smoke signal matrix: FAIL: {error}"); std::process::exit(1); }
        println!("macOS real-launchd smoke signal matrix: PASS");
        return;
    }
    let result = (|| -> Result<()> {
        install_signal_handlers()?;
        ensure(!security_window()?, "ABORT before smoke: SecurityAgent window present")?;
        let sweep_only = match args.get(2).map(String::as_str) { None => false, Some("--sweep-only") => true, Some(other) => return Err(format!("Unknown option {other}").into()) };
        let root = std::env::current_dir()?;
        let assets = PathBuf::from(args.get(1).ok_or("Missing smoke assets argument")?);
        let scratch = root.join("tmp");
        fs::create_dir_all(&scratch)?;
        let lock = acquire_lock()?;
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let work = scratch.join(format!("macos-app-smoke-{}-{nonce}", std::process::id()));
        fs::create_dir(&work)?;
        fs::set_permissions(&work, fs::Permissions::from_mode(0o700))?;
        writeln!(OpenOptions::new().create(true).append(true).open(scratch.join("TEMPORARY_FILES.md"))?, "\n- `{}`: real-launchd smoke app/plists/state, throwaway K and command evidence; removed by the runner on exit or by the next run's sweep.", work.strip_prefix(&root)?.display())?;
        let mut random = [0_u8; 32];
        File::open("/dev/urandom")?.read_exact(&mut random)?;
        let password = format!("{:x}\n", Sha256::digest(random)).into_bytes();
        random.fill(0);
        let mut smoke = Smoke { root, work, ctl: assets.join("primitives/bin/macos-app-ctl"), assets, password, claimed: Vec::new(), command_number: 0, cleaning: false, _lock: lock };
        let run = smoke.run(sweep_only);
        match (run, smoke.cleanup()) {
            (Err(run), Err(cleanup)) => return Err(format!("{run}; {cleanup}").into()),
            (run, cleanup) => { cleanup?; run?; }
        }
        println!("macOS real-launchd smoke{}: PASS", if sweep_only { " sweep" } else { "" });
        Ok(())
    })();
    if let Err(error) = result { eprintln!("macOS real-launchd smoke: FAIL: {error}"); std::process::exit(1); }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cleanup_attempts_every_step_and_names_leftovers() {
        let work = std::env::temp_dir().join(format!("macos-app-smoke-cleanup-test-{}", std::process::id()));
        fs::create_dir_all(work.join("Library/Keychains")).unwrap();
        let targets = vec!["gui/1/x".to_owned(), "user/1/x".to_owned()];
        let mut attempted = Vec::new();
        let error = cleanup_all(&targets, &work, |target| {
            attempted.push(target.to_owned());
            ensure(target != "gui/1/x", "still loaded after 10s")
        }).unwrap_err().to_string();
        assert_eq!(attempted, targets);
        assert!(!work.exists());
        assert!(error.contains("gui/1/x: still loaded after 10s") && error.ends_with("left behind: gui/1/x"), "{error}");
        cleanup_all(&targets, &work, |_| Ok(())).unwrap();
    }
    #[test]
    fn removal_wait_tolerates_async_teardown_and_is_bounded() {
        let mut polls = 0;
        retry_until(Duration::from_secs(5), Duration::from_millis(1), || { polls += 1; ensure(polls >= 3, "still loaded") }).unwrap();
        assert_eq!(polls, 3);
        let start = Instant::now();
        assert!(retry_until(Duration::from_millis(50), Duration::from_millis(5), || ensure(false, "still loaded")).is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
