use base64::{engine::general_purpose::STANDARD, Engine};
use buck2_tool_core::{
    canonical_json, normalized_relative, safe_text, sha256_bytes, sha256_file,
    verify_execution_capability, ToolError, ToolResult,
};
use clap::{Args, Parser, Subcommand};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};
use tar::{Builder, EntryType, Header};
use walkdir::WalkDir;

#[derive(Parser)]
struct Cli {
    #[arg(long)]
    capability_manifest: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Package(Box<PackageArgs>),
    Product(ProductArgs),
}

#[derive(Args)]
struct ProductArgs {
    #[arg(long)]
    binary: PathBuf,
    #[arg(long = "binary-name")]
    binary_name: String,
    #[arg(long)]
    target: String,
    #[arg(long = "toolchain-identity")]
    toolchain_identity: String,
    #[arg(long)]
    archive: PathBuf,
    #[arg(long)]
    descriptor: PathBuf,
}

#[derive(Args)]
struct PackageArgs {
    #[arg(long)]
    name: String,
    #[arg(long = "package-path")]
    package_path: String,
    #[arg(long)]
    kind: String,
    #[arg(long)]
    target: String,
    #[arg(long)]
    platform: String,
    #[arg(long = "closure-label")]
    closure_label: String,
    #[arg(long = "closure-descriptor")]
    closure_descriptor: PathBuf,
    #[arg(long = "source-label")]
    source_labels: Vec<String>,
    #[arg(long = "source")]
    sources: Vec<PathBuf>,
    #[arg(long = "config-label")]
    config_labels: Vec<String>,
    #[arg(long = "config")]
    configs: Vec<PathBuf>,
    #[arg(long = "dep-label")]
    dep_labels: Vec<String>,
    #[arg(long = "dep-artifact")]
    dep_artifacts: Vec<PathBuf>,
    #[arg(long)]
    archive: PathBuf,
    #[arg(long)]
    descriptor: PathBuf,
}

fn nix_name(value: &str, field: &str) -> ToolResult<String> {
    safe_text(value, field)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
    {
        return Err(ToolError::new(
            "BUCK2_NIX_NAME",
            format!("{field} is not accepted by the Nix artifact importer: {value:?}"),
        ));
    }
    Ok(value.to_owned())
}

fn digest_path(path: &Path) -> ToolResult<(&'static str, String)> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        ToolError::new(
            "BUCK2_EVIDENCE_INPUT",
            format!("declared input is unavailable: {error}"),
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(ToolError::new(
            "BUCK2_EVIDENCE_SYMLINK",
            format!(
                "declared input must not be a symlink: {}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ),
        ));
    }
    if metadata.is_file() {
        return Ok(("file", sha256_file(path)?));
    }
    if !metadata.is_dir() {
        return Err(ToolError::new(
            "BUCK2_EVIDENCE_INPUT",
            format!(
                "declared input must be a regular file or directory: {}",
                path.display()
            ),
        ));
    }
    let mut entries = WalkDir::new(path)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .map(|entry| {
            entry.map_err(|error| ToolError::new("BUCK2_EVIDENCE_INPUT", error.to_string()))
        })
        .collect::<ToolResult<Vec<_>>>()?;
    entries.sort_by_key(|entry| {
        entry
            .path()
            .strip_prefix(path)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/")
    });
    let mut records = Vec::new();
    for entry in entries {
        let relative = entry
            .path()
            .strip_prefix(path)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let relative = normalized_relative(&relative, "artifact path")?;
        if entry.file_type().is_symlink() {
            return Err(ToolError::new(
                "BUCK2_EVIDENCE_SYMLINK",
                format!("declared directory input contains a symlink: {relative}"),
            ));
        }
        if entry.file_type().is_dir() {
            records.push(json!({"kind":"directory","path":relative}));
        } else if entry.file_type().is_file() {
            records
                .push(json!({"kind":"file","path":relative,"sha256":sha256_file(entry.path())?}));
        } else {
            return Err(ToolError::new(
                "BUCK2_EVIDENCE_INPUT",
                format!("declared directory input contains a non-regular entry: {relative}"),
            ));
        }
    }
    Ok(("directory", sha256_bytes(&canonical_json(&records)?)))
}

fn input_records(labels: Vec<String>, paths: Vec<PathBuf>, role: &str) -> ToolResult<Vec<Value>> {
    if labels.len() != paths.len() {
        return Err(ToolError::new(
            "BUCK2_EVIDENCE_EDGES",
            format!("each {role} requires both a logical label and an artifact"),
        ));
    }
    let mut seen = HashSet::new();
    let mut records = Vec::new();
    for (label, path) in labels.into_iter().zip(paths) {
        let logical = normalized_relative(&label, &format!("{role} label"))?;
        if !seen.insert(logical.clone()) {
            return Err(ToolError::new(
                "BUCK2_EVIDENCE_DUPLICATE",
                format!("duplicate {role} label: {logical}"),
            ));
        }
        let (kind, digest) = digest_path(&path)?;
        records.push(json!({"artifactKind":kind,"path":logical,"sha256":digest}));
    }
    records.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
    Ok(records)
}

fn dependency_records(labels: Vec<String>, paths: Vec<PathBuf>) -> ToolResult<Vec<Value>> {
    if labels.len() != paths.len() {
        return Err(ToolError::new(
            "BUCK2_EVIDENCE_EDGES",
            "each dependency requires both a target label and an artifact",
        ));
    }
    let mut seen = HashSet::new();
    let mut records = Vec::new();
    for (label, path) in labels.into_iter().zip(paths) {
        safe_text(&label, "dependency label")?;
        if !seen.insert(label.clone()) {
            return Err(ToolError::new(
                "BUCK2_EVIDENCE_DUPLICATE",
                format!("duplicate dependency label: {label}"),
            ));
        }
        let (kind, digest) = digest_path(&path)?;
        records.push(json!({"artifactKind":kind,"label":label,"sha256":digest}));
    }
    records.sort_by(|left, right| left["label"].as_str().cmp(&right["label"].as_str()));
    Ok(records)
}

fn add_member(
    builder: &mut Builder<fs::File>,
    name: &str,
    content: Option<&[u8]>,
    mode: u32,
) -> ToolResult<()> {
    let mut header = Header::new_ustar();
    header.set_mode(mode);
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    header
        .set_username("")
        .map_err(|error| ToolError::new("BUCK2_EVIDENCE_TAR", error.to_string()))?;
    header
        .set_groupname("")
        .map_err(|error| ToolError::new("BUCK2_EVIDENCE_TAR", error.to_string()))?;
    match content {
        None => {
            header.set_entry_type(EntryType::Directory);
            header.set_size(0);
            header.set_cksum();
            builder
                .append_data(&mut header, name, Cursor::new([]))
                .map_err(|error| ToolError::new("BUCK2_EVIDENCE_TAR", error.to_string()))?;
        }
        Some(bytes) => {
            header.set_entry_type(EntryType::Regular);
            header.set_size(bytes.len() as u64);
            header.set_cksum();
            builder
                .append_data(&mut header, name, Cursor::new(bytes))
                .map_err(|error| ToolError::new("BUCK2_EVIDENCE_TAR", error.to_string()))?;
        }
    }
    Ok(())
}

fn package(args: PackageArgs) -> ToolResult<()> {
    let name = nix_name(&args.name, "name")?;
    let package_path = normalized_relative(&args.package_path, "package path")?;
    let kind = safe_text(&args.kind, "kind")?;
    let target = safe_text(&args.target, "target")?;
    let platform = nix_name(&args.platform, "platform")?;
    let closure_label = normalized_relative(&args.closure_label, "closure label")?;
    let closure_bytes = fs::read(&args.closure_descriptor).map_err(|error| {
        ToolError::new(
            "BUCK2_EVIDENCE_CLOSURE",
            format!("closure descriptor must be valid UTF-8 JSON: {error}"),
        )
    })?;
    let closure_value: Value = serde_json::from_slice(&closure_bytes).map_err(|error| {
        ToolError::new(
            "BUCK2_EVIDENCE_CLOSURE",
            format!("closure descriptor must be valid UTF-8 JSON: {error}"),
        )
    })?;
    if !closure_value.is_object() {
        return Err(ToolError::new(
            "BUCK2_EVIDENCE_CLOSURE",
            "closure descriptor root must be an object",
        ));
    }
    let sources = input_records(args.source_labels, args.sources, "source")?;
    let configs = input_records(args.config_labels, args.configs, "config")?;
    let dependencies = dependency_records(args.dep_labels, args.dep_artifacts)?;
    let manifest = json!({"closure":{"path":closure_label,"sha256":sha256_file(&args.closure_descriptor)?},"configs":configs,"dependencies":dependencies,"kind":kind,"packagePath":package_path,"schemaVersion":1,"sources":sources,"target":target});
    let manifest_bytes = canonical_json(&manifest)?;
    let action_digest = sha256_bytes(&manifest_bytes);
    let shell_payload = String::from_utf8(manifest_bytes.clone())
        .unwrap()
        .trim_end_matches('\n')
        .replace('\'', "'\"'\"'");
    let entrypoint = format!("#!/bin/sh\nset -eu\nprintf '%s\\n' '{shell_payload}'\n").into_bytes();
    if let Some(parent) = args.archive.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| ToolError::new("BUCK2_EVIDENCE_IO", error.to_string()))?;
    }
    let archive_file = fs::File::create(&args.archive)
        .map_err(|error| ToolError::new("BUCK2_EVIDENCE_IO", error.to_string()))?;
    let mut builder = Builder::new(archive_file);
    add_member(&mut builder, "bin", None, 0o555)?;
    add_member(
        &mut builder,
        "bin/package-evidence",
        Some(&entrypoint),
        0o555,
    )?;
    add_member(&mut builder, "share", None, 0o555)?;
    add_member(&mut builder, "share/package-evidence", None, 0o555)?;
    add_member(
        &mut builder,
        "share/package-evidence/manifest.json",
        Some(&manifest_bytes),
        0o444,
    )?;
    builder
        .finish()
        .map_err(|error| ToolError::new("BUCK2_EVIDENCE_TAR", error.to_string()))?;
    drop(builder);
    let archive_bytes = fs::read(&args.archive)
        .map_err(|error| ToolError::new("BUCK2_EVIDENCE_IO", error.to_string()))?;
    let descriptor = json!({"artifact":{"digest":{"algorithm":"sha256","sri":format!("sha256-{}",STANDARD.encode(hex_to_bytes(&sha256_bytes(&archive_bytes))))},"file":"artifact.tar","format":"tar","sizeBytes":archive_bytes.len()},"entrypoints":["bin/package-evidence"],"kind":"buck2-package-evidence","name":name,"platform":platform,"provenance":{"actionDigest":format!("sha256:{action_digest}"),"producer":"effect-utils/buck2/package-evidence@1","sourceRevision":"content-addressed","target":target},"schemaVersion":1});
    if let Some(parent) = args.descriptor.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| ToolError::new("BUCK2_EVIDENCE_IO", error.to_string()))?;
    }
    fs::write(&args.descriptor, canonical_json(&descriptor)?)
        .map_err(|error| ToolError::new("BUCK2_EVIDENCE_IO", error.to_string()))?;
    Ok(())
}

fn hex_to_bytes(value: &str) -> Vec<u8> {
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
        .collect()
}

fn product(args: ProductArgs) -> ToolResult<()> {
    let name = nix_name(&args.binary_name, "binary name")?;
    let target = safe_text(&args.target, "target")?;
    let toolchain = safe_text(&args.toolchain_identity, "toolchain identity")?;
    if !toolchain.starts_with("sha256:") || toolchain.len() != 71 {
        return Err(ToolError::new(
            "BUCK2_PRODUCT_TOOLCHAIN",
            "toolchain identity must be a Nix-authored sha256 identity",
        ));
    }
    let binary = fs::read(&args.binary)
        .map_err(|error| ToolError::new("BUCK2_PRODUCT_INPUT", error.to_string()))?;
    let archive_file = fs::File::create(&args.archive)
        .map_err(|error| ToolError::new("BUCK2_PRODUCT_IO", error.to_string()))?;
    let mut builder = Builder::new(archive_file);
    add_member(&mut builder, "bin", None, 0o555)?;
    add_member(&mut builder, &format!("bin/{name}"), Some(&binary), 0o555)?;
    builder
        .finish()
        .map_err(|error| ToolError::new("BUCK2_PRODUCT_TAR", error.to_string()))?;
    drop(builder);
    let archive = fs::read(&args.archive)
        .map_err(|error| ToolError::new("BUCK2_PRODUCT_IO", error.to_string()))?;
    let digest = sha256_bytes(&archive);
    let descriptor = json!({
        "entrypoints": [format!("bin/{name}")],
        "name": name,
        "payload": {
            "digest": {"algorithm": "sha256", "sri": format!("sha256-{}", STANDARD.encode(hex_to_bytes(&digest)))},
            "file": "artifact.tar",
            "format": "tar",
            "sizeBytes": archive.len(),
        },
        "platform": {"abi": "musl", "architecture": "x86_64", "os": "linux"},
        "runtime": {"inspectionContract": "elf-static/v1", "kind": "self-contained"},
        "schema": "buck-build-product/v1",
        "semanticProvenance": {
            "recipe": "rust-static-binary/v1",
            "target": target,
            "toolchain": toolchain,
        },
    });
    let descriptor_bytes = serde_json::to_vec(&descriptor)
        .map_err(|error| ToolError::new("BUCK2_PRODUCT_JSON", error.to_string()))?;
    fs::write(&args.descriptor, descriptor_bytes)
        .map_err(|error| ToolError::new("BUCK2_PRODUCT_IO", error.to_string()))
}

fn run() -> ToolResult<()> {
    let cli = Cli::parse();
    verify_execution_capability(
        &cli.capability_manifest,
        "package-evidence",
        "effect-utils/buck2-package-evidence/v1",
        "native-executable/v1",
    )?;
    match cli.command {
        Command::Package(args) => package(*args),
        Command::Product(args) => product(args),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn args(root: &Path, suffix: &str) -> PackageArgs {
        PackageArgs {
            name: "typescript_inputs".into(),
            package_path: "packages/example".into(),
            kind: "typescript-input-evidence".into(),
            target: "root//packages/example:typescript_inputs".into(),
            platform: "x86_64-linux".into(),
            closure_label: "packages/example/buck2/check.closure.json".into(),
            closure_descriptor: root.join("closure.json"),
            source_labels: vec!["packages/example/src/mod.ts".into()],
            sources: vec![root.join("source.ts")],
            config_labels: vec!["packages/example/tsconfig.json".into()],
            configs: vec![root.join("tsconfig.json")],
            dep_labels: vec![],
            dep_artifacts: vec![],
            archive: root.join(format!("artifact{suffix}.tar")),
            descriptor: root.join(format!("descriptor{suffix}.json")),
        }
    }
    fn fixture() -> tempfile::TempDir {
        let d = tempdir().unwrap();
        fs::write(d.path().join("source.ts"), "export const answer = 42\n").unwrap();
        fs::write(d.path().join("tsconfig.json"), "{}\n").unwrap();
        fs::write(d.path().join("closure.json"), "{\"schemaVersion\":1}\n").unwrap();
        d
    }
    #[test]
    fn accepts_repeatable_buck_rule_flags() {
        let cli = Cli::try_parse_from([
            "buck2-package-evidence",
            "--capability-manifest",
            "manifest.json",
            "package",
            "--name",
            "example",
            "--package-path",
            "packages/example",
            "--kind",
            "example",
            "--target",
            "root//packages/example:example",
            "--platform",
            "x86_64-linux",
            "--closure-label",
            "closure.json",
            "--closure-descriptor",
            "closure.json",
            "--source-label",
            "src/a.ts",
            "--source",
            "a.ts",
            "--source-label",
            "src/b.ts",
            "--source",
            "b.ts",
            "--config-label",
            "tsconfig.json",
            "--config",
            "tsconfig.json",
            "--archive",
            "artifact.tar",
            "--descriptor",
            "descriptor.json",
        ])
        .unwrap();
        let Command::Package(args) = cli.command else {
            panic!("expected package command")
        };
        assert_eq!(args.sources, [PathBuf::from("a.ts"), PathBuf::from("b.ts")]);
        assert_eq!(args.configs, [PathBuf::from("tsconfig.json")]);
    }
    #[test]
    fn deterministic_and_shaped() {
        let d = fixture();
        package(args(d.path(), "-one")).unwrap();
        package(args(d.path(), "-two")).unwrap();
        assert_eq!(
            fs::read(d.path().join("artifact-one.tar")).unwrap(),
            fs::read(d.path().join("artifact-two.tar")).unwrap()
        );
        assert_eq!(
            fs::read(d.path().join("descriptor-one.json")).unwrap(),
            fs::read(d.path().join("descriptor-two.json")).unwrap()
        );
        let v: Value =
            serde_json::from_slice(&fs::read(d.path().join("descriptor-one.json")).unwrap())
                .unwrap();
        assert_eq!(v["kind"], "buck2-package-evidence");
        assert_eq!(v["entrypoints"], json!(["bin/package-evidence"]));
    }
    #[test]
    fn archive_is_sanitized() {
        let d = fixture();
        package(args(d.path(), "")).unwrap();
        let bytes = fs::read(d.path().join("artifact.tar")).unwrap();
        assert!(!bytes
            .windows(d.path().as_os_str().len())
            .any(|window| window == d.path().to_string_lossy().as_bytes()));
        let mut ar = tar::Archive::new(Cursor::new(&bytes));
        let names = ar
            .entries()
            .unwrap()
            .map(|e| e.unwrap().path().unwrap().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                "bin",
                "bin/package-evidence",
                "share",
                "share/package-evidence",
                "share/package-evidence/manifest.json"
            ]
        );
    }
    #[test]
    fn rejects_traversal_before_outputs() {
        let d = fixture();
        let mut a = args(d.path(), "");
        a.package_path = "../private".into();
        let error = package(a).unwrap_err();
        assert!(error.message.contains("normalized relative path"));
        assert!(!d.path().join("artifact.tar").exists());
    }
    #[test]
    fn rejects_control_characters_in_scanned_artifact_paths() {
        for byte in (1_u8..=31).chain(std::iter::once(127)) {
            let d = tempfile::tempdir().unwrap();
            let artifact = d.path().join("artifact");
            fs::create_dir(&artifact).unwrap();
            fs::write(
                artifact.join(format!("entry{}name", char::from(byte))),
                "content",
            )
            .unwrap();

            let error = digest_path(&artifact).unwrap_err();
            assert_eq!(error.code, "BUCK2_INVALID_PATH", "accepted byte {byte}");
        }
    }
    #[test]
    fn content_change_changes_artifact() {
        let d = fixture();
        package(args(d.path(), "-before")).unwrap();
        let before = fs::read(d.path().join("artifact-before.tar")).unwrap();
        fs::write(d.path().join("source.ts"), "export const answer = 43\n").unwrap();
        package(args(d.path(), "-after")).unwrap();
        assert_ne!(
            before,
            fs::read(d.path().join("artifact-after.tar")).unwrap()
        );
    }
}
