//! Validate a consumer-owned plist without translating launchd's scheduling schema.
use super::*;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Component;
use std::process::Stdio;

pub(super) struct Validated {
    pub(super) domain: String,
    pub(super) target_uid: u32,
    pub(super) evidence: String,
    pub(super) bytes: Vec<u8>,
    pub(super) label: String,
    pub(super) program: PathBuf,
    pub(super) disabled: bool,
}

fn invalid(reason: impl Into<String>) -> Failure { fail(64, "invalid-input", reason) }

fn uid(value: &str) -> Result<u32> {
    if value.is_empty() || !value.bytes().all(|c| c.is_ascii_digit()) {
        return Err(invalid("UID must be an explicit unsigned decimal integer"));
    }
    let result: u32 = value.parse().map_err(|_| invalid("UID exceeds u32"))?;
    if result.to_string() != value { return Err(invalid("UID must use canonical decimal spelling")); }
    Ok(result)
}

fn validate_domain(session: &str, value: &str, target_uid: u32) -> Result<()> {
    let kind = if value == "system" { "system" } else {
        let (kind, suffix) = value.split_once('/').ok_or_else(|| invalid("Domain must be system, gui/UID or user/UID"))?;
        if !matches!(kind, "gui" | "user") || uid(suffix)? != target_uid {
            return Err(invalid("Domain UID must equal --target-uid"));
        }
        kind
    };
    if !matches!((session, kind), ("background-agent", "user" | "gui") | ("gui-agent", "gui") | ("system-daemon", "system")) {
        return Err(invalid("Domain violates the configured session constraint"));
    }
    Ok(())
}

fn safe_path(path: &Path) -> Result<()> {
    let spelling = text(path)?;
    if !path.is_absolute() || spelling.contains('\0') || spelling.contains("//")
        || spelling.split('/').any(|part| matches!(part, "." | ".."))
        || (spelling.len() > 1 && spelling.ends_with('/'))
        || path.components().any(|c| !matches!(c, Component::RootDir | Component::Normal(_))) {
        return Err(invalid(format!("Path must be absolute and normalized: {spelling}")));
    }
    Ok(())
}

fn protected_metadata(owner: u32, mode: u32, target_uid: u32) -> Result<()> {
    if owner != 0 && owner != target_uid { return Err(invalid("Path owner must be root or the explicit target UID")); }
    if mode & 0o022 != 0 { return Err(invalid("Path must not be group/world writable")); }
    Ok(())
}

/// No symlink component, including the final file; the consumer supplies canonical paths.
fn protected_path(path: &Path, target_uid: u32) -> Result<()> {
    safe_path(path)?;
    use std::os::fd::{AsRawFd, FromRawFd};
    let mut file = fs::OpenOptions::new().read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC).open("/")?;
    let parts: Vec<_> = path.components().skip(1).collect();
    let mut retained = Vec::new();
    for index in 0..=parts.len() {
        let metadata = file.metadata()?;
        protected_metadata(metadata.uid(), metadata.mode(), target_uid)?;
        macos_app_host::endpoint::verify_acl_no_grants(&file)
            .map_err(|error| invalid(format!("Unsafe path ACL: {error}")))?;
        if index == parts.len() {
            if !metadata.is_file() && !metadata.is_dir() { return Err(invalid("Protected input must be a regular file or directory")); }
            break;
        }
        if !metadata.is_dir() { return Err(invalid("Path parent is not a directory")); }
        let name = CString::new(parts[index].as_os_str().as_encoded_bytes())
            .map_err(|_| invalid("NUL in path"))?;
        let directory = if index + 1 < parts.len() { libc::O_DIRECTORY } else { 0 };
        // SAFETY: parent descriptor is retained; nofollow applies to each component.
        let fd = unsafe { libc::openat(file.as_raw_fd(), name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK | directory) };
        if fd < 0 { return Err(io::Error::last_os_error().into()); }
        retained.push(file);
        // SAFETY: openat returned a uniquely owned descriptor.
        file = unsafe { fs::File::from_raw_fd(fd) };
    }
    Ok(())
}

struct Input<'a> {
    session: &'a str,
    domain: &'a str,
    target_uid: u32,
    evidence: &'a str,
    label: &'a str,
    program: &'a Path,
    generic_argv: Option<Vec<String>>,
    // Resolved from the explicit UID, never from the current user/session.
    user_name: Option<&'a str>,
    group_name: Option<&'a str>,
}

fn validate_value(value: &Value, input: &Input<'_>) -> Result<()> {
    validate_domain(input.session, input.domain, input.target_uid)?;
    if !matches!(input.evidence, "resident" | "scheduled") { return Err(invalid("Evidence must be resident or scheduled")); }
    safe_path(input.program)?;
    if input.label.is_empty() || input.label.contains('/') || input.label.chars().any(char::is_control) {
        return Err(invalid("Configured launchd label is unsafe"));
    }
    let object = value.as_object().ok_or_else(|| invalid("Plist root must be a dictionary"))?;
    if object.get("Label").and_then(Value::as_str) != Some(input.label) { return Err(invalid("Plist Label differs from configured label")); }
    if object.get("Program").and_then(Value::as_str) != Some(text(input.program)?) {
        return Err(invalid("Program must be the direct installed Contents/MacOS entrypoint"));
    }
    let argv = object.get("ProgramArguments").and_then(Value::as_array).ok_or_else(|| invalid("ProgramArguments must be an array"))?;
    if argv.is_empty() || argv.iter().any(|v| v.as_str().is_none_or(|s| s.contains('\0')))
        || argv[0].as_str() != Some(text(input.program)?) {
        return Err(invalid("ProgramArguments must be strings with argv[0] exactly equal to Program"));
    }
    if let Some(expected) = &input.generic_argv {
        if argv.len() != expected.len() || argv.iter().zip(expected).any(|(actual, expected)| actual.as_str() != Some(expected.as_str())) {
            return Err(invalid("Generic host requires its exact closed serve argument contract"));
        }
    }
    // These keys can replace the direct executable, launch identity or selected domain.
    // Other launchd fields (calendars, environment, MachServices, etc.) remain opaque.
    for key in ["BundleProgram", "RootDirectory", "LimitLoadToUser", "LimitLoadToGroup", "SessionCreate", "JoinExistingSession", "AssociatedBundleIdentifiers", "Domain", "TargetUID", "UID", "GID"] {
        if object.contains_key(key) { return Err(invalid(format!("Reserved launchd override: {key}"))); }
    }
    if let Some(restriction) = object.get("LimitLoadToSessionType") {
        let expected = match input.domain.split('/').next() { Some("gui") => "Aqua", Some("user") => "Background", _ => return Err(invalid("System daemon cannot override session type")) };
        if restriction.as_str() != Some(expected) { return Err(invalid("LimitLoadToSessionType conflicts with explicit domain")); }
    }
    for (key, expected) in [("UserName", input.user_name), ("GroupName", input.group_name)] {
        if let Some(actual) = object.get(key) {
            if input.domain != "system" || expected.is_none() || actual.as_str() != expected {
                return Err(invalid(format!("{key} conflicts with the explicit target UID identity")));
            }
        }
    }
    if input.domain == "system" && input.target_uid != 0 && !object.contains_key("UserName") {
        return Err(invalid("A non-root system target requires matching UserName"));
    }
    Ok(())
}

fn account_names(target_uid: u32) -> Result<(String, String)> {
    use std::ffi::CStr;
    let mut buffer = vec![0_u8; 16 * 1024];
    let mut account = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut found = std::ptr::null_mut();
    // The reentrant lookup writes only into our account and backing buffer.
    let status = unsafe { libc::getpwuid_r(target_uid, account.as_mut_ptr(), buffer.as_mut_ptr().cast(), buffer.len(), &mut found) };
    if status != 0 || found.is_null() { return Err(invalid("Explicit target UID has no resolvable account")); }
    let account = unsafe { account.assume_init() };
    let name = unsafe { CStr::from_ptr(account.pw_name) }.to_str().map_err(|_| invalid("Account name must be UTF-8"))?.to_owned();
    let mut group_buffer = vec![0_u8; 16 * 1024];
    let mut group = std::mem::MaybeUninit::<libc::group>::uninit();
    let mut group_found = std::ptr::null_mut();
    let status = unsafe { libc::getgrgid_r(account.pw_gid, group.as_mut_ptr(), group_buffer.as_mut_ptr().cast(), group_buffer.len(), &mut group_found) };
    if status != 0 || group_found.is_null() { return Err(invalid("Target account has no resolvable primary group")); }
    let group = unsafe { group.assume_init() };
    let name_group = unsafe { CStr::from_ptr(group.gr_name) }.to_str().map_err(|_| invalid("Group name must be UTF-8"))?.to_owned();
    Ok((name, name_group))
}

pub(super) fn validate(ctl: &Ctl) -> Result<Validated> {
    let target_uid = uid(ctl.arg("target-uid")?)?;
    let domain = ctl.arg("domain")?;
    validate_domain(ctl.field("session")?, domain, target_uid)?;
    let evidence = ctl.arg("evidence")?;
    if !matches!(evidence, "resident" | "scheduled") { return Err(invalid("Evidence must be resident or scheduled")); }
    let source = PathBuf::from(ctl.arg("plist")?);
    protected_path(&source, target_uid)?;
    let mut file = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(&source)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() { return Err(invalid("Plist input must be a regular file")); }
    protected_metadata(metadata.uid(), metadata.mode(), target_uid)?;
    macos_app_host::endpoint::verify_acl_no_grants(&file)
        .map_err(|error| invalid(format!("Unsafe captured plist ACL: {error}")))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    // Parse exactly the protected snapshot returned to convergence, not a second path read.
    let mut child = Command::new("/usr/bin/plutil").args(["-convert", "json", "-o", "-", "--", "-"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let write_result = child.stdin.take().ok_or_else(|| invalid("plutil stdin unavailable"))?.write_all(&bytes);
    let output = child.wait_with_output()?;
    write_result?;
    if !output.status.success() { return Err(invalid(format!("Invalid plist: {}", String::from_utf8_lossy(&output.stderr)))); }
    let value: Value = serde_json::from_slice(&output.stdout)?;
    let app = ctl.app()?;
    safe_path(&app)?;
    let executable = ctl.field("hostExecutable")?;
    if executable.is_empty() || executable.contains('/') || matches!(executable, "." | "..") { return Err(invalid("hostExecutable must be a single filename")); }
    let program = app.join("Contents/MacOS").join(executable);
    protected_path(&program, target_uid)?;
    let metadata = fs::symlink_metadata(&program)?;
    if !metadata.is_file() || metadata.mode() & 0o111 == 0 { return Err(invalid("Installed entrypoint must be an executable regular file")); }
    let generic_argv = if executable == "macos-app-host" {
        let state = ctl.state()?;
        let socket = Path::new(ctl.arg("socket")?);
        safe_path(&state)?;
        safe_path(socket)?;
        protected_path(&state, target_uid)?;
        protected_path(socket.parent().ok_or_else(|| invalid("Socket has no parent"))?, target_uid)?;
        Some(vec![text(&program)?.to_owned(), "serve".into(), "--socket".into(), text(socket)?.to_owned(), "--generation-pointer".into(), text(&state.join("current"))?.to_owned()])
    } else { None };
    let names = if domain == "system" { Some(account_names(target_uid)?) } else { None };
    let label = ctl.label()?;
    validate_value(&value, &Input { session: ctl.field("session")?, domain, target_uid, evidence, label, program: &program, generic_argv,
        user_name: names.as_ref().map(|n| n.0.as_str()), group_name: names.as_ref().map(|n| n.1.as_str()) })?;
    if value.get("Disabled").is_some_and(|disabled| !disabled.is_boolean()) { return Err(invalid("Disabled must be a boolean")); }
    Ok(Validated { domain: domain.to_owned(), target_uid, evidence: evidence.to_owned(), bytes, label: label.to_owned(), program, disabled: value["Disabled"] == true })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> Input<'static> {
        Input { session: "background-agent", domain: "user/501", target_uid: 501, evidence: "scheduled", label: "org.example.worker",
            program: Path::new("/Applications/Worker.app/Contents/MacOS/worker"), generic_argv: None, user_name: Some("worker"), group_name: Some("staff") }
    }
    fn value() -> Value { json!({"Label":"org.example.worker", "Program":"/Applications/Worker.app/Contents/MacOS/worker", "ProgramArguments":["/Applications/Worker.app/Contents/MacOS/worker", "backup"]}) }

    #[test]
    fn refuses_implicit_or_mismatched_domains() {
        for value in ["auto", "gui", "user", "gui/0", "user/0501", "gui/501/extra", "system/501"] { assert!(validate_domain("background-agent", value, 501).is_err(), "{value}"); }
        assert!(validate_domain("gui-agent", "user/501", 501).is_err());
        assert!(validate_domain("system-daemon", "gui/501", 501).is_err());
        assert!(validate_domain("background-agent", "system", 501).is_err());
        assert!(validate_domain("background-agent", "gui/501", 501).is_ok());
        assert!(validate_domain("system-daemon", "system", 0).is_ok());
        for value in ["", "-1", "+501", " 501", "4294967296"] { assert!(uid(value).is_err()); }
    }

    #[test]
    fn refuses_substituted_entrypoints_and_identity() {
        for (key, replacement) in [("Label", json!("org.example.other")), ("Program", json!("/bin/sh")), ("ProgramArguments", json!(["/bin/sh"])), ("ProgramArguments", json!([])), ("ProgramArguments", json!(["/Applications/Worker.app/Contents/MacOS/worker", 1]))] {
            let mut value = value(); value[key] = replacement; assert!(validate_value(&value, &input()).is_err(), "{key}");
        }
        for key in ["BundleProgram", "RootDirectory", "UserName", "GroupName", "SessionCreate", "JoinExistingSession", "AssociatedBundleIdentifiers", "Domain", "TargetUID", "UID", "GID"] {
            let mut value = value(); value[key] = json!("override"); assert!(validate_value(&value, &input()).is_err(), "{key}");
        }
        let mut invalid_evidence = input(); invalid_evidence.evidence = "idle"; assert!(validate_value(&value(), &invalid_evidence).is_err());
    }

    #[test]
    fn system_identity_must_match_explicit_target() {
        let mut input = input(); input.session = "system-daemon"; input.domain = "system";
        assert!(validate_value(&value(), &input).is_err());
        let mut value = value(); value["UserName"] = json!("worker"); value["GroupName"] = json!("staff");
        assert!(validate_value(&value, &input).is_ok());
        value["UserName"] = json!("root"); assert!(validate_value(&value, &input).is_err());
        value["UserName"] = json!("worker"); value["GroupName"] = json!("wheel"); assert!(validate_value(&value, &input).is_err());
    }

    #[test]
    fn generic_arguments_are_closed_native_arguments_are_product_owned() {
        let mut input = input(); input.generic_argv = Some(vec![text(input.program).unwrap().into(), "serve".into(), "--socket".into(), "/opt/product/control.sock".into(), "--generation-pointer".into(), "/opt/product/state/current".into()]);
        let mut value = value(); assert!(validate_value(&value, &input).is_err());
        value["ProgramArguments"] = json!(input.generic_argv.as_ref().unwrap()); assert!(validate_value(&value, &input).is_ok());
        value["ProgramArguments"].as_array_mut().unwrap().push(json!("--extra")); assert!(validate_value(&value, &input).is_err());
        input.generic_argv = None; assert!(validate_value(&value, &input).is_ok());
    }

    #[test]
    fn preserves_consumer_launchd_inputs_without_a_schema_allowlist() {
        let mut value = value();
        value["StartCalendarInterval"] = json!([{"Hour": 4, "Minute": 10}]);
        value["EnvironmentVariables"] = json!({"MODE": "backup"});
        value["MachServices"] = json!({"org.example.worker.business": true});
        value["ConsumerFutureLaunchdKey"] = json!({"opaque": true});
        value["LimitLoadToSessionType"] = json!("Background");
        assert!(validate_value(&value, &input()).is_ok());
        value["LimitLoadToSessionType"] = json!("Aqua"); assert!(validate_value(&value, &input()).is_err());
    }

    #[test]
    fn refuses_unsafe_paths_and_unprotected_owners() {
        for path in ["relative.plist", "/safe/../input.plist", "/safe/./input.plist", "/safe//input.plist", "/safe/input.plist/", "/safe/\0input.plist"] { assert!(safe_path(Path::new(path)).is_err(), "{path:?}"); }
        assert!(safe_path(Path::new("/Applications/Worker.app/Contents/MacOS/worker")).is_ok());
        assert!(protected_metadata(502, 0o100644, 501).is_err());
        for mode in [0o100664, 0o100646, 0o40777] { assert!(protected_metadata(501, mode, 501).is_err()); }
        assert!(protected_metadata(0, 0o100644, 501).is_ok());
        assert!(protected_metadata(501, 0o100600, 501).is_ok());
    }
}
