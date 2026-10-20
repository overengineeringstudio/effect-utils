//! Declarative child policy only. This module never starts a process.
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Default, Deserialize)]
#[serde(try_from = "Vec<Child>")]
pub struct Children(pub Vec<Child>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Child {
    pub id: String,
    pub helper_path: String,
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: String,
    pub required_tcc_services: Vec<Service>,
    pub readiness: Readiness,
    pub restart: Restart,
    pub stop: Stop,
    #[serde(default)]
    pub activation: Activation,
    pub schedule: Schedule,
    pub requires_session: Session,
}
#[derive(Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum Service { FullDiskAccess, Notifications, ScreenRecording, Accessibility, Microphone, SystemAudio, Automation }
#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Activation { Active, #[default] Inactive }
#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Session { None, Gui }
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stop { pub signal: StopSignal, pub grace_ms: u32 }
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StopSignal { Int, Term }
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Readiness { SocketAccepts { path: String, #[serde(rename = "timeoutMs")] timeout_ms: u32 }, ExitZero { op: String, #[serde(rename = "timeoutMs")] timeout_ms: u32 }, None {} }
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Restart { Never {}, OnFailure { #[serde(rename = "initialBackoffMs")] initial_backoff_ms: u32, #[serde(rename = "maxBackoffMs")] max_backoff_ms: u32, #[serde(rename = "maxAttempts")] max_attempts: u32 } }
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Schedule { Resident {}, LaunchdScheduled { op: String } }

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.as_bytes()[0].is_ascii_lowercase()
        && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn operation(value: &str) -> bool {
    value.split_once('.').is_some_and(|(namespace, name)| identifier(namespace) && identifier(name))
}
fn clean(value: &str) -> bool { !value.contains('\0') }
fn absolute(value: &str) -> bool {
    value.starts_with('/') && value != "/nix/store" && !value.starts_with("/nix/store/")
        && clean(value) && !value.contains('\\')
        && (value == "/" || value[1..].split('/').all(|part| !matches!(part, "" | "." | "..")))
}
fn nested(value: &str) -> bool {
    value.starts_with("Contents/Helpers/") && clean(value) && !value.contains('\\')
        && value.split('/').all(|part| !matches!(part, "" | "." | ".."))
}
impl TryFrom<Vec<Child>> for Children {
    type Error = &'static str;
    fn try_from(children: Vec<Child>) -> Result<Self, Self::Error> {
        let mut ids = BTreeSet::new();
        let mut helpers = BTreeSet::new();
        for child in &children {
            if !identifier(&child.id) || !ids.insert(&child.id) || !nested(&child.helper_path) || !helpers.insert(&child.helper_path) {
                return Err("Invalid or duplicate child ID or nested helper path");
            }
            if !absolute(&child.cwd) || child.argv.iter().any(|s| !clean(s))
                || child.env.iter().any(|(key, value)| key.is_empty() || key.contains('=') || !clean(key) || !clean(value)) {
                return Err("Invalid fixed child argv, environment or working directory");
            }
            if child.required_tcc_services.iter().collect::<BTreeSet<_>>().len() != child.required_tcc_services.len() {
                return Err("Duplicate child TCC service");
            }
            match &child.readiness {
                Readiness::SocketAccepts { path, timeout_ms } if !absolute(path) || !(1..=300_000).contains(timeout_ms) => return Err("Invalid child socket probe"),
                Readiness::ExitZero { op, timeout_ms } if !operation(op) || !(1..=300_000).contains(timeout_ms) => return Err("Invalid child probe operation"),
                _ => {}
            }
            if !(1..=300_000).contains(&child.stop.grace_ms) { return Err("Invalid child stop grace period"); }
            if let Restart::OnFailure { initial_backoff_ms, max_backoff_ms, max_attempts } = &child.restart {
                if *initial_backoff_ms == 0 || initial_backoff_ms > max_backoff_ms || *max_backoff_ms > 300_000 || !(1..=100).contains(max_attempts) {
                    return Err("Invalid child restart bounds");
                }
            }
            if let Schedule::LaunchdScheduled { op } = &child.schedule {
                if !operation(op) || !matches!(child.restart, Restart::Never {}) { return Err("Invalid scheduled child operation or restart policy"); }
            }
        }
        Ok(Self(children))
    }
}
impl Children {
    /// Fail closed until the separately reviewed supervisor runtime exists.
    pub fn require_inactive(&self) -> Result<(), &'static str> {
        if self.0.iter().any(|child| child.activation == Activation::Active) {
            return Err("Active supervised children require the supervisor runtime; only inactive declarations are supported");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    fn child() -> Value { json!({"id":"watcher","helperPath":"Contents/Helpers/watcher","argv":[],"env":{},"cwd":"/","requiredTccServices":["full-disk-access"],"requiresSession":"none","readiness":{"kind":"socket-accepts","path":"/var/run/example.sock","timeoutMs":1000},"restart":{"kind":"on-failure","initialBackoffMs":100,"maxBackoffMs":1000,"maxAttempts":3},"stop":{"signal":"term","graceMs":30000},"schedule":{"kind":"resident"}}) }
    fn parse(value: Value) -> Result<Children, serde_json::Error> { serde_json::from_value(json!([value])) }
    #[test] fn inactive_is_default_and_active_is_not_silently_started() {
        assert!(parse(child()).unwrap().require_inactive().is_ok());
        let mut value = child(); value["activation"] = json!("active");
        assert!(parse(value).unwrap().require_inactive().is_err());
    }
    #[test] fn rejects_unknown_fields_at_every_object_boundary() {
        for key in ["", "readiness", "restart", "schedule", "stop"] {
            let mut value = child();
            let target = if key.is_empty() { &mut value } else { &mut value[key] };
            target["unexpected"] = json!(true);
            assert!(parse(value).is_err(), "{key}");
        }
        for (key, kind) in [("readiness", "none"), ("restart", "never"), ("schedule", "resident")] {
            let mut value = child(); value[key] = json!({"kind":kind,"unexpected":true});
            assert!(parse(value).is_err(), "{key}:{kind}");
        }
    }
    #[test] fn rejects_non_nested_helper_paths() {
        for path in ["/nix/store/abc/bin/watcher", "/Contents/Helpers/watcher", "bin/watcher", "Contents/MacOS/watcher", "Contents/Helpers/../watcher", "Contents/Helpers/./watcher", "Contents/Helpers//watcher", "Contents/Helpers/", "Contents/Helpers/a\\b", "Contents/Helpers/a\0b"] {
            let mut value = child(); value["helperPath"] = json!(path);
            assert!(parse(value).is_err(), "{path:?}");
        }
    }
    #[test] fn rejects_invalid_bounds_services_and_fixed_inputs() {
        for (key, bad) in [("id", json!("Bad")), ("cwd", json!("/nix/store/abc")), ("argv", json!(["a\0b"])), ("env", json!({"A=B":"x"})), ("requiredTccServices", json!(["unknown"])), ("requiredTccServices", json!(["microphone","microphone"])), ("activation", json!("enabled")), ("restart", json!({"kind":"on-failure","initialBackoffMs":10,"maxBackoffMs":1,"maxAttempts":1})), ("readiness", json!({"kind":"socket-accepts","path":"relative","timeoutMs":1})), ("readiness", json!({"kind":"exit-zero","op":"core.exec","timeoutMs":0}))] {
            let mut value = child(); value[key] = bad;
            assert!(parse(value).is_err(), "{key}");
        }
    }
    #[test] fn validates_scheduled_operations_and_unique_inventory() {
        let mut value = child(); value["schedule"] = json!({"kind":"launchd-scheduled","op":"private.backup"});
        assert!(parse(value.clone()).is_err());
        value["restart"] = json!({"kind":"never"}); value["readiness"] = json!({"kind":"exit-zero","op":"private.probe","timeoutMs":1000});
        assert!(parse(value).is_ok());
        assert!(serde_json::from_value::<Children>(json!([child(),child()])).is_err());
        let mut other = child(); other["id"] = json!("other");
        assert!(serde_json::from_value::<Children>(json!([child(),other])).is_err());
    }
    #[test] fn validates_stop_signal_and_grace_bounds() {
        for signal in ["int", "term"] {
            let mut value = child(); value["stop"] = json!({"signal":signal,"graceMs":1});
            assert!(parse(value).is_ok());
        }
        for stop in [json!({"signal":"kill","graceMs":1}), json!({"signal":"term","graceMs":0}), json!({"signal":"int","graceMs":300001}), json!({"signal":"term"}), json!({"graceMs":1000})] {
            let mut value = child(); value["stop"] = stop;
            assert!(parse(value).is_err());
        }
        let mut value = child(); value.as_object_mut().unwrap().remove("stop");
        assert!(parse(value).is_err());
    }
}
