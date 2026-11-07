use std::{env, path::PathBuf, process::Command};
fn main() {
    println!("cargo:rerun-if-changed=src/Onboarding.swift");
    println!("cargo:rerun-if-env-changed=SWIFTC");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") { return; }
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    let library = out.join("libpermissions_onboarding.dylib");
    let status = Command::new(env::var_os("SWIFTC").unwrap_or_else(|| "swiftc".into()))
        .args(["-emit-library", "-module-name", "PermissionsOnboarding", "-parse-as-library", "src/Onboarding.swift", "-o"])
        .arg(&library)
        .args(["-no-toolchain-stdlib-rpath", "-Xlinker", "-rpath", "-Xlinker", "/usr/lib/swift",
            "-Xlinker", "-install_name", "-Xlinker", "@rpath/libpermissions_onboarding.dylib", "-Xlinker", "-no_adhoc_codesign"])
        .status().expect("Swift compiler is required for the native onboarding panel");
    assert!(status.success(), "Swift onboarding compilation failed");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=dylib=permissions_onboarding");
    // Sealed apps resolve only their own Frameworks and Apple's Swift runtime.
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../lib");
}
