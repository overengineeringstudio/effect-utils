// Production compilation must stage declared resources outside this crate.
pub const MESSAGE: &str = include_str!("../../../fixtures/message.txt");
pub const BYTES: &[u8] = include_bytes!("../../assets/blob.bin");
pub fn answer() -> u32 {
    assert_eq!(MESSAGE, "declared fixture\n");
    // Changing even an invalid UTF-8 byte must change the compiled behavior.
    u32::from(BYTES[0]) + u32::from(0xff - BYTES[1])
}
#[cfg(test)] mod tests {
    #[test] fn lib_unit() { assert_eq!(super::answer(), 42); assert_eq!(number::to_string(&42).unwrap(), "42"); }
    #[test] #[ignore] fn lib_ignored() {}
    #[test] fn no_bin_exe_in_unit() {
        assert!(option_env!("CARGO_BIN_EXE_cargo-test-parity").is_none());
        assert!(std::env::var_os("CARGO_BIN_EXE_cargo-test-parity").is_none());
    }
    #[test] fn repository_fixture_include() { assert_eq!(include_str!("../../../fixtures/message.txt"), super::MESSAGE); }
    #[test] fn non_utf8_resource() {
        assert!(std::str::from_utf8(super::BYTES).is_err());
        assert_eq!(super::BYTES, &[42, 0xff, 0, 0x80]);
    }
}
