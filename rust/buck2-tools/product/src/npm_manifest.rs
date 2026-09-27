//! Published `package.json` projection for npm package archives.
//!
//! `pnpm pack` replaces top-level manifest fields with their `publishConfig`
//! counterparts; the archive applies the same projection so the packed
//! manifest never points consumers at `.ts` sources, which Node refuses to
//! type-strip under `node_modules`.

use buck2_tool_core::{ToolError, ToolResult};
use serde::{
    de::{self, MapAccess, SeqAccess, Visitor},
    ser::{SerializeMap, SerializeSeq},
    Deserialize, Deserializer, Serialize, Serializer,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};

/// Order-preserving JSON value: export condition order is resolution order.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = Json;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a JSON value")
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_bool<E>(self, value: bool) -> Result<Json, E> {
                Ok(Json::Bool(value))
            }
            fn visit_i64<E>(self, value: i64) -> Result<Json, E> {
                Ok(Json::Number(value.into()))
            }
            fn visit_u64<E>(self, value: u64) -> Result<Json, E> {
                Ok(Json::Number(value.into()))
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Json, E> {
                serde_json::Number::from_f64(value)
                    .map(Json::Number)
                    .ok_or_else(|| E::custom("non-finite number"))
            }
            fn visit_str<E>(self, value: &str) -> Result<Json, E> {
                Ok(Json::String(value.to_owned()))
            }
            fn visit_string<E>(self, value: String) -> Result<Json, E> {
                Ok(Json::String(value))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::Array(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut entries: Vec<(String, Json)> = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Json>()? {
                    if entries.iter().any(|(existing, _)| *existing == key) {
                        return Err(de::Error::custom(format!("duplicate key: {key}")));
                    }
                    entries.push((key, value));
                }
                Ok(Json::Object(entries))
            }
        }
        deserializer.deserialize_any(JsonVisitor)
    }
}

impl Serialize for Json {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Json::Null => serializer.serialize_unit(),
            Json::Bool(value) => serializer.serialize_bool(*value),
            Json::Number(value) => value.serialize(serializer),
            Json::String(value) => serializer.serialize_str(value),
            Json::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Json::Object(entries) => {
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (key, value) in entries {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

/// Registry-side publish settings that `pnpm pack` does not project into the manifest.
const PUBLISH_ONLY_FIELDS: [&str; 7] = [
    "access",
    "directory",
    "executableFiles",
    "linkDirectory",
    "provenance",
    "registry",
    "tag",
];

/// Manifest fields whose values name files inside the package.
const TARGET_FIELDS: [&str; 7] = [
    "bin", "browser", "exports", "main", "module", "types", "typings",
];

fn fail(message: impl Into<String>) -> ToolError {
    ToolError::new("BUCK2_PRODUCT_NPM_MANIFEST", message)
}

/// Read only Buck-declared workspace manifests, not the ambient checkout.
pub fn workspace_versions(manifests: &[Vec<u8>]) -> ToolResult<BTreeMap<String, String>> {
    let mut versions = BTreeMap::new();
    for bytes in manifests {
        let Json::Object(fields) = serde_json::from_slice(bytes)
            .map_err(|error| fail(format!("workspace package.json is not valid JSON: {error}")))?
        else {
            return Err(fail("workspace package.json must be an object"));
        };
        let string_field = |key| {
            fields.iter().find_map(|(field, value)| {
                if field == key {
                    if let Json::String(value) = value {
                        Some(value.clone())
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
        };
        let name = string_field("name").ok_or_else(|| fail("workspace package has no name"))?;
        let version =
            string_field("version").ok_or_else(|| fail(format!("{name} has no version")))?;
        if versions.insert(name.clone(), version).is_some() {
            return Err(fail(format!("duplicate workspace package: {name}")));
        }
    }
    Ok(versions)
}

fn resolve_workspace_dependencies(
    fields: &mut [(String, Json)],
    versions: &BTreeMap<String, String>,
) -> ToolResult<()> {
    for (section, value) in fields {
        if ![
            "dependencies",
            "devDependencies",
            "optionalDependencies",
            "peerDependencies",
        ]
        .contains(&section.as_str())
        {
            continue;
        }
        let Json::Object(dependencies) = value else {
            continue;
        };
        for (name, specifier) in dependencies {
            let Json::String(specifier) = specifier else {
                continue;
            };
            let Some(range) = specifier.strip_prefix("workspace:") else {
                continue;
            };
            let version = versions.get(name).ok_or_else(|| {
                fail(format!(
                    "{section}.{name}: no declared workspace package version"
                ))
            })?;
            *specifier = match range {
                "^" => format!("^{version}"),
                "~" => format!("~{version}"),
                "*" => version.clone(),
                "" => return Err(fail(format!("{section}.{name}: empty workspace range"))),
                other => other.to_owned(),
            };
        }
    }
    Ok(())
}

/// Applies publishable `publishConfig` overrides while retaining registry settings.
pub fn published_manifest(
    source: &[u8],
    versions: &BTreeMap<String, String>,
) -> ToolResult<Vec<u8>> {
    let manifest: Json = serde_json::from_slice(source)
        .map_err(|error| fail(format!("package.json is not valid JSON: {error}")))?;
    let Json::Object(mut fields) = manifest else {
        return Err(fail("package.json must be a JSON object"));
    };
    if let Some(index) = fields.iter().position(|(key, _)| key == "publishConfig") {
        let (_, publish_config) = fields.remove(index);
        let Json::Object(overrides) = publish_config else {
            return Err(fail("publishConfig must be a JSON object"));
        };
        let mut publish_only = Vec::new();
        for (key, value) in overrides {
            if PUBLISH_ONLY_FIELDS.contains(&key.as_str()) {
                publish_only.push((key, value));
                continue;
            }
            match fields.iter_mut().find(|(existing, _)| *existing == key) {
                Some((_, existing)) => *existing = value,
                None => fields.push((key, value)),
            }
        }
        if !publish_only.is_empty() {
            fields.insert(
                index,
                ("publishConfig".to_owned(), Json::Object(publish_only)),
            );
        }
    }
    resolve_workspace_dependencies(&mut fields, versions)?;
    let mut bytes = serde_json::to_vec_pretty(&Json::Object(fields))
        .map_err(|error| fail(format!("could not serialize package.json: {error}")))?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn collect_targets<'a>(field: &str, value: &'a Json, targets: &mut Vec<(String, &'a str)>) {
    match value {
        Json::String(target) => targets.push((field.to_owned(), target)),
        Json::Array(items) => {
            for item in items {
                collect_targets(field, item, targets);
            }
        }
        Json::Object(entries) => {
            for (key, item) in entries {
                collect_targets(&format!("{field}.{key}"), item, targets);
            }
        }
        Json::Null | Json::Bool(_) | Json::Number(_) => {}
    }
}

fn is_runtime_typescript(path: &str) -> bool {
    let declaration = [".d.ts", ".d.mts", ".d.cts"]
        .iter()
        .any(|suffix| path.ends_with(suffix));
    let typescript = [".ts", ".tsx", ".mts", ".cts"]
        .iter()
        .any(|suffix| path.ends_with(suffix));
    typescript && !declaration
}

/// Every manifest target must name a shipped file and never a runtime TypeScript source.
/// `archived` holds package-relative paths (without the `package/` prefix).
pub fn validate_targets(manifest: &[u8], archived: &BTreeSet<String>) -> ToolResult<()> {
    let manifest: Json = serde_json::from_slice(manifest)
        .map_err(|error| fail(format!("package.json is not valid JSON: {error}")))?;
    let Json::Object(fields) = manifest else {
        return Err(fail("package.json must be a JSON object"));
    };
    let mut targets = Vec::new();
    for (key, value) in &fields {
        if TARGET_FIELDS.contains(&key.as_str()) {
            // A `browser` map may disable a module with `false`; only strings are file targets.
            collect_targets(key, value, &mut targets);
        }
    }
    for (field, target) in targets {
        if field.starts_with("browser") && !target.starts_with('.') {
            continue;
        }
        if is_runtime_typescript(target) {
            return Err(fail(format!(
                "packed manifest {field} targets TypeScript source {target}; publishConfig must point at emitted JavaScript"
            )));
        }
        if target.contains('*') {
            return Err(fail(format!(
                "packed manifest {field} uses an unverified export pattern {target}"
            )));
        }
        let relative = target.strip_prefix("./").unwrap_or(target);
        if !archived.contains(relative) {
            return Err(fail(format!(
                "packed manifest {field} targets {target}, which the archive does not ship"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shipped(paths: &[&str]) -> BTreeSet<String> {
        paths.iter().map(|path| (*path).to_owned()).collect()
    }

    #[test]
    fn publish_config_replaces_fields_in_order_and_preserves_registry_settings() {
        let source = br#"{"name":"x","exports":{".":{"types":"./dist/src/mod.d.ts","default":"./src/mod.ts"}},"publishConfig":{"access":"public","registry":"https://registry.example.test","exports":{".":{"types":"./dist/src/mod.d.ts","default":"./dist/src/mod.js"}},"bin":{"x":"./dist/src/cli.js"}}}"#;
        let packed = published_manifest(source, &BTreeMap::new()).unwrap();
        let text = String::from_utf8(packed.clone()).unwrap();
        let Json::Object(fields) = serde_json::from_slice::<Json>(&packed).unwrap() else {
            panic!("packed manifest must be an object");
        };
        assert_eq!(
            fields
                .iter()
                .find(|(key, _)| key == "publishConfig")
                .map(|(_, value)| value),
            Some(&Json::Object(vec![
                ("access".to_owned(), Json::String("public".to_owned())),
                (
                    "registry".to_owned(),
                    Json::String("https://registry.example.test".to_owned()),
                ),
            ]))
        );
        assert!(text.find("\"types\"").unwrap() < text.find("\"default\"").unwrap());
        validate_targets(
            &packed,
            &shipped(&["dist/src/mod.d.ts", "dist/src/mod.js", "dist/src/cli.js"]),
        )
        .unwrap();
    }

    #[test]
    fn rejects_runtime_typescript_targets() {
        let error = validate_targets(
            br#"{"exports":{".":{"types":"./dist/src/mod.d.ts","default":"./src/mod.ts"}}}"#,
            &shipped(&["dist/src/mod.d.ts", "src/mod.ts"]),
        )
        .unwrap_err();
        assert_eq!(error.code, "BUCK2_PRODUCT_NPM_MANIFEST");
        assert!(error.message.contains("exports...default"));
    }

    #[test]
    fn rejects_targets_the_archive_does_not_ship() {
        let error = validate_targets(
            br#"{"exports":{"./x":"./dist/x.js"},"main":"./dist/mod.js"}"#,
            &shipped(&["dist/mod.js"]),
        )
        .unwrap_err();
        assert!(error.message.contains("./dist/x.js"));
    }

    #[test]
    fn accepts_shipped_assets_and_declarations() {
        validate_targets(
            br#"{"types":"./dist/src/mod.d.ts","exports":{"./styles.css":"./src/styles.css","./package.json":"./package.json"}}"#,
            &shipped(&["dist/src/mod.d.ts", "src/styles.css", "package.json"]),
        )
        .unwrap();
    }

    #[test]
    fn workspace_ranges_resolve_against_declared_manifest_versions() {
        let versions =
            workspace_versions(&[br#"{"name":"@x/dep","version":"2.3.4"}"#.to_vec()]).unwrap();
        for (source, expected) in [
            ("workspace:^", "^2.3.4"),
            ("workspace:~", "~2.3.4"),
            ("workspace:*", "2.3.4"),
            ("workspace:>=2.1.0", ">=2.1.0"),
        ] {
            let input = format!(r#"{{"dependencies":{{"@x/dep":"{source}"}}}}"#);
            let packed = published_manifest(input.as_bytes(), &versions).unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&packed).unwrap();
            assert_eq!(parsed["dependencies"]["@x/dep"], expected);
        }
        let missing = published_manifest(
            br#"{"dependencies":{"@x/unknown":"workspace:^"}}"#,
            &versions,
        )
        .unwrap_err();
        assert!(missing
            .message
            .contains("no declared workspace package version"));
    }
}
