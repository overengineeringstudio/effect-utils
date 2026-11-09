//! Packages the adapter's declared, normalized compilation-input directory.
use super::*;

#[derive(Args)]
pub(crate) struct LibraryArgs {
    #[arg(long)]
    directory: PathBuf,
    #[arg(long)]
    metadata: PathBuf,
    #[arg(long)]
    artifact: PathBuf,
    #[arg(long)]
    descriptor: PathBuf,
    #[arg(long)]
    name: String,
    #[arg(long)]
    target: String,
    #[arg(long)]
    platform_os: String,
    #[arg(long)]
    platform_architecture: String,
    #[arg(long)]
    platform_abi: String,
    #[arg(long)]
    provenance: PathBuf,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Metadata {
    crate_name: String,
    target_triple: String,
    host_triple: String,
    panic_strategy: String,
    rustc: Compiler,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Compiler {
    verbose_version: String,
    compiler_store_path: String,
    sysroot: String,
    darwin_wrapper_evidence: String,
}

fn input(error: impl std::fmt::Display) -> ToolError {
    fail("BUCK2_PRODUCT_LIBRARY", error.to_string())
}

fn store_output(path: &str) -> bool {
    let Some((hash, name)) = path
        .strip_prefix("/nix/store/")
        .and_then(|p| p.split_once('-'))
    else {
        return false;
    };
    hash.len() == 32
        && hash
            .bytes()
            .all(|c| b"0123456789abcdfghijklmnpqrsvwxyz".contains(&c))
        && !name.is_empty()
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"+._?=-".contains(&c))
}

fn compiler_metadata(metadata: &Metadata) -> ToolResult<()> {
    let Some((arch, suffix)) = metadata.host_triple.split_once('-') else {
        return Err(input("unsupported compiler host triple"));
    };
    if !matches!(arch, "x86_64" | "aarch64")
        || !matches!(
            suffix,
            "unknown-linux-gnu" | "unknown-linux-musl" | "apple-darwin"
        )
    {
        return Err(input("unsupported compiler host triple"));
    }
    let compiler = &metadata.rustc;
    if !store_output(&compiler.compiler_store_path) || !store_output(&compiler.sysroot) {
        return Err(input(
            "compilerStorePath/sysroot must be canonical store output paths",
        ));
    }
    let wrapper = &compiler.darwin_wrapper_evidence;
    if !wrapper.is_empty()
        && (suffix != "apple-darwin"
            || !wrapper.strip_suffix("/bin/rustc").is_some_and(store_output))
    {
        return Err(input("invalid Darwin wrapper evidence"));
    }
    let version = &compiler.verbose_version;
    if version.contains('\r') || !version.ends_with('\n') || version.ends_with("\n\n") {
        return Err(input(
            "verboseVersion must use LF and exactly one final newline",
        ));
    }
    for prefix in [
        "rustc ",
        "release: ",
        "commit-hash: ",
        "commit-date: ",
        "host: ",
        "LLVM version: ",
    ] {
        let mut fields = version
            .lines()
            .filter_map(|line| line.strip_prefix(prefix))
            .filter(|v| !v.is_empty());
        let first = fields.next();
        if first.is_none()
            || fields.next().is_some()
            || (prefix == "host: " && first != Some(metadata.host_triple.as_str()))
        {
            return Err(input(format!(
                "verboseVersion has missing, duplicate or inconsistent {prefix}evidence"
            )));
        }
    }
    Ok(())
}

fn files(directory: &Path, host: &str) -> ToolResult<BTreeMap<String, Vec<u8>>> {
    if !fs::symlink_metadata(directory).map_err(input)?.is_dir() {
        return Err(input("library directory must be a non-symlink directory"));
    }
    let mut files = BTreeMap::new();
    for entry in fs::read_dir(directory).map_err(input)? {
        let entry = entry.map_err(input)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| input("non-UTF8 artifact"))?;
        normalized_relative(&name, "library artifact").map_err(input)?;
        let extension = Path::new(&name)
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("");
        if name.contains('/')
            || !entry.file_type().map_err(input)?.is_file()
            || !matches!(extension, "rlib" | "rmeta")
                && !(extension == "so"
                    && (host.ends_with("-linux-gnu") || host.ends_with("-linux-musl")))
                && !(extension == "dylib" && host.ends_with("-apple-darwin"))
        {
            return Err(input(format!("unsupported library artifact: {name}")));
        }
        files.insert(
            format!("lib/{name}"),
            fs::read(entry.path()).map_err(input)?,
        );
    }
    Ok(files)
}

pub(crate) fn package(args: LibraryArgs) -> ToolResult<()> {
    validate_name(&args.name)?;
    safe_text(&args.target, "target")?;
    let decoded: Metadata =
        serde_json::from_slice(&fs::read(&args.metadata).map_err(input)?).map_err(input)?;
    compiler_metadata(&decoded)?;
    let mut characters = decoded.crate_name.chars();
    if !characters
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        || !characters.all(|c| c.is_ascii_alphanumeric() || c == '_')
        || !matches!(decoded.panic_strategy.as_str(), "unwind" | "abort")
    {
        return Err(input("invalid crate name or panic strategy"));
    }
    let suffix = match (args.platform_os.as_str(), args.platform_abi.as_str()) {
        ("linux", "glibc") => "unknown-linux-gnu",
        ("linux", "musl") => "unknown-linux-musl",
        ("darwin", "darwin") => "apple-darwin",
        _ => return Err(input("unsupported library platform")),
    };
    if !matches!(args.platform_architecture.as_str(), "x86_64" | "aarch64")
        || decoded.target_triple != format!("{}-{suffix}", args.platform_architecture)
    {
        return Err(input("library target triple does not match platform"));
    }
    let primary = format!("lib/lib{}.rlib", decoded.crate_name);
    let files = files(&args.directory, &decoded.host_triple)?;
    let mut metadata = serde_json::to_value(decoded).map_err(input)?;
    if !files.contains_key(&primary) {
        return Err(input(format!("missing primary: {primary}")));
    }
    let artifacts = files
        .iter()
        .map(|(path, bytes)| {
            let role = if path.ends_with(".rlib") {
                "rlib"
            } else if path.ends_with(".rmeta") {
                "rmeta"
            } else {
                "proc-macro"
            };
            json!({"path": path, "role": role, "sha256": sha256_bytes(bytes)})
        })
        .collect::<Vec<_>>();
    let library = metadata
        .as_object_mut()
        .ok_or_else(|| input("metadata must be an object"))?;
    library.insert("language".into(), json!("rust"));
    library.insert("primary".into(), json!(primary));
    library.insert("dependencyDirectory".into(), json!("lib"));
    library.insert("artifacts".into(), json!(artifacts));
    let provenance: Provenance =
        serde_json::from_slice(&fs::read(&args.provenance).map_err(input)?).map_err(input)?;
    if provenance.schema != "buck-build-provenance/v1" {
        return Err(input("unsupported provenance schema"));
    }
    safe_text(&provenance.recipe, "recipe")?;
    safe_text(&provenance.toolchain, "toolchain")?;
    let artifact = archive_tree(files, &[])?;
    let descriptor = json!({
        "schema": "buck-rust-library-product/v1", "kind": "library", "name": args.name,
        "payload": {"file": "artifact.tar", "format": "tar", "sizeBytes": artifact.len(),
            "digest": {"algorithm": "sha256", "sri": sha256_sri(&sha256_bytes(&artifact))?}},
        "platform": {"os": args.platform_os, "architecture": args.platform_architecture, "abi": args.platform_abi},
        "library": metadata,
        "semanticProvenance": {"target": args.target, "recipe": provenance.recipe, "toolchain": provenance.toolchain},
    });
    fs::write(args.artifact, artifact).map_err(input)?;
    fs::write(args.descriptor, canonical_json(&descriptor)?).map_err(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn flat_inventory_and_archive_are_sorted_and_deterministic() {
        let root = tempdir().unwrap();
        for name in [
            "libsame-b.rlib",
            "libroot.rlib",
            "libsame-a.rlib",
            "libroot.rmeta",
            "libderive-a.so",
        ] {
            fs::write(root.path().join(name), name).unwrap();
        }
        let first = files(root.path(), "x86_64-unknown-linux-gnu").unwrap();
        assert_eq!(first.len(), 5);
        let bytes = archive_tree(first, &[]).unwrap();
        assert_eq!(
            bytes,
            archive_tree(files(root.path(), "x86_64-unknown-linux-gnu").unwrap(), &[]).unwrap()
        );
        fs::write(root.path().join("native.a"), "unsupported").unwrap();
        assert!(files(root.path(), "x86_64-unknown-linux-gnu").is_err());
    }

    #[test]
    fn packages_primary_metadata_and_exact_inventory() {
        let root = tempdir().unwrap();
        let directory = root.path().join("lib");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("libroot.rlib"), b"primary").unwrap();
        fs::write(directory.join("libdep-a.rlib"), b"dependency").unwrap();
        let metadata = root.path().join("metadata.json");
        fs::write(&metadata, br#"{"crateName":"root","targetTriple":"x86_64-unknown-linux-gnu","hostTriple":"x86_64-unknown-linux-gnu","panicStrategy":"unwind","rustc":{"verboseVersion":"rustc 1.90.0 (fixture 2025-09-18)\nbinary: rustc\ncommit-hash: fixture\ncommit-date: 2025-09-18\nhost: x86_64-unknown-linux-gnu\nrelease: 1.90.0\nLLVM version: 20.1.8\n","compilerStorePath":"/nix/store/00000000000000000000000000000000-rustc","sysroot":"/nix/store/00000000000000000000000000000000-rustc","darwinWrapperEvidence":""}}"#).unwrap();
        let provenance = root.path().join("provenance.json");
        fs::write(
            &provenance,
            br#"{"schema":"buck-build-provenance/v1","recipe":"fixture/v1","toolchain":"fixture"}"#,
        )
        .unwrap();
        let artifact = root.path().join("artifact.tar");
        let descriptor = root.path().join("descriptor.json");
        let args = || LibraryArgs {
            directory: directory.clone(),
            metadata: metadata.clone(),
            artifact: artifact.clone(),
            descriptor: descriptor.clone(),
            name: "fixture".into(),
            target: "//fixture:product".into(),
            platform_os: "linux".into(),
            platform_architecture: "x86_64".into(),
            platform_abi: "glibc".into(),
            provenance: provenance.clone(),
        };
        package(args()).unwrap();
        let first = fs::read(&artifact).unwrap();
        let json: Value = serde_json::from_slice(&fs::read(&descriptor).unwrap()).unwrap();
        assert_eq!(json["schema"], "buck-rust-library-product/v1");
        assert_eq!(json["library"]["primary"], "lib/libroot.rlib");
        assert_eq!(
            json["library"]["artifacts"][0]["sha256"],
            sha256_bytes(b"dependency")
        );
        assert_eq!(
            json["payload"]["digest"]["sri"],
            sha256_sri(&sha256_bytes(&first)).unwrap()
        );
        let descriptor_bytes = fs::read(&descriptor).unwrap();
        package(args()).unwrap();
        assert_eq!(first, fs::read(&artifact).unwrap());
        assert_eq!(descriptor_bytes, fs::read(&descriptor).unwrap());
        let mut members = tar::Archive::new(first.as_slice());
        let paths = members
            .entries()
            .unwrap()
            .map(|entry| entry.unwrap().path().unwrap().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            [
                PathBuf::from("lib"),
                PathBuf::from("lib/libdep-a.rlib"),
                PathBuf::from("lib/libroot.rlib")
            ]
        );
        let original: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
        for (field, value) in [
            ("hostTriple", json!("unsupported-host")),
            (
                "compilerStorePath",
                json!("/nix/store/not-a-canonical-output"),
            ),
            (
                "sysroot",
                json!("/nix/store/00000000000000000000000000000000-rustc/lib"),
            ),
            ("verboseVersion", json!("rustc incomplete\n")),
            (
                "verboseVersion",
                json!(original["rustc"]["verboseVersion"]
                    .as_str()
                    .unwrap()
                    .replace("host: x86_64", "host: aarch64")),
            ),
            (
                "verboseVersion",
                json!(format!(
                    "{}\n",
                    original["rustc"]["verboseVersion"].as_str().unwrap()
                )),
            ),
            (
                "darwinWrapperEvidence",
                json!("/nix/store/00000000000000000000000000000000-rustc/bin/rustc"),
            ),
        ] {
            let mut invalid = original.clone();
            if field == "hostTriple" {
                invalid[field] = value;
            } else {
                invalid["rustc"][field] = value;
            }
            fs::write(&metadata, serde_json::to_vec(&invalid).unwrap()).unwrap();
            assert!(package(args()).is_err(), "{field}");
        }
        fs::write(&metadata, serde_json::to_vec(&original).unwrap()).unwrap();
        fs::remove_file(directory.join("libroot.rlib")).unwrap();
        assert!(package(args()).is_err());
    }
}
