use buck2_tool_core::fingerprint::{fingerprint, LinkOwner};
use std::fs;
use std::os::unix::fs::symlink;
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
        LinkOwner { source: source.clone(), identity: "source".into() },
        LinkOwner { source: backing.clone(), identity: "backing".into() },
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
    symlink("../parity-backing/external.txt", relocated.join("cross-root")).unwrap();
    assert_eq!(plain.digest, fingerprint(&relocated, false, &[], &[
        LinkOwner { source: PathBuf::from(&relocated), identity: "source".into() },
        owners[1].clone(),
    ]).unwrap().digest);
}
