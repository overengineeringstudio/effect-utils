use super::*;
use serde_json::{json, Value};

fn digest(value: &str) -> String {
    sha256_bytes(value.as_bytes())
}
fn recipe() -> Recipe {
    Recipe::new(
        digest("closure"),
        digest("archive"),
        "package".into(),
        vec![digest("one"), digest("two")],
    )
    .unwrap()
}
fn write(path: &Path, bytes: &[u8], mode: u32) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}
fn mkdir(path: &Path) {
    fs::create_dir_all(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

struct Fixture {
    _temp: tempfile::TempDir,
    args: ExtractNpmArgs,
    capability: PathBuf,
    generation: PathBuf,
    root: PathBuf,
    recipe: Recipe,
    pin: PathBuf,
    canonical: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let capability = base.join("native.json");
        write(&capability, b"native capability bytes", 0o600);
        let bun_manifest = base.join("bun.json");
        write(&bun_manifest, b"not inspected on trusted hit", 0o600);
        let runtime = base.join("runtime");
        mkdir(&runtime);
        let entry = runtime.join("shared-recipe.js");
        write(&entry, b"publisher source", 0o600);
        let config = base.join("bunfig.toml");
        write(&config, b"", 0o600);
        let closure_inputs = base.join("inputs.json");
        write(&closure_inputs, &serde_json::to_vec(&json!({"schema":"effect-utils/buck-materialization-tool-inputs/v1","nativeManifest":capability,"bunManifest":bun_manifest,"publisherRuntime":runtime})).unwrap(), 0o600);
        let closure = closure_digest(&closure_inputs, &capability, &config)
            .unwrap()
            .0;
        let recipe = Recipe::new(closure, digest("archive"), "package".into(), vec![]).unwrap();
        let key = recipe.key().unwrap();
        let store = base.join("cas");
        mkdir(&store);
        let root = base.join("cas.buck-materialization-v1");
        mkdir(&root);
        for dir in [".store", ".recipes", ".leases"] {
            mkdir(&root.join(dir));
        }
        let name = format!("recipe-{key}");
        let generation = root.join(".store").join(&name);
        mkdir(&generation);
        mkdir(&generation.join("pins"));
        let blob = Blob {
            sha256: digest("payload"),
            size: 7,
            mode: "0444".into(),
        };
        mkdir(&store.join(&blob.sha256[..2]));
        let canonical = store.join(&blob.sha256[..2]).join(blob.key());
        write(&canonical, b"payload", 0o444);
        let pin = generation.join("pins").join(blob.key());
        fs::hard_link(&canonical, &pin).unwrap();
        let manifest = Manifest {
            schema: TREE.into(),
            recipe: recipe.clone(),
            entries: vec![
                Entry::Directory(DirectoryEntry {
                    path: "lib".into(),
                    directory: true,
                }),
                Entry::File(FileEntry {
                    path: "lib/value".into(),
                    file: blob.clone(),
                }),
                Entry::Symlink(SymlinkEntry {
                    path: "value".into(),
                    symlink: "lib/value".into(),
                }),
            ],
        };
        let manifest_path = generation.join("manifest.json");
        let mut bytes = super::json(&manifest).unwrap();
        bytes.push(b'\n');
        write(&manifest_path, &bytes, 0o444);
        let proof = Proof(
            PROOF.into(),
            tuple(
                &sha256_bytes(&bytes),
                &fs::metadata(&manifest_path).unwrap(),
            ),
            vec![(
                blob.key(),
                tuple(&blob.sha256, &fs::metadata(&pin).unwrap()),
            )],
        );
        let mut bytes = super::json(&proof).unwrap();
        bytes.push(b'\n');
        write(&generation.join("verification.json"), &bytes, 0o600);
        write(
            &root.join(".recipes").join(format!("{key}.lock")),
            b"",
            0o600,
        );
        let control = root.join(".leases").join(format!("{name}.lock"));
        write(&control, b"", 0o600);
        let meta = fs::metadata(&control).unwrap();
        write(
            &control,
            format!(
                "{}:{}\n{}\n{}\n",
                meta.dev(),
                meta.ino(),
                root.display(),
                name
            )
            .as_bytes(),
            0o600,
        );
        let args = ExtractNpmArgs {
            archive: base.join("nonexistent-archive"),
            out: base.join("output"),
            strip_prefix: "package".into(),
            patches: vec![],
            replay: ReplayArgs {
                content_store: Some(store),
                high_water_bytes: Some(4096),
                archive_sha256: Some(digest("archive")),
                tool_closure_inputs: Some(closure_inputs),
                publisher_bun: Some(base.join("nonexistent-bun")),
                publisher_bun_config: Some(config),
                publisher_entry: Some(entry),
                receipt: Some(base.join("receipt.json")),
            },
        };
        Self {
            _temp: temp,
            args,
            capability,
            generation,
            root,
            recipe,
            pin,
            canonical,
        }
    }
    fn validate(&self) -> ToolResult<Validated> {
        validate_generation(
            self.args.replay.content_store.as_ref().unwrap(),
            &self.generation,
            &self.recipe,
        )
    }
    fn proof(&self) -> Proof {
        decode(&fs::read(self.generation.join("verification.json")).unwrap()).unwrap()
    }
    fn replace_proof(&self, proof: &Proof) {
        let mut bytes = super::json(proof).unwrap();
        bytes.push(b'\n');
        write(&self.generation.join("verification.json"), &bytes, 0o600);
    }
    fn establish_nonracy_proof(&self) {
        let deadline = Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let valid = self.validate().unwrap();
            assert!(!valid.mismatch);
            if !valid.racy { return; }
            assert!(Instant::now() < deadline, "fixture filesystem clock did not advance");
            std::thread::sleep(std::time::Duration::from_millis(2));
            self.replace_proof(&self.proof());
        }
    }
}

#[test]
fn all_recipe_dimensions_change_identity() {
    let base = recipe();
    let key = base.key().unwrap();
    let variants = [
        Recipe(
            base.0.clone(),
            digest("other closure"),
            base.2.clone(),
            base.3.clone(),
            base.4.clone(),
        ),
        Recipe(
            base.0.clone(),
            base.1.clone(),
            digest("other archive"),
            base.3.clone(),
            base.4.clone(),
        ),
        Recipe(
            base.0.clone(),
            base.1.clone(),
            base.2.clone(),
            "other-prefix".into(),
            base.4.clone(),
        ),
        Recipe(
            base.0.clone(),
            base.1.clone(),
            base.2.clone(),
            base.3.clone(),
            vec![digest("two"), digest("one")],
        ),
        Recipe(
            base.0.clone(),
            base.1.clone(),
            base.2.clone(),
            base.3.clone(),
            vec![digest("changed"), digest("two")],
        ),
    ];
    for value in variants {
        assert_ne!(value.key().unwrap(), key);
    }
    let expected = format!(
        "[\"{RECIPE}\",\"{}\",\"{}\",\"package\",[\"{}\",\"{}\"]]",
        base.1, base.2, base.4[0], base.4[1]
    );
    assert_eq!(key, sha256_bytes(expected.as_bytes()));
}
#[test]
fn malformed_and_incomplete_recipes_fail_closed() {
    for prefix in ["", ".", "..", "a/../b", "a//b", "a/", "/a", "a\\b", "a\nb"] {
        assert!(
            Recipe::new(digest("c"), digest("a"), prefix.into(), vec![]).is_err(),
            "{prefix:?}"
        );
    }
    for hash in ["", "ABC", &"A".repeat(64), &"g".repeat(64)] {
        assert!(Recipe::new(hash.into(), digest("a"), "package".into(), vec![]).is_err());
    }
    assert!(decode::<Recipe>(b"[]").is_err());
    let mut value = serde_json::to_value(recipe()).unwrap();
    value.as_array_mut().unwrap().push(Value::Null);
    assert!(decode::<Recipe>(&serde_json::to_vec(&value).unwrap()).is_err());
    assert!(ReplayArgs {
        archive_sha256: Some(digest("a")),
        ..ReplayArgs::default()
    }
    .require_disabled()
    .is_err());
}
#[test]
fn trusted_warm_hit_never_invokes_publisher_or_writes_host_state() {
    let f = Fixture::new();
    f.establish_nonracy_proof();
    let proof_before = fs::metadata(f.generation.join("verification.json")).unwrap();
    let pin_before = fs::metadata(&f.pin).unwrap();
    extract(&f.args, &f.capability).unwrap();
    assert_eq!(fs::read(f.args.out.join("lib/value")).unwrap(), b"payload");
    assert_eq!(
        fs::read_link(f.args.out.join("value")).unwrap(),
        Path::new("lib/value")
    );
    let output = fs::metadata(f.args.out.join("lib/value")).unwrap();
    assert!(!same(&output, &pin_before));
    assert_eq!(output.mode() & 0o777, 0o644);
    assert_eq!(
        tuple("", &pin_before),
        tuple("", &fs::metadata(&f.pin).unwrap())
    );
    assert_eq!(
        tuple("", &proof_before),
        tuple(
            "",
            &fs::metadata(f.generation.join("verification.json")).unwrap()
        )
    );
    let receipt: Value =
        serde_json::from_slice(&fs::read(f.args.replay.receipt.as_ref().unwrap()).unwrap())
            .unwrap();
    assert_eq!(receipt["cacheHit"], true);
    assert_eq!(receipt["extractionCount"], 0);
    assert_eq!(receipt["patchCount"], 0);
    assert_eq!(receipt["sourceVerification"], "metadata-proof");
    assert_eq!(
        receipt["clonedFiles"].as_u64().unwrap() + receipt["copiedFiles"].as_u64().unwrap(),
        1
    );
    assert_eq!(
        receipt["clonedBytes"].as_u64().unwrap() + receipt["copiedBytes"].as_u64().unwrap(),
        7
    );
    assert_eq!(receipt["linkedFiles"], 0);
}
#[test]
fn ctime_mismatch_requires_bridge_verification_never_reextracts() {
    let f = Fixture::new();
    let mut proof = f.proof();
    proof.2[0].1 .6 = "0".into();
    f.replace_proof(&proof);
    assert!(f.validate().unwrap().mismatch);
    assert!(extract(&f.args, &f.capability).is_err());
    assert!(!f.args.out.exists());
}
#[test]
fn mode_symlink_and_pin_identity_corruption_fail_closed() {
    let f = Fixture::new();
    fs::set_permissions(&f.pin, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(f.validate().is_err());
    let f = Fixture::new();
    fs::remove_file(&f.pin).unwrap();
    symlink(&f.canonical, &f.pin).unwrap();
    assert!(f.validate().is_err());
    let f = Fixture::new();
    fs::remove_file(&f.pin).unwrap();
    write(&f.pin, b"payload", 0o444);
    assert!(f.validate().is_err());
}
#[test]
fn malformed_proofs_and_manifest_digest_changes_fail_closed() {
    let f = Fixture::new();
    write(&f.generation.join("verification.json"), b"[]\n", 0o600);
    assert!(f.validate().is_err());
    let f = Fixture::new();
    let mut proof = f.proof();
    proof.2.clear();
    f.replace_proof(&proof);
    assert!(f.validate().is_err());
    let f = Fixture::new();
    let mut proof = f.proof();
    proof.1 .0 = digest("unestablished");
    f.replace_proof(&proof);
    assert!(f.validate().is_err());
    assert!(
        decode::<Manifest>(br#"{"schema":"x","recipe":[],"entries":[],"extra":true}"#).is_err()
    );
    assert!(decode::<Entry>(
        br#"{"path":"a","file":{"sha256":"x","size":1,"mode":"0444","extra":1}}"#
    )
    .is_err());
}
#[test]
fn manifest_rejects_paths_traversal_cycles_and_unknown_modes() {
    for path in ["../escape", "a//b", "a\\b", "a\nb", "/absolute"] {
        assert!(validate_path(path).is_err());
    }
    let r = recipe();
    let trees = [
        vec![Entry::Directory(DirectoryEntry {
            path: "a/b".into(),
            directory: true,
        })],
        vec![Entry::Symlink(SymlinkEntry {
            path: "a".into(),
            symlink: "a".into(),
        })],
        vec![Entry::Symlink(SymlinkEntry {
            path: "a".into(),
            symlink: "../outside".into(),
        })],
        vec![Entry::Symlink(SymlinkEntry {
            path: "a".into(),
            symlink: "missing".into(),
        })],
        vec![Entry::File(FileEntry {
            path: "a".into(),
            file: Blob {
                sha256: digest("a"),
                size: 1,
                mode: "0644".into(),
            },
        })],
    ];
    for entries in trees {
        assert!(Manifest {
            schema: TREE.into(),
            recipe: r.clone(),
            entries
        }
        .validate(&r)
        .is_err());
    }
}
#[test]
fn existing_generation_missing_control_is_not_repaired() {
    let f = Fixture::new();
    let control = f
        .root
        .join(".leases")
        .join(format!("recipe-{}.lock", f.recipe.key().unwrap()));
    fs::remove_file(&control).unwrap();
    assert!(extract(&f.args, &f.capability).is_err());
    assert!(!control.exists());
    assert!(!f.args.out.exists());
}
#[test]
fn private_install_never_overwrites_existing_output() {
    let f = Fixture::new();
    mkdir(&f.args.out);
    write(&f.args.out.join("sentinel"), b"keep", 0o600);
    assert!(extract(&f.args, &f.capability).is_err());
    assert_eq!(fs::read(f.args.out.join("sentinel")).unwrap(), b"keep");
}
#[test]
fn generation_shared_lease_blocks_retirement_until_dropped() {
    let f = Fixture::new();
    let name = format!("recipe-{}", f.recipe.key().unwrap());
    let held = generation_lease(&f.root, &name).unwrap();
    let other = open(&f.root.join(".leases").join(format!("{name}.lock")), true).unwrap();
    assert!(other.try_lock().is_err());
    drop(held);
    assert!(other.try_lock().is_ok());
}
#[test]
fn closure_identity_hashes_runtime_bytes_not_root_paths() {
    let f = Fixture::new();
    let inputs = f.args.replay.tool_closure_inputs.as_ref().unwrap();
    let config = f.args.replay.publisher_bun_config.as_ref().unwrap();
    let initial = closure_digest(inputs, &f.capability, config).unwrap().0;
    write(
        f.args.replay.publisher_entry.as_ref().unwrap(),
        b"changed publisher",
        0o600,
    );
    assert_ne!(
        initial,
        closure_digest(inputs, &f.capability, config).unwrap().0
    );
    let decoded: ClosureInputs = decode(&fs::read(inputs).unwrap()).unwrap();
    symlink(
        "shared-recipe.js",
        decoded.publisher_runtime.join("alias.js"),
    )
    .unwrap();
    assert!(closure_digest(inputs, &f.capability, config).is_err());
}

#[test]
fn modified_same_size_payload_invalidates_ctime_proof() {
    let f = Fixture::new();
    let before = fs::metadata(&f.pin).unwrap();
    fs::set_permissions(&f.pin, fs::Permissions::from_mode(0o644)).unwrap();
    fs::write(&f.pin, b"corrupt").unwrap();
    fs::set_permissions(&f.pin, fs::Permissions::from_mode(0o444)).unwrap();
    let after = fs::metadata(&f.pin).unwrap();
    let valid = f.validate().unwrap();
    assert!(
        valid.mismatch || valid.racy,
        "neither tuple mismatch nor racy proof witnessed same-size mutation: before={}:{} after={}:{}",
        before.ctime(), before.ctime_nsec(), after.ctime(), after.ctime_nsec()
    );
    assert!(extract(&f.args, &f.capability).is_err());
    assert!(!f.args.out.exists());
}

#[test]
fn executable_outputs_are_private_and_preserve_executable_bits() {
    let f = Fixture::new();
    let blob = Blob {
        sha256: digest("executable"),
        size: 10,
        mode: "0555".into(),
    };
    let pin = f.generation.join("pins").join(blob.key());
    write(&pin, b"executable", 0o555);
    let manifest = Manifest {
        schema: TREE.into(),
        recipe: f.recipe.clone(),
        entries: vec![Entry::File(FileEntry {
            path: "program".into(),
            file: blob.clone(),
        })],
    };
    let valid = Validated {
        manifest,
        proof: Proof(
            PROOF.into(),
            f.proof().1,
            vec![(
                blob.key(),
                tuple(&blob.sha256, &fs::metadata(&pin).unwrap()),
            )],
        ),
        mismatch: false,
        racy: true,
    };
    let counts = install(&valid, &f.generation, &f.args.out).unwrap();
    let installed = fs::metadata(f.args.out.join("program")).unwrap();
    assert_eq!(installed.mode() & 0o777, 0o755);
    assert!(!same(&installed, &fs::metadata(pin).unwrap()));
    assert_eq!(counts.copied_files + counts.cloned_files, 1);
    assert_eq!(counts.linked_files, 0);
}

#[test]
fn clone_fallback_only_accepts_unsupported_operation_errors() {
    for code in [
        libc::EOPNOTSUPP,
        libc::ENOTTY,
        libc::EINVAL,
        libc::EXDEV,
        libc::ENOSYS,
    ] {
        assert!(clone_unsupported(&std::io::Error::from_raw_os_error(code)));
    }
    for code in [
        libc::EACCES,
        libc::EPERM,
        libc::ENOSPC,
        libc::EIO,
        libc::EEXIST,
    ] {
        assert!(!clone_unsupported(&std::io::Error::from_raw_os_error(code)));
    }
}

#[test]
fn writable_host_directories_are_rejected() {
    let f = Fixture::new();
    fs::set_permissions(f.generation.join("pins"), fs::Permissions::from_mode(0o722)).unwrap();
    assert!(f.validate().is_err());
    let f = Fixture::new();
    fs::set_permissions(&f.root, fs::Permissions::from_mode(0o770)).unwrap();
    assert!(generation_lease(&f.root, &format!("recipe-{}", f.recipe.key().unwrap())).is_err());
}

#[test]
fn exclusive_generation_holder_fails_shared_acquisition_without_waiting() {
    let f = Fixture::new();
    let name = format!("recipe-{}", f.recipe.key().unwrap());
    let control = open(&f.root.join(".leases").join(format!("{name}.lock")), true).unwrap();
    control.try_lock().unwrap();
    assert!(generation_lease(&f.root, &name).is_err());
}

// The Darwin acceptance lane uses its local APFS temporary volume. This proves
// the FD-based clone API accepts read-only sources and an absent destination.
#[cfg(target_os = "macos")]
#[test]
fn darwin_apfs_clone_creates_independent_destination() {
    let temp = tempfile::tempdir().unwrap();
    let source_path = temp.path().join("source");
    let destination = temp.path().join("destination");
    write(&source_path, b"APFS clone bytes", 0o444);
    let source = open(&source_path, false).unwrap();
    let before = fs::metadata(&source_path).unwrap();
    let output = clone_file(&source, &destination)
        .unwrap()
        .expect("Darwin APFS lane must clone");
    let installed = fs::metadata(&destination).unwrap();
    assert!(!same(&before, &installed));
    assert_eq!(installed.len(), before.len());
    assert_eq!(installed.uid(), uid());
    assert_eq!(installed.nlink(), 1);
    assert!(same_stat(&before, &fs::metadata(&source_path).unwrap()));
    assert_eq!(fs::read(&destination).unwrap(), b"APFS clone bytes");
    drop(output);
}

#[test]
fn metadata_proof_requires_strict_same_device_ctime_ordering() {
    assert!(metadata_proof_is_fresh(7, 99, 7, 100));
    assert!(!metadata_proof_is_fresh(7, 100, 7, 100));
    assert!(!metadata_proof_is_fresh(7, 101, 7, 100));
    assert!(!metadata_proof_is_fresh(7, 99, 8, 100));
    assert!(!metadata_proof_is_fresh(7, -1, 8, 100));
    assert!(metadata_proof_is_fresh(7, -2, 7, -1));
}

#[test]
fn racy_postverification_sources_require_private_output_digest_checks() {
    let f = Fixture::new();
    let mut valid = f.validate().unwrap();
    fs::set_permissions(&f.pin, fs::Permissions::from_mode(0o644)).unwrap();
    fs::write(&f.pin, b"corrupt").unwrap();
    fs::set_permissions(&f.pin, fs::Permissions::from_mode(0o444)).unwrap();
    // Model an unchanged source tuple on a coarse clock after TS verification:
    // the tuple still claims the established payload digest, not these bytes.
    let expected_digest = valid.proof.2[0].1.0.clone();
    valid.proof.2[0].1 = tuple(&expected_digest, &fs::metadata(&f.pin).unwrap());
    valid.racy = true;
    assert!(install(&valid, &f.generation, &f.args.out).is_err());
    assert!(!f.args.out.exists());
}
