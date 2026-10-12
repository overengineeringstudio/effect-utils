use schema_registry_rust_consumer::types::GateSlotReceipt;
use std::io::{self, Read as _, Write as _};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut source = String::new();
    io::stdin().read_to_string(&mut source)?;
    let receipt: GateSlotReceipt = serde_json::from_str(&source)?;
    io::stdout().write_all(serde_json::to_string(&receipt)?.as_bytes())?;
    Ok(())
}
