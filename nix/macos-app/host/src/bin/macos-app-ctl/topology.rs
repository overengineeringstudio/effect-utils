//! One release, two direct-entrypoint jobs. The durable journal restores both
//! configurations after failure or interruption; a missing GUI domain is not a
//! supervisor failure and never causes a root or substitute-session fallback.
use super::*;

struct Job { ctl: Ctl, desired: launchd::Validated, path: PathBuf }

struct RestoreJob { ctl: Ctl, path: PathBuf, bytes: Option<Vec<u8>>, was_loaded: bool }
pub(super) struct RestoreTopology<'a> { jobs: Vec<RestoreJob>, receipt: &'a Value }

impl Ctl {
    pub(super) fn paired(&self) -> bool { self.config.get("guiLaunchd").is_some_and(Value::is_object) }

    fn topology_controls(&self) -> Result<Vec<Ctl>> {
        let target: u32 = self.arg("target-uid")?.parse().map_err(|_| fail(64, "invalid-input", "Invalid target UID"))?;
        if target == 0 || self.arg("domain")? != "system" || self.field("session")? != "system-daemon" {
            return Err(fail(64, "invalid-input", "Paired topology requires a system supervisor with an explicit non-root target UID"));
        }
        let mut controls = Vec::with_capacity(2);
        for gui in [false, true] {
            let mut config = self.config.clone();
            let mut args = self.args.clone();
            args.entry("evidence".into()).or_insert_with(|| "resident".into());
            if gui {
                config["session"] = json!("gui-agent");
                config["launchd"] = config["guiLaunchd"].clone();
                args.insert("domain".into(), format!("gui/{target}"));
                if let Some(path) = self.args.get("gui-plist") { args.insert("plist".into(), path.clone()); }
                else { args.remove("plist"); }
                args.insert("plist-dir".into(), self.arg("gui-plist-dir")?.to_owned());
            }
            controls.push(Ctl { config, args });
        }
        if controls[0].label()? == controls[1].label()? { return Err(fail(64, "invalid-input", "Paired jobs require distinct labels")); }
        Ok(controls)
    }

    fn topology_jobs(&self) -> Result<Vec<Job>> {
        let target = self.arg("target-uid")?.parse().map_err(|_| fail(64, "invalid-input", "Invalid target UID"))?;
        self.topology_controls()?.into_iter().enumerate().map(|(index, ctl)| {
            let desired = if ctl.args.contains_key("plist") { launchd::validate(&ctl)? }
                else { launchd::validate_bytes(&ctl, ctl.render_topology_plist(index == 1, target)?)? };
            if desired.disabled || ctl.config["launchd"]["held"] == true || desired.evidence != "resident" {
                return Err(fail(64, "invalid-input", "Paired jobs require resident evidence and cannot be disabled or held independently"));
            }
            let path = Path::new(ctl.arg("plist-dir")?).join(format!("{}.plist", desired.label));
            Ok(Job { ctl, desired, path })
        }).collect()
    }

    fn render_topology_plist(&self, gui: bool, target: u32) -> Result<Vec<u8>> {
        let program = self.app()?.join("Contents/MacOS").join(self.field("hostExecutable")?);
        let mut data = self.config["launchd"].clone();
        let object = data.as_object_mut().ok_or_else(|| fail(64, "invalid-input", "launchd must be an object"))?;
        for key in ["label", "keepAlive", "runAtLoad", "held"] { object.remove(key); }
        object.insert("Label".into(), json!(self.label()?));
        object.insert("Program".into(), json!(program));
        let mut arguments = vec![json!(program), json!("serve"), json!("--role"), json!(if gui { "gui-agent" } else { "supervisor" }), json!("--gui-socket"), json!(self.arg("gui-socket")?)];
        if gui { object.insert("LimitLoadToSessionType".into(), json!("Aqua")); }
        else {
            let (user, group) = launchd::account_names(target)?;
            object.insert("UserName".into(), json!(user));
            object.insert("GroupName".into(), json!(group));
            arguments.extend([json!("--socket"), json!(self.arg("socket")?), json!("--generation-pointer"), json!(self.state()?.join("current"))]);
        }
        object.insert("ProgramArguments".into(), json!(arguments));
        object.insert("KeepAlive".into(), self.config["launchd"]["keepAlive"].clone());
        object.insert("RunAtLoad".into(), self.config["launchd"]["runAtLoad"].clone());
        Ok(format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\">{}</plist>\n", plist(&data)?).into_bytes())
    }

    pub(super) fn converge_topology(&self) -> Result<Value> {
        if self.args.contains_key("validate-only") { return self.apply_topology(); }
        self.recover_paired()?;
        let topology = self.capture_topology()?;
        let old_config = topology["receipt"]["config"].as_object().map(|config| Value::Object(config.clone())).unwrap_or_else(|| self.config.clone());
        let record = json!({"direction": "paired-config", "oldConfig": old_config, "topology": topology});
        let journal = rollback_record(&self.app()?);
        atomic_write(&journal, &serde_json::to_vec(&record)?)?;
        match self.apply_topology() {
            Ok(result) => { remove_if_present(&journal)?; Ok(result) }
            Err(error) => {
                self.recover_paired().map_err(|recovery| fail(23, "release-unresolved",
                    format!("{}; recovery failed: {}; journal retained", error.reason, recovery.reason)))?;
                Err(error)
            }
        }
    }

    pub(super) fn apply_topology(&self) -> Result<Value> {
        let jobs = self.topology_jobs()?;
        if self.args.contains_key("validate-only") {
            return Ok(json!({"validated": true, "jobs": jobs.iter().map(|job| json!({"domain": job.desired.domain, "label": job.desired.label})).collect::<Vec<_>>() }));
        }
        self.verify_bundle(&self.app()?)?;
        releases::destination(&self.state()?, true)?;
        for job in &jobs { releases::destination(job.path.parent().ok_or_else(|| mismatch("Plist requires parent"))?, true)?; }
        let receipt = self.state()?.join("launchd-pair-current.json");
        let mut gui_present = command(LAUNCHCTL, &["print", &jobs[1].desired.domain])?.status.success();
        let revision = json!({"config": self.config, "publicSocket": self.arg("socket")?, "guiSocket": self.arg("gui-socket")?, "appInode": inode(&self.app()?), "generation": pointer(&self.state()?.join("current")), "socketMode": self.desired_socket_mode()?, "jobs": jobs.iter().map(|job| json!({"domain": job.desired.domain, "label": job.desired.label, "bytes": job.desired.bytes})).collect::<Vec<_>>()});
        let observations = jobs.iter().map(|job| job.ctl.job(&job.desired.domain)).collect::<Result<Vec<_>>>()?;
        let unchanged = read_json(&receipt)?.as_ref() == Some(&revision)
            && jobs.iter().all(|job| fs::read(&job.path).is_ok_and(|bytes| bytes == job.desired.bytes))
            && observations[0].0 && (!gui_present || observations[1].0);
        if unchanged { return Ok(json!({"changed": false, "guiSession": gui_present})); }
        for job in &jobs {
            if job.desired.domain.starts_with("gui/") && !gui_present { continue; }
            let disabled = checked(LAUNCHCTL, &["print-disabled", &job.desired.domain]);
            let disabled = disabled?;
            if String::from_utf8_lossy(&disabled.stdout).lines().any(|line| line.trim() == format!("\"{}\" => true", job.desired.label)) {
                return Err(mismatch("A paired job is disabled in launchd"));
            }
        }
            // Stop GUI first, supervisor last; neither executes against a half-published pair.
            for job in jobs.iter().rev() { stop(job)?; }
            for job in &jobs { atomic_write(&job.path, &job.desired.bytes)?; }
            if failpoint("pair-after-write") { std::process::exit(137); }
            for (index, job) in jobs.iter().enumerate() {
                if index == 1 {
                    gui_present = command(LAUNCHCTL, &["print", &job.desired.domain])?.status.success();
                    if !gui_present { continue; }
                }
                if failpoint("paired-release-before-system") && index == 0 { return Err(fail(23, "operation-failed", "Injected failure before supervisor bootstrap")); }
                if failpoint("paired-release-before-gui") && index == 1 { return Err(fail(23, "operation-failed", "Injected failure before GUI bootstrap")); }
                if let Err(error) = checked(LAUNCHCTL, &["bootstrap", &job.desired.domain, text(&job.path)?]) {
                    if index != 1 || command(LAUNCHCTL, &["print", &job.desired.domain])?.status.success() { return Err(error); }
                    gui_present = false;
                }
                if failpoint("pair-after-supervisor-bootstrap") && index == 0 { return Err(fail(23, "operation-failed", "Injected paired bootstrap failure")); }
                if failpoint("paired-release-after-system") && index == 0 { return Err(fail(23, "operation-failed", "Injected failure after supervisor bootstrap")); }
                if failpoint("paired-release-after-gui") && index == 1 { return Err(fail(23, "operation-failed", "Injected failure after GUI bootstrap")); }
            }
            // Check the processes and code identity, not permission readiness:
            // pending consent must not roll back an otherwise valid release.
            running_pid(&jobs[0])?;
            let status = self.ipc()?;
            if status["ok"] != true || status["status"]["hostSourceHash"].as_str() != hash(&self.app()?).as_deref() {
                return Err(mismatch("Started supervisor does not report the installed release"));
            }
            verify_process_policy(&self.config, &jobs[0].desired.process_policy, &status["status"]["processPolicy"], false)?;
            if gui_present {
                if let Err(error) = authenticate_job(&jobs[1], self.arg("gui-socket")?) {
                    if command(LAUNCHCTL, &["print", &jobs[1].desired.domain])?.status.success() { return Err(error); }
                    gui_present = false;
                }
            }
        if gui_present {
            let observed = self.ipc()?;
            if observed["status"]["guiProcessPolicy"].is_null() {
                if command(LAUNCHCTL, &["print", &jobs[1].desired.domain])?.status.success() {
                    return Err(mismatch("GUI job lacks authenticated process policy evidence"));
                }
                gui_present = false;
            } else {
                verify_process_policy(&self.config, &jobs[1].desired.process_policy, &observed["status"]["guiProcessPolicy"], true)?;
            }
        }
        atomic_write(&receipt, &serde_json::to_vec(&revision)?)?;
        Ok(json!({"changed": true, "guiSession": gui_present}))
    }

    pub(super) fn topology_evidence(&self) -> Result<Value> {
        self.topology_evidence_with(&self.ipc()?)
    }

    pub(super) fn topology_evidence_with(&self, status: &Value) -> Result<Value> {
        let jobs = self.topology_jobs()?;
        let receipt = read_json(&self.state()?.join("launchd-pair-current.json"))?.ok_or_else(|| mismatch("No committed paired launchd release"))?;
        if receipt["appInode"].as_u64() != inode(&self.app()?) { return Err(mismatch("Paired jobs belong to another installed release")); }
        if rollback_record(&self.app()?).exists() { return Err(mismatch("Paired release transaction is incomplete")); }
        for (index, job) in jobs.iter().enumerate() {
            if fs::read(&job.path)? != job.desired.bytes || receipt["jobs"][index]["bytes"] != json!(job.desired.bytes) { return Err(mismatch("Paired launchd configurations differ from the selected release")); }
        }
        let (loaded, pid) = jobs[0].ctl.job("system")?;
        if !loaded || pid.is_none() { return Err(mismatch("System supervisor is not running")); }
        if status["ok"] != true || status["status"]["pid"].as_u64() != pid.map(u64::from) { return Err(mismatch("Supervisor status does not match launchd")); }
        let generation = pointer(&self.state()?.join("current")).ok_or_else(|| mismatch("Missing generation"))?;
        let manifest: Value = serde_json::from_slice(&fs::read(generation.join("manifest.json"))?)?;
        if status["status"]["hostSourceHash"].as_str() != hash(&self.app()?).as_deref() || status["status"]["generation"] != manifest["generation"] { return Err(mismatch("Supervisor release or policy is stale")); }
        verify_process_policy(&self.config, &jobs[0].desired.process_policy, &status["status"]["processPolicy"], false)?;
        if !status["status"]["guiProcessPolicy"].is_null() {
            verify_process_policy(&self.config, &jobs[1].desired.process_policy, &status["status"]["guiProcessPolicy"], true)?;
        }
        let children = verify_children(&self.config, &status["status"]["children"])?;
        Ok(json!({"verified": true, "children": children, "supervisor": {"domain": "system", "pid": pid}}))
    }
}

fn stop(job: &Job) -> Result<()> { stop_control(&job.ctl) }

fn authenticate_job(job: &Job, socket: &str) -> Result<()> {
    authenticate_control(&job.ctl, socket)
}

fn authenticate_control(control: &Ctl, socket: &str) -> Result<()> {
    let mut args = control.args.clone();
    args.insert("socket".into(), socket.to_owned());
    let ctl = Ctl { config: control.config.clone(), args };
    let pid = running_control_pid(&ctl)?;
    let stream = ctl.connect_endpoint(ctl.arg("domain")?, pid)?;
    let requirement = macos_app_host::CompiledRequirement::compile(ctl.field("requirement")?)
        .map_err(|error| fail(64, "invalid-input", error.to_string()))?;
    let peer = macos_app_host::authenticate_peer(&stream, macos_app_host::PeerPolicy {
        allowed_uids: &[ctl.arg("target-uid")?.parse().map_err(|_| fail(64, "invalid-input", "Invalid target UID"))?], requirement: &requirement,
    }).map_err(|error| mismatch(error.to_string()))?;
    if peer.token().pid() != pid { return Err(mismatch("Paired private endpoint differs from launchd PID")); }
    peer.recheck_freshness().map_err(|error| mismatch(error.to_string()))
}

fn running_pid(job: &Job) -> Result<u32> {
    running_control_pid(&job.ctl)
}

fn running_control_pid(ctl: &Ctl) -> Result<u32> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let (loaded, pid) = ctl.job(ctl.arg("domain")?)?;
        if !loaded { return Err(mismatch("Paired job exited before endpoint authentication")); }
        if let Some(pid) = pid { return Ok(pid); }
        if Instant::now() >= deadline { return Err(mismatch("Paired job did not start")); }
        std::thread::sleep(Duration::from_millis(50));
    }
}

impl Ctl {
    pub(super) fn capture_topology(&self) -> Result<Value> {
        let exists = self.app()?.exists();
        let receipt = read_json(&self.state()?.join("launchd-pair-current.json"))?;
        if let Some(receipt) = &receipt {
            if receipt["publicSocket"] != self.arg("socket")? || receipt["guiSocket"] != self.arg("gui-socket")? {
                return Err(fail(64, "endpoint-migration-required", "Pinned public/private host endpoints cannot change during release installation"));
            }
        }
        let jobs = self.topology_controls()?.iter().map(|ctl| -> Result<Value> {
            let domain = ctl.arg("domain")?;
            let path = Path::new(ctl.arg("plist-dir")?).join(format!("{}.plist", ctl.label()?));
            releases::destination(path.parent().ok_or_else(|| mismatch("Plist requires parent"))?, true)?;
            let (loaded, _) = ctl.job(domain)?;
            let bytes = match fs::read(&path) { Ok(bytes) => Some(bytes), Err(error) if error.kind() == io::ErrorKind::NotFound => None, Err(error) => return Err(error.into()) };
            if let Some(bytes) = &bytes {
                if !exists { return Err(mismatch("A configuration exists without its installed bundle")); }
                launchd::validate_previous_bytes(ctl, bytes.clone())?;
            }
            if loaded && bytes.is_none() { return Err(mismatch("Loaded paired job has no restorable installed configuration")); }
            Ok(json!({"domain": domain, "label": ctl.label()?, "path": path, "bytes": bytes, "loaded": loaded}))
        }).collect::<Result<Vec<_>>>()?;
        Ok(json!({"jobs": jobs, "receipt": receipt}))
    }

    pub(super) fn stop_topology(&self) -> Result<()> {
        for ctl in self.topology_controls()?.iter().rev() { stop_control(ctl)?; }
        Ok(())
    }

    /// Resolve every path, closed plist, executable and receipt before the caller
    /// stops either live job. The prepared plan owns the exact validated bytes.
    pub(super) fn prepare_topology_restore<'a>(&self, record: &'a Value, incumbent: Option<&Path>) -> Result<RestoreTopology<'a>> {
        let controls = self.topology_controls()?;
        let previous = record["jobs"].as_array().filter(|jobs| jobs.len() == controls.len()).ok_or_else(|| mismatch("Corrupt paired transaction"))?;
        let mut jobs = Vec::with_capacity(controls.len());
        for (ctl, old) in controls.into_iter().zip(previous) {
            let path = Path::new(ctl.arg("plist-dir")?).join(format!("{}.plist", ctl.label()?));
            if old["domain"] != ctl.arg("domain")? || old["label"] != ctl.label()? || old["path"].as_str() != Some(text(&path)?) { return Err(mismatch("Paired transaction identity differs")); }
            releases::destination(path.parent().ok_or_else(|| mismatch("Recovery plist has no parent"))?, false)?;
            let was_loaded = old["loaded"].as_bool().ok_or_else(|| mismatch("Corrupt paired loaded evidence"))?;
            let bytes = if old["bytes"].is_null() {
                if was_loaded { return Err(mismatch("Paired transaction lacks a loaded job's configuration")); }
                None
            } else {
                let incumbent = incumbent.ok_or_else(|| mismatch("Recovery configurations have no incumbent bundle"))?;
                let bytes: Vec<u8> = serde_json::from_value(old["bytes"].clone())?;
                Some(launchd::validate_recovery_bytes(&ctl, bytes, incumbent)?.bytes)
            };
            jobs.push(RestoreJob { ctl, path, bytes, was_loaded });
        }
        let receipt = &record["receipt"];
        if !receipt.is_null() && (!receipt.is_object()
            || receipt["appInode"].as_u64() != incumbent.and_then(inode)
            || receipt["publicSocket"] != self.arg("socket")? || receipt["guiSocket"] != self.arg("gui-socket")?) {
            return Err(mismatch("Restored topology receipt differs from the incumbent principal"));
        }
        Ok(RestoreTopology { jobs, receipt })
    }
}

impl RestoreTopology<'_> {
    pub(super) fn apply(&self, owner: &Ctl) -> Result<()> {
        for job in &self.jobs {
            if let Some(bytes) = &job.bytes { atomic_write(&job.path, bytes)?; }
            else { remove_if_present(&job.path)?; }
        }
        let mut gui_started = false;
        for (index, job) in self.jobs.iter().enumerate() {
            let domain = job.ctl.arg("domain")?;
            let gui_present = index == 1 && command(LAUNCHCTL, &["print", domain])?.status.success();
            if !restore_job_required(index == 1, job.was_loaded, job.bytes.is_some(), gui_present) { continue; }
            if let Err(error) = checked(LAUNCHCTL, &["bootstrap", domain, text(&job.path)?]) {
                if index != 1 || command(LAUNCHCTL, &["print", domain])?.status.success() { return Err(error); }
                continue;
            }
            gui_started = index == 1;
        }
        if self.jobs[0].was_loaded {
            running_control_pid(&self.jobs[0].ctl)?;
            let status = owner.ipc()?;
            if status["ok"] != true || status["status"]["hostSourceHash"].as_str() != hash(&owner.app()?).as_deref() {
                return Err(mismatch("Restored supervisor release differs"));
            }
            let generation = pointer(&owner.state()?.join("current")).ok_or_else(|| mismatch("Restored supervisor has no generation"))?;
            let manifest: Value = serde_json::from_slice(&fs::read(generation.join("manifest.json"))?)?;
            if status["status"]["generation"] != manifest["generation"] { return Err(mismatch("Restored supervisor generation differs")); }
        }
        if gui_started {
            if let Err(error) = authenticate_control(&self.jobs[1].ctl, owner.arg("gui-socket")?) {
                if command(LAUNCHCTL, &["print", self.jobs[1].ctl.arg("domain")?])?.status.success() { return Err(error); }
            }
        }
        let receipt = owner.state()?.join("launchd-pair-current.json");
        if self.receipt.is_null() { remove_if_present(&receipt)?; }
        else { atomic_write(&receipt, &serde_json::to_vec(self.receipt)?)?; }
        Ok(())
    }
}

fn restore_job_required(gui: bool, was_loaded: bool, has_configuration: bool, gui_present: bool) -> bool {
    if gui { has_configuration && gui_present } else { was_loaded }
}

fn stop_control(ctl: &Ctl) -> Result<()> {
    let domain = ctl.arg("domain")?;
    if !ctl.job(domain)?.0 { return Ok(()); }
    if let Err(error) = checked(LAUNCHCTL, &["bootout", &format!("{domain}/{}", ctl.label()?)]) {
        if ctl.job(domain)?.0 { return Err(error); }
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while ctl.job(domain)?.0 {
        if Instant::now() >= deadline { return Err(fail(23, "operation-failed", "Paired job remained loaded after bootout")); }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

/// The generic single-job host has no child runtime. Preserve its declaration-only
/// inactive report without claiming readiness or requiring a runtime inventory.
pub(super) fn inactive_single_job_children(config: &Value) -> Result<Value> {
    config["supervisedChildren"].as_array().into_iter().flatten().map(|child| {
        if child["activation"].as_str().unwrap_or("inactive") != "inactive" {
            return Err(fail(64, "invalid-input", "Single-job hosts support only inactive supervised child declarations"));
        }
        Ok(json!({"id": child["id"], "activation": "inactive", "state": "inactive", "probe": "not-run"}))
    }).collect::<Result<Vec<_>>>().map(Value::Array)
}

pub(super) fn verify_children(config: &Value, observed: &Value) -> Result<Value> {
    let desired = config.get("supervisedChildren").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    // Hosts with no declared children have no child-evidence obligation.
    if desired.is_empty() && observed.is_null() { return Ok(json!([])); }
    let actual = observed.as_array().ok_or_else(|| mismatch("Authenticated status lacks child inventory"))?;
    if actual.len() != desired.len() { return Err(mismatch("Child inventory differs from desired release")); }
    let mut failed = Vec::new();
    let mut deferred = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for child in desired {
        let id = child["id"].as_str().ok_or_else(|| mismatch("Desired child lacks ID"))?;
        let Some(live) = actual.iter().find(|live| live["id"] == id) else { return Err(mismatch(format!("Missing child {id}"))); };
        if !seen.insert(id) || actual.iter().filter(|live| live["id"] == id).count() != 1 { return Err(mismatch("Duplicate child evidence")); }
        let activation = child["activation"].as_str().unwrap_or("inactive");
        if live["activation"] != activation || live["schedule"] != child["schedule"]["kind"] || live["requiresSession"] != child["requiresSession"] { return Err(mismatch(format!("Child {id} policy differs"))); }
        if config["policyRevision"].as_str().is_none_or(str::is_empty)
            || config["releaseRevision"].as_str().is_none_or(str::is_empty)
            || live["policyRevision"] != config["policyRevision"] || live["releaseRevision"] != config["releaseRevision"] {
            return Err(mismatch(format!("Child {id} release/policy evidence is stale")));
        }
        if activation == "inactive" {
            if live["state"] != "inactive" || !live["readiness"].is_null() { failed.push(id); }
            continue;
        }
        match live["readiness"]["outcome"].as_str() {
            Some("ready") => {
                if !matches!(live["state"].as_str(), Some("running" | "stopped")) { failed.push(id); }
                if child["schedule"]["kind"] == "resident" && (live["state"] != "running" || live["instanceId"].as_str().is_none_or(str::is_empty)) { failed.push(id); }
                let probe = child["readiness"]["kind"].as_str().unwrap_or_default();
                let expected_evidence = if live["readiness"]["evidence"] == "scheduled-idle" && child["schedule"]["kind"] == "launchd-scheduled" {
                    "scheduled-idle"
                } else if probe == "none" { "spawn-only" } else { "probe-passed" };
                if live["readiness"]["probe"] != probe || live["readiness"]["evidence"] != expected_evidence { failed.push(id); }
                if expected_evidence == "scheduled-idle"
                    && (!live["pid"].is_null() || live["running"] == true) {
                    failed.push(id);
                }
            }
            Some("deferred") => {
                let service = live["readiness"]["service"].as_str().unwrap_or_default();
                let reason = live["readiness"]["reason"].as_str().unwrap_or_default();
                if service.is_empty() || reason.is_empty() || !child["requiredTccServices"].as_array().is_some_and(|services| services.iter().any(|item| item == service)) { failed.push(id); }
                else { deferred.push(json!({"id": id, "service": service, "reason": reason})); }
            }
            _ => failed.push(id),
        }
    }
    if !failed.is_empty() { return Err(mismatch(format!("Failed or stale child evidence: {}", failed.join(", ")))); }
    if !deferred.is_empty() {
        let services = deferred.iter().filter_map(|child| child["service"].as_str()).collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>().join(", ");
        let mut error = fail(75, "deferred-admission", format!("deferred-admission: pending-grant: {services}"));
        error.details = Some(json!({"children": deferred}));
        return Err(error);
    }
    Ok(observed.clone())
}

fn verify_process_policy(config: &Value, desired: &Value, actual: &Value, gui: bool) -> Result<()> {
    let role = if gui { "gui-agent" } else { "supervisor" };
    let session = if gui { "gui" } else { "none" };
    let process_type = desired["processType"].as_str().filter(|kind| matches!(*kind, "Background" | "Standard" | "Interactive" | "Adaptive"))
        .ok_or_else(|| mismatch("Paired owning launchd job requires an explicit valid ProcessType"))?;
    if actual["role"] != role || actual["processType"] != process_type || actual["processTypeEvidence"] != "launchd-inherited" {
        return Err(mismatch(format!("{role} owning-job process policy differs")));
    }
    let nice = actual["nice"].as_i64().filter(|nice| (-20..=20).contains(nice)).ok_or_else(|| mismatch("Host lacks effective nice evidence"))?;
    let soft = actual["rlimitNofile"]["soft"].as_u64().ok_or_else(|| mismatch("Host lacks effective nofile soft limit"))?;
    let hard = actual["rlimitNofile"]["hard"].as_u64().ok_or_else(|| mismatch("Host lacks effective nofile hard limit"))?;
    if soft > hard { return Err(mismatch("Host effective nofile limits are inconsistent")); }
    if (!desired["nice"].is_null() && desired["nice"].as_i64() != Some(nice))
        || (!desired["softNofile"].is_null() && desired["softNofile"].as_u64() != Some(soft))
        || (!desired["hardNofile"].is_null() && desired["hardNofile"].as_u64() != Some(hard)) {
        return Err(mismatch(format!("{role} effective process policy differs from its launchd configuration")));
    }
    for child in config["supervisedChildren"].as_array().into_iter().flatten() {
        if child["activation"] != "active" || child["requiresSession"] != session { continue; }
        if child["processType"] != process_type
            || child["nice"].as_i64().is_none_or(|requested| requested < nice)
            || child["rlimitNofile"]["hard"].as_u64().is_none_or(|requested| requested > hard) {
            return Err(mismatch(format!("Child {} resource policy is incompatible with {role}'s effective limits", child["id"].as_str().unwrap_or("unknown"))));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy() -> Value { json!({"policyRevision": "policy", "releaseRevision": "release", "supervisedChildren": [{"id": "worker", "activation": "active", "schedule": {"kind": "resident"}, "requiresSession": "none", "readiness": {"kind": "none"}, "requiredTccServices": ["full-disk-access"]}]}) }
    fn live(readiness: Value) -> Value { json!([{"id": "worker", "policyRevision": "policy", "releaseRevision": "release", "activation": "active", "schedule": "resident", "requiresSession": "none", "state": "running", "instanceId": "release-instance", "readiness": readiness}]) }
    #[test]
    fn restored_gui_configuration_follows_current_session_availability() {
        assert!(restore_job_required(true, false, true, true));
        assert!(!restore_job_required(true, true, true, false));
        assert!(!restore_job_required(true, false, false, true));
        assert!(restore_job_required(false, true, true, false));
        assert!(!restore_job_required(false, false, true, true));
    }
    #[test]
    fn inactive_single_job_declarations_need_no_runtime_inventory() {
        let config = json!({"supervisedChildren": [{"id": "disabled", "activation": "inactive"}, {"id": "default"}]});
        assert_eq!(inactive_single_job_children(&config).unwrap(), json!([
            {"id": "disabled", "activation": "inactive", "state": "inactive", "probe": "not-run"},
            {"id": "default", "activation": "inactive", "state": "inactive", "probe": "not-run"}
        ]));
        assert_eq!(inactive_single_job_children(&json!({"supervisedChildren": [{"id": "active", "activation": "active"}]})).unwrap_err().code, 64);
    }
    #[test]
    fn fresh_scheduled_idle_receipt_is_ready_without_a_first_run() {
        let mut config = policy();
        config["supervisedChildren"][0]["schedule"] = json!({"kind": "launchd-scheduled", "op": "example.run"});
        config["supervisedChildren"][0]["readiness"] = json!({"kind": "probe-op", "op": "example.ready"});
        let mut actual = live(json!({"outcome": "ready", "probe": "probe-op", "evidence": "scheduled-idle"}));
        actual[0]["schedule"] = json!("launchd-scheduled");
        actual[0]["state"] = json!("running");
        actual[0]["pid"] = Value::Null;
        actual[0]["instanceId"] = Value::Null;
        actual[0]["running"] = json!(false);
        assert!(verify_children(&config, &actual).is_ok());
        actual[0]["readiness"]["probe"] = json!("none");
        assert_eq!(verify_children(&config, &actual).unwrap_err().code, 22);
        actual[0]["readiness"]["probe"] = json!("probe-op");
        actual[0]["running"] = json!(true);
        assert_eq!(verify_children(&config, &actual).unwrap_err().code, 22);
    }
    #[test]
    fn typed_ready_is_required() {
        assert!(verify_children(&policy(), &live(json!({"outcome": "ready", "probe": "none", "evidence": "spawn-only"}))).is_ok());
        assert_eq!(verify_children(&policy(), &live(Value::Null)).unwrap_err().code, 22);
        assert_eq!(verify_children(&policy(), &json!([])).unwrap_err().code, 22);
    }
    #[test]
    fn only_declared_explicit_deferral_returns_75() {
        let deferred = live(json!({"outcome": "deferred", "service": "full-disk-access", "reason": "pending-grant"}));
        assert_eq!(verify_children(&policy(), &deferred).unwrap_err().code, 75);
        assert_eq!(verify_children(&policy(), &live(json!({"outcome": "deferred", "service": "unknown", "reason": "pending-grant"}))).unwrap_err().code, 22);
        assert_eq!(verify_children(&policy(), &live(json!({"outcome": "failed", "code": "exit-75"}))).unwrap_err().code, 22);
    }
    #[test]
    fn hard_failure_takes_precedence_over_deferral() {
        let mut config = policy();
        let mut second = config["supervisedChildren"][0].clone(); second["id"] = json!("second");
        config["supervisedChildren"].as_array_mut().unwrap().push(second);
        let mut actual = live(json!({"outcome": "deferred", "service": "full-disk-access", "reason": "pending-grant"}));
        let mut second = actual[0].clone(); second["id"] = json!("second"); second["readiness"] = json!({"outcome": "failed", "code": "probe-failed"});
        actual.as_array_mut().unwrap().push(second);
        assert_eq!(verify_children(&config, &actual).unwrap_err().code, 22);
    }
    #[test]
    fn stale_release_is_never_ready_or_deferred() {
        let mut actual = live(json!({"outcome": "deferred", "service": "full-disk-access", "reason": "pending-grant"}));
        actual[0]["releaseRevision"] = json!("old-release");
        assert_eq!(verify_children(&policy(), &actual).unwrap_err().code, 22);
    }
    #[test]
    fn effective_job_limits_must_permit_child_policy() {
        let mut config = policy();
        config["supervisedChildren"][0]["processType"] = json!("Background");
        config["supervisedChildren"][0]["nice"] = json!(5);
        config["supervisedChildren"][0]["rlimitNofile"] = json!({"soft": 256, "hard": 256});
        let desired = json!({"processType": "Background", "nice": null, "softNofile": null, "hardNofile": null});
        let mut actual = json!({"role": "supervisor", "processType": "Background", "processTypeEvidence": "launchd-inherited", "nice": 0, "rlimitNofile": {"soft": 256, "hard": 1024}});
        assert!(verify_process_policy(&config, &desired, &actual, false).is_ok());
        actual["nice"] = json!(10);
        assert_eq!(verify_process_policy(&config, &desired, &actual, false).unwrap_err().code, 22);
        actual["nice"] = json!(0);
        actual["rlimitNofile"] = json!({"soft": 128, "hard": 128});
        assert_eq!(verify_process_policy(&config, &desired, &actual, false).unwrap_err().code, 22);
        actual["rlimitNofile"] = json!({"soft": 256, "hard": 1024});
        actual["processType"] = json!("Interactive");
        assert_eq!(verify_process_policy(&config, &desired, &actual, false).unwrap_err().code, 22);
    }
}
