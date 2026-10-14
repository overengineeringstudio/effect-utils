//! Signing and verify-only release import. Legacy local-sign installation remains separate.
use super::*;

fn desired(ctl: &Ctl) -> Result<Value> {
    let path = Path::new(ctl.arg("desired")?);
    if path.is_dir() { artifact::describe(path, &ctl.config) }
    else {
        let value: Value = serde_json::from_slice(&fs::read(path)?)?;
        // describe-host's JSON CLI envelope is also the Nix descriptor output.
        Ok(if value["ok"] == true { value["result"].clone() } else { value })
    }
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
    pub(super) fn describe_host(&self) -> Result<Value> { artifact::describe(Path::new(self.arg("desired")?), &self.config) }

    pub(super) fn verify_bundle(&self, app: &Path) -> Result<()> {
        for entry in artifact::signing_entries(&self.config)? {
            let path = if entry.path.is_empty() { app.to_owned() } else { app.join(&entry.path) };
            self.signature_with(&path, &entry.requirement)?;
            for architecture in artifact::code_architectures(app, &entry, &self.config)? {
                artifact::verify_entitlements(app, &entry, &architecture)?;
                let details = keys::bounded_codesign(&["-d", "--verbose=4", "--architecture", &architecture, text(&path)?])?;
                let diagnostic = String::from_utf8_lossy(&details.stderr);
                if !details.status.success() || !diagnostic.lines().any(|line| line == format!("Identifier={}", entry.identifier)) {
                    return Err(mismatch("Code identifier differs from the independently pinned inventory"));
                }
                verify_options(&diagnostic, &entry.options)?;
            }
        }
        Ok(())
    }

    pub(super) fn seal_host(&self) -> Result<Value> {
        let unsigned = Path::new(self.arg("desired")?);
        if !unsigned.is_dir() { return Err(fail(64, "invalid-input", "seal-host requires the unsigned complete .app")); }
        let descriptor = artifact::describe(unsigned, &self.config)?;
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
        let stage = parent.join(format!(".sealed-release-{}", std::process::id()));
        fs::create_dir(&stage)?;
        let result = (|| {
            let app = stage.join("host.app");
            checked("/bin/cp", &["-R", text(unsigned)?, text(&app)?])?;
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

    pub(super) fn install_artifact(&self) -> Result<Value> {
        if ["keychain", "keychain-password-fd", "signing-auth-pending"].iter().any(|key| self.args.contains_key(*key)) {
            return Err(fail(64, "invalid-input", "Artifact import accepts no signing credentials and has no signing fallback"));
        }
        let descriptor = desired(self)?;
        let release = Path::new(self.arg("artifact")?);
        let candidate = artifact::verify_release(release, &descriptor, &self.config)?;
        self.verify_bundle(&candidate.app)?;
        let app = self.app()?;
        let parent = app.parent().ok_or_else(|| fail(64, "invalid-input", "App requires parent"))?;
        let archive = PathBuf::from(self.arg("archive-dir")?);
        // Verification above completes before any destination mutation.
        destination(parent, true).map_err(|mut error| { error.reason = format!("Preparing app destination: {}", error.reason); error })?;
        destination(&archive, true).map_err(|mut error| { error.reason = format!("Preparing archive destination: {}", error.reason); error })?;
        destination(&self.state()?, true).map_err(|mut error| { error.reason = format!("Preparing state destination: {}", error.reason); error })?;
        if fs::metadata(parent)?.dev() != fs::metadata(&archive)?.dev() {
            return Err(fail(64, "invalid-input", "App and immutable archive must share a filesystem for atomic exchange"));
        }
        let (reconciled, _) = self.reconcile(&app)?;
        if app.exists() && artifact::describe(&app, &self.config)? == descriptor && self.verify_bundle(&app).is_ok() &&
            artifact::artifact_revision(&app)? == candidate.sealed_revision {
            return Ok(json!({"changed": false, "descriptor": descriptor, "sealedRevision": candidate.sealed_revision, "reconciled": reconciled}));
        }
        if app.exists() && (!fs::symlink_metadata(&app)?.is_dir() || fs::symlink_metadata(&app)?.uid() != unsafe { libc::geteuid() }) {
            return Err(fail(64, "invalid-input", "Installed app is not an owned directory"));
        }
        if app.exists() { self.signature(&app)?; }
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| fail(23, "operation-failed", e.to_string()))?.as_nanos();
        let stage = archive.join(format!("retained-{}-{nonce}.app", std::process::id()));
        checked("/bin/cp", &["-R", text(&candidate.app)?, text(&stage)?])?;
        self.verify_bundle(&stage)?;
        if artifact::describe(&stage, &self.config)? != descriptor || artifact::artifact_revision(&stage)? != candidate.sealed_revision {
            return Err(mismatch("Staged artifact content or sealed revision differs"));
        }
        if app.exists() {
            let txn = json!({"stage": stage, "stageInode": inode(&stage), "generation": pointer(&self.state()?.join("current")), "immutable": true});
            atomic_write(&transaction_record(&app), &serde_json::to_vec(&txn)?)?;
            exchange(&stage, &app)?;
            self.publish_archive(&app, &txn)?;
        } else { publish_exclusive(&stage, &app).map_err(|mut error| { error.reason = format!("Publishing verified artifact: {}", error.reason); error })?; }
        Ok(json!({"changed": true, "descriptor": descriptor, "sealedRevision": candidate.sealed_revision, "archive": pointer(&archive_pointer(&app)), "reconciled": reconciled}))
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
        let live = if self.args.contains_key("plist") { Some(self.supplied_evidence()?) } else { None };
        Ok(json!({"verified": true, "descriptor": descriptor, "sealedRevision": sealed_revision,
            "generation": generation, "generationDigest": manifest["generation"], "launchd": live}))
    }

    pub(super) fn rollback_artifact(&self) -> Result<Value> {
        // The caller selects the exact release/generation pair; no latest-success policy.
        let installed = self.install_artifact()?;
        let selected = self.generation()?;
        let launchd = if self.args.contains_key("plist") { Some(self.converge_supplied()?) } else { None };
        let verified = self.verify_artifact()?;
        Ok(json!({"installed": installed, "selected": selected, "launchd": launchd, "verification": verified,
            "restartRequired": !self.args.contains_key("plist")}))
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
        let live = if self.args.contains_key("plist") { Some(self.supplied_evidence()?) } else { None };
        Ok(json!({"descriptor": actual, "sealedRevision": sealed_revision, "artifactValid": valid,
            "activeGeneration": generation, "generationDigest": manifest.as_ref().map(|value| &value["generation"]),
            "launchd": live, "hostArchive": pointer(&archive_pointer(&app))}))
    }

    #[cfg(feature = "test-signing-cert")]
    pub(super) fn seal_fixture_artifact(&self) -> Result<Value> {
        if ["keychain", "keychain-password-fd"].iter().any(|key| self.args.contains_key(*key)) { return Err(fail(64, "invalid-input", "Ad-hoc test release accepts no keychain")); }
        let source = Path::new(self.arg("desired")?);
        let descriptor = artifact::describe(source, &self.config)?;
        self.verify_bundle(source)?;
        let output = PathBuf::from(self.arg("output")?);
        let parent = output.parent().ok_or_else(|| fail(64, "invalid-input", "Release requires a parent"))?;
        destination(parent, false)?;
        let stage = parent.join(format!(".fixture-release-{}", std::process::id()));
        fs::create_dir(&stage)?;
        let result = (|| {
            let app = stage.join("host.app");
            checked("/bin/cp", &["-R", text(source)?, text(&app)?])?;
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
