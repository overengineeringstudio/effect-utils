use crate::SecurityError;
use std::ffi::{CString, c_void};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::ptr::NonNull;

type Result<T, E = SecurityError> = std::result::Result<T, E>;
type Ref = *const c_void;
const STRICT_NO_NETWORK: u32 = (1 << 4) | (1 << 29);
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithCString(allocator: Ref, text: *const libc::c_char, encoding: u32) -> Ref;
    fn CFURLCreateFromFileSystemRepresentation(allocator: Ref, path: *const u8, len: isize, directory: u8) -> Ref;
    fn CFRelease(value: Ref);
}
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SecRequirementCreateWithString(text: Ref, flags: u32, requirement: *mut Ref) -> i32;
    fn SecStaticCodeCreateWithPath(url: Ref, flags: u32, code: *mut Ref) -> i32;
    fn SecStaticCodeCheckValidity(code: Ref, flags: u32, requirement: Ref) -> i32;
    fn SecCodeCheckValidity(code: Ref, flags: u32, requirement: Ref) -> i32;
}
// This private boundary owns every Create-rule CF object and releases it exactly once.
struct Object(NonNull<c_void>);
impl Object {
    fn new(value: Ref) -> Result<Self> {
        NonNull::new(value.cast_mut()).map(Self).ok_or(SecurityError::Unavailable("Security returned a null object"))
    }
    fn as_ref(&self) -> Ref { self.0.as_ptr() }
}
impl Drop for Object {
    fn drop(&mut self) {
        // SAFETY: only retained Create-rule CF objects enter Object, and it has one owner.
        unsafe { CFRelease(self.as_ref()); }
    }
}
fn status(operation: &'static str, status: i32) -> Result<()> {
    if status == 0 { Ok(()) } else { Err(SecurityError::Security { operation, status }) }
}
/// An actual compiled Security.framework predicate; diagnostic text is not identity.
pub struct CompiledRequirement(Object);
// SAFETY: SecRequirement is immutable; CF supports concurrent retain/use of immutable objects.
unsafe impl Send for CompiledRequirement {}
// SAFETY: all verification calls only read the immutable compiled SecRequirement.
unsafe impl Sync for CompiledRequirement {}
impl CompiledRequirement {
    pub fn compile(text: &str) -> Result<Self> {
        if text.trim().is_empty() { return Err(SecurityError::InvalidInput("Empty requirement")); }
        let text = CString::new(text).map_err(|_| SecurityError::InvalidInput("NUL in requirement"))?;
        // SAFETY: CString lives through this call; UTF-8 encoding and null default allocator are CF ABI values.
        let text = Object::new(unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), 0x08000100) })?;
        let mut requirement = std::ptr::null();
        // SAFETY: retained CFString input and initialized output pointer satisfy the Security ABI.
        status("compileRequirement", unsafe { SecRequirementCreateWithString(text.as_ref(), 0, &mut requirement) })?;
        Ok(Self(Object::new(requirement)?))
    }
    /// Caller must protect the candidate from modification during and after verification.
    /// Checks all Mach-O architectures, sealed resources and nested code, without network access.
    pub fn verify_path(&self, path: &Path) -> Result<()> {
        let path = std::fs::canonicalize(path)?;
        let bytes = path.as_os_str().as_bytes();
        let len = isize::try_from(bytes.len()).map_err(|_| SecurityError::InvalidInput("Path too long"))?;
        // SAFETY: bytes and its explicit length remain live; CF copies the absolute filesystem representation.
        let url = Object::new(unsafe { CFURLCreateFromFileSystemRepresentation(std::ptr::null(), bytes.as_ptr(), len, u8::from(path.is_dir())) })?;
        let mut code = std::ptr::null();
        // SAFETY: URL is retained and output is initialized. Default create flags do not skip validation.
        status("createStaticCode", unsafe { SecStaticCodeCreateWithPath(url.as_ref(), 0, &mut code) })?;
        let code = Object::new(code)?;
        // SAFETY: both CF objects are retained for the entire validation call.
        status("verifyStaticCode", unsafe { SecStaticCodeCheckValidity(code.as_ref(), STRICT_NO_NETWORK | 1 | (1 << 3), self.0.as_ref()) })
    }
}
/// Darwin audit_token_t ABI. Only construct from kernel-supplied XPC/Mach/Unix transport evidence.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuditToken(pub [u32; 8]);
impl AuditToken {
    pub fn effective_uid(self) -> u32 { self.0[1] }
    pub fn real_uid(self) -> u32 { self.0[3] }
    pub fn pid(self) -> u32 { self.0[5] }
    pub fn pid_version(self) -> u32 { self.0[7] }
    pub fn from_stream(stream: &UnixStream) -> Result<Self> {
        let mut token = Self([0; 8]);
        let mut len = std::mem::size_of::<Self>() as libc::socklen_t;
        // SAFETY: LOCAL_PEERTOKEN (SOL_LOCAL=0, option=6) writes at most the supplied buffer length.
        if unsafe { libc::getsockopt(stream.as_raw_fd(), 0, 6, (&mut token as *mut Self).cast(), &mut len) } != 0 { return Err(std::io::Error::last_os_error().into()); }
        if len as usize != std::mem::size_of::<Self>() { return Err(SecurityError::InvalidInput("Truncated peer audit token")); }
        Ok(token)
    }
}
pub struct PeerPolicy<'a> { pub allowed_uids: &'a [u32], pub requirement: &'a CompiledRequirement }
/// Authenticated incarnation, not a permanent authorization grant. Recheck immediately before admission.
pub struct AuthenticatedPeer { token: AuditToken }
impl AuthenticatedPeer {
    pub fn token(&self) -> AuditToken { self.token }
    pub fn recheck_freshness(&self) -> Result<()> { freshness(self.token) }
}
type CreateToken = unsafe extern "C" fn(*const AuditToken, u32, *mut Ref) -> i32;
type CsopsToken = unsafe extern "C" fn(libc::pid_t, u32, *mut c_void, usize, *mut AuditToken) -> i32;
fn symbol(name: &'static std::ffi::CStr) -> Result<NonNull<c_void>> {
    // SAFETY: static NUL-terminated symbol name; RTLD_DEFAULT searches already loaded system libraries.
    NonNull::new(unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) }).ok_or(SecurityError::Unavailable(name.to_str().unwrap_or("Security SPI unavailable")))
}
fn freshness(mut token: AuditToken) -> Result<()> {
    let pid = libc::pid_t::try_from(token.pid()).map_err(|_| SecurityError::InvalidInput("Invalid audit PID"))?;
    if pid <= 0 { return Err(SecurityError::InvalidInput("Invalid audit PID")); }
    // SAFETY: the named Darwin SPI has the exact E4-tested csops_audittoken ABI. Missing SPI fails closed.
    let fresh: CsopsToken = unsafe { std::mem::transmute(symbol(c"csops_audittoken")?.as_ptr()) };
    let mut flags = 0u32;
    // SAFETY: flags and token are live correctly sized ABI outputs; kernel validates PID/incarnation.
    if unsafe { fresh(pid, 0, (&mut flags as *mut u32).cast(), std::mem::size_of::<u32>(), &mut token) } != 0 {
        return Err(SecurityError::StaleToken(std::io::Error::last_os_error()));
    }
    Ok(())
}
fn authorize_uid(token: AuditToken, allowed: &[u32]) -> Result<()> {
    if allowed.contains(&token.effective_uid()) && allowed.contains(&token.real_uid()) { Ok(()) } else { Err(SecurityError::UnauthorizedUid) }
}
/// Authenticate a kernel-supplied native transport token with conjunctive UID and compiled-code policy.
/// Native transports retain responsibility for message/connection liveness and token provenance.
pub fn authenticate_token(token: AuditToken, policy: PeerPolicy<'_>) -> Result<AuthenticatedPeer> {
    authorize_uid(token, policy.allowed_uids)?;
    freshness(token)?;
    // SAFETY: this dynamically resolved Security SPI uses the E4-tested audit-token ABI; no PID fallback.
    let create: CreateToken = unsafe { std::mem::transmute(symbol(c"SecCodeCreateWithAuditToken")?.as_ptr()) };
    let mut code = std::ptr::null();
    // SAFETY: token is a live audit_token_t and output is initialized for a retained SecCode.
    status("createAuditCode", unsafe { create(&token, 0, &mut code) })?;
    let code = Object::new(code)?;
    // SAFETY: both Security objects are retained and flags require strict, offline validation.
    status("verifyAuditCode", unsafe { SecCodeCheckValidity(code.as_ref(), STRICT_NO_NETWORK, policy.requirement.0.as_ref()) })?;
    freshness(token)?;
    Ok(AuthenticatedPeer { token })
}
/// Captures LOCAL_PEERTOKEN; callers must still reject EOF and recheck freshness at operation admission.
pub fn authenticate_peer(stream: &UnixStream, policy: PeerPolicy<'_>) -> Result<AuthenticatedPeer> {
    authenticate_token(AuditToken::from_stream(stream)?, policy)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uid_policy_refuses_before_security_lookup() {
        let token = AuditToken([0, 501, 0, 0, 0, 42, 0, 7]);
        assert!(matches!(authorize_uid(token, &[501]), Err(SecurityError::UnauthorizedUid)));
        assert!(matches!(authorize_uid(token, &[]), Err(SecurityError::UnauthorizedUid)));
        assert!(authorize_uid(token, &[0, 501]).is_ok());
    }
    #[test]
    fn token_preserves_incarnation() {
        let token = AuditToken([0, 501, 20, 501, 20, 42, 123, 456]);
        assert_eq!(token.pid(), 42);
        assert_eq!(token.pid_version(), 456);
        assert_eq!(std::mem::size_of::<AuditToken>(), 32);
    }
    #[test]
    fn empty_and_nul_requirements_refuse() {
        assert!(matches!(CompiledRequirement::compile("  "), Err(SecurityError::InvalidInput(_))));
        assert!(matches!(CompiledRequirement::compile("identifier \0 x"), Err(SecurityError::InvalidInput(_))));
    }
}
