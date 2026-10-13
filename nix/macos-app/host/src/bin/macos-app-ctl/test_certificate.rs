//! Compiled only for the separate test-signing-cert output; never in shipped ctl.
use super::*;

pub(super) fn issue(key: Ref, common_name: &str, spki: &[u8], out: &Path) -> Result<()> {
    let time = |offset: i64| -> Result<Vec<u8>> {
        let seconds = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| fail(23, "operation-failed", e.to_string()))?.as_secs() as libc::time_t + offset;
        let mut tm = std::mem::MaybeUninit::<libc::tm>::uninit();
        // SAFETY: seconds and tm are valid pointers; gmtime_r initializes tm on success.
        if unsafe { libc::gmtime_r(&seconds, tm.as_mut_ptr()) }.is_null() { return Err(fail(23, "operation-failed", "gmtime_r failed")); }
        let tm = unsafe { tm.assume_init() };
        Ok(der(0x18, format!("{:04}{:02}{:02}{:02}{:02}{:02}Z", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec).as_bytes()))
    };
    let name = sequence(&[&der(0x31, &sequence(&[COMMON_NAME, &der(0x0c, common_name.as_bytes())]))]);
    let algorithm = sequence(&[SHA256_WITH_RSA, DER_NULL]);
    let validity = sequence(&[&time(-60)?, &time(2 * 86400)?]);
    let basic = sequence(&[&der(0x06, &[0x55, 0x1d, 0x13]), &[0x01, 0x01, 0xff], &der(0x04, &sequence(&[]))]);
    let usage = sequence(&[&der(0x06, &[0x55, 0x1d, 0x0f]), &[0x01, 0x01, 0xff], &der(0x04, &[0x03, 0x02, 0x07, 0x80])]);
    let eku = sequence(&[&der(0x06, &[0x55, 0x1d, 0x25]), &der(0x04, &sequence(&[&der(0x06, &[0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x03])]))]);
    let extensions = der(0xa3, &sequence(&[&basic, &usage, &eku]));
    let tbs = sequence(&[&[0xa0, 0x03, 0x02, 0x01, 0x02], &[0x02, 0x01, 0x01], &algorithm, &name, &validity, &name, spki, &extensions]);
    let signature = sign_request(key, &tbs)?;
    atomic_write(out, pem("CERTIFICATE", &sequence(&[&tbs, &algorithm, &bit_string(&signature)])).as_bytes())
}
