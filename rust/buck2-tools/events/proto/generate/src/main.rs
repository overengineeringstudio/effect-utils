//! Regenerates the adapter's prost bindings from the vendored Buck2 protos
//! (Buck2 be6971d47dcc835b7356e1698b23039ffee4f4c2, matching nix/buck2.nix
//! 2026-09-01). Bump procedure: replace ../*.proto, rerun, commit both.
//!
//! `--check` generates into a scratch directory and fails unless it matches
//! the committed `src/gen` byte for byte, file set included.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    process::ExitCode,
};

fn generate(out_dir: &Path) {
    let generator = Path::new(env!("CARGO_MANIFEST_DIR"));
    let proto_dir = generator.parent().expect("proto directory");
    let files = [
        "data.proto",
        "error.proto",
        "host_sharing.proto",
        "subscription.proto",
        "daemon.proto",
    ];
    let fds = protox::compile(files, [proto_dir]).expect("compile pinned Buck2 protos");
    prost_build::Config::new()
        .out_dir(out_dir)
        .compile_fds(fds)
        .expect("generate prost bindings");
}

fn contents(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fs::read_dir(dir)
        .expect("read generated directory")
        .map(|entry| {
            let entry = entry.expect("directory entry");
            (
                entry.file_name().to_string_lossy().into_owned(),
                fs::read(entry.path()).expect("read generated file"),
            )
        })
        .collect()
}

fn main() -> ExitCode {
    let committed = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/gen");
    if std::env::args().nth(1).as_deref() != Some("--check") {
        generate(&committed);
        return ExitCode::SUCCESS;
    }
    let scratch = std::env::temp_dir().join(format!("buck2-events-proto-{}", std::process::id()));
    fs::create_dir_all(&scratch).expect("create scratch directory");
    generate(&scratch);
    let (expected, actual) = (contents(&scratch), contents(&committed));
    fs::remove_dir_all(&scratch).expect("remove scratch directory");
    let stale: BTreeSet<_> = expected
        .keys()
        .chain(actual.keys())
        .filter(|name| expected.get(*name) != actual.get(*name))
        .collect();
    if stale.is_empty() {
        return ExitCode::SUCCESS;
    }
    eprintln!(
        "rust/buck2-tools/events/src/gen is stale ({stale:?}); regenerate with \
         `cargo run --manifest-path rust/buck2-tools/events/proto/generate/Cargo.toml`"
    );
    ExitCode::FAILURE
}
