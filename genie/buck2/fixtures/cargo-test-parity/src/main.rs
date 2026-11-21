fn main() { println!("{}", cargo_test_parity::answer()); }
#[test] fn bin_unit() { assert_eq!(cargo_test_parity::answer(), 42); }
#[test] fn no_bin_exe_in_unit() { assert!(option_env!("CARGO_BIN_EXE_cargo-test-parity").is_none()); }
