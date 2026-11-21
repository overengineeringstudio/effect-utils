mod common;
#[test] fn manifest_fixture() { assert_eq!(common::fixture(), "declared fixture\n"); }
#[test] fn renamed_dev_dependency() { assert_eq!(number::to_string(&42).unwrap(), "42"); }
#[test] fn dev_dependency() { fn serializable<T: serde::Serialize>() {} serializable::<u32>(); }
#[test] #[ignore] fn integration_ignored() {}
