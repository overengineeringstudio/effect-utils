// Credential-free image fixture, not an authorization service.
use std::{env, fs, io::{Read, Write}, net::TcpListener, path::PathBuf};

fn main() -> std::io::Result<()> {
    let state = PathBuf::from(env::var("STATE_DIRECTORY").expect("STATE_DIRECTORY"));
    let identity = state.join("identity");
    if !identity.exists() {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&identity)?;
        file.write_all(fs::read("/proc/sys/kernel/random/uuid")?.as_slice())?;
        file.sync_all()?;
        fs::File::open(&state)?.sync_all()?;
    }
    let identity = fs::read_to_string(identity)?;
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    let release = env::var("AUTHORITY_RELEASE").expect("AUTHORITY_RELEASE");
    let catalog = env::var("AUTHORITY_CATALOG").expect("AUTHORITY_CATALOG");
    let epoch = env::var("AUTHORITY_EPOCH").expect("AUTHORITY_EPOCH");
    for stream in TcpListener::bind("0.0.0.0:8080")?.incoming() {
        let mut stream = stream?;
        stream.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
        let mut request = [0; 4096];
        let count = stream.read(&mut request)?;
        let request = String::from_utf8_lossy(&request[..count]);
        let target = request.split_whitespace().nth(1).unwrap_or("");
        let challenge = target.strip_prefix("/health?nonce=").unwrap_or("");
        if challenge.len() != 36 || !challenge.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
            stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")?;
            continue;
        }
        let body = format!("{{\"release\":\"{release}\",\"catalogDigest\":\"{catalog}\",\"epoch\":\"{epoch}\",\"ready\":true,\"bootNonce\":\"{}\",\"nonce\":\"{challenge}\",\"stateIdentity\":\"{}\"}}", boot.trim(), identity.trim());
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        stream.write_all(response.as_bytes())?;
    }
    Ok(())
}
