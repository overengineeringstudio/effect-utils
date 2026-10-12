//! Emit one self-contained Rust authority from a JSON Schema on standard input.
use schema_registry_rust::{generate, parse_schema, Options, RUNTIME_HELPERS};
use std::io::{self, Read, Write};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args().skip(1);
    let name = arguments
        .next()
        .ok_or("usage: schema-registry-rust <PascalCaseRoot> < schema.json")?;
    if arguments.next().is_some() {
        return Err("expected exactly one root name".into());
    }
    let mut source = String::new();
    io::stdin().read_to_string(&mut source)?;
    let schema = parse_schema(&source)?;
    let types = generate(
        &schema,
        &name,
        &Options {
            runtime_module: "self::__schema_registry_runtime",
            ..Options::default()
        },
    )?;
    // A relative helper path lets this file be included in any consumer module.
    let mut stdout = io::stdout().lock();
    stdout.write_all(b"pub mod __schema_registry_runtime {\n")?;
    stdout.write_all(RUNTIME_HELPERS.as_bytes())?;
    stdout.write_all(b"\n}\n")?;
    stdout.write_all(types.as_bytes())?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("schema-registry-rust: {error}");
        std::process::exit(1);
    }
}
