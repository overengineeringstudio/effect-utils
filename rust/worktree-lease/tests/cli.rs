#[test]
fn acceptance() {
    let output = std::process::Command::new("bash")
        .arg("tests/await.sh")
        .env("LEASE", env!("CARGO_BIN_EXE_worktree-lease"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
}
