//! Emit the protocol authority's nine synthetic fixtures, never live evidence.
#![forbid(unsafe_code)]

use std::io::{self, Write};
use std::process::ExitCode;
use holder_evidence_protocol::protocol;

fn emit() -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    for fixture in protocol::codec_fixtures()? {
        stdout.write_all(&fixture)?;
        stdout.write_all(b"\n")?;
    }
    stdout.flush()
}

fn main() -> ExitCode {
    match emit() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("holder-evidence-codec: {:?}", error.kind());
            ExitCode::FAILURE
        }
    }
}
