use buck2_tool_core::{
    is_sha256, normalized_relative, pretty_json, sha256_file, ToolError, ToolResult,
};
use clap::{Args, Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::PathBuf};

const RESERVED_METADATA_PATH: &str = "closure-manifest.json";

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Stage(StageArgs),
    Probe(ProbeArgs),
}

#[derive(Args)]
struct StageArgs {
    #[arg(long)] manifest: PathBuf,
    #[arg(long)] out: PathBuf,
    #[arg(long = "package-id")] package_ids: Vec<String>,
    #[arg(long = "projection-path")] projection_paths: Vec<String>,
    #[arg(long = "sha256")] sha256s: Vec<String>,
    #[arg(long = "artifact")] artifacts: Vec<PathBuf>,
}

#[derive(Args)]
struct ProbeArgs {
    #[arg(long)] tree: PathBuf,
    #[arg(long)] source: PathBuf,
    #[arg(long)] out: PathBuf,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Package {
    id: String,
    projection_path: String,
    sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    packages: Vec<Package>,
    schema_version: u64,
}

fn read_manifest(path: &std::path::Path) -> ToolResult<Vec<Package>> {
    let bytes = fs::read(path).map_err(|error| ToolError::new("BUCK2_CLOSURE_IO", format!("invalid closure manifest: {error}")))?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|error| {
        ToolError::new("BUCK2_CLOSURE_MANIFEST", format!("invalid closure manifest: {error}"))
    })?;
    if manifest.schema_version != 1 {
        return Err(ToolError::new(
            "BUCK2_CLOSURE_SCHEMA",
            format!("unsupported closure manifest schemaVersion: {}", manifest.schema_version),
        ));
    }
    let mut prior_id: Option<&str> = None;
    let mut paths = Vec::<String>::new();
    let mut seen = HashSet::new();
    for (index, package) in manifest.packages.iter().enumerate() {
        if package.id.is_empty() {
            return Err(ToolError::new("BUCK2_CLOSURE_ID", format!("package entry {index} id must be a non-empty string")));
        }
        if prior_id.is_some_and(|prior| package.id.as_str() <= prior) {
            return Err(ToolError::new("BUCK2_CLOSURE_ORDER", "closure manifest package ids must be unique and strictly increasing"));
        }
        normalized_relative(&package.projection_path, "projectionPath")?;
        if package.projection_path == RESERVED_METADATA_PATH
            || package.projection_path.starts_with(&format!("{RESERVED_METADATA_PATH}/"))
        {
            return Err(ToolError::new("BUCK2_CLOSURE_RESERVED", format!("projectionPath collides with reserved metadata path: {}", package.projection_path)));
        }
        if !seen.insert(package.projection_path.clone()) {
            return Err(ToolError::new("BUCK2_CLOSURE_DUPLICATE", format!("duplicate projectionPath: {}", package.projection_path)));
        }
        if let Some(prior) = paths.iter().find(|prior| is_ancestor(prior, &package.projection_path) || is_ancestor(&package.projection_path, prior)) {
            return Err(ToolError::new("BUCK2_CLOSURE_COLLISION", format!("projectionPath file/ancestor collision: {prior} and {}", package.projection_path)));
        }
        if !is_sha256(&package.sha256) {
            return Err(ToolError::new("BUCK2_INVALID_DIGEST", "sha256 must contain exactly 64 lowercase hexadecimal characters"));
        }
        paths.push(package.projection_path.clone());
        prior_id = Some(&package.id);
    }
    Ok(manifest.packages)
}

fn is_ancestor(parent: &str, child: &str) -> bool {
    child.strip_prefix(parent).is_some_and(|suffix| suffix.starts_with('/'))
}

fn stage(args: StageArgs) -> ToolResult<()> {
    let widths = [args.package_ids.len(), args.projection_paths.len(), args.sha256s.len(), args.artifacts.len()];
    if widths.iter().any(|width| *width != widths[0]) {
        return Err(ToolError::new("BUCK2_CLOSURE_EDGES", "each package requires id, projection path, sha256, and artifact"));
    }
    let declared = args.package_ids.into_iter().zip(args.projection_paths).zip(args.sha256s).zip(args.artifacts)
        .map(|(((id, projection_path), sha256), artifact)| {
            normalized_relative(&projection_path, "projectionPath")?;
            if !is_sha256(&sha256) { return Err(ToolError::new("BUCK2_INVALID_DIGEST", "sha256 must contain exactly 64 lowercase hexadecimal characters")); }
            Ok((Package { id, projection_path, sha256 }, artifact))
        }).collect::<ToolResult<Vec<_>>>()?;
    let manifest = read_manifest(&args.manifest)?;
    let contract = declared.iter().map(|(package, _)| package.clone()).collect::<Vec<_>>();
    if manifest != contract {
        return Err(ToolError::new("BUCK2_CLOSURE_EDGES", format!("manifest packages do not exactly match declared Buck package edges\nmanifest={}\ndeclared={}", serde_json::to_string(&manifest).unwrap(), serde_json::to_string(&contract).unwrap())));
    }
    fs::create_dir(&args.out).map_err(|error| ToolError::new("BUCK2_CLOSURE_OUT", format!("could not create output: {error}")))?;
    for (package, artifact) in &declared {
        if !artifact.is_file() || artifact.is_symlink() {
            return Err(ToolError::new("BUCK2_CLOSURE_ARTIFACT", format!("package artifact must be a regular file: {}", artifact.display())));
        }
        let actual = sha256_file(artifact)?;
        if actual != package.sha256 {
            return Err(ToolError::new("BUCK2_CLOSURE_DIGEST", format!("package digest mismatch for {}: expected {}, got {actual}", package.id, package.sha256)));
        }
        let destination = args.out.join(&package.projection_path);
        if let Some(parent) = destination.parent() { fs::create_dir_all(parent).map_err(|error| ToolError::new("BUCK2_CLOSURE_IO", error.to_string()))?; }
        fs::copy(artifact, &destination).map_err(|error| ToolError::new("BUCK2_CLOSURE_IO", error.to_string()))?;
    }
    let canonical = Manifest { packages: manifest, schema_version: 1 };
    fs::write(args.out.join(RESERVED_METADATA_PATH), pretty_json(&canonical)?).map_err(|error| ToolError::new("BUCK2_CLOSURE_IO", error.to_string()))?;
    make_tree_read_only(&args.out)?;
    Ok(())
}

fn probe(args: ProbeArgs) -> ToolResult<()> {
    let manifest = read_manifest(&args.tree.join(RESERVED_METADATA_PATH))?;
    let mut packages = Vec::new();
    for package in manifest {
        let actual = sha256_file(&args.tree.join(&package.projection_path))?;
        if actual != package.sha256 {
            return Err(ToolError::new("BUCK2_CLOSURE_DIGEST", format!("staged package digest mismatch for {}", package.id)));
        }
        packages.push(serde_json::json!({"id": package.id, "sha256": actual}));
    }
    let evidence = serde_json::json!({"packages": packages, "schemaVersion": 1, "sourceSha256": sha256_file(&args.source)?});
    fs::write(args.out, pretty_json(&evidence)?).map_err(|error| ToolError::new("BUCK2_CLOSURE_IO", error.to_string()))?;
    Ok(())
}

fn make_tree_read_only(root: &std::path::Path) -> ToolResult<()> {
    fn visit(path: &std::path::Path) -> ToolResult<()> {
        for entry in fs::read_dir(path).map_err(|error| ToolError::new("BUCK2_CLOSURE_IO", error.to_string()))? {
            let entry = entry.map_err(|error| ToolError::new("BUCK2_CLOSURE_IO", error.to_string()))?;
            let ty = entry.file_type().map_err(|error| ToolError::new("BUCK2_CLOSURE_IO", error.to_string()))?;
            if ty.is_dir() { visit(&entry.path())?; }
            set_mode(&entry.path(), if ty.is_dir() { 0o555 } else { 0o444 })?;
        }
        Ok(())
    }
    visit(root)
}

#[cfg(unix)]
fn set_mode(path: &std::path::Path, mode: u32) -> ToolResult<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|error| ToolError::new("BUCK2_CLOSURE_IO", error.to_string()))
}
#[cfg(not(unix))]
fn set_mode(path: &std::path::Path, _mode: u32) -> ToolResult<()> {
    let mut permissions = fs::metadata(path).map_err(|error| ToolError::new("BUCK2_CLOSURE_IO", error.to_string()))?.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions).map_err(|error| ToolError::new("BUCK2_CLOSURE_IO", error.to_string()))
}

fn run() -> ToolResult<()> {
    match Cli::parse().command { Command::Stage(args) => stage(args), Command::Probe(args) => probe(args) }
}

fn main() {
    if let Err(error) = run() { eprintln!("{error}"); std::process::exit(1); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn manifest(value: serde_json::Value) -> (tempfile::TempDir, PathBuf) {
        let directory = tempdir().unwrap();
        let path = directory.path().join("manifest.json");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        (directory, path)
    }
    #[test] fn accepts_strict_shape() { let (_d,p)=manifest(serde_json::json!({"packages":[{"id":"a","projectionPath":"a","sha256":"0".repeat(64)}],"schemaVersion":1})); assert_eq!(read_manifest(&p).unwrap()[0].id,"a"); }
    #[test] fn rejects_excess_fields() { let (_d,p)=manifest(serde_json::json!({"packages":[],"schemaVersion":1,"unexpected":true})); assert!(read_manifest(&p).unwrap_err().message.contains("unknown field")); }
    #[test] fn rejects_noncanonical_order() { let (_d,p)=manifest(serde_json::json!({"packages":[{"id":"z","projectionPath":"z","sha256":"0".repeat(64)},{"id":"a","projectionPath":"a","sha256":"0".repeat(64)}],"schemaVersion":1})); assert!(read_manifest(&p).unwrap_err().message.contains("strictly increasing")); }
    #[test] fn rejects_path_traversal() { let (_d,p)=manifest(serde_json::json!({"packages":[{"id":"a","projectionPath":"../a","sha256":"0".repeat(64)}],"schemaVersion":1})); assert!(read_manifest(&p).unwrap_err().message.contains("traverse")); }
    #[test] fn rejects_reserved_manifest_path() { let (_d,p)=manifest(serde_json::json!({"packages":[{"id":"a","projectionPath":"closure-manifest.json","sha256":"0".repeat(64)}],"schemaVersion":1})); assert!(read_manifest(&p).unwrap_err().message.contains("reserved")); }
    #[test] fn rejects_reserved_manifest_ancestor() { let (_d,p)=manifest(serde_json::json!({"packages":[{"id":"a","projectionPath":"closure-manifest.json/payload","sha256":"0".repeat(64)}],"schemaVersion":1})); assert!(read_manifest(&p).unwrap_err().message.contains("reserved")); }
    #[test] fn rejects_file_ancestor_collision() { let (_d,p)=manifest(serde_json::json!({"packages":[{"id":"a","projectionPath":"x","sha256":"0".repeat(64)},{"id":"b","projectionPath":"x/y","sha256":"0".repeat(64)}],"schemaVersion":1})); assert!(read_manifest(&p).unwrap_err().message.contains("file/ancestor collision")); }
}
