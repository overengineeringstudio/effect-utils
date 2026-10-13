//! Nonresident primitives. The consumer serializes calls and owns transaction policy.
use serde_json::{json, Value};
use std::{collections::BTreeMap, ffi::CString, fs, io::{self, BufRead, BufReader, Write}, os::unix::{fs::symlink, net::UnixStream}, path::{Path, PathBuf}, process::{Command, Output}, time::Duration};

type Result<T, E = Failure> = std::result::Result<T, E>;
struct Failure { code: i32, kind: &'static str, reason: String }
fn fail(code: i32, kind: &'static str, reason: impl Into<String>) -> Failure { Failure { code, kind, reason: reason.into() } }
impl From<io::Error> for Failure { fn from(e: io::Error) -> Self { fail(23, "operation-failed", e.to_string()) } }
impl From<serde_json::Error> for Failure { fn from(e: serde_json::Error) -> Self { fail(64, "invalid-input", e.to_string()) } }
struct Ctl { config: Value, args: BTreeMap<String, String>, test: bool }
fn command(program: &str, args: &[&str]) -> Result<Output> { Ok(Command::new(program).args(args).output()?) }
fn checked(program: &str, args: &[&str]) -> Result<Output> { let out = command(program, args)?; if !out.status.success() { return Err(fail(23, "operation-failed", format!("{program}: {}", String::from_utf8_lossy(&out.stderr)))); } Ok(out) }
fn text(path: &Path) -> Result<&str> { path.to_str().ok_or_else(|| fail(64, "invalid-input", "Paths must be UTF-8")) }
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> { let tmp = path.with_extension(format!("tmp-{}", std::process::id())); let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?; f.write_all(bytes)?; f.sync_all()?; fs::rename(tmp, path)?; Ok(()) }
fn pointer(path: &Path) -> Option<PathBuf> { fs::read_link(path).ok() }
fn select(path: &Path, target: &Path) -> Result<()> { let tmp = path.with_extension(format!("tmp-{}", std::process::id())); symlink(target, &tmp)?; fs::rename(tmp, path)?; Ok(()) }
fn marker(app: &Path) -> PathBuf { app.join("Contents/Resources/host-source-hash") }
fn hash(app: &Path) -> Option<String> { fs::read_to_string(marker(app)).ok().map(|s| s.trim().to_owned()) }
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
impl Ctl {
    fn arg(&self, key: &str) -> Result<&str> { self.args.get(key).map(String::as_str).ok_or_else(|| fail(64, "invalid-input", format!("Missing --{key}"))) }
    fn field(&self, key: &str) -> Result<&str> { self.config[key].as_str().ok_or_else(|| fail(64, "invalid-input", format!("Invalid config {key}"))) }
    fn app(&self) -> Result<PathBuf> { Ok(PathBuf::from(self.arg("app-dir")?)) }
    fn state(&self) -> Result<PathBuf> { Ok(PathBuf::from(self.arg("state")?)) }
    fn requirement(&self) -> Result<String> { if self.test { Ok(format!("identifier \"{}\"", self.field("bundleId")?)) } else { Ok(self.field("requirement")?.to_owned()) } }
    fn signature(&self, app: &Path) -> Result<String> {
        let path = text(app)?;
        let strict = command("codesign", &["--verify", "--strict", path])?;
        let req = self.requirement()?;
        let matches = command("codesign", &["-v", &format!("-R={req}"), path])?;
        let details = command("codesign", &["-d", "-r-", path])?;
        let dr = String::from_utf8_lossy(&details.stderr).lines().find_map(|line| line.strip_prefix("designated => ").map(str::to_owned)).unwrap_or_default();
        if !strict.status.success() || !matches.status.success() || !details.status.success() || dr != req { return Err(fail(22, "verification-failed", format!("Signature/DR mismatch: {dr}"))); }
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
    fn install(&self) -> Result<Value> {
        let app = self.app()?; let desired = PathBuf::from(self.arg("desired")?);
        let expected = hash(&desired).ok_or_else(|| fail(64, "invalid-input", "Unsigned app lacks source hash marker"))?;
        if hash(&app).as_ref() == Some(&expected) && self.signature(&app).is_ok() { return Ok(json!({"changed": false, "hostSourceHash": expected})); }
        let parent = app.parent().ok_or_else(|| fail(64, "invalid-input", "App requires parent"))?;
        fs::create_dir_all(parent)?;
        let pending = app.with_extension("pending-signing.json");
        if !self.test && self.session()? != "gui" {
            let reason = "signing-needs-gui-session";
            atomic_write(&pending, &serde_json::to_vec(&json!({"reason": reason, "desiredHostSourceHash": expected}))?)?;
            return Err(fail(20, "pending-signing", reason));
        }
        let identity = if self.test { "-" } else { self.config["signer"]["identity"].as_str().filter(|s| !s.is_empty() && *s != "-").ok_or_else(|| fail(64, "invalid-input", "Production requires a certificate identity"))? };
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| fail(23, "operation-failed", e.to_string()))?.as_nanos();
        let stage = parent.join(format!(".{}.stage-{}-{nonce}", app.file_name().and_then(|s| s.to_str()).unwrap_or("app"), std::process::id()));
        checked("/bin/cp", &["-R", text(&desired)?, text(&stage)?])?;
        let result = (|| {
            checked("/bin/chmod", &["-R", "u+w", text(&stage)?])?;
            let requirement = self.requirement()?;
            let signed = command("codesign", &["--force", "--sign", identity, "--requirements", &format!("=designated => {requirement}"), text(&stage)?])?;
            if !signed.status.success() {
                let reason = String::from_utf8_lossy(&signed.stderr).trim().to_owned();
                atomic_write(&pending, &serde_json::to_vec(&json!({"reason": reason, "desiredHostSourceHash": expected}))?)?;
                return Err(fail(20, "pending-signing", reason));
            }
            self.signature(&stage)?;
            if app.exists() {
                exchange(&stage, &app)?;
                // The stage now is the signed incumbent; retain before publishing its pointer.
                if let Err(error) = select(&app.with_extension("previous"), &stage) { exchange(&stage, &app)?; return Err(error); }
            } else { fs::rename(&stage, &app)?; }
            if pending.exists() { fs::remove_file(&pending)?; }
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
        let mut digest = sha2::Sha256::new();
        use sha2::Digest;
        digest.update(text(&generation)?.as_bytes());
        let root = state.join("roots").join(format!("{:x}", digest.finalize()));
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
        use std::io::Read;
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
        if self.args.contains_key("restore-host") {
            let archive = pointer(&app.with_extension("previous")).ok_or_else(|| fail(22, "verification-failed", "No archived host"))?;
            self.signature(&archive)?; exchange(&archive, &app)?;
        }
        select(&state.join("current"), &previous)?;
        self.converge(self.args.contains_key("restore-host"))?;
        let expected = hash(&app).ok_or_else(|| fail(22, "verification-failed", "Restored host lacks marker"))?;
        self.verify_expected(&expected, &previous)
    }
    fn status(&self) -> Result<Value> {
        let app = self.app()?; let state = self.state()?; let session = self.session()?;
        let domain = self.domain(); let job = domain.as_ref().ok().map(|d| self.job(d)).transpose()?;
        let dr = self.signature(&app); let pending = fs::read(app.with_extension("pending-signing.json")).ok().map(|b| serde_json::from_slice::<Value>(&b)).transpose()?;
        let ipc = self.ipc().ok();
        Ok(json!({"hostSourceHash": hash(&app), "drValid": dr.is_ok(), "requirement": dr.ok(), "activeGeneration": pointer(&state.join("current")), "previousGeneration": pointer(&state.join("previous")), "launchd": {"domain": domain.ok(), "loaded": job.map(|j| j.0).unwrap_or(false), "pid": job.and_then(|j| j.1)}, "session": session, "pendingSigning": pending, "running": ipc}))
    }
}
fn run() -> Result<Value> {
    let mut argv = std::env::args().skip(1); let action = argv.next().ok_or_else(|| fail(64, "invalid-input", "Missing primitive"))?;
    let mut args = BTreeMap::new(); let mut test = false;
    while let Some(flag) = argv.next() {
        if flag == "--test-ad-hoc" { test = true; continue; }
        let key = flag.strip_prefix("--").ok_or_else(|| fail(64, "invalid-input", "Expected --option"))?;
        if key == "restore-host" { args.insert(key.to_owned(), String::new()); continue; }
        let value = argv.next().ok_or_else(|| fail(64, "invalid-input", "Missing option value"))?;
        if args.insert(key.to_owned(), value).is_some() { return Err(fail(64, "invalid-input", "Duplicate option")); }
    }
    let config_path = args.get("config").ok_or_else(|| fail(64, "invalid-input", "Missing --config"))?;
    let config = serde_json::from_slice(&fs::read(config_path)?)?; let ctl = Ctl { config, args, test };
    if test && ctl.config["allowTestSigning"] != true { return Err(fail(64, "invalid-input", "Production ctl refuses test signing")); }
    let result = match action.as_str() { "install-host" => ctl.install(), "select-generation" => ctl.generation(), "converge-launchd" => ctl.converge(false), "verify" => ctl.verify(), "rollback" => ctl.rollback(), "status" => ctl.status(), _ => Err(fail(64, "invalid-input", "Unknown primitive")) }?;
    Ok(json!({"ok": true, "primitive": action, "result": result}))
}
fn main() { match run() { Ok(v) => println!("{v}"), Err(e) => { println!("{}", json!({"ok": false, "error": {"kind": e.kind, "reason": e.reason}})); std::process::exit(e.code); } } }
