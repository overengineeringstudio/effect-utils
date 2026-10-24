//! Read-only native replay. The TypeScript bridge is the only host-state writer.
//! Lock order is recipe EX -> generation SH; SH survives private output rename.
use super::{extract_npm, fail, normalize_symlink_target, ExtractNpmArgs};
use buck2_tool_core::{is_sha256, normalized_relative, sha256_bytes, sha256_file, ToolResult};
use clap::Args;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{symlink, FileExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Instant,
};

const RECIPE: &str = "effect-utils/buck-materialization-recipe/v1";
const TREE: &str = "effect-utils/buck-materialization-tree/v1";
const PROOF: &str = "effect-utils/buck-materialization-recipe-proof/v1";
const MAX_JSON: u64 = 64 * 1024 * 1024;

#[derive(Args, Default)]
pub(super) struct ReplayArgs {
    #[arg(long)]
    content_store: Option<PathBuf>,
    #[arg(long)]
    high_water_bytes: Option<u64>,
    #[arg(long)]
    archive_sha256: Option<String>,
    #[arg(long)]
    tool_closure_inputs: Option<PathBuf>,
    #[arg(long)]
    publisher_bun: Option<PathBuf>,
    #[arg(long)]
    publisher_bun_config: Option<PathBuf>,
    #[arg(long)]
    publisher_entry: Option<PathBuf>,
    #[arg(long)]
    receipt: Option<PathBuf>,
}
impl ReplayArgs {
    pub(super) fn enabled(&self) -> bool {
        self.content_store.is_some()
    }
    pub(super) fn require_disabled(&self) -> ToolResult<()> {
        ensure(
            self.high_water_bytes.is_none()
                && self.archive_sha256.is_none()
                && self.tool_closure_inputs.is_none()
                && self.publisher_bun.is_none()
                && self.publisher_bun_config.is_none()
                && self.publisher_entry.is_none()
                && self.receipt.is_none(),
            "incomplete replay arguments",
        )
    }
}
fn ensure(ok: bool, message: &str) -> ToolResult<()> {
    if ok {
        Ok(())
    } else {
        Err(fail("BUCK2_REPLAY_INVALID", message))
    }
}
fn io<T>(value: std::io::Result<T>) -> ToolResult<T> {
    value.map_err(|e| fail("BUCK2_REPLAY_IO", e.to_string()))
}
fn required<T>(value: Option<&T>) -> ToolResult<&T> {
    value.ok_or_else(|| fail("BUCK2_REPLAY_ARGUMENT", "all replay arguments are required"))
}
fn json<T: Serialize>(value: &T) -> ToolResult<Vec<u8>> {
    serde_json::to_vec(value).map_err(|e| fail("BUCK2_REPLAY_JSON", e.to_string()))
}
fn decode<T: for<'a> Deserialize<'a>>(bytes: &[u8]) -> ToolResult<T> {
    serde_json::from_slice(bytes).map_err(|e| fail("BUCK2_REPLAY_JSON", e.to_string()))
}

// Tuple structs make serde reject both missing and extra array elements.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct Recipe(String, String, String, String, Vec<String>);
impl Recipe {
    fn new(
        closure: String,
        archive: String,
        prefix: String,
        patches: Vec<String>,
    ) -> ToolResult<Self> {
        let value = Self(RECIPE.into(), closure, archive, prefix, patches);
        value.validate()?;
        Ok(value)
    }
    fn validate(&self) -> ToolResult<()> {
        ensure(
            self.0 == RECIPE
                && is_sha256(&self.1)
                && is_sha256(&self.2)
                && self.4.iter().all(|s| is_sha256(s)),
            "invalid recipe digest or schema",
        )?;
        validate_path(&self.3)?;
        ensure(
            normalized_relative(&self.3, "stripPrefix")? == self.3,
            "invalid recipe prefix",
        )
    }
    fn key(&self) -> ToolResult<String> {
        self.validate()?;
        Ok(sha256_bytes(&json(self)?))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClosureInputs {
    schema: String,
    native_manifest: PathBuf,
    bun_manifest: PathBuf,
    publisher_runtime: PathBuf,
}
fn runtime_files(root: &Path, at: &Path, entries: &mut Vec<(String, String)>) -> ToolResult<()> {
    for entry in io(fs::read_dir(at))? {
        let path = io(entry)?.path();
        let meta = io(fs::symlink_metadata(&path))?;
        if meta.is_dir() {
            runtime_files(root, &path, entries)?;
        } else {
            ensure(
                meta.is_file(),
                "publisher runtime contains symlink or nonregular file",
            )?;
            let name = path
                .strip_prefix(root)
                .map_err(|e| fail("BUCK2_REPLAY_PATH", e.to_string()))?
                .to_str()
                .ok_or_else(|| fail("BUCK2_REPLAY_PATH", "non UTF-8 runtime path"))?
                .to_owned();
            validate_path(&name)?;
            entries.push((name, sha256_file(&path)?));
        }
    }
    Ok(())
}
fn closure_digest(
    path: &Path,
    capability: &Path,
    config: &Path,
) -> ToolResult<(String, ClosureInputs)> {
    let inputs: ClosureInputs = decode(&io(fs::read(path))?)?;
    ensure(
        inputs.schema == "effect-utils/buck-materialization-tool-inputs/v1",
        "unknown closure inputs",
    )?;
    let native = io(fs::read(&inputs.native_manifest))?;
    ensure(
        native == io(fs::read(capability))?,
        "native capability differs from verified capability",
    )?;
    ensure(
        io(fs::read(config))?.is_empty(),
        "publisher Bun config must be empty",
    )?;
    ensure(
        io(fs::symlink_metadata(&inputs.publisher_runtime))?.is_dir(),
        "runtime root must be a real directory",
    )?;
    let mut files = Vec::new();
    runtime_files(
        &inputs.publisher_runtime,
        &inputs.publisher_runtime,
        &mut files,
    )?;
    files.sort();
    ensure(!files.is_empty(), "empty publisher runtime")?;
    let digest = sha256_bytes(&json(&(
        "effect-utils/buck-materialization-tool-closure/v1",
        sha256_bytes(&native),
        sha256_bytes(&io(fs::read(&inputs.bun_manifest))?),
        files,
    ))?);
    Ok((digest, inputs))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: String,
    recipe: Recipe,
    entries: Vec<Entry>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum Entry {
    File(FileEntry),
    Directory(DirectoryEntry),
    Symlink(SymlinkEntry),
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct FileEntry {
    path: String,
    file: Blob,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DirectoryEntry {
    path: String,
    directory: bool,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SymlinkEntry {
    path: String,
    symlink: String,
}
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
struct Blob {
    sha256: String,
    size: u64,
    mode: String,
}
impl Blob {
    fn key(&self) -> String {
        format!("{}-{}", self.sha256, self.mode)
    }
    fn mode(&self) -> u32 {
        if self.mode == "0444" {
            0o444
        } else {
            0o555
        }
    }
}
impl Entry {
    fn path(&self) -> &str {
        match self {
            Self::File(e) => &e.path,
            Self::Directory(e) => &e.path,
            Self::Symlink(e) => &e.path,
        }
    }
}
fn validate_path(path: &str) -> ToolResult<()> {
    ensure(
        !path.is_empty()
            && !path.contains('\\')
            && !path.bytes().any(|b| b < 32 || b == 127)
            && !path.starts_with('/')
            && path
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."),
        "noncanonical manifest path",
    )
}
impl Manifest {
    fn validate(&self, recipe: &Recipe) -> ToolResult<BTreeMap<String, Blob>> {
        ensure(
            self.schema == TREE && &self.recipe == recipe && !self.entries.is_empty(),
            "manifest identity mismatch or empty tree",
        )?;
        let mut paths: BTreeMap<&str, &Entry> = BTreeMap::new();
        let mut blobs = BTreeMap::new();
        let mut previous: Option<&str> = None;
        for entry in &self.entries {
            let path = entry.path();
            validate_path(path)?;
            ensure(
                previous.is_none_or(|p| p < path),
                "manifest paths not strictly sorted",
            )?;
            previous = Some(path);
            if let Some(parent) = Path::new(path)
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
            {
                ensure(
                    matches!(
                        paths.get(parent.to_str().unwrap()),
                        Some(Entry::Directory(_))
                    ),
                    "missing explicit parent directory or symlink traversal",
                )?;
            }
            match entry {
                Entry::File(e) => {
                    ensure(
                        is_sha256(&e.file.sha256)
                            && matches!(e.file.mode.as_str(), "0444" | "0555"),
                        "invalid blob",
                    )?;
                    if let Some(old) = blobs.insert(e.file.key(), e.file.clone()) {
                        ensure(old.size == e.file.size, "inconsistent blob sizes")?;
                    }
                }
                Entry::Directory(e) => ensure(e.directory, "invalid directory tag")?,
                Entry::Symlink(e) => {
                    ensure(!e.symlink.is_empty(), "empty symlink")?;
                    normalize_symlink_target(
                        Path::new(path).parent().unwrap(),
                        Path::new(&e.symlink),
                    )?;
                }
            }
            paths.insert(path, entry);
        }
        // Resolve internal links without touching the host filesystem; bounded expansion rejects cycles.
        for entry in &self.entries {
            if let Entry::Symlink(e) = entry {
                resolve_link(&paths, &e.path)?;
            }
        }
        Ok(blobs)
    }
}
fn resolve_link(paths: &BTreeMap<&str, &Entry>, path: &str) -> ToolResult<()> {
    let mut current = PathBuf::from(path);
    for _ in 0..=paths.len() {
        let parts: Vec<_> = current.iter().map(|s| s.to_owned()).collect();
        let mut prefix = PathBuf::new();
        let mut replaced = false;
        for (i, part) in parts.iter().enumerate() {
            prefix.push(part);
            let text = prefix.to_str().unwrap();
            let entry = paths
                .get(text)
                .ok_or_else(|| fail("BUCK2_REPLAY_LINK", "dangling symlink"))?;
            if let Entry::Symlink(e) = entry {
                current =
                    normalize_symlink_target(prefix.parent().unwrap(), Path::new(&e.symlink))?;
                for suffix in &parts[i + 1..] {
                    current.push(suffix);
                }
                replaced = true;
                break;
            }
            ensure(
                i + 1 == parts.len() || matches!(entry, Entry::Directory(_)),
                "symlink traverses nondirectory",
            )?;
        }
        if !replaced {
            return Ok(());
        }
    }
    Err(fail("BUCK2_REPLAY_LINK", "symlink cycle"))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct Tuple(String, u64, String, String, String, String, String);
#[derive(Deserialize, Serialize)]
struct Proof(String, Tuple, Vec<(String, Tuple)>);
#[cfg(test)]
fn tuple(digest: &str, meta: &Metadata) -> Tuple {
    let ns = i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec());
    Tuple(
        digest.into(),
        meta.len(),
        meta.dev().to_string(),
        meta.ino().to_string(),
        meta.mode().to_string(),
        meta.uid().to_string(),
        ns.to_string(),
    )
}
fn tuple_valid(t: &Tuple) -> bool {
    is_sha256(&t.0)
        && [&t.2, &t.3, &t.4, &t.5]
            .iter()
            .all(|s| s.parse::<u64>().is_ok_and(|n| n.to_string() == **s))
        && t.6.parse::<i128>().is_ok_and(|n| n.to_string() == t.6)
}
// The platform boundary is limited to POSIX open flags/uid and best-effort clone.
// geteuid has no pointer preconditions and returns the process credential.
fn uid() -> u32 {
    unsafe { libc::geteuid() }
}
fn open(path: &Path, write: bool) -> ToolResult<File> {
    io(OpenOptions::new()
        .read(true)
        .write(write)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path))
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}
fn same_stat(a: &Metadata, b: &Metadata) -> bool {
    same(a, b)
        && a.len() == b.len()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
        && a.nlink() == b.nlink()
}
fn tuple_matches(t: &Tuple, m: &Metadata) -> bool {
    t.1 == m.len()
        && t.2.parse::<u64>() == Ok(m.dev())
        && t.3.parse::<u64>() == Ok(m.ino())
        && t.4.parse::<u32>() == Ok(m.mode())
        && t.5.parse::<u32>() == Ok(m.uid())
        && t.6.parse::<i128>()
            == Ok(i128::from(m.ctime()) * 1_000_000_000 + i128::from(m.ctime_nsec()))
}
fn regular(path: &Path, file: &File, mode: u32, single: bool) -> ToolResult<Metadata> {
    let meta = io(file.metadata())?;
    let named = io(fs::symlink_metadata(path))?;
    ensure(
        meta.is_file()
            && named.is_file()
            && same_stat(&meta, &named)
            && meta.uid() == uid()
            && meta.mode() & 0o7777 == mode
            && (!single || meta.nlink() == 1),
        "unsafe or replaced replay file",
    )?;
    Ok(meta)
}
fn directory(path: &Path, private: bool) -> ToolResult<()> {
    let meta = io(fs::symlink_metadata(path))?;
    ensure(
        meta.is_dir()
            && meta.uid() == uid()
            && meta.mode() & 0o022 == 0
            && (!private || meta.mode() & 0o077 == 0)
            && io(fs::canonicalize(path))? == path,
        "unsafe replay directory",
    )
}
fn read_bounded(path: &Path, mode: u32, single: bool) -> ToolResult<(Vec<u8>, Metadata)> {
    let mut file = open(path, false)?;
    let before = regular(path, &file, mode, single)?;
    ensure(before.len() <= MAX_JSON, "oversized replay JSON")?;
    let mut bytes = Vec::with_capacity(
        usize::try_from(before.len()).map_err(|e| fail("BUCK2_REPLAY_SIZE", e.to_string()))?,
    );
    io((&mut file).take(MAX_JSON + 1).read_to_end(&mut bytes))?;
    ensure(
        bytes.len() as u64 == before.len()
            && same_stat(&before, &regular(path, &file, mode, single)?),
        "replay file changed while reading",
    )?;
    Ok((bytes, before))
}
fn recipe_lock(path: &Path) -> ToolResult<File> {
    directory(path.parent().unwrap(), true)?;
    let file = open(path, true)?;
    regular(path, &file, 0o600, true)?;
    io(file.lock())?;
    regular(path, &file, 0o600, true)?;
    Ok(file)
}
fn generation_lease(root: &Path, generation: &str) -> ToolResult<File> {
    directory(root, false)?;
    directory(&root.join(".store"), false)?;
    directory(&root.join(".store").join(generation), false)?;
    let path = root.join(".leases").join(format!("{generation}.lock"));
    directory(path.parent().unwrap(), true)?;
    let file = open(&path, true)?;
    let before = regular(&path, &file, 0o600, true)?;
    ensure(before.len() <= 8192, "oversized generation control")?;
    let expected = format!(
        "{}:{}\n{}\n{}\n",
        before.dev(),
        before.ino(),
        root.display(),
        generation
    );
    let mut bytes = vec![0; usize::try_from(before.len()).unwrap()];
    io(file.read_exact_at(&mut bytes, 0))?;
    ensure(
        bytes == expected.as_bytes(),
        "incomplete generation control",
    )?;
    file.try_lock_shared().map_err(|e| {
        fail(
            "BUCK2_REPLAY_LEASE",
            format!("generation control unexpectedly held under recipe exclusion: {e}"),
        )
    })?;
    ensure(
        same_stat(&before, &regular(&path, &file, 0o600, true)?),
        "generation control changed",
    )?;
    Ok(file)
}
fn ctime_ns(meta: &Metadata) -> i128 {
    i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec())
}
// As with git's racy index, equality is not evidence that the source predates
// verification. Cross-device clocks cannot establish this ordering either.
fn metadata_proof_is_fresh(
    source_dev: u64,
    source_ctime: i128,
    proof_dev: u64,
    proof_ctime: i128,
) -> bool {
    source_dev == proof_dev && source_ctime < proof_ctime
}
fn source_predates_proof(source: &Metadata, proof: &Metadata) -> bool {
    metadata_proof_is_fresh(source.dev(), ctime_ns(source), proof.dev(), ctime_ns(proof))
}
struct Validated {
    manifest: Manifest,
    proof: Proof,
    mismatch: bool,
    racy: bool,
}
fn validate_generation(store: &Path, generation: &Path, recipe: &Recipe) -> ToolResult<Validated> {
    let manifest_path = generation.join("manifest.json");
    let (manifest_bytes, manifest_meta) = read_bounded(&manifest_path, 0o444, false)?;
    let manifest: Manifest = decode(&manifest_bytes)?;
    let blobs = manifest.validate(recipe)?;
    let (proof_bytes, proof_meta) =
        read_bounded(&generation.join("verification.json"), 0o600, true)?;
    let proof: Proof = decode(&proof_bytes)?;
    let mut canonical = json(&proof)?;
    canonical.push(b'\n');
    ensure(
        canonical == proof_bytes
            && proof.0 == PROOF
            && tuple_valid(&proof.1)
            && proof.2.iter().all(|(_, t)| tuple_valid(t)),
        "malformed or noncanonical verification proof",
    )?;
    ensure(
        proof.1 .0 == sha256_bytes(&manifest_bytes),
        "established manifest digest mismatch",
    )?;
    ensure(
        proof.2.len() == blobs.len() && proof.2.iter().map(|(k, _)| k).eq(blobs.keys()),
        "incomplete or unordered blob proof",
    )?;
    directory(&generation.join("pins"), false)?;
    let actual_pins: BTreeSet<_> = io(fs::read_dir(generation.join("pins")))?
        .map(|e| {
            io(e).and_then(|e| {
                e.file_name()
                    .into_string()
                    .map_err(|_| fail("BUCK2_REPLAY_PATH", "non UTF-8 pin"))
            })
        })
        .collect::<ToolResult<_>>()?;
    ensure(
        actual_pins.iter().eq(blobs.keys()),
        "unknown or missing recipe pins",
    )?;
    let mut mismatch = !tuple_matches(&proof.1, &manifest_meta);
    let mut racy = !source_predates_proof(&manifest_meta, &proof_meta);
    for (key, expected) in &proof.2 {
        let blob = &blobs[key];
        ensure(
            expected.0 == blob.sha256 && expected.1 == blob.size,
            "blob proof identity mismatch",
        )?;
        let canonical = store.join(&blob.sha256[..2]).join(key);
        directory(canonical.parent().unwrap(), false)?;
        let pin = generation.join("pins").join(key);
        let source = open(&pin, false)?;
        let meta = regular(&pin, &source, blob.mode(), false)?;
        let canonical_file = open(&canonical, false)?;
        let canonical_meta = regular(&canonical, &canonical_file, blob.mode(), false)?;
        ensure(
            same(&meta, &canonical_meta) && meta.len() == blob.size,
            "pin does not identify canonical CAS payload",
        )?;
        mismatch |= !tuple_matches(expected, &meta);
        racy |= !source_predates_proof(&meta, &proof_meta);
    }
    Ok(Validated {
        manifest,
        proof,
        mismatch,
        racy,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BunCapability {
    schema: String,
    tool_id: String,
    protocol: String,
    runtime_contract: String,
    execution_platform: String,
    executable_store_path: PathBuf,
    content_digest: String,
    closure_identity: PathBuf,
    closure_store_paths: Vec<String>,
}
struct Bridge<'a> {
    args: &'a ReplayArgs,
    recipe_file: PathBuf,
    inputs: &'a ClosureInputs,
}
impl Bridge<'_> {
    fn invoke(&self, operation: &str, lock: Option<&File>, tree: Option<&Path>) -> ToolResult<()> {
        let bun = required(self.args.publisher_bun.as_ref())?;
        ensure(bun.is_absolute(), "publisher Bun must be absolute")?;
        let cap: BunCapability = decode(&io(fs::read(&self.inputs.bun_manifest))?)?;
        ensure(
            cap.schema == "effect-utils/buck2-support-tools/v1"
                && cap.tool_id == "bun"
                && cap.protocol == "effect-utils/buck2-bun/v1"
                && cap.runtime_contract == "native-executable/v1"
                && cap.execution_platform
                    == format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS),
            "Bun capability identity mismatch",
        )?;
        ensure(
            cap.executable_store_path == *bun
                && io(fs::canonicalize(bun))? == *bun
                && bun.starts_with("/nix/store")
                && bun.starts_with(&cap.closure_identity)
                && is_sha256(&cap.content_digest)
                && sha256_file(bun)? == cap.content_digest,
            "Bun executable attestation mismatch",
        )?;
        ensure(
            !cap.closure_store_paths.is_empty()
                && cap.closure_store_paths.windows(2).all(|p| p[0] < p[1])
                && cap.closure_store_paths.iter().all(|p| {
                    p.strip_prefix("/nix/store/")
                        .is_some_and(|s| !s.is_empty() && !s.contains('/'))
                })
                && cap
                    .closure_store_paths
                    .iter()
                    .any(|p| Path::new(p) == cap.closure_identity),
            "invalid Bun closure",
        )?;
        ensure(
            std::env::var_os("EDITOR_VIEW_LEASE_LIBRARY").is_some(),
            "missing lease library capability",
        )?;
        let mut command = Command::new(bun);
        command
            .arg("--no-env-file")
            .arg("--no-install")
            .arg(format!(
                "--config={}",
                required(self.args.publisher_bun_config.as_ref())?.display()
            ))
            .arg(required(self.args.publisher_entry.as_ref())?)
            .arg("--operation")
            .arg(operation)
            .arg("--content-store")
            .arg(required(self.args.content_store.as_ref())?)
            .arg("--high-water-bytes")
            .arg(required(self.args.high_water_bytes.as_ref())?.to_string())
            .arg("--recipe-json")
            .arg(&self.recipe_file)
            .stdout(Stdio::null());
        if let Some(lock) = lock {
            command
                .arg("--lock-stdin")
                .stdin(Stdio::from(io(lock.try_clone())?));
        } else {
            command.stdin(Stdio::null());
        }
        if let Some(tree) = tree {
            command.arg("--tree").arg(tree);
        }
        ensure(io(command.status())?.success(), "recipe bridge failed")
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Counts {
    cloned_files: u64,
    cloned_bytes: u64,
    copied_files: u64,
    copied_bytes: u64,
    linked_files: u64,
    linked_bytes: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt<'a> {
    schema: &'static str,
    recipe_key: &'a str,
    cache_hit: bool,
    extraction_count: u64,
    patch_count: usize,
    #[serde(flatten)]
    counts: Counts,
    source_verification: &'static str,
    timings_ms: BTreeMap<&'static str, f64>,
}
fn clone_unsupported(error: &std::io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::EOPNOTSUPP | libc::ENOTTY | libc::EINVAL | libc::EXDEV | libc::ENOSYS)
    )
}
// Only the kernel clone operations cross the unsafe boundary. Both descriptors
// stay live, and the destination is exclusively owned private staging state.
fn clone_file(source: &File, destination: &Path) -> ToolResult<Option<File>> {
    #[cfg(target_os = "linux")]
    {
        let output = io(OpenOptions::new()
            .write(true)
            .read(true)
            .create_new(true)
            .mode(0o600)
            .open(destination))?;
        // SAFETY: FICLONE takes a live destination fd and a live source fd; it
        // neither dereferences Rust memory nor writes through the source.
        let result = unsafe { libc::ioctl(output.as_raw_fd(), 0x4004_9409, source.as_raw_fd()) };
        if result == 0 {
            return Ok(Some(output));
        }
        let error = std::io::Error::last_os_error();
        drop(output);
        io(fs::remove_file(destination))?;
        if clone_unsupported(&error) {
            Ok(None)
        } else {
            Err(fail("BUCK2_REPLAY_CLONE", error.to_string()))
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let parent = destination
            .parent()
            .ok_or_else(|| fail("BUCK2_REPLAY_CLONE", "missing clone destination parent"))?;
        let parent_fd = io(OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(parent))?;
        let name = std::ffi::CString::new(
            destination
                .file_name()
                .ok_or_else(|| fail("BUCK2_REPLAY_CLONE", "missing clone destination name"))?
                .as_bytes(),
        )
        .map_err(|e| fail("BUCK2_REPLAY_CLONE", e.to_string()))?;
        // SAFETY: both fds remain live, name is NUL-terminated and lives across
        // the call, flags are zero. fclonefileat creates the previously absent
        // destination relative to the pinned private parent, never the source.
        let result = unsafe {
            libc::fclonefileat(source.as_raw_fd(), parent_fd.as_raw_fd(), name.as_ptr(), 0)
        };
        if result == 0 {
            return Ok(Some(open(destination, false)?));
        }
        let error = std::io::Error::last_os_error();
        if clone_unsupported(&error) {
            ensure(
                fs::symlink_metadata(destination)
                    .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
                "failed clone left a destination",
            )?;
            Ok(None)
        } else {
            Err(fail("BUCK2_REPLAY_CLONE", error.to_string()))
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (source, destination);
        Err(fail("BUCK2_REPLAY_CLONE", "unsupported replay platform"))
    }
}
fn hash_reader(source: &mut File) -> ToolResult<String> {
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let n = io(source.read(&mut buffer))?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(buck2_tool_core::lowercase_hex(&hash.finalize()))
}
fn install(valid: &Validated, generation: &Path, out: &Path) -> ToolResult<Counts> {
    ensure(
        fs::symlink_metadata(out).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
        "output already exists",
    )?;
    let parent = out
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let staging = io(tempfile::Builder::new()
        .prefix(".replay-output-")
        .tempdir_in(parent))?;
    io(fs::set_permissions(
        staging.path(),
        fs::Permissions::from_mode(0o755),
    ))?;
    let mut counts = Counts::default();
    for entry in &valid.manifest.entries {
        let destination = staging.path().join(entry.path());
        match entry {
            Entry::Directory(_) => {
                io(fs::create_dir(&destination))?;
                io(fs::set_permissions(
                    &destination,
                    fs::Permissions::from_mode(0o755),
                ))?;
            }
            Entry::Symlink(e) => io(symlink(&e.symlink, &destination))?,
            Entry::File(e) => {
                let key = e.file.key();
                let pin = generation.join("pins").join(&key);
                let mut source = open(&pin, false)?;
                let before = regular(&pin, &source, e.file.mode(), false)?;
                let proof_index = valid
                    .proof
                    .2
                    .binary_search_by(|(k, _)| k.cmp(&key))
                    .map_err(|_| fail("BUCK2_REPLAY_PROOF", "missing source proof"))?;
                ensure(
                    tuple_matches(&valid.proof.2[proof_index].1, &before),
                    "source changed before materialization",
                )?;
                let clone = clone_file(&source, &destination)?;
                let cloned = clone.is_some();
                let mut output = match clone {
                    Some(file) => file,
                    None => io(OpenOptions::new()
                        .write(true)
                        .read(true)
                        .create_new(true)
                        .mode(0o600)
                        .open(&destination))?,
                };
                if !cloned {
                    let mut hash = Sha256::new();
                    let mut buffer = [0; 65536];
                    let mut size = 0;
                    loop {
                        let n = io(source.read(&mut buffer))?;
                        if n == 0 {
                            break;
                        }
                        hash.update(&buffer[..n]);
                        io(output.write_all(&buffer[..n]))?;
                        size += n as u64;
                    }
                    ensure(
                        size == e.file.size
                            && buck2_tool_core::lowercase_hex(&hash.finalize()) == e.file.sha256,
                        "copied payload digest mismatch",
                    )?;
                }
                let after = regular(&pin, &source, e.file.mode(), false)?;
                if cloned && (valid.racy || !same_stat(&before, &after)) {
                    ensure(
                        hash_reader(&mut output)? == e.file.sha256,
                        "cloned payload changed during materialization",
                    )?;
                }
                io(output.set_permissions(fs::Permissions::from_mode(e.file.mode() | 0o200)))?;
                let installed = regular(&destination, &output, e.file.mode() | 0o200, true)?;
                ensure(
                    !same(&installed, &before) && installed.len() == e.file.size,
                    "installed output is not an independent correctly sized file",
                )?;
                if cloned {
                    counts.cloned_files += 1;
                    counts.cloned_bytes += e.file.size;
                } else {
                    counts.copied_files += 1;
                    counts.copied_bytes += e.file.size;
                }
            }
        }
    }
    io(fs::rename(staging.path(), out))?;
    Ok(counts)
}

pub(super) fn extract(args: &ExtractNpmArgs, capability: &Path) -> ToolResult<()> {
    let a = &args.replay;
    let start = Instant::now();
    let store = required(a.content_store.as_ref())?;
    required(a.high_water_bytes.as_ref())?;
    let receipt = required(a.receipt.as_ref())?;
    required(a.publisher_bun.as_ref())?;
    required(a.publisher_entry.as_ref())?;
    let config = required(a.publisher_bun_config.as_ref())?;
    let (closure, inputs) = closure_digest(
        required(a.tool_closure_inputs.as_ref())?,
        capability,
        config,
    )?;
    let entry = io(fs::canonicalize(required(a.publisher_entry.as_ref())?))?;
    ensure(
        entry.starts_with(io(fs::canonicalize(&inputs.publisher_runtime))?)
            && io(fs::symlink_metadata(required(a.publisher_entry.as_ref())?))?.is_file(),
        "publisher entry is outside declared runtime",
    )?;
    let patches = args
        .patches
        .iter()
        .map(|p| sha256_file(p))
        .collect::<ToolResult<Vec<_>>>()?;
    let recipe = Recipe::new(
        closure,
        required(a.archive_sha256.as_ref())?.clone(),
        args.strip_prefix.clone(),
        patches,
    )?;
    let key = recipe.key()?;
    let parent = args
        .out
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    ensure(store.is_absolute(), "content store must be absolute")?;
    let host_root = PathBuf::from(format!("{}.buck-materialization-v1", store.display()));
    let output_parent = io(fs::canonicalize(parent))?;
    let receipt_parent = io(fs::canonicalize(
        receipt
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new(".")),
    ))?;
    let output_name = args.out.file_name().ok_or_else(|| {
        fail(
            "BUCK2_REPLAY_OUTPUT",
            "output must name a private directory",
        )
    })?;
    ensure(
        !output_parent.starts_with(store)
            && !output_parent.starts_with(&host_root)
            && !receipt_parent.starts_with(store)
            && !receipt_parent.starts_with(&host_root)
            && !receipt_parent.starts_with(output_parent.join(output_name)),
        "output and receipt must remain private and outside host stores",
    )?;
    let private = io(tempfile::Builder::new()
        .prefix(".replay-private-")
        .tempdir_in(parent))?;
    let recipe_file = private.path().join("recipe.json");
    io(fs::write(&recipe_file, json(&recipe)?))?;
    let bridge = Bridge {
        args: a,
        recipe_file,
        inputs: &inputs,
    };
    let root = PathBuf::from(format!("{}.buck-materialization-v1", store.display()));
    let generation_name = format!("recipe-{key}");
    let generation = root.join(".store").join(&generation_name);
    let lock_path = root.join(".recipes").join(format!("{key}.lock"));
    match fs::symlink_metadata(&lock_path) {
        Ok(_) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            bridge.invoke("prepare", None, None)?
        }
        Err(e) => return Err(fail("BUCK2_REPLAY_IO", e.to_string())),
    }
    let lock = recipe_lock(&lock_path)?;
    let hit = match fs::symlink_metadata(&generation) {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(fail("BUCK2_REPLAY_IO", e.to_string())),
    };
    if !hit {
        ensure(
            sha256_file(&args.archive)? == recipe.2,
            "archive digest differs from declared digest",
        )?;
        let tree = private.path().join("tree");
        let cold = ExtractNpmArgs {
            archive: args.archive.clone(),
            out: tree.clone(),
            strip_prefix: args.strip_prefix.clone(),
            patches: args.patches.clone(),
            replay: ReplayArgs::default(),
        };
        extract_npm(&cold)?;
        bridge.invoke("publish", Some(&lock), Some(&tree))?;
    }
    let lease = generation_lease(&root, &generation_name)?;
    let mut valid = validate_generation(store, &generation, &recipe)?;
    let mut verification = if hit { "metadata-proof" } else { "publication" };
    if valid.mismatch || valid.racy {
        bridge.invoke("verify", Some(&lock), None)?;
        valid = validate_generation(store, &generation, &recipe)?;
        ensure(
            !valid.mismatch,
            "verification did not establish matching proof",
        )?;
        verification = "rehash";
    }
    drop(lock);
    let validation_ms = start.elapsed().as_secs_f64() * 1000.0;
    let output_start = Instant::now();
    let counts = install(&valid, &generation, &args.out)?;
    drop(lease);
    let receipt = Receipt {
        schema: "effect-utils/buck-materialization-replay-receipt/v1",
        recipe_key: &key,
        cache_hit: hit,
        extraction_count: u64::from(!hit),
        patch_count: if hit { 0 } else { args.patches.len() },
        counts,
        source_verification: verification,
        timings_ms: BTreeMap::from([
            ("validation", validation_ms),
            (
                "installation",
                output_start.elapsed().as_secs_f64() * 1000.0,
            ),
            ("total", start.elapsed().as_secs_f64() * 1000.0),
        ]),
    };
    let mut bytes = json(&receipt)?;
    bytes.push(b'\n');
    let mut destination = io(OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(required(a.receipt.as_ref())?))?;
    io(destination.write_all(&bytes))?;
    Ok(())
}

#[cfg(test)]
mod tests;
