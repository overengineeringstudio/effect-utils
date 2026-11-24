//! One fixed endpoint, one exact GET, no body, redirects or daemon forwarding.
use std::io::{self, BufRead, BufReader, Read, Write};
use std::time::Instant;
use super::protocol;
const MAX_LINE: usize = 4 * 1024 * 1024;
pub(super) const MAX_HEADERS: usize = 1024;
pub(super) const PREFIX: &[u8] = b"GET /v1/holders?request=";
pub(super) const SUFFIX: &[u8] = b" HTTP/1.1\r\n";
pub(super) const REQUEST_HEADERS: &[u8] = b"Host: localhost\r\nConnection: close\r\n\r\n";
#[cfg(any(test, holder_evidence_clients))]
const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
pub(super) fn invalid() -> io::Error { io::Error::new(io::ErrorKind::InvalidData,"invalid holder-evidence HTTP frame") }
pub(super) fn remaining(deadline: Instant) -> io::Result<std::time::Duration> {
    let duration=deadline.saturating_duration_since(Instant::now());
    if duration.is_zero() { Err(io::Error::new(io::ErrorKind::TimedOut,"holder-evidence transport deadline")) } else { Ok(duration) }
}
#[cfg(any(test, holder_evidence_clients))]
pub(super) fn base64(input: &[u8]) -> Vec<u8> {
    let mut out=Vec::with_capacity(input.len().div_ceil(3)*4);
    for block in input.chunks(3) {
        out.push(ALPHABET[usize::from(block[0]>>2)]);
        out.push(ALPHABET[usize::from((block[0]&3)<<4 | block.get(1).copied().unwrap_or(0)>>4)]);
        if block.len()>1 { out.push(ALPHABET[usize::from((block[1]&15)<<2 | block.get(2).copied().unwrap_or(0)>>6)]); }
        if block.len()>2 { out.push(ALPHABET[usize::from(block[2]&63)]); }
    }
    out
}
fn unbase64(input: &[u8]) -> io::Result<Vec<u8>> {
    if input.is_empty() || input.len()%4==1 || input.len()>protocol::MAX_REQUEST.div_ceil(3)*4 { return Err(invalid()); }
    let mut out=Vec::with_capacity(input.len()*3/4);
    let mut acc=0_u32; let mut bits=0;
    for &b in input {
        let n=match b {b'A'..=b'Z'=>b-b'A',b'a'..=b'z'=>b-b'a'+26,b'0'..=b'9'=>b-b'0'+52,b'-'=>62,b'_'=>63,_=>return Err(invalid())};
        acc=(acc<<6)|u32::from(n); bits+=6;
        if bits>=8 { bits-=8; out.push((acc>>bits) as u8); }
    }
    if (bits>0 && (acc&((1<<bits)-1))!=0) || out.len()>protocol::MAX_REQUEST { return Err(invalid()); } Ok(out)
}
// fill_buf avoids read_until allocating past its limit. Every byte, including
// CRLF, counts toward the bound; no lenient HTTP line-ending or header parser.
pub(super) fn line<R: BufRead>(reader: &mut R, limit: usize, deadline: Instant) -> io::Result<Vec<u8>> {
    let mut out=Vec::new();
    loop {
        remaining(deadline)?;
        let bytes=reader.fill_buf()?;
        if bytes.is_empty() { return Err(invalid()); }
        let n=bytes.iter().position(|b|*b==b'\n').map_or(bytes.len(),|i|i+1);
        if out.len()+n>limit { return Err(invalid()); }
        let ended=bytes[n-1]==b'\n'; out.extend_from_slice(&bytes[..n]); reader.consume(n);
        if ended { if !out.ends_with(b"\r\n") { return Err(invalid()); } return Ok(out); }
    }
}
pub fn read_request<R: Read>(input: R, deadline: Instant) -> io::Result<Vec<u8>> {
    let mut reader=BufReader::new(input); let first=line(&mut reader,MAX_LINE,deadline)?;
    let encoded=first.strip_prefix(PREFIX).and_then(|b|b.strip_suffix(SUFFIX)).ok_or_else(invalid)?;
    let mut headers=Vec::new();
    loop {
        let next=line(&mut reader,MAX_HEADERS-headers.len(),deadline)?;
        let end=next==b"\r\n"; headers.extend_from_slice(&next); if end { break; }
    }
    if headers!=REQUEST_HEADERS { return Err(invalid()); }
    // The client half-closes after the GET. Requiring EOF rules out hidden
    // bodies, pipelining and a second request; the root alarm bounds a stall.
    remaining(deadline)?; let mut extra=[0]; if reader.read(&mut extra)?!=0 { return Err(invalid()); }
    unbase64(encoded)
}
pub fn write_response<W: Write>(output: &mut W, body: &[u8], deadline: Instant) -> io::Result<()> {
    if body.is_empty() || body.len()>protocol::MAX_RESPONSE { return Err(invalid()); }
    remaining(deadline)?;
    write!(output,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len())?;
    output.write_all(body)?; output.flush()
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::time::Duration;
    #[test]
    fn exact_get_roundtrip_and_rejections() {
        let deadline=Instant::now()+Duration::from_secs(1);
        let mut wire=PREFIX.to_vec(); wire.extend(base64(b"{\"version\":1}")); wire.extend(SUFFIX); wire.extend(REQUEST_HEADERS);
        assert_eq!(read_request(Cursor::new(&wire),deadline).unwrap(),b"{\"version\":1}");
        let mut body=wire.clone(); body.extend(b"body"); assert!(read_request(Cursor::new(body),deadline).is_err());
        let mut alternate=wire.clone(); alternate[0]=b'P'; assert!(read_request(Cursor::new(alternate),deadline).is_err());
        assert!(unbase64(b"Zh").is_err()); assert!(unbase64(b"Zg==").is_err());
        for input in [b"a".as_slice(),b"ab",b"abc",b"abcd",b"\0\xff"] { assert_eq!(unbase64(&base64(input)).unwrap(),input); }
    }
    #[test]
    fn request_line_is_bounded() {
        let deadline=Instant::now()+Duration::from_secs(1);
        assert!(line(&mut Cursor::new(b"abcdef\r\n"),4,deadline).is_err());
    }
}
