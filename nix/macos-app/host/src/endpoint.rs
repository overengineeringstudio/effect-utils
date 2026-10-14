//! Descriptor-relative endpoint inspection and cleanup. Darwin has no bindat;
//! binding uses the verified absolute path while every ancestor descriptor is
//! retained and revalidated. Root and the selected owner are the trusted writers.
//! No process-wide chdir or umask changes are used. Directories must already exist.
use crate::SecurityError;
use std::ffi::{CString, c_void};
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Component, Path, PathBuf};

type Result<T, E = SecurityError> = std::result::Result<T, E>;
unsafe extern "C" {
    fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut c_void;
    fn acl_get_link_np(path: *const libc::c_char, kind: libc::c_int) -> *mut c_void;
    fn acl_get_entry(acl: *mut c_void, index: libc::c_int, entry: *mut *mut c_void) -> libc::c_int;
    fn acl_get_tag_type(entry: *mut c_void, tag: *mut libc::c_int) -> libc::c_int;
    fn acl_free(value: *mut c_void) -> libc::c_int;
}
#[derive(Clone, Copy, Debug)]
pub struct EndpointPolicy { pub owner_uid: u32, pub socket_mode: u32 }
fn validate_policy(policy: EndpointPolicy) -> Result<()> {
    if ![0o600, 0o660, 0o666].contains(&policy.socket_mode) { return Err(SecurityError::EndpointPolicy("Unsupported endpoint socket mode")); }
    Ok(())
}
fn names(path: &Path) -> Result<Vec<CString>> {
    if !path.is_absolute() { return Err(SecurityError::EndpointPolicy("Endpoint must be absolute")); }
    let mut names = Vec::new();
    for part in path.components() {
        match part {
            Component::RootDir => {},
            Component::Normal(name) => names.push(CString::new(name.as_bytes()).map_err(|_| SecurityError::EndpointPolicy("NUL in endpoint path"))?),
            _ => return Err(SecurityError::EndpointPolicy("Endpoint path must not contain dot components")),
        }
    }
    if names.is_empty() { return Err(SecurityError::EndpointPolicy("Endpoint needs a filename")); }
    // Path::components normalizes interior '.', so refuse it explicitly as well.
    if path.as_os_str().as_bytes().split(|b| *b == b'/').any(|s| s == b"." || s == b"..") { return Err(SecurityError::EndpointPolicy("Endpoint path must not contain dot components")); }
    Ok(names)
}
fn inspect_fd(fd: &File) -> Result<libc::stat> {
    // SAFETY: zeroed stat is an output buffer and fd remains owned by File.
    let mut stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd.as_raw_fd(), &mut stat) } != 0 { return Err(io::Error::last_os_error().into()); }
    Ok(stat)
}
fn inspect_at(parent: &File, name: &CString) -> Result<libc::stat> {
    // SAFETY: stat is a valid output; CString and parent live throughout the nofollow lookup.
    let mut stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(parent.as_raw_fd(), name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } != 0 { return Err(io::Error::last_os_error().into()); }
    Ok(stat)
}
fn identity(a: &libc::stat, b: &libc::stat) -> bool { a.st_dev == b.st_dev && a.st_ino == b.st_ino }
fn directory_policy(stat: &libc::stat, owner: u32, final_parent: bool) -> Result<()> {
    if stat.st_mode & libc::S_IFMT != libc::S_IFDIR { return Err(SecurityError::EndpointPolicy("Endpoint ancestor is not a directory")); }
    if stat.st_uid != 0 && stat.st_uid != owner { return Err(SecurityError::EndpointPolicy("Untrusted endpoint ancestor owner")); }
    if stat.st_mode & 0o022 != 0 { return Err(SecurityError::EndpointPolicy("Writable endpoint ancestor")); }
    if final_parent && stat.st_uid != owner { return Err(SecurityError::EndpointPolicy("Endpoint parent must belong to selected owner")); }
    Ok(())
}
fn acl_tag_policy(tag: libc::c_int) -> Result<()> {
    if tag == 2 { Ok(()) } else { Err(SecurityError::EndpointPolicy("Access-granting or unknown ACL entry")) }
}
fn check_acl(acl: *mut c_void) -> Result<()> {
    if acl.is_null() {
        let error = io::Error::last_os_error();
        // Darwin filesec_get_property reports ENOENT when the existing object's ACL is absent.
        if error.raw_os_error() == Some(libc::ENOENT) { return Ok(()); }
        return Err(error.into());
    }
    let result = (|| {
        let mut entry = std::ptr::null_mut();
        let mut index = 0; // ACL_FIRST_ENTRY; subsequent iteration uses ACL_NEXT_ENTRY=-1.
        loop {
            // SAFETY: caller passes a retained Darwin ACL; entry is a live output pointer.
            if unsafe { acl_get_entry(acl, index, &mut entry) } != 0 {
                let error = io::Error::last_os_error();
                // Darwin returns EINVAL when iteration reaches the end of this valid ACL.
                return if error.raw_os_error() == Some(libc::EINVAL) { Ok(()) } else { Err(error.into()) };
            }
            let mut tag = 0;
            // SAFETY: successful acl_get_entry returned a live entry within this retained ACL.
            if unsafe { acl_get_tag_type(entry, &mut tag) } != 0 { return Err(io::Error::last_os_error().into()); }
            acl_tag_policy(tag)?;
            index = -1;
        }
    })();
    // SAFETY: ACL is allocated by acl_get_* and freed once, after all inspection paths.
    unsafe { acl_free(acl); }
    result
}
/// For already opened nofollow objects, permit deny-only ACLs and reject every grant/unknown tag.
pub fn verify_acl_no_grants(file: &File) -> Result<()> {
    // SAFETY: File owns the descriptor; acl_get_fd_np returns an allocated Darwin extended ACL.
    check_acl(unsafe { acl_get_fd_np(file.as_raw_fd(), 0x100) })
}
struct Ancestor { file: File, stat: libc::stat }
fn open_ancestors(parts: Vec<CString>) -> Result<Vec<Ancestor>> {
    // SAFETY: static root path; successful descriptor is uniquely adopted by File.
    let root = unsafe { libc::open(c"/".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW) };
    if root < 0 { return Err(io::Error::last_os_error().into()); }
    // SAFETY: newly opened descriptor has exactly one owner.
    let root = unsafe { File::from_raw_fd(root) };
    let stat = inspect_fd(&root)?;
    let mut ancestors = vec![Ancestor { file: root, stat }];
    for part in parts {
        // SAFETY: parent is held and CString is live; nofollow forbids symlink traversal.
        let fd = unsafe { libc::openat(ancestors[ancestors.len() - 1].file.as_raw_fd(), part.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW) };
        if fd < 0 { return Err(io::Error::last_os_error().into()); }
        // SAFETY: newly opened descriptor has exactly one owner.
        let file = unsafe { File::from_raw_fd(fd) };
        let stat = inspect_fd(&file)?;
        ancestors.push(Ancestor { file, stat });
    }
    Ok(ancestors)
}
/// Preflight an existing owned destination directory and every nofollow ancestor.
/// This is a snapshot, not an exclusion lock; callers must protect subsequent mutations.
pub fn validate_directory(path: &Path, owner_uid: u32) -> Result<()> {
    let probe = path.join(".macos-app-directory-validation");
    let mut parts = names(&probe)?;
    parts.pop();
    let ancestors = open_ancestors(parts)?;
    let parts = names(&probe)?;
    for (index, ancestor) in ancestors.iter().enumerate() {
        let current = if index == 0 { inspect_fd(&ancestor.file)? } else { inspect_at(&ancestors[index - 1].file, &parts[index - 1])? };
        if !identity(&current, &ancestor.stat) { return Err(SecurityError::EndpointPolicy("Destination ancestor changed")); }
        directory_policy(&current, owner_uid, index + 1 == ancestors.len())?;
        verify_acl_no_grants(&ancestor.file)?;
    }
    Ok(())
}
/// Keeps verified ancestry and exclusive directory lock alive for endpoint lifetime.
pub struct EndpointGuard { path: PathBuf, name: CString, ancestors: Vec<Ancestor>, stat: Option<libc::stat>, policy: EndpointPolicy }
impl EndpointGuard {
    fn parent(&self) -> &File { &self.ancestors[self.ancestors.len() - 1].file }
    fn recheck(&self) -> Result<()> {
        let parts = names(&self.path)?;
        for (index, ancestor) in self.ancestors.iter().enumerate() {
            let current = if index == 0 { inspect_fd(&ancestor.file)? } else { inspect_at(&self.ancestors[index - 1].file, &parts[index - 1])? };
            if !identity(&current, &ancestor.stat) { return Err(SecurityError::EndpointPolicy("Endpoint ancestor changed")); }
            directory_policy(&current, self.policy.owner_uid, index + 1 == self.ancestors.len())?;
            verify_acl_no_grants(&ancestor.file)?;
        }
        Ok(())
    }
}
impl Drop for EndpointGuard {
    fn drop(&mut self) {
        if let Some(created) = &self.stat {
            if self.recheck().is_err() { return; }
            if let Ok(current) = inspect_at(self.parent(), &self.name) {
                if current.st_mode & libc::S_IFMT == libc::S_IFSOCK && current.st_uid == self.policy.owner_uid && identity(&current, created) {
                    // SAFETY: verified protected parent and same owned socket inode; unlink is descriptor relative.
                    unsafe { libc::unlinkat(self.parent().as_raw_fd(), self.name.as_ptr(), 0); }
                }
            }
        }
    }
}
fn socket_policy(stat: &libc::stat, policy: EndpointPolicy) -> Result<()> {
    if stat.st_mode & libc::S_IFMT != libc::S_IFSOCK || stat.st_uid != policy.owner_uid || stat.st_nlink != 1 {
        return Err(SecurityError::EndpointPolicy("Existing endpoint must be a singly linked owned socket"));
    }
    if u32::from(stat.st_mode & 0o777) != policy.socket_mode { return Err(SecurityError::EndpointPolicy("Existing endpoint mode differs from policy")); }
    Ok(())
}
/// Refuses unsafe ancestors, symlinks, ACL grants, foreign sockets and live listeners.
/// Stale removal requires ECONNREFUSED and a second identical inode/policy check.
pub fn bind(path: &Path, policy: EndpointPolicy) -> Result<(UnixListener, EndpointGuard)> {
    validate_policy(policy)?;
    let mut parts = names(path)?;
    let name = parts.pop().ok_or(SecurityError::EndpointPolicy("Missing endpoint filename"))?;
    let ancestors = open_ancestors(parts)?;
    let mut guard = EndpointGuard { path: path.to_owned(), name, ancestors, stat: None, policy };
    guard.recheck()?;
    // SAFETY: held parent descriptor; flock serializes cooperating helpers without a replaceable lockfile.
    if unsafe { libc::flock(guard.parent().as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 { return Err(io::Error::last_os_error().into()); }
    let cpath = CString::new(path.as_os_str().as_bytes()).map_err(|_| SecurityError::EndpointPolicy("NUL in endpoint path"))?;
    match inspect_at(guard.parent(), &guard.name) {
        Ok(old) => {
            socket_policy(&old, policy)?;
            // SAFETY: NUL-terminated verified absolute path; retrieves ACL without following symlinks.
            check_acl(unsafe { acl_get_link_np(cpath.as_ptr(), 0x100) })?;
            match UnixStream::connect(path) {
                Ok(_) => return Err(SecurityError::EndpointPolicy("A listener already owns the endpoint")),
                Err(e) if e.raw_os_error() == Some(libc::ECONNREFUSED) => {},
                Err(e) => return Err(e.into()),
            }
            guard.recheck()?;
            let current = inspect_at(guard.parent(), &guard.name)?;
            socket_policy(&current, policy)?;
            if !identity(&old, &current) { return Err(SecurityError::EndpointPolicy("Stale endpoint inode changed")); }
            // SAFETY: nofollow inspection proves the same socket in the exclusively held protected parent.
            if unsafe { libc::unlinkat(guard.parent().as_raw_fd(), guard.name.as_ptr(), 0) } != 0 { return Err(io::Error::last_os_error().into()); }
        }
        Err(SecurityError::Io(e)) if e.kind() == io::ErrorKind::NotFound => {},
        Err(e) => return Err(e),
    }
    guard.recheck()?;
    let listener = UnixListener::bind(path)?;
    // Capture inode before any fallible post-bind work so failure cleanup never deletes a replacement.
    let created = inspect_at(guard.parent(), &guard.name)?;
    if created.st_mode & libc::S_IFMT != libc::S_IFSOCK || created.st_uid != policy.owner_uid { return Err(SecurityError::EndpointPolicy("Bound endpoint identity differs")); }
    guard.stat = Some(created);
    guard.recheck()?;
    // SAFETY: nofollow fchmodat operates on the owned socket within the protected locked parent.
    if unsafe { libc::fchmodat(guard.parent().as_raw_fd(), guard.name.as_ptr(), policy.socket_mode as libc::mode_t, libc::AT_SYMLINK_NOFOLLOW) } != 0 { return Err(io::Error::last_os_error().into()); }
    let current = inspect_at(guard.parent(), &guard.name)?;
    if !identity(&created, &current) { return Err(SecurityError::EndpointPolicy("Bound endpoint inode changed")); }
    socket_policy(&current, policy)?;
    // SAFETY: verifies the new socket has no inherited ACL grants before returning it.
    check_acl(unsafe { acl_get_link_np(cpath.as_ptr(), 0x100) })?;
    let after_acl = inspect_at(guard.parent(), &guard.name)?;
    if !identity(&created, &after_acl) { return Err(SecurityError::EndpointPolicy("Endpoint changed during ACL check")); }
    Ok((listener, guard))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acl_policy_refuses_grants_and_unknown_tags_but_keeps_denials() {
        assert!(acl_tag_policy(1).is_err());
        assert!(acl_tag_policy(0).is_err());
        assert!(acl_tag_policy(3).is_err());
        assert!(acl_tag_policy(2).is_ok());
    }
    fn directory(uid: u32, mode: u16) -> libc::stat {
        // SAFETY: synthetic stat is used only by pure policy validation, never passed to OS.
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        stat.st_uid = uid; stat.st_mode = libc::S_IFDIR | mode; stat
    }
    #[test]
    fn refuses_unsafe_paths_and_modes() {
        for path in ["relative/socket", "/safe/../socket", "/safe/./socket", "/"] { assert!(names(Path::new(path)).is_err()); }
        assert!(validate_policy(EndpointPolicy { owner_uid: 501, socket_mode: 0o777 }).is_err());
    }
    #[test]
    fn refuses_foreign_writable_and_symlink_ancestors() {
        assert!(directory_policy(&directory(502, 0o755), 501, false).is_err());
        assert!(directory_policy(&directory(0, 0o777), 501, false).is_err());
        assert!(directory_policy(&directory(0, 0o755), 501, true).is_err());
        let mut link = directory(501, 0o700); link.st_mode = libc::S_IFLNK | 0o700;
        assert!(directory_policy(&link, 501, true).is_err());
        assert!(directory_policy(&directory(501, 0o700), 501, true).is_ok());
    }
    #[test]
    fn stale_cleanup_requires_owned_socket_mode_and_inode() {
        let policy = EndpointPolicy { owner_uid: 501, socket_mode: 0o600 };
        let mut socket = directory(501, 0o600); socket.st_mode = libc::S_IFSOCK | 0o600; socket.st_nlink = 1; socket.st_ino = 42;
        assert!(socket_policy(&socket, policy).is_ok());
        let mut other = socket; other.st_uid = 502; assert!(socket_policy(&other, policy).is_err());
        other = socket; other.st_mode = libc::S_IFREG | 0o600; assert!(socket_policy(&other, policy).is_err());
        other = socket; other.st_nlink = 2; assert!(socket_policy(&other, policy).is_err());
        other = socket; other.st_mode = libc::S_IFSOCK | 0o666; assert!(socket_policy(&other, policy).is_err());
        other = socket; other.st_ino += 1; assert!(!identity(&socket, &other));
    }
}
