use base64::{engine::general_purpose::STANDARD, Engine};
use buck2_tool_core::{
    canonical_json, normalized_relative, safe_text, sha256_file, verify_execution_capability,
    ToolError, ToolResult,
};
use clap::{Args, Parser, Subcommand};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Cursor,
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
};
use tar::{Builder, EntryType, Header};
use tempfile::tempdir;
use walkdir::WalkDir;

#[derive(Parser)]
struct Cli {
    #[arg(long)]
    capability_manifest: PathBuf,
    #[command(subcommand)]
    command: CommandKind,
}

#[derive(Subcommand)]
enum CommandKind {
    Check(CheckArgs),
    Bundle(BundleArgs),
}

#[derive(Args)]
struct CommonArgs {
    #[arg(long = "dependency-root")]
    dependency_root: PathBuf,
    #[arg(long = "native-package")]
    native_packages: Vec<String>,
    #[arg(long = "source-label")]
    source_labels: Vec<String>,
    #[arg(long = "source")]
    sources: Vec<PathBuf>,
    #[arg(long = "source-tree-prefix")]
    source_tree_prefixes: Vec<String>,
    #[arg(long = "source-tree")]
    source_trees: Vec<PathBuf>,
}

#[derive(Args)]
struct CheckArgs {
    #[command(flatten)]
    common: CommonArgs,
    #[arg(long)]
    tsgo: PathBuf,
    #[arg(long)]
    tsconfig: String,
    #[arg(long)]
    output: PathBuf,
}

#[derive(Args)]
struct BundleArgs {
    #[command(flatten)]
    common: CommonArgs,
    #[arg(long)]
    bun: PathBuf,
    #[arg(long)]
    patchelf: PathBuf,
    #[arg(long)]
    entry: String,
    #[arg(long = "binary-name")]
    binary_name: String,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    archive: PathBuf,
    #[arg(long)]
    descriptor: PathBuf,
    #[arg(long)]
    target: String,
    #[arg(long)]
    platform: String,
}

fn fail(code: &'static str, message: impl Into<String>) -> ToolError {
    ToolError::new(code, message)
}

fn require_executable(path: &Path, name: &str) -> ToolResult<()> {
    let metadata = fs::metadata(path)
        .map_err(|error| fail("BUCK2_TS_TOOL", format!("{name} is unavailable: {error}")))?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err(fail(
            "BUCK2_TS_TOOL",
            format!("{name} is not executable: {}", path.display()),
        ));
    }
    Ok(())
}

fn pair<'a, T>(
    left: &'a [String],
    right: &'a [T],
    role: &str,
) -> ToolResult<impl Iterator<Item = (&'a String, &'a T)>> {
    if left.len() != right.len() {
        return Err(fail(
            "BUCK2_TS_EDGES",
            format!("{role} labels and artifacts must be paired"),
        ));
    }
    Ok(left.iter().zip(right))
}

fn copy_file(source: &Path, destination: &Path) -> ToolResult<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| fail("BUCK2_TS_STAGE", error.to_string()))?;
    }
    match fs::hard_link(source, destination) {
        Ok(()) => Ok(()),
        Err(_) => fs::copy(source, destination)
            .map(|_| ())
            .map_err(|error| fail("BUCK2_TS_STAGE", error.to_string())),
    }
}

fn copy_tree(source: &Path, destination: &Path, containment_root: &Path) -> ToolResult<()> {
    if !source.is_dir() {
        return Err(fail(
            "BUCK2_TS_STAGE",
            format!("source tree is not a directory: {}", source.display()),
        ));
    }
    for entry in WalkDir::new(source).follow_links(false).into_iter() {
        let entry = entry.map_err(|error| fail("BUCK2_TS_STAGE", error.to_string()))?;
        let relative = entry.path().strip_prefix(source).unwrap();
        if relative.as_os_str().is_empty() {
            fs::create_dir_all(destination)
                .map_err(|error| fail("BUCK2_TS_STAGE", error.to_string()))?;
        } else if entry.file_type().is_dir() {
            fs::create_dir_all(destination.join(relative))
                .map_err(|error| fail("BUCK2_TS_STAGE", error.to_string()))?;
        } else if entry.file_type().is_file() {
            copy_file(entry.path(), &destination.join(relative))?;
        } else if entry.file_type().is_symlink() {
            let target = fs::read_link(entry.path())
                .map_err(|error| fail("BUCK2_TS_STAGE", error.to_string()))?;
            let resolved = fs::canonicalize(entry.path()).map_err(|error| {
                fail(
                    "BUCK2_TS_DEPENDENCY_SYMLINK",
                    format!("dependency symlink is unresolved: {error}"),
                )
            })?;
            let canonical_source = fs::canonicalize(containment_root)
                .map_err(|error| fail("BUCK2_TS_STAGE", error.to_string()))?;
            if !resolved.starts_with(&canonical_source) {
                return Err(fail(
                    "BUCK2_TS_DEPENDENCY_SYMLINK",
                    format!(
                        "dependency symlink escapes its declared closure: {} -> {}",
                        entry.path().display(),
                        target.display()
                    ),
                ));
            }
            let output = destination.join(relative);
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| fail("BUCK2_TS_STAGE", error.to_string()))?;
            }
            symlink(target, output).map_err(|error| fail("BUCK2_TS_STAGE", error.to_string()))?;
        } else {
            return Err(fail(
                "BUCK2_TS_STAGE",
                "dependency tree contains an unsupported node",
            ));
        }
    }
    Ok(())
}

fn stage(common: &CommonArgs, workspace: &Path) -> ToolResult<()> {
    let mut seen = HashSet::new();
    for (label, source) in pair(&common.source_labels, &common.sources, "source")? {
        let label = normalized_relative(label, "source label")?;
        if !seen.insert(label.clone()) {
            return Err(fail(
                "BUCK2_TS_DUPLICATE",
                format!("duplicate staged source: {label}"),
            ));
        }
        copy_file(source, &workspace.join(label))?;
    }
    for (prefix, tree) in pair(
        &common.source_tree_prefixes,
        &common.source_trees,
        "source tree",
    )? {
        let prefix = normalized_relative(prefix, "source tree prefix")?;
        for entry in WalkDir::new(tree)
            .min_depth(1)
            .follow_links(false)
            .into_iter()
        {
            let entry = entry.map_err(|error| fail("BUCK2_TS_STAGE", error.to_string()))?;
            if entry.file_type().is_symlink() {
                return Err(fail(
                    "BUCK2_TS_STAGE",
                    format!(
                        "declared source tree contains a symlink: {}",
                        entry.path().display()
                    ),
                ));
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(tree)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let label = normalized_relative(&format!("{prefix}/{relative}"), "source tree member")?;
            if !seen.insert(label.clone()) {
                return Err(fail(
                    "BUCK2_TS_DUPLICATE",
                    format!("duplicate staged source: {label}"),
                ));
            }
            copy_file(entry.path(), &workspace.join(label))?;
        }
    }
    let modules = common.dependency_root.join("node_modules");
    if !modules.is_dir() {
        return Err(fail("BUCK2_TS_DEPS", "dependency root has no node_modules"));
    }
    copy_tree(
        &modules,
        &workspace.join("node_modules"),
        &common.dependency_root,
    )?;
    let package_layouts = common.dependency_root.join("packages");
    if package_layouts.is_dir() {
        for entry in WalkDir::new(&package_layouts)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if entry.file_type().is_dir() && entry.file_name() == "node_modules" {
                let relative = entry
                    .path()
                    .parent()
                    .unwrap()
                    .strip_prefix(&common.dependency_root)
                    .unwrap();
                copy_tree(
                    entry.path(),
                    &workspace.join(relative).join("node_modules"),
                    &common.dependency_root,
                )?;
            }
        }
    }
    for native in &common.native_packages {
        let (name, source) = native
            .split_once('=')
            .ok_or_else(|| fail("BUCK2_TS_NATIVE", "native package must be NAME=PATH"))?;
        let name = normalized_relative(name, "native package name")?;
        let destination = workspace.join("node_modules").join(name);
        if destination.exists() || destination.is_symlink() {
            if destination.is_dir() && !destination.is_symlink() {
                fs::remove_dir_all(&destination)
            } else {
                fs::remove_file(&destination)
            }
            .map_err(|error| fail("BUCK2_TS_NATIVE", error.to_string()))?;
        }
        let parent = destination.parent().ok_or_else(|| {
            fail("BUCK2_TS_NATIVE", "native package destination has no parent")
        })?;
        fs::create_dir_all(parent)
            .map_err(|error| fail("BUCK2_TS_NATIVE", error.to_string()))?;
        symlink(source, destination).map_err(|error| fail("BUCK2_TS_NATIVE", error.to_string()))?;
    }
    Ok(())
}

fn run_tool(program: &Path, args: &[&str], cwd: &Path, home: &Path) -> ToolResult<()> {
    let status = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("HOME", home)
        .env("PATH", "/nonexistent")
        .env("DEVENV_TASK_PASSTHROUGH", "1")
        .status()
        .map_err(|error| fail("BUCK2_TS_EXEC", error.to_string()))?;
    if !status.success() {
        return Err(fail(
            "BUCK2_TS_EXEC",
            format!("{} exited with {status}", program.display()),
        ));
    }
    Ok(())
}

fn check(args: CheckArgs) -> ToolResult<()> {
    require_executable(&args.tsgo, "tsgo")?;
    let tsconfig = normalized_relative(&args.tsconfig, "tsconfig")?;
    let temp = tempdir().map_err(|error| fail("BUCK2_TS_TEMP", error.to_string()))?;
    let workspace = temp.path().join("workspace");
    fs::create_dir(&workspace).map_err(|error| fail("BUCK2_TS_TEMP", error.to_string()))?;
    stage(&args.common, &workspace)?;
    if !workspace.join(&tsconfig).is_file() {
        return Err(fail(
            "BUCK2_TS_CONFIG",
            "tsconfig is absent from the declared source graph",
        ));
    }
    run_tool(
        &args.tsgo,
        &["--build", &tsconfig, "--force", "--pretty", "false"],
        &workspace,
        &temp.path().join("home"),
    )?;
    if let Some(parent) = args.output.parent() {
        fs::create_dir_all(parent).map_err(|error| fail("BUCK2_TS_OUTPUT", error.to_string()))?;
    }
    fs::write(
        args.output,
        canonical_json(
            &json!({"project":tsconfig,"schema":"effect-utils-buck2-typescript-check/v1"}),
        )?,
    )
    .map_err(|error| fail("BUCK2_TS_OUTPUT", error.to_string()))
}

fn append_tar(
    builder: &mut Builder<fs::File>,
    name: &str,
    bytes: Option<&[u8]>,
    mode: u32,
) -> ToolResult<()> {
    let mut header = Header::new_ustar();
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(1);
    header.set_mode(mode);
    header
        .set_username("")
        .map_err(|error| fail("BUCK2_TS_TAR", error.to_string()))?;
    header
        .set_groupname("")
        .map_err(|error| fail("BUCK2_TS_TAR", error.to_string()))?;
    match bytes {
        None => {
            header.set_entry_type(EntryType::Directory);
            header.set_size(0);
        }
        Some(value) => {
            header.set_entry_type(EntryType::Regular);
            header.set_size(value.len() as u64);
        }
    }
    header.set_cksum();
    builder
        .append_data(&mut header, name, Cursor::new(bytes.unwrap_or_default()))
        .map_err(|error| fail("BUCK2_TS_TAR", error.to_string()))
}

fn input_digest(args: &BundleArgs) -> ToolResult<String> {
    let configuration = json!({
        "binaryName": args.binary_name, "bun": args.bun,
        "dependencyRoot": args.common.dependency_root, "entry": args.entry,
        "nativePackages": args.common.native_packages, "patchelf": args.patchelf,
        "platform": args.platform, "target": args.target,
    });
    let mut inputs =
        pair(&args.common.source_labels, &args.common.sources, "source")?.collect::<Vec<_>>();
    inputs.sort_by_key(|(label, _)| *label);
    let mut records = Vec::new();
    for (label, path) in inputs {
        records.push(json!({
            "digest": sha256_file(path)?,
            "label": normalized_relative(label, "source label")?,
            "sizeBytes": fs::metadata(path).map_err(|error| fail("BUCK2_TS_DIGEST", error.to_string()))?.len(),
        }));
    }
    let mut trees = pair(
        &args.common.source_tree_prefixes,
        &args.common.source_trees,
        "source tree",
    )?
    .collect::<Vec<_>>();
    trees.sort_by_key(|(prefix, _)| *prefix);
    for (prefix, tree) in trees {
        let prefix = normalized_relative(prefix, "source tree prefix")?;
        let mut members = WalkDir::new(tree)
            .min_depth(1)
            .follow_links(false)
            .into_iter()
            .map(|entry| entry.map_err(|error| fail("BUCK2_TS_DIGEST", error.to_string())))
            .collect::<ToolResult<Vec<_>>>()?;
        members.sort_by_key(|entry| entry.path().strip_prefix(tree).unwrap().to_path_buf());
        for entry in members {
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(tree)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let label = normalized_relative(&format!("{prefix}/{relative}"), "source tree member")?;
            records.push(json!({
                "digest": sha256_file(entry.path())?,
                "label": label,
                "sizeBytes": entry.metadata().map_err(|error| fail("BUCK2_TS_DIGEST", error.to_string()))?.len(),
            }));
        }
    }
    let mut digest = Sha256::new();
    digest.update(canonical_json(&json!({
        "configuration": configuration,
        "inputs": records,
        "schema": "buck2-typescript-product-input/v1",
    }))?);
    Ok(format!(
        "sha256:{}",
        digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn bundle(args: BundleArgs) -> ToolResult<()> {
    require_executable(&args.bun, "bun")?;
    require_executable(&args.patchelf, "patchelf")?;
    safe_text(&args.target, "target")?;
    let entry = normalized_relative(&args.entry, "entry")?;
    let binary_name = normalized_relative(&args.binary_name, "binary name")?;
    if binary_name.contains('/') {
        return Err(fail(
            "BUCK2_TS_NAME",
            "binary name must be one path component",
        ));
    }
    let temp = tempdir().map_err(|error| fail("BUCK2_TS_TEMP", error.to_string()))?;
    let workspace = temp.path().join("workspace");
    fs::create_dir(&workspace).map_err(|error| fail("BUCK2_TS_TEMP", error.to_string()))?;
    stage(&args.common, &workspace)?;
    let staged_entry = workspace.join(&entry);
    if !staged_entry.is_file() {
        return Err(fail(
            "BUCK2_TS_ENTRY",
            "entry is absent from the declared source graph",
        ));
    }
    let stable = temp.path().join("out").join(&binary_name);
    fs::create_dir_all(stable.parent().unwrap())
        .map_err(|error| fail("BUCK2_TS_OUTPUT", error.to_string()))?;
    let stable_text = stable
        .to_str()
        .ok_or_else(|| fail("BUCK2_TS_PATH", "temporary output path is not UTF-8"))?;
    let entry_text = staged_entry
        .to_str()
        .ok_or_else(|| fail("BUCK2_TS_PATH", "entry path is not UTF-8"))?;
    run_tool(
        &args.bun,
        &["build", entry_text, "--compile", "--outfile", stable_text],
        &workspace,
        &temp.path().join("home"),
    )?;
    if let Some(parent) = args.output.parent() {
        fs::create_dir_all(parent).map_err(|error| fail("BUCK2_TS_OUTPUT", error.to_string()))?;
    }
    fs::copy(&stable, &args.output).map_err(|error| fail("BUCK2_TS_OUTPUT", error.to_string()))?;
    // patchelf runs with the scratch directory as cwd, while Buck declares the
    // output relative to the project root. Resolve it absolutely first.
    let output_text = fs::canonicalize(&args.output)
        .map_err(|error| fail("BUCK2_TS_OUTPUT", error.to_string()))?
        .to_str()
        .ok_or_else(|| fail("BUCK2_TS_PATH", "output path is not UTF-8"))?
        .to_owned();
    run_tool(
        &args.patchelf,
        &[
            "--set-interpreter",
            "/lib64/ld-linux-x86-64.so.2",
            "--remove-rpath",
            output_text.as_str(),
        ],
        temp.path(),
        &temp.path().join("home"),
    )?;
    fs::set_permissions(&args.output, fs::Permissions::from_mode(0o555))
        .map_err(|error| fail("BUCK2_TS_OUTPUT", error.to_string()))?;
    let binary =
        fs::read(&args.output).map_err(|error| fail("BUCK2_TS_OUTPUT", error.to_string()))?;
    if let Some(parent) = args.archive.parent() {
        fs::create_dir_all(parent).map_err(|error| fail("BUCK2_TS_OUTPUT", error.to_string()))?;
    }
    let file =
        fs::File::create(&args.archive).map_err(|error| fail("BUCK2_TS_TAR", error.to_string()))?;
    let mut builder = Builder::new(file);
    append_tar(&mut builder, "bin", None, 0o555)?;
    append_tar(
        &mut builder,
        &format!("bin/{binary_name}"),
        Some(&binary),
        0o555,
    )?;
    builder
        .finish()
        .map_err(|error| fail("BUCK2_TS_TAR", error.to_string()))?;
    drop(builder);
    let payload_hex = sha256_file(&args.archive)?;
    let payload_bytes = (0..payload_hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&payload_hex[index..index + 2], 16).unwrap())
        .collect::<Vec<_>>();
    let descriptor = json!({
        "entrypoints":[format!("bin/{binary_name}")], "name":binary_name,
        "payload":{"digest":{"algorithm":"sha256","sri":format!("sha256-{}", STANDARD.encode(payload_bytes))},"file":"artifact.tar","format":"tar","sizeBytes":fs::metadata(&args.archive).map_err(|error| fail("BUCK2_TS_OUTPUT", error.to_string()))?.len()},
        "platform":{"abi":"glibc","architecture":"x86_64","os":"linux"},
        "runtime":{
            "elfClass":"ELF64",
            "inspectionContract":"elf-dynamic/v1",
            "interpreter":"/lib64/ld-linux-x86-64.so.2",
            "kind":"elf-dynamic",
            "machine":"x86_64",
            "neededLibraries":["ld-linux-x86-64.so.2","libc.so.6","libdl.so.2","libm.so.6","libpthread.so.0"],
            "rpathPolicy":"empty/v1",
            "symbolVersionFloors":["GLIBC_2.10","GLIBC_2.12","GLIBC_2.14","GLIBC_2.16","GLIBC_2.17","GLIBC_2.2.5","GLIBC_2.3","GLIBC_2.3.2","GLIBC_2.3.4","GLIBC_2.4","GLIBC_2.6","GLIBC_2.7","GLIBC_2.8","GLIBC_2.9"]
        },
        "schema":"buck-build-product/v1",
        "semanticProvenance":{"recipe":input_digest(&args)?,"target":args.target,"toolchain":format!("bun:{};patchelf:{}", args.bun.display(), args.patchelf.display())},
    });
    if let Some(parent) = args.descriptor.parent() {
        fs::create_dir_all(parent).map_err(|error| fail("BUCK2_TS_OUTPUT", error.to_string()))?;
    }
    fs::write(args.descriptor, canonical_json(&descriptor)?)
        .map_err(|error| fail("BUCK2_TS_OUTPUT", error.to_string()))
}

fn main() {
    let cli = Cli::parse();
    let result = verify_execution_capability(
        &cli.capability_manifest,
        "typescript-product",
        "effect-utils/buck2-typescript-product/v1",
        "native-executable/v1",
    )
    .and_then(|()| match cli.command {
        CommandKind::Check(args) => check(args),
        CommandKind::Bundle(args) => bundle(args),
    });
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest_args(root: &Path, labels: Vec<&str>, files: Vec<&str>) -> BundleArgs {
        let dependency_root = root.join("deps");
        fs::create_dir_all(dependency_root.join("node_modules")).unwrap();
        let sources = files
            .iter()
            .enumerate()
            .map(|(index, contents)| {
                let path = root.join(format!("source-{index}"));
                fs::write(&path, contents).unwrap();
                path
            })
            .collect();
        BundleArgs {
            common: CommonArgs {
                dependency_root,
                native_packages: vec![],
                source_labels: labels.into_iter().map(String::from).collect(),
                sources,
                source_tree_prefixes: vec![],
                source_trees: vec![],
            },
            bun: "/nix/store/bun/bin/bun".into(),
            patchelf: "/nix/store/patchelf/bin/patchelf".into(),
            entry: "pkg/main.ts".into(),
            binary_name: "tool".into(),
            output: root.join("tool"),
            archive: root.join("artifact.tar"),
            descriptor: root.join("descriptor.json"),
            target: "//pkg:tool".into(),
            platform: "x86_64-linux".into(),
        }
    }

    #[test]
    fn input_digest_is_injective_across_source_partitions() {
        let first = tempdir().unwrap();
        let second = tempdir().unwrap();
        let partitioned = digest_args(first.path(), vec!["a", "bc"], vec!["b", "d"]);
        let regrouped = digest_args(second.path(), vec!["a"], vec!["b\0bcd"]);
        assert_ne!(input_digest(&partitioned).unwrap(), input_digest(&regrouped).unwrap());
    }

    #[test]
    fn source_edges_reject_duplicate_destinations_before_tool_execution() {
        let temporary = tempdir().unwrap();
        let dependency_root = temporary.path().join("deps");
        fs::create_dir_all(dependency_root.join("node_modules")).unwrap();
        let first = temporary.path().join("first.ts");
        let second = temporary.path().join("second.ts");
        fs::write(&first, "export const first = 1\n").unwrap();
        fs::write(&second, "export const second = 2\n").unwrap();
        let common = CommonArgs {
            dependency_root,
            native_packages: vec![],
            source_labels: vec!["pkg/mod.ts".into(), "pkg/mod.ts".into()],
            sources: vec![first, second],
            source_tree_prefixes: vec![],
            source_trees: vec![],
        };
        let workspace = temporary.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let error = stage(&common, &workspace).unwrap_err();
        assert_eq!(error.code, "BUCK2_TS_DUPLICATE");
    }

    #[test]
    fn deterministic_tar_header_does_not_encode_host_metadata() {
        let temporary = tempdir().unwrap();
        let archive = temporary.path().join("artifact.tar");
        let file = fs::File::create(&archive).unwrap();
        let mut builder = Builder::new(file);
        append_tar(&mut builder, "bin", None, 0o555).unwrap();
        append_tar(&mut builder, "bin/tool", Some(b"payload"), 0o555).unwrap();
        builder.finish().unwrap();
        drop(builder);
        let first = fs::read(&archive).unwrap();

        let file = fs::File::create(&archive).unwrap();
        let mut builder = Builder::new(file);
        append_tar(&mut builder, "bin", None, 0o555).unwrap();
        append_tar(&mut builder, "bin/tool", Some(b"payload"), 0o555).unwrap();
        builder.finish().unwrap();
        drop(builder);
        assert_eq!(first, fs::read(&archive).unwrap());
    }

    #[test]
    fn dependency_symlink_must_stay_inside_declared_closure() {
        let temporary = tempdir().unwrap();
        let closure = temporary.path().join("closure");
        let modules = closure.join("node_modules");
        fs::create_dir_all(&modules).unwrap();
        let external = temporary.path().join("external");
        fs::create_dir(&external).unwrap();
        symlink(&external, modules.join("escape")).unwrap();
        let output = temporary.path().join("output");
        let error = copy_tree(&modules, &output, &closure).unwrap_err();
        assert_eq!(error.code, "BUCK2_TS_DEPENDENCY_SYMLINK");
    }
}
