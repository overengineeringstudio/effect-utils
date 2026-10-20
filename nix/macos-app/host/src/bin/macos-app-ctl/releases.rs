//! Signing and verify-only release import. Legacy local-sign installation remains separate.
use super::*;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Incumbent {
    Contract,
    Legacy,
}

impl Incumbent {
    pub(super) fn parse(value: Option<&str>) -> Result<Self> {
        match value {
            None => Ok(Self::Contract),
            Some("legacy") => Ok(Self::Legacy),
            Some(_) => Err(fail(64, "invalid-input", "--incumbent accepts only legacy")),
        }
    }
}

fn desired(ctl: &Ctl) -> Result<Value> {
    let path = fs::canonicalize(ctl.arg("desired")?)?;
    if path.is_dir() { artifact::describe(&path, &ctl.config) }
    else {
        let value: Value = serde_json::from_slice(&fs::read(&path)?)?;
        // describe-host's JSON CLI envelope is also the Nix descriptor output.
        Ok(if value["ok"] == true { value["result"].clone() } else { value })
    }
}

fn restore_pointer(path: &Path, value: &Value) -> Result<()> {
    if value.is_null() { return remove_if_present(path); }
    let target = Path::new(value.as_str().ok_or_else(|| mismatch("Corrupt rollback pointer"))?);
    if !target.is_absolute() { return Err(mismatch("Rollback pointer must be absolute")); }
    select(path, target)
}

fn check_child_endpoints(old: &Value, desired: &Value) -> Result<()> {
    for previous in old["supervisedChildren"].as_array().into_iter().flatten() {
        if let Some(current) = desired["supervisedChildren"].as_array().into_iter().flatten().find(|child| child["id"] == previous["id"]) {
            if previous["clientSocket"] != current["clientSocket"] {
                return Err(fail(64, "endpoint-migration-required", format!(
                    "Child {} changes its fixed clientSocket; explicit endpoint migration is required",
                    previous["id"].as_str().unwrap_or("unknown"))));
            }
        }
    }
    Ok(())
}

/// Mutable destination directories never traverse a symlink or another user's
/// writable directory. Root-owned read-only ancestors are acceptable for users.
pub(super) fn destination(path: &Path, create: bool) -> Result<()> {
    if !path.is_absolute() || path.components().any(|p| matches!(p, std::path::Component::ParentDir | std::path::Component::CurDir)) {
        return Err(fail(64, "invalid-input", "Destination must be an absolute normalized path"));
    }
    let owner = unsafe { libc::geteuid() };
    use std::os::unix::fs::OpenOptionsExt;
    let mut current = PathBuf::from("/");
    for part in path.components().skip(1) {
        current.push(part.as_os_str());
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(e) if create && e.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current)?;
                fs::set_permissions(&current, fs::Permissions::from_mode(0o700))?;
                fs::symlink_metadata(&current)?
            }
            Err(e) => return Err(e.into()),
        };
        if !metadata.is_dir() || metadata.uid() != 0 && metadata.uid() != owner || metadata.mode() & 0o022 != 0 {
            return Err(fail(64, "invalid-input", "Unsafe destination ancestor ownership, mode or symlink"));
        }
        let directory = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY).open(&current)?;
        macos_app_host::endpoint::verify_acl_no_grants(&directory).map_err(|e| fail(64, "invalid-input", e.to_string()))?;
    }
    let metadata = fs::metadata(path)?;
    if metadata.uid() != owner { return Err(fail(64, "invalid-input", "Destination directory must belong to the installing UID")); }
    macos_app_host::endpoint::validate_directory(path, owner).map_err(|e| fail(64, "invalid-input", e.to_string()))
}

pub(super) fn private_stage(parent: &Path) -> Result<PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    let mut template = CString::new(text(&parent.join(format!("{STAGE_DIRECTORY_PREFIX}XXXXXX")))?)
        .map_err(|error| fail(64, "invalid-input", error.to_string()))?.into_bytes_with_nul();
    // SAFETY: mkdtemp receives a writable NUL-terminated template. It atomically
    // creates a unique directory with mode 0700, independent of ambient umask.
    if unsafe { libc::mkdtemp(template.as_mut_ptr().cast()) }.is_null() {
        return Err(io::Error::last_os_error().into());
    }
    template.pop();
    let path = PathBuf::from(std::ffi::OsString::from_vec(template));
    let metadata = fs::symlink_metadata(&path)?;
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o777 != 0o700 {
        return Err(mismatch("Bundle stage parent must be private and owned by the installing UID"));
    }
    Ok(path)
}

fn copy_pinned_source(source: &Path, app: &Path, descriptor: &Value, config: &Value) -> Result<()> {
    #[cfg(feature = "test-signing-cert")]
    if failpoint("seal-source-after-describe") {
        fs::create_dir_all(source.join("Contents/Resources"))?;
        fs::write(source.join("Contents/Resources/seal-race.txt"), b"changed after describing\n")?;
    }
    copy_app(source, app)?;
    if artifact::describe(app, config)? != *descriptor {
        return Err(mismatch("Staged source changed after its unsigned descriptor was pinned"));
    }
    Ok(())
}

fn publish_exclusive(stage: &Path, output: &Path) -> Result<()> {
    let stage = CString::new(text(stage)?).map_err(|e| fail(64, "invalid-input", e.to_string()))?;
    let output = CString::new(text(output)?).map_err(|e| fail(64, "invalid-input", e.to_string()))?;
    // SAFETY: strings live through renamex_np. Exclusive publication never replaces
    // a release another consumer has already published.
    if unsafe { libc::renamex_np(stage.as_ptr(), output.as_ptr(), libc::RENAME_EXCL) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(())
}

fn verify_options(diagnostic: &str, options: &[String]) -> Result<()> {
    // Embedded CodeDirectory option bits, defined by Apple's CSCommon.h.
    let expected = options.iter().try_fold(0u32, |flags, option| {
        Ok(flags | match option.as_str() {
            "host" => 0x0001, "hard" => 0x0100, "kill" => 0x0200,
            "expires" => 0x0400, "restrict" => 0x0800, "library" => 0x2000,
            "runtime" => 0x10000,
            _ => return Err(fail(64, "invalid-input", "Unsupported signing option")),
        })
    })?;
    let actual = diagnostic.split_whitespace().find_map(|word| word.strip_prefix("flags="))
        .and_then(|word| word.split('(').next()).and_then(|word| word.strip_prefix("0x"))
        .and_then(|word| u32::from_str_radix(word, 16).ok())
        .ok_or_else(|| mismatch("Cannot read candidate CodeDirectory signing flags"))?;
    // Ad-hoc/linker seal flags describe the signing mechanism, not declared options.
    if actual & !(0x0002 | 0x20000) != expected { return Err(mismatch("Candidate signing options differ from pinned policy")); }
    Ok(())
}

impl Ctl {
    pub(super) fn describe_host(&self) -> Result<Value> { artifact::describe(&fs::canonicalize(self.arg("desired")?)?, &self.config) }

    pub(super) fn verify_bundle(&self, app: &Path) -> Result<()> {
        self.verify_bundle_with(app, &self.config)
    }

    fn verify_bundle_with(&self, app: &Path, config: &Value) -> Result<()> {
        for entry in artifact::signing_entries(config)? {
            let path = if entry.path.is_empty() {
                app.to_owned()
            } else {
                app.join(&entry.path)
            };
            self.signature_with(&path, &entry.requirement)?;
            for architecture in artifact::code_architectures(app, &entry, config)? {
                artifact::verify_entitlements(app, &entry, &architecture)?;
                let details = keys::bounded_codesign(&[
                    "-d",
                    "--verbose=4",
                    "--architecture",
                    &architecture,
                    text(&path)?,
                ])?;
                let diagnostic = String::from_utf8_lossy(&details.stderr);
                if !details.status.success()
                    || !diagnostic
                        .lines()
                        .any(|line| line == format!("Identifier={}", entry.identifier))
                {
                    return Err(mismatch(
                        "Code identifier differs from the independently pinned inventory",
                    ));
                }
                verify_options(&diagnostic, &entry.options)?;
            }
        }
        Ok(())
    }

    pub(super) fn seal_host(&self) -> Result<Value> {
        let unsigned = fs::canonicalize(self.arg("desired")?)?;
        if !unsigned.is_dir() { return Err(fail(64, "invalid-input", "seal-host requires the unsigned complete .app")); }
        let descriptor = artifact::describe(&unsigned, &self.config)?;
        let output = PathBuf::from(self.arg("output")?);
        if output.exists() {
            let release = artifact::verify_release(&output, &descriptor, &self.config)?;
            self.verify_bundle(&release.app)?;
            return Ok(json!({"changed": false, "release": output, "descriptor": descriptor, "sealedRevision": release.sealed_revision}));
        }
        let keychain_arg = PathBuf::from(self.arg("keychain")?);
        if is_login_keychain(&fs::canonicalize(&keychain_arg).unwrap_or_else(|_| keychain_arg.clone())) {
            return Err(fail(64, "invalid-input", "The login keychain is never used for signing"));
        }
        let keychain_path = fs::canonicalize(&keychain_arg).map_err(|e| signing("keychain-missing", e.to_string()))?;
        if !keychain_path.is_file() || !keychain_path.parent().is_some_and(keys::partition_capable) {
            return Err(fail(64, "invalid-input", "A dedicated per-user Library/Keychains signing keychain is required"));
        }
        let keychain = Keychain::open_locked(&keychain_path)?;
        let parent = output.parent().ok_or_else(|| fail(64, "invalid-input", "Release requires a parent"))?;
        destination(parent, true)?;
        let stage = private_stage(parent)?;
        let result = (|| {
            let app = stage.join(artifact::app_bundle_name(&self.config)?);
            copy_pinned_source(&unsigned, &app, &descriptor, &self.config)?;
            checked("/bin/chmod", &["-R", "u+w", text(&app)?])?;
            self.sign(&keychain_path, &keychain, &app)?;
            checked("/bin/chmod", &["-R", "a-w", text(&app)?])?;
            let receipt = artifact::create_receipt(&app, &descriptor, &self.config)?;
            atomic_write(&stage.join("descriptor.json"), &serde_json::to_vec(&descriptor)?)?;
            atomic_write(&stage.join("receipt.json"), &serde_json::to_vec(&receipt)?)?;
            checked("/bin/chmod", &["-R", "a-w", text(&stage)?])?;
            publish_exclusive(&stage, &output)?;
            Ok(json!({"changed": true, "release": output, "descriptor": descriptor, "receipt": receipt}))
        })();
        let result = keychain.finish(result);
        if result.is_err() && stage.exists() {
            checked("/bin/chmod", &["-R", "u+w", text(&stage)?])?;
            fs::remove_dir_all(stage)?;
        }
        result
    }

    // Configs are retained by bundle inode alongside retained immutable hosts.
    // Writing before publication makes interrupted exchanges recoverable without
    // ever interpreting the incumbent through the candidate's code inventory.
    fn host_config_path(&self, app: &Path) -> Result<PathBuf> {
        let metadata = fs::metadata(app)?;
        Ok(self.state()?.join("host-configs").join(format!(
            "{}-{}.json",
            metadata.dev(),
            metadata.ino()
        )))
    }

    fn record_host_config(&self, app: &Path) -> Result<()> {
        destination(&self.state()?.join("host-configs"), true)?;
        atomic_write(
            &self.host_config_path(app)?,
            &serde_json::to_vec(&self.config)?,
        )
    }

    fn describe_incumbent(&self, app: &Path, mode: Incumbent) -> Result<Option<Value>> {
        artifact::verify_bundle_identifier(app, &self.config)?;
        self.signature(app)?;
        let record = self.host_config_path(app)?;
        let config: Option<Value> = match fs::symlink_metadata(&record) {
            Ok(metadata) => {
                if !metadata.is_file() {
                    return Err(mismatch("Recorded host config is not a regular file"));
                }
                Some(serde_json::from_slice(&fs::read(&record)?)?)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if let Some(config) = config {
            let descriptor = artifact::describe(app, &config)?;
            self.verify_bundle_with(app, &config)?;
            Ok(Some(descriptor))
        } else if mode == Incumbent::Legacy {
            Ok(None)
        } else {
            artifact::describe(app, &self.config).map(Some)
        }
    }

    pub(super) fn install_artifact(&self) -> Result<Value> {
        if self.paired() { return self.install_paired_artifact(); }
        if ["keychain", "keychain-password-fd", "signing-auth-pending"]
            .iter()
            .any(|key| self.args.contains_key(*key))
        {
            return Err(fail(
                64,
                "invalid-input",
                "Artifact import accepts no signing credentials and has no signing fallback",
            ));
        }
        let incumbent = Incumbent::parse(self.args.get("incumbent").map(String::as_str))?;
        let descriptor = desired(self)?;
        let release = Path::new(self.arg("artifact")?);
        let candidate = artifact::verify_release(release, &descriptor, &self.config)?;
        self.verify_bundle(&candidate.app)?;
        let app = self.app()?;
        let parent = app
            .parent()
            .ok_or_else(|| fail(64, "invalid-input", "App requires parent"))?;
        let archive = PathBuf::from(self.arg("archive-dir")?);
        // Verification above completes before any destination mutation.
        destination(parent, true).map_err(|mut error| {
            error.reason = format!("Preparing app destination: {}", error.reason);
            error
        })?;
        destination(&archive, true).map_err(|mut error| {
            error.reason = format!("Preparing archive destination: {}", error.reason);
            error
        })?;
        destination(&self.state()?, true).map_err(|mut error| {
            error.reason = format!("Preparing state destination: {}", error.reason);
            error
        })?;
        if fs::metadata(parent)?.dev() != fs::metadata(&archive)?.dev() {
            return Err(fail(
                64,
                "invalid-input",
                "App and immutable archive must share a filesystem for atomic exchange",
            ));
        }
        let (reconciled, _) = self.reconcile(&app)?;
        if app.exists() {
            if !fs::symlink_metadata(&app)?.is_dir()
                || fs::symlink_metadata(&app)?.uid() != unsafe { libc::geteuid() }
            {
                return Err(fail(
                    64,
                    "invalid-input",
                    "Installed app is not an owned directory",
                ));
            }
            if self.describe_incumbent(&app, incumbent)?.as_ref() == Some(&descriptor)
                && self.verify_bundle(&app).is_ok()
                && artifact::artifact_revision(&app)? == candidate.sealed_revision
            {
                if !self.host_config_path(&app)?.exists() {
                    self.record_host_config(&app)?;
                }
                return Ok(
                    json!({"changed": false, "descriptor": descriptor, "sealedRevision": candidate.sealed_revision, "reconciled": reconciled}),
                );
            }
        }
        let stage_parent = private_stage(&archive)?;
        let stage = stage_parent.join(artifact::app_bundle_name(&self.config)?);
        let result = (|| {
            copy_app(&candidate.app, &stage)?;
            self.verify_bundle(&stage)?;
            if artifact::describe(&stage, &self.config)? != descriptor
                || artifact::artifact_revision(&stage)? != candidate.sealed_revision
            {
                return Err(mismatch(
                    "Staged artifact content or sealed revision differs",
                ));
            }
            // Darwin requires write access to a directory moved between parents.
            // Installed owner-write bits are excluded from the artifact revision;
            // retained incumbents are frozen again by publish_archive.
            checked("/bin/chmod", &["-R", "u+w", text(&stage)?])?;
            self.record_host_config(&stage)?;
            if app.exists() {
                let txn = json!({"stage": stage, "stageInode": inode(&stage), "generation": pointer(&self.state()?.join("current")), "immutable": true});
                atomic_write(&transaction_record(&app), &serde_json::to_vec(&txn)?)?;
                exchange(&stage, &app)?;
                self.publish_archive(&app, &txn)?;
            } else {
                publish_exclusive(&stage, &app).map_err(|mut error| {
                    error.reason = format!("Publishing verified artifact: {}", error.reason);
                    error
                })?;
                fs::remove_dir(&stage_parent)?;
            }
            Ok(
                json!({"changed": true, "descriptor": descriptor, "sealedRevision": candidate.sealed_revision, "archive": pointer(&archive_pointer(&app)), "reconciled": reconciled}),
            )
        })();
        if result.is_err() && stage_parent.exists() && !transaction_record(&app).exists() {
            checked("/bin/chmod", &["-R", "u+w", text(&stage_parent)?])?;
            fs::remove_dir_all(&stage_parent)?;
        }
        result
    }

    /// A paired release has one rollback authority: the existing D.rollback.json.
    /// It is durable before the bundle exchange and removed only after both job
    /// configurations and authenticated process identities are committed.
    fn install_paired_artifact(&self) -> Result<Value> {
        self.arg("generation")?;
        if ["keychain", "keychain-password-fd", "signing-auth-pending"].iter().any(|key| self.args.contains_key(*key)) {
            return Err(fail(64, "invalid-input", "Paired artifact import accepts no signing credentials"));
        }
        self.recover_paired()?;
        let descriptor = desired(self)?;
        let candidate = artifact::verify_release(Path::new(self.arg("artifact")?), &descriptor, &self.config)?;
        self.verify_bundle(&candidate.app)?;
        let app = self.app()?;
        let state = self.state()?;
        let parent = app.parent().ok_or_else(|| fail(64, "invalid-input", "App requires parent"))?;
        let archive = PathBuf::from(self.arg("archive-dir")?);
        let generation = Path::new(self.arg("generation")?);
        if !generation.is_absolute() || !generation.join("manifest.json").is_file() {
            return Err(fail(64, "invalid-input", "Generation must be absolute and contain manifest.json"));
        }
        // This validates target identity and both restorable configurations
        // before the exchange. A first install cannot adopt unrelated jobs.
        let topology = self.capture_topology()?;
        destination(parent, true)?;
        destination(&archive, true)?;
        destination(&state, true)?;
        if fs::metadata(parent)?.dev() != fs::metadata(&archive)?.dev() {
            return Err(fail(64, "invalid-input", "App and archive must share a filesystem for atomic exchange"));
        }
        self.reconcile(&app)?;
        let incumbent = Incumbent::parse(self.args.get("incumbent").map(String::as_str))?;
        let mut old_config = self.config.clone();
        let unchanged = if app.exists() {
            let metadata = fs::symlink_metadata(&app)?;
            if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
                return Err(fail(64, "invalid-input", "Installed app is not an owned directory"));
            }
            let actual = self.describe_incumbent(&app, incumbent)?;
            old_config = read_json(&self.host_config_path(&app)?)?.ok_or_else(|| fail(64, "migration-required", "Paired installation requires a recorded paired incumbent; migrate the old job topology explicitly"))?;
            if !old_config["guiLaunchd"].is_object() || old_config["session"] != self.config["session"]
                || old_config["targetUid"] != self.config["targetUid"]
                || old_config["bundleId"] != self.config["bundleId"]
                || old_config["appBundleName"] != self.config["appBundleName"]
                || old_config["launchd"]["label"] != self.config["launchd"]["label"]
                || old_config["guiLaunchd"]["label"] != self.config["guiLaunchd"]["label"] {
                return Err(fail(64, "migration-required", "Release installation cannot change the pinned paired job principal or adopt a single-job incumbent"));
            }
            check_child_endpoints(&old_config, &self.config)?;
            actual.as_ref() == Some(&descriptor) && self.verify_bundle(&app).is_ok()
                && artifact::artifact_revision(&app)? == candidate.sealed_revision
        } else { false };
        let stage = if unchanged { None } else {
            let stage_parent = private_stage(&archive)?;
            let stage = stage_parent.join(artifact::app_bundle_name(&self.config)?);
            let staged = (|| {
                copy_app(&candidate.app, &stage)?;
                self.verify_bundle(&stage)?;
                if artifact::describe(&stage, &self.config)? != descriptor || artifact::artifact_revision(&stage)? != candidate.sealed_revision {
                    return Err(mismatch("Staged artifact differs from the independently pinned release"));
                }
                checked("/bin/chmod", &["-R", "u+w", text(&stage)?])?;
                self.record_host_config(&stage)
            })();
            if let Err(error) = staged {
                checked("/bin/chmod", &["-R", "u+w", text(&stage_parent)?])?;
                fs::remove_dir_all(&stage_parent)?;
                return Err(error);
            }
            Some(stage)
        };
        let record = json!({"direction": "paired-release", "stage": stage,
            "oldInode": inode(&app), "candidateInode": stage.as_deref().and_then(inode).or_else(|| inode(&app)),
            "oldConfig": old_config, "topology": topology,
            "generation": pointer(&state.join("current")), "previousGeneration": pointer(&state.join("previous")),
            "archive": pointer(&archive_pointer(&app)), "archiveGeneration": pointer(&state.join("host-previous-generation"))});
        let journal = rollback_record(&app);
        atomic_write(&journal, &serde_json::to_vec(&record)?)?;
        let applied = (|| {
            if let Some(stage) = &stage {
                // Stop the incumbent before moving its bytes. A crash before or
                // after exchange is distinguished by the recorded bundle inode.
                self.stop_topology()?;
                if app.exists() { exchange(stage, &app)?; } else { fs::rename(stage, &app)?; }
                if failpoint("paired-release-after-exchange") { std::process::exit(137); }
                if failpoint("paired-release-fail-after-exchange") { return Err(fail(23, "operation-failed", "Injected release failure after exchange")); }
            }
            let selected = self.generation()?;
            let launchd = self.apply_topology()?;
            // Admission is separate: GUI absence or pending consent does not
            // discard a correctly installed and authenticated system release.
            if let Some(stage) = &stage {
                if record["oldInode"].is_number() {
                    checked("/bin/chmod", &["-R", "a-w", text(stage)?])?;
                    select(&archive_pointer(&app), stage)?;
                    restore_pointer(&state.join("host-previous-generation"), &record["generation"])?;
                }
            }
            remove_if_present(&signing_failure_marker(&app))?;
            remove_if_present(&journal)?;
            let leftover = if record["oldInode"].is_null() {
                stage.as_ref().and_then(|stage| stage.parent()).and_then(remove_leftover)
            } else { None };
            Ok(json!({"changed": !unchanged || selected["changed"] == true || launchd["changed"] == true,
                "descriptor": descriptor, "sealedRevision": candidate.sealed_revision,
                "generation": generation, "launchd": launchd, "admissionRequired": true,
                "archive": pointer(&archive_pointer(&app)), "leftovers": leftover.into_iter().collect::<Vec<_>>()}))
        })();
        if let Err(error) = applied {
            self.recover_paired().map_err(|recovery| fail(23, "release-unresolved",
                format!("{}; recovery failed: {}; D.rollback.json retained", error.reason, recovery.reason)))?;
            return Err(error);
        }
        applied
    }

    /// Roll back an interrupted paired release/configuration transaction. Every
    /// step is restartable; the journal is the last recovery state removed.
    pub(super) fn recover_paired(&self) -> Result<()> {
        let app = self.app()?;
        let journal = rollback_record(&app);
        let Some(record) = read_json(&journal)? else { return Ok(()); };
        let direction = record["direction"].as_str().ok_or_else(|| mismatch("Corrupt rollback journal"))?;
        if !matches!(direction, "paired-release" | "paired-config") {
            return Err(mismatch("A non-paired host rollback must be resumed before paired installation"));
        }
        let config = record["oldConfig"].as_object().ok_or_else(|| mismatch("Paired rollback lacks incumbent configuration"))?;
        let old = Ctl { config: Value::Object(config.clone()), args: self.args.clone() };
        // Validate the journal's snapshot identity before touching the live jobs.
        // Both controls must retain the same public principal and explicit UID.
        if old.config["bundleId"] != self.config["bundleId"] || old.config["targetUid"] != self.config["targetUid"] {
            return Err(mismatch("Paired rollback principal differs from the requested release"));
        }
        let state = self.state()?;
        let mut stage = None;
        let mut exchange_required = false;
        let mut initial_removal = false;
        let mut incumbent = app.exists().then(|| app.clone());
        if direction == "paired-release" {
            let old_inode = if record["oldInode"].is_null() { None } else {
                Some(record["oldInode"].as_u64().ok_or_else(|| mismatch("Corrupt incumbent inode"))?)
            };
            let candidate_inode = record["candidateInode"].as_u64().ok_or_else(|| mismatch("Corrupt candidate inode"))?;
            stage = if record["stage"].is_null() { None } else {
                Some(PathBuf::from(record["stage"].as_str().ok_or_else(|| mismatch("Corrupt rollback stage"))?))
            };
            if let Some(path) = &stage {
                let archive = PathBuf::from(self.arg("archive-dir")?);
                destination(&archive, false)?;
                let parent = path.parent().ok_or_else(|| mismatch("Paired rollback stage has no parent"))?;
                if parent.parent() != Some(archive.as_path())
                    || !parent.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(STAGE_DIRECTORY_PREFIX))
                    || path.file_name().and_then(|name| name.to_str()) != Some(artifact::app_bundle_name(&old.config)?) {
                    return Err(mismatch("Paired rollback stage is not a canonical bundle in the explicit private archive"));
                }
                if inode(&app) == Some(candidate_inode) {
                    if let Some(expected) = old_inode {
                        if inode(path) != Some(expected) { return Err(mismatch("Paired rollback incumbent stage differs")); }
                        incumbent = Some(path.clone());
                        exchange_required = true;
                    } else {
                        if path.exists() { return Err(mismatch("Unexpected initial-install rollback stage")); }
                        incumbent = None;
                        initial_removal = true;
                    }
                } else {
                    if inode(&app) != old_inode { return Err(mismatch("Installed bundle holds neither recorded release")); }
                    if path.exists() && inode(path) != Some(candidate_inode) { return Err(mismatch("Rejected release stage inode differs")); }
                }
            } else if inode(&app) != old_inode { return Err(mismatch("Unchanged release inode differs")); }
            // Reject malformed pointers and unavailable incumbent generations
            // while both currently running jobs are still untouched.
            for key in ["generation", "previousGeneration", "archive", "archiveGeneration"] {
                if !record[key].is_null() && !record[key].as_str().is_some_and(|value| Path::new(value).is_absolute()) {
                    return Err(mismatch(format!("Corrupt recovery pointer {key}")));
                }
            }
            if record["topology"]["jobs"][0]["loaded"] == true {
                let generation = record["generation"].as_str().ok_or_else(|| mismatch("Recovery supervisor lacks a generation"))?;
                let manifest: Value = serde_json::from_slice(&fs::read(Path::new(generation).join("manifest.json"))?)?;
                if manifest["generation"].as_str().is_none_or(str::is_empty) { return Err(mismatch("Invalid recovery generation")); }
            }
        }
        if let Some(incumbent) = &incumbent { old.verify_bundle(incumbent)?; }
        let restoration = old.prepare_topology_restore(&record["topology"], incumbent.as_deref())?;
        // No fallible recovery prerequisite may be resolved after this point.
        self.stop_topology()?;
        if let Some(stage) = &stage {
            if exchange_required {
                checked("/bin/chmod", &["-R", "u+w", text(stage)?])?;
                exchange(stage, &app)?;
            } else if initial_removal { fs::rename(&app, stage)?; }
        }
        if direction == "paired-release" {
            restore_pointer(&state.join("current"), &record["generation"])?;
            restore_pointer(&state.join("previous"), &record["previousGeneration"])?;
            restore_pointer(&archive_pointer(&app), &record["archive"])?;
            restore_pointer(&state.join("host-previous-generation"), &record["archiveGeneration"])?;
        }
        restoration.apply(&old)?;
        if direction == "paired-release" {
            if let Some(stage) = record["stage"].as_str().map(PathBuf::from) {
                if stage.exists() {
                    if inode(&stage) != record["candidateInode"].as_u64() { return Err(mismatch("Rejected release stage inode differs")); }
                    checked("/bin/chmod", &["-R", "u+w", text(&stage)?])?;
                    remove_staged_bundle(&stage)?;
                }
                if let Some(parent) = stage.parent().filter(|parent| parent.exists()) {
                    fs::remove_dir(parent)?;
                }
            }
        }
        remove_if_present(&journal)
    }

    pub(super) fn verify_artifact(&self) -> Result<Value> {
        let descriptor = desired(self)?;
        let candidate = artifact::verify_release(Path::new(self.arg("artifact")?), &descriptor, &self.config)?;
        let app = self.app()?;
        self.verify_bundle(&app)?;
        let sealed_revision = artifact::artifact_revision(&app)?;
        if artifact::describe(&app, &self.config)? != descriptor ||
            sealed_revision != candidate.sealed_revision {
            return Err(mismatch("Installed signed artifact differs from the independently pinned release"));
        }
        let state = self.state()?;
        let generation = Path::new(self.arg("generation")?);
        if pointer(&state.join("current")).as_deref() != Some(generation) { return Err(mismatch("Generation pointer differs")); }
        let manifest: Value = serde_json::from_slice(&fs::read(generation.join("manifest.json"))?)?;
        let live = if self.paired() { Some(self.topology_evidence()?) }
            else if self.args.contains_key("plist") { Some(self.supplied_evidence()?) } else { None };
        Ok(json!({"verified": true, "descriptor": descriptor, "sealedRevision": sealed_revision,
            "generation": generation, "generationDigest": manifest["generation"], "launchd": live}))
    }

    pub(super) fn rollback_artifact(&self) -> Result<Value> {
        if self.paired() {
            let installed = self.install_paired_artifact().map_err(|mut error| {
                if error.kind == "reseal-required" { error.kind = "rollback-unavailable"; }
                error
            })?;
            return Ok(json!({"installed": installed, "restartRequired": false, "admissionRequired": true}));
        }
        // The caller selects the exact release/generation pair; no latest-success policy.
        let installed = self.install_artifact().map_err(|mut error| {
            if error.kind == "reseal-required" { error.kind = "rollback-unavailable"; }
            error
        })?;
        let selected = self.generation()?;
        let launchd = if self.paired() { Some(self.converge_topology()?) }
            else if self.args.contains_key("plist") { Some(self.converge_supplied()?) } else { None };
        let verified = self.verify_artifact()?;
        Ok(json!({"installed": installed, "selected": selected, "launchd": launchd, "verification": verified,
            "restartRequired": !self.paired() && !self.args.contains_key("plist")}))
    }

    pub(super) fn status_artifact(&self) -> Result<Value> {
        let descriptor = desired(self)?;
        let candidate = artifact::verify_release(Path::new(self.arg("artifact")?), &descriptor, &self.config)?;
        let app = self.app()?;
        let actual = artifact::describe(&app, &self.config)?;
        let sealed_revision = artifact::artifact_revision(&app)?;
        let valid = self.verify_bundle(&app).is_ok() && actual == descriptor &&
            sealed_revision == candidate.sealed_revision;
        let generation = pointer(&self.state()?.join("current"));
        let manifest = generation.as_ref().map(|path| read_json(&path.join("manifest.json"))).transpose()?.flatten();
        let live = if self.paired() { Some(self.topology_evidence()?) }
            else if self.args.contains_key("plist") { Some(self.supplied_evidence()?) } else { None };
        Ok(json!({"descriptor": actual, "sealedRevision": sealed_revision, "artifactValid": valid,
            "activeGeneration": generation, "generationDigest": manifest.as_ref().map(|value| &value["generation"]),
            "launchd": live, "hostArchive": pointer(&archive_pointer(&app))}))
    }

    #[cfg(feature = "test-signing-cert")]
    pub(super) fn seal_fixture_artifact(&self) -> Result<Value> {
        if ["keychain", "keychain-password-fd"].iter().any(|key| self.args.contains_key(*key)) { return Err(fail(64, "invalid-input", "Ad-hoc test release accepts no keychain")); }
        let source = fs::canonicalize(self.arg("desired")?)?;
        let descriptor = artifact::describe(&source, &self.config)?;
        self.verify_bundle(&source)?;
        let output = PathBuf::from(self.arg("output")?);
        let parent = output.parent().ok_or_else(|| fail(64, "invalid-input", "Release requires a parent"))?;
        destination(parent, false)?;
        let stage = private_stage(parent)?;
        let result = (|| {
            let app = stage.join(artifact::app_bundle_name(&self.config)?);
            copy_pinned_source(&source, &app, &descriptor, &self.config)?;
            self.verify_bundle(&app)?;
            checked("/bin/chmod", &["-R", "a-w", text(&app)?])?;
            let receipt = artifact::create_receipt(&app, &descriptor, &self.config)?;
            atomic_write(&stage.join("descriptor.json"), &serde_json::to_vec(&descriptor)?)?;
            atomic_write(&stage.join("receipt.json"), &serde_json::to_vec(&receipt)?)?;
            checked("/bin/chmod", &["-R", "a-w", text(&stage)?])?;
            publish_exclusive(&stage, &output)?;
            Ok(json!({"descriptor": descriptor, "receipt": receipt}))
        })();
        if result.is_err() && stage.exists() {
            checked("/bin/chmod", &["-R", "u+w", text(&stage)?])?;
            fs::remove_dir_all(stage)?;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paired_recovery_rejects_unavailable_prerequisites_before_job_control() {
        let root = private_stage(&fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let app = root.join("Host.app");
        let archive = root.join("archive");
        fs::create_dir(&app).unwrap();
        fs::create_dir(&archive).unwrap();
        let stage_parent = private_stage(&archive).unwrap();
        let stage = stage_parent.join("Host.app");
        fs::create_dir(&stage).unwrap();
        let config = json!({"bundleId": "dev.example.recovery", "appBundleName": "Host.app",
            "hostExecutable": "host", "requirement": "identifier \"dev.example.recovery\"", "targetUid": 501});
        let record = json!({"direction": "paired-release", "oldConfig": config,
            "oldInode": inode(&stage), "candidateInode": inode(&app), "stage": stage,
            "generation": null, "previousGeneration": null, "archive": null, "archiveGeneration": null});
        let journal = rollback_record(&app);
        atomic_write(&journal, &serde_json::to_vec(&record).unwrap()).unwrap();
        // No launchd/domain/plist arguments exist: reaching job control would
        // return their missing-argument error instead of these prerequisites.
        let mut ctl = Ctl { config, args: BTreeMap::from([
            ("app-dir".into(), text(&app).unwrap().into()),
            ("state".into(), text(&root.join("state")).unwrap().into()),
        ]) };
        let before = inode(&app);
        assert!(ctl.recover_paired().unwrap_err().reason.contains("archive-dir"));
        ctl.args.insert("archive-dir".into(), text(&root).unwrap().into());
        assert!(ctl.recover_paired().unwrap_err().reason.contains("canonical bundle"));
        ctl.args.insert("archive-dir".into(), text(&archive).unwrap().into());
        assert!(ctl.recover_paired().is_err()); // unsigned incumbent cannot be restored
        assert_eq!(inode(&app), before);
        assert_eq!(read_json(&journal).unwrap().unwrap(), record);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn fixed_child_endpoints_require_explicit_migration() {
        let old = json!({"supervisedChildren": [{"id": "worker", "clientSocket": "/run/fixed.sock"}]});
        assert!(check_child_endpoints(&old, &old).is_ok());
        for socket in [json!("/run/changed.sock"), Value::Null] {
            let candidate = json!({"supervisedChildren": [{"id": "worker", "clientSocket": socket}]});
            let error = check_child_endpoints(&old, &candidate).unwrap_err();
            assert_eq!(error.code, 64);
            assert_eq!(error.kind, "endpoint-migration-required");
        }
        assert!(check_child_endpoints(&old, &json!({"supervisedChildren": []})).is_ok());
        assert!(check_child_endpoints(&old, &json!({"supervisedChildren": [
            {"id": "worker", "clientSocket": "/run/fixed.sock"}, {"id": "new", "clientSocket": "/run/new.sock"}
        ]})).is_ok());
    }
    #[test]
    fn desired_symlink_is_copied_as_a_real_directory() {
        let scratch = std::env::current_dir().unwrap().join("tmp");
        fs::create_dir_all(&scratch).unwrap();
        let root = private_stage(&scratch).unwrap();
        let source = root.join("source.app");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("content"), b"desired app").unwrap();
        symlink("content", source.join("internal-link")).unwrap();
        let desired = root.join("desired.app");
        symlink(&source, &desired).unwrap();
        let stage = root.join("stage.app");
        copy_app(&desired, &stage).unwrap();
        assert!(fs::symlink_metadata(&stage).unwrap().is_dir());
        assert_eq!(fs::read(stage.join("content")).unwrap(), b"desired app");
        assert!(fs::symlink_metadata(stage.join("internal-link")).unwrap().file_type().is_symlink());
        fs::write(stage.join("content"), b"mutable stage").unwrap();
        assert_eq!(fs::read(source.join("content")).unwrap(), b"desired app");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn staged_symlinks_and_files_are_refused() {
        let scratch = std::env::current_dir().unwrap().join("tmp");
        fs::create_dir_all(&scratch).unwrap();
        let root = private_stage(&scratch).unwrap();
        let source = root.join("source.app");
        fs::create_dir(&source).unwrap();
        let stage = root.join("stage.app");
        symlink(&source, &stage).unwrap();
        let error = require_stage_directory(&stage).unwrap_err();
        assert_eq!((error.code, error.kind), (22, "verification-failed"));
        fs::remove_file(&stage).unwrap();
        fs::write(&stage, b"not a directory").unwrap();
        let error = require_stage_directory(&stage).unwrap_err();
        assert_eq!((error.code, error.kind), (22, "verification-failed"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn incumbent_opt_in_is_explicit_and_typed() {
        assert_eq!(Incumbent::parse(None).unwrap(), Incumbent::Contract);
        assert_eq!(Incumbent::parse(Some("legacy")).unwrap(), Incumbent::Legacy);
        for value in ["", "contract", "true", "LEGACY"] {
            assert!(Incumbent::parse(Some(value)).is_err());
        }
    }
    #[test]
    fn legacy_cutover_preserves_identity_and_recorded_inventory() {
        let root = private_stage(&fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let identifier = "dev.example.legacy-cutover";
        let app = root.join("apps/Host.app");
        fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        let source = root.join("host.c");
        fs::write(&source, b"int main(void) { return 0; }\n").unwrap();
        let architecture = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x86_64"
        };
        checked(
            "/usr/bin/clang",
            &[
                "-arch",
                architecture,
                text(&source).unwrap(),
                "-o",
                text(&app.join("Contents/MacOS/host")).unwrap(),
            ],
        )
        .unwrap();
        let plist = app.join("Contents/Info.plist");
        let write_plist = |id: &str| {
            fs::write(&plist, format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>{id}</string><key>CFBundleExecutable</key><string>host</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>"#
            )).unwrap();
        };
        let sign = |id: &str| {
            checked(
                "/usr/bin/codesign",
                &[
                    "--force",
                    "-s",
                    "-",
                    "--identifier",
                    id,
                    text(&app).unwrap(),
                ],
            )
            .unwrap();
        };
        write_plist(identifier);
        sign(identifier);
        let legacy_config = json!({"bundleId": identifier, "appBundleName": "Host.app", "hostExecutable": "host",
            "requirement": format!("identifier \"{identifier}\""), "nestedCode": []});
        let mut candidate_config = legacy_config.clone();
        candidate_config["nestedCode"] = json!([{"path": "Contents/Helpers/helper",
            "identifier": "dev.example.legacy-cutover.helper",
            "requirement": "identifier \"dev.example.legacy-cutover.helper\""}]);
        let state = root.join("state");
        let ctl = Ctl {
            config: candidate_config,
            args: BTreeMap::from([
                ("state".into(), text(&state).unwrap().into()),
                ("app-dir".into(), text(&app).unwrap().into()),
            ]),
        };
        assert!(ctl.describe_incumbent(&app, Incumbent::Contract).is_err());
        assert_eq!(
            ctl.describe_incumbent(&app, Incumbent::Legacy)
                .expect("Legacy incumbent signature must verify without a recorded config"),
            None
        );
        write_plist("dev.example.wrong");
        sign(identifier);
        assert!(ctl.describe_incumbent(&app, Incumbent::Legacy).is_err());
        write_plist(identifier);
        sign("dev.example.wrong");
        assert!(ctl.describe_incumbent(&app, Incumbent::Legacy).is_err());
        sign(identifier);
        fs::write(app.join("Contents/invalid-resource"), b"not signed").unwrap();
        assert!(ctl.describe_incumbent(&app, Incumbent::Legacy).is_err());
        fs::remove_file(app.join("Contents/invalid-resource")).unwrap();
        sign(identifier);
        destination(&state, true).unwrap();
        destination(&state.join("host-configs"), true).unwrap();
        let record = ctl.host_config_path(&app).unwrap();
        atomic_write(&record, &serde_json::to_vec(&legacy_config).unwrap()).unwrap();
        let own_descriptor = artifact::describe(&app, &legacy_config).unwrap();
        for mode in [Incumbent::Contract, Incumbent::Legacy] {
            assert_eq!(
                ctl.describe_incumbent(&app, mode).unwrap().unwrap(),
                own_descriptor
            );
        }
        // A legacy opt-in never falls back past a recorded contract failure.
        atomic_write(&record, &serde_json::to_vec(&ctl.config).unwrap()).unwrap();
        assert!(ctl.describe_incumbent(&app, Incumbent::Legacy).is_err());
        fs::remove_file(&record).unwrap();
        let make_release = |name: &str, config: &Value, nested: bool| {
            let release = root.join(name);
            fs::create_dir(&release).unwrap();
            let host = release.join(artifact::app_bundle_name(config).unwrap());
            checked(
                "/bin/cp",
                &["-R", text(&app).unwrap(), text(&host).unwrap()],
            )
            .unwrap();
            if nested {
                let helper = host.join("Contents/Helpers/helper");
                fs::create_dir_all(helper.parent().unwrap()).unwrap();
                fs::copy(app.join("Contents/MacOS/host"), &helper).unwrap();
                checked(
                    "/usr/bin/codesign",
                    &[
                        "--force",
                        "-s",
                        "-",
                        "--identifier",
                        "dev.example.legacy-cutover.helper",
                        text(&helper).unwrap(),
                    ],
                )
                .unwrap();
                checked(
                    "/usr/bin/codesign",
                    &[
                        "--force",
                        "-s",
                        "-",
                        "--identifier",
                        identifier,
                        text(&host).unwrap(),
                    ],
                )
                .unwrap();
            }
            let descriptor = artifact::describe(&host, config).unwrap();
            checked("/bin/chmod", &["-R", "a-w", text(&host).unwrap()]).unwrap();
            let receipt = artifact::create_receipt(&host, &descriptor, config).unwrap();
            fs::write(
                release.join("descriptor.json"),
                serde_json::to_vec(&descriptor).unwrap(),
            )
            .unwrap();
            fs::write(
                release.join("receipt.json"),
                serde_json::to_vec(&receipt).unwrap(),
            )
            .unwrap();
            checked("/bin/chmod", &["-R", "a-w", text(&release).unwrap()]).unwrap();
            assert_eq!(artifact::verify_release(&release, &descriptor, config).unwrap().app, host);
            let mut wrong_name = config.clone();
            wrong_name["appBundleName"] = json!("Other Product.app");
            assert!(artifact::verify_release(&release, &descriptor, &wrong_name).is_err());
            release
        };
        let nested_release = make_release("nested-release", &ctl.config, true);
        let plain_release = make_release("plain-release", &legacy_config, false);
        let mut ctl = ctl;
        ctl.args.insert(
            "archive-dir".into(),
            text(&root.join("archive")).unwrap().into(),
        );
        ctl.args
            .insert("artifact".into(), text(&nested_release).unwrap().into());
        ctl.args.insert(
            "desired".into(),
            text(&nested_release.join("descriptor.json"))
                .unwrap()
                .into(),
        );
        let incumbent_inode = inode(&app);
        assert!(ctl.install_artifact().is_err());
        assert_eq!(inode(&app), incumbent_inode);
        ctl.args.insert("incumbent".into(), "legacy".into());
        assert_eq!(ctl.install_artifact().unwrap()["changed"], true);
        let first_archive = pointer(&archive_pointer(&app)).unwrap();
        assert_eq!(first_archive.file_name().unwrap(), "Host.app");
        assert_ne!(first_archive.parent(), app.parent());
        assert!(app.join("Contents/Helpers/helper").is_file());
        assert_eq!(
            read_json(&ctl.host_config_path(&app).unwrap()).unwrap(),
            Some(ctl.config.clone())
        );
        ctl.args.remove("incumbent");
        ctl.config = legacy_config;
        ctl.args
            .insert("artifact".into(), text(&plain_release).unwrap().into());
        ctl.args.insert(
            "desired".into(),
            text(&plain_release.join("descriptor.json")).unwrap().into(),
        );
        assert_eq!(ctl.install_artifact().unwrap()["changed"], true);
        let second_archive = pointer(&archive_pointer(&app)).unwrap();
        assert_eq!(second_archive.file_name().unwrap(), "Host.app");
        assert_ne!(first_archive.parent(), second_archive.parent());
        assert!(first_archive.is_dir());
        assert!(!app.join("Contents/Helpers/helper").exists());
        assert_eq!(ctl.install_artifact().unwrap()["changed"], false);
        checked("/bin/chmod", &["-R", "u+w", text(&root).unwrap()]).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stages_are_private_unique_and_owned() {
        let parent = fs::canonicalize(std::env::temp_dir()).unwrap();
        let first = private_stage(&parent).unwrap();
        let second = private_stage(&parent).unwrap();
        assert_ne!(first, second);
        for stage in [first, second] {
            let metadata = fs::symlink_metadata(&stage).unwrap();
            assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
            assert_eq!(metadata.mode() & 0o777, 0o700);
            fs::remove_dir(stage).unwrap();
        }
    }
    #[test]
    fn refuses_missing_extra_or_unreadable_signing_flags() {
        for (name, bit) in [("host", 0x0001), ("hard", 0x0100), ("kill", 0x0200),
            ("expires", 0x0400), ("restrict", 0x0800), ("library", 0x2000), ("runtime", 0x10000)] {
            let options = vec![name.to_owned()];
            assert!(verify_options("CodeDirectory flags=0x2(adhoc)", &options).is_err());
            assert!(verify_options(&format!("CodeDirectory flags=0x{:x}(test)", bit | 2), &options).is_ok());
        }
        assert!(verify_options("CodeDirectory flags=0x1000(enforcement)", &[]).is_err());
        assert!(verify_options("CodeDirectory unreadable", &[]).is_err());
        assert!(verify_options("CodeDirectory flags=0x20002(adhoc,linker-signed)", &[]).is_ok());
    }
}
