//! Regenerates the adapter's prost bindings from the vendored Buck2 protos
//! (Buck2 be6971d47dcc835b7356e1698b23039ffee4f4c2, matching nix/buck2.nix
//! 2026-09-01). Bump procedure: replace ../*.proto, rerun, commit both.
use std::path::Path;

fn main() {
    let generator = Path::new(env!("CARGO_MANIFEST_DIR"));
    let proto_dir = generator.parent().expect("proto directory");
    let out_dir = proto_dir.parent().expect("crate directory").join("src/gen");
    let files = [
        "data.proto",
        "error.proto",
        "host_sharing.proto",
        "subscription.proto",
        "daemon.proto",
    ];
    let fds = protox::compile(files, [proto_dir]).expect("compile pinned Buck2 protos");
    prost_build::Config::new()
        .out_dir(&out_dir)
        .compile_fds(fds)
        .expect("generate prost bindings");
}
