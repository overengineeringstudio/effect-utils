use schema_registry_rust::{generate, Options};
use std::{env, fmt::Write as _, fs, path::PathBuf};

const ROOTS: [&str; 8] = [
    "AgentTraceV2",
    "AgentTraceRuntimeV1",
    "PublicAudienceV2",
    "PrivateAudienceV2",
    "PublicTrailerV2",
    "PrivateTrailerV2",
    "PublicFooterV2",
    "PrivateFooterV2",
];

// The two authorities deliberately reuse the same component schemas. Generate
// moves beside their private newtype fields rather than round-tripping JSON.
fn component_moves(schema: &serde_json::Value, suffix: &str, output: &mut String) {
    let source = format!("AgentTraceRuntimeV1{suffix}");
    let target = format!("AgentTraceV2{suffix}");
    if let Some(branches) = schema.get("anyOf").and_then(serde_json::Value::as_array) {
        for (index, branch) in branches.iter().enumerate() {
            component_moves(branch, &format!("{suffix}Variant{index}"), output);
        }
        writeln!(output, "impl From<{source}> for {target} {{ fn from(value: {source}) -> Self {{ match value {{").unwrap();
        for index in 0..branches.len() {
            writeln!(
                output,
                "{source}::Variant{index}(inner) => Self::Variant{index}(inner.into()),"
            )
            .unwrap();
        }
        output.push_str("} } }\n");
        return;
    }
    match schema["type"].as_str().unwrap() {
        "string" => {
            writeln!(output, "impl From<{source}> for {target} {{ fn from(value: {source}) -> Self {{ Self(value.0) }} }}").unwrap();
        }
        "object" => {
            let properties = schema["properties"].as_object().unwrap();
            let required = schema["required"].as_array();
            for (key, child) in properties {
                component_moves(child, &format!("{suffix}{}", pascal(key)), output);
            }
            writeln!(
                output,
                "impl From<{source}> for {target} {{ fn from(value: {source}) -> Self {{ Self {{"
            )
            .unwrap();
            for key in properties.keys() {
                let conversion =
                    if required.is_some_and(|keys| keys.iter().any(|value| value == key)) {
                        "into()"
                    } else {
                        "map(Into::into)"
                    };
                writeln!(output, "r#{key}: value.r#{key}.{conversion},").unwrap();
            }
            output.push_str("} } }\n");
        }
        kind => panic!("Agent Trace component moves do not support {kind}"),
    }
}

fn pascal(value: &str) -> String {
    value
        .split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars.next().unwrap().to_ascii_uppercase().to_string() + chars.as_str()
        })
        .collect()
}

fn main() {
    let output_directory = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let mut artifact_schema = None;
    let mut runtime_schema = None;
    let mut generated =
        String::from("// Generated at build time from the committed Agent Trace JSON Schemas.\n");
    for name in ROOTS {
        let path = format!("../generated/{name}.schema.json");
        println!("cargo:rerun-if-changed={path}");
        let source = fs::read_to_string(&path).unwrap();
        let schema = schema_registry_rust::parse_schema(&source).unwrap();
        // Preserve medium source format; runtime serialization stays strict.
        let options = Options {
            validate_object_serialization: name == "AgentTraceRuntimeV1",
            ..Options::default()
        };
        generated.push_str(&generate(&schema, name, &options).unwrap());
        if name == "AgentTraceV2" {
            artifact_schema = Some(schema);
        } else if name == "AgentTraceRuntimeV1" {
            runtime_schema = Some(schema);
        }
        if matches!(name, "PublicFooterV2" | "PrivateFooterV2") {
            let destination = output_directory.join(format!("{name}.schema.json"));
            // Generated authorities are read-only; never copy that mode to mutable build outputs.
            if destination.exists() {
                fs::remove_file(&destination).unwrap();
            }
            fs::write(destination, &source).unwrap();
        }
    }
    let artifact_schema = artifact_schema.unwrap();
    let runtime_schema = runtime_schema.unwrap();
    for key in ["who", "why", "how", "where"] {
        assert_eq!(
            artifact_schema["properties"][key], runtime_schema["properties"][key],
            "Runtime and artifact component schemas must remain identical: {key}"
        );
        component_moves(
            &artifact_schema["properties"][key],
            &pascal(key),
            &mut generated,
        );
    }
    assert_eq!(
        artifact_schema["properties"]["type"]["enum"],
        serde_json::json!(["agent-trace/v2"])
    );
    assert_eq!(
        runtime_schema["properties"]["type"]["enum"],
        serde_json::json!(["agent-trace-runtime/v1"])
    );
    // Reuse the runtime discriminator's longer string allocation.
    generated.push_str("impl From<AgentTraceRuntimeV1Type> for AgentTraceV2Type { fn from(value: AgentTraceRuntimeV1Type) -> Self { let mut value = value.0; value.clear(); value.push_str(\"agent-trace/v2\"); Self(value) } }\n");
    fs::write(output_directory.join("types.rs"), generated).unwrap();
}
