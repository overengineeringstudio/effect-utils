# Reindeer fixups

Every reachable Cargo build script is reviewed explicitly. `run = false` means
the published crate builds correctly from its manifest-declared Rust sources
for the currently admitted target without executing that script. A dependency
update must regenerate the graph and re-review this list.
