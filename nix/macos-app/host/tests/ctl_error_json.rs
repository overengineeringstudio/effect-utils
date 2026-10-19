use std::process::Command;

#[test]
fn validation_failure_reports_actual_exit_status() {
    let output = Command::new(env!("CARGO_BIN_EXE_macos-app-ctl"))
        .output()
        .expect("Run macos-app-ctl");
    assert_eq!(output.status.code(), Some(64));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .expect("Failure stdout is a JSON envelope");
    assert_eq!(value["ok"], false);
    assert_eq!(value["error"]["kind"], "invalid-input");
    assert_eq!(value["error"]["exitCode"], output.status.code().unwrap());
}
