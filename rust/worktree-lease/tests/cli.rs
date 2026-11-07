#[test]
fn acceptance() {
    let output = std::process::Command::new("bash")
        .arg("tests/await.sh")
        .env("LEASE", env!("CARGO_BIN_EXE_worktree-lease"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let record: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(record["_tag"], "Granted");
    assert_eq!(record["job"], "test-job");
    assert!(record["warning"].is_string());
}
#[test]
#[cfg(target_os = "linux")]
fn reaper() {
    let output = std::process::Command::new("python3")
        .arg("tests/reap.py")
        .env("LEASE", env!("CARGO_BIN_EXE_worktree-lease"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
}
#[test]
fn inherited() {
    let output = std::process::Command::new("python3")
        .arg("tests/inherited.py")
        .env("LEASE", env!("CARGO_BIN_EXE_worktree-lease"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
}

#[test]
fn service_actors() {
    let output = std::process::Command::new("python3")
        .arg("tests/actors.py")
        .env("LEASE", env!("CARGO_BIN_EXE_worktree-lease"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
}

#[test]
#[cfg(target_os = "linux")]
fn compatibility() {
    use std::{
        fs,
        os::unix::fs::{symlink, PermissionsExt},
    };
    let package = tempfile::tempdir().unwrap();
    let bin = package.path().join("bin");
    let imports = package.path().join("share/worktree-lease");
    fs::create_dir_all(&bin).unwrap();
    fs::create_dir_all(&imports).unwrap();
    symlink(
        env!("CARGO_BIN_EXE_worktree-lease"),
        bin.join("worktree-lease"),
    )
    .unwrap();
    for module in ["gate_worktree_lease.py", "reclaim_worktree_guard.py"] {
        fs::copy(
            std::path::Path::new("compat").join(module),
            imports.join(module),
        )
        .unwrap();
    }
    for (entry, function) in [
        ("gate-lease-write", "writer_main"),
        ("reclaim-worktree-guard", "guard_main"),
    ] {
        let executable = bin.join(entry);
        fs::write(&executable, format!(
            "#!/usr/bin/env python3\nimport sys\nfrom pathlib import Path\nsys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'share/worktree-lease'))\nfrom gate_worktree_lease import {function}\nsys.exit({function}())\n"
        )).unwrap();
        fs::set_permissions(executable, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let output = std::process::Command::new("python3")
        .arg("tests/compat.py")
        .env("LEASE_PACKAGE", package.path())
        .env_remove("WORKTREE_LEASE_BIN")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
}
