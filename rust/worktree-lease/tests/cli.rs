#[test]
fn acceptance() {
    assert!(std::process::Command::new("bash")
        .arg("tests/try.sh")
        .env("LEASE", env!("CARGO_BIN_EXE_worktree-lease"))
        .status()
        .unwrap()
        .success());
}
