use buck2_fingerprint::{fingerprint, fingerprint_input_root, LinkOwner};
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::PathBuf;

#[test]
fn canonical_tree_modes_and_owner_root_links() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("parity-tree");
    let backing = scratch.path().join("parity-backing");
    fs::create_dir_all(source.join("dir")).unwrap();
    fs::create_dir(&backing).unwrap();
    fs::write(source.join("dir/first.txt"), b"first\n").unwrap();
    fs::write(backing.join("external.txt"), b"external\n").unwrap();
    symlink("dir/first.txt", source.join("in-root")).unwrap();
    symlink("../parity-backing", source.join("owner-root")).unwrap();
    symlink("../parity-backing/external.txt", source.join("cross-root")).unwrap();
    let owners = [
        LinkOwner {
            source: source.clone(),
            identity: "source".into(),
        },
        LinkOwner {
            source: backing.clone(),
            identity: "backing".into(),
        },
    ];
    let plain = fingerprint(&source, false, &[], &owners, None).unwrap();
    let repeat = fingerprint(&source, false, &[], &owners, None).unwrap();
    assert_eq!(plain.digest, repeat.digest);
    assert_eq!(plain.literal_links_digest, repeat.literal_links_digest);
    assert_eq!(plain.resolved_links_digest, repeat.resolved_links_digest);
    assert_ne!(plain.digest, plain.resolved_links_digest.unwrap());
    let dereferenced =
        fingerprint(&source, true, std::slice::from_ref(&backing), &[], None).unwrap();
    assert_ne!(plain.digest, dereferenced.digest);
    assert!(fingerprint(&source, true, &[], &[], None).is_err());
    let relocated = scratch.path().join("relocated");
    fs::create_dir_all(relocated.join("dir")).unwrap();
    fs::write(relocated.join("dir/first.txt"), b"first\n").unwrap();
    symlink("dir/first.txt", relocated.join("in-root")).unwrap();
    symlink("../parity-backing", relocated.join("owner-root")).unwrap();
    symlink(
        "../parity-backing/external.txt",
        relocated.join("cross-root"),
    )
    .unwrap();
    assert_eq!(
        plain.digest,
        fingerprint(
            &relocated,
            false,
            &[],
            &[
                LinkOwner {
                    source: PathBuf::from(&relocated),
                    identity: "source".into()
                },
                owners[1].clone(),
            ],
            None,
        )
        .unwrap()
        .digest
    );
}

#[test]
fn canonical_tree_digest_remains_mode_independent() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("tree");
    let directory = source.join("directory");
    let file = directory.join("file");
    fs::create_dir_all(&directory).unwrap();
    fs::write(&file, b"unchanged content").unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    let canonical_before = fingerprint(&source, false, &[], &[], None).unwrap();
    let input_before = fingerprint_input_root(&source).unwrap();

    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();

    let canonical_after = fingerprint(&source, false, &[], &[], None).unwrap();
    assert_eq!(canonical_before.digest, canonical_after.digest);
    assert_eq!(
        canonical_before.literal_links_digest,
        canonical_after.literal_links_digest
    );
    assert_eq!(
        canonical_before.resolved_links_digest,
        canonical_after.resolved_links_digest
    );
    assert_ne!(input_before, fingerprint_input_root(&source).unwrap());
}

#[test]
fn cli_isolated_admission_preserves_the_tree_digest() {
    let scratch = tempfile::tempdir().unwrap();
    let tree = scratch.path().join("tree");
    fs::create_dir(&tree).unwrap();
    fs::write(tree.join("payload"), b"bounded fixture").unwrap();
    let directory = scratch.path().join("admission");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_buck2-fingerprint"))
        .arg(&tree)
        .arg("--admission-directory")
        .arg(&directory)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let expected = fingerprint(&tree, false, &[], &[], Some(&directory)).unwrap();
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("digest {}\n", expected.digest)
    );
    assert!(directory.join("admission").is_file());
    for index in 0..4 {
        assert!(directory.join(format!("slot-{index}")).is_file());
    }
}
