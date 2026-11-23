pub fn fixture() -> String {
    // Runtime env!("CARGO_MANIFEST_DIR") is unsupported/gated: use std::env::var.
    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    assert_eq!(std::env::current_dir().unwrap().canonicalize().unwrap(), manifest.canonicalize().unwrap());
    assert!(manifest.ends_with("crates/app"));
    let script = std::process::Command::new(manifest.join("../../ancestor-script.sh")).output().unwrap();
    assert!(script.status.success());
    assert_eq!(script.stdout, b"declared ancestor runtime\n");
    assert_eq!(std::fs::read_to_string(manifest.join("../../fixtures/generated.txt")).unwrap(), "generated resource\n");
    std::fs::read_to_string(manifest.join("../../fixtures/message.txt")).unwrap()
}
