//! A single permission-bearing process. Requests never select executable code.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use parking_lot::Mutex;
use std::time::Instant;
pub mod documents;
pub mod native;
pub mod control;
mod transport;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostError {
    pub code: &'static str,
    pub message: String,
    pub audit_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_required: Option<ActionRequired>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequired { pub category: String, pub next_step: String }
impl HostError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), audit_id: None, action_required: None }
    }
    pub fn permission(category: &str, message: impl Into<String>) -> Self {
        Self { action_required: Some(ActionRequired { category: category.into(), next_step: "Run explicit human-present onboarding for this host; runtime requests never prompt".into() }), ..Self::new("permission-required", message) }
    }
}
impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}: {}", self.code, self.message) }
}
impl std::error::Error for HostError {}
impl From<io::Error> for HostError {
    fn from(_: io::Error) -> Self { Self::new("operation-failed", "Host I/O failed") }
}
fn notification_interval() -> u64 { 1000 }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub uid: u32, pub socket: PathBuf, pub audit: PathBuf, pub staging: PathBuf,
    pub policy_revision: String, pub release_revision: String,
    pub enabled_grants: Vec<String>, pub automation_targets: Vec<String>,
    pub documents: DocumentsPolicy, pub products: BTreeMap<String, String>, pub audit_max_bytes: u64,
    #[serde(default = "notification_interval")]
    pub notification_min_interval_ms: u64,
    #[serde(default)]
    pub supervised_children: macos_app_security::children::Children,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentsPolicy { pub sources: BTreeMap<String, Source>, pub max_items: usize, pub max_bytes: u64, pub timeout_ms: u64 }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source { pub root: PathBuf, pub sentinel: String, #[serde(rename = "allowedBasenames")] pub allowed_basenames: Vec<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopyInput { pub source_id: String, pub files: Vec<String> }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult { pub staging_id: String, pub files: Vec<CopiedFile> }
#[derive(Debug, Serialize)]
pub struct CopiedFile { pub name: String, pub bytes: u64, pub sha256: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotifyInput { pub product_id: String, pub title: String, pub body: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyInput {}
#[derive(Deserialize)]
#[serde(tag = "operation", content = "input")]
pub enum Operation {
    #[serde(rename = "host.status")] Status(EmptyInput),
    #[serde(rename = "documents.copy")] Copy(CopyInput),
    #[serde(rename = "notify")] Notify(NotifyInput),
}
impl Operation {
    fn id(&self) -> &'static str { match self { Self::Status(_) => "host.status", Self::Copy(_) => "documents.copy", Self::Notify(_) => "notify" } }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationVersion { pub operation: &'static str, pub operation_version: u32 }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult { pub operations: Vec<OperationVersion>, pub policy_revision: String, pub release_revision: String, pub consent_pending: bool }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyResult { pub notification_id: String, pub submitted: bool }
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum OperationResult { Status(StatusResult), Copy(CopyResult), Notify(NotifyResult) }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditedResult { pub audit_id: String, #[serde(flatten)] pub output: OperationResult }
#[derive(Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum Response {
    Success { protocol_version: u32, request_id: String, ok: bool, result: AuditedResult },
    Failure { protocol_version: u32, request_id: Option<String>, ok: bool, error: HostError },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireRequest { protocol_version: u32, request_id: String, operation_version: u32, caller_label: String, operation: String, input: Value }
pub struct Request { request_id: String, caller_label: String, operation: Operation }
fn decode(bytes: &[u8]) -> Result<Request, HostError> {
    let wire: WireRequest = serde_json::from_slice(bytes).map_err(|_| HostError::new("invalid-request", "Invalid request envelope"))?;
    if wire.protocol_version != 1 || wire.operation_version != 1 { return Err(HostError::new("unsupported-version", "Only protocol and operation version 1 are supported")); }
    if wire.request_id.is_empty() || wire.request_id.len() > 64 || !wire.request_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') || wire.caller_label.len() > 128 { return Err(HostError::new("invalid-request", "Invalid correlation or caller label")); }
    if !["host.status", "documents.copy", "notify"].contains(&wire.operation.as_str()) { return Err(HostError::new("unknown-operation", "Operation is not registered")); }
    let operation: Operation = serde_json::from_value(json!({"operation":wire.operation,"input":wire.input})).map_err(|_| HostError::new("invalid-request", "Invalid operation input"))?;
    let symbolic_id = match &operation { Operation::Copy(input) => Some(&input.source_id), Operation::Notify(input) => Some(&input.product_id), Operation::Status(_) => None };
    if symbolic_id.is_some_and(|id| id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')) { return Err(HostError::new("invalid-request", "Invalid symbolic policy ID")); }
    Ok(Request { request_id: wire.request_id, caller_label: wire.caller_label, operation })
}
pub fn opaque_id() -> io::Result<String> {
    let mut bytes = [0_u8; 24];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(hex::encode(bytes))
}
fn private_directory(path: &Path, uid: u32) -> Result<(), HostError> {
    macos_app_security::endpoint::validate_directory(path, uid).map_err(|_| HostError::new("policy-denied", "Unsafe state directory"))?;
    let stat = std::fs::symlink_metadata(path)?;
    if stat.uid() != uid || stat.permissions().mode() & 0o777 != 0o700 { return Err(HostError::new("policy-denied", "State directory must be owner-only mode 0700")); }
    Ok(())
}
impl Config {
    pub fn load(path: &Path) -> Result<Self, HostError> {
        let bytes = std::fs::read(path)?;
        if bytes.len() > 1024 * 1024 { return Err(HostError::new("policy-denied", "Policy exceeds size bound")); }
        let config: Self = serde_json::from_slice(&bytes).map_err(|_| HostError::new("policy-denied", "Invalid policy"))?;
        config.validate()?;
        Ok(config)
    }
    fn validate(&self) -> Result<(), HostError> {
        self.supervised_children.require_inactive().map_err(|reason| HostError::new("policy-denied", reason))?;
        let grants = ["full-disk-access", "notifications", "screen-recording", "accessibility", "system-audio", "microphone", "automation"];
        if self.uid != unsafe { libc::geteuid() } || self.uid != unsafe { libc::getuid() } || self.audit_max_bytes < 4096 || self.audit_max_bytes > 1024 * 1024 * 1024 || self.documents.max_items == 0 || self.documents.max_items > 4096 || self.documents.max_bytes == 0 || self.documents.timeout_ms == 0 || self.documents.timeout_ms > 300_000 || self.policy_revision.is_empty() || self.release_revision.is_empty() || self.policy_revision.len() > 128 || self.release_revision.len() > 128 {
            return Err(HostError::new("policy-denied", "Invalid policy bounds or host UID"));
        }
        if self.enabled_grants.iter().any(|g| !grants.contains(&g.as_str())) || self.enabled_grants.iter().collect::<BTreeSet<_>>().len() != self.enabled_grants.len() || self.products.iter().any(|(id,label)| id.is_empty() || id.len()>128 || label.is_empty() || label.len()>128) || self.automation_targets.iter().any(|t| t.is_empty() || t.len()>255 || !t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')) { return Err(HostError::new("policy-denied", "Invalid grant or product policy")); }
        if self.automation_targets.len() > 64 { return Err(HostError::new("policy-denied", "Automation target count exceeds bound")); }
        if self.notification_min_interval_ms == 0 || self.notification_min_interval_ms > 3_600_000 { return Err(HostError::new("policy-denied", "Invalid notification rate policy")); }
        documents::validate_policy(&self.documents)?;
        private_directory(self.socket.parent().ok_or_else(|| HostError::new("policy-denied", "Socket needs parent"))?, self.uid)?;
        private_directory(self.audit.parent().ok_or_else(|| HostError::new("policy-denied", "Audit needs parent"))?, self.uid)?;
        private_directory(&self.staging, self.uid)?;
        Ok(())
    }
    fn grant(&self, category: &str) -> Result<(), HostError> {
        if self.enabled_grants.iter().any(|g| g == category) { Ok(()) } else { Err(HostError::new("policy-denied", "Required grant category disabled")) }
    }
}
struct Audit { file: File, max: u64, reserved: u64, failed: bool }
impl Audit {
    fn open(config: &Config) -> Result<Self, HostError> {
        let file = OpenOptions::new().create(true).append(true).read(true).mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&config.audit)?;
        let stat = file.metadata()?;
        if !stat.is_file() || stat.uid() != config.uid || stat.mode() & 0o777 != 0o600 || stat.nlink() != 1 { return Err(HostError::new("audit-unavailable", "Unsafe audit file")); }
        macos_app_security::endpoint::verify_acl_no_grants(&file).map_err(|_| HostError::new("audit-unavailable", "Unsafe audit ACL"))?;
        // An exclusive lifetime lock also serializes explicit onboarding against service work.
        if unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&file), libc::LOCK_EX | libc::LOCK_NB) } != 0 { return Err(HostError::new("busy", "Another host or onboarding session owns the audit")); }
        Ok(Self { file, max: config.audit_max_bytes, reserved: 0, failed: false })
    }
    fn append(&mut self, event: &Value) -> Result<(), HostError> { self.admit(event, 0) }
    fn admit(&mut self, event: &Value, terminal_capacity: u64) -> Result<(), HostError> {
        if self.failed { return Err(HostError::new("audit-unavailable", "Audit previously failed; restart after consumer repair")); }
        let mut bytes = serde_json::to_vec(event).map_err(|_| HostError::new("audit-unavailable", "Audit encoding failed"))?;
        bytes.push(b'\n');
        let length = self.file.metadata().map_err(|_| HostError::new("audit-unavailable", "Audit unavailable"))?.len();
        if length.saturating_add(bytes.len() as u64).saturating_add(self.reserved).saturating_add(terminal_capacity) > self.max { return Err(HostError::new("audit-unavailable", "Audit retention cannot accommodate admission and terminal outcome")); }
        if self.file.write_all(&bytes).and_then(|()| self.file.sync_all()).is_err() { self.failed = true; return Err(HostError::new("audit-unavailable", "Audit persistence failed")); }
        self.reserved += terminal_capacity;
        Ok(())
    }
    fn complete(&mut self, event: &Value, terminal_capacity: u64) -> Result<(), HostError> {
        self.reserved = self.reserved.checked_sub(terminal_capacity).ok_or_else(|| HostError::new("audit-unavailable", "Audit reservation invariant failed"))?;
        self.append(event)
    }
}
fn utc() -> String {
    // SAFETY: time_t and tm are live output buffers; gmtime_r has no shared mutable state.
    unsafe { let mut now = libc::time(std::ptr::null_mut()); let mut tm: libc::tm = std::mem::zeroed(); libc::gmtime_r(&mut now, &mut tm); format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",tm.tm_year+1900,tm.tm_mon+1,tm.tm_mday,tm.tm_hour,tm.tm_min,tm.tm_sec) }
}
pub struct Host { config: Config, audit: Mutex<Audit>, work: Mutex<()>, consent_pending: bool, last_notification: Mutex<Option<Instant>> }
impl Host {
    pub fn new(config: Config) -> Result<Self, HostError> {
        let mut audit = Audit::open(&config)?;
        let consent_pending = !read_consent(&config);
        audit.append(&json!({"phase":"recovery","utc":utc(),"releaseRevision":config.release_revision,"policyRevision":config.policy_revision,"priorAdmittedWork":"outcome-unknown-unless-terminal-recorded"}))?;
        Ok(Self { config, audit: Mutex::new(audit), work: Mutex::new(()), consent_pending, last_notification: Mutex::new(None) })
    }
    fn execute(&self, operation: &Operation, cancelled: &dyn Fn() -> bool) -> Result<OperationResult, HostError> {
        match operation {
            Operation::Status(_) => Ok(OperationResult::Status(StatusResult {
                operations: ["host.status", "documents.copy", "notify"].into_iter().filter(|operation| match *operation {
                    "documents.copy" => self.config.grant("full-disk-access").is_ok() && !self.config.documents.sources.is_empty(),
                    "notify" => self.config.grant("notifications").is_ok() && !self.config.products.is_empty(),
                    _ => true,
                }).map(|operation| OperationVersion { operation, operation_version: 1 }).collect(),
                policy_revision: self.config.policy_revision.clone(), release_revision: self.config.release_revision.clone(), consent_pending: self.consent_pending,
            })),
            Operation::Copy(input) => {
                self.config.grant("full-disk-access")?;
                if self.consent_pending { return Err(HostError::permission("full-disk-access", "Documents consent is pending human-present onboarding")); }
                documents::copy(&self.config.documents, &self.config.staging, input, cancelled).map(OperationResult::Copy)
            },
            Operation::Notify(input) => {
                self.config.grant("notifications")?;
                if input.title.len()>256 || input.body.len()>4096 { return Err(HostError::new("invalid-request", "Notification exceeds byte bounds")); }
                let label = self.config.products.get(&input.product_id).ok_or_else(|| HostError::new("policy-denied", "Unknown notification product"))?;
                let mut last = self.last_notification.lock();
                if last.is_some_and(|instant| instant.elapsed().as_millis() < u128::from(self.config.notification_min_interval_ms)) { return Err(HostError::new("busy", "Notification rate limit reached")); }
                *last = Some(Instant::now());
                let id = native::notify(label, &input.title, &input.body, cancelled)?;
                Ok(OperationResult::Notify(NotifyResult { notification_id: id, submitted: true }))
            }
        }
    }
    fn respond(&self, bytes: Result<Vec<u8>, HostError>, peer: Value, cancelled: &dyn Fn() -> bool) -> Value {
        let start = Instant::now();
        let decoded = bytes.and_then(|b| decode(&b));
        let id = match opaque_id() { Ok(id) => id, Err(_) => return failure(None, HostError::new("audit-unavailable", "Secure audit identity unavailable")) };
        let correlation = decoded.as_ref().ok().map(|r| r.request_id.clone());
        let operation = decoded.as_ref().ok().map(|r| r.operation.id());
        let caller = decoded.as_ref().ok().map(|r| r.caller_label.as_str());
        let mut audit = self.audit.lock();
        let target = decoded.as_ref().ok().map(|r| match &r.operation {
            Operation::Copy(input) => json!({"sourceId":input.source_id,"requestedItems":input.files.len()}),
            Operation::Notify(input) => json!({"productId":input.product_id}),
            Operation::Status(_) => json!({}),
        });
        // Six bytes per input byte covers maximal JSON escaping; 256 per receipt
        // covers SHA-256, u64 byte counts and framing. Fixed envelope slack also
        // bounds error outcomes. Outstanding reservations exclude other admissions.
        let terminal_capacity = decoded.as_ref().ok().map_or(2048, |r| match &r.operation {
            Operation::Copy(input) => 2048 + input.files.iter().map(|name| (name.len() as u64) * 6 + 256).sum::<u64>(),
            _ => 2048,
        });
        let admission = json!({"phase":"admission","auditId":id,"utc":utc(),"releaseRevision":self.config.release_revision,"policyRevision":self.config.policy_revision,"requestId":correlation,"operation":operation,"operationVersion":1,"target":target,"peer":peer,"callerLabel":{"asserted":caller,"authenticated":false}});
        if let Err(error) = audit.admit(&admission, terminal_capacity) { return failure(correlation, error); }
        drop(audit);
        let result = decoded.and_then(|request| {
            let _exclusion = self.work.try_lock().ok_or_else(|| HostError::new("busy", "Host operation in progress"))?;
            self.execute(&request.operation, cancelled)
        });
        let outcome = match &result { Ok(OperationResult::Copy(value)) => json!({"result":value}), Ok(OperationResult::Notify(value)) => json!({"result":value}), Ok(_) => json!({"result":"completed"}), Err(e) => json!({"error":e.code}) };
        let mut audit = self.audit.lock();
        if let Err(error) = audit.complete(&json!({"phase":"outcome","auditId":id,"utc":utc(),"requestId":correlation,"target":target,"durationMs":start.elapsed().as_millis(),"outcome":outcome}), terminal_capacity) { return failure(correlation, error); }
        match result {
            Ok(output) => serde_json::to_value(Response::Success { protocol_version: 1, request_id: correlation.unwrap_or_default(), ok: true, result: AuditedResult { audit_id: id, output } }).expect("Response contains only JSON-safe types"),
            Err(mut error) => { error.audit_id = Some(id); failure(correlation, error) }
        }
    }
    pub fn serve(self) -> Result<(), HostError> { transport::serve(Arc::new(self)) }
}
fn failure(request_id: Option<String>, error: HostError) -> Value {
    serde_json::to_value(Response::Failure { protocol_version: 1, request_id, ok: false, error }).expect("Error response contains only JSON-safe types")
}
fn consent_path(config: &Config) -> PathBuf { config.audit.with_extension("onboarding.json") }
fn read_consent(config: &Config) -> bool {
    let Ok(mut file) = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC).open(consent_path(config)) else { return false; };
    let Ok(stat) = file.metadata() else { return false; };
    if !stat.is_file() || stat.uid()!=config.uid || stat.mode() & 0o777 != 0o600 || stat.len()>65536 { return false; }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() { return false; }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { return false; };
    value["policyRevision"] == config.policy_revision && value["results"].as_array().is_some_and(|results| results.iter().any(|r| r["category"]=="full-disk-access" && r["status"]=="passed"))
}
pub fn onboard(config: Config) -> Result<Value, HostError> {
    let mut audit = Audit::open(&config)?;
    let id = opaque_id()?;
    audit.admit(&json!({"phase":"onboarding-admission","auditId":id,"utc":utc(),"policyRevision":config.policy_revision,"humanPresentExplicit":true}), 65536)?;
    let results = native::onboard(&config);
    let record = json!({"auditId":id,"utc":utc(),"policyRevision":config.policy_revision,"releaseRevision":config.release_revision,"results":results});
    audit.complete(&json!({"phase":"onboarding-outcome","record":record}), 65536)?;
    let path = consent_path(&config);
    let temporary = path.with_extension(format!("{}.tmp", opaque_id()?));
    let persist = (|| -> io::Result<()> {
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&temporary)?;
        file.write_all(&serde_json::to_vec(&record)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &path)?;
        File::open(path.parent().ok_or_else(|| io::Error::other("Missing parent"))?)?.sync_all()
    })();
    if persist.is_err() { let _ = std::fs::remove_file(&temporary); return Err(HostError::new("audit-unavailable", "Onboarding result persistence failed")); }
    Ok(record)
}
#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    #[test] fn strict_envelope() {
        assert!(decode(br#"{"protocolVersion":1,"requestId":"x","operationVersion":1,"callerLabel":"","operation":"host.status","input":{}}"#).is_ok());
        assert!(decode(br#"{"protocolVersion":1,"requestId":"x","operationVersion":1,"callerLabel":"","operation":"host.status","input":{"exec":"x"}}"#).is_err());
    }
    proptest! { #[test] fn arbitrary_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(),0..8192)) { let _ = decode(&bytes); } }
    #[test] fn consent_gate_starts_closed_without_record() {
        let config: Config = serde_json::from_value(json!({"uid":0,"socket":"/absent/socket","audit":"/absent/audit","staging":"/absent/staging","policyRevision":"p","releaseRevision":"r","enabledGrants":[],"automationTargets":[],"documents":{"sources":{},"maxItems":1,"maxBytes":1,"timeoutMs":1},"products":{},"auditMaxBytes":4096})).unwrap();
        assert!(!read_consent(&config));
    }
    fn test_config(root: &Path) -> Config {
        serde_json::from_value(json!({"uid":unsafe { libc::geteuid() },"socket":root.join("socket"),"audit":root.join("audit"),"staging":root,"policyRevision":"p","releaseRevision":"r","enabledGrants":["full-disk-access"],"automationTargets":[],"documents":{"sources":{},"maxItems":1,"maxBytes":1,"timeoutMs":1},"products":{},"auditMaxBytes":65536})).unwrap()
    }
    #[test] fn outcome_is_durable_before_success_response() {
        let root = std::env::temp_dir().join(opaque_id().unwrap());
        std::fs::create_dir(&root).unwrap();
        let host = Host::new(test_config(&root)).unwrap();
        let response = host.respond(Ok(br#"{"protocolVersion":1,"requestId":"x","operationVersion":1,"callerLabel":"","operation":"host.status","input":{}}"#.to_vec()), json!({}), &|| false);
        assert_eq!(response["ok"], true);
        let records: Vec<Value> = std::fs::read_to_string(root.join("audit")).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(records[1]["phase"], "admission");
        assert_eq!(records[2]["phase"], "outcome");
        assert_eq!(records[2]["auditId"], response["result"]["auditId"]);
        drop(host);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test] fn closed_consent_gate_blocks_copy_before_source_access() {
        let root = std::env::temp_dir().join(opaque_id().unwrap());
        std::fs::create_dir(&root).unwrap();
        let host = Host::new(test_config(&root)).unwrap();
        let error = host.execute(&Operation::Copy(CopyInput { source_id: "absent".into(), files: vec!["file".into()] }), &|| false).unwrap_err();
        assert_eq!(error.code, "permission-required");
        assert_eq!(error.action_required.unwrap().category, "full-disk-access");
        drop(host);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test] fn exhausted_audit_refuses_success() {
        let root = std::env::temp_dir().join(opaque_id().unwrap());
        std::fs::create_dir(&root).unwrap();
        let host = Host::new(test_config(&root)).unwrap();
        host.audit.lock().max = 1;
        let response = host.respond(Ok(br#"{"protocolVersion":1,"requestId":"x","operationVersion":1,"callerLabel":"","operation":"host.status","input":{}}"#.to_vec()), json!({}), &|| false);
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "audit-unavailable");
        assert_eq!(std::fs::read_to_string(root.join("audit")).unwrap().lines().count(), 1);
        drop(host);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test] fn fifo_consent_record_fails_closed_without_blocking() {
        use std::os::unix::ffi::OsStrExt;
        let root = std::env::temp_dir().join(opaque_id().unwrap());
        std::fs::create_dir(&root).unwrap();
        let config = test_config(&root);
        let path = std::ffi::CString::new(consent_path(&config).as_os_str().as_bytes()).unwrap();
        // SAFETY: path is a live NUL-terminated fixture pathname.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let start = Instant::now();
        let host = Host::new(config).unwrap();
        assert!(host.consent_pending);
        assert!(start.elapsed() < std::time::Duration::from_secs(1));
        drop(host);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test] fn admission_that_fits_without_its_outcome_refuses_work() {
        let root = std::env::temp_dir().join(opaque_id().unwrap());
        std::fs::create_dir(&root).unwrap();
        let host = Host::new(test_config(&root)).unwrap();
        host.audit.lock().max = 4096;
        let request = json!({"protocolVersion":1,"requestId":"x","operationVersion":1,"callerLabel":"","operation":"documents.copy","input":{"sourceId":"source","files":["a".repeat(255),"b".repeat(255)]}});
        let response = host.respond(Ok(serde_json::to_vec(&request).unwrap()), json!({}), &|| false);
        assert_eq!(response["error"]["code"], "audit-unavailable");
        assert_eq!(std::fs::read_to_string(root.join("audit")).unwrap().lines().count(), 1);
        drop(host);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test] fn outstanding_terminal_reservations_exclude_other_admissions() {
        let root = std::env::temp_dir().join(opaque_id().unwrap());
        std::fs::create_dir(&root).unwrap();
        let config = test_config(&root);
        let mut audit = Audit::open(&config).unwrap();
        audit.max = 4096;
        audit.admit(&json!({"phase":"admission"}), 4000).unwrap();
        assert!(audit.admit(&json!({"phase":"admission"}), 100).is_err());
        audit.complete(&json!({"phase":"outcome"}), 4000).unwrap();
        assert_eq!(audit.reserved, 0);
        drop(audit);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test] fn audit_projects_policy_target_but_not_notification_content() {
        let root = std::env::temp_dir().join(opaque_id().unwrap());
        std::fs::create_dir(&root).unwrap();
        let host = Host::new(test_config(&root)).unwrap();
        let request = json!({"protocolVersion":1,"requestId":"x","operationVersion":1,"callerLabel":"","operation":"notify","input":{"productId":"product","title":"private title","body":"private body"}});
        let _ = host.respond(Ok(serde_json::to_vec(&request).unwrap()), json!({}), &|| false);
        let raw = std::fs::read_to_string(root.join("audit")).unwrap();
        let events: Vec<Value> = raw.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(events[1]["target"]["productId"], "product");
        assert_eq!(events[2]["target"]["productId"], "product");
        assert!(!raw.contains("private title") && !raw.contains("private body"));
        drop(host);
        std::fs::remove_dir_all(root).unwrap();
    }
}
