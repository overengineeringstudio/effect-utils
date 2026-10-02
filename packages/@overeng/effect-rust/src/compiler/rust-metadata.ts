import { reject, type ContractIR } from './ir.ts'
import { emitJsonSchema } from './json-schema.ts'

/** Emit lawful schemars implementations from the compiler's normalized schema definitions. */
export const emitRustMetadata = ({
  ir,
  names,
  literal,
}: {
  ir: ContractIR
  names: Readonly<Record<string, string>>
  literal: (value: string) => string
}): string => {
  const root = Object.keys(names)[0]
  if (root === undefined) return ''
  const document = emitJsonSchema(ir, root)
  const definitions = document.$defs
  if (
    typeof definitions !== 'object' ||
    definitions === null ||
    Array.isArray(definitions) === true
  )
    return reject(
      '$/schemaMetadata',
      'Invalid normalized schema definitions',
      'Provide an admitted contract IR',
    )
  // Rust admission restricts every wire definition name to ASCII identifiers, so none
  // need JSON Pointer/URI escaping. Take the definition path from the normalized document.
  const reference = document.$ref
  if (typeof reference !== 'string' || reference.endsWith(root) === false)
    return reject(
      '$/schemaMetadata',
      'Invalid normalized root reference',
      'Provide an admitted contract IR',
    )
  const referencePrefix = reference.slice(0, -root.length)
  const implementations = Object.entries(names).map(([wire, rust]) => {
    const definition: unknown = Object.getOwnPropertyDescriptor(definitions, wire)?.value
    const json = JSON.stringify(definition)
    if (json === undefined)
      return reject(
        `$/schemaMetadata/${wire}`,
        'Missing normalized schema definition',
        'Provide an admitted contract IR',
      )
    return `impl schemars::JsonSchema for ${rust} {
    fn schema_name() -> std::borrow::Cow<'static, str> { ${literal(wire)}.into() }
    fn schema_id() -> std::borrow::Cow<'static, str> { concat!(module_path!(), "::", ${literal(rust)}).into() }
    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        effect_rust_schema_metadata::schema(${literal(json)}, generator)
    }
}`
  })
  return `// Register through schemars, rather than inserting definitions under hard-coded names:
// its generator owns reference paths, recursion, and collisions with other crates.
mod effect_rust_schema_metadata {
    pub(super) fn schema(json: &str, generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let mut value: serde_json::Value = serde_json::from_str(json).expect("compiler-emitted schema JSON");
        rewrite(&mut value, generator);
        schemars::Schema::try_from(value).expect("compiler-emitted object schema")
    }
    fn rewrite(value: &mut serde_json::Value, generator: &mut schemars::SchemaGenerator) {
        match value {
            serde_json::Value::Array(values) => {
                for value in values { rewrite(value, generator); }
            }
            serde_json::Value::Object(object) => {
                for value in object.values_mut() { rewrite(value, generator); }
                if let Some(reference) = object.get("$ref").and_then(serde_json::Value::as_str) {
                    let schema = match reference {
${Object.entries(names)
  .map(
    ([wire, rust]) =>
      `                        ${literal(`${referencePrefix}${wire}`)} => generator.subschema_for::<super::${rust}>(),`,
  )
  .join('\n')}
                        _ => unreachable!("compiler-emitted definition reference"),
                    };
                    object.remove("$ref");
                    if let serde_json::Value::Object(replacement) = schema.to_value() {
                        for (key, value) in replacement { object.entry(key).or_insert(value); }
                    } else {
                        unreachable!("generated contracts have object schemas");
                    }
                }
            }
            _ => {}
        }
    }
}

${implementations.join('\n\n')}`
}
