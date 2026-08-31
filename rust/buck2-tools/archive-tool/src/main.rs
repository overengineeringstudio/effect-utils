use buck2_tool_core::{normalized_relative, verify_execution_capability, ToolError, ToolResult};
use clap::{Args, Parser, Subcommand};
use flate2::read::GzDecoder;
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read},
    os::unix::fs::{symlink, PermissionsExt},
    path::{Component, Path, PathBuf},
};
use tar::Archive;

const PROTOCOL: &str = "effect-utils/buck2-archive-tool/v2";

#[derive(Parser)]
struct Cli {
    #[arg(long)]
    capability_manifest: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    ExtractCrate(ExtractCrateArgs),
    ExtractNpm(ExtractNpmArgs),
}

#[derive(Args)]
struct ExtractCrateArgs {
    #[arg(long)]
    archive: PathBuf,
    #[arg(long)]
    out: PathBuf,
    #[arg(long)]
    strip_prefix: String,
}

#[derive(Args)]
struct ExtractNpmArgs {
    #[arg(long)]
    archive: PathBuf,
    #[arg(long)]
    out: PathBuf,
    #[arg(long, default_value = "package")]
    strip_prefix: String,
    #[arg(long = "patch")]
    patches: Vec<PathBuf>,
}

fn fail(code: &'static str, message: impl Into<String>) -> ToolError {
    ToolError::new(code, message)
}

fn normalize_symlink_target(parent: &Path, target: &Path) -> ToolResult<PathBuf> {
    if target.is_absolute() {
        return Err(fail(
            "BUCK2_ARCHIVE_LINK",
            format!("archive symlink target is absolute: {}", target.display()),
        ));
    }
    let target_text = target.to_str().ok_or_else(|| {
        fail(
            "BUCK2_ARCHIVE_LINK",
            "archive symlink target is not UTF-8",
        )
    })?;
    if target_text.contains('\\') || target_text.bytes().any(|byte| byte < 32 || byte == 127) {
        return Err(fail(
            "BUCK2_ARCHIVE_LINK",
            format!("archive symlink target is not portable: {target_text:?}"),
        ));
    }
    let mut normalized = parent.to_path_buf();
    for component in target.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => normalized.push(value),
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(fail(
                        "BUCK2_ARCHIVE_LINK",
                        format!("archive symlink target escapes package root: {}", target.display()),
                    ));
                }
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(fail(
                    "BUCK2_ARCHIVE_LINK",
                    format!("archive symlink target is not portable: {}", target.display()),
                ));
            }
        }
    }
    Ok(normalized)
}

fn extract_prefixed_archive(
    archive_path: &Path,
    out: &Path,
    strip_prefix: &str,
    archive_kind: &str,
    allow_symlinks: bool,
) -> ToolResult<()> {
    let strip_prefix = normalized_relative(strip_prefix, "stripPrefix")?;
    let strip_prefix = Path::new(&strip_prefix);
    fs::create_dir(out).map_err(|error| {
        fail(
            "BUCK2_ARCHIVE_OUTPUT",
            format!("could not create output directory: {error}"),
        )
    })?;

    let source = File::open(archive_path).map_err(|error| {
        fail(
            "BUCK2_ARCHIVE_INPUT",
            format!("could not open {archive_kind} archive: {error}"),
        )
    })?;
    let mut archive = Archive::new(GzDecoder::new(source));
    archive.set_preserve_permissions(false);
    let entries = archive.entries().map_err(|error| {
        fail(
            "BUCK2_ARCHIVE_FORMAT",
            format!("could not read {archive_kind} archive: {error}"),
        )
    })?;
    let mut seen = HashSet::new();
    let mut symlinks = Vec::new();
    let mut extracted = 0_usize;

    for entry in entries {
        let mut entry = entry.map_err(|error| {
            fail(
                "BUCK2_ARCHIVE_FORMAT",
                format!("could not read {archive_kind} entry: {error}"),
            )
        })?;
        let path = entry
            .path()
            .map_err(|error| {
                fail(
                    "BUCK2_ARCHIVE_PATH",
                    format!("invalid {archive_kind} entry path: {error}"),
                )
            })?
            .into_owned();
        let relative = path.strip_prefix(strip_prefix).map_err(|_| {
            fail(
                "BUCK2_ARCHIVE_PREFIX",
                format!(
                    "{archive_kind} entry is outside required prefix {}: {}",
                    strip_prefix.display(),
                    path.display()
                ),
            )
        })?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        if !relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        {
            return Err(fail(
                "BUCK2_ARCHIVE_PATH",
                format!("{archive_kind} entry path is not normalized: {}", path.display()),
            ));
        }
        let relative_text = relative.to_str().ok_or_else(|| {
            fail(
                "BUCK2_ARCHIVE_PATH",
                format!("{archive_kind} entry path is not UTF-8"),
            )
        })?;
        if relative_text.contains('\\')
            || relative_text.bytes().any(|byte| byte < 32 || byte == 127)
        {
            return Err(fail(
                "BUCK2_ARCHIVE_PATH",
                format!("{archive_kind} entry path is not portable: {relative_text:?}"),
            ));
        }
        let destination = out.join(relative);
        if !seen.insert(relative.to_path_buf()) {
            let kind = entry.header().entry_type();
            let identical = if kind.is_dir() {
                destination.is_dir()
            } else if kind.is_file() {
                let archive_mode = entry.header().mode().map_err(|error| {
                    fail(
                        "BUCK2_ARCHIVE_FORMAT",
                        format!("could not read {archive_kind} entry mode: {error}"),
                    )
                })?;
                let expected_mode = if archive_mode & 0o111 == 0 { 0o644 } else { 0o755 };
                let metadata = fs::symlink_metadata(&destination).map_err(|error| {
                    fail(
                        "BUCK2_ARCHIVE_DUPLICATE",
                        format!("could not inspect duplicate {archive_kind} entry: {error}"),
                    )
                })?;
                if !metadata.is_file()
                    || metadata.len() != entry.size()
                    || metadata.permissions().mode() & 0o777 != expected_mode
                {
                    false
                } else {
                    let mut existing = File::open(&destination).map_err(|error| {
                        fail(
                            "BUCK2_ARCHIVE_DUPLICATE",
                            format!("could not read duplicate {archive_kind} entry: {error}"),
                        )
                    })?;
                    let mut remaining = entry.size();
                    let mut archive_bytes = [0_u8; 8192];
                    let mut existing_bytes = [0_u8; 8192];
                    let mut equal = true;
                    while remaining > 0 {
                        let length = usize::try_from(remaining.min(archive_bytes.len() as u64))
                            .expect("bounded duplicate comparison length");
                        entry.read_exact(&mut archive_bytes[..length]).map_err(|error| {
                            fail(
                                "BUCK2_ARCHIVE_DUPLICATE",
                                format!("could not read duplicate {archive_kind} entry: {error}"),
                            )
                        })?;
                        existing
                            .read_exact(&mut existing_bytes[..length])
                            .map_err(|error| {
                                fail(
                                    "BUCK2_ARCHIVE_DUPLICATE",
                                    format!(
                                        "could not read extracted duplicate {archive_kind} entry: {error}"
                                    ),
                                )
                            })?;
                        equal &= archive_bytes[..length] == existing_bytes[..length];
                        remaining -= length as u64;
                    }
                    equal
                }
            } else if allow_symlinks && kind.is_symlink() {
                let target = entry.link_name().map_err(|error| {
                    fail(
                        "BUCK2_ARCHIVE_LINK",
                        format!("could not read duplicate archive symlink target: {error}"),
                    )
                })?;
                match target {
                    Some(target) => fs::read_link(&destination)
                        .map(|existing| existing == target)
                        .unwrap_or(false),
                    None => false,
                }
            } else {
                false
            };
            if !identical {
                return Err(fail(
                    "BUCK2_ARCHIVE_DUPLICATE",
                    format!("conflicting duplicate {archive_kind} entry: {}", relative.display()),
                ));
            }
            continue;
        }

        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                fail(
                    "BUCK2_ARCHIVE_OUTPUT",
                    format!("could not create output parent: {error}"),
                )
            })?;
        }
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            fs::create_dir_all(&destination).map_err(|error| {
                fail(
                    "BUCK2_ARCHIVE_OUTPUT",
                    format!("could not create archive directory: {error}"),
                )
            })?;
            fs::set_permissions(&destination, fs::Permissions::from_mode(0o755)).map_err(
                |error| fail("BUCK2_ARCHIVE_OUTPUT", format!("could not set directory mode: {error}")),
            )?;
        } else if kind.is_file() {
            let archive_mode = entry.header().mode().map_err(|error| {
                fail(
                    "BUCK2_ARCHIVE_FORMAT",
                    format!("could not read {archive_kind} entry mode: {error}"),
                )
            })?;
            let mode = if archive_mode & 0o111 == 0 { 0o644 } else { 0o755 };
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .map_err(|error| {
                    fail(
                        "BUCK2_ARCHIVE_OUTPUT",
                        format!("could not create extracted file: {error}"),
                    )
                })?;
            io::copy(&mut entry, &mut output).map_err(|error| {
                fail(
                    "BUCK2_ARCHIVE_EXTRACT",
                    format!("could not extract {archive_kind} file: {error}"),
                )
            })?;
            fs::set_permissions(&destination, fs::Permissions::from_mode(mode)).map_err(
                |error| fail("BUCK2_ARCHIVE_OUTPUT", format!("could not set file mode: {error}")),
            )?;
        } else if allow_symlinks && kind.is_symlink() {
            let target = entry.link_name().map_err(|error| {
                fail(
                    "BUCK2_ARCHIVE_LINK",
                    format!("could not read archive symlink target: {error}"),
                )
            })?;
            let target = target.ok_or_else(|| {
                fail(
                    "BUCK2_ARCHIVE_LINK",
                    format!("archive symlink has no target: {}", path.display()),
                )
            })?;
            normalize_symlink_target(relative.parent().unwrap_or_else(|| Path::new("")), &target)?;
            symlink(&target, &destination).map_err(|error| {
                fail(
                    "BUCK2_ARCHIVE_EXTRACT",
                    format!("could not create archive symlink: {error}"),
                )
            })?;
            symlinks.push(destination);
        } else {
            return Err(fail(
                "BUCK2_ARCHIVE_ENTRY_TYPE",
                format!("unsupported {archive_kind} entry type at {}", path.display()),
            ));
        }
        extracted += 1;
    }

    if extracted == 0 {
        return Err(fail(
            "BUCK2_ARCHIVE_EMPTY",
            format!("{archive_kind} archive contains no entries under the required prefix"),
        ));
    }
    let canonical_out = fs::canonicalize(out).map_err(|error| {
        fail(
            "BUCK2_ARCHIVE_OUTPUT",
            format!("could not canonicalize output directory: {error}"),
        )
    })?;
    for link in symlinks {
        let target = fs::canonicalize(&link).map_err(|error| {
            fail(
                "BUCK2_ARCHIVE_LINK",
                format!("archive symlink is dangling: {}: {error}", link.display()),
            )
        })?;
        if !target.starts_with(&canonical_out) {
            return Err(fail(
                "BUCK2_ARCHIVE_LINK",
                format!("archive symlink resolves outside package root: {}", link.display()),
            ));
        }
    }
    Ok(())
}

fn extract_crate(args: &ExtractCrateArgs) -> ToolResult<()> {
    extract_prefixed_archive(
        &args.archive,
        &args.out,
        &args.strip_prefix,
        "crate",
        false,
    )
}

fn parse_patch_range(value: &str) -> ToolResult<(usize, usize)> {
    let mut parts = value.split(',');
    let start = parts
        .next()
        .ok_or_else(|| fail("BUCK2_ARCHIVE_PATCH", "patch range is empty"))?
        .parse::<usize>()
        .map_err(|error| fail("BUCK2_ARCHIVE_PATCH", format!("invalid patch range: {error}")))?;
    let count = parts
        .next()
        .map_or(Ok(1_usize), |value| value.parse::<usize>())
        .map_err(|error| fail("BUCK2_ARCHIVE_PATCH", format!("invalid patch count: {error}")))?;
    if parts.next().is_some() {
        return Err(fail("BUCK2_ARCHIVE_PATCH", "patch range has too many fields"));
    }
    Ok((start, count))
}

fn parse_hunk_header(value: &str) -> ToolResult<(usize, usize, usize)> {
    let value = value
        .strip_prefix("@@ -")
        .ok_or_else(|| fail("BUCK2_ARCHIVE_PATCH", "invalid unified-diff hunk header"))?;
    let (old, value) = value
        .split_once(" +")
        .ok_or_else(|| fail("BUCK2_ARCHIVE_PATCH", "invalid unified-diff hunk ranges"))?;
    let (new, _) = value
        .split_once(" @@")
        .ok_or_else(|| fail("BUCK2_ARCHIVE_PATCH", "invalid unified-diff hunk terminator"))?;
    let (old_start, old_count) = parse_patch_range(old)?;
    let (_, new_count) = parse_patch_range(new)?;
    Ok((old_start, old_count, new_count))
}

fn patch_path(value: &str) -> ToolResult<PathBuf> {
    let value = value
        .split('\t')
        .next()
        .unwrap_or(value)
        .strip_prefix("b/")
        .ok_or_else(|| fail("BUCK2_ARCHIVE_PATCH", "patched path must have the b/ prefix"))?;
    let value = normalized_relative(value, "patched path")?;
    Ok(PathBuf::from(value))
}

fn apply_file_hunks(
    original: &str,
    lines: &[&str],
    mut index: usize,
) -> ToolResult<(String, usize)> {
    let source_lines = original.split_inclusive('\n').collect::<Vec<_>>();
    let mut source_index = 0_usize;
    let mut output = String::new();
    while index < lines.len() && !lines[index].starts_with("diff --git ") {
        if !lines[index].starts_with("@@ -") {
            index += 1;
            continue;
        }
        let (old_start, old_count, new_count) = parse_hunk_header(lines[index].trim_end())?;
        let hunk_start = old_start.saturating_sub(1);
        if hunk_start < source_index || hunk_start > source_lines.len() {
            return Err(fail("BUCK2_ARCHIVE_PATCH", "patch hunk is out of order or out of range"));
        }
        for line in &source_lines[source_index..hunk_start] {
            output.push_str(line);
        }
        source_index = hunk_start;
        index += 1;
        let mut consumed = 0_usize;
        let mut produced = 0_usize;
        while index < lines.len()
            && !lines[index].starts_with("@@ -")
            && !lines[index].starts_with("diff --git ")
        {
            let line = lines[index];
            let marker = line.as_bytes().first().copied();
            if marker != Some(b' ') && marker != Some(b'-') && marker != Some(b'+') {
                if line.starts_with("\\ No newline at end of file") {
                    return Err(fail(
                        "BUCK2_ARCHIVE_PATCH",
                        "misplaced no-newline marker in unified diff",
                    ));
                }
                break;
            }
            let mut body = &line[1..];
            if lines
                .get(index + 1)
                .is_some_and(|next| next.starts_with("\\ No newline at end of file"))
            {
                body = body.strip_suffix('\n').unwrap_or(body);
                index += 1;
            }
            if marker == Some(b' ') || marker == Some(b'-') {
                let source = source_lines.get(source_index).ok_or_else(|| {
                    fail("BUCK2_ARCHIVE_PATCH", "patch hunk consumes past end of file")
                })?;
                if *source != body {
                    return Err(fail(
                        "BUCK2_ARCHIVE_PATCH",
                        format!("patch context does not match at source line {}", source_index + 1),
                    ));
                }
                source_index += 1;
                consumed += 1;
            }
            if marker == Some(b' ') || marker == Some(b'+') {
                output.push_str(body);
                produced += 1;
            }
            index += 1;
        }
        if consumed != old_count || produced != new_count {
            return Err(fail(
                "BUCK2_ARCHIVE_PATCH",
                "patch hunk line counts do not match its header",
            ));
        }
    }
    for line in &source_lines[source_index..] {
        output.push_str(line);
    }
    Ok((output, index))
}

fn apply_patch(root: &Path, patch_path_value: &Path) -> ToolResult<()> {
    let patch = fs::read_to_string(patch_path_value).map_err(|error| {
        fail(
            "BUCK2_ARCHIVE_PATCH",
            format!("could not read patch {}: {error}", patch_path_value.display()),
        )
    })?;
    let lines = patch.split_inclusive('\n').collect::<Vec<_>>();
    let mut index = 0_usize;
    let mut files = 0_usize;
    while index < lines.len() {
        if !lines[index].starts_with("diff --git ") {
            index += 1;
            continue;
        }
        index += 1;
        while index < lines.len()
            && !lines[index].starts_with("--- a/")
            && !lines[index].starts_with("diff --git ")
        {
            index += 1;
        }
        if index + 1 >= lines.len()
            || !lines[index].starts_with("--- a/")
            || !lines[index + 1].starts_with("+++ b/")
        {
            return Err(fail(
                "BUCK2_ARCHIVE_PATCH",
                "patch must modify an existing file with --- a/ and +++ b/ headers",
            ));
        }
        let old_path = lines[index]
            .trim_end()
            .strip_prefix("--- a/")
            .ok_or_else(|| fail("BUCK2_ARCHIVE_PATCH", "invalid old patch path"))?;
        let new_path = patch_path(lines[index + 1].trim_end().trim_start_matches("+++ "))?;
        if Path::new(old_path) != new_path {
            return Err(fail("BUCK2_ARCHIVE_PATCH", "patch renames are not supported"));
        }
        let destination = root.join(&new_path);
        let metadata = fs::symlink_metadata(&destination).map_err(|error| {
            fail(
                "BUCK2_ARCHIVE_PATCH",
                format!("patched file does not exist: {}: {error}", new_path.display()),
            )
        })?;
        if !metadata.file_type().is_file() {
            return Err(fail(
                "BUCK2_ARCHIVE_PATCH",
                format!("patched path is not a regular file: {}", new_path.display()),
            ));
        }
        let original = fs::read_to_string(&destination).map_err(|error| {
            fail(
                "BUCK2_ARCHIVE_PATCH",
                format!("could not read patched file {}: {error}", new_path.display()),
            )
        })?;
        let (patched, next) = apply_file_hunks(&original, &lines, index + 2)?;
        if patched == original {
            return Err(fail(
                "BUCK2_ARCHIVE_PATCH",
                format!("patch made no change to {}", new_path.display()),
            ));
        }
        fs::write(&destination, patched).map_err(|error| {
            fail(
                "BUCK2_ARCHIVE_PATCH",
                format!("could not write patched file {}: {error}", new_path.display()),
            )
        })?;
        index = next;
        files += 1;
    }
    if files == 0 {
        return Err(fail("BUCK2_ARCHIVE_PATCH", "patch contains no file modifications"));
    }
    Ok(())
}

fn extract_npm(args: &ExtractNpmArgs) -> ToolResult<()> {
    extract_prefixed_archive(
        &args.archive,
        &args.out,
        &args.strip_prefix,
        "npm package",
        true,
    )?;
    for patch in &args.patches {
        apply_patch(&args.out, patch)?;
    }
    Ok(())
}

fn run() -> ToolResult<()> {
    let cli = Cli::parse();
    verify_execution_capability(
        &cli.capability_manifest,
        "archive-tool",
        PROTOCOL,
        "native-executable/v1",
    )?;
    match cli.command {
        Command::ExtractCrate(args) => extract_crate(&args),
        Command::ExtractNpm(args) => extract_npm(&args),
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
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;
    use tar::{Builder, EntryType, Header};

    fn crate_archive(entries: &[(&str, &[u8])]) -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        let encoder = GzEncoder::new(file.reopen().unwrap(), Compression::default());
        let mut builder = Builder::new(encoder);
        for (path, contents) in entries {
            let mut header = Header::new_gnu();
            header.set_entry_type(EntryType::Regular);
            header.set_mode(0o644);
            header.set_size(contents.len() as u64);
            header.set_cksum();
            builder.append_data(&mut header, path, *contents).unwrap();
        }
        builder
            .into_inner()
            .unwrap()
            .finish()
            .unwrap()
            .flush()
            .unwrap();
        file
    }

    #[test]
    fn extracts_only_after_the_declared_crate_prefix() {
        let archive = crate_archive(&[("demo-1.0.0/src/lib.rs", b"pub fn demo() {}\n")]);
        let output_parent = tempfile::tempdir().unwrap();
        let output = output_parent.path().join("out");
        extract_crate(&ExtractCrateArgs {
            archive: archive.path().to_owned(),
            out: output.clone(),
            strip_prefix: "demo-1.0.0".into(),
        })
        .unwrap();
        assert_eq!(
            fs::read(output.join("src/lib.rs")).unwrap(),
            b"pub fn demo() {}\n"
        );
    }

    #[test]
    fn rejects_an_entry_outside_the_declared_prefix() {
        let archive = crate_archive(&[("other/src/lib.rs", b"not the declared crate\n")]);
        let output_parent = tempfile::tempdir().unwrap();
        let error = extract_crate(&ExtractCrateArgs {
            archive: archive.path().to_owned(),
            out: output_parent.path().join("out"),
            strip_prefix: "demo-1.0.0".into(),
        })
        .unwrap_err();
        assert_eq!(error.code, "BUCK2_ARCHIVE_PREFIX");
    }

    #[test]
    fn extracts_npm_tree_with_explicit_prefix_safe_relative_symlink_and_patch() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let encoder = GzEncoder::new(file.reopen().unwrap(), Compression::default());
        let mut builder = Builder::new(encoder);
        let mut file_header = Header::new_gnu();
        file_header.set_entry_type(EntryType::Regular);
        file_header.set_mode(0o644);
        file_header.set_size(4);
        file_header.set_cksum();
        builder
            .append_data(&mut file_header, "deep-eql/lib/value.txt", b"old\n".as_slice())
            .unwrap();
        let mut duplicate_header = Header::new_gnu();
        duplicate_header.set_entry_type(EntryType::Regular);
        duplicate_header.set_mode(0o644);
        duplicate_header.set_size(4);
        duplicate_header.set_cksum();
        builder
            .append_data(
                &mut duplicate_header,
                "deep-eql/./lib/value.txt",
                b"old\n".as_slice(),
            )
            .unwrap();
        let mut link_header = Header::new_gnu();
        link_header.set_entry_type(EntryType::Symlink);
        link_header.set_mode(0o777);
        link_header.set_size(0);
        link_header.set_link_name("../lib/value.txt").unwrap();
        link_header.set_cksum();
        builder
            .append_data(&mut link_header, "deep-eql/bin/value", io::empty())
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap().flush().unwrap();

        let patch = tempfile::NamedTempFile::new().unwrap();
        fs::write(
            patch.path(),
            "diff --git a/lib/value.txt b/lib/value.txt\nindex 3367afd..3e75765 100644\n--- a/lib/value.txt\n+++ b/lib/value.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
        )
        .unwrap();
        let output_parent = tempfile::tempdir().unwrap();
        let output = output_parent.path().join("out");
        extract_npm(&ExtractNpmArgs {
            archive: file.path().to_owned(),
            out: output.clone(),
            patches: vec![patch.path().to_owned()],
            strip_prefix: "deep-eql".into(),
        })
        .unwrap();
        assert_eq!(fs::read_to_string(output.join("lib/value.txt")).unwrap(), "new\n");
        assert_eq!(
            fs::read_link(output.join("bin/value")).unwrap(),
            PathBuf::from("../lib/value.txt")
        );
    }

    #[test]
    fn rejects_npm_archive_path_traversal() {
        let archive = tempfile::NamedTempFile::new().unwrap();
        let encoder = GzEncoder::new(archive.reopen().unwrap(), Compression::default());
        let mut builder = Builder::new(encoder);
        let contents = b"escape\n";
        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Regular);
        header.set_mode(0o644);
        header.set_size(contents.len() as u64);
        header.set_path("package/xx/outside.txt").unwrap();
        header.as_mut_bytes()[8..10].copy_from_slice(b"..");
        header.set_cksum();
        builder.append(&header, contents.as_slice()).unwrap();
        builder.into_inner().unwrap().finish().unwrap().flush().unwrap();

        let output_parent = tempfile::tempdir().unwrap();
        let error = extract_npm(&ExtractNpmArgs {
            archive: archive.path().to_owned(),
            out: output_parent.path().join("out"),
            strip_prefix: "package".into(),
            patches: Vec::new(),
        })
        .unwrap_err();
        assert_eq!(error.code, "BUCK2_ARCHIVE_PATH");
        assert!(!output_parent.path().join("outside.txt").exists());
    }

    #[test]
    fn rejects_npm_symlink_that_escapes_package_root() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let encoder = GzEncoder::new(file.reopen().unwrap(), Compression::default());
        let mut builder = Builder::new(encoder);
        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Symlink);
        header.set_mode(0o777);
        header.set_size(0);
        header.set_link_name("../../outside").unwrap();
        header.set_cksum();
        builder
            .append_data(&mut header, "package/bin/escape", io::empty())
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap().flush().unwrap();
        let output_parent = tempfile::tempdir().unwrap();
        let error = extract_npm(&ExtractNpmArgs {
            archive: file.path().to_owned(),
            out: output_parent.path().join("out"),
            patches: Vec::new(),
            strip_prefix: "package".into(),
        })
        .unwrap_err();
        assert_eq!(error.code, "BUCK2_ARCHIVE_LINK");
    }
}
