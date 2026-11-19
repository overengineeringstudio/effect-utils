use std::ffi::OsString;
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;

/// Typed request for the fixed read-only namespace evidence mode. No executable,
/// URL, arbitrary process ID, or user-controlled manifest path is accepted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreRequest {
    pub candidate: PathBuf,
    pub device: u64,
    pub inode: u64,
    pub root_fd: i32,
    pub lease_fd: i32,
    pub nonce: String,
    pub client_start: u64,
}

fn decimal(value: OsString) -> Result<u64, &'static str> {
    let value = value.to_str().ok_or("non-UTF-8 numeric field")?;
    if value.is_empty()
        || value.len() > 20
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("noncanonical numeric field");
    }
    value.parse().map_err(|_| "numeric field overflow")
}

impl StoreRequest {
    /// Parse only the seven positional fields after the fixed mode selector.
    /// Filesystem authorization and caller/FD attestation are separate mandatory
    /// checks; successful parsing is never absence evidence.
    pub fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<Self, &'static str> {
        let mut arguments = arguments.into_iter();
        let candidate = arguments.next().ok_or("missing candidate")?;
        let bytes = candidate.as_os_str().as_bytes();
        if !bytes.starts_with(b"/")
            || bytes.len() > 4096
            || bytes.contains(&0)
            || bytes.contains(&b'\n')
            || bytes.contains(&b'\r')
            || bytes.contains(&b'\t')
            || bytes[1..].split(|byte| *byte == b'/').any(|component| {
                component.is_empty() || component == b"." || component == b".."
            })
        {
            return Err("noncanonical candidate");
        }
        let candidate = PathBuf::from(candidate);
        if candidate.file_name().and_then(|name| name.to_str()) != Some("pnpm-store-pure-v1")
            || candidate.parent().and_then(|path| path.file_name()).and_then(|name| name.to_str())
                != Some(".devenv")
        {
            return Err("not a historical worktree store");
        }
        let device = decimal(arguments.next().ok_or("missing device")?)?;
        let inode = decimal(arguments.next().ok_or("missing inode")?)?;
        let root_fd = i32::try_from(decimal(arguments.next().ok_or("missing root FD")?)?)
            .map_err(|_| "root FD overflow")?;
        let lease_fd = i32::try_from(decimal(arguments.next().ok_or("missing lease FD")?)?)
            .map_err(|_| "lease FD overflow")?;
        let nonce = arguments.next().ok_or("missing nonce")?.into_string()
            .map_err(|_| "non-UTF-8 nonce")?;
        if nonce.len() != 32 || !nonce.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
            return Err("noncanonical nonce");
        }
        let client_start = decimal(arguments.next().ok_or("missing client start")?)?;
        if inode == 0 || client_start == 0 || root_fd < 3 || lease_fd < 3 || root_fd == lease_fd {
            return Err("invalid admitted identity");
        }
        if arguments.next().is_some() {
            return Err("extra request field");
        }
        Ok(Self { candidate, device, inode, root_fd, lease_fd, nonce, client_start })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> Vec<OsString> {
        ["/srv/worktrees/repo/root/.devenv/pnpm-store-pure-v1", "43", "7", "8", "9", "0123456789abcdef0123456789abcdef", "42"]
            .into_iter().map(OsString::from).collect()
    }

    #[test]
    fn accepts_exact_canonical_fields_without_asserting_authority() {
        let request = StoreRequest::parse(fields()).unwrap();
        assert_eq!(request.device, 43);
        assert_eq!(request.inode, 7);
        assert_eq!(request.root_fd, 8);
        assert_eq!(request.lease_fd, 9);
    }

    #[test]
    fn rejects_extra_missing_or_noncanonical_fields() {
        for index in 0..7 {
            let mut input = fields();
            input.remove(index);
            assert!(StoreRequest::parse(input).is_err());
        }
        let mut extra = fields();
        extra.push("untrusted-command".into());
        assert!(StoreRequest::parse(extra).is_err());
        for index in [1, 2, 3, 4, 6] {
            for value in ["", "01", "+1", "-1", "1\n", "18446744073709551616"] {
                let mut input = fields();
                input[index] = value.into();
                assert!(StoreRequest::parse(input).is_err());
            }
        }
        for value in ["/home/a/../b/.devenv/pnpm-store-pure-v1", "/home//b/.devenv/pnpm-store-pure-v1", "/home/b/.devenv/pnpm-store-pure-v1/", "/home/b/.devenv/pnpm-store", "/home/b/not-devenv/pnpm-store-pure-v1"] {
            let mut input = fields();
            input[0] = value.into();
            assert!(StoreRequest::parse(input).is_err());
        }
    }

    #[test]
    fn rejects_unusable_or_confused_descriptor_identities() {
        for (index, value) in [(2, "0"), (3, "0"), (3, "2147483648"), (4, "8"), (6, "0"), (5, "0123456789ABCDEF0123456789ABCDEF")] {
            let mut input = fields();
            input[index] = value.into();
            assert!(StoreRequest::parse(input).is_err());
        }
    }
}
