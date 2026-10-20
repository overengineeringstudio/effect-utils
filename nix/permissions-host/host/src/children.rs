//! Lifetime-owned child supervision. No request can select executable bytes or spawn policy.
use crate::{Audit, Config, HostError, opaque_id, utc};
use crate::transport::Role;
use macos_app_security::children::{Activation, Child, ProcessType, Readiness, Restart, Schedule, Session, StopSignal};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child as Process, Command, Stdio};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
const LOG_LIMIT: usize = 16384;
/// Rust-only registry: policy and requests cannot install handlers.
pub struct ProbeOperation {
    pub id: &'static str, pub requires_session: &'static str,
    /// A reviewed callback must observe the supplied absolute deadline before
    /// every blocking boundary. It must not spawn detached work or request consent.
    pub run: fn(&Config, &Child, &str, Instant) -> Result<ProbeOutcome, HostError>,
}
pub struct ScheduledOperation { pub id: &'static str, pub child_id: &'static str, pub requires_session: &'static str }
#[derive(Default)]
pub struct Registry { pub probes: Vec<ProbeOperation>, pub scheduled: Vec<ScheduledOperation> }
pub enum ProbeOutcome { Ready, Deferred { service: String, evidence: String }, Failed { code: String } }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildStatus {
    id: String, activation: &'static str, schedule: &'static str, requires_session: &'static str,
    state: &'static str, readiness: Option<Value>, instance_id: Option<String>, pid: Option<u32>,
    restart_count: u32, next_retry_at: Option<String>, last_exit: Option<Exit>, last_start: Option<Value>,
    policy_revision: String, release_revision: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Exit { code: Option<i32>, signal: Option<i32> }
struct Entry {
    status: ChildStatus, process: Option<Process>, probe_deadline: Option<Instant>, retry: Option<Instant>,
    suppressed: bool, logs: Vec<JoinHandle<()>>, log_stop: Arc<AtomicBool>, stderr_log: Option<File>, scheduled_inflight: bool,
    consent_blocked: bool, deferred_blocked: bool,
}
struct ScheduledLease<'a>(&'a Mutex<Entry>);
impl Drop for ScheduledLease<'_> {
    fn drop(&mut self) { self.0.lock().scheduled_inflight = false; }
}
struct Inner { config: Arc<Config>, audit: Arc<Mutex<Audit>>, entries: Vec<Mutex<Entry>>, role: Role, activated: AtomicBool, stop: AtomicBool, registry: Arc<Registry> }
pub struct Supervisor { inner: Arc<Inner>, worker: Mutex<Option<JoinHandle<()>>> }
pub fn process_type(value: &ProcessType) -> &'static str {
    match value { ProcessType::Background => "Background", ProcessType::Standard => "Standard", ProcessType::Interactive => "Interactive", ProcessType::Adaptive => "Adaptive" }
}
pub fn session_name(value: &Session) -> &'static str { match value { Session::None => "none", Session::Gui => "gui" } }
fn service_name(service: &macos_app_security::children::Service) -> &'static str {
    use macos_app_security::children::Service;
    match service {
        Service::FullDiskAccess=>"full-disk-access", Service::Notifications=>"notifications",
        Service::ScreenRecording=>"screen-recording", Service::Accessibility=>"accessibility",
        Service::Microphone=>"microphone", Service::SystemAudio=>"system-audio",Service::Automation=>"automation",
    }
}
fn owns(role: Role, child: &Child) -> bool { matches!((role, &child.requires_session), (Role::Supervisor, Session::None) | (Role::GuiAgent, Session::Gui)) }
/// These are compiled reviewed operations, not declaration-selected executable adapters.
/// New product operations must be added here with their permission/session contract.
impl Registry {
    pub fn validate(&self, config: &Config) -> Result<(), HostError> {
    validate_compiled_registry(self)?;
    let mut names = std::collections::BTreeSet::new();
    if self.probes.iter().any(|op| !names.insert(op.id)) || self.scheduled.iter().any(|op| !names.insert(op.id)) {
        return Err(HostError::new("duplicate-child-operation", "Compiled child operation IDs must be unique"));
    }
    for child in &config.supervised_children.0 {
        if child.required_tcc_services.iter().any(|service| !config.enabled_grants.iter().any(|enabled| enabled == service_name(service))) {
            return Err(HostError::new("child-grant-disabled", "Required child grant category is disabled in host policy"));
        }
        if let Readiness::ProbeOp { op, .. } = &child.readiness {
            if !self.probes.iter().any(|compiled| compiled.id == op && compiled.requires_session == session_name(&child.requires_session)) {
                return Err(HostError::new("unregistered-child-probe", "Child probe operation is absent or session-incompatible"));
            }
        }
        if let Schedule::LaunchdScheduled { op } = &child.schedule {
            if !self.scheduled.iter().any(|compiled| compiled.id == op && compiled.child_id == child.id && compiled.requires_session == session_name(&child.requires_session)) {
                return Err(HostError::new("unregistered-child-schedule", "Child scheduled operation is absent or session-incompatible"));
            }
        }
        let expected = config.job_process_types.get(session_name(&child.requires_session));
        if expected.map(String::as_str) != Some(process_type(&child.process_type)) {
            return Err(HostError::new("child-process-type-mismatch", "Child ProcessType must match its owning launchd job"));
        }
        if !config.helper_requirements.contains_key(&child.helper_path) {
            return Err(HostError::new("undeclared-helper", "Child is absent from the sealed helper inventory"));
        }
    }
    Ok(())
}
}
impl Supervisor {
    pub(crate) fn new(config: Arc<Config>, audit: Arc<Mutex<Audit>>, role: Role, consent_pending: bool, registry: Arc<Registry>) -> Result<Self, HostError> {
        let entries = config.supervised_children.0.iter().map(|child| Mutex::new(Entry {
            status: ChildStatus {
                id: child.id.clone(), activation: if child.activation == Activation::Active { "active" } else { "inactive" },
                schedule: match child.schedule { Schedule::Resident {} => "resident", Schedule::LaunchdScheduled { .. } => "launchd-scheduled" },
                requires_session: session_name(&child.requires_session),
                state: if child.activation != Activation::Active { "inactive" } else if consent_pending && !child.required_tcc_services.is_empty() { "stopped" } else if matches!(child.schedule, Schedule::LaunchdScheduled { .. }) { "running" } else { "starting" },
                readiness: if child.activation != Activation::Active { None } else if consent_pending && !child.required_tcc_services.is_empty() {
                    Some(json!({"outcome":"failed","code":"permission-required"}))
                } else if let Schedule::LaunchdScheduled { .. } = &child.schedule {
                    Some(scheduled_idle(child))
                } else { None },
                instance_id: None, pid: None,
                restart_count: 0, next_retry_at: None, last_exit: None, last_start: None,
                policy_revision: config.policy_revision.clone(), release_revision: config.release_revision.clone(),
            }, process: None, probe_deadline: None, retry: None,
            suppressed: consent_pending && !child.required_tcc_services.is_empty(), logs: Vec::new(), log_stop: Arc::new(AtomicBool::new(false)), stderr_log: None, scheduled_inflight: false,
            consent_blocked: consent_pending && !child.required_tcc_services.is_empty(),
            deferred_blocked: false,
        })).collect();
        registry.validate(&config)?;
        let inner = Arc::new(Inner { config, audit, entries, role, activated: AtomicBool::new(false), stop: AtomicBool::new(false), registry });
        let worker_inner = Arc::clone(&inner);
        let worker = thread::Builder::new().name("supervised-children".into()).spawn(move || {
            while !worker_inner.stop.load(Ordering::Acquire) {
                if !worker_inner.activated.load(Ordering::Acquire) {
                    thread::park_timeout(Duration::from_millis(20));
                    continue;
                }
                for (index, child) in worker_inner.config.supervised_children.0.iter().enumerate() {
                    if !owns(worker_inner.role, child) || child.activation != Activation::Active || !matches!(child.schedule, Schedule::Resident {}) { continue; }
                    let mut entry = worker_inner.entries[index].lock();
                    worker_inner.tick(child, &mut entry);
                }
                thread::park_timeout(Duration::from_millis(20));
            }
            for (index, child) in worker_inner.config.supervised_children.0.iter().enumerate() {
                if owns(worker_inner.role, child) { let mut entry = worker_inner.entries[index].lock(); let _ = worker_inner.stop_child(child, &mut entry); }
            }
        }).map_err(|_| HostError::new("child-supervisor-failed", "Cannot create child supervisor"))?;
        Ok(Self { inner, worker: Mutex::new(Some(worker)) })
    }
    /// Endpoint ownership is acquired before any resident or scheduled child work.
    pub(crate) fn activate(&self) {
        let worker = self.worker.lock();
        if !self.inner.stop.load(Ordering::Acquire) {
            self.inner.activated.store(true, Ordering::Release);
            if let Some(worker) = worker.as_ref() { worker.thread().unpark(); }
        }
    }
    /// Return only after the owning worker has stopped/reaped every child and
    /// joined its log workers. Retaining the lock through join makes concurrent
    /// shutdown calls wait for the same completed teardown, not just cancellation.
    pub(crate) fn shutdown(&self) {
        self.inner.stop.store(true, Ordering::Release);
        let mut worker = self.worker.lock();
        if let Some(worker) = worker.take() {
            worker.thread().unpark();
            if worker.join().is_err() {
                // A worker panic must not leave descendants or capture threads
                // alive after the service endpoint is released.
                for (index, child) in self.inner.config.supervised_children.0.iter().enumerate() {
                    if owns(self.inner.role, child) {
                        let mut entry = self.inner.entries[index].lock();
                        let _ = self.inner.stop_process(child, &mut entry);
                        self.inner.finish_logs(&mut entry);
                    }
                }
            }
        }
    }
    pub fn statuses(&self) -> Vec<ChildStatus> {
        let mut statuses: Vec<_> = self.inner.entries.iter().enumerate().filter(|(i,_)| owns(self.inner.role, &self.inner.config.supervised_children.0[*i])).map(|(_,entry)| entry.lock().status.clone()).collect();
        statuses.sort_by(|a,b| a.id.cmp(&b.id)); statuses
    }
    pub fn scheduled_ids(&self) -> Vec<&'static str> {
        self.inner.registry.scheduled.iter().filter(|operation| {
            self.inner.config.supervised_children.0.iter().any(|child| {
                child.activation == Activation::Active && child.id == operation.child_id
                    && matches!(&child.schedule, Schedule::LaunchdScheduled { op } if op == operation.id)
                    && (self.inner.role == Role::Supervisor || owns(self.inner.role, child))
            })
        }).map(|operation| operation.id).collect()
    }
    pub fn run_scheduled(&self, op: &str, cancelled: &dyn Fn()->bool) -> Result<Value,HostError> {
        if !self.inner.activated.load(Ordering::Acquire) || self.inner.stop.load(Ordering::Acquire) {
            return Err(HostError::new("child-supervisor-unavailable", "Child supervisor has no active endpoint ownership"));
        }
        let registered = self.inner.registry.scheduled.iter().find(|entry| entry.id == op).ok_or_else(|| HostError::new("unknown-operation","Scheduled operation is not compiled"))?;
        let index = self.inner.config.supervised_children.0.iter().position(|child| child.id == registered.child_id && matches!(&child.schedule,Schedule::LaunchdScheduled{op:declared} if declared == op)).ok_or_else(|| HostError::new("policy-denied","Scheduled child is not declared"))?;
        let child = &self.inner.config.supervised_children.0[index];
        if child.activation != Activation::Active { return Err(HostError::new("policy-denied","Scheduled child is inactive")); }
        if !owns(self.inner.role,child) { return Err(HostError::new("session-unavailable","Scheduled operation requires another session")); }
        {
            let mut entry = self.inner.entries[index].lock();
            if entry.process.is_some() || entry.scheduled_inflight { entry.status.last_start=Some(json!({"outcome":"skipped","reason":"already-running"})); self.inner.event(child,&entry,"skipped")?; return Ok(json!({"id":child.id,"outcome":"skipped","reason":"already-running"})); }
            if entry.consent_blocked || entry.deferred_blocked { return Err(HostError::new("permission-required","Child admission is suspended pending explicit reevaluation")); }
            entry.suppressed = false;
            self.inner.start(child,&mut entry)?;
            entry.scheduled_inflight = true;
        }
        let _lease = ScheduledLease(&self.inner.entries[index]);
        loop {
            let mut entry = self.inner.entries[index].lock();
            if cancelled() || self.inner.stop.load(Ordering::Acquire) {
                entry.suppressed = true;
                entry.retry = None;
                entry.status.next_retry_at = None;
                let _ = self.inner.stop_process(child, &mut entry);
                entry.status.state = "stopped";
                entry.status.readiness = None;
                if self.inner.event(child, &entry, "cancelled").is_err() { self.inner.audit_failed(child, &mut entry); }
                return Err(HostError::new("cancelled", "Scheduled child cancelled and reaped"));
            }
            self.inner.tick(child,&mut entry);
            if entry.process.is_none() { return Ok(json!({"id":child.id,"instanceId":entry.status.instance_id,"lastExit":entry.status.last_exit,"readiness":entry.status.readiness})); }
            drop(entry); thread::sleep(Duration::from_millis(10));
        }
    }
    pub fn gui_child(&self, id: &str) -> Result<bool, HostError> {
        self.inner.config.supervised_children.0.iter().find(|child| child.id == id).map(|child| matches!(child.requires_session, Session::Gui)).ok_or_else(|| HostError::new("unknown-child", "Child ID is not declared"))
    }
    pub fn stop(&self, id: &str) -> Result<Value, HostError> {
        let index = self.inner.config.supervised_children.0.iter().position(|child| child.id == id).ok_or_else(|| HostError::new("unknown-child", "Child ID is not declared"))?;
        let child = &self.inner.config.supervised_children.0[index];
        if !owns(self.inner.role, child) { return Err(HostError::new("session-unavailable", "Child belongs to another session")); }
        self.inner.stop_child(child, &mut self.inner.entries[index].lock())
    }
    pub fn missing_gui_statuses(&self) -> Vec<Value> {
        self.inner.config.supervised_children.0.iter().enumerate().filter(|(_,child)| matches!(child.requires_session, Session::Gui)).map(|(index,child)| {
            let mut value = serde_json::to_value(&self.inner.entries[index].lock().status).expect("JSON-safe status");
            if child.activation == Activation::Active { value["state"] = json!("stopped"); value["readiness"] = json!({"outcome":"failed","code":"session-unavailable"}); }
            value
        }).collect()
    }
}
impl Drop for Supervisor {
    fn drop(&mut self) { self.shutdown(); }
}
impl Inner {
    fn event(&self, child: &Child, entry: &Entry, kind: &str) -> Result<(), HostError> {
        self.audit.lock().append(&json!({"phase":"child","auditId":opaque_id()?,"utc":utc(),"childId":child.id,"instanceId":entry.status.instance_id,"event":kind,"state":entry.status.state,"readiness":entry.status.readiness,"restartCount":entry.status.restart_count,"releaseRevision":self.config.release_revision,"policyRevision":self.config.policy_revision,"exit":entry.status.last_exit}))
    }
    // Internal safety cleanup is not a client operation: an unavailable audit
    // must never prevent reaping work whose admission evidence could not persist.
    fn audit_failed(&self, child: &Child, entry: &mut Entry) {
        entry.suppressed = true;
        entry.retry = None;
        entry.status.next_retry_at = None;
        let _ = self.stop_process(child, entry);
        entry.status.state = "stopped";
        entry.status.readiness = Some(json!({"outcome":"failed","code":"audit-unavailable"}));
    }
    fn ready(&self, child: &Child, entry: &mut Entry, probe: &str, evidence: &str) {
        entry.status.state = "running";
        entry.status.readiness = Some(json!({"outcome":"ready","probe":probe,"evidence":evidence}));
        if self.event(child, entry, "ready").is_err() { self.audit_failed(child, entry); }
    }
    fn defer_exit(&self, child: &Child, entry: &mut Entry) -> bool {
        use std::io::{Seek, SeekFrom};
        let Some(file) = entry.stderr_log.as_mut() else { return false; };
        let mut bytes = [0_u8; LOG_LIMIT];
        if file.seek(SeekFrom::Start(0)).is_err() { return false; }
        let Ok(count) = file.read(&mut bytes) else { return false; };
        let Some(service) = stderr_permission_service(&bytes[..count]) else { return false; };
        let Readiness::ProbeOp { op, .. } = &child.readiness else { return false; };
        let Some(deadline) = entry.probe_deadline else { return false; };
        if Instant::now() >= deadline || self.stop.load(Ordering::Acquire) { return false; }
        let Some(probe) = self.registry.probes.iter().find(|probe| probe.id == op) else { return false; };
        let Ok(ProbeOutcome::Deferred { service: observed, evidence }) = (probe.run)(&self.config, child, entry.status.instance_id.as_deref().unwrap_or(""), deadline) else { return false; };
        if Instant::now() >= deadline || observed != service || !valid_deferral(child, &observed, &evidence) { return false; }
        let audit = opaque_id().map_err(HostError::from).and_then(|id| self.audit.lock().append(&json!({
            "phase":"child-probe","auditId":id,"utc":utc(),"childId":child.id,
            "instanceId":entry.status.instance_id,"releaseRevision":self.config.release_revision,
            "policyRevision":self.config.policy_revision,"service":observed,"evidence":evidence,"exitCode":75
        })));
        entry.suppressed = true;
        entry.deferred_blocked = true;
        entry.retry = None;
        entry.status.next_retry_at = None;
        entry.status.state = "stopped";
        entry.status.readiness = Some(if audit.is_ok() { json!({"outcome":"deferred","service":observed,"reason":"pending-grant"}) } else { json!({"outcome":"failed","code":"audit-unavailable"}) });
        true
    }
    fn fail(&self, child: &Child, entry: &mut Entry, code: &str) {
        entry.status.readiness = Some(json!({"outcome":"failed","code":code}));
        entry.status.state = "stopped";
        if let Restart::OnFailure { initial_backoff_ms, max_backoff_ms, max_attempts } = child.restart {
            if !entry.suppressed && entry.status.restart_count < max_attempts {
                let delay = backoff(initial_backoff_ms, max_backoff_ms, entry.status.restart_count);
                entry.status.restart_count += 1;
                entry.retry = Some(Instant::now() + Duration::from_millis(delay));
                entry.status.next_retry_at = Some(retry_timestamp(delay));
                entry.status.state = "backoff";
            } else { entry.suppressed = true; }
        } else { entry.suppressed = true; }
        if self.event(child, entry, "failed").is_err() { self.audit_failed(child, entry); }
    }
    fn tick(&self, child: &Child, entry: &mut Entry) {
        if let Some(process) = entry.process.as_mut() {
            match process.try_wait() {
                Ok(Some(status)) => {
                    use std::os::unix::process::ExitStatusExt;
                    entry.status.last_exit = Some(Exit { code: status.code(), signal: status.signal() });
                    if let Some(pid) = entry.status.pid { unsafe { libc::kill(-(pid as i32), libc::SIGKILL); } }
                    entry.process = None; entry.status.pid = None; self.finish_logs(entry);
                    if self.event(child, entry, "exit").is_err() { self.audit_failed(child, entry); return; }
                    if status.success() && matches!(child.schedule, Schedule::LaunchdScheduled { .. }) {
                        entry.suppressed = false;
                        entry.status.state = "running";
                        entry.status.readiness = Some(scheduled_idle(child));
                        return;
                    }
                    if status.code() == Some(75) && self.defer_exit(child, entry) { return; }
                    self.fail(child, entry, "child-exited"); return;
                }
                Err(_) => { let _ = self.stop_process(child, entry); self.fail(child, entry, "child-wait-failed"); return; }
                Ok(None) => {}
            }
            if entry.status.state == "starting" {
                match &child.readiness {
                    Readiness::None {} => self.ready(child, entry, "none", "spawn-only"),
                    Readiness::SocketAccepts { path, .. } => {
                        if socket_ready(path) { self.ready(child, entry, "socket-accepts", "probe-passed"); }
                        else if entry.probe_deadline.is_some_and(|deadline| Instant::now() >= deadline) { let _ = self.stop_process(child,entry); self.fail(child,entry,"child-readiness-timeout"); }
                    }
                    Readiness::ProbeOp { op, .. } => {
                        let Some(deadline) = entry.probe_deadline else {
                            let _ = self.stop_process(child, entry);
                            self.fail(child, entry, "child-readiness-deadline-missing");
                            return;
                        };
                        if Instant::now() >= deadline || self.stop.load(Ordering::Acquire) {
                            let _ = self.stop_process(child, entry);
                            self.fail(child, entry, "child-readiness-timeout");
                            return;
                        }
                        let outcome = self.registry.probes.iter().find(|probe| probe.id == op).ok_or_else(|| HostError::new("unregistered-child-probe","Probe missing")).and_then(|probe| (probe.run)(&self.config,child,entry.status.instance_id.as_deref().unwrap_or(""),deadline));
                        if Instant::now() >= deadline { let _=self.stop_process(child,entry); self.fail(child,entry,"child-readiness-timeout"); }
                        else { match outcome {
                            Ok(ProbeOutcome::Ready) => self.ready(child, entry, "probe-op", "probe-passed"),
                            Ok(ProbeOutcome::Deferred{service,evidence}) if valid_deferral(child,&service,&evidence) => {
                                let audit = opaque_id().map_err(HostError::from).and_then(|id| self.audit.lock().append(&json!({"phase":"child-probe","auditId":id,"utc":utc(),"childId":child.id,"instanceId":entry.status.instance_id,"releaseRevision":self.config.release_revision,"policyRevision":self.config.policy_revision,"service":service,"evidence":evidence})));
                                entry.suppressed=true; entry.deferred_blocked=true; let _=self.stop_process(child,entry); entry.status.state="stopped";
                                entry.status.readiness=Some(if audit.is_ok(){json!({"outcome":"deferred","service":service,"reason":"pending-grant"})}else{json!({"outcome":"failed","code":"audit-unavailable"})});
                                let _=self.event(child,entry,"deferred");
                            }
                            Ok(ProbeOutcome::Failed{code}) => { let _=self.stop_process(child,entry); self.fail(child,entry,if valid_failure_code(&code) { &code } else { "invalid-child-probe-code" }); }
                            Ok(ProbeOutcome::Deferred{..}) => { let _=self.stop_process(child,entry); self.fail(child,entry,"invalid-deferred-evidence"); }
                            Err(error) => { let _=self.stop_process(child,entry); self.fail(child,entry,error.code); }
                        } }
                    }
                }
            }
            return;
        }
        if entry.suppressed || entry.retry.is_some_and(|deadline| Instant::now() < deadline) { return; }
        entry.retry = None; entry.status.next_retry_at = None;
        match self.start(child, entry) { Ok(()) => {}, Err(error) => self.fail(child, entry, error.code) }
    }
    fn start(&self, child: &Child, entry: &mut Entry) -> Result<(), HostError> {
        if !self.activated.load(Ordering::Acquire) || self.stop.load(Ordering::Acquire) {
            return Err(HostError::new("child-supervisor-unavailable", "Child supervisor is paused or shutting down"));
        }
        if entry.process.is_some() { entry.status.last_start = Some(json!({"outcome":"skipped","reason":"already-running"})); self.event(child,entry,"skipped")?; return Ok(()); }
        entry.status.instance_id = Some(opaque_id()?); entry.status.state = "starting"; entry.status.readiness = None;
        self.event(child,entry,"admission")?;
        let (executable, _helper_file) = verified_helper(&self.config, child)?;
        let _state = provision(Path::new(&child.directories.state.path), self.config.uid, child.directories.state.mode)?;
        let _run = provision(Path::new(&child.directories.run.path), self.config.uid, child.directories.run.mode)?;
        let log_directory = provision(Path::new(&child.directories.log.path), self.config.uid, child.directories.log.mode)?;
        let stdout_log = open_log(&log_directory, c"stdout.tail", self.config.uid)?;
        let stderr_log = open_log(&log_directory, c"stderr.tail", self.config.uid)?;
        entry.stderr_log = Some(stderr_log.try_clone()?);
        let cwd = fs::canonicalize(&child.cwd)?;
        if cwd != Path::new(&child.cwd) { return Err(HostError::new("unsafe-child-directory", "Child working directory resolves through a symlink")); }
        let mut command = Command::new(executable);
        command.args(&child.argv).env_clear().envs(&child.env).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let limits = libc::rlimit { rlim_cur: child.rlimit_nofile.soft, rlim_max: child.rlimit_nofile.hard };
        let nice = i32::from(child.nice);
        // SAFETY: only async-signal-safe libc calls execute after fork. No allocation,
        // locks, Rust I/O or responsibility-disclaim API is used in this closure.
        unsafe { command.pre_exec(move || {
            if libc::setpgid(0,0) != 0 || libc::setrlimit(libc::RLIMIT_NOFILE, &limits) != 0 || libc::setpriority(libc::PRIO_PROCESS,0,nice) != 0 { return Err(std::io::Error::last_os_error()); }
            Ok(())
        }); }
        let mut process = command.spawn().map_err(|_| HostError::new("child-spawn-policy-failed", "Child spawn or pre-exec resource policy failed"))?;
        entry.status.pid = Some(process.id()); entry.status.last_start = Some(json!({"outcome":"started","reason":null}));
        entry.log_stop = Arc::new(AtomicBool::new(false));
        let stdout = process.stdout.take();
        let stderr = process.stderr.take();
        entry.process = Some(process);
        if let Some(pipe) = stdout {
            match capture(pipe, stdout_log, Arc::clone(&entry.log_stop)) {
                Ok(worker) => entry.logs.push(worker),
                Err(error) => { let _ = self.stop_process(child, entry); return Err(error); }
            }
        }
        if let Some(pipe) = stderr {
            match capture(pipe, stderr_log, Arc::clone(&entry.log_stop)) {
                Ok(worker) => entry.logs.push(worker),
                Err(error) => { let _ = self.stop_process(child, entry); return Err(error); }
            }
        }
        entry.probe_deadline = match child.readiness { Readiness::SocketAccepts { timeout_ms, .. } | Readiness::ProbeOp { timeout_ms, .. } => Some(Instant::now()+Duration::from_millis(u64::from(timeout_ms))), Readiness::None {} => None };
        if let Err(error) = self.event(child,entry,"spawn") { let _ = self.stop_process(child,entry); entry.suppressed = true; return Err(error); }
        Ok(())
    }
    fn finish_logs(&self, entry: &mut Entry) { entry.log_stop.store(true,Ordering::Release); for log in entry.logs.drain(..) { let _ = log.join(); } }
    fn stop_process(&self, child: &Child, entry: &mut Entry) -> Result<(), HostError> {
        if let Some(mut process) = entry.process.take() {
            let pid = process.id() as i32;
            let signal = match child.stop.signal { StopSignal::Int => libc::SIGINT, StopSignal::Term => libc::SIGTERM };
            unsafe { libc::kill(-pid, signal); }
            let deadline = Instant::now()+Duration::from_millis(u64::from(child.stop.grace_ms));
            let outcome = (|| -> std::io::Result<std::process::ExitStatus> {
                loop {
                    match process.try_wait() {
                        Ok(Some(status)) => return Ok(status),
                        Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                        Ok(None) | Err(_) => {
                            // SAFETY: this child owns the process group established before exec.
                            unsafe { libc::kill(-pid, libc::SIGKILL); }
                            return process.wait();
                        }
                    }
                }
            })();
            // Always terminate descendants, even if the direct child was already
            // reaped elsewhere or a wait syscall failed. No early `?` skips cleanup.
            unsafe { libc::kill(-pid, libc::SIGKILL); }
            entry.status.pid = None;
            self.finish_logs(entry);
            use std::os::unix::process::ExitStatusExt;
            let status = outcome?;
            entry.status.last_exit = Some(Exit { code: status.code(), signal: status.signal() });
        }
        Ok(())
    }
    fn stop_child(&self, child: &Child, entry: &mut Entry) -> Result<Value, HostError> {
        let already_stopped = entry.process.is_none();
        entry.suppressed = true; entry.retry = None; entry.status.next_retry_at = None;
        // An unauditable explicit operation must not signal a live process. Host
        // teardown remains responsible for reaping regardless of audit exhaustion.
        let admission = self.event(child,entry,"stop-admission");
        if admission.is_err() && !self.stop.load(Ordering::Acquire) { return Err(HostError::new("audit-unavailable", "Cannot admit child stop")); }
        self.stop_process(child,entry)?; entry.status.state = "stopped"; entry.status.readiness = None;
        let result = json!({"id":child.id,"instanceId":entry.status.instance_id,"alreadyStopped":already_stopped,"lastExit":entry.status.last_exit});
        self.event(child,entry,"stop")?; Ok(result)
    }
}
fn scheduled_idle(child: &Child) -> Value {
    let probe = match child.readiness {
        Readiness::None {} => "none",
        Readiness::SocketAccepts { .. } => "socket-accepts",
        Readiness::ProbeOp { .. } => "probe-op",
    };
    json!({"outcome":"ready","probe":probe,"evidence":"scheduled-idle"})
}
fn backoff(initial: u32, max: u32, attempt: u32) -> u64 { u64::from(initial).saturating_mul(1_u64.checked_shl(attempt).unwrap_or(u64::MAX)).min(u64::from(max)) }
fn validate_compiled_registry(registry: &Registry) -> Result<(), HostError> {
    fn segment(value: &str) -> bool {
        !value.is_empty() && value.len() <= 128 && value.as_bytes()[0].is_ascii_lowercase()
            && value.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    }
    if registry.scheduled.iter().any(|op| !segment(op.child_id)) {
        return Err(HostError::new("invalid-child-operation", "Compiled scheduled child ID is invalid"));
    }
    for (id, session) in registry.probes.iter().map(|op| (op.id, op.requires_session)).chain(registry.scheduled.iter().map(|op| (op.id, op.requires_session))) {
        let mut parts = id.split('.');
        if !parts.next().is_some_and(segment) || !parts.next().is_some_and(segment) || parts.next().is_some()
            || !["none", "gui"].contains(&session) || ["host.status", "documents.copy", "notify", "children.stop"].contains(&id) {
            return Err(HostError::new("invalid-child-operation", "Compiled child operation ID or session is invalid or reserved"));
        }
    }
    Ok(())
}
fn valid_failure_code(code: &str) -> bool {
    !code.is_empty() && code.len() <= 128 && code.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
fn stderr_permission_service(bytes: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(bytes).ok()?;
    let line = text.strip_suffix('\n').unwrap_or(text);
    let service = line.strip_prefix("deferred-admission: pending-grant: ")?;
    valid_failure_code(service).then_some(service)
}
fn retry_timestamp(delay_ms: u64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let future_ms = now.as_millis().saturating_add(u128::from(delay_ms));
    let seconds = (future_ms / 1000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both timestamp input and calendar output are live for this call.
    unsafe { libc::gmtime_r(&seconds, &mut tm); }
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec, future_ms % 1000)
}
fn verified_helper(config: &Config, child: &Child) -> Result<(PathBuf, File),HostError> {
    let exe = fs::canonicalize(std::env::current_exe()?)?;
    let bundle = exe.parent().and_then(Path::parent).and_then(Path::parent).ok_or_else(|| HostError::new("invalid-helper-bundle", "Host is not inside a bundle"))?;
    let host_requirement = macos_app_security::CompiledRequirement::compile(&config.host_requirement).map_err(|_| HostError::new("invalid-host-signature", "Invalid host signing requirement"))?;
    host_requirement.verify_path(bundle).map_err(|_| HostError::new("invalid-host-signature", "Host bundle seal verification failed"))?;
    let lexical = bundle.join(&child.helper_path); let resolved = fs::canonicalize(&lexical)?;
    if resolved != lexical || !resolved.starts_with(bundle.join("Contents/Helpers")) || !fs::symlink_metadata(&resolved)?.is_file() { return Err(HostError::new("invalid-helper-bundle", "Helper must be regular sealed nested code")); }
    // Keep a nofollow descriptor across signature verification and spawn. This
    // pins the admitted inode's lifetime; the sealed bundle's immutable placement
    // remains responsible for excluding concurrent namespace/content mutation.
    let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC).open(&resolved)?;
    let pinned = file.metadata()?;
    if !pinned.is_file() { return Err(HostError::new("invalid-helper-bundle", "Pinned helper is not a regular file")); }
    let requirement = config.helper_requirements.get(&child.helper_path).ok_or_else(|| HostError::new("undeclared-helper", "Helper has no pinned requirement"))?;
    macos_app_security::CompiledRequirement::compile(requirement).and_then(|requirement| requirement.verify_path(&resolved)).map_err(|_| HostError::new("invalid-helper-signature", "Nested helper signature verification failed"))?;
    let selected = fs::symlink_metadata(&resolved)?;
    if selected.dev() != pinned.dev() || selected.ino() != pinned.ino()
        || selected.len() != pinned.len() || selected.mtime() != pinned.mtime() || selected.mtime_nsec() != pinned.mtime_nsec()
        || selected.ctime() != pinned.ctime() || selected.ctime_nsec() != pinned.ctime_nsec() {
        return Err(HostError::new("invalid-helper-bundle", "Helper changed during signature verification"));
    }
    Ok((resolved, file))
}
fn valid_deferral(child: &Child, service: &str, evidence: &str) -> bool {
    let declared=child.required_tcc_services.iter().any(|required| service_name(required)==service);
    declared && !evidence.trim().is_empty() && evidence.chars().count()<=4096
}
fn provision(path: &Path, uid: u32, mode: u32) -> Result<File, HostError> {
    let unsafe_directory = || HostError::new("unsafe-child-directory", "Unsafe child directory owner, mode, ACL or ancestry");
    let bytes = path.as_os_str().as_bytes();
    if !path.is_absolute() || mode > 0o777 || bytes.split(|byte| *byte == b'/').any(|part| part == b"." || part == b"..") {
        return Err(unsafe_directory());
    }
    let parts: Vec<_> = path.components().filter_map(|part| match part {
        std::path::Component::Normal(name) => Some(CString::new(name.as_bytes())),
        _ => None,
    }).collect::<Result<_, _>>().map_err(|_| unsafe_directory())?;
    if parts.is_empty() { return Err(unsafe_directory()); }
    // SAFETY: a fixed root directory is opened nofollow and adopted exactly once.
    let raw = unsafe { libc::open(c"/".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if raw < 0 { return Err(std::io::Error::last_os_error().into()); }
    let mut parent = unsafe { File::from_raw_fd(raw) };
    for (index, name) in parts.iter().enumerate() {
        let final_component = index + 1 == parts.len();
        validate_directory_fd(&parent, uid, None)?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: the held verified parent and NUL-terminated child name remain live.
        let mut raw = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if raw < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            let requested = if final_component { mode } else { 0o700 };
            let created = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), requested as libc::mode_t) };
            if created != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) { return Err(std::io::Error::last_os_error().into()); }
            raw = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        }
        if raw < 0 { return Err(unsafe_directory()); }
        let directory = unsafe { File::from_raw_fd(raw) };
        validate_directory_fd(&directory, uid, if final_component { Some(mode) } else { None })?;
        parent = directory;
    }
    Ok(parent)
}
fn validate_directory_fd(file: &File, uid: u32, exact_mode: Option<u32>) -> Result<(), HostError> {
    let metadata = file.metadata()?;
    let sticky_root = metadata.uid() == 0 && metadata.mode() & 0o1000 != 0;
    if !metadata.is_dir() || (metadata.uid() != 0 && metadata.uid() != uid)
        || exact_mode.is_some_and(|mode| metadata.uid() != uid || metadata.mode() & 0o777 != mode)
        || (exact_mode.is_none() && metadata.mode() & 0o022 != 0 && !sticky_root) {
        return Err(HostError::new("unsafe-child-directory", "Unsafe child directory owner or mode"));
    }
    macos_app_security::endpoint::verify_acl_no_grants(file)
        .map_err(|_| HostError::new("unsafe-child-directory", "Unsafe child directory ACL"))
}
fn open_log(directory: &File, name: &std::ffi::CStr, uid: u32) -> Result<File, HostError> {
    // O_NONBLOCK prevents a hostile preexisting FIFO/device from hanging admission.
    let raw = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), libc::O_CREAT | libc::O_RDWR | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) };
    if raw < 0 { return Err(HostError::new("unsafe-child-log", "Cannot open private child log")); }
    let file = unsafe { File::from_raw_fd(raw) };
    let metadata = file.metadata()?;
    if metadata.uid() != uid || metadata.mode() & 0o777 != 0o600 || metadata.nlink() != 1 || !metadata.is_file() {
        return Err(HostError::new("unsafe-child-log", "Unsafe private child log"));
    }
    macos_app_security::endpoint::verify_acl_no_grants(&file).map_err(|_| HostError::new("unsafe-child-log", "Unsafe child log ACL"))?;
    // Never truncate before all ownership/type/link/mode/ACL checks have passed.
    file.set_len(0)?;
    Ok(file)
}
fn socket_ready(path: &str) -> bool {
    // A nonblocking connect cannot stall the supervisor on a full socket backlog.
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let bytes = Path::new(path).as_os_str().as_bytes();
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.len() >= address.sun_path.len() { return false; }
    address.sun_family = libc::AF_UNIX as _;
    for (to,from) in address.sun_path.iter_mut().zip(bytes) { *to = *from as _; }
    let raw = unsafe { libc::socket(libc::AF_UNIX,libc::SOCK_STREAM,0) };
    if raw < 0 { return false; }
    let stream = unsafe { UnixStream::from_raw_fd(raw) };
    if stream.set_nonblocking(true).is_err() { return false; }
    unsafe { libc::fcntl(stream.as_raw_fd(),libc::F_SETFD,libc::FD_CLOEXEC); libc::connect(raw, (&raw const address).cast(), std::mem::size_of_val(&address) as _) == 0 }
}
fn capture(mut input: impl Read + AsRawFd + Send + 'static, mut file: File, stop: Arc<AtomicBool>) -> Result<JoinHandle<()>, HostError> {
    thread::Builder::new().name("child-log".into()).spawn(move || {
        let mut bytes = VecDeque::with_capacity(LOG_LIMIT); let mut buffer = [0_u8;4096];
        let mut shutdown_remaining = LOG_LIMIT;
        loop {
            let stopping = stop.load(Ordering::Acquire);
            if stopping && shutdown_remaining == 0 { break; }
            let mut poll = libc::pollfd { fd: input.as_raw_fd(), events: libc::POLLIN, revents:0 };
            let ready = unsafe { libc::poll(&mut poll,1,if stopping { 0 } else { 100 }) };
            if ready < 0 { break; }
            if ready == 0 { if stop.load(Ordering::Acquire) { break; } continue; }
            let count = match input.read(&mut buffer) { Ok(0) => break, Ok(count) => count, Err(_) => break };
            if stopping { shutdown_remaining = shutdown_remaining.saturating_sub(count); }
            let excess = (bytes.len()+count).saturating_sub(LOG_LIMIT); bytes.drain(..excess); bytes.extend(&buffer[..count]);
            use std::io::{Seek,SeekFrom};
            if file.seek(SeekFrom::Start(0)).and_then(|_| file.write_all(bytes.make_contiguous())).and_then(|_| file.set_len(bytes.len() as u64)).is_err() { break; }
        }
    }).map_err(|_| HostError::new("child-log-failed", "Cannot create bounded child log worker"))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn runtime_fixture(root: &Path, readiness: Value, schedule: Value) -> (Config, Registry) {
        let restart = if schedule["kind"] == "launchd-scheduled" { json!({"kind":"never"}) }
            else { json!({"kind":"on-failure","initialBackoffMs":10,"maxBackoffMs":100,"maxAttempts":2}) };
        let config = serde_json::from_value(json!({
            "uid":unsafe { libc::geteuid() },"socket":root.join("socket"),
            "audit":root.join("audit"),"staging":root,"policyRevision":"policy","releaseRevision":"release",
            "enabledGrants":[],"automationTargets":[],"products":{},"auditMaxBytes":65536,
            "documents":{"sources":{},"maxItems":1,"maxBytes":1,"timeoutMs":1},
            "helperRequirements":{"Contents/Helpers/worker":"identifier test.worker"},
            "jobProcessTypes":{"none":"Standard"},
            "supervisedChildren":[{
                "id":"worker","activation":"active","helperPath":"Contents/Helpers/worker",
                "argv":[],"env":{},"cwd":root,"requiredTccServices":[],"requiresSession":"none",
                "rlimitNofile":{"soft":128,"hard":128},"nice":0,"processType":"Standard",
                "directories":{"state":{"path":root.join("state")},"run":{"path":root.join("run")},"log":{"path":root.join("log")}},
                "clientSocket":root.join("run/probe"),"readiness":readiness,"restart":restart,
                "stop":{"signal":"term","graceMs":100},"schedule":schedule
            }]
        })).unwrap();
        let registry = Registry {
            probes: vec![ProbeOperation { id:"worker.ready",requires_session:"none",run:|_,_,_,_| Ok(ProbeOutcome::Ready) }],
            scheduled: vec![ScheduledOperation { id:"worker.run",child_id:"worker",requires_session:"none" }],
        };
        (config, registry)
    }
    #[test] fn fresh_scheduled_child_has_verifiable_idle_receipt() {
        let root = root();
        let (config, registry) = runtime_fixture(&root, json!({"kind":"probe-op","op":"worker.ready","timeoutMs":1000}), json!({"kind":"launchd-scheduled","op":"worker.run"}));
        let audit = Arc::new(Mutex::new(Audit::open(&config).unwrap()));
        let supervisor = Supervisor::new(Arc::new(config), audit, Role::Supervisor, false, Arc::new(registry)).unwrap();
        let status = &supervisor.statuses()[0];
        assert_eq!(status.readiness, Some(json!({"outcome":"ready","probe":"probe-op","evidence":"scheduled-idle"})));
        assert!(status.pid.is_none());
        assert!(status.instance_id.is_none());
        {
            let child = &supervisor.inner.config.supervised_children.0[0];
            let mut entry = supervisor.inner.entries[0].lock();
            let mut process = Command::new("/usr/bin/true").process_group(0).spawn().unwrap();
            process.wait().unwrap();
            entry.process = Some(process);
            supervisor.inner.tick(child, &mut entry);
            assert_eq!(entry.status.readiness, status.readiness);
            assert_eq!(entry.status.last_exit.as_ref().unwrap().code, Some(0));
        }
        supervisor.shutdown();
        drop(supervisor);
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn failed_readiness_audit_reaps_all_readiness_kinds() {
        for kind in ["none", "socket-accepts", "probe-op"] {
            // Darwin's per-user temp prefix plus a UUID exceeds sockaddr_un;
            // retain a unique owner-only fixture under the short sticky root.
            let root = fs::canonicalize("/tmp").unwrap().join(format!("cr-{}", opaque_id().unwrap()));
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
            fs::create_dir(root.join("run")).unwrap();
            let socket = root.join("run/probe");
            let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
            let readiness = match kind {
                "none" => json!({"kind":"none"}),
                "socket-accepts" => json!({"kind":kind,"path":socket,"timeoutMs":1000}),
                _ => json!({"kind":kind,"op":"worker.ready","timeoutMs":1000}),
            };
            let (config, registry) = runtime_fixture(&root, readiness, json!({"kind":"resident"}));
            let audit = Arc::new(Mutex::new(Audit::open(&config).unwrap()));
            // Exercise real audit retention failure, not a mocked event callback.
            audit.lock().max = 0;
            let supervisor = Supervisor::new(Arc::new(config), audit, Role::Supervisor, false, Arc::new(registry)).unwrap();
            let child = &supervisor.inner.config.supervised_children.0[0];
            {
                let mut entry = supervisor.inner.entries[0].lock();
                let process = Command::new("/bin/sleep").arg("60").process_group(0).spawn().unwrap();
                let pid = process.id();
                entry.process = Some(process);
                entry.status.pid = Some(pid);
                entry.probe_deadline = Some(Instant::now() + Duration::from_secs(1));
                supervisor.inner.tick(child, &mut entry);
                assert!(entry.process.is_none(), "{kind}");
                assert!(entry.status.pid.is_none(), "{kind}");
                assert_eq!(entry.status.state, "stopped", "{kind}");
                assert_eq!(entry.status.readiness, Some(json!({"outcome":"failed","code":"audit-unavailable"})), "{kind}");
                assert!(entry.suppressed && entry.retry.is_none(), "{kind}");
                assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1, "{kind}");
                assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH), "{kind}");
            }
            supervisor.shutdown();
            drop(supervisor);
            drop(listener);
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test] fn retry_delay_caps_without_overflow() { assert_eq!(backoff(100,1000,0),100); assert_eq!(backoff(100,1000,3),800); assert_eq!(backoff(100,1000,100),1000); }
    fn root() -> PathBuf {
        let path = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("child-runtime-{}", opaque_id().unwrap()));
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        path
    }
    #[test] fn provision_rejects_symlink_ancestors() {
        let root = root();
        std::os::unix::fs::symlink(&root, root.join("redirect")).unwrap();
        assert!(provision(&root.join("redirect/new"), unsafe { libc::geteuid() }, 0o700).is_err());
        assert!(!root.join("new").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn unsafe_log_is_not_truncated() {
        let root = root();
        let uid = unsafe { libc::geteuid() };
        let directory = provision(&root, uid, 0o700).unwrap();
        let mut file = open_log(&directory, c"stdout.tail", uid).unwrap();
        file.write_all(b"preserve protected bytes").unwrap();
        fs::hard_link(root.join("stdout.tail"), root.join("another-link")).unwrap();
        assert!(open_log(&directory, c"stdout.tail", uid).is_err());
        assert_eq!(fs::read(root.join("stdout.tail")).unwrap(), b"preserve protected bytes");
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn log_worker_stops_with_open_pipe() {
        let root = root();
        let uid = unsafe { libc::geteuid() };
        let directory = provision(&root, uid, 0o700).unwrap();
        let file = open_log(&directory, c"stdout.tail", uid).unwrap();
        let (input, mut output) = UnixStream::pair().unwrap();
        output.write_all(b"bounded diagnostic").unwrap();
        let stop = Arc::new(AtomicBool::new(true));
        capture(input, file, stop).unwrap().join().unwrap();
        assert_eq!(fs::read(root.join("stdout.tail")).unwrap(), b"bounded diagnostic");
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn typed_stderr_diagnostic_is_closed() {
        assert_eq!(stderr_permission_service(b"deferred-admission: pending-grant: full-disk-access\n"), Some("full-disk-access"));
        assert!(stderr_permission_service(b"permission denied").is_none());
        assert!(stderr_permission_service(b"deferred-admission: not-pending: full-disk-access").is_none());
        assert!(stderr_permission_service(b"deferred-admission: pending-grant: full-disk-access\nextra").is_none());
        assert!(stderr_permission_service(br#"{"outcome":"deferred","service":"full-disk-access","reason":"pending-grant"}"#).is_none());
    }
    #[test] fn compiled_registry_rejects_reserved_ids_and_unknown_sessions() {
        for (id, session) in [("host.status","none"), ("bad","none"), ("a.b.c","gui"), ("good.probe","ssh")] {
            let registry = Registry { probes: vec![], scheduled: vec![ScheduledOperation { id, child_id: "worker", requires_session: session }] };
            assert!(validate_compiled_registry(&registry).is_err());
        }
        let registry = Registry { probes: vec![], scheduled: vec![ScheduledOperation { id:"worker.run", child_id:"worker", requires_session:"none" }] };
        assert!(validate_compiled_registry(&registry).is_ok());
    }
    #[test] fn failure_codes_remain_stable_and_bounded() {
        assert!(valid_failure_code("permission-not-observed"));
        assert!(!valid_failure_code(""));
        assert!(!valid_failure_code("private path /details"));
        assert!(!valid_failure_code(&"x".repeat(129)));
    }
    #[test] fn deferral_requires_declared_enabled_service_and_bounded_evidence() {
        let children: macos_app_security::children::Children = serde_json::from_value(json!([{
            "id":"worker","helperPath":"Contents/Helpers/worker","argv":[],"env":{},"cwd":"/",
            "requiredTccServices":["full-disk-access"],"requiresSession":"none",
            "rlimitNofile":{"soft":128,"hard":128},"nice":0,"processType":"Standard",
            "directories":{"state":{"path":"/example/state"},"run":{"path":"/example/run"},"log":{"path":"/example/log"}},
            "readiness":{"kind":"none"},"restart":{"kind":"never"},"stop":{"signal":"term","graceMs":100},
            "schedule":{"kind":"resident"}
        }])).unwrap();
        let child = &children.0[0];
        assert!(valid_deferral(child, "full-disk-access", "compiled probe observed permission denial"));
        assert!(!valid_deferral(child, "notifications", "observed"));
        assert!(!valid_deferral(child, "unknown", "observed"));
        assert!(!valid_deferral(child, "full-disk-access", "  "));
        assert!(!valid_deferral(child, "full-disk-access", &"x".repeat(4097)));
        assert!(valid_deferral(child, "full-disk-access", &"é".repeat(4096)));
        let mut config: Config = serde_json::from_value(json!({
            "uid":0,"socket":"/example/socket","audit":"/example/audit","staging":"/example/staging",
            "policyRevision":"policy","releaseRevision":"release","enabledGrants":[],"automationTargets":[],
            "products":{},"auditMaxBytes":65536,"documents":{"sources":{},"maxItems":1,"maxBytes":1,"timeoutMs":1}
        })).unwrap();
        config.supervised_children=children;
        assert_eq!(Registry::default().validate(&config).unwrap_err().code,"child-grant-disabled");
        config.enabled_grants.push("full-disk-access".into());
        assert_eq!(Registry::default().validate(&config).unwrap_err().code,"child-process-type-mismatch");
    }
    #[test] fn provisioning_creates_owned_nested_directories() {
        let root = root();
        let uid = unsafe { libc::geteuid() };
        let path = root.join("new/nested");
        let directory = provision(&path, uid, 0o700).unwrap();
        let metadata = directory.metadata().unwrap();
        assert_eq!(metadata.uid(), uid);
        assert_eq!(metadata.mode() & 0o777, 0o700);
        assert!(path.is_dir());
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn retry_timestamp_is_absolute_utc() {
        let value = retry_timestamp(1500);
        assert_eq!(value.len(), 24);
        assert!(value.ends_with('Z'));
        assert_eq!(&value[10..11], "T");
        assert!(!value.contains('+'));
    }
    #[test] fn supervision_requires_activation_and_shutdown_is_idempotent() {
        let root = root();
        let config: Config = serde_json::from_value(json!({
            "uid":unsafe { libc::geteuid() },"socket":root.join("socket"),
            "audit":root.join("audit"),"staging":root,"policyRevision":"policy","releaseRevision":"release",
            "enabledGrants":[],"automationTargets":[],"products":{},"auditMaxBytes":65536,
            "documents":{"sources":{},"maxItems":1,"maxBytes":1,"timeoutMs":1}
        })).unwrap();
        let audit = Arc::new(Mutex::new(Audit::open(&config).unwrap()));
        let supervisor = Supervisor::new(Arc::new(config), audit, Role::Supervisor, false, Arc::new(Registry::default())).unwrap();
        assert!(!supervisor.inner.activated.load(Ordering::Acquire));
        assert_eq!(supervisor.run_scheduled("worker.run", &|| false).unwrap_err().code, "child-supervisor-unavailable");
        supervisor.activate();
        assert!(supervisor.inner.activated.load(Ordering::Acquire));
        thread::scope(|scope| {
            scope.spawn(|| supervisor.shutdown());
            scope.spawn(|| supervisor.shutdown());
        });
        assert!(supervisor.worker.lock().is_none());
        assert!(supervisor.inner.stop.load(Ordering::Acquire));
        supervisor.activate();
        assert_eq!(supervisor.run_scheduled("worker.run", &|| false).unwrap_err().code, "child-supervisor-unavailable");
        drop(supervisor);
        fs::remove_dir_all(root).unwrap();
    }
}
