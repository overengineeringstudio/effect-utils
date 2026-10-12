//! Schema-derived Agent Trace types, private runtime capture, and medium codecs.
//! Runtime capture moves validated components into an artifact without inventing
//! purpose for idle seats. Human renderings are never parsed.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{borrow::Cow, collections::BTreeMap, sync::LazyLock};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Invalid Agent Trace: {0}")]
    Invalid(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

fn deserialize_optional<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
// ECMAScript trim's WhiteSpace + LineTerminator set differs from Rust's Unicode whitespace.
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn is_js_trimmed(value: &str) -> bool {
    value.chars().next().is_none_or(|c| !js_whitespace(c))
        && value.chars().next_back().is_none_or(|c| !js_whitespace(c))
}
/// Length semantics used by the TypeScript authority (not Unicode scalar count).
#[must_use]
pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

pub mod types {
    include!(concat!(env!("OUT_DIR"), "/types.rs"));
}

pub use types::{AgentTraceRuntimeV1, AgentTraceV2};

/// Event-specific facts, using the artifact authority's validated field types.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactFacts {
    pub id: types::AgentTraceV2Id,
    pub at: types::AgentTraceV2At,
    pub artifact: types::AgentTraceV2Artifact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CaptureError {
    #[error("An idle Agent Trace runtime has no artifact purpose (why)")]
    MissingWhy,
    #[error("Agent Trace artifact purpose requires mission or step context")]
    EmptyWhy,
}

/// Capture an artifact from private runtime context and event-specific facts.
///
/// Consumes both inputs, moving every component without serialization or copies.
///
/// # Errors
/// Rejects idle runtimes without `why`, and purpose emptied by public-field mutation.
pub fn capture_artifact(
    runtime: AgentTraceRuntimeV1,
    facts: ArtifactFacts,
) -> Result<AgentTraceV2, CaptureError> {
    let why = runtime.why.ok_or(CaptureError::MissingWhy)?;
    if why.mission.is_none() && why.step.is_none() {
        return Err(CaptureError::EmptyWhy);
    }
    Ok(AgentTraceV2 {
        r#type: runtime.r#type.into(),
        id: facts.id,
        at: facts.at,
        artifact: facts.artifact,
        who: runtime.who.into(),
        why: why.into(),
        how: runtime.how.into(),
        r#where: runtime.r#where.into(),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Audience {
    #[serde(rename = "public-minimal")]
    Public,
    #[serde(rename = "private-rich")]
    Private,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Medium {
    #[serde(rename = "trailer/v2")]
    Trailer,
    #[serde(rename = "footer/v4")]
    Footer,
}

/// A validated binding view; sparse legacy observations bypass only writer requirements.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum View {
    PublicTrailer(types::PublicTrailerV2),
    PrivateTrailer(types::PrivateTrailerV2),
    PublicFooter(types::PublicFooterV2),
    PrivateFooter(types::PrivateFooterV2),
}
impl View {
    /// Deserialize the schema-derived audience/medium binding.
    ///
    /// # Errors
    /// Rejects unknown fields, null optionals, and any schema constraint violation.
    pub fn from_value(value: Value, audience: Audience, medium: Medium) -> Result<Self, Error> {
        Ok(match (audience, medium) {
            (Audience::Public, Medium::Trailer) => {
                Self::PublicTrailer(serde_json::from_value(value)?)
            }
            (Audience::Private, Medium::Trailer) => {
                Self::PrivateTrailer(serde_json::from_value(value)?)
            }
            (Audience::Public, Medium::Footer) => {
                Self::PublicFooter(serde_json::from_value(value)?)
            }
            (Audience::Private, Medium::Footer) => {
                Self::PrivateFooter(serde_json::from_value(value)?)
            }
        })
    }
    #[must_use]
    pub fn audience(&self) -> Audience {
        match self {
            Self::PublicTrailer(_) | Self::PublicFooter(_) => Audience::Public,
            _ => Audience::Private,
        }
    }
    #[must_use]
    pub fn medium(&self) -> Medium {
        match self {
            Self::PublicTrailer(_) | Self::PrivateTrailer(_) => Medium::Trailer,
            _ => Medium::Footer,
        }
    }
    /// Return the authoritative machine view.
    ///
    /// # Errors
    /// Propagates JSON serialization errors.
    pub fn value(&self) -> Result<Value, Error> {
        Ok(serde_json::to_value(self)?)
    }
}

pub const FOOTER_BEGIN: &str = "<!-- agent-trace:begin -->";
pub const FOOTER_END: &str = "<!-- agent-trace:end -->";
const TRAILER: &str = "Agent-Trace: agent-trace/v2 trailer/v2 ";
const FOOTER: &str = "<!-- agent-trace/v2 footer/v4 ";

fn writer(value: &Value) -> Result<(), Error> {
    if [
        "/who/agent",
        "/who/principal",
        "/how/harness/tool",
        "/how/model/route",
    ]
    .iter()
    .any(|p| value.pointer(p).and_then(Value::as_str).is_none())
    {
        return Err(Error::Invalid(
            "Current writer requires who.agent, who.principal, how.harness and how.model".into(),
        ));
    }
    if ["mission", "step", "related"]
        .iter()
        .all(|k| value["why"].get(k).is_none())
    {
        return Err(Error::Invalid(
            "Current writer requires why context or a related link".into(),
        ));
    }
    Ok(())
}

/// Decode the single authoritative machine region and enforce current-writer requirements.
///
/// # Errors
/// Rejects malformed or duplicate regions, invalid schema values, and missing writer facts.
pub fn decode(wire: &str, audience: Audience, medium: Medium) -> Result<View, Error> {
    let machine = match medium {
        Medium::Trailer => {
            let mut rows = wire
                .split('\n')
                .filter(|line| line.starts_with("Agent-Trace:"));
            let machine = rows.next().and_then(|line| line.strip_prefix(TRAILER));
            if rows.next().is_some() {
                return Err(Error::Invalid(
                    "Expected one versioned Agent-Trace trailer".into(),
                ));
            }
            machine.ok_or_else(|| {
                Error::Invalid("Expected one versioned Agent-Trace trailer".into())
            })?
        }
        Medium::Footer => {
            static REGION: LazyLock<regex::Regex> = LazyLock::new(|| {
                regex::Regex::new(r"<!-- agent-trace/v2 footer/v4 ([^\r\n\u{2028}\u{2029}]*?) -->")
                    .unwrap()
            });
            if !wire.starts_with(&format!("{FOOTER_BEGIN}\n"))
                || !wire.ends_with(&format!("\n{FOOTER_END}"))
            {
                return Err(Error::Invalid("Invalid footer region".into()));
            }
            let mut regions = REGION.captures_iter(wire);
            let first = regions
                .next()
                .ok_or_else(|| Error::Invalid("Expected one footer machine region".into()))?;
            if regions.next().is_some() {
                return Err(Error::Invalid("Expected one footer machine region".into()));
            }
            first
                .get(1)
                .ok_or_else(|| Error::Invalid("Missing footer capture".into()))?
                .as_str()
        }
    };
    let value = serde_json::from_str(machine)?;
    writer(&value)?;
    View::from_value(value, audience, medium)
}

/// Encode a current binding view, rendering human text from its authoritative fields.
///
/// # Errors
/// Rejects sparse legacy views lacking accountable writer facts and propagates JSON errors.
pub fn encode(view: &View) -> Result<String, Error> {
    let value = view.value()?;
    writer(&value)?;
    let machine = serde_json::to_string(view)?;
    Ok(match view.medium() {
        Medium::Trailer => format!("On-Behalf-Of: {}\n{TRAILER}{machine}", summary(&value)),
        Medium::Footer => format!(
            "{FOOTER_BEGIN}\n{}\n{FOOTER}{} -->\n{FOOTER_END}",
            render_footer(&value, view.audience()),
            machine
                .replace("--", "\\u002d\\u002d")
                .replace('>', "\\u003e")
        ),
    })
}

fn text<'a>(value: &'a Value, path: &str) -> Option<&'a str> {
    value.pointer(path).and_then(Value::as_str)
}
pub fn summary(value: &Value) -> String {
    let principal = text(value, "/who/principal").and_then(|p| p.rsplit(':').next());
    let agent = text(value, "/who/agent");
    let seat = agent.and_then(|a| a.strip_prefix("agent/"));
    let mut output = if let Some(p) = principal.filter(|p| !p.is_empty()) {
        let mut identity = format!("@{p}");
        if let Some(s) = seat {
            identity.push_str(" via ");
            identity.push_str(s);
        } else if agent.is_some() {
            identity.push_str(" via direct session");
        }
        identity
    } else {
        seat.unwrap_or(if agent.is_some() {
            "direct session"
        } else {
            ""
        })
        .to_owned()
    };
    let mission = text(value, "/why/mission/name")
        .map(|m| seat.map_or_else(|| m.to_owned(), |s| m.replacen(&format!("{s}/"), "", 1)));
    let first = mission.or_else(|| {
        if seat.is_none() {
            text(value, "/how/harness/tool").map(str::to_owned)
        } else {
            None
        }
    });
    for (i, item) in first
        .into_iter()
        .chain(text(value, "/why/step/name").map(str::to_owned))
        .filter(|item| !item.is_empty())
        .enumerate()
    {
        if !output.is_empty() {
            output.push_str(if i == 0 { " · " } else { " › " });
        }
        output.push_str(&item);
    }
    output
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('|', "&#124;")
}
fn metadata<'a>(schema: &'a Value, key: &str) -> Option<&'a Value> {
    schema.get(key).or_else(|| {
        schema
            .get("allOf")?
            .as_array()?
            .iter()
            .find_map(|part| metadata(part, key))
    })
}
fn value_text(schema: &Value, value: &Value) -> String {
    if let Some(s) = value.as_str() {
        return escape(s);
    }
    schema["properties"]
        .as_object()
        .unwrap()
        .iter()
        .filter_map(|(key, child)| value.get(key).map(|v| value_text(child, v)))
        .collect::<Vec<_>>()
        .join(
            if metadata(schema, "x-format").and_then(Value::as_str) == Some("space") {
                " "
            } else {
                " · "
            },
        )
}
fn footer_schema(audience: Audience) -> &'static Value {
    static PUBLIC: LazyLock<Value> = LazyLock::new(|| {
        serde_json::from_str(include_str!(concat!(
            env!("OUT_DIR"),
            "/PublicFooterV2.schema.json"
        )))
        .unwrap()
    });
    static PRIVATE: LazyLock<Value> = LazyLock::new(|| {
        serde_json::from_str(include_str!(concat!(
            env!("OUT_DIR"),
            "/PrivateFooterV2.schema.json"
        )))
        .unwrap()
    });
    match audience {
        Audience::Public => &PUBLIC,
        Audience::Private => &PRIVATE,
    }
}
fn render_footer(value: &Value, audience: Audience) -> String {
    let schema = footer_schema(audience);
    let mut sections = Vec::new();
    for (family, definition) in schema["properties"].as_object().unwrap() {
        if !["who", "why", "how", "where"].contains(&family.as_str()) {
            continue;
        }
        let Some(fields) = value.get(family) else {
            continue;
        };
        let mut rows = Vec::new();
        for (key, child) in definition["properties"].as_object().unwrap() {
            if metadata(child, "x-row").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            let Some(field) = fields.get(key) else {
                continue;
            };
            let mut field = Cow::Borrowed(field);
            if family == "why" && key == "mission" {
                if let (Some(agent), Some(name)) =
                    (text(value, "/who/agent"), field["name"].as_str())
                {
                    let seat = agent.strip_prefix("agent/").unwrap_or(agent);
                    if let Some(short) = name.strip_prefix(&format!("{seat}/")) {
                        let short = short.to_owned();
                        field.to_mut()["name"] = Value::String(short);
                    }
                }
            }
            let title = metadata(child, "title").and_then(Value::as_str).unwrap();
            let description = metadata(child, "description")
                .and_then(Value::as_str)
                .unwrap();
            let private =
                if metadata(child, "x-sensitivity").and_then(Value::as_str) == Some("internal") {
                    " (private only)"
                } else {
                    ""
                };
            rows.push(format!(
                "| {} | {} | `{family}.{key}` | {} |",
                escape(title),
                value_text(child, &field),
                escape(&format!("{description}{private}"))
            ));
        }
        if !rows.is_empty() {
            sections.push(format!(
                "**{}**\n\n{}\n\n| Field | Value | Key | Description |\n|---|---|---|---|\n{}",
                escape(
                    metadata(definition, "title")
                        .and_then(Value::as_str)
                        .unwrap()
                ),
                escape(
                    metadata(definition, "description")
                        .and_then(Value::as_str)
                        .unwrap()
                ),
                rows.join("\n")
            ));
        }
    }
    format!(
        "<details>\n<summary>Posted on behalf of {}</summary>\n\n{}\n</details>",
        escape(&summary(value)),
        sections.join("\n\n")
    )
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag", rename_all = "lowercase", deny_unknown_fields)]
pub enum LegacyValue {
    Unknown,
    Unavailable,
    Value { value: String },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyView {
    pub binding: String,
    pub fields: BTreeMap<String, LegacyValue>,
}
fn tagged(value: &str) -> LegacyValue {
    match value {
        "unknown" => LegacyValue::Unknown,
        "unavailable" => LegacyValue::Unavailable,
        _ => LegacyValue::Value {
            value: value.to_owned(),
        },
    }
}
/// Preserve every observed historical agent namespace field, including tagged sentinels.
#[must_use]
pub fn decode_legacy_trailer(body: &str) -> LegacyView {
    static LINE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)^(agent-[a-z0-9-]+|tooling-profile):[ \t]*([^\r\n\u{2028}\u{2029}]*)$",
        )
        .unwrap()
    });
    let fields = body
        .split('\n')
        .filter_map(|line| LINE.captures(line.strip_suffix('\r').unwrap_or(line)))
        .map(|m| {
            (
                m[1].to_ascii_lowercase(),
                tagged(m[2].trim_matches(js_whitespace)),
            )
        })
        .collect();
    LegacyView {
        binding: "trailer/v1".into(),
        fields,
    }
}
/// Read the frozen footer/v3 owned table.
///
/// # Errors
/// Rejects a body without both historical region markers.
pub fn decode_legacy_footer(body: &str) -> Result<LegacyView, Error> {
    static ROW: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^\| `([a-z_]+)` \| ([^\r\n\u{2028}\u{2029}]*) \|$").unwrap()
    });
    let start = body
        .find("<!-- agent-footer:begin v=3 -->")
        .ok_or_else(|| Error::Invalid("Missing frozen footer/v3 region".into()))?;
    let end = body[start..]
        .find("<!-- agent-footer:end -->")
        .map(|i| i + start)
        .ok_or_else(|| Error::Invalid("Missing frozen footer/v3 region".into()))?;
    let fields = body[start..end]
        .split('\n')
        .filter_map(|line| ROW.captures(line.strip_suffix('\r').unwrap_or(line)))
        .map(|m| (m[1].replace('_', "-"), tagged(&m[2].replace("\\|", "|"))))
        .collect();
    Ok(LegacyView {
        binding: "footer/v3".into(),
        fields,
    })
}
fn public_identity(value: &str) -> &str {
    if value.starts_with("agent/") || value.starts_with("direct.") {
        value
    } else {
        value.split_once('.').map_or(value, |(_, rest)| rest)
    }
}
/// Upgrade only observed legacy facts into a sparse current binding.
///
/// # Errors
/// Rejects unsupported legacy versions or observed facts incompatible with the binding schema.
pub fn upgrade_legacy(legacy: &LegacyView, audience: Audience) -> Result<View, Error> {
    let observed = |key: &str| match legacy.fields.get(key) {
        Some(LegacyValue::Value { value }) if !value.is_empty() => Some(value.as_str()),
        _ => None,
    };
    let mut value = json!({"type":"agent-trace/v2","who":{},"why":{},"how":{}});
    for (key, source) in [
        ("agent", "agent-identity"),
        ("supervisor", "agent-supervisor"),
        ("persona", "agent-persona"),
    ] {
        if let Some(v) = observed(source) {
            value["who"][key] = json!(if audience == Audience::Public && key != "persona" {
                public_identity(v)
            } else {
                v
            });
        }
    }
    if let Some(tool) = observed("agent-tool") {
        value["how"]["harness"] = json!({"tool":tool});
        if let Some(version) = observed("agent-tool-version") {
            value["how"]["harness"]["version"] = json!(version);
        }
    }
    if let Some(route) = observed("agent-model")
        .filter(|s| types::PrivateTrailerV2HowModelRoute::validate(s).is_ok())
    {
        value["how"]["model"] = json!({"route":route});
        if audience == Audience::Private {
            if let Some(effort) = observed("agent-effort") {
                value["how"]["model"]["effort"] = json!(effort);
            }
        }
    }
    if audience == Audience::Private {
        if let Some(profile) = observed("tooling-profile") {
            value["how"]["tooling_profile"] = json!(profile);
        }
    }
    let medium = match legacy.binding.as_str() {
        "trailer/v1" => Medium::Trailer,
        "footer/v3" => {
            value["where"] = json!({});
            if let Some(session) = observed("session")
                .filter(|s| types::PrivateFooterV2WhereSession::validate(s).is_ok())
            {
                value["where"]["session"] = json!(if audience == Audience::Public {
                    session.rsplit('.').next().unwrap_or(session)
                } else {
                    session
                });
            }
            if audience == Audience::Private {
                if let Some(worktree) = observed("worktree") {
                    value["where"]["worktree"] = json!(worktree);
                }
            }
            Medium::Footer
        }
        other => return Err(Error::Invalid(format!("Unknown legacy binding {other}"))),
    };
    View::from_value(value, audience, medium)
}

/// Current machine trailers are authoritative, including preview commits with `Agent:` human text.
/// A malformed current trailer never falls back to historical observations.
/// Returns `None` when neither a current machine trailer nor historical agent-* facts were recorded.
///
/// # Errors
/// Propagates current decoding errors or invalid historical observations during upgrade.
pub fn decode_commit(body: &str, audience: Audience) -> Result<Option<View>, Error> {
    if body
        .split('\n')
        .any(|line| line.starts_with("Agent-Trace:"))
    {
        decode(body, audience, Medium::Trailer).map(Some)
    } else {
        let legacy = decode_legacy_trailer(body);
        if legacy.fields.keys().any(|key| key.starts_with("agent-")) {
            upgrade_legacy(&legacy, audience).map(Some)
        } else {
            Ok(None)
        }
    }
}
