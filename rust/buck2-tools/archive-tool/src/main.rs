use buck2_tool_core::{normalized_relative, verify_execution_capability, ToolError, ToolResult};
use clap::{Args, Parser, Subcommand};
use flate2::read::GzDecoder;
use std::{
    collections::HashSet,
    fs::{self, File},
    path::{Component, Path, PathBuf},
};
use tar::Archive;

const PROTOCOL: &str = "effect-utils/buck2-archive-tool/v1";

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

fn fail(code: &'static str, message: impl Into<String>) -> ToolError {
    ToolError::new(code, message)
}

fn extract_crate(args: &ExtractCrateArgs) -> ToolResult<()> {
    let strip_prefix = normalized_relative(&args.strip_prefix, "stripPrefix")?;
    let strip_prefix = Path::new(&strip_prefix);
    fs::create_dir(&args.out).map_err(|error| {
        fail(
            "BUCK2_ARCHIVE_OUTPUT",
            format!("could not create output directory: {error}"),
        )
    })?;

    let source = File::open(&args.archive).map_err(|error| {
        fail(
            "BUCK2_ARCHIVE_INPUT",
            format!("could not open crate archive: {error}"),
        )
    })?;
    let mut archive = Archive::new(GzDecoder::new(source));
    archive.set_preserve_permissions(true);
    let entries = archive.entries().map_err(|error| {
        fail(
            "BUCK2_ARCHIVE_FORMAT",
            format!("could not read crate archive: {error}"),
        )
    })?;
    let mut seen = HashSet::new();
    let mut extracted = 0_usize;

    for entry in entries {
        let mut entry = entry.map_err(|error| {
            fail(
                "BUCK2_ARCHIVE_FORMAT",
                format!("could not read crate entry: {error}"),
            )
        })?;
        let path = entry.path().map_err(|error| {
            fail(
                "BUCK2_ARCHIVE_PATH",
                format!("invalid crate entry path: {error}"),
            )
        })?;
        let relative = path.strip_prefix(strip_prefix).map_err(|_| {
            fail(
                "BUCK2_ARCHIVE_PREFIX",
                format!(
                    "crate entry is outside required prefix {}: {}",
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
                format!("crate entry path is not normalized: {}", path.display()),
            ));
        }
        if !seen.insert(relative.to_path_buf()) {
            return Err(fail(
                "BUCK2_ARCHIVE_DUPLICATE",
                format!("duplicate crate entry: {}", relative.display()),
            ));
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(fail(
                "BUCK2_ARCHIVE_ENTRY_TYPE",
                format!("unsupported crate entry type at {}", path.display()),
            ));
        }
        let destination = args.out.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                fail(
                    "BUCK2_ARCHIVE_OUTPUT",
                    format!("could not create output parent: {error}"),
                )
            })?;
        }
        entry.unpack(&destination).map_err(|error| {
            fail(
                "BUCK2_ARCHIVE_EXTRACT",
                format!("could not extract crate entry: {error}"),
            )
        })?;
        extracted += 1;
    }

    if extracted == 0 {
        return Err(fail(
            "BUCK2_ARCHIVE_EMPTY",
            "crate archive contains no entries under the required prefix",
        ));
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
}
