use buck2_tool_core::{
    is_sha256, normalized_relative, sha256_file, sha256_sri, ToolError, ToolResult,
};
use clap::Args;
use serde_json::{Map, Value};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
use tar::{Archive, EntryType};

const DESCRIPTOR_KEYS: &[&str] = &[
    "artifact",
    "entrypoints",
    "kind",
    "name",
    "normalization",
    "platform",
    "provenance",
    "schemaVersion",
];
pub const MAX_ARCHIVE_MEMBER_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_ARCHIVE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub const MAX_ARCHIVE_MEMBERS: usize = 100_000;
pub const TAR_BLOCK_BYTES: u64 = 512;
pub const TAR_END_MARKER_BYTES: u64 = 2 * TAR_BLOCK_BYTES;

#[derive(Args)]
pub struct StageArgs {
    #[arg(long)]
    pub archive: PathBuf,
    #[arg(long)]
    pub descriptor: PathBuf,
    #[arg(long = "archive-sha256")]
    pub archive_sha256: String,
    #[arg(long = "descriptor-sha256")]
    pub descriptor_sha256: String,
    #[arg(long)]
    pub entrypoint: String,
    #[arg(long = "expected-platform")]
    pub expected_platform: String,
    #[arg(long)]
    pub out: PathBuf,
}

#[derive(Clone, Debug)]
struct Member {
    path: String,
    kind: MemberKind,
    mode: u32,
    link: Option<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MemberKind {
    Directory,
    File,
    Symlink,
}

fn object<'a>(value: &'a Value, field: &str) -> ToolResult<&'a Map<String, Value>> {
    value.as_object().ok_or_else(|| {
        ToolError::new(
            "BUCK2_TOOLCHAIN_DESCRIPTOR",
            format!("{field} must be an object"),
        )
    })
}
fn exact_keys(object: &Map<String, Value>, keys: &[&str]) -> bool {
    object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
}

fn read_descriptor(path: &Path, expected_entrypoint: &str) -> ToolResult<Value> {
    let bytes = fs::read(path).map_err(|error| {
        ToolError::new(
            "BUCK2_TOOLCHAIN_DESCRIPTOR",
            format!("invalid portable toolchain descriptor: {error}"),
        )
    })?;
    let descriptor: Value = serde_json::from_slice(&bytes).map_err(|error| {
        ToolError::new(
            "BUCK2_TOOLCHAIN_DESCRIPTOR",
            format!("invalid portable toolchain descriptor: {error}"),
        )
    })?;
    let root = object(&descriptor, "portable toolchain descriptor")?;
    if !exact_keys(root, DESCRIPTOR_KEYS) {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_DESCRIPTOR",
            "portable toolchain descriptor has an unexpected top-level shape",
        ));
    }
    if descriptor["schemaVersion"] != 1 || descriptor["kind"] != "buck2-portable-toolchain-artifact"
    {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_SCHEMA",
            "unsupported portable toolchain descriptor contract",
        ));
    }
    let entrypoints = descriptor["entrypoints"]
        .as_array()
        .filter(|items| !items.is_empty())
        .ok_or_else(|| {
            ToolError::new(
                "BUCK2_TOOLCHAIN_DESCRIPTOR",
                "portable toolchain descriptor entrypoints must be a non-empty list",
            )
        })?;
    let mut parsed = Vec::new();
    for entrypoint in entrypoints {
        parsed.push(normalized_relative(
            entrypoint.as_str().ok_or_else(|| {
                ToolError::new(
                    "BUCK2_TOOLCHAIN_DESCRIPTOR",
                    "descriptor entrypoint must be a string",
                )
            })?,
            "descriptor entrypoint",
        )?);
    }
    let unique = parsed.iter().collect::<HashSet<_>>();
    if unique.len() != parsed.len() {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_DESCRIPTOR",
            "portable toolchain descriptor entrypoints must be unique",
        ));
    }
    if !parsed.iter().any(|entry| entry == expected_entrypoint) {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_ENTRYPOINT",
            format!("requested entrypoint is absent from descriptor: {expected_entrypoint}"),
        ));
    }
    let artifact = object(
        &descriptor["artifact"],
        "portable toolchain descriptor artifact",
    )?;
    if !exact_keys(artifact, &["digest", "file", "format", "sizeBytes"]) {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_DESCRIPTOR",
            "portable toolchain descriptor artifact has an unexpected shape",
        ));
    }
    let digest = object(
        &descriptor["artifact"]["digest"],
        "portable toolchain descriptor digest",
    )?;
    if !exact_keys(digest, &["algorithm", "sri"])
        || descriptor["artifact"]["digest"]["algorithm"] != "sha256"
    {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_DESCRIPTOR",
            "portable toolchain descriptor requires a sha256 digest",
        ));
    }
    if descriptor["artifact"]["file"] != "artifact.tar" || descriptor["artifact"]["format"] != "tar"
    {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_DESCRIPTOR",
            "portable toolchain descriptor requires artifact.tar in tar format",
        ));
    }
    if descriptor["artifact"]["sizeBytes"]
        .as_u64()
        .filter(|size| *size > 0)
        .is_none()
    {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_DESCRIPTOR",
            "portable toolchain descriptor sizeBytes must be a positive integer",
        ));
    }
    object(
        &descriptor["normalization"],
        "portable toolchain normalization",
    )?;
    object(&descriptor["provenance"], "portable toolchain provenance")?;
    Ok(descriptor)
}

fn validate_descriptor_platform(descriptor: &Value, expected: &str) -> ToolResult<()> {
    if descriptor["platform"] != expected {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_PLATFORM",
            format!(
                "portable toolchain platform mismatch: expected {expected}, got {:?}",
                descriptor["platform"]
            ),
        ));
    }
    Ok(())
}

fn member_path(raw: &Path) -> ToolResult<Option<String>> {
    let mut name = raw
        .to_str()
        .ok_or_else(|| ToolError::new("BUCK2_TOOLCHAIN_PATH", "archive member must be UTF-8"))?;
    while name.starts_with("./") {
        name = &name[2..];
    }
    let name = name.trim_end_matches('/');
    if name.is_empty() || name == "." {
        return Ok(None);
    }
    normalized_relative(name, "archive member").map(Some)
}

fn validate_symlink_target(member_path: &str, target: &str) -> ToolResult<()> {
    if target.is_empty() || target.bytes().any(|byte| byte < 32 || byte == 127) {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_SYMLINK",
            "archive symlink target must be non-empty and contain no control characters",
        ));
    }
    if target.starts_with('/') || target.contains('\\') {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_SYMLINK",
            "archive symlink target must be portable and relative",
        ));
    }
    let components = target.split('/').collect::<Vec<_>>();
    if components
        .iter()
        .any(|component| component.is_empty() || *component == ".")
    {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_SYMLINK",
            "archive symlink target must be normalized",
        ));
    }
    let mut depth = member_path.split('/').count() as isize - 1;
    for component in components {
        if component == ".." {
            depth -= 1
        } else {
            depth += 1
        }
        if depth < 0 {
            return Err(ToolError::new(
                "BUCK2_TOOLCHAIN_SYMLINK",
                format!("archive symlink escapes toolchain root: {member_path} -> {target}"),
            ));
        }
    }
    Ok(())
}

fn is_ancestor(parent: &str, child: &str) -> bool {
    child
        .strip_prefix(parent)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

fn validate_archive(path: &Path) -> ToolResult<Vec<Member>> {
    let file = File::open(path)
        .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_ARCHIVE", error.to_string()))?;
    let mut archive = Archive::new(file);
    let mut members = Vec::new();
    let mut file_paths = Vec::<String>::new();
    let mut directory_paths = HashSet::<String>::new();
    let mut all_paths = HashSet::<String>::new();
    let mut extracted_bytes = 0_u64;
    let mut logical_end = 0_u64;
    let entries = archive.entries().map_err(|error| {
        ToolError::new(
            "BUCK2_TOOLCHAIN_ARCHIVE",
            format!("invalid portable toolchain archive: {error}"),
        )
    })?;
    for entry in entries {
        if members.len() >= MAX_ARCHIVE_MEMBERS {
            return Err(ToolError::new(
                "BUCK2_TOOLCHAIN_LIMIT",
                "archive exceeds member-count limit",
            ));
        }
        let entry = entry.map_err(|error| {
            ToolError::new(
                "BUCK2_TOOLCHAIN_ARCHIVE",
                format!("invalid portable toolchain archive: {error}"),
            )
        })?;
        let raw_path = entry
            .path()
            .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_PATH", error.to_string()))?;
        let Some(path) = member_path(&raw_path)? else {
            continue;
        };
        if !all_paths.insert(path.clone()) {
            return Err(ToolError::new(
                "BUCK2_TOOLCHAIN_COLLISION",
                format!("duplicate archive member: {path}"),
            ));
        }
        let entry_type = entry.header().entry_type();
        reject_sparse_type(entry_type, &path)?;
        let size = entry.size();
        logical_end = logical_end
            .max(entry.raw_file_position() + size.div_ceil(TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES);
        let (kind, link) = if entry_type.is_dir() {
            directory_paths.insert(path.clone());
            (MemberKind::Directory, None)
        } else if entry_type.is_file() {
            account_regular_size(&path, size, &mut extracted_bytes)?;
            file_paths.push(path.clone());
            (MemberKind::File, None)
        } else if entry_type.is_symlink() {
            let target = entry
                .link_name()
                .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_SYMLINK", error.to_string()))?
                .ok_or_else(|| {
                    ToolError::new(
                        "BUCK2_TOOLCHAIN_SYMLINK",
                        "archive symlink target is absent",
                    )
                })?;
            let target = target
                .to_str()
                .ok_or_else(|| {
                    ToolError::new(
                        "BUCK2_TOOLCHAIN_SYMLINK",
                        "archive symlink target must be UTF-8",
                    )
                })?
                .to_owned();
            validate_symlink_target(&path, &target)?;
            file_paths.push(path.clone());
            (MemberKind::Symlink, Some(target))
        } else {
            return Err(ToolError::new(
                "BUCK2_TOOLCHAIN_TYPE",
                format!("unsupported archive member type: {path}"),
            ));
        };
        let mode = entry
            .header()
            .mode()
            .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_ARCHIVE", error.to_string()))?;
        members.push(Member {
            path,
            kind,
            mode,
            link,
        });
    }
    for (index, path) in file_paths.iter().enumerate() {
        if directory_paths.contains(path) {
            return Err(ToolError::new(
                "BUCK2_TOOLCHAIN_COLLISION",
                format!("archive member is both a directory and file-like path: {path}"),
            ));
        }
        for other in file_paths.iter().skip(index + 1) {
            if is_ancestor(path, other) || is_ancestor(other, path) {
                return Err(ToolError::new(
                    "BUCK2_TOOLCHAIN_COLLISION",
                    format!("archive member file/ancestor collision: {path} and {other}"),
                ));
            }
        }
        if directory_paths
            .iter()
            .any(|directory| is_ancestor(path, directory))
        {
            return Err(ToolError::new(
                "BUCK2_TOOLCHAIN_COLLISION",
                format!("archive member file/ancestor collision: {path}"),
            ));
        }
    }
    validate_archive_end(path, logical_end)?;
    Ok(members)
}

fn reject_sparse_type(entry_type: EntryType, path: &str) -> ToolResult<()> {
    if entry_type == EntryType::GNUSparse {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_SPARSE",
            format!("sparse archive member is unsupported: {path}"),
        ));
    }
    Ok(())
}

fn account_regular_size(path: &str, size: u64, extracted_bytes: &mut u64) -> ToolResult<()> {
    if size > MAX_ARCHIVE_MEMBER_BYTES {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_LIMIT",
            format!("archive member exceeds extracted-size limit: {path} ({size} bytes)"),
        ));
    }
    *extracted_bytes = extracted_bytes.checked_add(size).ok_or_else(|| {
        ToolError::new("BUCK2_TOOLCHAIN_LIMIT", "archive extracted-size overflow")
    })?;
    if *extracted_bytes > MAX_ARCHIVE_BYTES {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_LIMIT",
            format!("archive exceeds aggregate extracted-size limit: {extracted_bytes} bytes"),
        ));
    }
    Ok(())
}

fn validate_archive_end(path: &Path, logical_end: u64) -> ToolResult<()> {
    let size = fs::metadata(path)
        .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_ARCHIVE", error.to_string()))?
        .len();
    if !size.is_multiple_of(TAR_BLOCK_BYTES) {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_END",
            "portable toolchain archive size must be block-aligned",
        ));
    }
    if !logical_end.is_multiple_of(TAR_BLOCK_BYTES) {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_END",
            "portable toolchain archive has an invalid physical end marker offset",
        ));
    }
    if size
        .checked_sub(logical_end)
        .filter(|remaining| *remaining >= TAR_END_MARKER_BYTES)
        .is_none()
    {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_END",
            "portable toolchain archive is missing its physical end marker",
        ));
    }
    let mut file = File::open(path)
        .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_ARCHIVE", error.to_string()))?;
    file.seek(SeekFrom::Start(logical_end))
        .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_ARCHIVE", error.to_string()))?;
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_ARCHIVE", error.to_string()))?;
        if read == 0 {
            break;
        }
        if buffer[..read].iter().any(|byte| *byte != 0) {
            return Err(ToolError::new(
                "BUCK2_TOOLCHAIN_END",
                "portable toolchain archive contains nonzero bytes after its physical end marker",
            ));
        }
    }
    Ok(())
}

fn extract_archive(path: &Path, out: &Path, members: &[Member]) -> ToolResult<()> {
    let file = File::open(path)
        .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_ARCHIVE", error.to_string()))?;
    let mut archive = Archive::new(file);
    let mut expected = members.iter();
    for entry in archive
        .entries()
        .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_ARCHIVE", error.to_string()))?
    {
        let mut entry =
            entry.map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_ARCHIVE", error.to_string()))?;
        let raw_path = entry
            .path()
            .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_PATH", error.to_string()))?;
        let Some(path) = member_path(&raw_path)? else {
            continue;
        };
        let member = expected.next().ok_or_else(|| {
            ToolError::new(
                "BUCK2_TOOLCHAIN_ARCHIVE",
                "archive changed between validation and extraction",
            )
        })?;
        if path != member.path {
            return Err(ToolError::new(
                "BUCK2_TOOLCHAIN_ARCHIVE",
                "archive changed between validation and extraction",
            ));
        }
        let destination = out.join(&member.path);
        match member.kind {
            MemberKind::Directory => fs::create_dir_all(&destination)
                .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_IO", error.to_string()))?,
            MemberKind::File => {
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_IO", error.to_string()))?;
                }
                let mut target = File::create(&destination)
                    .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_IO", error.to_string()))?;
                std::io::copy(&mut entry, &mut target)
                    .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_IO", error.to_string()))?;
                set_mode(
                    &destination,
                    if member.mode & 0o100 != 0 {
                        0o555
                    } else {
                        0o444
                    },
                )?;
            }
            MemberKind::Symlink => {
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_IO", error.to_string()))?;
                }
                create_symlink(member.link.as_ref().unwrap(), &destination)?;
            }
        }
    }
    if expected.next().is_some() {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_ARCHIVE",
            "archive changed between validation and extraction",
        ));
    }
    for member in members
        .iter()
        .filter(|member| member.kind == MemberKind::Directory)
        .rev()
    {
        set_mode(&out.join(&member.path), 0o555)?;
    }
    set_mode(out, 0o555)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> ToolResult<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_IO", error.to_string()))
}
#[cfg(not(unix))]
fn set_mode(path: &Path, _mode: u32) -> ToolResult<()> {
    let mut p = fs::metadata(path)
        .map_err(|e| ToolError::new("BUCK2_TOOLCHAIN_IO", e.to_string()))?
        .permissions();
    p.set_readonly(true);
    fs::set_permissions(path, p).map_err(|e| ToolError::new("BUCK2_TOOLCHAIN_IO", e.to_string()))
}
#[cfg(unix)]
fn create_symlink(target: &str, path: &Path) -> ToolResult<()> {
    std::os::unix::fs::symlink(target, path)
        .map_err(|e| ToolError::new("BUCK2_TOOLCHAIN_IO", e.to_string()))
}
#[cfg(not(unix))]
fn create_symlink(_target: &str, _path: &Path) -> ToolResult<()> {
    Err(ToolError::new(
        "BUCK2_TOOLCHAIN_IO",
        "portable toolchain symlinks require Unix",
    ))
}

pub fn stage(args: StageArgs) -> ToolResult<()> {
    if !is_sha256(&args.archive_sha256) || !is_sha256(&args.descriptor_sha256) {
        return Err(ToolError::new(
            "BUCK2_INVALID_DIGEST",
            "sha256 must contain exactly 64 lowercase hexadecimal characters",
        ));
    }
    let entrypoint = normalized_relative(&args.entrypoint, "entrypoint")?;
    let expected_platform = normalized_relative(&args.expected_platform, "expected_platform")?;
    let actual_archive = sha256_file(&args.archive)?;
    let actual_descriptor = sha256_file(&args.descriptor)?;
    if actual_archive != args.archive_sha256 {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_IDENTITY",
            format!(
                "portable toolchain archive identity mismatch: expected {}, got {actual_archive}",
                args.archive_sha256
            ),
        ));
    }
    if actual_descriptor != args.descriptor_sha256 {
        return Err(ToolError::new("BUCK2_TOOLCHAIN_IDENTITY",format!("portable toolchain descriptor identity mismatch: expected {}, got {actual_descriptor}",args.descriptor_sha256)));
    }
    let descriptor = read_descriptor(&args.descriptor, &entrypoint)?;
    validate_descriptor_platform(&descriptor, &expected_platform)?;
    if descriptor["artifact"]["digest"]["sri"] != sha256_sri(&actual_archive)? {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_IDENTITY",
            "portable toolchain descriptor digest does not match the archive",
        ));
    }
    if descriptor["artifact"]["sizeBytes"].as_u64()
        != Some(
            fs::metadata(&args.archive)
                .map_err(|e| ToolError::new("BUCK2_TOOLCHAIN_ARCHIVE", e.to_string()))?
                .len(),
        )
    {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_IDENTITY",
            "portable toolchain descriptor sizeBytes does not match the archive",
        ));
    }
    let members = validate_archive(&args.archive)?;
    fs::create_dir(&args.out).map_err(|e| {
        ToolError::new(
            "BUCK2_TOOLCHAIN_IO",
            format!("could not create output: {e}"),
        )
    })?;
    extract_archive(&args.archive, &args.out, &members)?;
    let executable = args.out.join(&entrypoint);
    if !executable.is_file() || !is_executable(&executable)? {
        return Err(ToolError::new(
            "BUCK2_TOOLCHAIN_ENTRYPOINT",
            format!("portable toolchain entrypoint is not executable: {entrypoint}"),
        ));
    }
    Ok(())
}
#[cfg(unix)]
fn is_executable(path: &Path) -> ToolResult<bool> {
    use std::os::unix::fs::PermissionsExt;
    Ok(fs::metadata(path)
        .map_err(|e| ToolError::new("BUCK2_TOOLCHAIN_IO", e.to_string()))?
        .permissions()
        .mode()
        & 0o111
        != 0)
}
#[cfg(not(unix))]
fn is_executable(_path: &Path) -> ToolResult<bool> {
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tar::{Builder, Header};
    use tempfile::tempdir;
    fn tar_with(entries: Vec<(&str, EntryType, u64)>) -> (tempfile::TempDir, PathBuf) {
        let d = tempdir().unwrap();
        let p = d.path().join("a.tar");
        let f = File::create(&p).unwrap();
        let mut b = Builder::new(f);
        for (name, ty, size) in entries {
            let mut h = Header::new_gnu();
            h.set_entry_type(ty);
            h.set_mode(0o555);
            h.set_size(size);
            h.set_cksum();
            b.append_data(&mut h, name, std::io::repeat(0).take(size))
                .unwrap();
        }
        b.finish().unwrap();
        (d, p)
    }
    #[test]
    fn accepts_normalized_entrypoint() {
        assert_eq!(
            normalized_relative("bin/tool", "entrypoint").unwrap(),
            "bin/tool"
        );
    }
    #[test]
    fn rejects_control_characters() {
        for bad in [
            "bin/tool\0suffix",
            "bin/tool\n",
            "bin/tool\targ",
            "bin/tool\x7f",
        ] {
            assert!(normalized_relative(bad, "entrypoint").is_err());
        }
    }
    #[test]
    fn rejects_non_normalized_paths() {
        for bad in [
            "/bin/tool",
            "bin/../tool",
            "bin//tool",
            "./bin/tool",
            "bin\\tool",
        ] {
            assert!(normalized_relative(bad, "entrypoint").is_err());
        }
    }
    #[test]
    fn accepts_bounded_symlink() {
        validate_symlink_target("bin/tool", "../lib/tool").unwrap();
    }
    #[test]
    fn rejects_escaping_symlink() {
        assert!(validate_symlink_target("bin/tool", "../../outside")
            .unwrap_err()
            .message
            .contains("escapes"));
    }
    #[test]
    fn accepts_platform() {
        validate_descriptor_platform(
            &serde_json::json!({"platform":"x86_64-linux"}),
            "x86_64-linux",
        )
        .unwrap();
    }
    #[test]
    fn rejects_platform() {
        assert!(validate_descriptor_platform(
            &serde_json::json!({"platform":"x86_64-linux"}),
            "aarch64-darwin"
        )
        .unwrap_err()
        .message
        .contains("platform mismatch"));
    }
    #[test]
    fn rejects_oversized_member() {
        assert!(
            account_regular_size("oversized", MAX_ARCHIVE_MEMBER_BYTES + 1, &mut 0)
                .unwrap_err()
                .message
                .contains("extracted-size limit")
        );
    }
    #[test]
    fn rejects_aggregate_size() {
        let mut total = MAX_ARCHIVE_BYTES;
        assert!(account_regular_size("last", 1, &mut total)
            .unwrap_err()
            .message
            .contains("aggregate extracted-size limit"));
    }
    #[test]
    fn rejects_sparse_member() {
        let error = reject_sparse_type(EntryType::GNUSparse, "sparse").unwrap_err();
        assert!(error.message.contains("sparse archive member"), "{error}");
    }
    #[test]
    fn rejects_nonzero_after_end() {
        let (_d, p) = tar_with(vec![("bin/tool", EntryType::Regular, 1)]);
        let mut f = fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"EVIL").unwrap();
        f.write_all(&vec![0; 508]).unwrap();
        assert!(validate_archive(&p)
            .unwrap_err()
            .message
            .contains("physical end marker"));
    }
    #[test]
    fn accepts_zero_end() {
        let (_d, p) = tar_with(vec![("bin/tool", EntryType::Regular, 1)]);
        validate_archive(&p).unwrap();
    }
    #[test]
    fn rejects_non_aligned() {
        let (_d, p) = tar_with(vec![("bin/tool", EntryType::Regular, 1)]);
        fs::OpenOptions::new()
            .append(true)
            .open(&p)
            .unwrap()
            .write_all(&[0])
            .unwrap();
        assert!(validate_archive(&p)
            .unwrap_err()
            .message
            .contains("block-aligned"));
    }
}
