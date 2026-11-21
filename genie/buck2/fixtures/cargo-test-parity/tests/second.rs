mod common;
#[test] fn declared_binary() {
    let binary = env!("CARGO_BIN_EXE_cargo-test-parity");
    assert!(std::path::Path::new(binary).is_absolute());
    let output = std::process::Command::new(binary).output().unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"42\n");
    assert_eq!(common::fixture(), "declared fixture\n");
}
