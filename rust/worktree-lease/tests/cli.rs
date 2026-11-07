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
