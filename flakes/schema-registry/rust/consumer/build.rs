use schema_registry_rust::{generate, parse_schema, Options, RUNTIME_HELPERS};
use std::{env, fs, path::PathBuf};

fn main() {
    let output_directory = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let runtime_path = "../../../agent-trace/generated/AgentTraceRuntimeV1.rs";
    println!("cargo:rerun-if-changed={runtime_path}");
    // Compile the exact distributed file, not a second generator invocation.
    fs::write(
        output_directory.join("runtime.rs"),
        fs::read(runtime_path).unwrap(),
    )
    .unwrap();
    println!("cargo:rerun-if-changed=cases.schema.json");
    println!("cargo:rerun-if-env-changed=SCHEMA_REGISTRY_RECEIPT_SCHEMA");
    let receipt_path =
        env::var("SCHEMA_REGISTRY_RECEIPT_SCHEMA").unwrap_or_else(|_| "receipt.schema.json".into());
    println!("cargo:rerun-if-changed={receipt_path}");
    let cases = parse_schema(&fs::read_to_string("cases.schema.json").unwrap()).unwrap();
    let receipt = parse_schema(&fs::read_to_string(receipt_path).unwrap()).unwrap();
    let mut output =
        String::from("// Generated test consumer; schemas above are the semantic inputs.\n");
    output.push_str(RUNTIME_HELPERS);
    output.push_str("\npub mod types {\n");
    for (name, schema) in cases.as_object().unwrap() {
        output.push_str(&generate(schema, name, &Options::default()).unwrap());
    }
    output.push_str(&generate(&receipt, "GateSlotReceipt", &Options::default()).unwrap());
    output.push_str("}\n");
    fs::write(output_directory.join("types.rs"), output).unwrap();
}
