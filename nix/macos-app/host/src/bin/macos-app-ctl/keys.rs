//! Signing-key provisioning primitives: create the dedicated keychain and a non-extractable
//! key, import the certificate issued for it, and prove the key's protections. Every keychain
//! call runs in-process with user interaction disabled, so a would-be prompt fails instead of
//! showing UI; the password arrives only on a descriptor and never reaches argv or a child.
use super::*;
#[cfg(feature = "test-signing-cert")]
#[path = "test_certificate.rs"]
mod test_certificate;

type Ref = *const c_void;
const UTF8: u32 = 0x0800_0100;
const ITEM_NOT_FOUND: i32 = -25300;
const DUPLICATE_ITEM: i32 = -25299;
const PKCS12: u32 = 12;
/// Keychain auto-lock interval in seconds (`security set-keychain-settings -lut 300`).
const LOCK_INTERVAL: u32 = 300;
/// The partition ID securityd assigns `/usr/bin/codesign`: Apple-signed binaries get `apple:`
/// (`security` alone gets `apple-tool:`, others `teamid:`/`cdhash:`/`unsigned:`; nothing is ever
/// assigned `codesign:`). A caller outside the list triggers a confirmation prompt on use.
const CODESIGN_PARTITION: &str = "apple:";
/// Only the feature-built test executable can select the injected PATH shim. Production always
/// executes the same absolute Apple binary that the signing ACL guard identifies.
pub(super) fn codesign_program() -> &'static str {
    #[cfg(feature = "test-signing-cert")]
    { "codesign" }
    #[cfg(not(feature = "test-signing-cert"))]
    { CODESIGN }
}
/// Upper bound for one signing `codesign` run; a run blocked on a confirmation is killed.
pub(super) const SIGN_DEADLINE: Duration = Duration::from_secs(30);
const CODESIGN: &str = "/usr/bin/codesign";
/// `kSecUnlockStateStatus` bit of `SecKeychainGetStatus`.
const UNLOCK_STATE: u32 = 1;

#[allow(non_upper_case_globals)]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFBooleanTrue: Ref;
    static kCFBooleanFalse: Ref;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
    static kCFTypeArrayCallBacks: c_void;
    fn CFDictionaryCreate(allocator: Ref, keys: *const Ref, values: *const Ref, count: isize, key_callbacks: *const c_void, value_callbacks: *const c_void) -> Ref;
    fn CFArrayCreate(allocator: Ref, values: *const Ref, count: isize, callbacks: *const c_void) -> Ref;
    fn CFStringCreateWithBytes(allocator: Ref, bytes: *const u8, count: isize, encoding: u32, external: u8) -> Ref;
    fn CFNumberCreate(allocator: Ref, kind: isize, value: *const c_void) -> Ref;
    fn CFDataCreate(allocator: Ref, bytes: *const u8, count: isize) -> Ref;
    fn CFDataGetBytePtr(data: Ref) -> *const u8;
    fn CFDataGetLength(data: Ref) -> isize;
    fn CFGetTypeID(value: Ref) -> usize;
    fn CFArrayGetTypeID() -> usize;
    fn CFDictionaryGetTypeID() -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFArrayGetCount(array: Ref) -> isize;
    fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
    fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
    fn CFStringGetLength(string: Ref) -> isize;
    fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    fn CFStringGetCString(string: Ref, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
    fn CFPropertyListCreateData(allocator: Ref, plist: Ref, format: isize, options: usize, error: *mut Ref) -> Ref;
    fn CFPropertyListCreateWithData(allocator: Ref, data: Ref, options: usize, format: *mut isize, error: *mut Ref) -> Ref;
    fn CFErrorCopyDescription(error: Ref) -> Ref;
    fn CFRetain(value: Ref) -> Ref;
    fn CFURLCreateFromFileSystemRepresentation(allocator: Ref, path: *const u8, length: isize, directory: u8) -> Ref;
}

#[allow(non_upper_case_globals)]
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    static kSecClass: Ref;
    static kSecClassKey: Ref;
    static kSecClassIdentity: Ref;
    static kSecClassCertificate: Ref;
    static kSecAttrKeyClass: Ref;
    static kSecAttrKeyClassPrivate: Ref;
    static kSecAttrKeyType: Ref;
    static kSecAttrKeyTypeRSA: Ref;
    static kSecAttrKeySizeInBits: Ref;
    static kSecAttrIsPermanent: Ref;
    static kSecAttrIsExtractable: Ref;
    static kSecAttrLabel: Ref;
    static kSecUseKeychain: Ref;
    static kSecAttrAccess: Ref;
    static kSecMatchSearchList: Ref;
    static kSecMatchLimit: Ref;
    static kSecMatchLimitAll: Ref;
    static kSecReturnRef: Ref;
    static kSecReturnAttributes: Ref;
    static kSecValueRef: Ref;
    static kSecKeyAlgorithmRSASignatureMessagePKCS1v15SHA256: Ref;
    static kSecACLAuthorizationPartitionID: Ref;
    static kSecACLAuthorizationSign: Ref;
    static kSecCodeInfoUnique: Ref;
    fn SecStaticCodeCreateWithPath(path: Ref, flags: u32, code: *mut Ref) -> i32;
    fn SecCodeCopySigningInformation(code: Ref, flags: u32, information: *mut Ref) -> i32;
    fn SecKeychainCreate(path: *const c_char, length: u32, password: *const c_void, prompt: u8, access: Ref, keychain: *mut Ref) -> i32;
    fn SecKeychainSetSettings(keychain: Ref, settings: *const Settings) -> i32;
    fn SecKeychainGetStatus(keychain: Ref, status: *mut u32) -> i32;
    fn SecKeychainCopySettings(keychain: Ref, settings: *mut Settings) -> i32;
    fn SecTrustedApplicationCreateFromPath(path: *const c_char, application: *mut Ref) -> i32;
    fn SecTrustedApplicationCopyData(application: Ref, data: *mut Ref) -> i32;
    fn SecAccessCreate(descriptor: Ref, trusted: Ref, access: *mut Ref) -> i32;
    fn SecKeyCreateRandomKey(parameters: Ref, error: *mut Ref) -> Ref;
    fn SecKeyCopyPublicKey(key: Ref) -> Ref;
    fn SecKeyCopyExternalRepresentation(key: Ref, error: *mut Ref) -> Ref;
    fn SecKeyCreateSignature(key: Ref, algorithm: Ref, data: Ref, error: *mut Ref) -> Ref;
    fn SecKeyGetCSSMKey(key: Ref, cssm_key: *mut *const CssmKeyHeaderPrefix) -> i32;
    fn SecItemCopyMatching(query: Ref, result: *mut Ref) -> i32;
    fn SecItemAdd(attributes: Ref, result: *mut Ref) -> i32;
    fn SecItemExport(item: Ref, format: u32, flags: u32, parameters: *const ExportParameters, data: *mut Ref) -> i32;
    fn SecCertificateCreateWithData(allocator: Ref, data: Ref) -> Ref;
    fn SecCertificateCopyData(certificate: Ref) -> Ref;
    fn SecCertificateCopyKey(certificate: Ref) -> Ref;
    fn SecCertificateCopySubjectSummary(certificate: Ref) -> Ref;
    fn SecIdentityCreateWithCertificate(keychain: Ref, certificate: Ref, identity: *mut Ref) -> i32;
    fn SecIdentityCopyPrivateKey(identity: Ref, key: *mut Ref) -> i32;
    fn SecIdentityCopyCertificate(identity: Ref, certificate: *mut Ref) -> i32;
    fn SecKeychainItemCopyAccess(item: Ref, access: *mut Ref) -> i32;
    fn SecKeychainItemSetAccessWithPassword(item: Ref, access: Ref, length: u32, password: *const c_void) -> i32;
    fn SecAccessCopyMatchingACLList(access: Ref, tag: Ref) -> Ref;
    fn SecACLCopyContents(acl: Ref, applications: *mut Ref, description: *mut Ref, prompt: *mut u16) -> i32;
    fn SecACLSetContents(acl: Ref, applications: Ref, description: Ref, prompt: u16) -> i32;
    static kSecPolicyAppleCodeSigning: Ref;
    fn SecPolicyCreateWithProperties(identifier: Ref, properties: Ref) -> Ref;
    fn SecTrustCreateWithCertificates(certificates: Ref, policies: Ref, trust: *mut Ref) -> i32;
    fn SecTrustSetNetworkFetchAllowed(trust: Ref, allowed: u8) -> i32;
    fn SecTrustEvaluateWithError(trust: Ref, error: *mut Ref) -> bool;
    #[cfg(feature = "test-signing-cert")]
    fn SecCertificateCopyNormalizedIssuerSequence(certificate: Ref) -> Ref;
    #[cfg(feature = "test-signing-cert")]
    fn SecCertificateCopyNormalizedSubjectSequence(certificate: Ref) -> Ref;
    #[cfg(feature = "test-signing-cert")]
    fn SecTrustSetAnchorCertificates(trust: Ref, certificates: Ref) -> i32;
}
unsafe extern "C" {
    fn CC_SHA1(data: *const c_void, length: u32, digest: *mut u8) -> *mut u8;
}

#[repr(C)]
struct Settings { version: u32, lock_on_sleep: u8, use_lock_interval: u8, lock_interval: u32 }
#[repr(C)]
struct ExportParameters { version: u32, flags: u32, passphrase: Ref, alert_title: Ref, alert_prompt: Ref, access: Ref, key_usage: Ref, key_attributes: Ref }
/// Prefix of CSSM_KEYHEADER through KeyAttr, from cssmtype.h. SecKeyGetCSSMKey returns a
/// borrowed CSSM_KEY whose first member is this header; no key material is read.
#[repr(C)]
struct CssmKeyHeaderPrefix {
    version: u32, csp_id: [u8; 16], blob_type: u32, format: u32, algorithm: u32,
    key_class: u32, logical_bits: u32, attributes: u32,
}

/// An owned Core Foundation reference, released exactly once.
struct Cf(Ref);
impl Drop for Cf {
    // SAFETY: Cf only wraps non-null references it owns (create/copy rule).
    fn drop(&mut self) { unsafe { CFRelease(self.0) } }
}
fn owned(value: Ref, what: &str) -> Result<Cf> {
    if value.is_null() { Err(fail(23, "operation-failed", format!("{what} returned no value"))) } else { Ok(Cf(value)) }
}
fn checked_status(status: i32, what: &str) -> Result<()> {
    match status {
        0 => Ok(()),
        -25308 => Err(fail(23, "operation-failed", format!("{what}: user interaction required and refused (errSecInteractionNotAllowed); nothing was prompted"))),
        _ => Err(fail(23, "operation-failed", format!("{what} status {status}"))),
    }
}
fn cf_failure(error: Ref, what: &str) -> Failure {
    if error.is_null() { return fail(23, "operation-failed", format!("{what} failed")); }
    let error = Cf(error);
    // SAFETY: error is a live CFError; the description follows the copy rule.
    let description = owned(unsafe { CFErrorCopyDescription(error.0) }, "CFErrorCopyDescription").ok().and_then(|d| string(d.0));
    fail(23, "operation-failed", format!("{what}: {}", description.unwrap_or_default()))
}
fn cf_string(value: &str) -> Result<Cf> {
    let length = isize::try_from(value.len()).map_err(|_| fail(64, "invalid-input", "String too long"))?;
    // SAFETY: the bytes are valid for length; CF copies them.
    owned(unsafe { CFStringCreateWithBytes(std::ptr::null(), value.as_ptr(), length, UTF8, 0) }, "CFStringCreateWithBytes")
}
fn cf_data(bytes: &[u8]) -> Result<Cf> {
    let length = isize::try_from(bytes.len()).map_err(|_| fail(64, "invalid-input", "Data too long"))?;
    // SAFETY: the bytes are valid for length; CF copies them.
    owned(unsafe { CFDataCreate(std::ptr::null(), bytes.as_ptr(), length) }, "CFDataCreate")
}
fn cf_i32(value: i32) -> Result<Cf> {
    // SAFETY: kCFNumberSInt32Type (3) reads exactly one i32 from the pointer.
    owned(unsafe { CFNumberCreate(std::ptr::null(), 3, (&raw const value).cast()) }, "CFNumberCreate")
}
fn cf_dictionary(pairs: &[(Ref, Ref)]) -> Result<Cf> {
    let (keys, values): (Vec<Ref>, Vec<Ref>) = pairs.iter().copied().unzip();
    // SAFETY: both arrays hold pairs.len() live CF references; CF retains them.
    owned(unsafe { CFDictionaryCreate(std::ptr::null(), keys.as_ptr(), values.as_ptr(), pairs.len() as isize, &raw const kCFTypeDictionaryKeyCallBacks, &raw const kCFTypeDictionaryValueCallBacks) }, "CFDictionaryCreate")
}
fn cf_array(values: &[Ref]) -> Result<Cf> {
    // SAFETY: values holds values.len() live CF references; CF retains them.
    owned(unsafe { CFArrayCreate(std::ptr::null(), values.as_ptr(), values.len() as isize, &raw const kCFTypeArrayCallBacks) }, "CFArrayCreate")
}
fn bytes(data: Ref) -> Vec<u8> {
    // SAFETY: data is a live CFData; the pointer is valid for its length while it lives.
    unsafe { std::slice::from_raw_parts(CFDataGetBytePtr(data), CFDataGetLength(data) as usize).to_vec() }
}
fn string(value: Ref) -> Option<String> {
    // SAFETY: type-checked CFString; the buffer is sized for the worst-case UTF-8 encoding.
    unsafe {
        if value.is_null() || CFGetTypeID(value) != CFStringGetTypeID() { return None; }
        let size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(value), UTF8) + 1;
        let mut buffer = vec![0u8; usize::try_from(size).ok()?];
        if CFStringGetCString(value, buffer.as_mut_ptr().cast(), size, UTF8) == 0 { return None; }
        let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
        String::from_utf8(buffer[..end].to_vec()).ok()
    }
}
/// Borrowed elements of a CFArray (owned by the array).
fn elements(array: Ref) -> Vec<Ref> {
    // SAFETY: type-checked CFArray; indices are within its count.
    unsafe {
        if array.is_null() || CFGetTypeID(array) != CFArrayGetTypeID() { return Vec::new(); }
        (0..CFArrayGetCount(array)).map(|i| CFArrayGetValueAtIndex(array, i)).collect()
    }
}
fn sha1(data: &[u8]) -> String {
    let mut digest = [0u8; 20];
    // SAFETY: CC_SHA1 reads len bytes and writes exactly 20 digest bytes.
    unsafe { CC_SHA1(data.as_ptr().cast(), data.len() as u32, digest.as_mut_ptr()) };
    hex(&digest)
}
fn sha256(data: &[u8]) -> String { use sha2::Digest; format!("{:x}", sha2::Sha256::digest(data)) }
fn hex(data: &[u8]) -> String { data.iter().map(|b| format!("{b:02x}")).collect() }
fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 { return None; }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok()).collect()
}
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn base64(data: &[u8]) -> String {
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..4 { out.push(if i <= chunk.len() { BASE64[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' }); }
    }
    out
}
fn unbase64(text: &str) -> Option<Vec<u8>> {
    let digits: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if digits.len() % 4 != 0 { return None; }
    let mut out = Vec::new();
    for chunk in digits.chunks(4) {
        let pad = chunk.iter().rev().take_while(|b| **b == b'=').count();
        if pad > 2 { return None; }
        let mut n = 0u32;
        for b in &chunk[..4 - pad] { n = n << 6 | BASE64.iter().position(|d| d == b)? as u32; }
        n <<= 6 * pad as u32;
        out.extend(n.to_be_bytes()[1..4 - pad].iter());
    }
    Some(out)
}
fn pem(label: &str, der: &[u8]) -> String {
    let body = base64(der);
    let lines: Vec<&str> = body.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect();
    format!("-----BEGIN {label}-----\n{}\n-----END {label}-----\n", lines.join("\n"))
}
/// A certificate file as DER: PEM `CERTIFICATE` armour is decoded, anything else is taken as DER.
fn certificate_der(file: &[u8]) -> Result<Vec<u8>> {
    let invalid = || fail(64, "invalid-input", "Certificate PEM is malformed");
    let Ok(text) = std::str::from_utf8(file) else { return Ok(file.to_vec()) };
    let Some(start) = text.find("-----BEGIN CERTIFICATE-----") else { return Ok(file.to_vec()) };
    let body = &text[start + 27..];
    let end = body.find("-----END CERTIFICATE-----").ok_or_else(invalid)?;
    unbase64(&body[..end]).ok_or_else(invalid)
}

// Minimal DER for a PKCS#10 request: SEQUENCE, SET, INTEGER 0, OIDs, UTF8String, BIT STRING.
fn der(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    match content.len() {
        n if n < 0x80 => out.push(n as u8),
        n => {
            let length = (n as u64).to_be_bytes();
            let first = length.iter().position(|b| *b != 0).unwrap_or(7);
            out.push(0x80 | (8 - first) as u8);
            out.extend(&length[first..]);
        }
    }
    out.extend(content);
    out
}
fn sequence(parts: &[&[u8]]) -> Vec<u8> { der(0x30, &parts.concat()) }
fn bit_string(content: &[u8]) -> Vec<u8> { der(0x03, &[&[0u8][..], content].concat()) }
const RSA_ENCRYPTION: &[u8] = &[0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const SHA256_WITH_RSA: &[u8] = &[0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b];
const COMMON_NAME: &[u8] = &[0x06, 0x03, 0x55, 0x04, 0x03];
const DER_NULL: &[u8] = &[0x05, 0x00];
/// SubjectPublicKeyInfo for a PKCS#1 RSAPublicKey (SecKeyCopyExternalRepresentation's RSA form).
fn subject_public_key_info(pkcs1: &[u8]) -> Vec<u8> { sequence(&[&sequence(&[RSA_ENCRYPTION, DER_NULL]), &bit_string(pkcs1)]) }
/// The CertificationRequestInfo that the key signs: version 0, CN subject, key, no attributes.
fn request_info(common_name: &str, spki: &[u8]) -> Vec<u8> {
    let name = sequence(&[&der(0x31, &sequence(&[COMMON_NAME, &der(0x0c, common_name.as_bytes())]))]);
    sequence(&[&[0x02, 0x01, 0x00], &name, spki, &[0xa0, 0x00]])
}
fn certification_request(info: &[u8], signature: &[u8]) -> Vec<u8> { sequence(&[info, &sequence(&[SHA256_WITH_RSA, DER_NULL]), &bit_string(signature)]) }

/// The dedicated keychain path: absolute, `.keychain-db`, in a per-user `Library/Keychains`
/// directory, never the login keychain.
fn dedicated_keychain(ctl: &Ctl) -> Result<PathBuf> {
    let raw = PathBuf::from(ctl.arg("keychain")?);
    let name = raw.file_name().and_then(|n| n.to_str()).filter(|n| n.ends_with(".keychain-db"));
    let (Some(name), true) = (name, raw.is_absolute()) else { return Err(fail(64, "invalid-input", "--keychain must be an absolute .keychain-db path")) };
    let parent = raw.parent().ok_or_else(|| fail(64, "invalid-input", "Keychain requires a parent directory"))?;
    let parent = fs::canonicalize(parent).map_err(|e| fail(64, "invalid-input", format!("Keychain directory: {e}")))?;
    if !partition_capable(&parent) {
        return Err(fail(64, "invalid-input", "The keychain directory must be a per-user Library/Keychains directory; securityd only creates partition-ID (and integrity) ACLs for keychains there"));
    }
    let resolved = parent.join(name);
    if is_login_keychain(&resolved) || is_login_keychain(&fs::canonicalize(&resolved).unwrap_or_else(|_| resolved.clone())) {
        return Err(fail(64, "invalid-input", "The login keychain is never used for signing"));
    }
    Ok(resolved)
}
/// securityd creates partition-version keychains only in a `…/Library/Keychains` directory that is
/// not `/Library/Keychains` or `/System/Library/Keychains`; elsewhere keys get no partition list.
pub(super) fn partition_capable(directory: &Path) -> bool {
    directory.ends_with("Library/Keychains") && !directory.starts_with("/Library") && !directory.starts_with("/System")
}
fn keychain_ref(keychain: &Keychain) -> Ref { keychain.0.cast_const() }
fn search_list(keychain: &Keychain) -> Result<Cf> { cf_array(&[keychain_ref(keychain)]) }
fn matching(query: &Cf) -> Result<Option<Cf>> {
    let mut result = std::ptr::null();
    // SAFETY: query is a live dictionary; result follows the copy rule.
    match unsafe { SecItemCopyMatching(query.0, &mut result) } {
        ITEM_NOT_FOUND => Ok(None),
        status => { checked_status(status, "SecItemCopyMatching")?; owned(result, "SecItemCopyMatching").map(Some) }
    }
}
/// Labels of the private keys already in the keychain (attributes only; no key is used).
fn private_key_labels(keychain: &Keychain) -> Result<Vec<String>> {
    let list = search_list(keychain)?;
    // SAFETY: the Security constants are immutable framework globals.
    let query = unsafe { cf_dictionary(&[(kSecClass, kSecClassKey), (kSecAttrKeyClass, kSecAttrKeyClassPrivate), (kSecMatchSearchList, list.0), (kSecMatchLimit, kSecMatchLimitAll), (kSecReturnAttributes, kCFBooleanTrue)])? };
    let Some(found) = matching(&query)? else { return Ok(Vec::new()) };
    // SAFETY: each element is a live attribute dictionary owned by `found`.
    Ok(elements(found.0).into_iter().map(|attributes| unsafe { string(CFDictionaryGetValue(attributes, kSecAttrLabel)) }.unwrap_or_default()).collect())
}
fn public_key_pkcs1(key: Ref) -> Result<Vec<u8>> {
    // SAFETY: key is a live SecKey; both results follow the copy rule.
    let public = owned(unsafe { SecKeyCopyPublicKey(key) }, "SecKeyCopyPublicKey")?;
    let mut error = std::ptr::null();
    let data = unsafe { SecKeyCopyExternalRepresentation(public.0, &mut error) };
    if data.is_null() { return Err(cf_failure(error, "SecKeyCopyExternalRepresentation")); }
    Ok(bytes(Cf(data).0))
}
/// The key's initial ACL trusts this process (to sign the CSR during provisioning) and
/// `/usr/bin/codesign`. securityd refuses removing this process later, so it stays in the signing
/// ACL, recorded exactly in the ACL record; the `[apple:]` partition keeps it from using the key.
fn initial_access(descriptor: &Cf) -> Result<Cf> {
    let mut current = std::ptr::null();
    // SAFETY: a null path names the calling application; it follows the create rule.
    checked_status(unsafe { SecTrustedApplicationCreateFromPath(std::ptr::null(), &mut current) }, "SecTrustedApplicationCreateFromPath")?;
    let current = owned(current, "SecTrustedApplicationCreateFromPath")?;
    let codesign = codesign_application()?;
    let trusted = cf_array(&[current.0, codesign.0])?;
    let mut access = std::ptr::null();
    // SAFETY: descriptor and trusted are live; the access follows the create rule.
    checked_status(unsafe { SecAccessCreate(descriptor.0, trusted.0, &mut access) }, "SecAccessCreate")?;
    owned(access, "SecAccessCreate")
}
fn create_key(keychain: &Keychain, label: &str) -> Result<Cf> {
    let label = cf_string(label)?;
    let access = initial_access(&label)?;
    let bits = cf_i32(2048)?;
    // The CDSA/file-keychain branch of SecKeyCreateRandomKey passes only the top-level
    // dictionary to GetKeyParameters; nested private/public attributes are ignored there.
    // Public keys are always extractable; false here applies only to the private key.
    // SAFETY: every value is a live CF reference or immutable framework constant.
    let parameters = unsafe {
        cf_dictionary(&[(kSecAttrKeyType, kSecAttrKeyTypeRSA), (kSecAttrKeySizeInBits, bits.0),
            (kSecUseKeychain, keychain_ref(keychain)), (kSecAttrAccess, access.0),
            (kSecAttrIsPermanent, kCFBooleanTrue), (kSecAttrIsExtractable, kCFBooleanFalse),
            (kSecAttrLabel, label.0)])?
    };
    let mut error = std::ptr::null();
    // SAFETY: parameters is a live dictionary; the key follows the create rule.
    let key = unsafe { SecKeyCreateRandomKey(parameters.0, &mut error) };
    if key.is_null() { return Err(cf_failure(error, "SecKeyCreateRandomKey")); }
    Ok(Cf(key))
}
fn sign_request(key: Ref, info: &[u8]) -> Result<Vec<u8>> {
    let data = cf_data(info)?;
    let mut error = std::ptr::null();
    // SAFETY: key and data are live; the signature follows the create rule.
    let signature = unsafe { SecKeyCreateSignature(key, kSecKeyAlgorithmRSASignatureMessagePKCS1v15SHA256, data.0, &mut error) };
    if signature.is_null() { return Err(cf_failure(error, "SecKeyCreateSignature")); }
    Ok(bytes(Cf(signature).0))
}
fn keychain_settings(keychain: &Keychain) -> Result<Settings> {
    let mut settings = Settings { version: 1, lock_on_sleep: 0, use_lock_interval: 0, lock_interval: 0 };
    // SAFETY: settings is a valid SecKeychainSettings (version 1) for the call.
    checked_status(unsafe { SecKeychainCopySettings(keychain_ref(keychain), &mut settings) }, "SecKeychainCopySettings")?;
    // SecKeychainCopySettings writes lockOnSleep and lockInterval only; useLockInterval is
    // ignored by both SetSettings and CopySettings. Derive it from the actual interval.
    settings.use_lock_interval = u8::from(settings.lock_interval != i32::MAX as u32);
    Ok(settings)
}

/// `provision-signing-key`: dedicated keychain, auto-lock settings, a fresh non-extractable
/// RSA-2048 key and a PKCS#10 request signed by it. Existing keys are never deleted.
pub(super) fn provision(ctl: &Ctl) -> Result<Value> {
    let path = dedicated_keychain(ctl)?;
    let mut held = if path.exists() { Some(Keychain::open_locked(&path)?) } else { None };
    let result = (|| {
    let common_name = ctl.arg("common-name-hint")?;
    if common_name.is_empty() || common_name.chars().count() > 64 || common_name.chars().any(char::is_control) {
        return Err(fail(64, "invalid-input", "--common-name-hint must be 1-64 printable characters"));
    }
    let csr_out = PathBuf::from(ctl.arg("csr-out")?);
    let password = Password::read(ctl.password_fd()?)?;
    let created = held.is_none();
    if created {
        let c_path = CString::new(text(&path)?).map_err(|e| fail(64, "invalid-input", e.to_string()))?;
        let mut keychain = std::ptr::null();
        // SAFETY: the password is valid for len bytes; promptUser is false; SecKeychainCreate
        // does not add the keychain to the search list or make it the default.
        checked_status(unsafe { SecKeychainCreate(c_path.as_ptr(), password.len as u32, password.bytes.as_ptr().cast(), 0, std::ptr::null(), &mut keychain) }, "SecKeychainCreate")?;
        if keychain.is_null() { return Err(fail(23, "operation-failed", "SecKeychainCreate returned no keychain")); }
        held = Some(Keychain(keychain.cast_mut()));
        held.as_ref().expect("created keychain").finish(Ok(()))?;
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let keychain = held.as_ref().expect("opened or created keychain");
    let window = keychain.unlock(&password)?;
    drop(password);
    let settings = Settings { version: 1, lock_on_sleep: 1, use_lock_interval: 1, lock_interval: LOCK_INTERVAL };
    // SAFETY: settings is a valid SecKeychainSettings (version 1) for the call.
    checked_status(unsafe { SecKeychainSetSettings(keychain_ref(&keychain), &settings) }, "SecKeychainSetSettings")?;
    let retained = private_key_labels(&keychain)?;
    if !retained.is_empty() && !ctl.args.contains_key("replace") {
        return Err(fail(64, "invalid-input", format!("The keychain already holds {} private key(s) {retained:?}; pass --replace to add a new key (existing keys are never deleted)", retained.len())));
    }
    let key = create_key(&keychain, common_name)?;
    let actual = keychain_settings(&keychain)?;
    let extractable = key_extractable(key.0)?;
    if extractable != Some(false) || actual.lock_on_sleep == 0 || actual.lock_interval != LOCK_INTERVAL {
        return Err(fail(22, "verification-failed", format!("Provisioning readback refused: keyExtractable {extractable:?}, lockOnSleep {}, lockIntervalSeconds {}", actual.lock_on_sleep != 0, actual.lock_interval)));
    }
    let spki = subject_public_key_info(&public_key_pkcs1(key.0)?);
    let info = request_info(common_name, &spki);
    let signature = sign_request(key.0, &info)?;
    let (ctl_path, ctl_cdhash) = record_ctl(&path, key.0)?;
    #[cfg(feature = "test-signing-cert")]
    if let Some(out) = ctl.args.get("test-self-signed-cert-out") {
        test_certificate::issue(key.0, common_name, &spki, Path::new(out))?;
    }
    window.close()?;
    if let Some(parent) = csr_out.parent() { fs::create_dir_all(parent)?; }
    atomic_write(&csr_out, pem("CERTIFICATE REQUEST", &certification_request(&info, &signature)).as_bytes())?;
    Ok(json!({"keychain": path, "createdKeychain": created, "mode": "0600", "lockOnSleep": true, "lockIntervalSeconds": LOCK_INTERVAL, "keyLabel": common_name, "publicKeySha256": sha256(&spki), "csr": csr_out, "retainedPrivateKeys": retained, "aclRecord": sidecar_path(&path), "ctlPath": ctl_path, "ctlCdhash": ctl_cdhash}))
    })();
    match held { Some(keychain) => keychain.finish(result), None => result }
}

/// `import-signing-cert`: adds the issued certificate only when a private key in the
/// keychain pairs with it, then confirms the identity resolves.
pub(super) fn import_certificate(ctl: &Ctl) -> Result<Value> {
    let path = dedicated_keychain(ctl)?;
    let keychain = Keychain::open_locked(&path)?;
    let result = (|| {
    let der = certificate_der(&fs::read(ctl.arg("cert")?)?)?;
    let password = Password::read(ctl.password_fd()?)?;
    let data = cf_data(&der)?;
    // SAFETY: data is live; the certificate follows the create rule.
    let certificate = owned(unsafe { SecCertificateCreateWithData(std::ptr::null(), data.0) }, "SecCertificateCreateWithData")
        .map_err(|_| fail(64, "invalid-input", "--cert is not an X.509 certificate"))?;
    let window = keychain.unlock(&password)?;
    drop(password);
    let mut identity = std::ptr::null();
    // SAFETY: keychain and certificate are live; the identity follows the create rule.
    match unsafe { SecIdentityCreateWithCertificate(keychain_ref(&keychain), certificate.0, &mut identity) } {
        ITEM_NOT_FOUND => return Err(fail(22, "verification-failed", "No private key in the keychain pairs with this certificate; nothing was imported")),
        status => checked_status(status, "SecIdentityCreateWithCertificate")?,
    }
    drop(owned(identity, "SecIdentityCreateWithCertificate")?);
    // SAFETY: the Security constants are immutable framework globals.
    let attributes = unsafe { cf_dictionary(&[(kSecClass, kSecClassCertificate), (kSecValueRef, certificate.0), (kSecUseKeychain, keychain_ref(&keychain))])? };
    // SAFETY: attributes is a live dictionary; no result is requested.
    let imported = match unsafe { SecItemAdd(attributes.0, std::ptr::null_mut()) } {
        DUPLICATE_ITEM => false,
        status => { checked_status(status, "SecItemAdd")?; true }
    };
    window.close()?;
    // SAFETY: certificate is live; the results follow the copy rule.
    let certificate_sha1 = sha1(&bytes(owned(unsafe { SecCertificateCopyData(certificate.0) }, "SecCertificateCopyData")?.0));
    let subject = owned(unsafe { SecCertificateCopySubjectSummary(certificate.0) }, "SecCertificateCopySubjectSummary").ok().and_then(|s| string(s.0));
    let key = owned(unsafe { SecCertificateCopyKey(certificate.0) }, "SecCertificateCopyKey")?;
    let mut error = std::ptr::null();
    let pkcs1 = unsafe { SecKeyCopyExternalRepresentation(key.0, &mut error) };
    if pkcs1.is_null() { return Err(cf_failure(error, "SecKeyCopyExternalRepresentation")); }
    let spki = subject_public_key_info(&bytes(Cf(pkcs1).0));
    // The identity lookup install-host uses (codesigning policy, keychain may be locked).
    if !identity_in_keychain(&path, &certificate_sha1)? { return Err(fail(22, "verification-failed", "Imported identity is not found by find-identity")); }
    Ok(json!({"keychain": path, "imported": imported, "certificateSha1": certificate_sha1, "subject": subject, "publicKeySha256": sha256(&spki), "identity": true}))
    })();
    keychain.finish(result)
}

fn identity_parts(identity: Ref) -> Result<(Cf, Cf)> {
    let (mut key, mut certificate) = (std::ptr::null(), std::ptr::null());
    // SAFETY: identity is live; retained copies follow the copy rule.
    checked_status(unsafe { SecIdentityCopyPrivateKey(identity, &mut key) }, "SecIdentityCopyPrivateKey")?;
    let key = owned(key, "SecIdentityCopyPrivateKey")?;
    checked_status(unsafe { SecIdentityCopyCertificate(identity, &mut certificate) }, "SecIdentityCopyCertificate")?;
    Ok((key, owned(certificate, "SecIdentityCopyCertificate")?))
}
fn certificate_sha1(certificate: Ref) -> Result<String> {
    // SAFETY: certificate is live; the data follows the copy rule.
    Ok(sha1(&bytes(owned(unsafe { SecCertificateCopyData(certificate) }, "SecCertificateCopyData")?.0)))
}
fn keychain_identities(keychain: &Keychain) -> Result<Option<Cf>> {
    let list = search_list(keychain)?;
    // SAFETY: the Security constants are immutable framework globals.
    let query = unsafe { cf_dictionary(&[(kSecClass, kSecClassIdentity), (kSecMatchSearchList, list.0), (kSecMatchLimit, kSecMatchLimitAll), (kSecReturnRef, kCFBooleanTrue)])? };
    matching(&query)
}
/// The keychain's only identity, with its private key and certificate.
fn sole_identity(keychain: &Keychain) -> Result<(Cf, Cf, Cf)> {
    let found = keychain_identities(keychain)?.ok_or_else(|| fail(22, "verification-failed", "The keychain holds no identity"))?;
    let identities = elements(found.0);
    let [identity] = identities.as_slice() else { return Err(fail(22, "verification-failed", format!("The keychain holds {} identities; the proof needs exactly one", identities.len()))) };
    let (key, certificate) = identity_parts(*identity)?;
    // SAFETY: retain the identity so it outlives `found`.
    let identity = Cf(unsafe { CFRetain(*identity) });
    Ok((identity, key, certificate))
}
/// Private key and certificate of the named identity (SHA-1 or subject, as codesign resolves it).
fn named_identity(keychain: &Keychain, name: &str) -> Result<(Cf, Cf)> {
    let found = keychain_identities(keychain)?;
    let mut keys = Vec::new();
    for identity in found.as_ref().map(|f| elements(f.0)).unwrap_or_default() {
        let (key, certificate) = identity_parts(identity)?;
        // SAFETY: certificate is live; the summary follows the copy rule.
        let subject = owned(unsafe { SecCertificateCopySubjectSummary(certificate.0) }, "SecCertificateCopySubjectSummary").ok().and_then(|s| string(s.0));
        if certificate_sha1(certificate.0)?.eq_ignore_ascii_case(name) || subject.as_deref() == Some(name) { keys.push((key, certificate)); }
    }
    let count = keys.len();
    match <[(Cf, Cf); 1]>::try_from(keys) {
        Ok([parts]) => Ok(parts),
        Err(_) => Err(fail(22, "verification-failed", format!("Codesign guard: {count} identities match {name:?}; exactly one is required"))),
    }
}
/// What the codesign guard saw. `ready` is true only when codesign can use the key without any
/// confirmation and nothing else can: a partition-capable keychain, a partition list of exactly
/// `[apple:]` (so `security`, partition `apple-tool:`, is excluded) and signing ACLs that each
/// admit exactly `{/usr/bin/codesign, recorded ctl}`. Anything wider or different refuses; a
/// missing or foreign ACL record refuses (64). Only ACLs are read.
struct Guard { capable: bool, partitions: Vec<String>, ctl: String, sign_acl_exact: bool, ready: bool }
fn codesign_guard(keychain_path: &Path, key: Ref) -> Result<Guard> {
    let capable = keychain_path.parent().is_some_and(partition_capable);
    let ctl = recorded_ctl(keychain_path, key)?;
    let partitions = partition_list(key)?;
    let sign = sign_applications(key)?;
    let sign_acl_exact = !sign.is_empty() && sign.iter().all(|paths| paths.as_deref().is_some_and(|paths| exact_sign_applications(paths, &ctl)));
    let ready = capable && partitions == [CODESIGN_PARTITION] && sign_acl_exact;
    Ok(Guard { capable, partitions, ctl, sign_acl_exact, ready })
}
/// `install-host`'s pre-codesign check, run inside the unlock window (key ACLs are only readable
/// while unlocked). Fails (22, or 64 for the ACL record) without invoking codesign unless ready.
pub(super) fn require_codesign_ready(keychain_path: &Path, keychain: &Keychain, identity: &str) -> Result<()> {
    let (key, certificate) = named_identity(keychain, identity)?;
    let guard = codesign_guard(keychain_path, key.0)?;
    if guard.ready { require_chain(certificate.0)?; return Ok(()); }
    Err(fail(22, "verification-failed", format!("Codesign guard refused (partitionCapable {}, partitionList {:?}, signAclExact {} for ctl {}); run prove-signing-key", guard.capable, guard.partitions, guard.sign_acl_exact, guard.ctl)))
}
fn item_access(item: Ref) -> Result<Cf> {
    let mut access = std::ptr::null();
    // SAFETY: item is a live keychain item; access follows the copy rule.
    checked_status(unsafe { SecKeychainItemCopyAccess(item, &mut access) }, "SecKeychainItemCopyAccess")?;
    owned(access, "SecKeychainItemCopyAccess")
}
/// ACL entries of `access` for one authorization tag, with their application lists and descriptions.
fn acl_entries(access: &Cf, tag: Ref) -> Result<(Option<Cf>, Vec<(Ref, Option<Cf>, Option<Cf>, u16)>)> {
    // SAFETY: access is live; the list follows the copy rule (null when no entry matches).
    let list = unsafe { SecAccessCopyMatchingACLList(access.0, tag) };
    if list.is_null() { return Ok((None, Vec::new())); }
    let list = Cf(list);
    let mut entries = Vec::new();
    for acl in elements(list.0) {
        let (mut applications, mut description, mut prompt) = (std::ptr::null(), std::ptr::null(), 0u16);
        // SAFETY: acl is live (owned by `list`); outputs follow the copy rule.
        checked_status(unsafe { SecACLCopyContents(acl, &mut applications, &mut description, &mut prompt) }, "SecACLCopyContents")?;
        entries.push((acl, (!applications.is_null()).then(|| Cf(applications)), (!description.is_null()).then(|| Cf(description)), prompt));
    }
    Ok((Some(list), entries))
}
/// Partition IDs are an ACL entry whose description is a hex-encoded XML plist
/// `{Partitions = [...]}` (the encoding `security set-key-partition-list` writes).
fn partition_description(partitions: &[&str]) -> Result<Cf> {
    let values = partitions.iter().map(|p| cf_string(p)).collect::<Result<Vec<_>>>()?;
    let array = cf_array(&values.iter().map(|v| v.0).collect::<Vec<_>>())?;
    let key = cf_string("Partitions")?;
    let dictionary = cf_dictionary(&[(key.0, array.0)])?;
    let mut error = std::ptr::null();
    // SAFETY: dictionary is a live plist; 100 is kCFPropertyListXMLFormat_v1_0.
    let xml = unsafe { CFPropertyListCreateData(std::ptr::null(), dictionary.0, 100, 0, &mut error) };
    if xml.is_null() { return Err(cf_failure(error, "CFPropertyListCreateData")); }
    cf_string(&hex(&bytes(Cf(xml).0)))
}
fn partition_list(key: Ref) -> Result<Vec<String>> {
    let access = item_access(key)?;
    // SAFETY: immutable framework constant.
    let (_list, entries) = acl_entries(&access, unsafe { kSecACLAuthorizationPartitionID })?;
    let mut partitions = Vec::new();
    for (_, _, description, _) in &entries {
        let Some(binary) = description.as_ref().and_then(|d| string(d.0)).and_then(|d| unhex(&d)) else { continue };
        let data = cf_data(&binary)?;
        // SAFETY: data is live; the plist follows the create rule.
        let Ok(plist) = owned(unsafe { CFPropertyListCreateWithData(std::ptr::null(), data.0, 0, std::ptr::null_mut(), std::ptr::null_mut()) }, "CFPropertyListCreateWithData") else { continue };
        // SAFETY: type-checked dictionary lookup; values are owned by `plist`.
        let values = unsafe {
            if CFGetTypeID(plist.0) != CFDictionaryGetTypeID() { continue; }
            let key = cf_string("Partitions")?;
            CFDictionaryGetValue(plist.0, key.0)
        };
        partitions.extend(elements(values).into_iter().filter_map(string));
    }
    Ok(partitions)
}
fn codesign_application() -> Result<Cf> {
    let path = CString::new(CODESIGN).map_err(|e| fail(64, "invalid-input", e.to_string()))?;
    let mut application = std::ptr::null();
    // SAFETY: path is a valid C string; the application follows the create rule.
    checked_status(unsafe { SecTrustedApplicationCreateFromPath(path.as_ptr(), &mut application) }, "SecTrustedApplicationCreateFromPath")?;
    owned(application, "SecTrustedApplicationCreateFromPath")
}
fn application_path(application: Ref) -> Option<String> {
    let mut data = std::ptr::null();
    // SAFETY: application is live; data follows the copy rule.
    if unsafe { SecTrustedApplicationCopyData(application, &mut data) } != 0 || data.is_null() { return None; }
    let path = bytes(Cf(data).0);
    String::from_utf8(path.strip_suffix(&[0]).unwrap_or(&path).to_vec()).ok()
}
/// The signing ACL admits exactly codesign and the ctl recorded at provisioning. ctl stays because
/// securityd refuses (errSecAuthFailed) a password-authorized edit that removes it; it cannot use
/// the key anyway, since its partition (`cdhash:…`) is outside `[apple:]`.
fn exact_sign_applications(paths: &[String], ctl: &str) -> bool {
    ctl != CODESIGN && matches!(paths, [a, b] if (a == CODESIGN && b == ctl) || (b == CODESIGN && a == ctl))
}
/// `<keychain>.acl.json`: per key (public-key SHA-256), the exact ctl path provisioning wrote
/// into the signing ACL and its cdhash. The guard trusts only this record, never a name match.
fn sidecar_path(keychain_path: &Path) -> PathBuf {
    let mut path = keychain_path.as_os_str().to_owned();
    path.push(".acl.json");
    PathBuf::from(path)
}
fn key_id(key: Ref) -> Result<String> { Ok(sha256(&subject_public_key_info(&public_key_pkcs1(key)?))) }
fn read_sidecar(keychain_path: &Path) -> Result<Value> {
    let path = sidecar_path(keychain_path);
    let refuse = |why: &str| fail(64, "invalid-input", format!("ACL record {}: {why}; re-run provision-signing-key", path.display()));
    let metadata = fs::symlink_metadata(&path).map_err(|_| refuse("missing"))?;
    // SAFETY: geteuid has no preconditions.
    if !metadata.file_type().is_file() || metadata.mode() & 0o777 != 0o600 || metadata.uid() != unsafe { libc::geteuid() } {
        return Err(refuse("must be a regular 0600 file owned by this user"));
    }
    let record: Value = serde_json::from_slice(&fs::read(&path)?).map_err(|_| refuse("not valid JSON"))?;
    if record["keychain"].as_str() != Some(text(keychain_path)?) { return Err(refuse("names a different keychain")); }
    Ok(record)
}
fn recorded_ctl(keychain_path: &Path, key: Ref) -> Result<String> {
    let record = read_sidecar(keychain_path)?;
    let id = key_id(key)?;
    record["keys"][&id]["ctlPath"].as_str().map(str::to_owned)
        .ok_or_else(|| fail(64, "invalid-input", format!("ACL record {} has no entry for key {id}; re-run provision-signing-key", sidecar_path(keychain_path).display())))
}
/// Records the one non-codesign application the new key's signing ACL holds (the provisioning
/// ctl, as securityd stored it) with its cdhash, merging into an existing record (`--replace`).
fn record_ctl(keychain_path: &Path, key: Ref) -> Result<(String, String)> {
    let mut others: Vec<String> = sign_applications(key)?.into_iter().flatten().flatten().filter(|path| path != CODESIGN).collect();
    others.sort_unstable();
    others.dedup();
    let [ctl] = <[String; 1]>::try_from(others).map_err(|others| fail(23, "operation-failed", format!("The new key's signing ACL holds {others:?} besides codesign; expected exactly this ctl")))?;
    let cdhash = cdhash(&ctl)?;
    let mut record = if sidecar_path(keychain_path).exists() { read_sidecar(keychain_path)? } else { json!({"keychain": text(keychain_path)?, "keys": {}}) };
    record["keys"][key_id(key)?] = json!({"ctlPath": ctl, "ctlCdhash": cdhash});
    let path = sidecar_path(keychain_path);
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".tmp-{}", std::process::id()));
    let mut file = { use std::os::unix::fs::OpenOptionsExt; fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)? };
    file.write_all(serde_json::to_string_pretty(&record).map_err(|e| fail(23, "operation-failed", e.to_string()))?.as_bytes())?;
    file.sync_all()?;
    fs::rename(&tmp, &path)?;
    Ok((ctl, cdhash))
}
/// The code directory hash of the binary at `path` (`kSecCodeInfoUnique`), read in-process.
fn cdhash(path: &str) -> Result<String> {
    // SAFETY: the bytes are valid for their length; the URL follows the create rule.
    let url = owned(unsafe { CFURLCreateFromFileSystemRepresentation(std::ptr::null(), path.as_ptr(), path.len() as isize, 0) }, "CFURLCreateFromFileSystemRepresentation")?;
    let mut code = std::ptr::null();
    // SAFETY: url is live; code follows the create rule.
    checked_status(unsafe { SecStaticCodeCreateWithPath(url.0, 0, &mut code) }, "SecStaticCodeCreateWithPath")?;
    let code = owned(code, "SecStaticCodeCreateWithPath")?;
    let mut information = std::ptr::null();
    // SAFETY: code is live; information follows the copy rule.
    checked_status(unsafe { SecCodeCopySigningInformation(code.0, 0, &mut information) }, "SecCodeCopySigningInformation")?;
    let information = owned(information, "SecCodeCopySigningInformation")?;
    // SAFETY: lookup in a live dictionary with an immutable framework constant.
    let unique = unsafe { CFDictionaryGetValue(information.0, kSecCodeInfoUnique) };
    if unique.is_null() { return Err(fail(23, "operation-failed", format!("{path} has no code directory hash"))); }
    Ok(hex(&bytes(unique)))
}
/// Pins the partition list to exactly `[apple:]` in one ACL edit authorized by the keychain
/// password in-process (`security set-key-partition-list` without the password in argv). Other ACL
/// entries, including the signing ACL set at creation, are unchanged.
fn pin_partition(key: Ref, password: &Password) -> Result<()> {
    let access = item_access(key)?;
    // SAFETY: immutable framework constant.
    let (_partition_list, partition_entries) = acl_entries(&access, unsafe { kSecACLAuthorizationPartitionID })?;
    if partition_entries.is_empty() { return Err(fail(22, "verification-failed", "The key has no partition-ID ACL entry")); }
    let description = partition_description(&[CODESIGN_PARTITION])?;
    for (acl, applications, _, prompt) in &partition_entries {
        // SAFETY: acl is live (owned by the list); the application list is retained by the call.
        checked_status(unsafe { SecACLSetContents(*acl, applications.as_ref().map_or(std::ptr::null(), |a| a.0), description.0, *prompt) }, "SecACLSetContents(partition)")?;
    }
    // SAFETY: the password is valid for len bytes; the change is authorized without UI.
    checked_status(unsafe { SecKeychainItemSetAccessWithPassword(key, access.0, password.len as u32, password.bytes.as_ptr().cast()) }, "SecKeychainItemSetAccessWithPassword")
}
/// Application paths of every ACL entry that authorizes signing; `None` for an entry without an
/// application list (it admits every application).
fn sign_applications(key: Ref) -> Result<Vec<Option<Vec<String>>>> {
    let access = item_access(key)?;
    // SAFETY: immutable framework constant.
    let (_list, entries) = acl_entries(&access, unsafe { kSecACLAuthorizationSign })?;
    Ok(entries.iter().map(|(_, applications, _, _)| applications.as_ref().map(|applications| {
        elements(applications.0).into_iter().map(|application| application_path(application).unwrap_or_default()).collect()
    })).collect())
}
fn key_extractable(key: Ref) -> Result<Option<bool>> {
    let mut header = std::ptr::null();
    // SAFETY: key is a live legacy SecKey; the pointer is borrowed until key is released.
    checked_status(unsafe { SecKeyGetCSSMKey(key, &mut header) }, "SecKeyGetCSSMKey")?;
    if header.is_null() { return Err(fail(22, "verification-failed", "The key has no CSSM key header")); }
    // SAFETY: CSSM_KEY starts with CSSM_KEYHEADER; this is its prefix through KeyAttr.
    Ok(Some(unsafe { (*header).attributes & 0x20 != 0 })) // CSSM_KEYATTR_EXTRACTABLE
}
/// Code-signing trust evaluation before codesign. No network fetch or trust-store mutation:
/// intermediates/anchors must already be available through the normal system search list.
fn require_chain(certificate: Ref) -> Result<()> {
    // SAFETY: immutable policy identifier; the policy follows the create rule.
    let policy = owned(unsafe { SecPolicyCreateWithProperties(kSecPolicyAppleCodeSigning, std::ptr::null()) }, "SecPolicyCreateWithProperties")?;
    let mut trust = std::ptr::null();
    // SAFETY: certificate and policy are live; trust follows the create rule.
    checked_status(unsafe { SecTrustCreateWithCertificates(certificate, policy.0, &mut trust) }, "SecTrustCreateWithCertificates")?;
    let trust = owned(trust, "SecTrustCreateWithCertificates")?;
    checked_status(unsafe { SecTrustSetNetworkFetchAllowed(trust.0, 0) }, "SecTrustSetNetworkFetchAllowed")?;
    #[cfg(feature = "test-signing-cert")]
    {
        // A self-issued test leaf is an anchor only for this ephemeral trust evaluation.
        // No system or keychain trust is changed.
        let issuer = owned(unsafe { SecCertificateCopyNormalizedIssuerSequence(certificate) }, "issuer")?;
        let subject = owned(unsafe { SecCertificateCopyNormalizedSubjectSequence(certificate) }, "subject")?;
        if bytes(issuer.0) == bytes(subject.0) {
            let anchors = cf_array(&[certificate])?;
            checked_status(unsafe { SecTrustSetAnchorCertificates(trust.0, anchors.0) }, "SecTrustSetAnchorCertificates(test only)")?;
        }
    }
    let mut error = std::ptr::null();
    // SAFETY: trust is live; error follows the create rule.
    if unsafe { SecTrustEvaluateWithError(trust.0, &mut error) } { return Ok(()); }
    let reason = cf_failure(error, "Code-signing chain is incomplete or untrusted").reason;
    Err(signing("chain-incomplete", reason))
}
/// Attempts a PKCS#12 export of the identity; the status is the proof.
fn export_status(identity: Ref) -> Result<i32> {
    let passphrase = cf_string("macos-app-ctl export proof")?;
    let parameters = ExportParameters { version: 0, flags: 0, passphrase: passphrase.0, alert_title: std::ptr::null(), alert_prompt: std::ptr::null(), access: std::ptr::null(), key_usage: std::ptr::null(), key_attributes: std::ptr::null() };
    let mut data = std::ptr::null();
    // SAFETY: identity and parameters are live; a passphrase is supplied, so no passphrase UI.
    let status = unsafe { SecItemExport(identity, PKCS12, 0, &parameters, &mut data) };
    if !data.is_null() { drop(Cf(data)); }
    Ok(status)
}
/// Runs one signing `codesign` with `SIGN_DEADLINE`; a run that has not finished (for example
/// because it waits on a confirmation) is killed and reported as `sign-timeout`.
pub(super) fn bounded_codesign(args: &[&str]) -> Result<Output> {
    let mut child = Command::new(codesign_program()).args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn()?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| std::thread::spawn(move || { let mut buffer = Vec::new(); if let Some(mut pipe) = pipe { let _ = pipe.read_to_end(&mut buffer); } buffer });
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let deadline = Instant::now() + SIGN_DEADLINE;
    let status = loop {
        if let Some(status) = child.try_wait()? { break status; }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(signing("sign-timeout", format!("codesign did not finish within {}s and was killed; a keychain confirmation may have been requested", SIGN_DEADLINE.as_secs())));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    Ok(Output { status, stdout: stdout.join().unwrap_or_default(), stderr: stderr.join().unwrap_or_default() })
}
/// Signs and verifies a throwaway file with the identity through `/usr/bin/codesign`.
fn codesign_probe(keychain: &Path, identity_sha1: &str) -> Result<bool> {
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| fail(23, "operation-failed", e.to_string()))?.as_nanos();
    let dir = std::env::temp_dir().join(format!("macos-app-ctl-proof-{}-{nonce}", std::process::id()));
    fs::create_dir(&dir)?;
    let file = dir.join("probe");
    let result = (|| {
        fs::write(&file, b"macos-app-ctl signing-key proof\n")?;
        let signed = bounded_codesign(&["--force", "--keychain", text(keychain)?, "--sign", identity_sha1, text(&file)?])?;
        if !signed.status.success() { return Err(fail(22, "verification-failed", format!("Signing-key codesign probe: {}", String::from_utf8_lossy(&signed.stderr)))); }
        let verified = command(codesign_program(), &["--verify", text(&file)?])?;
        if !verified.status.success() { return Err(fail(22, "verification-failed", format!("Signing-key codesign probe verification: {}", String::from_utf8_lossy(&verified.stderr)))); }
        Ok(true)
    })();
    fs::remove_dir_all(&dir)?;
    result
}
fn keychain_locked(keychain: &Keychain) -> Result<bool> {
    let mut status = 0u32;
    // SAFETY: the keychain reference is live; status is a valid out pointer.
    checked_status(unsafe { SecKeychainGetStatus(keychain_ref(keychain), &mut status) }, "SecKeychainGetStatus")?;
    Ok(status & UNLOCK_STATE == 0)
}

/// `prove-signing-key`: pins the key's partition list to exactly `[apple:]` (the signing ACL stays
/// exactly `{/usr/bin/codesign, recorded ctl}`) and proves the identity is usable by codesign but
/// not exportable. The export attempt runs before the pin, while this process may still use the
/// key, so it can only be refused by non-extractability; once pinned, ctl's partition is outside
/// the list and the attempt is skipped. codesign runs only when the exact guard holds, and under
/// `SIGN_DEADLINE`. With `--no-sign` everything except the codesign run happens. Fails (22)
/// unless every property holds.
pub(super) fn prove(ctl: &Ctl) -> Result<Value> {
    let path = dedicated_keychain(ctl)?;
    let keychain = Keychain::open_locked(&path)?;
    let result = (|| {
    let partition_capable = path.parent().is_some_and(partition_capable);
    let no_sign = ctl.args.contains_key("no-sign");
    let password = Password::read(ctl.password_fd()?)?;
    let window = keychain.unlock(&password)?;
    let (identity, key, certificate) = sole_identity(&keychain)?;
    let identity_sha1 = certificate_sha1(certificate.0)?;
    let extractable = key_extractable(key.0)?;
    let pinned_before = codesign_guard(&path, key.0)?.ready;
    // An extractable key could make export ask for confirmation, so it is only attempted when the
    // attribute already says non-extractable.
    let export = if !pinned_before && extractable == Some(false) { Some(export_status(identity.0)?) } else { None };
    if !pinned_before { pin_partition(key.0, &password)?; }
    drop(password);
    let guard = codesign_guard(&path, key.0)?;
    if guard.ready && !no_sign { require_chain(certificate.0)?; }
    let sign_ok = match (guard.ready, no_sign) { (true, false) => Some(codesign_probe(&path, &identity_sha1)?), _ => None };
    let settings = keychain_settings(&keychain)?;
    window.close()?;
    let locked_after = keychain_locked(&keychain)?;
    let export_refused = match export { Some(status) => status != 0, None => pinned_before && extractable == Some(false) };
    // `security` runs in partition `apple-tool:`; an exact `[apple:]` list excludes it structurally.
    let security_excluded = guard.partitions == [CODESIGN_PARTITION];
    let proof = json!({
        "keychain": path, "identitySha1": identity_sha1, "partitionCapable": partition_capable,
        "exportAttempted": export.is_some(), "exportStatus": export, "exportRefused": export_refused,
        "signOk": sign_ok, "signSkipped": no_sign, "guardReady": guard.ready,
        "partitionList": guard.partitions, "signAclExact": guard.sign_acl_exact, "recordedCtlPath": guard.ctl,
        "securityToolExcluded": security_excluded, "keyExtractable": extractable, "lockedAfterWindow": locked_after,
        "lockOnSleep": settings.lock_on_sleep != 0, "lockIntervalSeconds": (settings.use_lock_interval != 0).then_some(settings.lock_interval),
    });
    let ok = partition_capable && guard.ready && export_refused && extractable == Some(false) && locked_after
        && settings.lock_on_sleep != 0 && settings.lock_interval == LOCK_INTERVAL && (no_sign || sign_ok == Some(true));
    if ok { Ok(proof) } else { Err(fail(22, "verification-failed", format!("Signing-key proof failed: {proof}"))) }
    })();
    keychain.finish(result)
}

#[cfg(test)]
mod tests {
    #[test]
    fn codesign_selection_matches_the_build_contract() {
        #[cfg(not(feature = "test-signing-cert"))]
        assert_eq!(codesign_program(), "/usr/bin/codesign");
        #[cfg(feature = "test-signing-cert")]
        assert_eq!(codesign_program(), "codesign");
    }
    #[test]
    fn security_structs_match_the_sdk_abi() {
        assert_eq!(std::mem::size_of::<Settings>(), 12);
        assert_eq!(std::mem::offset_of!(Settings, lock_on_sleep), 4);
        assert_eq!(std::mem::offset_of!(Settings, use_lock_interval), 5);
        assert_eq!(std::mem::offset_of!(Settings, lock_interval), 8);
        assert_eq!(std::mem::offset_of!(CssmKeyHeaderPrefix, attributes), 40);
    }
    use super::*;
    #[test]
    fn base64_round_trips_and_matches_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        for data in [&b""[..], b"a", b"ab", b"abc", &[0, 255, 128, 7, 9]] { assert_eq!(unbase64(&base64(data)).as_deref(), Some(data)); }
        assert_eq!(unbase64("Zm9v\nYmFy"), Some(b"foobar".to_vec()));
        assert!(unbase64("Zm9").is_none() && unbase64("Z===").is_none());
    }
    #[test]
    fn der_lengths_use_short_and_long_forms() {
        assert_eq!(der(0x04, &[1, 2]), vec![0x04, 0x02, 1, 2]);
        assert_eq!(&der(0x04, &[0; 200])[..3], &[0x04, 0x81, 200]);
        assert_eq!(&der(0x04, &[0; 300])[..4], &[0x04, 0x82, 0x01, 0x2c]);
    }
    #[test]
    fn request_info_encodes_subject_key_and_empty_attributes() {
        let spki = subject_public_key_info(&[0x30, 0x00]);
        assert_eq!(&spki[..2], &[0x30, 0x14]);
        let info = request_info("Signer", &spki);
        assert_eq!(info[0], 0x30);
        assert!(info.windows(6).any(|w| w == b"Signer"));
        assert_eq!(&info[info.len() - 2..], &[0xa0, 0x00]);
        let request = certification_request(&info, &[1, 2, 3]);
        assert!(request.ends_with(&[0x03, 0x04, 0x00, 1, 2, 3]));
        assert!(pem("CERTIFICATE REQUEST", &request).starts_with("-----BEGIN CERTIFICATE REQUEST-----\n"));
    }
    #[test]
    fn certificate_files_accept_pem_or_der() {
        let der = vec![0x30, 0x03, 1, 2, 3];
        assert_eq!(certificate_der(&der).ok(), Some(der.clone()));
        assert_eq!(certificate_der(pem("CERTIFICATE", &der).as_bytes()).ok(), Some(der));
        assert!(certificate_der(b"-----BEGIN CERTIFICATE-----\n!!!\n").is_err());
    }
    #[test]
    fn hex_round_trips() {
        assert_eq!(unhex(&hex(&[0, 1, 254, 255])), Some(vec![0, 1, 254, 255]));
        assert!(unhex("abc").is_none() && unhex("zz").is_none());
    }
    #[test]
    fn only_per_user_library_keychains_get_partitions() {
        assert!(partition_capable(Path::new("/Users/me/Library/Keychains")));
        assert!(partition_capable(Path::new("/Users/me/work/Library/Keychains")));
        assert!(!partition_capable(Path::new("/Library/Keychains")));
        assert!(!partition_capable(Path::new("/System/Library/Keychains")));
        assert!(!partition_capable(Path::new("/Users/me/tmp")));
    }
    #[test]
    fn sign_acl_must_equal_codesign_and_the_recorded_ctl() {
        let ctl = "/nix/store/aaaa-macos-app-host-1/bin/macos-app-ctl";
        let paths = |list: &[&str]| list.iter().map(|p| p.to_string()).collect::<Vec<_>>();
        assert!(exact_sign_applications(&paths(&[CODESIGN, ctl]), ctl));
        assert!(exact_sign_applications(&paths(&[ctl, CODESIGN]), ctl));
        assert!(!exact_sign_applications(&paths(&[CODESIGN, "/nix/store/bbbb-macos-app-host-1/bin/macos-app-ctl"]), ctl));
        assert!(!exact_sign_applications(&paths(&[CODESIGN]), ctl));
        assert!(!exact_sign_applications(&paths(&[CODESIGN, ctl, "/usr/bin/security"]), ctl));
        assert!(!exact_sign_applications(&paths(&[CODESIGN, CODESIGN]), CODESIGN));
    }
    #[test]
    fn missing_loose_or_foreign_acl_records_refuse() {
        use std::os::unix::fs::OpenOptionsExt;
        let dir = std::env::temp_dir().join(format!("acl-record-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let keychain = dir.join("k.keychain-db");
        let record = sidecar_path(&keychain);
        assert_eq!(record, dir.join("k.keychain-db.acl.json"));
        let code = |r: Result<Value>| r.err().map(|f| f.code);
        assert_eq!(code(read_sidecar(&keychain)), Some(64));
        let body = json!({"keychain": keychain.to_str().unwrap(), "keys": {}}).to_string();
        fs::OpenOptions::new().write(true).create_new(true).mode(0o644).open(&record).unwrap().write_all(body.as_bytes()).unwrap();
        fs::set_permissions(&record, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(code(read_sidecar(&keychain)), Some(64));
        fs::set_permissions(&record, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_sidecar(&keychain).is_ok());
        assert_eq!(code(read_sidecar(&dir.join("other.keychain-db"))), Some(64));
        fs::rename(&record, dir.join("other.keychain-db.acl.json")).unwrap();
        assert_eq!(code(read_sidecar(&dir.join("other.keychain-db"))), Some(64));
        fs::remove_dir_all(&dir).unwrap();
    }
}
