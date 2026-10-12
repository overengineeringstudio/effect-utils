//! Strict, deterministic JSON Schema lowering for serde consumers.
//! Strings use the authority's JavaScript UTF-16 length semantics. Generated code
//! requires serde (derive), `serde_json` and regex, plus the runtime contract below.
use serde_json::Value;
use std::{collections::BTreeSet, fmt::Write as _};

/// Allocation-free exact numeric checks, also emitted in `RUNTIME_HELPERS`.
pub mod numbers;

/// Runtime module supplying `Error::Invalid(String)`, `deserialize_optional`,
/// `utf16_len`, `is_js_trimmed`, and the helpers in `numbers`.
/// Numeric helpers require `serde_json`'s ordinary (non-`arbitrary_precision`) Number.
#[derive(Debug, Clone)]
pub struct Options<'a> {
    pub runtime_module: &'a str,
    /// Enforce object cardinality again at serialization after public-field mutation.
    /// Disable only when retaining an existing generated object source contract.
    pub validate_object_serialization: bool,
}
impl Default for Options<'_> {
    fn default() -> Self {
        Self {
            runtime_module: "crate",
            validate_object_serialization: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub path: String,
    pub message: String,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}
impl std::error::Error for Error {}
fn reject<T>(path: &str, message: impl Into<String>) -> Result<T, Error> {
    Err(Error {
        path: path.into(),
        message: message.into(),
    })
}

/// Parse a JSON Schema document, retaining property order for wire-compatible output.
///
/// # Errors
/// Returns a schema error with the JSON parser's source location.
pub fn parse_schema(source: &str) -> Result<Value, Error> {
    serde_json::from_str(source).map_err(|error| Error {
        path: "$".into(),
        message: error.to_string(),
    })
}

/// Generate one named root (without a provenance banner).
///
/// # Errors
/// Rejects unsupported keywords, malformed constraints, unresolved/cyclic local
/// references, open objects, and non-discriminated unions with overlapping kinds.
/// Local JSON Pointer references may address `$defs` or `definitions`. External
/// references must be bundled by the caller before lowering.
pub fn generate(schema: &Value, name: &str, options: &Options<'_>) -> Result<String, Error> {
    if !identifier(name)
        || name == "Self"
        || !name.starts_with(|c: char| c.is_ascii_uppercase())
        || name.contains('_')
    {
        return reject(
            "$",
            "root name must be an alphanumeric PascalCase Rust identifier other than Self",
        );
    }
    if !options.runtime_module.split("::").all(identifier) {
        return reject("$", "runtime_module must be a Rust module path");
    }
    let schema = normalize(schema, schema, "$", &mut Vec::new(), false)?;
    check(&schema, "$", false)?;
    check_names(&schema, name, &mut BTreeSet::new())?;
    let mut output = String::new();
    emit(&schema, name, &mut output, options);
    Ok(output)
}
fn identifier(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}
fn annotation(key: &str) -> bool {
    matches!(
        key,
        "$schema"
            | "$id"
            | "$comment"
            | "$defs"
            | "definitions"
            | "title"
            | "description"
            | "default"
            | "examples"
            | "readOnly"
            | "writeOnly"
            | "deprecated"
    ) || key.starts_with("x-")
}
// Admit only the shared ECMAScript/Rust regex subset. In particular wildcard
// dot and Unicode shorthand classes have different line/character semantics.
fn portable_pattern(pattern: &str) -> bool {
    if ["&&", "--", "~~"]
        .iter()
        .any(|operator| pattern.contains(operator))
    {
        return false;
    }
    let mut escaped = false;
    let mut in_class = false;
    let mut chars = pattern.chars().peekable();
    while let Some(character) = chars.next() {
        if escaped {
            if character.is_ascii_alphabetic()
                && !matches!(character, 'd' | 'n' | 'r' | 't' | 'f' | 'v' | 'x' | 'u')
            {
                return false;
            }
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '[' if in_class => return false,
            '[' => in_class = true,
            ']' => in_class = false,
            '.' if !in_class => return false,
            '(' if !in_class && chars.peek() == Some(&'?') => {
                chars.next();
                if chars.next() != Some(':') {
                    return false;
                }
            }
            _ => {}
        }
    }
    true
}

fn normalize(
    schema: &Value,
    root: &Value,
    path: &str,
    stack: &mut Vec<String>,
    fragment: bool,
) -> Result<Value, Error> {
    let Some(object) = schema.as_object() else {
        return reject(path, "boolean/non-object schemas are unsupported");
    };
    if object.contains_key("$ref") {
        return normalize_reference(object, root, path, stack, fragment);
    }
    let mut result = object.clone();
    if let Some(value) = result.get_mut("properties") {
        let Some(children) = value.as_object_mut() else {
            return reject(path, "properties must be an object");
        };
        for (name, child) in children {
            *child = normalize(child, root, &format!("{path}/{name}"), stack, false)?;
        }
    }
    if let Some(child) = result.get_mut("items") {
        *child = normalize(child, root, &format!("{path}/items"), stack, false)?;
    }
    for key in ["allOf", "anyOf", "oneOf"] {
        if let Some(value) = result.get_mut(key) {
            let Some(children) = value.as_array_mut() else {
                return reject(path, format!("{key} must be an array"));
            };
            if children.is_empty() {
                return reject(path, format!("{key} must not be empty"));
            }
            for (index, child) in children.iter_mut().enumerate() {
                *child = normalize(
                    child,
                    root,
                    &format!("{path}/{key}/{index}"),
                    stack,
                    key == "allOf",
                )?;
            }
        }
    }
    if !fragment
        && !result.contains_key("type")
        && !result.contains_key("anyOf")
        && !result.contains_key("oneOf")
    {
        if let Some(value) = result.get("const") {
            let kind = match value {
                Value::Null => "null",
                Value::Bool(_) => "boolean",
                Value::String(_) => "string",
                Value::Number(number) if number.is_i64() || number.is_u64() => "integer",
                Value::Number(_) => "number",
                _ => return reject(path, "only scalar const is supported"),
            };
            result.insert("type".into(), Value::String(kind.into()));
        }
    }
    Ok(Value::Object(result))
}
fn normalize_reference(
    object: &serde_json::Map<String, Value>,
    root: &Value,
    path: &str,
    stack: &mut Vec<String>,
    fragment: bool,
) -> Result<Value, Error> {
    let Some(reference) = object["$ref"].as_str() else {
        return reject(path, "$ref must be a string");
    };
    let Some(pointer) = reference.strip_prefix('#') else {
        return reject(path, "external $ref must be bundled before lowering");
    };
    if !pointer.is_empty() && !pointer.starts_with('/') {
        return reject(path, "only JSON Pointer $ref is supported");
    }
    if stack.iter().any(|entry| entry == reference) {
        return reject(path, "recursive $ref is unsupported");
    }
    let Some(target) = root.pointer(pointer) else {
        return reject(path, format!("unresolved $ref {reference}"));
    };
    stack.push(reference.into());
    let mut resolved = normalize(target, root, path, stack, fragment)?;
    stack.pop();
    for (key, value) in object {
        if key == "$ref" || annotation(key) {
            continue;
        }
        if key != "allOf" {
            return reject(path, "$ref siblings may only add allOf constraints/annotations");
        }
        let Some(parts) = value.as_array() else {
            return reject(path, "allOf must be an array");
        };
        for part in parts {
            let part = normalize(part, root, path, stack, true)?;
            resolved
                .as_object_mut()
                .unwrap()
                .entry("allOf")
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .unwrap()
                .push(part);
        }
    }
    Ok(resolved)
}

fn kind(schema: &Value) -> Option<&str> {
    schema.get("type").and_then(Value::as_str)
}
fn check(schema: &Value, path: &str, fragment: bool) -> Result<(), Error> {
    let object = schema.as_object().unwrap();
    let union = object.get("anyOf").or_else(|| object.get("oneOf"));
    if object.contains_key("anyOf") && object.contains_key("oneOf") {
        return reject(path, "combined union applicators are unsupported");
    }
    let schema_kind = kind(schema);
    if fragment
        && object.keys().any(|key| {
            matches!(
                key.as_str(),
                "type"
                    | "properties"
                    | "required"
                    | "additionalProperties"
                    | "items"
                    | "anyOf"
                    | "oneOf"
            )
        })
    {
        return reject(path, "allOf only supports constraint/annotation fragments");
    }
    if !fragment && union.is_none() && schema_kind.is_none() {
        return reject(path, "schema requires a single type or union");
    }
    let allowed = allowed_keywords(schema_kind, union.is_some(), path)?;
    check_keywords(object, allowed, path)?;
    if schema_kind == Some("object") {
        check_object(schema, path)?;
    }
    if schema_kind == Some("array") {
        let Some(items) = schema.get("items") else {
            return reject(path, "array requires homogeneous items");
        };
        check(items, &format!("{path}/items"), false)?;
    }
    if let Some(parts) = schema.get("allOf").and_then(Value::as_array) {
        for part in parts {
            check(part, path, true)?;
            let mut keys = Vec::new();
            fragment_keys(part, &mut keys);
            for key in keys {
                if !allowed.contains(&key.as_str()) {
                    return reject(
                        path,
                        format!("allOf keyword {key} does not apply to this type"),
                    );
                }
            }
        }
    }
    check_literals(schema, schema_kind, path, fragment)?;
    if let Some(branches) = union.and_then(Value::as_array) {
        for branch in branches {
            check(branch, path, false)?;
        }
        if !disjoint(branches) {
            return reject(
                path,
                "union must have distinct primitive kinds or a required constant discriminator",
            );
        }
    }
    Ok(())
}

fn allowed_keywords(
    schema_kind: Option<&str>,
    union: bool,
    path: &str,
) -> Result<&'static [&'static str], Error> {
    let allowed: &[&str] = if union {
        if schema_kind.is_some() {
            return reject(path, "union with sibling type is unsupported");
        }
        &["anyOf", "oneOf", "allOf"]
    } else {
        match schema_kind.unwrap_or("fragment") {
            "object" => &[
                "type",
                "properties",
                "required",
                "additionalProperties",
                "minProperties",
                "allOf",
            ],
            "string" => &[
                "type",
                "minLength",
                "maxLength",
                "pattern",
                "enum",
                "const",
                "allOf",
            ],
            "integer" | "number" => &[
                "type",
                "minimum",
                "maximum",
                "exclusiveMinimum",
                "exclusiveMaximum",
                "multipleOf",
                "enum",
                "const",
                "allOf",
            ],
            "boolean" | "null" => &["type", "enum", "const", "allOf"],
            "array" => &[
                "type",
                "items",
                "minItems",
                "maxItems",
                "uniqueItems",
                "allOf",
            ],
            "fragment" => &[
                "minLength",
                "maxLength",
                "pattern",
                "enum",
                "const",
                "minProperties",
                "minimum",
                "maximum",
                "exclusiveMinimum",
                "exclusiveMaximum",
                "multipleOf",
                "minItems",
                "maxItems",
                "uniqueItems",
                "allOf",
            ],
            unsupported => return reject(path, format!("unsupported type {unsupported}")),
        }
    };
    Ok(allowed)
}

fn check_keywords(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
    path: &str,
) -> Result<(), Error> {
    for (key, value) in object {
        if annotation(key) {
            continue;
        }
        if !allowed.contains(&key.as_str()) {
            return reject(path, format!("unsupported keyword {key}"));
        }
        if matches!(
            key.as_str(),
            "minLength" | "maxLength" | "minProperties" | "minItems" | "maxItems"
        ) && value.as_u64().is_none()
        {
            return reject(path, format!("{key} requires a nonnegative integer"));
        }
        if matches!(
            key.as_str(),
            "minimum" | "maximum" | "exclusiveMinimum" | "exclusiveMaximum" | "multipleOf"
        ) && value.as_f64().is_none()
        {
            return reject(path, format!("{key} requires a finite number"));
        }
        if key == "multipleOf" && value.as_f64().unwrap() <= 0.0 {
            return reject(path, "multipleOf must be positive");
        }
        if key == "uniqueItems" && !value.is_boolean() {
            return reject(path, "uniqueItems must be boolean");
        }
        if key == "enum" && value.as_array().is_none_or(Vec::is_empty) {
            return reject(path, "enum must be a nonempty array");
        }
        if key == "pattern" {
            let Some(pattern) = value.as_str() else {
                return reject(path, "pattern must be a string");
            };
            if pattern != r"^\S[\s\S]*\S$|^\S$|^$" && pattern != r"^[^\r\n]+$" {
                if !portable_pattern(pattern) {
                    return reject(path, "pattern uses unsupported ECMAScript constructs");
                }
                regex::Regex::new(&pattern.replace(r"\d", "[0-9]")).map_err(|error| Error {
                    path: path.into(),
                    message: format!("unsupported pattern: {error}"),
                })?;
            }
        }
    }
    Ok(())
}

fn check_object(schema: &Value, path: &str) -> Result<(), Error> {
        if schema["additionalProperties"] != false {
            return reject(path, "objects must forbid additionalProperties");
        }
        let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
            return reject(path, "object requires properties");
        };
        let mut minimum = Vec::new();
        constraints(schema, "minProperties", &mut minimum);
        if minimum
            .iter()
            .filter_map(|value| value.as_u64())
            .any(|value| value > properties.len() as u64)
        {
            return reject(
                path,
                "minProperties exceeds the closed object's declared properties",
            );
        }
        let mut names = BTreeSet::new();
        for (key, child) in properties {
            if !identifier(key)
                || key.chars().all(|c| c == '_')
                || matches!(key.as_str(), "self" | "Self" | "super" | "crate")
                || !names.insert(pascal(key))
            {
                return reject(path, format!("unsupported/colliding Rust field name {key}"));
            }
            check(child, &format!("{path}/{key}"), false)?;
        }
        if let Some(required) = schema.get("required") {
            let Some(required) = required.as_array() else {
                return reject(path, "required must be an array");
            };
            let mut seen = BTreeSet::new();
            for key in required {
                if !key
                    .as_str()
                    .is_some_and(|key| properties.contains_key(key) && seen.insert(key))
                {
                    return reject(path, "required names must be unique declared properties");
                }
            }
        }
    Ok(())
}

fn check_literals(
    schema: &Value,
    schema_kind: Option<&str>,
    path: &str,
    fragment: bool,
) -> Result<(), Error> {
    for key in ["const", "enum"] {
        let mut constraints_found = Vec::new();
        constraints(schema, key, &mut constraints_found);
        for value in constraints_found {
            let values: Vec<&Value> = if key == "enum" {
                value.as_array().unwrap().iter().collect()
            } else {
                vec![value]
            };
            for value in values {
                let valid = match schema_kind {
                    Some("string") => value.is_string(),
                    Some("boolean") => value.is_boolean(),
                    Some("null") => value.is_null(),
                    Some("number") => value.is_number(),
                    Some("integer") => value.as_number().is_some_and(numbers::is_integer),
                    None if fragment => true,
                    _ => false,
                };
                if !valid {
                    return reject(
                        path,
                        format!("{key} value does not match supported scalar type"),
                    );
                }
            }
        }
    }
    Ok(())
}
fn fragment_keys<'a>(schema: &'a Value, keys: &mut Vec<&'a String>) {
    for key in schema
        .as_object()
        .unwrap()
        .keys()
        .filter(|key| !annotation(key) && key.as_str() != "allOf")
    {
        keys.push(key);
    }
    if let Some(parts) = schema.get("allOf").and_then(Value::as_array) {
        for part in parts {
            fragment_keys(part, keys);
        }
    }
}
fn literal(schema: &Value) -> Option<&Value> {
    schema.get("const").or_else(|| {
        schema
            .get("enum")
            .and_then(Value::as_array)
            .filter(|values| values.len() == 1)
            .map(|values| &values[0])
    })
}
fn literal_equal(left: &Value, right: &Value) -> bool {
    if let (Some(left), Some(right)) = (left.as_number(), right.as_number()) {
        numbers::numbers_equal(left, right)
    } else {
        left == right
    }
}

fn disjoint(branches: &[Value]) -> bool {
    for (index, left) in branches.iter().enumerate() {
        for right in &branches[index + 1..] {
            let different_kinds = kind(left) != kind(right)
                && !matches!(
                    (kind(left), kind(right)),
                    (Some("integer"), Some("number")) | (Some("number"), Some("integer"))
                );
            if different_kinds && kind(left).is_some() && kind(right).is_some() {
                continue;
            }
            if literal(left)
                .zip(literal(right))
                .is_some_and(|(a, b)| !literal_equal(a, b))
            {
                continue;
            }
            let discriminator = left
                .get("properties")
                .and_then(Value::as_object)
                .is_some_and(|properties| {
                    properties.iter().any(|(key, child)| {
                        let required = |schema: &Value| {
                            schema
                                .get("required")
                                .and_then(Value::as_array)
                                .is_some_and(|keys| keys.iter().any(|value| value == key))
                        };
                        required(left)
                            && required(right)
                            && right
                                .get("properties")
                                .and_then(|properties| properties.get(key))
                                .and_then(literal)
                                .zip(literal(child))
                                .is_some_and(|(a, b)| !literal_equal(a, b))
                    })
                });
            if !discriminator {
                return false;
            }
        }
    }
    true
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

fn constraints<'a>(schema: &'a Value, key: &str, values: &mut Vec<&'a Value>) {
    if let Some(value) = schema.get(key) {
        values.push(value);
    }
    if let Some(parts) = schema.get("allOf").and_then(Value::as_array) {
        for part in parts {
            constraints(part, key, values);
        }
    }
}
fn check_names(schema: &Value, name: &str, names: &mut BTreeSet<String>) -> Result<(), Error> {
    if !names.insert(name.into()) {
        return reject("$", format!("generated Rust type name collision: {name}"));
    }
    if let Some(branches) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Value::as_array)
    {
        for (index, branch) in branches.iter().enumerate() {
            check_names(branch, &format!("{name}Variant{index}"), names)?;
        }
    }
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        let mut minimum = Vec::new();
        constraints(schema, "minProperties", &mut minimum);
        if minimum.iter().any(|value| value.as_u64().unwrap() > 0)
            && !names.insert(format!("Raw{name}"))
        {
            return reject(
                "$",
                format!("generated Rust raw type name collision: Raw{name}"),
            );
        }
        for (key, child) in properties {
            check_names(child, &format!("{name}{}", pascal(key)), names)?;
        }
    }
    if let Some(items) = schema.get("items") {
        check_names(items, &format!("{name}Item"), names)?;
    }
    Ok(())
}

// Retain the established object/string source format; other kinds use reusable runtime checks.
#[allow(clippy::too_many_lines)]
fn emit(schema: &Value, name: &str, out: &mut String, options: &Options<'_>) {
    let runtime = options.runtime_module;
    if let Some(branches) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Value::as_array)
    {
        emit_union(branches, name, out, options);
        return;
    }
    match schema["type"].as_str().expect("validated schema type") {
        "object" => {
            assert_eq!(schema["additionalProperties"], false, "Open object {name}");
            let properties = schema["properties"].as_object().unwrap();
            let required = schema.get("required").and_then(Value::as_array);
            let is_required = |key: &str| required.is_some_and(|r| r.iter().any(|v| v == key));
            for (key, child) in properties {
                emit(child, &format!("{name}{}", pascal(key)), out, options);
            }
            let mut minimum = Vec::new();
            constraints(schema, "minProperties", &mut minimum);
            let min = minimum.iter().filter_map(|v| v.as_u64()).max().unwrap_or(0);
            let camel_case = properties
                .keys()
                .any(|key| key.chars().any(|c| c.is_ascii_uppercase()));
            if camel_case {
                out.push_str("#[allow(non_snake_case)]\n");
            }
            if min > 0 && options.validate_object_serialization {
                writeln!(
                    out,
                    "#[derive(Debug, Clone, PartialEq, serde::Deserialize)]"
                )
                .unwrap();
            } else {
                writeln!(
                    out,
                    "#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]"
                )
                .unwrap();
            }
            if min > 0 {
                writeln!(out, "#[serde(try_from = \"Raw{name}\")]").unwrap();
            }
            writeln!(out, "#[serde(deny_unknown_fields)]\npub struct {name} {{").unwrap();
            for key in properties.keys() {
                let field = format!("r#{key}");
                let ty = format!("{name}{}", pascal(key));
                if is_required(key) {
                    writeln!(out, "pub {field}: {ty},").unwrap();
                } else {
                    writeln!(out, "#[serde(default, deserialize_with = \"{runtime}::deserialize_optional\", skip_serializing_if = \"Option::is_none\")]\npub {field}: Option<{ty}>,").unwrap();
                }
            }
            out.push_str("}\n");
            if min > 0 {
                if camel_case {
                    out.push_str("#[allow(non_snake_case)]\n");
                }
                writeln!(out, "#[derive(serde::Deserialize)]\n#[serde(deny_unknown_fields)]\nstruct Raw{name} {{").unwrap();
                for key in properties.keys() {
                    let field = format!("r#{key}");
                    let ty = format!("{name}{}", pascal(key));
                    if is_required(key) {
                        writeln!(out, "{field}: {ty},").unwrap();
                    } else {
                        writeln!(out, "#[serde(default, deserialize_with = \"{runtime}::deserialize_optional\")]\n{field}: Option<{ty}>,").unwrap();
                    }
                }
                writeln!(out, "}}\nimpl TryFrom<Raw{name}> for {name} {{ type Error = {runtime}::Error; fn try_from(raw: Raw{name}) -> Result<Self, Self::Error> {{").unwrap();
                write!(out, "let count = [").unwrap();
                for key in properties.keys() {
                    let field = format!("r#{key}");
                    if is_required(key) {
                        out.push_str("true,");
                    } else {
                        write!(out, "raw.{field}.is_some(),").unwrap();
                    }
                }
                writeln!(out, "].into_iter().filter(|present| *present).count(); if count < {min} {{ return Err({runtime}::Error::Invalid(\"{name} requires context\".into())); }}\nOk(Self {{").unwrap();
                for key in properties.keys() {
                    let field = format!("r#{key}");
                    writeln!(out, "{field}: raw.{field},").unwrap();
                }
                out.push_str("}) } }\n");
                if options.validate_object_serialization {
                    emit_object_serializer(properties, required, min, name, out);
                }
            }
        }
        "string" => {
            writeln!(out, "#[derive(Debug, Clone, PartialEq, serde::Serialize)]\n#[serde(transparent)]\npub struct {name}(String);\nimpl {name} {{ #[must_use] pub fn as_str(&self) -> &str {{ &self.0 }}\npub(crate) fn validate(value: &str) -> Result<(), {runtime}::Error> {{").unwrap();
            let mut checks = String::new();
            for key in ["minLength", "maxLength", "pattern", "enum", "const"] {
                let mut values = Vec::new();
                constraints(schema, key, &mut values);
                for (index, constraint) in values.iter().enumerate() {
                    let expr = match key {
                        "minLength" if constraint.as_u64() == Some(0) => continue,
                        "minLength" if constraint.as_u64() == Some(1) => "value.is_empty()".into(),
                        "minLength" => {
                            format!(
                                "{runtime}::utf16_len(value) < {}",
                                constraint.as_u64().unwrap()
                            )
                        }
                        "maxLength" => {
                            format!(
                                "{runtime}::utf16_len(value) > {}",
                                constraint.as_u64().unwrap()
                            )
                        }
                        "enum" => format!(
                            "!{:?}.contains(&value)",
                            constraint
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|v| v.as_str().unwrap())
                                .collect::<Vec<_>>()
                        ),
                        "const" => format!("value != {:?}", constraint.as_str().unwrap()),
                        "pattern" if constraint.as_str() == Some(r"^\S[\s\S]*\S$|^\S$|^$") => {
                            format!("!{runtime}::is_js_trimmed(value)")
                        }
                        "pattern" if constraint.as_str() == Some(r"^[^\r\n]+$") => {
                            "value.is_empty() || value.contains(['\\r', '\\n'])".into()
                        }
                        "pattern" => {
                            // ECMAScript's \\d is ASCII even with the Unicode flag.
                            let pattern = constraint.as_str().unwrap().replace(r"\d", "[0-9]");
                            writeln!(out, "static PATTERN_{index}: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new({pattern:?}).expect(\"schema pattern\"));").unwrap();
                            format!("!PATTERN_{index}.is_match(value)")
                        }
                        _ => unreachable!(),
                    };
                    writeln!(checks, "if {expr} {{ return Err({runtime}::Error::Invalid(\"{name}: {key}\".into())); }}").unwrap();
                }
            }
            if checks.is_empty() {
                out.push_str("let _ = value;\n");
            }
            out.push_str(&checks);
            out.push_str("Ok(()) } }\n");
            writeln!(out, "impl TryFrom<String> for {name} {{ type Error = {runtime}::Error; fn try_from(value: String) -> Result<Self, Self::Error> {{ Self::validate(&value)?; Ok(Self(value)) }} }}").unwrap();
            writeln!(out, "impl<'de> serde::Deserialize<'de> for {name} {{ fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {{ let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) }} }}").unwrap();
        }
        "integer" | "number" | "boolean" | "null" => emit_scalar(schema, name, out, options),
        "array" => emit_array(schema, name, out, options),
        _ => unreachable!("validated schema type"),
    }
}

fn emit_object_serializer(
    properties: &serde_json::Map<String, Value>,
    required: Option<&Vec<Value>>,
    minimum: u64,
    name: &str,
    out: &mut String,
) {
    let is_required =
        |key: &str| required.is_some_and(|keys| keys.iter().any(|value| value == key));
    writeln!(out, "impl serde::Serialize for {name} {{ fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {{").unwrap();
    out.push_str("let count = [false,");
    for key in properties.keys() {
        if is_required(key) {
            out.push_str("true,");
        } else {
            write!(out, "self.r#{key}.is_some(),").unwrap();
        }
    }
    writeln!(out, "].into_iter().filter(|present| *present).count(); if count < {minimum} {{ return Err(serde::ser::Error::custom(\"{name}: minProperties\")); }}").unwrap();
    writeln!(
        out,
        "let mut state = serializer.serialize_struct(\"{name}\", count)?;"
    )
    .unwrap();
    for key in properties.keys() {
        if is_required(key) {
            writeln!(out, "serde::ser::SerializeStruct::serialize_field(&mut state, {key:?}, &self.r#{key})?;").unwrap();
        } else {
            writeln!(out, "if let Some(value) = &self.r#{key} {{ serde::ser::SerializeStruct::serialize_field(&mut state, {key:?}, value)?; }}").unwrap();
        }
    }
    out.push_str("serde::ser::SerializeStruct::end(state) } }\n");
}

fn emit_union(branches: &[Value], name: &str, out: &mut String, options: &Options<'_>) {
    for (index, branch) in branches.iter().enumerate() {
        emit(branch, &format!("{name}Variant{index}"), out, options);
    }
    writeln!(out, "#[derive(Debug, Clone, PartialEq, serde::Serialize)]\n#[serde(untagged)]\npub enum {name} {{").unwrap();
    for index in 0..branches.len() {
        writeln!(out, "Variant{index}({name}Variant{index}),").unwrap();
    }
    writeln!(out, "}}\nimpl<'de> serde::Deserialize<'de> for {name} {{ fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {{ let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;").unwrap();
    for index in 0..branches.len() {
        writeln!(out, "if let Ok(branch) = <{name}Variant{index} as serde::Deserialize>::deserialize(&value) {{ return Ok(Self::Variant{index}(branch)); }}").unwrap();
    }
    writeln!(
        out,
        "Err(serde::de::Error::custom(\"{name}: no union branch matched\")) }} }}"
    )
    .unwrap();
}
fn emit_scalar(schema: &Value, name: &str, out: &mut String, options: &Options<'_>) {
    let runtime = options.runtime_module;
    let kind = kind(schema).unwrap();
    let ty = match kind {
        "integer" | "number" => "serde_json::Number",
        "boolean" => "bool",
        "null" => "()",
        _ => unreachable!(),
    };
    let derives = if matches!(kind, "integer" | "number") {
        "Debug, Clone, serde::Serialize"
    } else {
        "Debug, Clone, PartialEq, serde::Serialize"
    };
    writeln!(out, "#[derive({derives})]\n#[serde(transparent)]\npub struct {name}({ty});\nimpl {name} {{ #[must_use] pub fn value(&self) -> &{ty} {{ &self.0 }}\nfn validate(value: &{ty}) -> Result<(), {runtime}::Error> {{").unwrap();
    if matches!(kind, "integer" | "number") {
        if kind == "integer" {
            writeln!(out, "if !{runtime}::is_integer(value) {{ return Err({runtime}::Error::Invalid(\"{name}: integer\".into())); }}").unwrap();
        } else {
            out.push_str("let _ = value;\n");
        }
        for key in [
            "minimum",
            "maximum",
            "exclusiveMinimum",
            "exclusiveMaximum",
            "multipleOf",
        ] {
            let mut found = Vec::new();
            constraints(schema, key, &mut found);
            for constraint in found {
                let limit = constraint.to_string();
                let expression = match key {
                    "minimum" => format!("{runtime}::compare_number(value, {limit:?}).is_lt()"),
                    "maximum" => format!("{runtime}::compare_number(value, {limit:?}).is_gt()"),
                    "exclusiveMinimum" => {
                        format!("!{runtime}::compare_number(value, {limit:?}).is_gt()")
                    }
                    "exclusiveMaximum" => {
                        format!("!{runtime}::compare_number(value, {limit:?}).is_lt()")
                    }
                    "multipleOf" => format!("!{runtime}::is_multiple_of(value, {limit:?})"),
                    _ => unreachable!(),
                };
                writeln!(out, "if {expression} {{ return Err({runtime}::Error::Invalid(\"{name}: {key}\".into())); }}").unwrap();
            }
        }
    } else {
        out.push_str("let _ = value;\n");
    }
    for key in ["enum", "const"] {
        let mut found = Vec::new();
        constraints(schema, key, &mut found);
        for constraint in found {
            let values: Vec<&Value> = if key == "enum" {
                constraint.as_array().unwrap().iter().collect()
            } else {
                vec![constraint]
            };
            let tests = values
                .iter()
                .map(|literal| match kind {
                    "boolean" if literal.as_bool() == Some(true) => "*value".into(),
                    "boolean" => "!*value".into(),
                    "null" => "true".into(),
                    _ => format!(
                        "{runtime}::compare_number(value, {:?}).is_eq()",
                        literal.to_string()
                    ),
                })
                .collect::<Vec<_>>()
                .join(" || ");
            writeln!(out, "if !({tests}) {{ return Err({runtime}::Error::Invalid(\"{name}: {key}\".into())); }}").unwrap();
        }
    }
    out.push_str("Ok(()) } }\n");
    if matches!(kind, "integer" | "number") {
        writeln!(out, "impl PartialEq for {name} {{ fn eq(&self, other: &Self) -> bool {{ {runtime}::numbers_equal(&self.0, &other.0) }} }}").unwrap();
    }
    writeln!(out, "impl TryFrom<{ty}> for {name} {{ type Error = {runtime}::Error; fn try_from(value: {ty}) -> Result<Self, Self::Error> {{ Self::validate(&value)?; Ok(Self(value)) }} }}\nimpl<'de> serde::Deserialize<'de> for {name} {{ fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {{ let value = <{ty} as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) }} }}").unwrap();
}
fn emit_array(schema: &Value, name: &str, out: &mut String, options: &Options<'_>) {
    let runtime = options.runtime_module;
    let item = format!("{name}Item");
    emit(&schema["items"], &item, out, options);
    writeln!(out, "#[derive(Debug, Clone, PartialEq, serde::Serialize)]\n#[serde(transparent)]\npub struct {name}(Vec<{item}>);\nimpl {name} {{ #[must_use] pub fn as_slice(&self) -> &[{item}] {{ &self.0 }}\nfn validate(value: &[{item}]) -> Result<(), {runtime}::Error> {{ let _ = value;").unwrap();
    for key in ["minItems", "maxItems", "uniqueItems"] {
        let mut found = Vec::new();
        constraints(schema, key, &mut found);
        for constraint in found {
            let expression = match key {
                "minItems" if constraint.as_u64() == Some(0) => continue,
                "minItems" => format!("value.len() < {}", constraint.as_u64().unwrap()),
                "maxItems" => format!("value.len() > {}", constraint.as_u64().unwrap()),
                "uniqueItems" if constraint == true => {
                    "value.iter().enumerate().any(|(index, item)| value[..index].contains(item))"
                        .into()
                }
                "uniqueItems" => continue,
                _ => unreachable!(),
            };
            writeln!(out, "if {expression} {{ return Err({runtime}::Error::Invalid(\"{name}: {key}\".into())); }}").unwrap();
        }
    }
    out.push_str("Ok(()) } }\n");
    writeln!(out, "impl TryFrom<Vec<{item}>> for {name} {{ type Error = {runtime}::Error; fn try_from(value: Vec<{item}>) -> Result<Self, Self::Error> {{ Self::validate(&value)?; Ok(Self(value)) }} }}\nimpl<'de> serde::Deserialize<'de> for {name} {{ fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {{ let value = <Vec<{item}> as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) }} }}").unwrap();
}

/// A standalone implementation of the generated runtime contract. Emit at the
/// consuming crate root, or inside the module named by `Options::runtime_module`.
/// It uses serde/`serde_json` only; callers may instead supply their own error type.
pub const RUNTIME_HELPERS: &str =
    concat!(include_str!("runtime.rs"), "\n", include_str!("numbers.rs"));
