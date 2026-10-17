// Generated at build time from the committed Agent Trace JSON Schemas.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2Type(String);
impl AgentTraceV2Type { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["agent-trace/v2"].contains(&value) { return Err(crate::Error::Invalid("AgentTraceV2Type: enum".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2Type { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2Type { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2Id(String);
impl AgentTraceV2Id { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2Id: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2Id: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2Id: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2Id { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2Id { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2At(String);
impl AgentTraceV2At { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2At: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2At: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2At: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("AgentTraceV2At: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2At { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2At { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2Artifact(String);
impl AgentTraceV2Artifact { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2Artifact: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2Artifact: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2Artifact: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2Artifact { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2Artifact { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2WhoAgent(String);
impl AgentTraceV2WhoAgent { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2WhoAgent: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2WhoAgent: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2WhoAgent: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("AgentTraceV2WhoAgent: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2WhoAgent { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2WhoAgent { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2WhoPrincipal(String);
impl AgentTraceV2WhoPrincipal { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2WhoPrincipal: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2WhoPrincipal: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2WhoPrincipal: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2WhoPrincipal { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2WhoPrincipal { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2WhoActor(String);
impl AgentTraceV2WhoActor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2WhoActor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2WhoActor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2WhoActor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2WhoActor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2WhoActor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2WhoPersona(String);
impl AgentTraceV2WhoPersona { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2WhoPersona: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2WhoPersona: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2WhoPersona: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2WhoPersona { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2WhoPersona { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2WhoSupervisor(String);
impl AgentTraceV2WhoSupervisor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2WhoSupervisor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2WhoSupervisor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2WhoSupervisor: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("AgentTraceV2WhoSupervisor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2WhoSupervisor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2WhoSupervisor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceV2Who {
pub r#agent: AgentTraceV2WhoAgent,
pub r#principal: AgentTraceV2WhoPrincipal,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#actor: Option<AgentTraceV2WhoActor>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#persona: Option<AgentTraceV2WhoPersona>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#supervisor: Option<AgentTraceV2WhoSupervisor>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2WhyMissionName(String);
impl AgentTraceV2WhyMissionName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2WhyMissionName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2WhyMissionName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2WhyMissionName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2WhyMissionName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2WhyMissionName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2WhyMissionRun(String);
impl AgentTraceV2WhyMissionRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[0-9a-f]{32}$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2WhyMissionRun: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2WhyMissionRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2WhyMissionRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("AgentTraceV2WhyMissionRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2WhyMissionRun { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2WhyMissionRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceV2WhyMission {
pub r#name: AgentTraceV2WhyMissionName,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#run: Option<AgentTraceV2WhyMissionRun>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2WhyStepName(String);
impl AgentTraceV2WhyStepName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2WhyStepName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2WhyStepName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2WhyStepName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2WhyStepName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2WhyStepName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2WhyStepRun(String);
impl AgentTraceV2WhyStepRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[0-9a-f]{32}$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2WhyStepRun: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2WhyStepRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2WhyStepRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("AgentTraceV2WhyStepRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2WhyStepRun { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2WhyStepRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceV2WhyStep {
pub r#name: AgentTraceV2WhyStepName,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#run: Option<AgentTraceV2WhyStepRun>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "RawAgentTraceV2Why")]
#[serde(deny_unknown_fields)]
pub struct AgentTraceV2Why {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#mission: Option<AgentTraceV2WhyMission>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#step: Option<AgentTraceV2WhyStep>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAgentTraceV2Why {
#[serde(default, deserialize_with = "crate::deserialize_optional")]
r#mission: Option<AgentTraceV2WhyMission>,
#[serde(default, deserialize_with = "crate::deserialize_optional")]
r#step: Option<AgentTraceV2WhyStep>,
}
impl TryFrom<RawAgentTraceV2Why> for AgentTraceV2Why { type Error = crate::Error; fn try_from(raw: RawAgentTraceV2Why) -> Result<Self, Self::Error> {
let count = [raw.r#mission.is_some(),raw.r#step.is_some(),].into_iter().filter(|present| *present).count(); if count < 1 { return Err(crate::Error::Invalid("AgentTraceV2Why requires context".into())); }
Ok(Self {
r#mission: raw.r#mission,
r#step: raw.r#step,
}) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2HowHarnessTool(String);
impl AgentTraceV2HowHarnessTool { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2HowHarnessTool: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2HowHarnessTool: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2HowHarnessTool: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2HowHarnessTool { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2HowHarnessTool { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2HowHarnessVersion(String);
impl AgentTraceV2HowHarnessVersion { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2HowHarnessVersion: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2HowHarnessVersion: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2HowHarnessVersion: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2HowHarnessVersion { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2HowHarnessVersion { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceV2HowHarness {
pub r#tool: AgentTraceV2HowHarnessTool,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#version: Option<AgentTraceV2HowHarnessVersion>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2HowModelRoute(String);
impl AgentTraceV2HowModelRoute { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._+-]*$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2HowModelRoute: minLength".into())); }
if crate::utf16_len(value) > 64 { return Err(crate::Error::Invalid("AgentTraceV2HowModelRoute: maxLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2HowModelRoute: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2HowModelRoute: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("AgentTraceV2HowModelRoute: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2HowModelRoute { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2HowModelRoute { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2HowModelEffort(String);
impl AgentTraceV2HowModelEffort { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2HowModelEffort: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2HowModelEffort: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2HowModelEffort: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2HowModelEffort { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2HowModelEffort { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceV2HowModel {
pub r#route: AgentTraceV2HowModelRoute,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#effort: Option<AgentTraceV2HowModelEffort>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2HowToolingProfile(String);
impl AgentTraceV2HowToolingProfile { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2HowToolingProfile: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2HowToolingProfile: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2HowToolingProfile: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2HowToolingProfile { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2HowToolingProfile { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2HowRuntimeProfile(String);
impl AgentTraceV2HowRuntimeProfile { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2HowRuntimeProfile: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2HowRuntimeProfile: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2HowRuntimeProfile: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2HowRuntimeProfile { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2HowRuntimeProfile { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2HowSkillsManifest(String);
impl AgentTraceV2HowSkillsManifest { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2HowSkillsManifest: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2HowSkillsManifest: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2HowSkillsManifest: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2HowSkillsManifest { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2HowSkillsManifest { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2HowInvocationId(String);
impl AgentTraceV2HowInvocationId { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2HowInvocationId: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2HowInvocationId: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2HowInvocationId: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2HowInvocationId { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2HowInvocationId { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2HowIssuanceVariant0Tag(String);
impl AgentTraceV2HowIssuanceVariant0Tag { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["st-issued"].contains(&value) { return Err(crate::Error::Invalid("AgentTraceV2HowIssuanceVariant0Tag: enum".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2HowIssuanceVariant0Tag { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2HowIssuanceVariant0Tag { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2HowIssuanceVariant0StepRun(String);
impl AgentTraceV2HowIssuanceVariant0StepRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^step-run\\/[0-9a-f]{32}\\/[a-z0-9][a-z0-9._-]*$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2HowIssuanceVariant0StepRun: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2HowIssuanceVariant0StepRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2HowIssuanceVariant0StepRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("AgentTraceV2HowIssuanceVariant0StepRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2HowIssuanceVariant0StepRun { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2HowIssuanceVariant0StepRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceV2HowIssuanceVariant0 {
pub r#_tag: AgentTraceV2HowIssuanceVariant0Tag,
pub r#step_run: AgentTraceV2HowIssuanceVariant0StepRun,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2HowIssuanceVariant1Tag(String);
impl AgentTraceV2HowIssuanceVariant1Tag { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["not-st-issued"].contains(&value) { return Err(crate::Error::Invalid("AgentTraceV2HowIssuanceVariant1Tag: enum".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2HowIssuanceVariant1Tag { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2HowIssuanceVariant1Tag { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2HowIssuanceVariant1Launcher(String);
impl AgentTraceV2HowIssuanceVariant1Launcher { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2HowIssuanceVariant1Launcher: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2HowIssuanceVariant1Launcher: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2HowIssuanceVariant1Launcher: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2HowIssuanceVariant1Launcher { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2HowIssuanceVariant1Launcher { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceV2HowIssuanceVariant1 {
pub r#_tag: AgentTraceV2HowIssuanceVariant1Tag,
pub r#launcher: AgentTraceV2HowIssuanceVariant1Launcher,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum AgentTraceV2HowIssuance {
Variant0(AgentTraceV2HowIssuanceVariant0),
Variant1(AgentTraceV2HowIssuanceVariant1),
}
impl<'de> serde::Deserialize<'de> for AgentTraceV2HowIssuance { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
if let Ok(branch) = <AgentTraceV2HowIssuanceVariant0 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant0(branch)); }
if let Ok(branch) = <AgentTraceV2HowIssuanceVariant1 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant1(branch)); }
Err(serde::de::Error::custom("AgentTraceV2HowIssuance: no union branch matched")) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceV2How {
pub r#harness: AgentTraceV2HowHarness,
pub r#model: AgentTraceV2HowModel,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#tooling_profile: Option<AgentTraceV2HowToolingProfile>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#runtime_profile: Option<AgentTraceV2HowRuntimeProfile>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#skills_manifest: Option<AgentTraceV2HowSkillsManifest>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#invocation_id: Option<AgentTraceV2HowInvocationId>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#issuance: Option<AgentTraceV2HowIssuance>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2WhereSession(String);
impl AgentTraceV2WhereSession { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2WhereSession: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2WhereSession: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2WhereSession: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("AgentTraceV2WhereSession: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2WhereSession { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2WhereSession { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2WhereHost(String);
impl AgentTraceV2WhereHost { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2WhereHost: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2WhereHost: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2WhereHost: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2WhereHost { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2WhereHost { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceV2WhereWorktree(String);
impl AgentTraceV2WhereWorktree { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceV2WhereWorktree: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceV2WhereWorktree: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceV2WhereWorktree: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceV2WhereWorktree { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceV2WhereWorktree { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceV2Where {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#session: Option<AgentTraceV2WhereSession>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#host: Option<AgentTraceV2WhereHost>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#worktree: Option<AgentTraceV2WhereWorktree>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceV2 {
pub r#type: AgentTraceV2Type,
pub r#id: AgentTraceV2Id,
pub r#at: AgentTraceV2At,
pub r#artifact: AgentTraceV2Artifact,
pub r#who: AgentTraceV2Who,
pub r#why: AgentTraceV2Why,
pub r#how: AgentTraceV2How,
pub r#where: AgentTraceV2Where,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1Type(String);
impl AgentTraceRuntimeV1Type { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["agent-trace-runtime/v1"].contains(&value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1Type: enum".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1Type { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1Type { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhoAgent(String);
impl AgentTraceRuntimeV1WhoAgent { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoAgent: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoAgent: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoAgent: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoAgent: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhoAgent { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhoAgent { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhoPrincipal(String);
impl AgentTraceRuntimeV1WhoPrincipal { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoPrincipal: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoPrincipal: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoPrincipal: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhoPrincipal { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhoPrincipal { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhoActor(String);
impl AgentTraceRuntimeV1WhoActor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoActor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoActor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoActor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhoActor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhoActor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhoPersona(String);
impl AgentTraceRuntimeV1WhoPersona { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoPersona: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoPersona: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoPersona: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhoPersona { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhoPersona { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhoSupervisor(String);
impl AgentTraceRuntimeV1WhoSupervisor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoSupervisor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoSupervisor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoSupervisor: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhoSupervisor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhoSupervisor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhoSupervisor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1Who {
pub r#agent: AgentTraceRuntimeV1WhoAgent,
pub r#principal: AgentTraceRuntimeV1WhoPrincipal,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#actor: Option<AgentTraceRuntimeV1WhoActor>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#persona: Option<AgentTraceRuntimeV1WhoPersona>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#supervisor: Option<AgentTraceRuntimeV1WhoSupervisor>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhyMissionName(String);
impl AgentTraceRuntimeV1WhyMissionName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhyMissionName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhyMissionName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhyMissionName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhyMissionName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhyMissionName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhyMissionRun(String);
impl AgentTraceRuntimeV1WhyMissionRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[0-9a-f]{32}$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhyMissionRun: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhyMissionRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhyMissionRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhyMissionRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhyMissionRun { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhyMissionRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1WhyMission {
pub r#name: AgentTraceRuntimeV1WhyMissionName,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#run: Option<AgentTraceRuntimeV1WhyMissionRun>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhyStepName(String);
impl AgentTraceRuntimeV1WhyStepName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhyStepName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhyStepName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhyStepName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhyStepName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhyStepName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhyStepRun(String);
impl AgentTraceRuntimeV1WhyStepRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[0-9a-f]{32}$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhyStepRun: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhyStepRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhyStepRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhyStepRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhyStepRun { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhyStepRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1WhyStep {
pub r#name: AgentTraceRuntimeV1WhyStepName,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#run: Option<AgentTraceRuntimeV1WhyStepRun>,
}
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(try_from = "RawAgentTraceRuntimeV1Why")]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1Why {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#mission: Option<AgentTraceRuntimeV1WhyMission>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#step: Option<AgentTraceRuntimeV1WhyStep>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAgentTraceRuntimeV1Why {
#[serde(default, deserialize_with = "crate::deserialize_optional")]
r#mission: Option<AgentTraceRuntimeV1WhyMission>,
#[serde(default, deserialize_with = "crate::deserialize_optional")]
r#step: Option<AgentTraceRuntimeV1WhyStep>,
}
impl TryFrom<RawAgentTraceRuntimeV1Why> for AgentTraceRuntimeV1Why { type Error = crate::Error; fn try_from(raw: RawAgentTraceRuntimeV1Why) -> Result<Self, Self::Error> {
let count = [raw.r#mission.is_some(),raw.r#step.is_some(),].into_iter().filter(|present| *present).count(); if count < 1 { return Err(crate::Error::Invalid("AgentTraceRuntimeV1Why requires context".into())); }
Ok(Self {
r#mission: raw.r#mission,
r#step: raw.r#step,
}) } }
impl serde::Serialize for AgentTraceRuntimeV1Why { fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
let count = [false,self.r#mission.is_some(),self.r#step.is_some(),].into_iter().filter(|present| *present).count(); if count < 1 { return Err(serde::ser::Error::custom("AgentTraceRuntimeV1Why: minProperties")); }
let mut state = serializer.serialize_struct("AgentTraceRuntimeV1Why", count)?;
if let Some(value) = &self.r#mission { serde::ser::SerializeStruct::serialize_field(&mut state, "mission", value)?; }
if let Some(value) = &self.r#step { serde::ser::SerializeStruct::serialize_field(&mut state, "step", value)?; }
serde::ser::SerializeStruct::end(state) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowHarnessTool(String);
impl AgentTraceRuntimeV1HowHarnessTool { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowHarnessTool: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowHarnessTool: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowHarnessTool: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowHarnessTool { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowHarnessTool { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowHarnessVersion(String);
impl AgentTraceRuntimeV1HowHarnessVersion { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowHarnessVersion: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowHarnessVersion: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowHarnessVersion: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowHarnessVersion { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowHarnessVersion { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1HowHarness {
pub r#tool: AgentTraceRuntimeV1HowHarnessTool,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#version: Option<AgentTraceRuntimeV1HowHarnessVersion>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowModelRoute(String);
impl AgentTraceRuntimeV1HowModelRoute { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._+-]*$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowModelRoute: minLength".into())); }
if crate::utf16_len(value) > 64 { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowModelRoute: maxLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowModelRoute: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowModelRoute: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowModelRoute: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowModelRoute { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowModelRoute { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowModelEffort(String);
impl AgentTraceRuntimeV1HowModelEffort { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowModelEffort: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowModelEffort: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowModelEffort: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowModelEffort { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowModelEffort { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1HowModel {
pub r#route: AgentTraceRuntimeV1HowModelRoute,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#effort: Option<AgentTraceRuntimeV1HowModelEffort>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowToolingProfile(String);
impl AgentTraceRuntimeV1HowToolingProfile { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowToolingProfile: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowToolingProfile: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowToolingProfile: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowToolingProfile { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowToolingProfile { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowRuntimeProfile(String);
impl AgentTraceRuntimeV1HowRuntimeProfile { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowRuntimeProfile: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowRuntimeProfile: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowRuntimeProfile: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowRuntimeProfile { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowRuntimeProfile { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowSkillsManifest(String);
impl AgentTraceRuntimeV1HowSkillsManifest { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowSkillsManifest: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowSkillsManifest: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowSkillsManifest: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowSkillsManifest { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowSkillsManifest { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowInvocationId(String);
impl AgentTraceRuntimeV1HowInvocationId { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowInvocationId: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowInvocationId: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowInvocationId: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowInvocationId { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowInvocationId { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowIssuanceVariant0Tag(String);
impl AgentTraceRuntimeV1HowIssuanceVariant0Tag { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["st-issued"].contains(&value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant0Tag: enum".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowIssuanceVariant0Tag { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowIssuanceVariant0Tag { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowIssuanceVariant0StepRun(String);
impl AgentTraceRuntimeV1HowIssuanceVariant0StepRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^step-run\\/[0-9a-f]{32}\\/[a-z0-9][a-z0-9._-]*$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant0StepRun: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant0StepRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant0StepRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant0StepRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowIssuanceVariant0StepRun { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowIssuanceVariant0StepRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1HowIssuanceVariant0 {
pub r#_tag: AgentTraceRuntimeV1HowIssuanceVariant0Tag,
pub r#step_run: AgentTraceRuntimeV1HowIssuanceVariant0StepRun,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowIssuanceVariant1Tag(String);
impl AgentTraceRuntimeV1HowIssuanceVariant1Tag { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["not-st-issued"].contains(&value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant1Tag: enum".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowIssuanceVariant1Tag { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowIssuanceVariant1Tag { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowIssuanceVariant1Launcher(String);
impl AgentTraceRuntimeV1HowIssuanceVariant1Launcher { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant1Launcher: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant1Launcher: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant1Launcher: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowIssuanceVariant1Launcher { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowIssuanceVariant1Launcher { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1HowIssuanceVariant1 {
pub r#_tag: AgentTraceRuntimeV1HowIssuanceVariant1Tag,
pub r#launcher: AgentTraceRuntimeV1HowIssuanceVariant1Launcher,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum AgentTraceRuntimeV1HowIssuance {
Variant0(AgentTraceRuntimeV1HowIssuanceVariant0),
Variant1(AgentTraceRuntimeV1HowIssuanceVariant1),
}
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowIssuance { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
if let Ok(branch) = <AgentTraceRuntimeV1HowIssuanceVariant0 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant0(branch)); }
if let Ok(branch) = <AgentTraceRuntimeV1HowIssuanceVariant1 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant1(branch)); }
Err(serde::de::Error::custom("AgentTraceRuntimeV1HowIssuance: no union branch matched")) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1How {
pub r#harness: AgentTraceRuntimeV1HowHarness,
pub r#model: AgentTraceRuntimeV1HowModel,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#tooling_profile: Option<AgentTraceRuntimeV1HowToolingProfile>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#runtime_profile: Option<AgentTraceRuntimeV1HowRuntimeProfile>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#skills_manifest: Option<AgentTraceRuntimeV1HowSkillsManifest>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#invocation_id: Option<AgentTraceRuntimeV1HowInvocationId>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#issuance: Option<AgentTraceRuntimeV1HowIssuance>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhereSession(String);
impl AgentTraceRuntimeV1WhereSession { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhereSession: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhereSession: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhereSession: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhereSession: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhereSession { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhereSession { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhereHost(String);
impl AgentTraceRuntimeV1WhereHost { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhereHost: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhereHost: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhereHost: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhereHost { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhereHost { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhereWorktree(String);
impl AgentTraceRuntimeV1WhereWorktree { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhereWorktree: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhereWorktree: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("AgentTraceRuntimeV1WhereWorktree: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhereWorktree { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhereWorktree { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1Where {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#session: Option<AgentTraceRuntimeV1WhereSession>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#host: Option<AgentTraceRuntimeV1WhereHost>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#worktree: Option<AgentTraceRuntimeV1WhereWorktree>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1 {
pub r#type: AgentTraceRuntimeV1Type,
pub r#who: AgentTraceRuntimeV1Who,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#why: Option<AgentTraceRuntimeV1Why>,
pub r#how: AgentTraceRuntimeV1How,
pub r#where: AgentTraceRuntimeV1Where,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicAudienceV2Type(String);
impl PublicAudienceV2Type { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["agent-trace/v2"].contains(&value) { return Err(crate::Error::Invalid("PublicAudienceV2Type: enum".into())); }
Ok(()) } }
impl TryFrom<String> for PublicAudienceV2Type { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicAudienceV2Type { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicAudienceV2At(String);
impl PublicAudienceV2At { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PublicAudienceV2At: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicAudienceV2At: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicAudienceV2At: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PublicAudienceV2At: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicAudienceV2At { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicAudienceV2At { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicAudienceV2Artifact(String);
impl PublicAudienceV2Artifact { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicAudienceV2Artifact: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicAudienceV2Artifact: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicAudienceV2Artifact: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicAudienceV2Artifact { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicAudienceV2Artifact { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicAudienceV2WhoAgent(String);
impl PublicAudienceV2WhoAgent { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PublicAudienceV2WhoAgent: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicAudienceV2WhoAgent: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicAudienceV2WhoAgent: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PublicAudienceV2WhoAgent: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicAudienceV2WhoAgent { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicAudienceV2WhoAgent { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicAudienceV2WhoPrincipal(String);
impl PublicAudienceV2WhoPrincipal { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicAudienceV2WhoPrincipal: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicAudienceV2WhoPrincipal: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicAudienceV2WhoPrincipal: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicAudienceV2WhoPrincipal { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicAudienceV2WhoPrincipal { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicAudienceV2WhoActor(String);
impl PublicAudienceV2WhoActor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicAudienceV2WhoActor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicAudienceV2WhoActor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicAudienceV2WhoActor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicAudienceV2WhoActor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicAudienceV2WhoActor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicAudienceV2WhoPersona(String);
impl PublicAudienceV2WhoPersona { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicAudienceV2WhoPersona: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicAudienceV2WhoPersona: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicAudienceV2WhoPersona: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicAudienceV2WhoPersona { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicAudienceV2WhoPersona { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicAudienceV2WhoSupervisor(String);
impl PublicAudienceV2WhoSupervisor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PublicAudienceV2WhoSupervisor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicAudienceV2WhoSupervisor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicAudienceV2WhoSupervisor: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PublicAudienceV2WhoSupervisor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicAudienceV2WhoSupervisor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicAudienceV2WhoSupervisor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicAudienceV2Who {
pub r#agent: PublicAudienceV2WhoAgent,
pub r#principal: PublicAudienceV2WhoPrincipal,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#actor: Option<PublicAudienceV2WhoActor>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#persona: Option<PublicAudienceV2WhoPersona>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#supervisor: Option<PublicAudienceV2WhoSupervisor>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicAudienceV2WhyMissionName(String);
impl PublicAudienceV2WhyMissionName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicAudienceV2WhyMissionName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicAudienceV2WhyMissionName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicAudienceV2WhyMissionName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicAudienceV2WhyMissionName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicAudienceV2WhyMissionName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicAudienceV2WhyMission {
pub r#name: PublicAudienceV2WhyMissionName,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicAudienceV2WhyStepName(String);
impl PublicAudienceV2WhyStepName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicAudienceV2WhyStepName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicAudienceV2WhyStepName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicAudienceV2WhyStepName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicAudienceV2WhyStepName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicAudienceV2WhyStepName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicAudienceV2WhyStep {
pub r#name: PublicAudienceV2WhyStepName,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "RawPublicAudienceV2Why")]
#[serde(deny_unknown_fields)]
pub struct PublicAudienceV2Why {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#mission: Option<PublicAudienceV2WhyMission>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#step: Option<PublicAudienceV2WhyStep>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPublicAudienceV2Why {
#[serde(default, deserialize_with = "crate::deserialize_optional")]
r#mission: Option<PublicAudienceV2WhyMission>,
#[serde(default, deserialize_with = "crate::deserialize_optional")]
r#step: Option<PublicAudienceV2WhyStep>,
}
impl TryFrom<RawPublicAudienceV2Why> for PublicAudienceV2Why { type Error = crate::Error; fn try_from(raw: RawPublicAudienceV2Why) -> Result<Self, Self::Error> {
let count = [raw.r#mission.is_some(),raw.r#step.is_some(),].into_iter().filter(|present| *present).count(); if count < 1 { return Err(crate::Error::Invalid("PublicAudienceV2Why requires context".into())); }
Ok(Self {
r#mission: raw.r#mission,
r#step: raw.r#step,
}) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicAudienceV2HowHarnessTool(String);
impl PublicAudienceV2HowHarnessTool { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicAudienceV2HowHarnessTool: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicAudienceV2HowHarnessTool: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicAudienceV2HowHarnessTool: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicAudienceV2HowHarnessTool { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicAudienceV2HowHarnessTool { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicAudienceV2HowHarnessVersion(String);
impl PublicAudienceV2HowHarnessVersion { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicAudienceV2HowHarnessVersion: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicAudienceV2HowHarnessVersion: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicAudienceV2HowHarnessVersion: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicAudienceV2HowHarnessVersion { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicAudienceV2HowHarnessVersion { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicAudienceV2HowHarness {
pub r#tool: PublicAudienceV2HowHarnessTool,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#version: Option<PublicAudienceV2HowHarnessVersion>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicAudienceV2HowModelRoute(String);
impl PublicAudienceV2HowModelRoute { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._+-]*$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PublicAudienceV2HowModelRoute: minLength".into())); }
if crate::utf16_len(value) > 64 { return Err(crate::Error::Invalid("PublicAudienceV2HowModelRoute: maxLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicAudienceV2HowModelRoute: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicAudienceV2HowModelRoute: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PublicAudienceV2HowModelRoute: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicAudienceV2HowModelRoute { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicAudienceV2HowModelRoute { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicAudienceV2HowModel {
pub r#route: PublicAudienceV2HowModelRoute,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicAudienceV2How {
pub r#harness: PublicAudienceV2HowHarness,
pub r#model: PublicAudienceV2HowModel,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicAudienceV2WhereSession(String);
impl PublicAudienceV2WhereSession { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PublicAudienceV2WhereSession: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicAudienceV2WhereSession: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicAudienceV2WhereSession: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PublicAudienceV2WhereSession: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicAudienceV2WhereSession { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicAudienceV2WhereSession { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicAudienceV2Where {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#session: Option<PublicAudienceV2WhereSession>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicAudienceV2 {
pub r#type: PublicAudienceV2Type,
pub r#at: PublicAudienceV2At,
pub r#artifact: PublicAudienceV2Artifact,
pub r#who: PublicAudienceV2Who,
pub r#why: PublicAudienceV2Why,
pub r#how: PublicAudienceV2How,
pub r#where: PublicAudienceV2Where,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2Type(String);
impl PrivateAudienceV2Type { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["agent-trace/v2"].contains(&value) { return Err(crate::Error::Invalid("PrivateAudienceV2Type: enum".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2Type { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2Type { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2Id(String);
impl PrivateAudienceV2Id { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2Id: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2Id: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2Id: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2Id { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2Id { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2At(String);
impl PrivateAudienceV2At { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2At: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2At: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2At: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateAudienceV2At: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2At { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2At { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2Artifact(String);
impl PrivateAudienceV2Artifact { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2Artifact: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2Artifact: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2Artifact: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2Artifact { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2Artifact { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2WhoAgent(String);
impl PrivateAudienceV2WhoAgent { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2WhoAgent: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhoAgent: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2WhoAgent: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhoAgent: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2WhoAgent { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2WhoAgent { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2WhoPrincipal(String);
impl PrivateAudienceV2WhoPrincipal { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2WhoPrincipal: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhoPrincipal: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2WhoPrincipal: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2WhoPrincipal { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2WhoPrincipal { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2WhoActor(String);
impl PrivateAudienceV2WhoActor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2WhoActor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhoActor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2WhoActor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2WhoActor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2WhoActor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2WhoPersona(String);
impl PrivateAudienceV2WhoPersona { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2WhoPersona: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhoPersona: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2WhoPersona: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2WhoPersona { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2WhoPersona { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2WhoSupervisor(String);
impl PrivateAudienceV2WhoSupervisor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2WhoSupervisor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhoSupervisor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2WhoSupervisor: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhoSupervisor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2WhoSupervisor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2WhoSupervisor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateAudienceV2Who {
pub r#agent: PrivateAudienceV2WhoAgent,
pub r#principal: PrivateAudienceV2WhoPrincipal,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#actor: Option<PrivateAudienceV2WhoActor>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#persona: Option<PrivateAudienceV2WhoPersona>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#supervisor: Option<PrivateAudienceV2WhoSupervisor>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2WhyMissionName(String);
impl PrivateAudienceV2WhyMissionName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2WhyMissionName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhyMissionName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2WhyMissionName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2WhyMissionName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2WhyMissionName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2WhyMissionRun(String);
impl PrivateAudienceV2WhyMissionRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[0-9a-f]{32}$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2WhyMissionRun: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhyMissionRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2WhyMissionRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhyMissionRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2WhyMissionRun { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2WhyMissionRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateAudienceV2WhyMission {
pub r#name: PrivateAudienceV2WhyMissionName,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#run: Option<PrivateAudienceV2WhyMissionRun>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2WhyStepName(String);
impl PrivateAudienceV2WhyStepName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2WhyStepName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhyStepName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2WhyStepName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2WhyStepName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2WhyStepName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2WhyStepRun(String);
impl PrivateAudienceV2WhyStepRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[0-9a-f]{32}$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2WhyStepRun: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhyStepRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2WhyStepRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhyStepRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2WhyStepRun { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2WhyStepRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateAudienceV2WhyStep {
pub r#name: PrivateAudienceV2WhyStepName,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#run: Option<PrivateAudienceV2WhyStepRun>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "RawPrivateAudienceV2Why")]
#[serde(deny_unknown_fields)]
pub struct PrivateAudienceV2Why {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#mission: Option<PrivateAudienceV2WhyMission>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#step: Option<PrivateAudienceV2WhyStep>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPrivateAudienceV2Why {
#[serde(default, deserialize_with = "crate::deserialize_optional")]
r#mission: Option<PrivateAudienceV2WhyMission>,
#[serde(default, deserialize_with = "crate::deserialize_optional")]
r#step: Option<PrivateAudienceV2WhyStep>,
}
impl TryFrom<RawPrivateAudienceV2Why> for PrivateAudienceV2Why { type Error = crate::Error; fn try_from(raw: RawPrivateAudienceV2Why) -> Result<Self, Self::Error> {
let count = [raw.r#mission.is_some(),raw.r#step.is_some(),].into_iter().filter(|present| *present).count(); if count < 1 { return Err(crate::Error::Invalid("PrivateAudienceV2Why requires context".into())); }
Ok(Self {
r#mission: raw.r#mission,
r#step: raw.r#step,
}) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2HowHarnessTool(String);
impl PrivateAudienceV2HowHarnessTool { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2HowHarnessTool: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2HowHarnessTool: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2HowHarnessTool: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2HowHarnessTool { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2HowHarnessTool { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2HowHarnessVersion(String);
impl PrivateAudienceV2HowHarnessVersion { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2HowHarnessVersion: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2HowHarnessVersion: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2HowHarnessVersion: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2HowHarnessVersion { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2HowHarnessVersion { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateAudienceV2HowHarness {
pub r#tool: PrivateAudienceV2HowHarnessTool,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#version: Option<PrivateAudienceV2HowHarnessVersion>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2HowModelRoute(String);
impl PrivateAudienceV2HowModelRoute { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._+-]*$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2HowModelRoute: minLength".into())); }
if crate::utf16_len(value) > 64 { return Err(crate::Error::Invalid("PrivateAudienceV2HowModelRoute: maxLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2HowModelRoute: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2HowModelRoute: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateAudienceV2HowModelRoute: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2HowModelRoute { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2HowModelRoute { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2HowModelEffort(String);
impl PrivateAudienceV2HowModelEffort { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2HowModelEffort: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2HowModelEffort: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2HowModelEffort: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2HowModelEffort { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2HowModelEffort { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateAudienceV2HowModel {
pub r#route: PrivateAudienceV2HowModelRoute,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#effort: Option<PrivateAudienceV2HowModelEffort>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2HowToolingProfile(String);
impl PrivateAudienceV2HowToolingProfile { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2HowToolingProfile: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2HowToolingProfile: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2HowToolingProfile: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2HowToolingProfile { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2HowToolingProfile { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2HowRuntimeProfile(String);
impl PrivateAudienceV2HowRuntimeProfile { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2HowRuntimeProfile: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2HowRuntimeProfile: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2HowRuntimeProfile: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2HowRuntimeProfile { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2HowRuntimeProfile { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2HowSkillsManifest(String);
impl PrivateAudienceV2HowSkillsManifest { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2HowSkillsManifest: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2HowSkillsManifest: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2HowSkillsManifest: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2HowSkillsManifest { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2HowSkillsManifest { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2HowInvocationId(String);
impl PrivateAudienceV2HowInvocationId { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2HowInvocationId: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2HowInvocationId: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2HowInvocationId: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2HowInvocationId { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2HowInvocationId { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2HowIssuanceVariant0Tag(String);
impl PrivateAudienceV2HowIssuanceVariant0Tag { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["st-issued"].contains(&value) { return Err(crate::Error::Invalid("PrivateAudienceV2HowIssuanceVariant0Tag: enum".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2HowIssuanceVariant0Tag { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2HowIssuanceVariant0Tag { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2HowIssuanceVariant0StepRun(String);
impl PrivateAudienceV2HowIssuanceVariant0StepRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^step-run\\/[0-9a-f]{32}\\/[a-z0-9][a-z0-9._-]*$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2HowIssuanceVariant0StepRun: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2HowIssuanceVariant0StepRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2HowIssuanceVariant0StepRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateAudienceV2HowIssuanceVariant0StepRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2HowIssuanceVariant0StepRun { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2HowIssuanceVariant0StepRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateAudienceV2HowIssuanceVariant0 {
pub r#_tag: PrivateAudienceV2HowIssuanceVariant0Tag,
pub r#step_run: PrivateAudienceV2HowIssuanceVariant0StepRun,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2HowIssuanceVariant1Tag(String);
impl PrivateAudienceV2HowIssuanceVariant1Tag { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["not-st-issued"].contains(&value) { return Err(crate::Error::Invalid("PrivateAudienceV2HowIssuanceVariant1Tag: enum".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2HowIssuanceVariant1Tag { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2HowIssuanceVariant1Tag { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2HowIssuanceVariant1Launcher(String);
impl PrivateAudienceV2HowIssuanceVariant1Launcher { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2HowIssuanceVariant1Launcher: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2HowIssuanceVariant1Launcher: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2HowIssuanceVariant1Launcher: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2HowIssuanceVariant1Launcher { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2HowIssuanceVariant1Launcher { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateAudienceV2HowIssuanceVariant1 {
pub r#_tag: PrivateAudienceV2HowIssuanceVariant1Tag,
pub r#launcher: PrivateAudienceV2HowIssuanceVariant1Launcher,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum PrivateAudienceV2HowIssuance {
Variant0(PrivateAudienceV2HowIssuanceVariant0),
Variant1(PrivateAudienceV2HowIssuanceVariant1),
}
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2HowIssuance { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
if let Ok(branch) = <PrivateAudienceV2HowIssuanceVariant0 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant0(branch)); }
if let Ok(branch) = <PrivateAudienceV2HowIssuanceVariant1 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant1(branch)); }
Err(serde::de::Error::custom("PrivateAudienceV2HowIssuance: no union branch matched")) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateAudienceV2How {
pub r#harness: PrivateAudienceV2HowHarness,
pub r#model: PrivateAudienceV2HowModel,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#tooling_profile: Option<PrivateAudienceV2HowToolingProfile>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#runtime_profile: Option<PrivateAudienceV2HowRuntimeProfile>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#skills_manifest: Option<PrivateAudienceV2HowSkillsManifest>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#invocation_id: Option<PrivateAudienceV2HowInvocationId>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#issuance: Option<PrivateAudienceV2HowIssuance>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2WhereSession(String);
impl PrivateAudienceV2WhereSession { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2WhereSession: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhereSession: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2WhereSession: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhereSession: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2WhereSession { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2WhereSession { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2WhereHost(String);
impl PrivateAudienceV2WhereHost { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2WhereHost: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhereHost: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2WhereHost: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2WhereHost { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2WhereHost { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateAudienceV2WhereWorktree(String);
impl PrivateAudienceV2WhereWorktree { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateAudienceV2WhereWorktree: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateAudienceV2WhereWorktree: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateAudienceV2WhereWorktree: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateAudienceV2WhereWorktree { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateAudienceV2WhereWorktree { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateAudienceV2Where {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#session: Option<PrivateAudienceV2WhereSession>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#host: Option<PrivateAudienceV2WhereHost>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#worktree: Option<PrivateAudienceV2WhereWorktree>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateAudienceV2 {
pub r#type: PrivateAudienceV2Type,
pub r#id: PrivateAudienceV2Id,
pub r#at: PrivateAudienceV2At,
pub r#artifact: PrivateAudienceV2Artifact,
pub r#who: PrivateAudienceV2Who,
pub r#why: PrivateAudienceV2Why,
pub r#how: PrivateAudienceV2How,
pub r#where: PrivateAudienceV2Where,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicTrailerV2Type(String);
impl PublicTrailerV2Type { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["agent-trace/v2"].contains(&value) { return Err(crate::Error::Invalid("PublicTrailerV2Type: enum".into())); }
Ok(()) } }
impl TryFrom<String> for PublicTrailerV2Type { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicTrailerV2Type { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicTrailerV2WhoAgent(String);
impl PublicTrailerV2WhoAgent { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PublicTrailerV2WhoAgent: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicTrailerV2WhoAgent: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicTrailerV2WhoAgent: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PublicTrailerV2WhoAgent: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicTrailerV2WhoAgent { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicTrailerV2WhoAgent { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicTrailerV2WhoPrincipal(String);
impl PublicTrailerV2WhoPrincipal { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicTrailerV2WhoPrincipal: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicTrailerV2WhoPrincipal: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicTrailerV2WhoPrincipal: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicTrailerV2WhoPrincipal { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicTrailerV2WhoPrincipal { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicTrailerV2WhoActor(String);
impl PublicTrailerV2WhoActor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicTrailerV2WhoActor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicTrailerV2WhoActor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicTrailerV2WhoActor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicTrailerV2WhoActor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicTrailerV2WhoActor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicTrailerV2WhoPersona(String);
impl PublicTrailerV2WhoPersona { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicTrailerV2WhoPersona: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicTrailerV2WhoPersona: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicTrailerV2WhoPersona: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicTrailerV2WhoPersona { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicTrailerV2WhoPersona { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicTrailerV2WhoSupervisor(String);
impl PublicTrailerV2WhoSupervisor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PublicTrailerV2WhoSupervisor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicTrailerV2WhoSupervisor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicTrailerV2WhoSupervisor: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PublicTrailerV2WhoSupervisor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicTrailerV2WhoSupervisor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicTrailerV2WhoSupervisor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicTrailerV2Who {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#agent: Option<PublicTrailerV2WhoAgent>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#principal: Option<PublicTrailerV2WhoPrincipal>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#actor: Option<PublicTrailerV2WhoActor>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#persona: Option<PublicTrailerV2WhoPersona>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#supervisor: Option<PublicTrailerV2WhoSupervisor>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicTrailerV2WhyMissionName(String);
impl PublicTrailerV2WhyMissionName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicTrailerV2WhyMissionName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicTrailerV2WhyMissionName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicTrailerV2WhyMissionName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicTrailerV2WhyMissionName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicTrailerV2WhyMissionName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicTrailerV2WhyMission {
pub r#name: PublicTrailerV2WhyMissionName,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicTrailerV2WhyStepName(String);
impl PublicTrailerV2WhyStepName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicTrailerV2WhyStepName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicTrailerV2WhyStepName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicTrailerV2WhyStepName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicTrailerV2WhyStepName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicTrailerV2WhyStepName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicTrailerV2WhyStep {
pub r#name: PublicTrailerV2WhyStepName,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicTrailerV2Why {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#mission: Option<PublicTrailerV2WhyMission>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#step: Option<PublicTrailerV2WhyStep>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicTrailerV2HowHarnessTool(String);
impl PublicTrailerV2HowHarnessTool { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicTrailerV2HowHarnessTool: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicTrailerV2HowHarnessTool: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicTrailerV2HowHarnessTool: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicTrailerV2HowHarnessTool { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicTrailerV2HowHarnessTool { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicTrailerV2HowHarnessVersion(String);
impl PublicTrailerV2HowHarnessVersion { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicTrailerV2HowHarnessVersion: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicTrailerV2HowHarnessVersion: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicTrailerV2HowHarnessVersion: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicTrailerV2HowHarnessVersion { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicTrailerV2HowHarnessVersion { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicTrailerV2HowHarness {
pub r#tool: PublicTrailerV2HowHarnessTool,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#version: Option<PublicTrailerV2HowHarnessVersion>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicTrailerV2HowModelRoute(String);
impl PublicTrailerV2HowModelRoute { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._+-]*$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PublicTrailerV2HowModelRoute: minLength".into())); }
if crate::utf16_len(value) > 64 { return Err(crate::Error::Invalid("PublicTrailerV2HowModelRoute: maxLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicTrailerV2HowModelRoute: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicTrailerV2HowModelRoute: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PublicTrailerV2HowModelRoute: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicTrailerV2HowModelRoute { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicTrailerV2HowModelRoute { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicTrailerV2HowModel {
pub r#route: PublicTrailerV2HowModelRoute,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicTrailerV2How {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#harness: Option<PublicTrailerV2HowHarness>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#model: Option<PublicTrailerV2HowModel>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicTrailerV2 {
pub r#type: PublicTrailerV2Type,
pub r#who: PublicTrailerV2Who,
pub r#why: PublicTrailerV2Why,
pub r#how: PublicTrailerV2How,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2Type(String);
impl PrivateTrailerV2Type { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["agent-trace/v2"].contains(&value) { return Err(crate::Error::Invalid("PrivateTrailerV2Type: enum".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2Type { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2Type { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2WhoAgent(String);
impl PrivateTrailerV2WhoAgent { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2WhoAgent: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2WhoAgent: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2WhoAgent: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateTrailerV2WhoAgent: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2WhoAgent { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2WhoAgent { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2WhoPrincipal(String);
impl PrivateTrailerV2WhoPrincipal { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2WhoPrincipal: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2WhoPrincipal: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2WhoPrincipal: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2WhoPrincipal { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2WhoPrincipal { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2WhoActor(String);
impl PrivateTrailerV2WhoActor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2WhoActor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2WhoActor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2WhoActor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2WhoActor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2WhoActor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2WhoPersona(String);
impl PrivateTrailerV2WhoPersona { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2WhoPersona: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2WhoPersona: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2WhoPersona: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2WhoPersona { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2WhoPersona { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2WhoSupervisor(String);
impl PrivateTrailerV2WhoSupervisor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2WhoSupervisor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2WhoSupervisor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2WhoSupervisor: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateTrailerV2WhoSupervisor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2WhoSupervisor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2WhoSupervisor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateTrailerV2Who {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#agent: Option<PrivateTrailerV2WhoAgent>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#principal: Option<PrivateTrailerV2WhoPrincipal>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#actor: Option<PrivateTrailerV2WhoActor>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#persona: Option<PrivateTrailerV2WhoPersona>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#supervisor: Option<PrivateTrailerV2WhoSupervisor>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2WhyMissionName(String);
impl PrivateTrailerV2WhyMissionName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2WhyMissionName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2WhyMissionName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2WhyMissionName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2WhyMissionName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2WhyMissionName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2WhyMissionRun(String);
impl PrivateTrailerV2WhyMissionRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[0-9a-f]{32}$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2WhyMissionRun: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2WhyMissionRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2WhyMissionRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateTrailerV2WhyMissionRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2WhyMissionRun { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2WhyMissionRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateTrailerV2WhyMission {
pub r#name: PrivateTrailerV2WhyMissionName,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#run: Option<PrivateTrailerV2WhyMissionRun>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2WhyStepName(String);
impl PrivateTrailerV2WhyStepName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2WhyStepName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2WhyStepName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2WhyStepName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2WhyStepName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2WhyStepName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2WhyStepRun(String);
impl PrivateTrailerV2WhyStepRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[0-9a-f]{32}$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2WhyStepRun: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2WhyStepRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2WhyStepRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateTrailerV2WhyStepRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2WhyStepRun { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2WhyStepRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateTrailerV2WhyStep {
pub r#name: PrivateTrailerV2WhyStepName,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#run: Option<PrivateTrailerV2WhyStepRun>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateTrailerV2Why {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#mission: Option<PrivateTrailerV2WhyMission>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#step: Option<PrivateTrailerV2WhyStep>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2HowHarnessTool(String);
impl PrivateTrailerV2HowHarnessTool { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2HowHarnessTool: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2HowHarnessTool: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2HowHarnessTool: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2HowHarnessTool { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2HowHarnessTool { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2HowHarnessVersion(String);
impl PrivateTrailerV2HowHarnessVersion { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2HowHarnessVersion: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2HowHarnessVersion: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2HowHarnessVersion: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2HowHarnessVersion { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2HowHarnessVersion { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateTrailerV2HowHarness {
pub r#tool: PrivateTrailerV2HowHarnessTool,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#version: Option<PrivateTrailerV2HowHarnessVersion>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2HowModelRoute(String);
impl PrivateTrailerV2HowModelRoute { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._+-]*$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2HowModelRoute: minLength".into())); }
if crate::utf16_len(value) > 64 { return Err(crate::Error::Invalid("PrivateTrailerV2HowModelRoute: maxLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2HowModelRoute: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2HowModelRoute: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateTrailerV2HowModelRoute: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2HowModelRoute { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2HowModelRoute { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2HowModelEffort(String);
impl PrivateTrailerV2HowModelEffort { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2HowModelEffort: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2HowModelEffort: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2HowModelEffort: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2HowModelEffort { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2HowModelEffort { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateTrailerV2HowModel {
pub r#route: PrivateTrailerV2HowModelRoute,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#effort: Option<PrivateTrailerV2HowModelEffort>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2HowToolingProfile(String);
impl PrivateTrailerV2HowToolingProfile { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2HowToolingProfile: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2HowToolingProfile: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2HowToolingProfile: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2HowToolingProfile { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2HowToolingProfile { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2HowRuntimeProfile(String);
impl PrivateTrailerV2HowRuntimeProfile { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2HowRuntimeProfile: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2HowRuntimeProfile: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2HowRuntimeProfile: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2HowRuntimeProfile { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2HowRuntimeProfile { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2HowSkillsManifest(String);
impl PrivateTrailerV2HowSkillsManifest { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2HowSkillsManifest: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2HowSkillsManifest: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2HowSkillsManifest: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2HowSkillsManifest { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2HowSkillsManifest { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2HowInvocationId(String);
impl PrivateTrailerV2HowInvocationId { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2HowInvocationId: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2HowInvocationId: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2HowInvocationId: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2HowInvocationId { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2HowInvocationId { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2HowIssuanceVariant0Tag(String);
impl PrivateTrailerV2HowIssuanceVariant0Tag { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["st-issued"].contains(&value) { return Err(crate::Error::Invalid("PrivateTrailerV2HowIssuanceVariant0Tag: enum".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2HowIssuanceVariant0Tag { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2HowIssuanceVariant0Tag { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2HowIssuanceVariant0StepRun(String);
impl PrivateTrailerV2HowIssuanceVariant0StepRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^step-run\\/[0-9a-f]{32}\\/[a-z0-9][a-z0-9._-]*$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2HowIssuanceVariant0StepRun: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2HowIssuanceVariant0StepRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2HowIssuanceVariant0StepRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateTrailerV2HowIssuanceVariant0StepRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2HowIssuanceVariant0StepRun { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2HowIssuanceVariant0StepRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateTrailerV2HowIssuanceVariant0 {
pub r#_tag: PrivateTrailerV2HowIssuanceVariant0Tag,
pub r#step_run: PrivateTrailerV2HowIssuanceVariant0StepRun,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2HowIssuanceVariant1Tag(String);
impl PrivateTrailerV2HowIssuanceVariant1Tag { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["not-st-issued"].contains(&value) { return Err(crate::Error::Invalid("PrivateTrailerV2HowIssuanceVariant1Tag: enum".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2HowIssuanceVariant1Tag { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2HowIssuanceVariant1Tag { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateTrailerV2HowIssuanceVariant1Launcher(String);
impl PrivateTrailerV2HowIssuanceVariant1Launcher { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateTrailerV2HowIssuanceVariant1Launcher: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateTrailerV2HowIssuanceVariant1Launcher: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateTrailerV2HowIssuanceVariant1Launcher: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateTrailerV2HowIssuanceVariant1Launcher { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2HowIssuanceVariant1Launcher { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateTrailerV2HowIssuanceVariant1 {
pub r#_tag: PrivateTrailerV2HowIssuanceVariant1Tag,
pub r#launcher: PrivateTrailerV2HowIssuanceVariant1Launcher,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum PrivateTrailerV2HowIssuance {
Variant0(PrivateTrailerV2HowIssuanceVariant0),
Variant1(PrivateTrailerV2HowIssuanceVariant1),
}
impl<'de> serde::Deserialize<'de> for PrivateTrailerV2HowIssuance { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
if let Ok(branch) = <PrivateTrailerV2HowIssuanceVariant0 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant0(branch)); }
if let Ok(branch) = <PrivateTrailerV2HowIssuanceVariant1 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant1(branch)); }
Err(serde::de::Error::custom("PrivateTrailerV2HowIssuance: no union branch matched")) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateTrailerV2How {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#harness: Option<PrivateTrailerV2HowHarness>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#model: Option<PrivateTrailerV2HowModel>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#tooling_profile: Option<PrivateTrailerV2HowToolingProfile>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#runtime_profile: Option<PrivateTrailerV2HowRuntimeProfile>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#skills_manifest: Option<PrivateTrailerV2HowSkillsManifest>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#invocation_id: Option<PrivateTrailerV2HowInvocationId>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#issuance: Option<PrivateTrailerV2HowIssuance>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateTrailerV2 {
pub r#type: PrivateTrailerV2Type,
pub r#who: PrivateTrailerV2Who,
pub r#why: PrivateTrailerV2Why,
pub r#how: PrivateTrailerV2How,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicFooterV2Type(String);
impl PublicFooterV2Type { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["agent-trace/v2"].contains(&value) { return Err(crate::Error::Invalid("PublicFooterV2Type: enum".into())); }
Ok(()) } }
impl TryFrom<String> for PublicFooterV2Type { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicFooterV2Type { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicFooterV2WhoAgent(String);
impl PublicFooterV2WhoAgent { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PublicFooterV2WhoAgent: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicFooterV2WhoAgent: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicFooterV2WhoAgent: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PublicFooterV2WhoAgent: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicFooterV2WhoAgent { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicFooterV2WhoAgent { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicFooterV2WhoPrincipal(String);
impl PublicFooterV2WhoPrincipal { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicFooterV2WhoPrincipal: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicFooterV2WhoPrincipal: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicFooterV2WhoPrincipal: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicFooterV2WhoPrincipal { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicFooterV2WhoPrincipal { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicFooterV2WhoActor(String);
impl PublicFooterV2WhoActor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicFooterV2WhoActor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicFooterV2WhoActor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicFooterV2WhoActor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicFooterV2WhoActor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicFooterV2WhoActor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicFooterV2WhoPersona(String);
impl PublicFooterV2WhoPersona { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicFooterV2WhoPersona: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicFooterV2WhoPersona: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicFooterV2WhoPersona: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicFooterV2WhoPersona { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicFooterV2WhoPersona { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicFooterV2WhoSupervisor(String);
impl PublicFooterV2WhoSupervisor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PublicFooterV2WhoSupervisor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicFooterV2WhoSupervisor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicFooterV2WhoSupervisor: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PublicFooterV2WhoSupervisor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicFooterV2WhoSupervisor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicFooterV2WhoSupervisor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicFooterV2Who {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#agent: Option<PublicFooterV2WhoAgent>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#principal: Option<PublicFooterV2WhoPrincipal>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#actor: Option<PublicFooterV2WhoActor>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#persona: Option<PublicFooterV2WhoPersona>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#supervisor: Option<PublicFooterV2WhoSupervisor>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicFooterV2WhyMissionName(String);
impl PublicFooterV2WhyMissionName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicFooterV2WhyMissionName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicFooterV2WhyMissionName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicFooterV2WhyMissionName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicFooterV2WhyMissionName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicFooterV2WhyMissionName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicFooterV2WhyMission {
pub r#name: PublicFooterV2WhyMissionName,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicFooterV2WhyStepName(String);
impl PublicFooterV2WhyStepName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicFooterV2WhyStepName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicFooterV2WhyStepName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicFooterV2WhyStepName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicFooterV2WhyStepName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicFooterV2WhyStepName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicFooterV2WhyStep {
pub r#name: PublicFooterV2WhyStepName,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicFooterV2Why {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#mission: Option<PublicFooterV2WhyMission>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#step: Option<PublicFooterV2WhyStep>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicFooterV2HowHarnessTool(String);
impl PublicFooterV2HowHarnessTool { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicFooterV2HowHarnessTool: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicFooterV2HowHarnessTool: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicFooterV2HowHarnessTool: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicFooterV2HowHarnessTool { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicFooterV2HowHarnessTool { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicFooterV2HowHarnessVersion(String);
impl PublicFooterV2HowHarnessVersion { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PublicFooterV2HowHarnessVersion: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicFooterV2HowHarnessVersion: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicFooterV2HowHarnessVersion: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicFooterV2HowHarnessVersion { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicFooterV2HowHarnessVersion { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicFooterV2HowHarness {
pub r#tool: PublicFooterV2HowHarnessTool,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#version: Option<PublicFooterV2HowHarnessVersion>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicFooterV2HowModelRoute(String);
impl PublicFooterV2HowModelRoute { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._+-]*$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PublicFooterV2HowModelRoute: minLength".into())); }
if crate::utf16_len(value) > 64 { return Err(crate::Error::Invalid("PublicFooterV2HowModelRoute: maxLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicFooterV2HowModelRoute: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicFooterV2HowModelRoute: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PublicFooterV2HowModelRoute: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicFooterV2HowModelRoute { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicFooterV2HowModelRoute { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicFooterV2HowModel {
pub r#route: PublicFooterV2HowModelRoute,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicFooterV2How {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#harness: Option<PublicFooterV2HowHarness>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#model: Option<PublicFooterV2HowModel>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PublicFooterV2WhereSession(String);
impl PublicFooterV2WhereSession { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PublicFooterV2WhereSession: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PublicFooterV2WhereSession: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PublicFooterV2WhereSession: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PublicFooterV2WhereSession: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PublicFooterV2WhereSession { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PublicFooterV2WhereSession { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicFooterV2Where {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#session: Option<PublicFooterV2WhereSession>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicFooterV2 {
pub r#type: PublicFooterV2Type,
pub r#who: PublicFooterV2Who,
pub r#why: PublicFooterV2Why,
pub r#how: PublicFooterV2How,
pub r#where: PublicFooterV2Where,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2Type(String);
impl PrivateFooterV2Type { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["agent-trace/v2"].contains(&value) { return Err(crate::Error::Invalid("PrivateFooterV2Type: enum".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2Type { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2Type { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2WhoAgent(String);
impl PrivateFooterV2WhoAgent { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2WhoAgent: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhoAgent: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2WhoAgent: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhoAgent: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2WhoAgent { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2WhoAgent { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2WhoPrincipal(String);
impl PrivateFooterV2WhoPrincipal { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2WhoPrincipal: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhoPrincipal: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2WhoPrincipal: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2WhoPrincipal { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2WhoPrincipal { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2WhoActor(String);
impl PrivateFooterV2WhoActor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2WhoActor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhoActor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2WhoActor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2WhoActor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2WhoActor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2WhoPersona(String);
impl PrivateFooterV2WhoPersona { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2WhoPersona: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhoPersona: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2WhoPersona: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2WhoPersona { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2WhoPersona { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2WhoSupervisor(String);
impl PrivateFooterV2WhoSupervisor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2WhoSupervisor: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhoSupervisor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2WhoSupervisor: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhoSupervisor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2WhoSupervisor { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2WhoSupervisor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateFooterV2Who {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#agent: Option<PrivateFooterV2WhoAgent>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#principal: Option<PrivateFooterV2WhoPrincipal>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#actor: Option<PrivateFooterV2WhoActor>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#persona: Option<PrivateFooterV2WhoPersona>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#supervisor: Option<PrivateFooterV2WhoSupervisor>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2WhyMissionName(String);
impl PrivateFooterV2WhyMissionName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2WhyMissionName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhyMissionName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2WhyMissionName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2WhyMissionName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2WhyMissionName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2WhyMissionRun(String);
impl PrivateFooterV2WhyMissionRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[0-9a-f]{32}$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2WhyMissionRun: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhyMissionRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2WhyMissionRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhyMissionRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2WhyMissionRun { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2WhyMissionRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateFooterV2WhyMission {
pub r#name: PrivateFooterV2WhyMissionName,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#run: Option<PrivateFooterV2WhyMissionRun>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2WhyStepName(String);
impl PrivateFooterV2WhyStepName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2WhyStepName: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhyStepName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2WhyStepName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2WhyStepName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2WhyStepName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2WhyStepRun(String);
impl PrivateFooterV2WhyStepRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[0-9a-f]{32}$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2WhyStepRun: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhyStepRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2WhyStepRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhyStepRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2WhyStepRun { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2WhyStepRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateFooterV2WhyStep {
pub r#name: PrivateFooterV2WhyStepName,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#run: Option<PrivateFooterV2WhyStepRun>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateFooterV2Why {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#mission: Option<PrivateFooterV2WhyMission>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#step: Option<PrivateFooterV2WhyStep>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2HowHarnessTool(String);
impl PrivateFooterV2HowHarnessTool { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2HowHarnessTool: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2HowHarnessTool: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2HowHarnessTool: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2HowHarnessTool { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2HowHarnessTool { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2HowHarnessVersion(String);
impl PrivateFooterV2HowHarnessVersion { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2HowHarnessVersion: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2HowHarnessVersion: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2HowHarnessVersion: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2HowHarnessVersion { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2HowHarnessVersion { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateFooterV2HowHarness {
pub r#tool: PrivateFooterV2HowHarnessTool,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#version: Option<PrivateFooterV2HowHarnessVersion>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2HowModelRoute(String);
impl PrivateFooterV2HowModelRoute { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._+-]*$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2HowModelRoute: minLength".into())); }
if crate::utf16_len(value) > 64 { return Err(crate::Error::Invalid("PrivateFooterV2HowModelRoute: maxLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2HowModelRoute: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2HowModelRoute: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateFooterV2HowModelRoute: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2HowModelRoute { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2HowModelRoute { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2HowModelEffort(String);
impl PrivateFooterV2HowModelEffort { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2HowModelEffort: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2HowModelEffort: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2HowModelEffort: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2HowModelEffort { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2HowModelEffort { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateFooterV2HowModel {
pub r#route: PrivateFooterV2HowModelRoute,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#effort: Option<PrivateFooterV2HowModelEffort>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2HowToolingProfile(String);
impl PrivateFooterV2HowToolingProfile { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2HowToolingProfile: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2HowToolingProfile: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2HowToolingProfile: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2HowToolingProfile { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2HowToolingProfile { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2HowRuntimeProfile(String);
impl PrivateFooterV2HowRuntimeProfile { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2HowRuntimeProfile: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2HowRuntimeProfile: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2HowRuntimeProfile: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2HowRuntimeProfile { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2HowRuntimeProfile { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2HowSkillsManifest(String);
impl PrivateFooterV2HowSkillsManifest { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2HowSkillsManifest: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2HowSkillsManifest: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2HowSkillsManifest: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2HowSkillsManifest { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2HowSkillsManifest { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2HowInvocationId(String);
impl PrivateFooterV2HowInvocationId { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2HowInvocationId: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2HowInvocationId: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2HowInvocationId: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2HowInvocationId { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2HowInvocationId { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2HowIssuanceVariant0Tag(String);
impl PrivateFooterV2HowIssuanceVariant0Tag { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["st-issued"].contains(&value) { return Err(crate::Error::Invalid("PrivateFooterV2HowIssuanceVariant0Tag: enum".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2HowIssuanceVariant0Tag { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2HowIssuanceVariant0Tag { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2HowIssuanceVariant0StepRun(String);
impl PrivateFooterV2HowIssuanceVariant0StepRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^step-run\\/[0-9a-f]{32}\\/[a-z0-9][a-z0-9._-]*$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2HowIssuanceVariant0StepRun: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2HowIssuanceVariant0StepRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2HowIssuanceVariant0StepRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateFooterV2HowIssuanceVariant0StepRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2HowIssuanceVariant0StepRun { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2HowIssuanceVariant0StepRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateFooterV2HowIssuanceVariant0 {
pub r#_tag: PrivateFooterV2HowIssuanceVariant0Tag,
pub r#step_run: PrivateFooterV2HowIssuanceVariant0StepRun,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2HowIssuanceVariant1Tag(String);
impl PrivateFooterV2HowIssuanceVariant1Tag { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["not-st-issued"].contains(&value) { return Err(crate::Error::Invalid("PrivateFooterV2HowIssuanceVariant1Tag: enum".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2HowIssuanceVariant1Tag { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2HowIssuanceVariant1Tag { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2HowIssuanceVariant1Launcher(String);
impl PrivateFooterV2HowIssuanceVariant1Launcher { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2HowIssuanceVariant1Launcher: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2HowIssuanceVariant1Launcher: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2HowIssuanceVariant1Launcher: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2HowIssuanceVariant1Launcher { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2HowIssuanceVariant1Launcher { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateFooterV2HowIssuanceVariant1 {
pub r#_tag: PrivateFooterV2HowIssuanceVariant1Tag,
pub r#launcher: PrivateFooterV2HowIssuanceVariant1Launcher,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum PrivateFooterV2HowIssuance {
Variant0(PrivateFooterV2HowIssuanceVariant0),
Variant1(PrivateFooterV2HowIssuanceVariant1),
}
impl<'de> serde::Deserialize<'de> for PrivateFooterV2HowIssuance { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
if let Ok(branch) = <PrivateFooterV2HowIssuanceVariant0 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant0(branch)); }
if let Ok(branch) = <PrivateFooterV2HowIssuanceVariant1 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant1(branch)); }
Err(serde::de::Error::custom("PrivateFooterV2HowIssuance: no union branch matched")) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateFooterV2How {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#harness: Option<PrivateFooterV2HowHarness>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#model: Option<PrivateFooterV2HowModel>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#tooling_profile: Option<PrivateFooterV2HowToolingProfile>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#runtime_profile: Option<PrivateFooterV2HowRuntimeProfile>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#skills_manifest: Option<PrivateFooterV2HowSkillsManifest>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#invocation_id: Option<PrivateFooterV2HowInvocationId>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#issuance: Option<PrivateFooterV2HowIssuance>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2WhereSession(String);
impl PrivateFooterV2WhereSession { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?$").expect("schema pattern"));
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2WhereSession: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhereSession: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2WhereSession: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhereSession: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2WhereSession { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2WhereSession { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2WhereHost(String);
impl PrivateFooterV2WhereHost { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2WhereHost: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhereHost: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2WhereHost: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2WhereHost { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2WhereHost { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct PrivateFooterV2WhereWorktree(String);
impl PrivateFooterV2WhereWorktree { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("PrivateFooterV2WhereWorktree: minLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("PrivateFooterV2WhereWorktree: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(crate::Error::Invalid("PrivateFooterV2WhereWorktree: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for PrivateFooterV2WhereWorktree { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for PrivateFooterV2WhereWorktree { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateFooterV2Where {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#session: Option<PrivateFooterV2WhereSession>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#host: Option<PrivateFooterV2WhereHost>,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#worktree: Option<PrivateFooterV2WhereWorktree>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateFooterV2 {
pub r#type: PrivateFooterV2Type,
pub r#who: PrivateFooterV2Who,
pub r#why: PrivateFooterV2Why,
pub r#how: PrivateFooterV2How,
pub r#where: PrivateFooterV2Where,
}
impl From<AgentTraceRuntimeV1WhoAgent> for AgentTraceV2WhoAgent { fn from(value: AgentTraceRuntimeV1WhoAgent) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1WhoPrincipal> for AgentTraceV2WhoPrincipal { fn from(value: AgentTraceRuntimeV1WhoPrincipal) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1WhoActor> for AgentTraceV2WhoActor { fn from(value: AgentTraceRuntimeV1WhoActor) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1WhoPersona> for AgentTraceV2WhoPersona { fn from(value: AgentTraceRuntimeV1WhoPersona) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1WhoSupervisor> for AgentTraceV2WhoSupervisor { fn from(value: AgentTraceRuntimeV1WhoSupervisor) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1Who> for AgentTraceV2Who { fn from(value: AgentTraceRuntimeV1Who) -> Self { Self {
r#agent: value.r#agent.into(),
r#principal: value.r#principal.into(),
r#actor: value.r#actor.map(Into::into),
r#persona: value.r#persona.map(Into::into),
r#supervisor: value.r#supervisor.map(Into::into),
} } }
impl From<AgentTraceRuntimeV1WhyMissionName> for AgentTraceV2WhyMissionName { fn from(value: AgentTraceRuntimeV1WhyMissionName) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1WhyMissionRun> for AgentTraceV2WhyMissionRun { fn from(value: AgentTraceRuntimeV1WhyMissionRun) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1WhyMission> for AgentTraceV2WhyMission { fn from(value: AgentTraceRuntimeV1WhyMission) -> Self { Self {
r#name: value.r#name.into(),
r#run: value.r#run.map(Into::into),
} } }
impl From<AgentTraceRuntimeV1WhyStepName> for AgentTraceV2WhyStepName { fn from(value: AgentTraceRuntimeV1WhyStepName) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1WhyStepRun> for AgentTraceV2WhyStepRun { fn from(value: AgentTraceRuntimeV1WhyStepRun) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1WhyStep> for AgentTraceV2WhyStep { fn from(value: AgentTraceRuntimeV1WhyStep) -> Self { Self {
r#name: value.r#name.into(),
r#run: value.r#run.map(Into::into),
} } }
impl From<AgentTraceRuntimeV1Why> for AgentTraceV2Why { fn from(value: AgentTraceRuntimeV1Why) -> Self { Self {
r#mission: value.r#mission.map(Into::into),
r#step: value.r#step.map(Into::into),
} } }
impl From<AgentTraceRuntimeV1HowHarnessTool> for AgentTraceV2HowHarnessTool { fn from(value: AgentTraceRuntimeV1HowHarnessTool) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1HowHarnessVersion> for AgentTraceV2HowHarnessVersion { fn from(value: AgentTraceRuntimeV1HowHarnessVersion) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1HowHarness> for AgentTraceV2HowHarness { fn from(value: AgentTraceRuntimeV1HowHarness) -> Self { Self {
r#tool: value.r#tool.into(),
r#version: value.r#version.map(Into::into),
} } }
impl From<AgentTraceRuntimeV1HowModelRoute> for AgentTraceV2HowModelRoute { fn from(value: AgentTraceRuntimeV1HowModelRoute) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1HowModelEffort> for AgentTraceV2HowModelEffort { fn from(value: AgentTraceRuntimeV1HowModelEffort) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1HowModel> for AgentTraceV2HowModel { fn from(value: AgentTraceRuntimeV1HowModel) -> Self { Self {
r#route: value.r#route.into(),
r#effort: value.r#effort.map(Into::into),
} } }
impl From<AgentTraceRuntimeV1HowToolingProfile> for AgentTraceV2HowToolingProfile { fn from(value: AgentTraceRuntimeV1HowToolingProfile) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1HowRuntimeProfile> for AgentTraceV2HowRuntimeProfile { fn from(value: AgentTraceRuntimeV1HowRuntimeProfile) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1HowSkillsManifest> for AgentTraceV2HowSkillsManifest { fn from(value: AgentTraceRuntimeV1HowSkillsManifest) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1HowInvocationId> for AgentTraceV2HowInvocationId { fn from(value: AgentTraceRuntimeV1HowInvocationId) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1HowIssuanceVariant0Tag> for AgentTraceV2HowIssuanceVariant0Tag { fn from(value: AgentTraceRuntimeV1HowIssuanceVariant0Tag) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1HowIssuanceVariant0StepRun> for AgentTraceV2HowIssuanceVariant0StepRun { fn from(value: AgentTraceRuntimeV1HowIssuanceVariant0StepRun) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1HowIssuanceVariant0> for AgentTraceV2HowIssuanceVariant0 { fn from(value: AgentTraceRuntimeV1HowIssuanceVariant0) -> Self { Self {
r#_tag: value.r#_tag.into(),
r#step_run: value.r#step_run.into(),
} } }
impl From<AgentTraceRuntimeV1HowIssuanceVariant1Tag> for AgentTraceV2HowIssuanceVariant1Tag { fn from(value: AgentTraceRuntimeV1HowIssuanceVariant1Tag) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1HowIssuanceVariant1Launcher> for AgentTraceV2HowIssuanceVariant1Launcher { fn from(value: AgentTraceRuntimeV1HowIssuanceVariant1Launcher) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1HowIssuanceVariant1> for AgentTraceV2HowIssuanceVariant1 { fn from(value: AgentTraceRuntimeV1HowIssuanceVariant1) -> Self { Self {
r#_tag: value.r#_tag.into(),
r#launcher: value.r#launcher.into(),
} } }
impl From<AgentTraceRuntimeV1HowIssuance> for AgentTraceV2HowIssuance { fn from(value: AgentTraceRuntimeV1HowIssuance) -> Self { match value {
AgentTraceRuntimeV1HowIssuance::Variant0(inner) => Self::Variant0(inner.into()),
AgentTraceRuntimeV1HowIssuance::Variant1(inner) => Self::Variant1(inner.into()),
} } }
impl From<AgentTraceRuntimeV1How> for AgentTraceV2How { fn from(value: AgentTraceRuntimeV1How) -> Self { Self {
r#harness: value.r#harness.into(),
r#model: value.r#model.into(),
r#tooling_profile: value.r#tooling_profile.map(Into::into),
r#runtime_profile: value.r#runtime_profile.map(Into::into),
r#skills_manifest: value.r#skills_manifest.map(Into::into),
r#invocation_id: value.r#invocation_id.map(Into::into),
r#issuance: value.r#issuance.map(Into::into),
} } }
impl From<AgentTraceRuntimeV1WhereSession> for AgentTraceV2WhereSession { fn from(value: AgentTraceRuntimeV1WhereSession) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1WhereHost> for AgentTraceV2WhereHost { fn from(value: AgentTraceRuntimeV1WhereHost) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1WhereWorktree> for AgentTraceV2WhereWorktree { fn from(value: AgentTraceRuntimeV1WhereWorktree) -> Self { Self(value.0) } }
impl From<AgentTraceRuntimeV1Where> for AgentTraceV2Where { fn from(value: AgentTraceRuntimeV1Where) -> Self { Self {
r#session: value.r#session.map(Into::into),
r#host: value.r#host.map(Into::into),
r#worktree: value.r#worktree.map(Into::into),
} } }
impl From<AgentTraceRuntimeV1Type> for AgentTraceV2Type { fn from(value: AgentTraceRuntimeV1Type) -> Self { let mut value = value.0; value.clear(); value.push_str("agent-trace/v2"); Self(value) } }
