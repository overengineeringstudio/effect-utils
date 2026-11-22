mod common;
#[test] fn declared_binary() {
    let binary = env!("CARGO_BIN_EXE_cargo-test-parity");
    assert!(std::path::Path::new(binary).is_absolute());
    let output = std::process::Command::new(binary).output().unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"42\n");
    assert_eq!(common::fixture(), "declared fixture\n");
}

#[test]
fn runtime_paths_survive_changed_cwd() {
    let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let binary = std::path::PathBuf::from(std::env::var_os("CARGO_BIN_EXE_cargo-test-parity").unwrap());
    assert!(manifest.is_absolute() && manifest.is_dir());
    assert!(binary.is_absolute() && binary.is_file());
    if let Some(directory) = std::env::var_os("PARITY_RUNTIME_PATH_CHILD") {
        // Only this one-test child changes its process cwd; parallel tests are unaffected.
        std::env::set_current_dir(directory).unwrap();
        assert_ne!(std::env::current_dir().unwrap(), manifest);
        let output = std::process::Command::new(&binary).output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"42\n");
        assert_eq!(std::fs::read_to_string(manifest.join("../../fixtures/message.txt")).unwrap(), "declared fixture\n");
        println!("RUNTIME_CARGO_PATHS_ABSOLUTE_AND_RELOCATABLE=1");
        return;
    }
    let directory = std::env::temp_dir().join(format!("cargo-parity-cwd-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "runtime_paths_survive_changed_cwd", "--nocapture"])
        .env("PARITY_RUNTIME_PATH_CHILD", &directory)
        .output().unwrap();
    std::fs::remove_dir(&directory).unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("RUNTIME_CARGO_PATHS_ABSOLUTE_AND_RELOCATABLE=1"), "{stdout}");
    print!("{stdout}");
}
