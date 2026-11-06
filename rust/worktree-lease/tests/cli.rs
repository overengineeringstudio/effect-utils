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
