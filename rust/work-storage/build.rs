//! Stage the normative package-owned resources for both Cargo and Buck rustc.
use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let package =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").ok_or("missing CARGO_MANIFEST_DIR")?)
            .join("../../packages/@overeng/work-storage");
    let output = PathBuf::from(env::var_os("OUT_DIR").ok_or("missing OUT_DIR")?);
    for (source, destination) in [
        ("protocol.schema.json", "protocol.schema.json"),
        ("fixtures/conformance.json", "conformance.json"),
    ] {
        let source = package.join(source);
        println!("cargo:rerun-if-changed={}", source.display());
        fs::copy(source, output.join(destination))?;
    }
    Ok(())
}
