//! Consumer-rendered launchd configuration; this is not a launchd declaration DSL.
use super::*;
use sha2::Digest;

impl Ctl {
    fn supplied_summary(&self, desired: &launchd::Validated, changed: bool, loaded: bool, pid: Option<u32>) -> Result<Value> {
        let running = match pid {
            Some(pid) if self.args.contains_key("socket") => {
                let connection = self.connect_endpoint(&desired.domain, pid)?;
                let requirement = macos_app_host::CompiledRequirement::compile(self.field("requirement")?)
                    .map_err(|e| fail(64, "invalid-input", e.to_string()))?;
                let peer = macos_app_host::authenticate_peer(&connection, macos_app_host::PeerPolicy {
                    allowed_uids: &[desired.target_uid], requirement: &requirement,
                }).map_err(|e| mismatch(e.to_string()))?;
                let token = peer.token();
                if token.pid() != pid { return Err(mismatch("Authenticated endpoint peer does not match launchd PID")); }
                peer.recheck_freshness().map_err(|e| mismatch(e.to_string()))?;
                Some(json!({"pid": pid, "uid": token.effective_uid(), "pidVersion": token.pid_version(), "authenticated": true}))
            }
            Some(pid) if desired.evidence == "scheduled" => Some(json!({"pid": pid, "authenticated": false})),
            Some(_) => return Err(mismatch("Resident evidence requires an authenticated --socket peer")),
            None => None,
        };
        Ok(json!({"changed": changed, "validated": true, "domain": desired.domain,
            "targetUid": desired.target_uid, "label": desired.label, "program": desired.program,
            "evidence": desired.evidence, "plistDigest": format!("{:x}", sha2::Sha256::digest(&desired.bytes)),
            "loaded": loaded, "running": running}))
    }

    pub(super) fn supplied_evidence(&self) -> Result<Value> {
        let desired = launchd::validate(self)?;
        let (loaded, pid) = self.job(&desired.domain)?;
        if !loaded { return Err(mismatch("Supplied job is not loaded")); }
        if desired.evidence == "resident" && pid.is_none() { return Err(mismatch("Resident job is not running")); }
        self.supplied_summary(&desired, false, loaded, pid)
    }

    pub(super) fn converge_supplied(&self) -> Result<Value> {
        let validated = launchd::validate(self)?;
        let digest = format!("{:x}", sha2::Sha256::digest(&validated.bytes));
        if self.args.contains_key("validate-only") { return self.supplied_summary(&validated, false, false, None); }
        let directory = PathBuf::from(self.arg("plist-dir")?);
        let state = self.state()?;
        if validated.evidence == "resident" { self.arg("socket")?; }
        self.signature(&self.app()?)?;
        // A missing explicit GUI domain is a structured non-mutation outcome.
        if validated.domain.starts_with("gui/") && !command(LAUNCHCTL, &["print", &validated.domain])?.status.success() {
            return Err(fail(21, "gui-absent", "Explicit GUI domain is absent; no job operation attempted"));
        }
        let disabled = checked(LAUNCHCTL, &["print-disabled", &validated.domain])?;
        let disabled_text = String::from_utf8_lossy(&disabled.stdout);
        if validated.disabled || disabled_text.lines().any(|line| line.trim() == format!("\"{}\" => true", validated.label)) || self.config["launchd"]["held"] == true {
            let (loaded, pid) = self.job(&validated.domain)?;
            let mut evidence = self.supplied_summary(&validated, false, loaded, pid)?;
            evidence["held"] = json!(true);
            return Ok(evidence);
        }
        releases::destination(&directory, true)?;
        releases::destination(&state, true)?;
        let path = directory.join(format!("{}.plist", validated.label));
        let record = state.join(format!("launched-{}-{}-{}.json", validated.domain.replace('/', "-"), validated.target_uid, validated.label));
        let app_inode = inode(&self.app()?);
        let previous = read_json(&record)?;
        let (loaded, pid) = self.job(&validated.domain)?;
        if loaded && previous.as_ref().is_some_and(|old| old["domain"] == validated.domain &&
            old["targetUid"] == validated.target_uid && old["plistDigest"] == digest && old["appInode"].as_u64() == app_inode) {
            if validated.evidence == "resident" && pid.is_none() { return Err(fail(75, "restart-deferred", "Resident is configured but not running")); }
            return self.supplied_summary(&validated, false, true, pid);
        }
        let target = format!("{}/{}", validated.domain, validated.label);
        if loaded {
            checked(LAUNCHCTL, &["bootout", &target])?;
            let deadline = Instant::now() + Duration::from_secs(10);
            while self.job(&validated.domain)?.0 {
                if Instant::now() >= deadline { return Err(fail(23, "operation-failed", "Job remained loaded after bootout")); }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        atomic_write(&path, &validated.bytes)?;
        checked(LAUNCHCTL, &["bootstrap", &validated.domain, text(&path)?])?;
        atomic_write(&record, &serde_json::to_vec(&json!({"domain": validated.domain, "targetUid": validated.target_uid, "plistDigest": digest, "appInode": app_inode}))?)?;
        let (loaded, pid) = self.job(&validated.domain)?;
        if !loaded { return Err(mismatch("Configured job is not loaded")); }
        if validated.evidence == "resident" && pid.is_none() { return Err(fail(75, "restart-deferred", "Resident is configured but not running")); }
        self.supplied_summary(&validated, true, loaded, pid)
    }
}
