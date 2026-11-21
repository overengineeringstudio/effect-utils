pub fn answer() -> u32 { 42 }
#[cfg(test)] mod tests {
    #[test] fn lib_unit() { assert_eq!(super::answer(), 42); assert_eq!(number::to_string(&42).unwrap(), "42"); }
    #[test] #[ignore] fn lib_ignored() {}
    #[test] fn no_bin_exe_in_unit() { assert!(option_env!("CARGO_BIN_EXE_cargo-test-parity").is_none()); }
}
