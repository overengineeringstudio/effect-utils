//! Client half of the same fixed endpoint; shared strict framing stays single-owned.
use std::io::{self, BufReader, Read, Write};
use std::net::Shutdown;
use std::time::Instant;
use super::{linux, protocol};
use super::transport::{invalid, remaining, line, base64, MAX_HEADERS, PREFIX, SUFFIX, REQUEST_HEADERS};

fn read_response<R: Read>(input: R, deadline: Instant) -> io::Result<Vec<u8>> {
    let mut reader=BufReader::new(input);
    if line(&mut reader,MAX_HEADERS,deadline)?!=b"HTTP/1.1 200 OK\r\n" || line(&mut reader,MAX_HEADERS,deadline)?!=b"Content-Type: application/json\r\n" { return Err(invalid()); }
    let length=line(&mut reader,MAX_HEADERS,deadline)?;
    let text=std::str::from_utf8(length.strip_prefix(b"Content-Length: ").and_then(|b|b.strip_suffix(b"\r\n")).ok_or_else(invalid)?).map_err(|_|invalid())?;
    if text.is_empty() || text.len()>8 || text.starts_with('0') || !text.bytes().all(|b|b.is_ascii_digit()) { return Err(invalid()); }
    let length=text.parse::<usize>().map_err(|_|invalid())?;
    if length>protocol::MAX_RESPONSE || line(&mut reader,MAX_HEADERS,deadline)?!=b"Connection: close\r\n" || line(&mut reader,MAX_HEADERS,deadline)?!=b"\r\n" { return Err(invalid()); }
    let mut body=vec![0;length]; let mut at=0;
    while at<body.len() { remaining(deadline)?; let n=reader.read(&mut body[at..])?; if n==0 { return Err(invalid()); } at+=n; }
    remaining(deadline)?; let mut extra=[0]; if reader.read(&mut extra)?!=0 { return Err(invalid()); } Ok(body)
}
pub fn exchange(input: &[u8], deadline: Instant) -> io::Result<Vec<u8>> {
    if input.is_empty() || input.len()>protocol::MAX_REQUEST { return Err(invalid()); }
    // This Linux boundary authenticates initial USER namespace, immutable fixed
    // socket ancestry and actual root SO_PEERCRED, including socket-activation.
    let mut stream=linux::connect_evidence(deadline)?;
    stream.set_write_timeout(Some(remaining(deadline)?))?;
    stream.set_read_timeout(Some(remaining(deadline)?))?;
    let encoded=base64(input);
    stream.write_all(PREFIX)?; stream.write_all(&encoded)?; stream.write_all(SUFFIX)?; stream.write_all(REQUEST_HEADERS)?;
    stream.shutdown(Shutdown::Write)?;
    read_response(stream,deadline)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::time::Duration;
    use super::super::transport::write_response;
    #[test]
    fn response_length_body_and_trailing_bytes_are_strict() {
        let deadline=Instant::now()+Duration::from_secs(1); let mut wire=Vec::new(); write_response(&mut wire,b"{}",deadline).unwrap();
        assert_eq!(read_response(Cursor::new(&wire),deadline).unwrap(),b"{}");
        wire.push(b'x'); assert!(read_response(Cursor::new(&wire),deadline).is_err());
        assert!(line(&mut Cursor::new(b"abcdef\r\n"),4,deadline).is_err());
    }
}
