//! Content verification only: callers must independently verify every code object's
//! signature and pinned requirement before publishing or installing a release.
//! Descriptor v1 hashes the complete unsigned tree and signing policy. Signature
//! envelopes are excluded only at declared code objects; sealed receipts hash bytes.
use super::{Result, fail, mismatch};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs, os::unix::fs::MetadataExt, path::{Component, Path, PathBuf}};

const VERSION: u64 = 1;

pub struct SigningEntry {
    pub path: String,
    pub identifier: String,
    pub requirement: String,
    pub entitlements: Option<String>,
    pub options: Vec<String>,
}

fn invalid(reason: impl Into<String>) -> super::Failure { fail(64, "invalid-input", reason) }
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().filter(|s| !s.is_empty() && !s.contains('\0')).ok_or_else(|| invalid(format!("Missing or invalid {key}")))
}
fn relative(path: &str) -> Result<()> {
    if path.is_empty() || path.contains('\\') || path.contains('\0') || path.split('/').any(|s| s.is_empty() || s == "." || s == "..")
        || Path::new(path).components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(invalid(format!("Unsafe relative code path: {path}")));
    }
    Ok(())
}
fn options(value: &Value) -> Result<Vec<String>> {
    let Some(array) = value.as_array() else {
        if value.is_null() { return Ok(Vec::new()); }
        return Err(invalid("Signing options must be an array"));
    };
    let mut seen = BTreeSet::new();
    for item in array {
        let item = item.as_str().ok_or_else(|| invalid("Invalid signing option"))?;
        if !matches!(item, "runtime" | "hard" | "kill" | "restrict" | "library" | "host" | "expires") || !seen.insert(item.to_owned()) {
            return Err(invalid(format!("Unknown or duplicate signing option: {item}")));
        }
    }
    Ok(seen.into_iter().collect())
}
fn entitlement(value: &Value) -> Result<Option<String>> {
    if value.is_null() { return Ok(None); }
    let path = value.as_str().filter(|p| !p.is_empty() && !p.contains('\0')).ok_or_else(|| invalid("Invalid entitlement path"))?;
    Ok(Some(path.to_owned()))
}
/// Explicit inventory, deepest objects first and enclosing app last. Never --deep.
pub fn signing_entries(config: &Value) -> Result<Vec<SigningEntry>> {
    let mut entries = Vec::new();
    let mut paths = BTreeSet::new();
    let executable = required(config, "hostExecutable")?;
    relative(executable)?;
    if executable.contains('/') { return Err(invalid("hostExecutable must be a basename")); }
    if let Some(nested) = config.get("nestedCode") {
        let nested = nested.as_array().ok_or_else(|| invalid("nestedCode must be an array"))?;
        for entry in nested {
            let object = entry.as_object().ok_or_else(|| invalid("Invalid nested code entry"))?;
            if object.keys().any(|k| !matches!(k.as_str(), "path" | "identifier" | "requirement" | "entitlements" | "options")) {
                return Err(invalid("Unknown nested code policy field"));
            }
            let path = required(entry, "path")?;
            relative(path)?;
            if !path.starts_with("Contents/") || path == format!("Contents/MacOS/{executable}") || !paths.insert(path.to_owned()) {
                return Err(invalid(format!("Duplicate, outer-main or misplaced nested code: {path}")));
            }
            entries.push(SigningEntry { path: path.to_owned(), identifier: required(entry, "identifier")?.to_owned(), requirement: required(entry, "requirement")?.to_owned(), entitlements: entitlement(&entry["entitlements"])?, options: options(&entry["options"])? });
        }
    }
    entries.sort_by(|a, b| b.path.split('/').count().cmp(&a.path.split('/').count()).then_with(|| a.path.cmp(&b.path)));
    entries.push(SigningEntry { path: String::new(), identifier: required(config, "bundleId")?.to_owned(), requirement: required(config, "requirement")?.to_owned(), entitlements: entitlement(&config["entitlements"])?, options: options(&config["signingOptions"])? });
    Ok(entries)
}
fn policy(entries: &[SigningEntry], executable: &str) -> Result<Value> {
    let objects = entries.iter().map(|entry| {
        let entitlements = entry.entitlements.as_ref().map(|path| {
            let metadata = fs::symlink_metadata(path)?;
            if !metadata.is_file() || metadata.mode() & 0o022 != 0 { return Err(invalid("Unsafe entitlements file")); }
            Ok(digest(&fs::read(path)?))
        }).transpose()?;
        Ok(json!({"path":entry.path,"identifier":entry.identifier,"requirement":entry.requirement,"entitlementsSha256":entitlements,"options":entry.options}))
    }).collect::<Result<Vec<_>>>()?;
    Ok(json!({"mainExecutable":format!("Contents/MacOS/{executable}"),"objects":objects}))
}

fn entitlement_dictionary(bytes: &[u8]) -> Result<Value> {
    use std::{io::Write, process::{Command, Stdio}};
    if bytes.len() > 1024 * 1024 { return Err(mismatch("Entitlements exceed 1 MiB")); }
    if bytes.is_empty() { return Ok(json!({})); }
    let mut child = Command::new("/usr/bin/plutil").args(["-convert","json","-o","-","-"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let mut stdin = child.stdin.take().ok_or_else(|| mismatch("Missing plist converter stdin"))?;
    // Read pipes concurrently with writing, so large entitlement dictionaries
    // cannot deadlock when the converter emits output before consuming EOF.
    let input = std::thread::scope(|scope| {
        let writer = scope.spawn(move || { let result = stdin.write_all(bytes); drop(stdin); result });
        let output = child.wait_with_output();
        let write_result = writer.join().map_err(|_| mismatch("Entitlement writer failed"))?;
        write_result?;
        output.map_err(super::Failure::from)
    })?;
    if !input.status.success() { return Err(mismatch("Invalid entitlement plist")); }
    let value: Value = serde_json::from_slice(&input.stdout)?;
    if !value.is_object() { return Err(mismatch("Entitlements must be a dictionary")); }
    Ok(value)
}
/// Verify actual signed entitlement semantics, not a candidate's receipt. An
/// absent policy means no entitlement keys; an empty signed dictionary is fine.
/// This is a read-only codesign invocation through the existing bounded guard.
/// The caller must invoke it for every selector returned by code_architectures.
pub fn verify_entitlements(app: &Path, entry: &SigningEntry, architecture: &str) -> Result<()> {
    if !matches!(architecture,"arm64" | "arm64e" | "x86_64" | "x86_64h") { return Err(mismatch("Unknown entitlement architecture selector")); }
    let object = app.join(&entry.path);
    let output = super::keys::bounded_codesign(&["-d","--architecture",architecture,"--entitlements",":-",super::text(&object)?])?;
    if !output.status.success() { return Err(mismatch("Cannot read signed entitlements")); }
    let actual = entitlement_dictionary(&output.stdout)?;
    let desired = match &entry.entitlements {
        Some(path) => entitlement_dictionary(&fs::read(path)?)?,
        None => json!({}),
    };
    if actual != desired { return Err(mismatch(format!("Signed entitlements differ from pinned policy: {} ({architecture})",entry.path))); }
    Ok(())
}

struct Item { path: String, directory: bool, executable: bool, bytes: Vec<u8>, raw_sha256: Option<String> }
fn acl_no_grants(file: &fs::File) -> Result<()> {
    macos_app_host::endpoint::verify_acl_no_grants(file).map_err(|error| mismatch(error.to_string()))
}
fn same_object(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino() && a.mode() == b.mode() && a.nlink() == b.nlink()
        && a.len() == b.len() && a.mtime() == b.mtime() && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime() && a.ctime_nsec() == b.ctime_nsec()
}
fn read_object(path: &Path, expected: &fs::Metadata) -> Result<(Vec<u8>,String)> {
    use std::{io::Read, os::unix::fs::OpenOptionsExt};
    let mut file = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path)?;
    if !same_object(expected,&file.metadata()?) { return Err(mismatch("Bundle file changed before reading")); }
    acl_no_grants(&file)?;
    let mut header = [0u8;4];
    let mut length = 0;
    while length < header.len() {
        let count = file.read(&mut header[length..])?;
        if count == 0 { break; }
        length += count;
    }
    let (bytes,hash) = if macho(&header[..length]) {
        let mut bytes = header.to_vec();
        file.read_to_end(&mut bytes)?;
        let hash = digest(&bytes);
        (bytes,hash)
    } else {
        let mut hash = Sha256::new();
        hash.update(&header[..length]);
        let mut buffer = [0u8;65536];
        loop { let count = file.read(&mut buffer)?; if count == 0 { break; } hash.update(&buffer[..count]); }
        (Vec::new(),format!("{:x}",hash.finalize()))
    };
    if !same_object(expected,&file.metadata()?) || !same_object(expected,&fs::symlink_metadata(path)?) {
        return Err(mismatch("Bundle file changed while reading"));
    }
    Ok((bytes,hash))
}
fn safe_layout(mode: u32, links: u64, immutable: bool) -> bool {
    let kind = mode & u32::from(libc::S_IFMT);
    (kind == u32::from(libc::S_IFREG) || kind == u32::from(libc::S_IFDIR))
        && mode & (if immutable {0o222} else {0o022}) == 0
        && mode & 0o7000 == 0 && (kind != u32::from(libc::S_IFREG) || links == 1)
}
fn inventory(root: &Path, immutable: bool) -> Result<Vec<Item>> {
    fn visit(root: &Path, path: &Path, immutable: bool, items: &mut Vec<Item>) -> Result<()> {
        let metadata = fs::symlink_metadata(path)?;
        if !safe_layout(metadata.mode(),metadata.nlink(),immutable) {
            return Err(mismatch(format!("Unsafe bundle object: {}", path.display())));
        }
        if path != root {
            let name = path.strip_prefix(root).map_err(|_| invalid("Inventory escaped root"))?.to_str().ok_or_else(|| invalid("Bundle paths must be UTF-8"))?.to_owned();
            relative(&name)?;
            let (bytes,raw_sha256) = if metadata.is_file() { let (bytes,hash) = read_object(path,&metadata)?; (bytes,Some(hash)) } else { (Vec::new(),None) };
            items.push(Item { path: name, directory: metadata.is_dir(), executable: metadata.mode() & 0o111 != 0, bytes, raw_sha256 });
        }
        if metadata.is_dir() {
            use std::os::unix::fs::OpenOptionsExt;
            let directory = fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW).open(path)?;
            if !same_object(&metadata,&directory.metadata()?) { return Err(mismatch("Bundle directory changed before inventory")); }
            acl_no_grants(&directory)?;
            for child in fs::read_dir(path)? { visit(root, &child?.path(), immutable, items)?; }
        }
        if !same_object(&metadata,&fs::symlink_metadata(path)?) { return Err(mismatch("Bundle layout changed during inventory")); }
        Ok(())
    }
    if !fs::symlink_metadata(root)?.is_dir() { return Err(mismatch("Artifact root is not a directory")); }
    let mut items = Vec::new();
    visit(root, root, immutable, &mut items)?;
    items.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(items)
}
fn plist_field(path: &Path, field: &str) -> Result<String> {
    let output = super::checked("/usr/bin/plutil", &["-extract", field, "raw", "-o", "-", super::text(path)?])?;
    let value = String::from_utf8(output.stdout).map_err(|_| mismatch("Non-UTF8 plist field"))?;
    Ok(value.trim_end_matches('\n').to_owned())
}
fn bundle_layout(path: &str) -> bool {
    [".app", ".framework", ".xpc", ".appex", ".bundle", ".plugin"].iter().any(|extension| path.ends_with(extension))
}
fn bundle_metadata(app: &Path, object: &str, identifier: &str) -> Result<String> {
    let root = app.join(object);
    let framework = object.ends_with(".framework");
    let plist = root.join(if framework { "Resources/Info.plist" } else { "Contents/Info.plist" });
    if plist_field(&plist, "CFBundleIdentifier")? != identifier { return Err(mismatch(format!("Bundle identifier mismatch: {object}"))); }
    let executable = plist_field(&plist, "CFBundleExecutable")?;
    relative(&executable)?;
    if executable.contains('/') { return Err(mismatch("Bundle executable must be a basename")); }
    Ok(if framework { format!("{object}/{executable}") } else if object.is_empty() { format!("Contents/MacOS/{executable}") } else { format!("{object}/Contents/MacOS/{executable}") })
}

fn architecture_name(cpu: u32, subtype: u32) -> Result<&'static str> {
    // Capability bits do not change codesign's architecture selector. Two
    // slices collapsing to one selector are refused, never silently skipped.
    match (cpu,subtype & 0x00ff_ffff) {
        (0x0100_0007,3) => Ok("x86_64"),
        (0x0100_0007,8) => Ok("x86_64h"),
        (0x0100_000c,0) => Ok("arm64"),
        (0x0100_000c,2) => Ok("arm64e"),
        _ => Err(mismatch(format!("Unsupported native architecture: CPU {cpu:#x}, subtype {subtype:#x}"))),
    }
}
fn architecture_headers(bytes: &[u8]) -> Result<Vec<String>> {
    fn thin_header(bytes: &[u8]) -> Result<(u32,u32)> {
        let magic = word(bytes,0,false)?;
        if !matches!(magic,0xfeedface | 0xfeedfacf | 0xcefaedfe | 0xcffaedfe) { return Err(mismatch("Architecture slice is not thin Mach-O")); }
        let little = matches!(magic,0xcefaedfe | 0xcffaedfe);
        let header = if matches!(magic,0xfeedfacf | 0xcffaedfe) {32usize} else {28usize};
        let size = usize::try_from(word(bytes,20,little)?).map_err(|_| mismatch("Mach-O command size overflow"))?;
        if header.checked_add(size).is_none_or(|end| end > bytes.len()) { return Err(mismatch("Truncated architecture header/load commands")); }
        Ok((word(bytes,4,little)?,word(bytes,8,little)?))
    }
    let magic = word(bytes,0,false)?;
    if !matches!(magic,0xcafebabe | 0xbebafeca | 0xcafebabf | 0xbfbafeca) {
        let (cpu,subtype) = thin_header(bytes)?;
        return Ok(vec![architecture_name(cpu,subtype)?.to_owned()]);
    }
    let little = matches!(magic,0xbebafeca | 0xbfbafeca);
    let fat64 = matches!(magic,0xcafebabf | 0xbfbafeca);
    let count = usize::try_from(word(bytes,4,little)?).map_err(|_| mismatch("Fat count overflow"))?;
    if count == 0 || count > 64 { return Err(mismatch("Invalid fat architecture count")); }
    let width = if fat64 {32} else {20};
    let table_end = 8 + count * width;
    if table_end > bytes.len() { return Err(mismatch("Truncated architecture table")); }
    let mut names = BTreeSet::new();
    let mut ranges = vec![(0,table_end)];
    for index in 0..count {
        let base = 8 + index * width;
        let cpu = word(bytes,base,little)?;
        let subtype = word(bytes,base+4,little)?;
        let offset = if fat64 {wide(bytes,base+8,little)?} else {u64::from(word(bytes,base+8,little)?)};
        let length = if fat64 {wide(bytes,base+16,little)?} else {u64::from(word(bytes,base+12,little)?)};
        let start = usize::try_from(offset).map_err(|_| mismatch("Fat architecture offset overflow"))?;
        let end = usize::try_from(offset.checked_add(length).ok_or_else(|| mismatch("Fat architecture range overflow"))?).map_err(|_| mismatch("Fat architecture range overflow"))?;
        if start >= end || end > bytes.len() || ranges.iter().any(|&(a,b)| start < b && end > a) { return Err(mismatch("Overlapping architecture slices")); }
        if thin_header(&bytes[start..end])? != (cpu,subtype) { return Err(mismatch("Architecture table/slice identity mismatch")); }
        if !names.insert(architecture_name(cpu,subtype)?.to_owned()) { return Err(mismatch("Duplicate codesign architecture selector")); }
        ranges.push((start,end));
    }
    Ok(names.into_iter().collect())
}
/// Exact architecture selectors for the declared code object's native executable.
/// Unknown architectures and multiple slices sharing a selector fail closed.
/// No external inspection tool or native-machine architecture inference is used.
pub fn code_architectures(app: &Path, entry: &SigningEntry, config: &Value) -> Result<Vec<String>> {
    if !entry.path.is_empty() { relative(&entry.path)?; }
    let object = app.join(&entry.path);
    let metadata = fs::symlink_metadata(&object)?;
    let executable = if metadata.is_dir() {
        let executable = bundle_metadata(app,&entry.path,&entry.identifier)?;
        if entry.path.is_empty() && executable != format!("Contents/MacOS/{}",required(config,"hostExecutable")?) { return Err(mismatch("Outer architecture executable mismatch")); }
        app.join(executable)
    } else { object };
    let metadata = fs::symlink_metadata(&executable)?;
    if !metadata.is_file() || !safe_layout(metadata.mode(),metadata.nlink(),false) { return Err(mismatch("Unsafe architecture executable")); }
    let (bytes,_) = read_object(&executable,&metadata)?;
    architecture_headers(&bytes)
}

fn word(bytes: &[u8], offset: usize, little: bool) -> Result<u32> {
    let raw: [u8; 4] = bytes.get(offset..offset.checked_add(4).ok_or_else(|| mismatch("Mach-O overflow"))?).ok_or_else(|| mismatch("Truncated Mach-O"))?.try_into().map_err(|_| mismatch("Truncated Mach-O"))?;
    Ok(if little { u32::from_le_bytes(raw) } else { u32::from_be_bytes(raw) })
}
fn wide(bytes: &[u8], offset: usize, little: bool) -> Result<u64> {
    let a = u64::from(word(bytes, offset, little)?);
    let b = u64::from(word(bytes, offset + 4, little)?);
    Ok(if little { a | (b << 32) } else { (a << 32) | b })
}
fn put_word(bytes: &mut [u8], offset: usize, value: u32, little: bool) {
    bytes[offset..offset + 4].copy_from_slice(&if little { value.to_le_bytes() } else { value.to_be_bytes() });
}
fn put_wide(bytes: &mut [u8], offset: usize, value: u64, little: bool) {
    bytes[offset..offset + 8].copy_from_slice(&if little { value.to_le_bytes() } else { value.to_be_bytes() });
}
fn macho(bytes: &[u8]) -> bool {
    bytes.get(..4).is_some_and(|b| matches!(b, [0xce,0xfa,0xed,0xfe] | [0xcf,0xfa,0xed,0xfe] | [0xfe,0xed,0xfa,0xce] | [0xfe,0xed,0xfa,0xcf] | [0xca,0xfe,0xba,0xbe] | [0xbe,0xba,0xfe,0xca] | [0xca,0xfe,0xba,0xbf] | [0xbf,0xba,0xfe,0xca]))
}
/// Canonical Mach-O bytes, with only signing-owned envelopes normalized. Load
/// command positions and all nonzero unsigned bytes remain binding. Fat slice
/// placement is packaging, but CPU identity and each complete slice are binding.
fn unsigned_macho(bytes: &[u8]) -> Result<Vec<u8>> {
    if !macho(bytes) { return Err(mismatch("Declared executable is not Mach-O")); }
    let magic = word(bytes, 0, false)?;
    if matches!(magic, 0xcafebabe | 0xbebafeca | 0xcafebabf | 0xbfbafeca) {
        let little = matches!(magic, 0xbebafeca | 0xbfbafeca);
        let fat64 = matches!(magic, 0xcafebabf | 0xbfbafeca);
        let count = usize::try_from(word(bytes, 4, little)?).map_err(|_| mismatch("Fat count overflow"))?;
        if count == 0 || count > 64 { return Err(mismatch("Invalid fat architecture count")); }
        let width = if fat64 { 32 } else { 20 };
        let table_end = 8 + count * width;
        if table_end > bytes.len() { return Err(mismatch("Truncated fat table")); }
        let mut slices = BTreeMap::new();
        let mut ranges = vec![(0, table_end)];
        for index in 0..count {
            let base = 8 + index * width;
            let cpu = (word(bytes, base, little)?, word(bytes, base + 4, little)?);
            let offset = if fat64 { wide(bytes, base + 8, little)? } else { u64::from(word(bytes, base + 8, little)?) };
            let length = if fat64 { wide(bytes, base + 16, little)? } else { u64::from(word(bytes, base + 12, little)?) };
            let start = usize::try_from(offset).map_err(|_| mismatch("Fat offset overflow"))?;
            let end = usize::try_from(offset.checked_add(length).ok_or_else(|| mismatch("Fat range overflow"))?).map_err(|_| mismatch("Fat range overflow"))?;
            if start >= end || end > bytes.len() || ranges.iter().any(|&(a,b)| start < b && end > a) { return Err(mismatch("Overlapping or invalid fat slice")); }
            let slice = &bytes[start..end];
            if !matches!(word(slice,0,false)?,0xfeedface | 0xfeedfacf | 0xcefaedfe | 0xcffaedfe) { return Err(mismatch("Fat slices must be thin Mach-O")); }
            let slice_little = matches!(word(slice, 0, false)?, 0xcefaedfe | 0xcffaedfe);
            if (word(slice, 4, slice_little)?, word(slice, 8, slice_little)?) != cpu { return Err(mismatch("Fat CPU identity mismatch")); }
            if slices.insert(cpu, unsigned_macho(slice)?).is_some() { return Err(mismatch("Duplicate fat CPU")); }
            ranges.push((start, end));
        }
        ranges.sort_unstable();
        let mut cursor = 0;
        for (start,end) in ranges { if bytes[cursor..start].iter().any(|b| *b != 0) { return Err(mismatch("Nonzero fat padding")); } cursor = end; }
        if bytes[cursor..].iter().any(|b| *b != 0) { return Err(mismatch("Nonzero fat trailer")); }
        let mut canonical = b"macos-app-fat-v1\0".to_vec();
        for ((cpu,subtype), slice) in slices { canonical.extend_from_slice(&cpu.to_be_bytes()); canonical.extend_from_slice(&subtype.to_be_bytes()); canonical.extend_from_slice(&(slice.len() as u64).to_be_bytes()); canonical.extend_from_slice(&slice); }
        return Ok(canonical);
    }
    let little = matches!(magic, 0xcefaedfe | 0xcffaedfe);
    let is64 = matches!(magic, 0xfeedfacf | 0xcffaedfe);
    let header = if is64 { 32 } else { 28 };
    let count = word(bytes, 16, little)?;
    let size = usize::try_from(word(bytes, 20, little)?).map_err(|_| mismatch("Load command size overflow"))?;
    let command_end = header + size;
    if command_end > bytes.len() || count > 65536 { return Err(mismatch("Invalid Mach-O commands")); }
    let mut commands = Vec::new();
    let mut signature = None;
    let mut linkedit = None;
    let mut referenced_end = 0usize;
    let mut cursor = header;
    for _ in 0..count {
        let kind = word(bytes, cursor, little)?;
        let length = usize::try_from(word(bytes, cursor + 4, little)?).map_err(|_| mismatch("Command size overflow"))?;
        let end = cursor.checked_add(length).ok_or_else(|| mismatch("Command overflow"))?;
        if length < 8 || length % 4 != 0 || end > command_end { return Err(mismatch("Malformed load command")); }
        if kind == 0x1d {
            if length != 16 || signature.is_some() { return Err(mismatch("Invalid signature load command")); }
            let start = usize::try_from(word(bytes, cursor + 8, little)?).map_err(|_| mismatch("Signature offset overflow"))?;
            let len = usize::try_from(word(bytes, cursor + 12, little)?).map_err(|_| mismatch("Signature size overflow"))?;
            let end = start.checked_add(len).ok_or_else(|| mismatch("Signature range overflow"))?;
            if start < command_end || len == 0 || end > bytes.len() || bytes[end..].iter().any(|b| *b != 0) { return Err(mismatch("Signature is not a terminal envelope")); }
            signature = Some((start,end));
        } else {
            let mut command = bytes[cursor..end].to_vec();
            let mut reference = |offset: u64, length: u64| -> Result<()> {
                if length == 0 { return Ok(()); }
                let end = usize::try_from(offset.checked_add(length).ok_or_else(|| mismatch("Mach-O referenced range overflow"))?).map_err(|_| mismatch("Mach-O referenced range overflow"))?;
                if end > bytes.len() { return Err(mismatch("Mach-O referenced range exceeds file")); }
                referenced_end = referenced_end.max(end);
                Ok(())
            };
            match kind {
                0x2 => {
                    if length != 24 { return Err(mismatch("Malformed symbol table")); }
                    reference(u64::from(word(&command,8,little)?), u64::from(word(&command,12,little)?) * if is64 {16} else {12})?;
                    reference(u64::from(word(&command,16,little)?), u64::from(word(&command,20,little)?))?;
                }
                0xb => {
                    if length != 80 { return Err(mismatch("Malformed dynamic symbol table")); }
                    for (offset,width) in [(32,8),(40,if is64 {56} else {52}),(48,4),(56,4),(64,8),(72,8)] {
                        reference(u64::from(word(&command,offset,little)?),u64::from(word(&command,offset+4,little)?) * width)?;
                    }
                }
                0x22 | 0x80000022 => {
                    if length != 48 { return Err(mismatch("Malformed dyld info")); }
                    for offset in [8,16,24,32,40] { reference(u64::from(word(&command,offset,little)?),u64::from(word(&command,offset+4,little)?))?; }
                }
                0x1e | 0x26 | 0x29 | 0x2b | 0x2e | 0x80000033 | 0x80000034 | 0x36 | 0x37 | 0x38 => {
                    if length != 16 { return Err(mismatch("Malformed linkedit data")); }
                    reference(u64::from(word(&command,8,little)?),u64::from(word(&command,12,little)?))?;
                }
                0x16 => {
                    if length != 16 { return Err(mismatch("Malformed two-level hints")); }
                    reference(u64::from(word(&command,8,little)?),u64::from(word(&command,12,little)?) * 4)?;
                }
                0x31 => {
                    if length != 40 { return Err(mismatch("Malformed Mach-O note")); }
                    reference(wide(&command,24,little)?,wide(&command,32,little)?)?;
                }
                _ => {}
            }
            if kind == 0x1 || kind == 0x19 {
                let min = if kind == 0x19 { 72 } else { 56 };
                if length < min { return Err(mismatch("Truncated segment command")); }
                if &command[8..24] == b"__LINKEDIT\0\0\0\0\0\0" {
                    if linkedit.is_some() { return Err(mismatch("Duplicate __LINKEDIT")); }
                    let fileoff = if kind == 0x19 { wide(&command, 40, little)? } else { u64::from(word(&command, 32, little)?) };
                    linkedit = Some((commands.len(), kind == 0x19, usize::try_from(fileoff).map_err(|_| mismatch("Linkedit offset overflow"))?));
                    // Filled from canonical byte extent after removing the envelope.
                    if kind == 0x19 { put_wide(&mut command, 32, 0, little); put_wide(&mut command, 48, 0, little); }
                    else { put_word(&mut command, 28, 0, little); put_word(&mut command, 36, 0, little); }
                }
            }
            commands.push(command);
        }
        cursor = end;
    }
    if cursor != command_end { return Err(mismatch("Load command size mismatch")); }
    let mut end = signature.map_or(bytes.len(), |(start,_)| start);
    if referenced_end > end { return Err(mismatch("Signature overlaps unsigned native data")); }
    // Only unreferenced zero alignment padding may disappear. In particular,
    // trailing zeros in a string table or relocation table remain binding.
    if let Some((_,_,offset)) = linkedit {
        if offset > end || offset < command_end { return Err(mismatch("Invalid __LINKEDIT extent")); }
        while end > offset.max(referenced_end) && bytes[end - 1] == 0 { end -= 1; }
    } else if signature.is_some() { return Err(mismatch("Signature without __LINKEDIT")); }
    if let Some((index,is64,offset)) = linkedit {
        let length = (end - offset) as u64;
        let virtual_length = length.checked_add(4095).ok_or_else(|| mismatch("Linkedit size overflow"))? & !4095;
        if is64 { put_wide(&mut commands[index], 32, virtual_length, little); put_wide(&mut commands[index], 48, length, little); }
        else { put_word(&mut commands[index], 28, u32::try_from(virtual_length).map_err(|_| mismatch("Linkedit size overflow"))?, little); put_word(&mut commands[index], 36, u32::try_from(length).map_err(|_| mismatch("Linkedit size overflow"))?, little); }
    }
    let mut canonical = bytes[..end].to_vec();
    canonical[header..command_end].fill(0);
    let mut cursor = header;
    for command in &commands { canonical[cursor..cursor + command.len()].copy_from_slice(command); cursor += command.len(); }
    put_word(&mut canonical, 16, u32::try_from(commands.len()).map_err(|_| mismatch("Command count overflow"))?, little);
    put_word(&mut canonical, 20, u32::try_from(cursor - header).map_err(|_| mismatch("Command size overflow"))?, little);
    Ok(canonical)
}

/// All non-platform dependencies must resolve inside the declared code closure.
/// Unknown token forms and escaping rpaths are refused rather than searched in
/// the calling process environment or the local Nix store.
fn load_paths(bytes: &[u8]) -> Result<(Vec<String>, Vec<String>)> {
    let magic = word(bytes,0,false)?;
    if matches!(magic, 0xcafebabe | 0xbebafeca | 0xcafebabf | 0xbfbafeca) {
        let little = matches!(magic,0xbebafeca | 0xbfbafeca);
        let fat64 = matches!(magic,0xcafebabf | 0xbfbafeca);
        let width = if fat64 {32} else {20};
        let mut dependencies = Vec::new();
        let mut rpaths = Vec::new();
        for index in 0..word(bytes,4,little)? as usize {
            let base = 8 + index * width;
            let offset = if fat64 {wide(bytes,base+8,little)?} else {u64::from(word(bytes,base+8,little)?)};
            let length = if fat64 {wide(bytes,base+16,little)?} else {u64::from(word(bytes,base+12,little)?)};
            let start = usize::try_from(offset).map_err(|_| mismatch("Fat range overflow"))?;
            let end = usize::try_from(offset.checked_add(length).ok_or_else(|| mismatch("Fat range overflow"))?).map_err(|_| mismatch("Fat range overflow"))?;
            let (deps,paths) = load_paths(bytes.get(start..end).ok_or_else(|| mismatch("Fat range outside file"))?)?;
            dependencies.extend(deps); rpaths.extend(paths);
        }
        return Ok((dependencies,rpaths));
    }
    let little = matches!(magic,0xcefaedfe | 0xcffaedfe);
    let mut cursor = if matches!(magic,0xfeedfacf | 0xcffaedfe) {32} else {28};
    let mut dependencies = Vec::new();
    let mut rpaths = Vec::new();
    for _ in 0..word(bytes,16,little)? {
        let kind = word(bytes,cursor,little)?;
        let length = word(bytes,cursor+4,little)? as usize;
        let command = bytes.get(cursor..cursor+length).ok_or_else(|| mismatch("Truncated dependency command"))?;
        if matches!(kind,0xc | 0x80000018 | 0x8000001f | 0x80000023 | 0x20 | 0x8000001c | 0xe | 0xf) {
            let offset = word(command,8,little)? as usize;
            let min = if kind == 0x8000001c || kind == 0xe || kind == 0xf {12} else {24};
            if offset < min { return Err(mismatch("Invalid Mach-O dependency string offset")); }
            let tail = command.get(offset..).ok_or_else(|| mismatch("Invalid dependency string"))?;
            let end = tail.iter().position(|b| *b == 0).ok_or_else(|| mismatch("Unterminated dependency string"))?;
            let path = std::str::from_utf8(&tail[..end]).map_err(|_| mismatch("Non-UTF8 dependency"))?.to_owned();
            if path.is_empty() { return Err(mismatch("Empty native dependency")); }
            if kind == 0x8000001c { rpaths.push(path); } else { dependencies.push(path); }
        }
        cursor += length;
    }
    Ok((dependencies,rpaths))
}
fn platform(path: &str) -> bool {
    (path.starts_with("/usr/lib/") || path.starts_with("/System/Library/"))
        && !path.trim_start_matches('/').split('/').any(|part| part == "." || part == ".." || part.is_empty())
        && !path.contains('\\')
}
fn local_path(path: &str, loader: &str, executable: &str) -> Result<String> {
    let parent = |object: &str| Path::new(object).parent().and_then(Path::to_str).map(str::to_owned).ok_or_else(|| mismatch("Invalid native object path"));
    let expanded = if path == "@loader_path" { parent(loader)? }
        else if path == "@executable_path" { parent(executable)? }
        else if let Some(suffix) = path.strip_prefix("@loader_path/") { format!("{}/{suffix}",parent(loader)?) }
        else if let Some(suffix) = path.strip_prefix("@executable_path/") { format!("{}/{suffix}",parent(executable)?) }
        else { return Err(mismatch(format!("Non-bundled native path: {path}"))); };
    let mut parts = Vec::new();
    for part in expanded.split('/') {
        match part {
            ".." => { if parts.pop().is_none() { return Err(mismatch("Native dependency escapes bundle")); } }
            "." => {}
            "" => return Err(mismatch("Invalid native dependency path")),
            value => parts.push(value),
        }
    }
    let result = parts.join("/");
    relative(&result)?;
    Ok(result)
}
fn verify_dependencies(items: &[Item], native: &BTreeSet<String>, mains: &BTreeMap<String,String>) -> Result<()> {
    let mut paths = BTreeMap::new();
    for item in items.iter().filter(|item| native.contains(&item.path)) {
        // file_records has already validated the complete Mach-O envelope.
        paths.insert(item.path.as_str(),load_paths(&item.bytes)?);
    }
    for (loader,(dependencies,rpaths)) in &paths {
        let main = mains.iter().filter(|(bundle,_)| bundle.is_empty() || bundle.as_str() == *loader || loader.starts_with(&format!("{bundle}/")))
            .max_by_key(|(bundle,_)| bundle.len()).map(|(_,main)| main.as_str()).ok_or_else(|| mismatch("No enclosing main executable"))?;
        let mut search = Vec::new();
        let inherited = paths.get(main).into_iter().flat_map(|(_,paths)| paths.iter().map(|path| (path,main)));
        for (path,owner) in rpaths.iter().map(|path| (path,*loader)).chain(inherited) {
            search.push(if platform(path) { path.clone() } else { local_path(path,owner,main)? });
        }
        for dependency in dependencies {
            if platform(dependency) { continue; }
            let candidates = if let Some(suffix) = dependency.strip_prefix("@rpath/") {
                relative(suffix)?;
                search.iter().map(|root| format!("{root}/{suffix}")).collect::<Vec<_>>()
            } else { vec![local_path(dependency,loader,main)?] };
            if !candidates.iter().any(|candidate| native.contains(candidate) || platform(candidate)) {
                return Err(mismatch(format!("Unhashed or undeclared native dependency: {loader}: {dependency}")));
            }
        }
    }
    Ok(())
}

fn signature_resource(path: &str, bundles: &BTreeSet<String>) -> Result<bool> {
    for bundle in bundles {
        let prefix = if bundle.is_empty() { "Contents/_CodeSignature".to_owned() } else if bundle.ends_with(".framework") { format!("{bundle}/_CodeSignature") } else { format!("{bundle}/Contents/_CodeSignature") };
        if path == prefix || path == format!("{prefix}/CodeResources") { return Ok(true); }
        if path.starts_with(&format!("{prefix}/")) { return Err(mismatch("Unexpected signature resource")); }
    }
    if path.split('/').any(|part| part == "_CodeSignature") { return Err(mismatch("Undeclared signature directory")); }
    Ok(false)
}
fn file_records(items: &[Item], normalized: bool, bundles: &BTreeSet<String>) -> Result<Value> {
    let mut records = Vec::new();
    for item in items {
        if normalized && signature_resource(&item.path, bundles)? { continue; }
        let hash = if normalized && macho(&item.bytes) { Some(digest(&unsigned_macho(&item.bytes)?)) } else { item.raw_sha256.clone() };
        records.push(json!({"path":item.path,"kind":if item.directory {"directory"} else {"file"},"executable":item.executable,"sha256":hash}));
    }
    Ok(Value::Array(records))
}
/// Check only the outer bundle identifier, without assuming a code inventory.
pub fn verify_bundle_identifier(app: &Path, config: &Value) -> Result<()> {
    if plist_field(&app.join("Contents/Info.plist"), "CFBundleIdentifier")?
        != required(config, "bundleId")?
    {
        return Err(mismatch("Outer bundle identifier mismatch"));
    }
    Ok(())
}

/// Deterministic descriptor; never trusts source markers or candidate receipts.
pub fn describe(app: &Path, config: &Value) -> Result<Value> {
    describe_items(app,config,&inventory(app,false)?)
}
fn describe_items(app: &Path, config: &Value, items: &[Item]) -> Result<Value> {
    let entries = signing_entries(config)?;
    let executable = required(config, "hostExecutable")?;
    let by_path = items.iter().map(|item| (item.path.as_str(),item)).collect::<BTreeMap<_,_>>();
    let mut bundles = BTreeSet::from([String::new()]);
    let mut native = BTreeSet::new();
    let mut mains = BTreeMap::new();
    for entry in &entries {
        let main = if entry.path.is_empty() || by_path.get(entry.path.as_str()).is_some_and(|item| item.directory) {
            if !entry.path.is_empty() && !bundle_layout(&entry.path) { return Err(mismatch("Declared code directory is not a bundle")); }
            bundles.insert(entry.path.clone());
            let main = bundle_metadata(app, &entry.path, &entry.identifier)?;
            if entry.path.is_empty() || [".app",".xpc",".appex"].iter().any(|suffix| entry.path.ends_with(suffix)) { mains.insert(entry.path.clone(),main.clone()); }
            main
        } else { entry.path.clone() };
        if entry.path.is_empty() && main != format!("Contents/MacOS/{executable}") { return Err(mismatch("Outer main executable mismatch")); }
        let item = by_path.get(main.as_str()).ok_or_else(|| mismatch(format!("Missing declared executable: {main}")))?;
        if item.directory || !macho(&item.bytes) { return Err(mismatch(format!("Declared code is not Mach-O: {main}"))); }
        if (entry.path.is_empty() || bundles.contains(&entry.path)) && !item.executable { return Err(mismatch("Bundle main executable lacks execute permission")); }
        let magic = word(&item.bytes,0,false)?;
        let header = if matches!(magic,0xcafebabe | 0xbebafeca | 0xcafebabf | 0xbfbafeca) {
            let little = matches!(magic,0xbebafeca | 0xbfbafeca);
            let offset = if matches!(magic,0xcafebabf | 0xbfbafeca) { wide(&item.bytes,16,little)? } else { u64::from(word(&item.bytes,16,little)?) };
            item.bytes.get(usize::try_from(offset).map_err(|_| mismatch("Fat offset overflow"))?..).ok_or_else(|| mismatch("Missing fat main header"))?
        } else { &item.bytes };
        let magic = word(header,0,false)?;
        if word(header,12,matches!(magic,0xcefaedfe | 0xcffaedfe))? == 2 { mains.insert(main.clone(),main.clone()); }
        if !native.insert(main.clone()) { return Err(mismatch(format!("Duplicate code object: {main}"))); }
    }
    for item in items {
        if item.directory && bundle_layout(&item.path) && !bundles.contains(&item.path) { return Err(mismatch(format!("Undeclared code bundle: {}", item.path))); }
        if !item.directory && (macho(&item.bytes) || item.executable) && !native.contains(&item.path) { return Err(mismatch(format!("Undeclared executable/native dependency: {}", item.path))); }
    }
    let files = file_records(items,true,&bundles)?;
    verify_dependencies(items,&native,&mains)?;
    let body = json!({"schema":"macos-app-unsigned","version":VERSION,"policy":policy(&entries,executable)?,"files":files});
    let revision = digest(&serde_json::to_vec(&body)?);
    let mut descriptor = body;
    descriptor["hostRevision"] = json!(revision);
    Ok(descriptor)
}
fn checked_descriptor(desired: &Value, config: &Value) -> Result<()> {
    let mut body = desired.clone();
    let object = body.as_object_mut().ok_or_else(|| mismatch("Invalid desired descriptor"))?;
    if object.len() != 5 || !object.contains_key("files") || !object.contains_key("policy") { return Err(mismatch("Unknown or missing descriptor fields")); }
    let revision = object.remove("hostRevision").ok_or_else(|| mismatch("Missing host revision"))?;
    if body["schema"] != "macos-app-unsigned" || body["version"] != VERSION || revision != digest(&serde_json::to_vec(&body)?) { return Err(mismatch("Invalid desired descriptor revision/version")); }
    if body["policy"] != policy(&signing_entries(config)?,required(config,"hostExecutable")?)? { return Err(mismatch("Desired descriptor does not match independent signing policy")); }
    Ok(())
}
/// Product-owned basename, independent of the source bundle's filename.
pub(super) fn app_bundle_name(config: &Value) -> Result<&str> {
    let name = required(config, "appBundleName")?;
    let stem = name.strip_suffix(".app").ok_or_else(|| mismatch("appBundleName must end in .app"))?;
    if stem.is_empty() || matches!(stem, "." | "..") || name.chars().any(|c| c == '/' || c == '\\' || c.is_control()) {
        return Err(mismatch("appBundleName must be a single nonempty .app basename"));
    }
    Ok(name)
}

/// Actual sealed tree revision for installed/status evidence. Owner-write bits
/// may exist on an installed copy; group/world-write and unsafe objects may not.
pub fn artifact_revision(app: &Path) -> Result<String> {
    let files = file_records(&inventory(app,false)?,false,&BTreeSet::new())?;
    Ok(digest(&serde_json::to_vec(&files)?))
}
/// Records actual sealed bytes. This is NOT a signature-verification substitute.
/// Caller seals modes and verifies all signatures before publishing these bytes.
pub fn create_receipt(app: &Path, desired: &Value, config: &Value) -> Result<Value> {
    checked_descriptor(desired, config)?;
    receipt_from_items(app,desired,config,&inventory(app,true)?)
}
fn receipt_from_items(app: &Path, desired: &Value, config: &Value, items: &[Item]) -> Result<Value> {
    if describe_items(app,config,items)? != *desired { return Err(mismatch("Sealed bundle differs from pinned unsigned content")); }
    let files = file_records(items,false,&BTreeSet::new())?;
    let sealed_revision = digest(&serde_json::to_vec(&files)?);
    Ok(json!({"schema":"macos-app-release","version":VERSION,"hostRevision":desired["hostRevision"],"sealedRevision":sealed_revision,"files":files}))
}
pub struct VerifiedRelease {
    pub app: PathBuf,
    pub sealed_revision: String,
}

/// Read-only verification of exactly release/{<appBundleName>,descriptor.json,receipt.json}.
/// The desired descriptor is supplied independently, never obtained from release.
/// Signature and compiled-requirement verification remains mandatory in the caller.
pub fn verify_release(release: &Path, desired: &Value, config: &Value) -> Result<VerifiedRelease> {
    checked_descriptor(desired,config)?;
    let bundle_name = app_bundle_name(config)?;
    let all = inventory(release,true)?;
    let top = all.iter().filter(|item| !item.path.contains('/')).map(|item| item.path.as_str()).collect::<BTreeSet<_>>();
    if bundle_name != "host.app" && top == BTreeSet::from(["descriptor.json","host.app","receipt.json"]) {
        return Err(fail(22, "reseal-required", "Release uses the old host.app layout; reseal unsigned source with the product appBundleName before activation or rollback"));
    }
    if top != BTreeSet::from(["descriptor.json",bundle_name,"receipt.json"]) { return Err(mismatch("Invalid immutable release layout")); }
    let descriptor: Value = serde_json::from_slice(&fs::read(release.join("descriptor.json"))?)?;
    if descriptor != *desired { return Err(mismatch("Release descriptor differs from independently desired descriptor")); }
    let receipt: Value = serde_json::from_slice(&fs::read(release.join("receipt.json"))?)?;
    let app = release.join(bundle_name);
    let prefix_len = bundle_name.len() + 1;
    let items = all.into_iter().filter_map(|mut item| {
        if !item.path.strip_prefix(bundle_name).is_some_and(|suffix| suffix.starts_with('/')) { return None; }
        item.path.drain(..prefix_len);
        Some(item)
    }).collect::<Vec<_>>();
    if receipt != receipt_from_items(&app,desired,config,&items)? { return Err(mismatch("Release receipt/actual sealed bytes mismatch")); }
    Ok(VerifiedRelease { app, sealed_revision: required(&receipt, "sealedRevision")?.to_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Value { json!({"bundleId":"org.example.host","appBundleName":"Example Host.app","hostExecutable":"host","requirement":"identifier org.example.host","nestedCode":[],"entitlements":null,"signingOptions":[]}) }
    #[test]
    fn product_bundle_name_is_pinned_and_path_safe() {
        for name in ["Product Name.app", "Another Product.app"] {
            assert_eq!(app_bundle_name(&json!({"appBundleName": name})).unwrap(), name);
        }
        for name in ["", ".app", "..app", "...app", "Product", "../Product.app", "/Product.app", "a/b.app", "a\\b.app", "a\nb.app", "a\0b.app"] {
            assert!(app_bundle_name(&json!({"appBundleName": name})).is_err(), "{name:?}");
        }
        assert!(app_bundle_name(&json!({})).is_err());
    }
    #[test]
    fn refuses_escaping_and_duplicate_inventory() {
        for path in ["../helper","/helper","Contents/../helper","Contents//helper","Contents/./helper","Contents\\helper","Contents/MacOS/host"] {
            let mut config = config(); config["nestedCode"] = json!([{"path":path,"identifier":"org.example.helper","requirement":"identifier org.example.helper"}]);
            assert!(signing_entries(&config).is_err());
        }
        let mut config = config(); let item = json!({"path":"Contents/MacOS/helper","identifier":"org.example.helper","requirement":"identifier org.example.helper"});
        config["nestedCode"] = json!([item,item]); assert!(signing_entries(&config).is_err());
    }
    #[test]
    fn refuses_unknown_policy_and_orders_leaf_first() {
        let mut config = config(); config["signingOptions"] = json!(["deep"]); assert!(signing_entries(&config).is_err());
        config["signingOptions"] = json!([]);
        config["nestedCode"] = json!([
            {"path":"Contents/Helpers/child.app","identifier":"org.example.child","requirement":"identifier org.example.child"},
            {"path":"Contents/Helpers/child.app/Contents/MacOS/tool","identifier":"org.example.tool","requirement":"identifier org.example.tool"}
        ]);
        let entries = match signing_entries(&config) { Ok(entries) => entries, Err(_) => panic!("valid policy rejected") };
        assert!(entries[0].path.ends_with("/tool")); assert!(entries[2].path.is_empty());
        config["nestedCode"][0]["deep"] = json!(true); assert!(signing_entries(&config).is_err());
    }
    fn thin(signed: bool) -> Vec<u8> {
        let mut bytes = vec![0; if signed { 160 } else { 128 }];
        bytes[..4].copy_from_slice(&[0xcf,0xfa,0xed,0xfe]);
        put_word(&mut bytes,4,0x01000007,true);
        put_word(&mut bytes,16,if signed {2} else {1},true);
        put_word(&mut bytes,20,if signed {88} else {72},true);
        put_word(&mut bytes,32,0x19,true); put_word(&mut bytes,36,72,true);
        bytes[40..56].copy_from_slice(b"__LINKEDIT\0\0\0\0\0\0");
        put_wide(&mut bytes,64,4096,true); put_wide(&mut bytes,72,128,true); put_wide(&mut bytes,80,if signed {32} else {0},true);
        if signed { put_word(&mut bytes,104,0x1d,true); put_word(&mut bytes,108,16,true); put_word(&mut bytes,112,128,true); put_word(&mut bytes,116,32,true); bytes[128..].fill(0x42); }
        bytes
    }
    #[test]
    fn signing_envelope_does_not_change_unsigned_revision() {
        let unsigned = unsigned_macho(&thin(false)); let signed = unsigned_macho(&thin(true));
        assert!(unsigned.is_ok() && signed.is_ok()); assert_eq!(unsigned.ok(),signed.ok());
        assert_ne!(digest(&thin(false)),digest(&thin(true)));
    }
    #[test]
    fn refuses_malformed_signature_and_native_content_changes() {
        let mut signed = thin(true); put_word(&mut signed,112,16,true); assert!(unsigned_macho(&signed).is_err());
        let mut signed = thin(true); put_word(&mut signed,116,u32::MAX,true); assert!(unsigned_macho(&signed).is_err());
        let mut changed = thin(false); changed[12] = 1;
        assert_ne!(unsigned_macho(&changed).ok(),unsigned_macho(&thin(false)).ok());
        for length in 0..32 { assert!(unsigned_macho(&thin(false)[..length]).is_err()); }
    }
    #[test]
    fn refuses_self_reported_desired_policy() {
        let config = config();
        let mut descriptor = json!({"schema":"macos-app-unsigned","version":VERSION,"policy":{},"files":[]});
        descriptor["hostRevision"] = json!(digest(&serde_json::to_vec(&descriptor).unwrap()));
        assert!(checked_descriptor(&descriptor,&config).is_err());
        descriptor["version"] = json!(2); assert!(checked_descriptor(&descriptor,&config).is_err());
    }
    #[test]
    fn signature_resources_only_excluded_for_declared_bundles() {
        let bundles = BTreeSet::from([String::new()]);
        assert!(matches!(signature_resource("Contents/_CodeSignature/CodeResources",&bundles),Ok(true)));
        assert!(signature_resource("Contents/_CodeSignature/extra",&bundles).is_err());
        assert!(signature_resource("Contents/Helpers/evil.app/Contents/_CodeSignature/CodeResources",&bundles).is_err());
    }
    #[test]
    fn refuses_external_native_paths_and_escaping_resolution() {
        assert!(local_path("/nix/store/unpinned/lib.dylib","Contents/MacOS/host","Contents/MacOS/host").is_err());
        assert!(local_path("@loader_path/../../../escape","Contents/MacOS/host","Contents/MacOS/host").is_err());
        assert_eq!(local_path("@loader_path/../Frameworks/lib.dylib","Contents/MacOS/host","Contents/MacOS/host").ok(),Some("Contents/Frameworks/lib.dylib".to_owned()));
        assert!(!platform("/usr/lib/../../tmp/untrusted.dylib"));
        assert!(!platform("/System/Library//untrusted.dylib"));
        assert!(platform("/usr/lib/libSystem.B.dylib"));
    }
    #[test]
    fn refuses_fat_overlap_and_duplicate_architectures() {
        let slice = thin(false);
        let mut fat = vec![0u8;384];
        put_word(&mut fat,0,0xcafebabe,false); put_word(&mut fat,4,2,false);
        for (base,offset) in [(8,128),(28,256)] {
            put_word(&mut fat,base,0x01000007,false);
            put_word(&mut fat,base+8,offset,false);
            put_word(&mut fat,base+12,128,false);
            fat[offset as usize..offset as usize+128].copy_from_slice(&slice);
        }
        assert!(unsigned_macho(&fat).is_err());
        put_word(&mut fat,36,128,false);
        assert!(unsigned_macho(&fat).is_err());
    }
    #[test]
    fn referenced_zero_bytes_are_not_signing_padding() {
        let mut bytes = thin(false);
        bytes.resize(132,0);
        put_word(&mut bytes,16,2,true); put_word(&mut bytes,20,96,true);
        put_word(&mut bytes,104,0x2,true); put_word(&mut bytes,108,24,true);
        put_word(&mut bytes,120,128,true); put_word(&mut bytes,124,4,true);
        let canonical = match unsigned_macho(&bytes) { Ok(bytes) => bytes, Err(_) => panic!("valid string table rejected") };
        assert_eq!(canonical.len(),132);
        let mut malformed = bytes;
        put_word(&mut malformed,124,u32::MAX,true);
        assert!(unsigned_macho(&malformed).is_err());
    }
    #[test]
    fn refuses_writable_symlink_special_and_hardlink_layouts() {
        let file = u32::from(libc::S_IFREG);
        assert!(safe_layout(file | 0o444,1,true));
        assert!(safe_layout(file | 0o644,1,false));
        assert!(!safe_layout(file | 0o644,1,true));
        assert!(!safe_layout(file | 0o664,1,false));
        assert!(!safe_layout(file | 0o4755,1,false));
        assert!(!safe_layout(file | 0o444,2,true));
        assert!(!safe_layout(u32::from(libc::S_IFLNK) | 0o777,1,false));
        assert!(!safe_layout(u32::from(libc::S_IFIFO) | 0o444,1,true));
    }
    #[test]
    fn architecture_selectors_are_exact_and_unknowns_refused() {
        assert_eq!(architecture_name(0x0100_0007,3).ok(),Some("x86_64"));
        assert_eq!(architecture_name(0x0100_0007,8).ok(),Some("x86_64h"));
        assert_eq!(architecture_name(0x0100_000c,0).ok(),Some("arm64"));
        assert_eq!(architecture_name(0x0100_000c,0x8000_0002).ok(),Some("arm64e"));
        assert!(architecture_name(0x0100_000c,1).is_err());
        assert!(architecture_name(0,0).is_err());
        let mut bytes = thin(false);
        put_word(&mut bytes,8,3,true);
        assert_eq!(architecture_headers(&bytes).ok(),Some(vec!["x86_64".to_owned()]));
        assert!(architecture_headers(&bytes[..24]).is_err());
    }
    #[test]
    fn every_fat_architecture_is_selected_and_aliases_refused() {
        let mut fat = vec![0u8;384];
        put_word(&mut fat,0,0xcafebabe,false); put_word(&mut fat,4,2,false);
        for (base,offset,cpu,subtype) in [(8,128,0x0100_0007,3),(28,256,0x0100_000c,0)] {
            let mut slice = thin(false);
            put_word(&mut slice,4,cpu,true); put_word(&mut slice,8,subtype,true);
            put_word(&mut fat,base,cpu,false); put_word(&mut fat,base+4,subtype,false);
            put_word(&mut fat,base+8,offset,false); put_word(&mut fat,base+12,128,false);
            fat[offset as usize..offset as usize+128].copy_from_slice(&slice);
        }
        assert_eq!(architecture_headers(&fat).ok(),Some(vec!["arm64".to_owned(),"x86_64".to_owned()]));
        put_word(&mut fat,28,0x0100_0007,false); put_word(&mut fat,32,0x8000_0003,false);
        put_word(&mut fat,260,0x0100_0007,true); put_word(&mut fat,264,0x8000_0003,true);
        assert!(architecture_headers(&fat).is_err());
        put_word(&mut fat,36,128,false);
        assert!(architecture_headers(&fat).is_err());
    }
}
