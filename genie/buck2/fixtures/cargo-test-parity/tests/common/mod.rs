pub fn fixture() -> String {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    assert_eq!(std::env::current_dir().unwrap().canonicalize().unwrap(), manifest.canonicalize().unwrap());
    assert_eq!(std::env::var("CARGO_MANIFEST_DIR").unwrap(), manifest.to_str().unwrap());
    std::fs::read_to_string(manifest.join("fixtures/message.txt")).unwrap()
}
