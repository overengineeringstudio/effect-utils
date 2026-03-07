use nix_wasm_rust::{Type, Value};
use yaml_rust2::{Yaml, YamlEmitter, YamlLoader};

fn yaml_to_value(yaml: &Yaml) -> Value {
    match yaml {
        Yaml::Real(_) => Value::make_float(yaml.as_f64().expect("YAML floating point number")),
        Yaml::Integer(n) => Value::make_int(*n),
        Yaml::String(s) => Value::make_string(s),
        Yaml::Boolean(b) => Value::make_bool(*b),
        Yaml::Array(array) => {
            Value::make_list(&array.iter().map(yaml_to_value).collect::<Vec<_>>())
        }
        Yaml::Hash(hash) => Value::make_attrset(
            &hash
                .iter()
                .map(|(key, value)| {
                    let key: &str = match &key {
                        Yaml::String(s) => s,
                        _ => panic!("non-string YAML keys are not supported, in: {:?}", key),
                    };
                    (key, yaml_to_value(value))
                })
                .collect::<Vec<_>>(),
        ),
        Yaml::Null => Value::make_null(),
        _ => panic!("unimplemented YAML value: {:?}", yaml),
    }
}

#[no_mangle]
pub extern "C" fn fromYAML(arg: Value) -> Value {
    Value::make_list(
        &YamlLoader::load_from_str(&arg.get_string())
            .unwrap()
            .iter()
            .map(yaml_to_value)
            .collect::<Vec<_>>(),
    )
}

fn to_yaml(v: Value) -> Yaml {
    match v.get_type() {
        Type::Int => Yaml::Integer(v.get_int()),
        Type::Float => Yaml::Real(format_yaml_float(v.get_float())),
        Type::Bool => Yaml::Boolean(v.get_bool()),
        Type::String => Yaml::String(v.get_string()),
        Type::Null => Yaml::Null,
        Type::Attrs => Yaml::Hash(
            v.get_attrset()
                .into_iter()
                .map(|(key, value)| (Yaml::String(key), to_yaml(value)))
                .collect(),
        ),
        Type::List => Yaml::Array(v.get_list().into_iter().map(to_yaml).collect::<Vec<_>>()),
        _ => panic!(
            "Nix type {} cannot be serialized to YAML",
            v.get_type() as u64
        ),
    }
}

fn format_yaml_float(value: f64) -> String {
    if value.is_nan() {
        ".nan".to_string()
    } else if value == f64::INFINITY {
        ".inf".to_string()
    } else if value == f64::NEG_INFINITY {
        "-.inf".to_string()
    } else {
        let rendered = value.to_string();
        if rendered.contains(['.', 'e', 'E']) {
            rendered
        } else {
            format!("{rendered}.0")
        }
    }
}

/** Convert block-style single-key mappings back to flow-style.
 * pnpm lockfiles use flow-style for entries like `resolution: {integrity: sha512-...}`
 * and `engines: {node: '>=6.9.0'}`. The yaml_rust2 emitter always produces block-style,
 * which pnpm cannot resolve correctly in offline mode. */
fn collapse_single_key_block_mappings(yaml: &str) -> String {
    let lines: Vec<&str> = yaml.lines().collect();
    let mut result = String::with_capacity(yaml.len());
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];

        // Look for a key-only line (e.g. "    resolution:") followed by a single
        // scalar value line (e.g. "      integrity: sha512-...") with no further
        // children at the same or deeper indent.
        if line.ends_with(':') && i + 1 < lines.len() {
            let key_indent = line.len() - line.trim_start().len();
            let next = lines[i + 1];
            let next_indent = next.len() - next.trim_start().len();

            // Next line is indented exactly 2 more and contains a key: value
            if next_indent == key_indent + 2 {
                let next_trimmed = next.trim();
                if let Some(colon_pos) = next_trimmed.find(": ") {
                    let child_key = &next_trimmed[..colon_pos];
                    let child_val = &next_trimmed[colon_pos + 2..];

                    // Ensure no further children at same or deeper indent
                    let has_more_children = i + 2 < lines.len() && {
                        let after = lines[i + 2];
                        let after_indent = after.len() - after.trim_start().len();
                        after_indent > key_indent && !after.trim().is_empty()
                    };

                    if !has_more_children {
                        let parent_key = line.trim().trim_end_matches(':');
                        let indent = &line[..key_indent];
                        result.push_str(indent);
                        result.push_str(parent_key);
                        result.push_str(": {");
                        result.push_str(child_key);
                        result.push_str(": ");
                        result.push_str(child_val);
                        result.push_str("}\n");
                        i += 2;
                        continue;
                    }
                }
            }
        }

        result.push_str(line);
        result.push('\n');
        i += 1;
    }

    result
}

#[no_mangle]
pub extern "C" fn toYAML(arg: Value) -> Value {
    let mut out_str = String::new();

    for v in arg.get_list() {
        let yaml = to_yaml(v);
        let mut emitter = YamlEmitter::new(&mut out_str);
        emitter.dump(&yaml).unwrap();
        out_str.push('\n');
    }

    Value::make_string(&collapse_single_key_block_mappings(&out_str))
}

#[cfg(test)]
mod tests {
    use super::{collapse_single_key_block_mappings, format_yaml_float};

    #[test]
    fn collapses_single_key_mapping() {
        let input = "resolution:\n  integrity: sha512-abc\n";
        let output = collapse_single_key_block_mappings(input);
        assert_eq!(output, "resolution: {integrity: sha512-abc}\n");
    }

    #[test]
    fn leaves_nested_mapping_unchanged() {
        let input = "resolution:\n  integrity: sha512-abc\n  tarball: https://example.test\n";
        let output = collapse_single_key_block_mappings(input);
        assert_eq!(output, input);
    }

    #[test]
    fn preserves_whole_number_float_scalars() {
        assert_eq!(format_yaml_float(1.0), "1.0");
        assert_eq!(format_yaml_float(-2.0), "-2.0");
    }

    #[test]
    fn preserves_special_float_scalars() {
        assert_eq!(format_yaml_float(f64::INFINITY), ".inf");
        assert_eq!(format_yaml_float(f64::NEG_INFINITY), "-.inf");
        assert_eq!(format_yaml_float(f64::NAN), ".nan");
    }
}
