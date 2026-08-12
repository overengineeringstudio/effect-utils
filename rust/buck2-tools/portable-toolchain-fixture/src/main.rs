use buck2_tool_core::{canonical_json, sha256_file, sha256_sri, ToolError, ToolResult};
use clap::{Args, Parser, Subcommand};
use serde_json::json;
use std::{fs, io::Cursor, path::PathBuf};
use tar::{Builder, EntryType, Header};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Fixture(FixtureArgs),
}

#[derive(Args)]
struct FixtureArgs {
    #[arg(long)]
    archive: PathBuf,
    #[arg(long)]
    descriptor: PathBuf,
}

fn add(
    builder: &mut Builder<fs::File>,
    name: &str,
    content: Option<&[u8]>,
    mode: u32,
) -> ToolResult<()> {
    let mut header = Header::new_gnu();
    header.set_mtime(1);
    header.set_uid(0);
    header.set_gid(0);
    header.set_mode(mode);
    match content {
        None => {
            header.set_entry_type(EntryType::Directory);
            header.set_size(0);
            header.set_cksum();
            builder.append_data(&mut header, name, Cursor::new([]))
        }
        Some(bytes) => {
            header.set_entry_type(EntryType::Regular);
            header.set_size(bytes.len() as u64);
            header.set_cksum();
            builder.append_data(&mut header, name, Cursor::new(bytes))
        }
    }
    .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_FIXTURE", error.to_string()))
}

fn fixture(args: FixtureArgs) -> ToolResult<()> {
    let payload = b"#!/bin/sh\nset -eu\nprintf \"%s\\n\" portable-toolchain-ok > \"$1\"\n";
    if let Some(parent) = args.archive.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_FIXTURE", error.to_string()))?;
    }
    let file = fs::File::create(&args.archive)
        .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_FIXTURE", error.to_string()))?;
    let mut builder = Builder::new(file);
    add(&mut builder, "./bin", None, 0o555)?;
    add(&mut builder, "./bin/fixture-tool", Some(payload), 0o555)?;
    builder
        .finish()
        .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_FIXTURE", error.to_string()))?;
    drop(builder);
    let digest = sha256_file(&args.archive)?;
    let size = fs::metadata(&args.archive)
        .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_FIXTURE", error.to_string()))?
        .len();
    let descriptor = json!({
        "artifact":{"digest":{"algorithm":"sha256","sri":sha256_sri(&digest)?},"file":"artifact.tar","format":"tar","sizeBytes":size},
        "entrypoints":["bin/fixture-tool"],
        "kind":"buck2-portable-toolchain-artifact",
        "name":"synthetic-portable-tool",
        "normalization":{"dataMode":"0444","directoryMode":"0555","executableMode":"0555","groupId":0,"mtimeSeconds":1,"ownerId":0,"schemaVersion":1},
        "platform":"x86_64-linux",
        "provenance":{"producer":"effect-utils.buck2.synthetic-portable-toolchain-fixture","recipeId":"synthetic-portable-tool-v1","sourceDigest":"sha256:synthetic-portable-tool-v1"},
        "schemaVersion":1
    });
    fs::write(args.descriptor, canonical_json(&descriptor)?)
        .map_err(|error| ToolError::new("BUCK2_TOOLCHAIN_FIXTURE", error.to_string()))
}

fn main() {
    let result = match Cli::parse().command {
        Command::Fixture(args) => fixture(args),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
