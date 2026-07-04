//! node-cpuprofile adapter: side-artifact capture (decision 0017). Injects the V8
//! `--cpu-prof` flags via `NODE_OPTIONS` into a temp dir, then discovers and
//! validates the emitted `.cpuprofile` as a profile artifact. Its human stdout is
//! captured AND streamed live; it emits no structured records of its own.

use std::io;
use std::path::Path;

use super::{AdapterPrep, ToolAdapter};
use crate::{
    hash_path_identity, ArtifactError, ChildRun, DiscoveredProfileArtifacts, ProfileArtifactInput,
    RunConfig, StdoutMode,
};

pub(crate) struct NodeCpuProfileAdapter;

impl ToolAdapter for NodeCpuProfileAdapter {
    fn name(&self) -> &'static str {
        "node-cpuprofile"
    }

    fn stdout_mode(&self, _nested: bool) -> StdoutMode {
        // node-cpuprofile emits a side-artifact (the profile) while its human
        // stdout stays readable, so it is captured AND streamed live.
        StdoutMode::TeeLive
    }

    fn parse(
        &self,
        _source: &[u8],
        _ownership: crate::AdapterStdoutOwnership,
    ) -> (Vec<crate::AdapterOutput>, Option<String>) {
        // node-cpuprofile has no structured stdout source; its value is the
        // profile artifact, appended by `adapter_outputs` from the discovered
        // artifacts. It never parses records of its own.
        (Vec::new(), None)
    }

    fn prepare(&self, config: &RunConfig) -> io::Result<AdapterPrep> {
        // Only a direct `node` child honors `--cpu-prof`; anything else degrades
        // (discovery then reports "child command is not node").
        if !is_node_command(config.argv.first().map(String::as_str)) {
            return Ok(AdapterPrep::default());
        }
        let root = std::env::temp_dir().join(format!(
            "otel-scrape-node-cpuprofile-{}-{}",
            std::process::id(),
            crate::random_hex(8)?
        ));
        std::fs::create_dir_all(&root)?;
        let node_options =
            node_options_with_cpu_profile(std::env::var("NODE_OPTIONS").ok().as_deref(), &root);
        Ok(AdapterPrep {
            env: vec![(String::from("NODE_OPTIONS"), node_options)],
            node_profile_dir: Some(root),
            ..AdapterPrep::default()
        })
    }

    fn discover_artifacts(&self, child: &ChildRun) -> DiscoveredProfileArtifacts {
        let Some(profile_dir) = child.node_profile_dir.as_ref() else {
            return DiscoveredProfileArtifacts {
                artifacts: Vec::new(),
                errors: vec![ArtifactError {
                    profile_type: Some(String::from("cpuprofile")),
                    path_hash: None,
                    message: String::from(
                        "node-cpuprofile adapter degraded: child command is not node",
                    ),
                }],
            };
        };

        let mut profile_paths = match std::fs::read_dir(profile_dir) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("cpuprofile"))
                .collect::<Vec<_>>(),
            Err(cause) => {
                return DiscoveredProfileArtifacts {
                    artifacts: Vec::new(),
                    errors: vec![ArtifactError {
                        profile_type: Some(String::from("cpuprofile")),
                        path_hash: Some(hash_path_identity(&profile_dir.to_string_lossy())),
                        message: format!("node-cpuprofile adapter degraded: failed to read profile directory: {cause}"),
                    }],
                };
            }
        };
        profile_paths.sort();

        if profile_paths.is_empty() {
            return DiscoveredProfileArtifacts {
                artifacts: Vec::new(),
                errors: vec![ArtifactError {
                    profile_type: Some(String::from("cpuprofile")),
                    path_hash: Some(hash_path_identity(&profile_dir.to_string_lossy())),
                    message: String::from(
                        "node-cpuprofile adapter degraded: no .cpuprofile file produced",
                    ),
                }],
            };
        }

        let mut artifacts = Vec::new();
        let mut errors = Vec::new();
        if profile_paths.len() > 1 {
            errors.push(ArtifactError {
                profile_type: Some(String::from("cpuprofile")),
                path_hash: Some(hash_path_identity(&profile_dir.to_string_lossy())),
                message: format!(
                    "node-cpuprofile adapter degraded: expected one .cpuprofile file, found {}",
                    profile_paths.len()
                ),
            });
        }

        for path in profile_paths {
            match validate_cpuprofile_file(&path) {
                Ok(()) => artifacts.push(ProfileArtifactInput {
                    profile_type: String::from("cpuprofile"),
                    path,
                }),
                Err(cause) => errors.push(ArtifactError {
                    profile_type: Some(String::from("cpuprofile")),
                    path_hash: Some(hash_path_identity(&path.to_string_lossy())),
                    message: format!(
                        "node-cpuprofile adapter degraded: malformed profile JSON: {cause}"
                    ),
                }),
            }
        }

        DiscoveredProfileArtifacts { artifacts, errors }
    }

    fn cleanup_artifacts(&self, child: &ChildRun) {
        if let Some(profile_dir) = child.node_profile_dir.as_ref() {
            let _ = std::fs::remove_dir_all(profile_dir);
        }
    }
}

fn is_node_command(argv0: Option<&str>) -> bool {
    let Some(argv0) = argv0 else {
        return false;
    };
    matches!(
        Path::new(argv0).file_name().and_then(|name| name.to_str()),
        Some("node" | "node.exe")
    )
}

pub(crate) fn node_options_with_cpu_profile(existing: Option<&str>, profile_dir: &Path) -> String {
    let profile_dir = profile_dir.to_string_lossy();
    let profile_options = [
        String::from("--cpu-prof"),
        format!("--cpu-prof-dir={profile_dir}"),
        String::from("--cpu-prof-name=CPU.cpuprofile"),
    ];
    match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(existing) => format!("{existing} {}", profile_options.join(" ")),
        None => profile_options.join(" "),
    }
}

fn validate_cpuprofile_file(path: &Path) -> io::Result<()> {
    let bytes = std::fs::read(path)?;
    validate_cpuprofile_bytes(&bytes)
}

fn validate_cpuprofile_bytes(bytes: &[u8]) -> io::Result<()> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|cause| {
        io::Error::new(io::ErrorKind::InvalidData, format!("invalid JSON: {cause}"))
    })?;
    let is_valid = value.as_object().is_some_and(|object| {
        object
            .get("nodes")
            .and_then(|value| value.as_array())
            .is_some()
            && object
                .get("samples")
                .and_then(|value| value.as_array())
                .is_some()
    });
    if is_valid {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected V8 cpuprofile object with nodes and samples",
        ))
    }
}
