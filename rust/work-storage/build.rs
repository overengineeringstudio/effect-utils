//! Stage the crate-local generated resources for both Cargo and Buck rustc.
use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let resources =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").ok_or("missing CARGO_MANIFEST_DIR")?)
            .join("resources");
    let output = PathBuf::from(env::var_os("OUT_DIR").ok_or("missing OUT_DIR")?);
    for name in ["protocol.schema.json", "conformance.json"] {
        let source = resources.join(name);
        println!("cargo:rerun-if-changed={}", source.display());
        fs::copy(source, output.join(name))?;
    }
    Ok(())
}
