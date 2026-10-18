use buck2_fingerprint::{fingerprint, fingerprint_batch, fingerprint_input_root, LinkOwner};
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::PathBuf;
use std::process::Command;

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
    let plain = fingerprint(&source, false, &[], &owners).unwrap();
    let repeat = fingerprint(&source, false, &[], &owners).unwrap();
    assert_eq!(plain.digest, repeat.digest);
    assert_eq!(plain.literal_links_digest, repeat.literal_links_digest);
    assert_eq!(plain.resolved_links_digest, repeat.resolved_links_digest);
    assert_ne!(plain.digest, plain.resolved_links_digest.unwrap());
    let dereferenced = fingerprint(&source, true, std::slice::from_ref(&backing), &[]).unwrap();
    assert_ne!(plain.digest, dereferenced.digest);
    assert!(fingerprint(&source, true, &[], &[]).is_err());
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
            ]
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
    let canonical_before = fingerprint(&source, false, &[], &[]).unwrap();
    let input_before = fingerprint_input_root(&source).unwrap();

    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();

    let canonical_after = fingerprint(&source, false, &[], &[]).unwrap();
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
fn batch_matches_single_tree_and_link_digests_in_input_order() {
    let scratch = tempfile::tempdir().unwrap();
    let first = scratch.path().join("first");
    let second = scratch.path().join("second");
    let backing = scratch.path().join("backing");
    for root in [&first, &second, &backing] {
        fs::create_dir(root).unwrap();
        fs::write(
            root.join("file"),
            root.file_name().unwrap().as_encoded_bytes(),
        )
        .unwrap();
    }
    for root in [&first, &second] {
        symlink("file", root.join("internal")).unwrap();
        symlink("../backing", root.join("owner-root")).unwrap();
        symlink("../backing/file", root.join("external")).unwrap();
    }
    let owners = [&first, &second, &backing].map(|root| LinkOwner {
        source: root.clone(),
        identity: root.file_name().unwrap().to_str().unwrap().into(),
    });
    // Include duplicates and deliberately reverse lexical order.
    let trees = [second, first.clone(), first, backing.clone()];
    for (dereference, backing_roots, link_owners) in [
        (false, &[][..], &owners[..]),
        (false, &[][..], &[][..]),
        (true, std::slice::from_ref(&backing), &owners[..]),
    ] {
        let batch = fingerprint_batch(&trees, dereference, backing_roots, link_owners).unwrap();
        assert_eq!(batch.len(), trees.len());
        for (tree, actual) in trees.iter().zip(batch) {
            let single = fingerprint(tree, dereference, backing_roots, link_owners).unwrap();
            assert_eq!(actual.digest, single.digest);
            assert_eq!(actual.resolved_links_digest, single.resolved_links_digest);
            assert_eq!(actual.literal_links_digest, single.literal_links_digest);
        }
    }
}

#[test]
fn batch_fails_if_any_root_or_shared_owner_is_invalid() {
    let scratch = tempfile::tempdir().unwrap();
    let valid = scratch.path().join("valid");
    fs::create_dir(&valid).unwrap();
    let file = scratch.path().join("file");
    fs::write(&file, b"not a directory").unwrap();
    let link = scratch.path().join("link");
    symlink(&valid, &link).unwrap();
    let missing = scratch.path().join("missing");
    for invalid in [&file, &link, &missing] {
        assert!(fingerprint_batch(&[valid.clone(), invalid.clone()], false, &[], &[]).is_err());
    }
    assert!(fingerprint_batch(
        std::slice::from_ref(&valid),
        false,
        &[],
        &[LinkOwner {
            source: missing,
            identity: "missing".into(),
        }],
    )
    .is_err());
    let outside = scratch.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("file"), b"external").unwrap();
    symlink(outside.join("file"), valid.join("external")).unwrap();
    assert!(fingerprint_batch(
        std::slice::from_ref(&valid),
        false,
        &[],
        &[LinkOwner {
            source: valid.clone(),
            identity: "valid".into(),
        }],
    )
    .is_err());
}

#[test]
fn batch_cli_emits_ordered_complete_records_and_preserves_single_mode() {
    let scratch = tempfile::tempdir().unwrap();
    let first = scratch.path().join("first root");
    let second = scratch.path().join("second=root");
    for root in [&first, &second] {
        fs::create_dir(root).unwrap();
        fs::write(
            root.join("file"),
            root.file_name().unwrap().as_encoded_bytes(),
        )
        .unwrap();
    }
    symlink("../second=root/file", first.join("external")).unwrap();
    // SOURCE may contain '=', but IDENTITY follows the final '=' delimiter.
    let owners =
        [(&first, "first-owner"), (&second, "second-owner")].map(|(root, identity)| LinkOwner {
            source: root.clone(),
            identity: identity.into(),
        });
    let roots = [second, first];
    for link_owners in [&[][..], &owners[..]] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_buck2-fingerprint"));
        command.arg("--batch");
        for root in &roots {
            command.arg("--tree").arg(root);
        }
        for owner in link_owners {
            command.arg("--link-owner").arg(format!(
                "{}={}",
                owner.source.display(),
                owner.identity
            ));
        }
        let output = command.output().unwrap();
        assert!(output.status.success(), "{:?}", output);
        assert!(output.stderr.is_empty());
        let mut expected = String::new();
        for (index, root) in roots.iter().enumerate() {
            let result = fingerprint(root, false, &[], link_owners).unwrap();
            expected.push_str(&format!(
                "{index} {} {} {}\n",
                result.digest,
                result.resolved_links_digest.as_deref().unwrap_or("-"),
                result.literal_links_digest.as_deref().unwrap_or("-"),
            ));
        }
        assert_eq!(String::from_utf8(output.stdout).unwrap(), expected);
    }
    let output = Command::new(env!("CARGO_BIN_EXE_buck2-fingerprint"))
        .arg(&roots[0])
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!(
            "digest {}\n",
            fingerprint(&roots[0], false, &[], &[]).unwrap().digest
        )
    );
}

#[test]
fn batch_cli_rejects_invalid_requests_without_partial_stdout() {
    let scratch = tempfile::tempdir().unwrap();
    let valid = scratch.path().join("valid");
    fs::create_dir(&valid).unwrap();
    fs::write(valid.join("file"), b"valid").unwrap();
    let missing = scratch.path().join("missing");
    let output = Command::new(env!("CARGO_BIN_EXE_buck2-fingerprint"))
        .arg("--batch")
        .arg("--tree")
        .arg(&valid)
        .arg("--tree")
        .arg(&missing)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!output.stderr.is_empty());
    for arguments in [
        vec!["--batch"],
        vec!["--batch", "--tree"],
        vec!["--batch", "--tree", ".", "--link-owner"],
        vec!["--batch", "--tree", ".", "--link-owner", "invalid"],
        vec!["--batch", "--tree", ".", "--input-roots"],
        vec!["--batch", "--tree", ".", "--dereference"],
        vec!["--batch", "--tree", ".", "--backing-root", "."],
        vec!["--batch", "--tree", ".", "--unexpected"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_buck2-fingerprint"))
            .args(&arguments)
            .output()
            .unwrap();
        assert!(!output.status.success(), "{arguments:?}");
        assert!(output.stdout.is_empty(), "{arguments:?}");
        assert!(!output.stderr.is_empty(), "{arguments:?}");
    }
}
