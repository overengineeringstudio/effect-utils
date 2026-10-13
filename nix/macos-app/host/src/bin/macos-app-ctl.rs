//! Nonresident primitives. The consumer serializes calls and owns transaction policy.
use serde_json::{json, Value};
use std::{collections::BTreeMap, ffi::{c_char, c_void, CString}, fs::{self, File}, io::{self, BufRead, BufReader, Read, Write}, os::{fd::FromRawFd, unix::{fs::symlink, net::UnixStream}}, path::{Path, PathBuf}, process::{Command, Output}, time::Duration};

type Result<T, E = Failure> = std::result::Result<T, E>;
struct Failure { code: i32, kind: &'static str, category: Option<&'static str>, reason: String }
fn fail(code: i32, kind: &'static str, reason: impl Into<String>) -> Failure { Failure { code, kind, category: None, reason: reason.into() } }
fn signing(category: &'static str, reason: impl Into<String>) -> Failure { Failure { code: 20, kind: "signing-failed", category: Some(category), reason: reason.into() } }
impl From<io::Error> for Failure { fn from(e: io::Error) -> Self { fail(23, "operation-failed", e.to_string()) } }
impl From<serde_json::Error> for Failure { fn from(e: serde_json::Error) -> Self { fail(64, "invalid-input", e.to_string()) } }
struct Ctl { config: Value, args: BTreeMap<String, String> }
fn command(program: &str, args: &[&str]) -> Result<Output> { Ok(Command::new(program).args(args).output()?) }
fn checked(program: &str, args: &[&str]) -> Result<Output> { let out = command(program, args)?; if !out.status.success() { return Err(fail(23, "operation-failed", format!("{program}: {}", String::from_utf8_lossy(&out.stderr)))); } Ok(out) }
fn text(path: &Path) -> Result<&str> { path.to_str().ok_or_else(|| fail(64, "invalid-input", "Paths must be UTF-8")) }
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> { let tmp = path.with_extension(format!("tmp-{}", std::process::id())); let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?; f.write_all(bytes)?; f.sync_all()?; fs::rename(tmp, path)?; Ok(()) }
fn pointer(path: &Path) -> Option<PathBuf> { fs::read_link(path).ok() }
fn select(path: &Path, target: &Path) -> Result<()> { let tmp = path.with_extension(format!("tmp-{}", std::process::id())); symlink(target, &tmp)?; fs::rename(tmp, path)?; Ok(()) }
fn marker(app: &Path) -> PathBuf { app.join("Contents/Resources/host-source-hash") }
fn hash(app: &Path) -> Option<String> { fs::read_to_string(marker(app)).ok().map(|s| s.trim().to_owned()) }
fn signing_failure_marker(app: &Path) -> PathBuf { app.with_extension("signing-failed.json") }
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

// Signing boundary: a dedicated keychain unlocked from an fd-supplied password.
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SecKeychainOpen(path: *const c_char, keychain: *mut *mut c_void) -> i32;
    fn SecKeychainUnlock(keychain: *mut c_void, length: u32, password: *const c_void, use_password: u8) -> i32;
    fn SecKeychainLock(keychain: *mut c_void) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" { fn CFRelease(value: *const c_void); }
/// Fixed-capacity buffer: never reallocates, so no stale copy of the password survives.
struct Password { bytes: [u8; 1024], len: usize }
impl Password {
    fn read(fd: i32) -> Result<Self> {
        if fd < 3 { return Err(fail(64, "invalid-input", "Password fd must not be stdio")); }
        // SAFETY: the caller transfers this descriptor; File closes it when dropped.
        let mut file = unsafe { File::from_raw_fd(fd) };
        let mut password = Password { bytes: [0; 1024], len: 0 };
        loop {
            let read = file.read(&mut password.bytes[password.len..])?;
            if read == 0 { break; }
            password.len += read;
            if password.len == password.bytes.len() { return Err(fail(64, "invalid-input", "Password exceeds 1023 bytes")); }
        }
        if password.len > 0 && password.bytes[password.len - 1] == b'\n' { password.len -= 1; }
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
/// may have left it unlocked); dropping it locks again before releasing the reference.
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
        if status != 0 { return Err(signing("keychain-missing", format!("SecKeychainLock status {status}"))); }
        Ok(keychain)
    }
    /// Unlocks for one signing window; the returned guard relocks on every path.
    fn unlock(&self, password: Password) -> Result<UnlockWindow<'_>> {
        let length = u32::try_from(password.len).map_err(|_| fail(64, "invalid-input", "Password too long"))?;
        // SAFETY: the password pointer is valid for length bytes; usePassword is true, so no UI is shown.
        let status = unsafe { SecKeychainUnlock(self.0, length, password.bytes.as_ptr().cast(), 1) };
        drop(password);
        let window = UnlockWindow(self);
        if status != 0 { return Err(signing("unlock-failed", format!("SecKeychainUnlock status {status}"))); }
        Ok(window)
    }
}
impl Drop for Keychain {
    fn drop(&mut self) {
        // SAFETY: the reference came from SecKeychainOpen and is released exactly once.
        unsafe { SecKeychainLock(self.0); CFRelease(self.0); }
    }
}
struct UnlockWindow<'a>(&'a Keychain);
impl Drop for UnlockWindow<'_> {
    // SAFETY: the borrowed keychain reference outlives the window.
    fn drop(&mut self) { unsafe { SecKeychainLock(self.0.0); } }
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
    fn signature(&self, app: &Path) -> Result<String> { self.signature_with(app, &canonical_requirement(self.field("requirement")?)?) }
    /// Runs only codesign, so it is admissible inside the unlocked signing window.
    fn signature_with(&self, app: &Path, requirement: &str) -> Result<String> {
        let path = text(app)?;
        let strict = command("codesign", &["--verify", "--strict", path])?;
        let matches = command("codesign", &["-v", &format!("-R={requirement}"), path])?;
        let details = command("codesign", &["-d", "-r-", path])?;
        let details_text = format!("{}\n{}", String::from_utf8_lossy(&details.stdout), String::from_utf8_lossy(&details.stderr));
        let dr = details_text.lines().find_map(|line| line.strip_prefix("designated => ").map(str::to_owned)).unwrap_or_default();
        if !strict.status.success() || !matches.status.success() || !details.status.success() || dr != requirement { return Err(fail(22, "verification-failed", format!("Signature/DR mismatch: {dr}"))); }
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
        let daemon = self.field("session")? == "system-daemon";
        let session = self.session()?;
        let kind = match requested {
            "auto" if daemon => "system",
            "auto" if self.field("session")? == "gui-agent" && session != "gui" => return Err(fail(21, "gui-absent", "GUI agent requires gui/<uid>; no job operations performed")),
            "auto" if session == "gui" => "gui",
            "auto" if session == "background-only" => "user",
            "auto" => return Err(fail(21, "no-session", "No user launchd domain")),
            "gui" if session != "gui" => return Err(fail(21, "gui-absent", "Requested GUI domain absent")),
            "gui" | "user" if !daemon => requested,
            "system" if daemon => "system",
            _ => return Err(fail(64, "invalid-input", "Domain conflicts with session kind")),
        };
        Ok(if kind == "system" { kind.to_owned() } else { format!("{kind}/{}", unsafe { libc::geteuid() }) })
    }
    fn label(&self) -> Result<&str> { self.config["launchd"]["label"].as_str().ok_or_else(|| fail(64, "invalid-input", "Missing launchd label")) }
    fn job(&self, domain: &str) -> Result<(bool, Option<u32>)> {
        let out = command("launchctl", &["print", &format!("{domain}/{}", self.label()?)])?;
        let pid = String::from_utf8_lossy(&out.stdout).lines().find_map(|line| line.trim().strip_prefix("pid = ").and_then(|s| s.parse().ok()));
        Ok((out.status.success(), pid))
    }
    /// Signs the staged bundle. Only `codesign` runs while the keychain is unlocked; the
    /// identity lookup and requirement canonicalization happen before the window opens.
    fn sign(&self, keychain_path: &Path, keychain: &Keychain, stage: &Path) -> Result<()> {
        let identity = self.config["signer"]["identity"].as_str().filter(|s| !s.is_empty() && *s != "-").ok_or_else(|| fail(64, "invalid-input", "A certificate identity is required; ad-hoc signing is refused"))?;
        if !identity_in_keychain(keychain_path, identity)? { return Err(signing("identity-missing", "Identity not present in the dedicated keychain")); }
        let declared = self.field("requirement")?;
        let requirement = canonical_requirement(declared)?;
        let fd = self.arg("keychain-password-fd")?.parse::<i32>().map_err(|_| fail(64, "invalid-input", "Invalid password fd"))?;
        let password = Password::read(fd)?;
        let window = keychain.unlock(password)?;
        let signed = command("codesign", &["--force", "--keychain", text(keychain_path)?, "--sign", identity, "--requirements", &format!("=designated => {declared}"), text(stage)?])?;
        if !signed.status.success() { return Err(signing("sign-failed", String::from_utf8_lossy(&signed.stderr).trim().to_owned())); }
        let verified = self.signature_with(stage, &requirement);
        drop(window);
        verified.map_err(|e| signing("dr-mismatch", e.reason))?;
        Ok(())
    }
    fn install(&self) -> Result<Value> {
        let app = self.app()?; let desired = PathBuf::from(self.arg("desired")?);
        let expected = hash(&desired).ok_or_else(|| fail(64, "invalid-input", "Unsigned app lacks source hash marker"))?;
        let failure_marker = signing_failure_marker(&app);
        let record = |error: Failure| -> Failure {
            if let Some(category) = error.category {
                let marker = json!({"category": category, "reason": error.reason, "desiredHostSourceHash": expected});
                if let Err(write) = serde_json::to_vec(&marker).map_err(Failure::from).and_then(|bytes| atomic_write(&failure_marker, &bytes)) { return write; }
            }
            error
        };
        let current = || hash(&app).as_ref() == Some(&expected) && self.signature(&app).is_ok();
        if self.args.contains_key("signing-auth-pending") {
            // The consumer could not obtain the password; the keychain is not touched.
            if current() { return Ok(json!({"changed": false, "hostSourceHash": expected})); }
            return Err(record(signing("signing-auth-pending", "Consumer could not obtain the signing keychain password")));
        }
        // The login keychain is refused even on the no-op path, so misconfiguration is never silent.
        let keychain_arg = PathBuf::from(self.arg("keychain")?);
        if is_login_keychain(&fs::canonicalize(&keychain_arg).unwrap_or_else(|_| keychain_arg.clone())) { return Err(fail(64, "invalid-input", "The login keychain is never used for signing")); }
        let keychain_path = match fs::canonicalize(&keychain_arg) {
            Ok(path) if path.is_file() => path,
            Ok(_) => return Err(record(signing("keychain-missing", "Keychain path is not a file"))),
            Err(e) => return Err(record(signing("keychain-missing", e.to_string()))),
        };
        let keychain = Keychain::open_locked(&keychain_path).map_err(&record)?;
        if current() { return Ok(json!({"changed": false, "hostSourceHash": expected})); }
        let parent = app.parent().ok_or_else(|| fail(64, "invalid-input", "App requires parent"))?;
        fs::create_dir_all(parent)?;
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| fail(23, "operation-failed", e.to_string()))?.as_nanos();
        let stage = parent.join(format!(".{}.stage-{}-{nonce}", app.file_name().and_then(|s| s.to_str()).unwrap_or("app"), std::process::id()));
        checked("/bin/cp", &["-R", text(&desired)?, text(&stage)?])?;
        let result = (|| {
            checked("/bin/chmod", &["-R", "u+w", text(&stage)?])?;
            self.sign(&keychain_path, &keychain, &stage).map_err(&record)?;
            if app.exists() {
                exchange(&stage, &app)?;
                // The stage now is the signed incumbent; retain before publishing its pointer.
                if let Err(error) = select(&app.with_extension("previous"), &stage) { exchange(&stage, &app)?; return Err(error); }
            } else { fs::rename(&stage, &app)?; }
            if failure_marker.exists() { fs::remove_file(&failure_marker)?; }
            Ok(json!({"changed": true, "hostSourceHash": expected, "archive": pointer(&app.with_extension("previous"))}))
        })();
        if result.is_err() && stage.exists() && pointer(&app.with_extension("previous")).as_ref() != Some(&stage) { fs::remove_dir_all(stage)?; }
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
    fn converge(&self, force: bool) -> Result<Value> {
        let domain = self.domain()?;
        let app = self.app()?; let state = self.state()?;
        let program = app.join("Contents/MacOS").join(self.field("hostExecutable")?);
        let socket = self.arg("socket")?;
        let mut data = self.config["launchd"].clone();
        let object = data.as_object_mut().ok_or_else(|| fail(64, "invalid-input", "launchd must be object"))?;
        object.remove("label"); object.remove("keepAlive"); object.remove("runAtLoad");
        object.insert("Label".into(), json!(self.label()?)); object.insert("Program".into(), json!(program));
        object.insert("ProgramArguments".into(), json!([program, "serve", "--socket", socket, "--generation-pointer", state.join("current")]));
        object.insert("KeepAlive".into(), self.config["launchd"]["keepAlive"].clone()); object.insert("RunAtLoad".into(), self.config["launchd"]["runAtLoad"].clone());
        let bytes = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\">{}</plist>\n", plist(&data)?).into_bytes();
        let dir = PathBuf::from(self.arg("plist-dir")?); let path = dir.join(format!("{}.plist", self.label()?));
        let same = fs::read(&path).is_ok_and(|old| old == bytes); let (loaded, _) = self.job(&domain)?;
        // A host swap needs a restart; a generation-only change does not, because the host rereads the pointer.
        let installed_hash = hash(&app);
        let running_hash = if loaded { self.ipc().ok().and_then(|v| v["status"]["hostSourceHash"].as_str().map(str::to_owned)) } else { None };
        if same && loaded && !force && installed_hash == running_hash { return Ok(json!({"changed": false, "domain": domain})); }
        if loaded { checked("launchctl", &["bootout", &format!("{domain}/{}", self.label()?)])?; }
        if !same { fs::create_dir_all(&dir)?; atomic_write(&path, &bytes)?; }
        checked("launchctl", &["bootstrap", &domain, text(&path)?])?;
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
    fn verify_expected(&self, expected_hash: &str, generation: &Path) -> Result<Value> {
        let app = self.app()?; self.signature(&app)?;
        if hash(&app).as_deref() != Some(expected_hash) || pointer(&self.state()?.join("current")).as_deref() != Some(generation) { return Err(fail(22, "verification-failed", "Installed source or generation pointer differs")); }
        let manifest: Value = serde_json::from_slice(&fs::read(generation.join("manifest.json"))?)?;
        let domain = self.domain()?; let (loaded, pid) = self.job(&domain)?; let ipc = self.ipc()?;
        if !loaded || pid.is_none() || ipc["ok"] != true || ipc["status"]["hostSourceHash"] != expected_hash || ipc["status"]["generation"] != manifest["generation"] || ipc["status"]["pid"].as_u64() != pid.map(u64::from) { return Err(fail(22, "verification-failed", "IPC host hash/generation/PID does not match desired and launchd")); }
        Ok(json!({"verified": true, "domain": domain, "pid": pid, "hostSourceHash": expected_hash, "generation": generation}))
    }
    fn verify(&self) -> Result<Value> {
        let expected = hash(Path::new(self.arg("desired")?)).ok_or_else(|| fail(64, "invalid-input", "Desired app lacks source marker"))?;
        self.verify_expected(&expected, Path::new(self.arg("generation")?))
    }
    fn rollback(&self) -> Result<Value> {
        let state = self.state()?; let previous = pointer(&state.join("previous")).ok_or_else(|| fail(22, "verification-failed", "No previous generation"))?;
        let app = self.app()?;
        let restore_host = self.args.contains_key("restore-host");
        if restore_host {
            let archive = pointer(&app.with_extension("previous")).ok_or_else(|| fail(22, "verification-failed", "No archived host"))?;
            self.signature(&archive)?; exchange(&archive, &app)?;
        }
        select(&state.join("current"), &previous)?;
        self.converge(restore_host)?;
        let expected = hash(&app).ok_or_else(|| fail(22, "verification-failed", "Restored host lacks marker"))?;
        self.verify_expected(&expected, &previous)
    }
    fn status(&self) -> Result<Value> {
        let app = self.app()?; let state = self.state()?; let session = self.session()?;
        let domain = self.domain(); let job = domain.as_ref().ok().map(|d| self.job(d)).transpose()?;
        let dr = self.signature(&app);
        let signing_failure = fs::read(signing_failure_marker(&app)).ok().map(|b| serde_json::from_slice::<Value>(&b)).transpose()?;
        let ipc = self.ipc().ok();
        Ok(json!({"hostSourceHash": hash(&app), "drValid": dr.is_ok(), "requirement": dr.ok(), "activeGeneration": pointer(&state.join("current")), "previousGeneration": pointer(&state.join("previous")), "launchd": {"domain": domain.ok(), "loaded": job.map(|j| j.0).unwrap_or(false), "pid": job.and_then(|j| j.1)}, "session": session, "signingFailure": signing_failure, "running": ipc}))
    }
}
fn run() -> Result<Value> {
    let mut argv = std::env::args().skip(1); let action = argv.next().ok_or_else(|| fail(64, "invalid-input", "Missing primitive"))?;
    let mut args = BTreeMap::new();
    while let Some(flag) = argv.next() {
        let key = flag.strip_prefix("--").ok_or_else(|| fail(64, "invalid-input", "Expected --option"))?;
        if matches!(key, "restore-host" | "signing-auth-pending") { args.insert(key.to_owned(), String::new()); continue; }
        let value = argv.next().ok_or_else(|| fail(64, "invalid-input", "Missing option value"))?;
        if args.insert(key.to_owned(), value).is_some() { return Err(fail(64, "invalid-input", "Duplicate option")); }
    }
    let config_path = args.get("config").ok_or_else(|| fail(64, "invalid-input", "Missing --config"))?;
    let config = serde_json::from_slice(&fs::read(config_path)?)?; let ctl = Ctl { config, args };
    let result = match action.as_str() { "install-host" => ctl.install(), "select-generation" => ctl.generation(), "converge-launchd" => ctl.converge(false), "verify" => ctl.verify(), "rollback" => ctl.rollback(), "status" => ctl.status(), _ => Err(fail(64, "invalid-input", "Unknown primitive")) }?;
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
