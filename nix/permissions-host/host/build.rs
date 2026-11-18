use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=gui/HostGUI.swift");
    println!("cargo:rerun-if-env-changed=SWIFTC");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") { return; }
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    let compiler = env::var_os("SWIFTC").unwrap_or_else(|| "swiftc".into());
    let status = Command::new(compiler)
        .args(["-parse-as-library", "-emit-library", "-static", "-module-name", "PermissionsHostGUI"])
        .arg("gui/HostGUI.swift")
        .arg("-o").arg(output.join("libPermissionsHostGUI.a"))
        .status().expect("execute reviewed Swift compiler");
    assert!(status.success(), "Swift GUI library compilation failed");
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=PermissionsHostGUI");
    println!("cargo:rustc-link-search=native=/usr/lib/swift");
    println!("cargo:rustc-link-lib=dylib=swiftCore");
    println!("cargo:rustc-link-lib=dylib=swift_Concurrency");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    println!("cargo:rustc-link-lib=framework=Foundation");
}
