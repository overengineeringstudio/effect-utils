mod common;
#[test] fn manifest_fixture() { assert_eq!(common::fixture(), "declared fixture\n"); }
#[test] fn renamed_dev_dependency() { assert_eq!(number::to_string(&42).unwrap(), "42"); }
#[test] fn dev_dependency() { fn serializable<T: serde::Serialize>() {} serializable::<u32>(); }
#[test] #[ignore] fn integration_ignored() {}
#[test] fn repository_fixture_include() { assert_eq!(include_str!("../../../fixtures/message.txt"), common::fixture()); }
#[test] fn undeclared_neighbor_inventory() {
    // The driver asserts present for Cargo and absent in Buck's staged tree.
    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    println!("PARITY_UNDECLARED_NEIGHBOR_PRESENT={}", manifest.join("../../fixtures/undeclared.txt").exists());
}
