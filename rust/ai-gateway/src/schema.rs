//! Provider schemas are projections; only the caller's original schema validates output.

use std::collections::BTreeSet;

use serde_json::{json, Map, Value};

use crate::{Error, Result};

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation {
        errors: vec![message.into()],
        usage: None,
    }
}

/// Resolve local references and close strict objects without changing `original`.
pub(crate) fn project(original: &Value) -> Result<Value> {
    project_node(original, original, &mut BTreeSet::new())
}

fn project_node(node: &Value, root: &Value, active: &mut BTreeSet<String>) -> Result<Value> {
    let Some(object) = node.as_object() else {
        return if node.is_boolean() {
            Ok(node.clone())
        } else {
            Err(invalid("JSON Schema must be an object or boolean"))
        };
    };
    if let Some(reference) = object.get("$ref") {
        let reference = reference
            .as_str()
            .ok_or_else(|| invalid("$ref must be a string"))?;
        let pointer = reference.strip_prefix('#').ok_or_else(|| {
            invalid(format!(
                "Only internal JSON Schema references are supported: {reference}"
            ))
        })?;
        if !pointer.is_empty() && !pointer.starts_with('/') {
            return Err(invalid(format!(
                "Reference is not an internal JSON pointer: {reference}"
            )));
        }
        let target = root
            .pointer(pointer)
            .ok_or_else(|| invalid(format!("Unresolved JSON Schema reference: {reference}")))?;
        if !active.insert(reference.to_owned()) {
            return Err(invalid(format!(
                "Cyclic JSON Schema reference: {reference}"
            )));
        }
        let resolved = project_node(target, root, active)?;
        let mut siblings = object.clone();
        siblings.remove("$ref");
        siblings.remove("$defs");
        siblings.remove("definitions");
        let result = if siblings.is_empty() {
            resolved
        } else {
            // Reference siblings are conjunctive, not overrides of the target.
            json!({"allOf": [resolved, project_node(&Value::Object(siblings), root, active)?]})
        };
        active.remove(reference);
        return Ok(result);
    }

    let mut projected = object.clone();
    // Definitions are consumed by reference expansion, never sent as dangling references.
    projected.remove("$defs");
    projected.remove("definitions");
    projected.remove("$schema");
    projected.remove("format");
    if let Some(value) = projected.remove("const") {
        projected.insert("enum".into(), json!([value]));
    }
    for keyword in ["allOf", "anyOf", "oneOf", "prefixItems"] {
        if let Some(value) = projected.get_mut(keyword) {
            let schemas = value
                .as_array_mut()
                .ok_or_else(|| invalid(format!("{keyword} must be an array")))?;
            for schema in schemas {
                *schema = project_node(schema, root, active)?;
            }
        }
    }
    for keyword in [
        "items",
        "additionalItems",
        "contains",
        "not",
        "if",
        "then",
        "else",
        "propertyNames",
        "additionalProperties",
        "unevaluatedProperties",
        "unevaluatedItems",
    ] {
        if let Some(value) = projected.get_mut(keyword) {
            if keyword == "items" && value.is_array() {
                for schema in value.as_array_mut().expect("array checked") {
                    *schema = project_node(schema, root, active)?;
                }
            } else {
                *value = project_node(value, root, active)?;
            }
        }
    }
    for keyword in ["patternProperties", "dependentSchemas"] {
        if let Some(value) = projected.get_mut(keyword) {
            let schemas = value
                .as_object_mut()
                .ok_or_else(|| invalid(format!("{keyword} must be an object")))?;
            for schema in schemas.values_mut() {
                *schema = project_node(schema, root, active)?;
            }
        }
    }
    if let Some(value) = projected.remove("oneOf") {
        projected.insert("anyOf".into(), value);
    }
    let is_object = object.contains_key("properties")
        || object.get("type").is_some_and(|kind| {
            kind == "object"
                || kind
                    .as_array()
                    .is_some_and(|kinds| kinds.iter().any(|kind| kind == "object"))
        });
    if is_object {
        let required: BTreeSet<&str> = match object.get("required") {
            None => BTreeSet::new(),
            Some(value) => value
                .as_array()
                .ok_or_else(|| invalid("required must be an array"))?
                .iter()
                .map(|name| {
                    name.as_str()
                        .ok_or_else(|| invalid("required names must be strings"))
                })
                .collect::<Result<_>>()?,
        };
        let mut properties = Map::new();
        if let Some(value) = object.get("properties") {
            for (name, schema) in value
                .as_object()
                .ok_or_else(|| invalid("properties must be an object"))?
            {
                let schema = project_node(schema, root, active)?;
                properties.insert(
                    name.clone(),
                    if required.contains(name.as_str()) {
                        schema
                    } else {
                        json!({"anyOf": [schema, {"type": "null"}]})
                    },
                );
            }
        }
        projected.insert(
            "required".into(),
            Value::Array(properties.keys().cloned().map(Value::String).collect()),
        );
        projected.insert("properties".into(), Value::Object(properties));
        projected.insert("additionalProperties".into(), Value::Bool(false));
    }
    Ok(Value::Object(projected))
}

/// Validate against the unchanged caller schema, not the stricter provider projection.
pub(crate) fn validate(schema: &Value, value: &Value) -> Result<()> {
    let validator = jsonschema::validator_for(schema)
        .map_err(|error| invalid(format!("Invalid original JSON Schema: {error}")))?;
    let errors: Vec<String> = validator
        .iter_errors(value)
        .map(|error| error.to_string())
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(Error::Validation {
            errors,
            usage: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_projection_does_not_replace_original_validation() {
        let original = json!({"type":"object","properties":{"name":{"type":"string"},"age":{"type":"integer","minimum":1}},"required":["name"]});
        let before = original.clone();
        let projected = project(&original).unwrap();
        assert_eq!(original, before);
        assert_eq!(projected["additionalProperties"], false);
        let required = projected["required"].as_array().unwrap();
        assert_eq!(required.len(), 2);
        assert!(required.contains(&json!("age")));
        assert!(required.contains(&json!("name")));
        assert!(validate(&original, &json!({"name":"Ada"})).is_ok());
        assert!(validate(&projected, &json!({"name":"Ada"})).is_err());
        assert!(validate(&projected, &json!({"name":"Ada","age":null})).is_ok());
        assert!(validate(&original, &json!({"name":"Ada","age":null})).is_err());
        assert!(validate(&original, &json!({"name":"Ada","age":0})).is_err());
    }

    #[test]
    fn references_resolve_json_pointer_escapes() {
        let schema = json!({"$defs":{"a/b~c":{"type":"object","properties":{"nested":{"type":"string"}}}},"$ref":"#/$defs/a~1b~0c"});
        let result = project(&schema).unwrap();
        assert_eq!(result["additionalProperties"], false);
        assert_eq!(result["required"], json!(["nested"]));
        assert!(result.get("$ref").is_none());
    }

    #[test]
    fn unresolved_external_and_cyclic_references_fail() {
        for schema in [
            json!({"$ref":"#/$defs/missing"}),
            json!({"$ref":"https://example.com/schema"}),
            json!({"$ref":"#"}),
            json!({"$defs":{"a":{"$ref":"#/$defs/b"},"b":{"$ref":"#/$defs/a"}},"$ref":"#/$defs/a"}),
        ] {
            assert!(matches!(project(&schema), Err(Error::Validation { .. })));
        }
    }
}
