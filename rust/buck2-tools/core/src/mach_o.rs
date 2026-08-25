//! Mach-O runtime observation for the mach-o-dynamic/v1 build-product contract.
//!
//! Shared by the product packager and the TypeScript bundler so both emit
//! descriptors whose runtime facts are observed from the exact payload bytes
//! rather than asserted by the caller.

use crate::{ToolError, ToolResult, safe_text};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn fail(code: &'static str, message: impl Into<String>) -> ToolError {
    ToolError::new(code, message)
}

fn be_u32(bytes: &[u8], offset: usize) -> ToolResult<u32> {
    let value: [u8; 4] = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| fail("BUCK2_PRODUCT_MACHO", "truncated Mach-O structure"))?
        .try_into()
        .unwrap();
    Ok(u32::from_be_bytes(value))
}

/// Read a NUL-terminated UTF-8 string starting at `offset`.
pub fn c_string(bytes: &[u8], offset: usize, field: &str) -> ToolResult<String> {
    let tail = bytes
        .get(offset..)
        .ok_or_else(|| fail("BUCK2_PRODUCT_BINARY", format!("invalid {field} offset")))?;
    let end = tail
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| fail("BUCK2_PRODUCT_BINARY", format!("unterminated {field}")))?;
    let value = std::str::from_utf8(&tail[..end])
        .map_err(|_| fail("BUCK2_PRODUCT_BINARY", format!("{field} is not UTF-8")))?;
    safe_text(value, field)
}

fn packed_version(value: u32) -> String {
    let major = value >> 16;
    let minor = (value >> 8) & 0xff;
    let patch = value & 0xff;
    if patch == 0 {
        format!("{major}.{minor}")
    } else {
        format!("{major}.{minor}.{patch}")
    }
}

fn is_ad_hoc_signature(bytes: &[u8], offset: usize, size: usize) -> ToolResult<bool> {
    let signature = bytes
        .get(offset..offset + size)
        .ok_or_else(|| fail("BUCK2_PRODUCT_MACHO", "truncated Mach-O code signature"))?;
    if be_u32(signature, 0)? != 0xfade_0cc0 {
        return Ok(false);
    }
    let declared_size = usize::try_from(be_u32(signature, 4)?)
        .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid code signature size"))?;
    let count = usize::try_from(be_u32(signature, 8)?)
        .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid code signature count"))?;
    if declared_size > signature.len()
        || 12usize.saturating_add(count.saturating_mul(8)) > declared_size
    {
        return Err(fail(
            "BUCK2_PRODUCT_MACHO",
            "malformed code signature superblob",
        ));
    }
    let mut ad_hoc_code_directory = false;
    for index in 0..count {
        let entry = 12 + index * 8;
        let slot = be_u32(signature, entry)?;
        let blob_offset = usize::try_from(be_u32(signature, entry + 4)?)
            .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid code signature offset"))?;
        if slot == 0x1_0000 {
            return Ok(false);
        }
        if slot == 0 || (0x1000..=0x1005).contains(&slot) {
            let magic = be_u32(signature, blob_offset)?;
            if !(0xfade_0c02..=0xfade_0c04).contains(&magic) {
                return Err(fail("BUCK2_PRODUCT_MACHO", "invalid CodeDirectory blob"));
            }
            ad_hoc_code_directory |= be_u32(signature, blob_offset + 12)? & 0x2 != 0;
        }
    }
    Ok(ad_hoc_code_directory)
}

/// List the load-command dylib names that fall outside the system
/// install-name policy (`/usr/lib` or `/System/Library`). Producers use this
/// to realize a portable payload before the full contract observation runs.
pub fn non_system_dylibs(bytes: &[u8]) -> ToolResult<Vec<String>> {
    if bytes.get(..4) != Some(&[0xcf, 0xfa, 0xed, 0xfe]) {
        return Err(fail(
            "BUCK2_PRODUCT_MACHO",
            "mach-o-dynamic/v1 requires a thin little-endian Mach-O 64 executable",
        ));
    }
    let command_count = usize::try_from(read_le_u32(bytes, 16)?)
        .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid load-command count"))?;
    let command_bytes = usize::try_from(read_le_u32(bytes, 20)?)
        .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid load-command size"))?;
    let mut names = Vec::new();
    let mut offset = 32usize;
    for _ in 0..command_count {
        let command = read_le_u32(bytes, offset)?;
        let size = usize::try_from(read_le_u32(bytes, offset + 4)?)
            .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid load-command size"))?;
        if size < 8 || offset + size > 32 + command_bytes {
            return Err(fail("BUCK2_PRODUCT_MACHO", "malformed Mach-O load command"));
        }
        match command {
            0x0c | 0x20 | 0x8000_0018 | 0x8000_001f | 0x8000_0023 => {
                let name_offset = usize::try_from(read_le_u32(bytes, offset + 8)?)
                    .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid dylib name offset"))?;
                let name = c_string(&bytes[offset..offset + size], name_offset, "Mach-O dylib")?;
                if !(name.starts_with("/usr/lib/") || name.starts_with("/System/Library/")) {
                    names.push(name);
                }
            }
            _ => {}
        }
        offset += size;
    }
    Ok(names)
}

/// Observe the mach-o-dynamic/v1 runtime facts of a thin little-endian
/// Mach-O 64 executable and reject anything outside the contract.
pub fn mach_o_runtime(bytes: &[u8], architecture: &str) -> ToolResult<Value> {
    if bytes.get(..4) != Some(&[0xcf, 0xfa, 0xed, 0xfe]) {
        return Err(fail(
            "BUCK2_PRODUCT_MACHO",
            "mach-o-dynamic/v1 requires a thin little-endian Mach-O 64 executable",
        ));
    }
    let observed_architecture = match u32::from_le_bytes(
        bytes
            .get(4..8)
            .ok_or_else(|| fail("BUCK2_PRODUCT_MACHO", "truncated Mach-O header"))?
            .try_into()
            .unwrap(),
    ) {
        0x0100_0007 => "x86_64",
        0x0100_000c => "arm64",
        value => {
            return Err(fail(
                "BUCK2_PRODUCT_MACHO",
                format!("unsupported Mach-O CPU type: {value:#x}"),
            ));
        }
    };
    let expected_architecture = match architecture {
        "x86_64" => "x86_64",
        "aarch64" => "arm64",
        value => {
            return Err(fail(
                "BUCK2_PRODUCT_PLATFORM",
                format!("unsupported Darwin architecture: {value}"),
            ));
        }
    };
    if observed_architecture != expected_architecture {
        return Err(fail(
            "BUCK2_PRODUCT_PLATFORM",
            "Mach-O architecture does not match platform architecture",
        ));
    }
    let command_count = usize::try_from(read_le_u32(bytes, 16)?)
        .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid load-command count"))?;
    let command_bytes = usize::try_from(read_le_u32(bytes, 20)?)
        .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid load-command size"))?;
    bytes
        .get(32..32 + command_bytes)
        .ok_or_else(|| fail("BUCK2_PRODUCT_MACHO", "truncated Mach-O load commands"))?;
    let mut offset = 32usize;
    let mut dylibs = BTreeSet::new();
    let mut minimum_os = None;
    let mut signature = None;
    for _ in 0..command_count {
        let command = read_le_u32(bytes, offset)?;
        let size = usize::try_from(read_le_u32(bytes, offset + 4)?)
            .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid load-command size"))?;
        if size < 8 || offset + size > 32 + command_bytes {
            return Err(fail("BUCK2_PRODUCT_MACHO", "malformed Mach-O load command"));
        }
        match command {
            0x0c | 0x20 | 0x8000_0018 | 0x8000_001f | 0x8000_0023 => {
                let name_offset = usize::try_from(read_le_u32(bytes, offset + 8)?)
                    .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid dylib name offset"))?;
                if name_offset >= size {
                    return Err(fail("BUCK2_PRODUCT_MACHO", "invalid dylib name offset"));
                }
                let name = c_string(&bytes[offset..offset + size], name_offset, "Mach-O dylib")?;
                if !(name.starts_with("/usr/lib/") || name.starts_with("/System/Library/")) {
                    return Err(fail(
                        "BUCK2_PRODUCT_MACHO",
                        format!("Mach-O dylib is outside the system install-name policy: {name}"),
                    ));
                }
                dylibs.insert(name);
            }
            0x8000_001c => {
                return Err(fail(
                    "BUCK2_PRODUCT_MACHO",
                    "mach-o-dynamic/v1 forbids LC_RPATH",
                ));
            }
            0x1d => {
                if signature.is_some() {
                    return Err(fail("BUCK2_PRODUCT_MACHO", "duplicate LC_CODE_SIGNATURE"));
                }
                signature = Some((
                    usize::try_from(read_le_u32(bytes, offset + 8)?)
                        .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid signature offset"))?,
                    usize::try_from(read_le_u32(bytes, offset + 12)?)
                        .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid signature size"))?,
                ));
            }
            0x32 => {
                if minimum_os.is_some() || read_le_u32(bytes, offset + 8)? != 1 {
                    return Err(fail(
                        "BUCK2_PRODUCT_MACHO",
                        "Mach-O must contain exactly one macOS LC_BUILD_VERSION",
                    ));
                }
                minimum_os = Some(packed_version(read_le_u32(bytes, offset + 12)?));
            }
            _ => {}
        }
        offset += size;
    }
    if offset != 32 + command_bytes {
        return Err(fail("BUCK2_PRODUCT_MACHO", "load-command size mismatch"));
    }
    let (signature_offset, signature_size) = signature
        .filter(|(_, size)| *size > 0)
        .ok_or_else(|| fail("BUCK2_PRODUCT_MACHO", "Mach-O has no code signature"))?;
    if !is_ad_hoc_signature(bytes, signature_offset, signature_size)? {
        return Err(fail(
            "BUCK2_PRODUCT_MACHO",
            "Mach-O signature is not ad hoc",
        ));
    }
    Ok(json!({
        "architecture": observed_architecture,
        "dylibs": dylibs,
        "inspectionContract": "mach-o-dynamic/v1",
        "installNamePolicy": "system-only/v1",
        "kind": "mach-o-dynamic",
        "minimumOs": minimum_os.ok_or_else(|| fail("BUCK2_PRODUCT_MACHO", "Mach-O has no LC_BUILD_VERSION"))?,
        "rpathPolicy": "empty/v1",
        "signingPolicy": "adhoc/v1",
    }))
}

fn read_le_u32(bytes: &[u8], offset: usize) -> ToolResult<u32> {
    let value: [u8; 4] = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| fail("BUCK2_PRODUCT_MACHO", "truncated Mach-O structure"))?
        .try_into()
        .unwrap();
    Ok(u32::from_le_bytes(value))
}
