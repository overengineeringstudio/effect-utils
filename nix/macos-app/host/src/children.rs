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
    pub rlimit_nofile: RlimitNofile,
    pub nice: i8,
    pub process_type: ProcessType,
    pub directories: Directories,
    pub client_socket: Option<String>,
}
#[derive(Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(try_from = "String")]
pub enum Service { FullDiskAccess, Notifications, ScreenRecording, Accessibility, Microphone, SystemAudio, Automation }
#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(try_from = "String")]
pub enum Activation { Active, #[default] Inactive }
#[derive(Debug, Deserialize)]
#[serde(try_from = "String")]
pub enum Session { None, Gui }
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stop { pub signal: StopSignal, pub grace_ms: u32 }
#[derive(Debug, Deserialize)]
#[serde(try_from = "String")]
pub enum StopSignal { Int, Term }
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RlimitNofile { pub soft: u64, pub hard: u64 }
#[derive(Debug, Deserialize)]
#[serde(try_from = "String")]
pub enum ProcessType { Background, Standard, Interactive, Adaptive }

impl TryFrom<String> for Activation {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() { "active" => Ok(Self::Active), "inactive" => Ok(Self::Inactive), _ => Err("Invalid child activation") }
    }
}
impl TryFrom<String> for Session {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() { "none" => Ok(Self::None), "gui" => Ok(Self::Gui), _ => Err("Invalid child session") }
    }
}
impl TryFrom<String> for StopSignal {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() { "int" => Ok(Self::Int), "term" => Ok(Self::Term), _ => Err("Invalid child stop signal") }
    }
}
impl TryFrom<String> for ProcessType {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() { "Background" => Ok(Self::Background), "Standard" => Ok(Self::Standard), "Interactive" => Ok(Self::Interactive), "Adaptive" => Ok(Self::Adaptive), _ => Err("Invalid child process type") }
    }
}
impl TryFrom<String> for Service {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "full-disk-access" => Ok(Self::FullDiskAccess), "notifications" => Ok(Self::Notifications),
            "screen-recording" => Ok(Self::ScreenRecording), "accessibility" => Ok(Self::Accessibility),
            "microphone" => Ok(Self::Microphone), "system-audio" => Ok(Self::SystemAudio),
            "automation" => Ok(Self::Automation), _ => Err("Invalid child TCC service")
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Directories { pub state: Directory, pub run: Directory, pub log: Directory }
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Directory { pub path: String, #[serde(default = "directory_mode")] pub mode: u32 }
fn directory_mode() -> u32 { 0o700 }
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Readiness { SocketAccepts { path: String, #[serde(rename = "timeoutMs")] timeout_ms: u32 }, ProbeOp { op: String, #[serde(rename = "timeoutMs")] timeout_ms: u32 }, None {} }
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
            if child.rlimit_nofile.soft == 0 || child.rlimit_nofile.soft > child.rlimit_nofile.hard || !(-20..=19).contains(&child.nice) {
                return Err("Invalid child resource policy");
            }
            let mut directories = BTreeSet::new();
            for directory in [&child.directories.state, &child.directories.run, &child.directories.log] {
                if !absolute(&directory.path) || directory.path == "/" || directory.mode > 0o777 || !directories.insert(&directory.path) {
                    return Err("Invalid or duplicate child directory");
                }
            }
            if child.client_socket.as_ref().is_some_and(|socket| !absolute(socket) || !socket.strip_prefix(&child.directories.run.path).is_some_and(|suffix| suffix.starts_with('/'))) {
                return Err("Child client socket must be inside its declared run directory");
            }
            match &child.readiness {
                Readiness::SocketAccepts { path, timeout_ms } if !absolute(path) || child.client_socket.as_ref() != Some(path) || !(1..=300_000).contains(timeout_ms) => return Err("Invalid child socket probe or mismatched client endpoint"),
                Readiness::ProbeOp { op, timeout_ms } if !operation(op) || !(1..=300_000).contains(timeout_ms) => return Err("Invalid child probe operation"),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    fn child() -> Value { json!({"id":"watcher","helperPath":"Contents/Helpers/watcher","argv":[],"env":{},"cwd":"/","requiredTccServices":["full-disk-access"],"requiresSession":"none","rlimitNofile":{"soft":8192,"hard":8192},"nice":0,"processType":"Standard","directories":{"state":{"path":"/var/example/state"},"run":{"path":"/var/example/run"},"log":{"path":"/var/example/log"}},"clientSocket":"/var/example/run/watcher.sock","readiness":{"kind":"socket-accepts","path":"/var/example/run/watcher.sock","timeoutMs":1000},"restart":{"kind":"on-failure","initialBackoffMs":100,"maxBackoffMs":1000,"maxAttempts":3},"stop":{"signal":"term","graceMs":30000},"schedule":{"kind":"resident"}}) }
    fn parse(value: Value) -> Result<Children, serde_json::Error> { serde_json::from_value(json!([value])) }
    #[test] fn inactive_is_default_and_active_is_explicit() {
        assert_eq!(parse(child()).unwrap().0[0].activation, Activation::Inactive);
        let mut value = child(); value["activation"] = json!("active");
        assert_eq!(parse(value).unwrap().0[0].activation, Activation::Active);
    }
    #[test] fn rejects_unknown_fields_at_every_object_boundary() {
        for key in ["", "readiness", "restart", "schedule", "stop", "rlimitNofile", "directories"] {
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
        value["restart"] = json!({"kind":"never"}); value["readiness"] = json!({"kind":"probe-op","op":"private.probe","timeoutMs":1000});
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
    #[test] fn rejects_invalid_resources_directories_and_changed_socket() {
        for (key, bad) in [("rlimitNofile", json!({"soft":0,"hard":1})), ("rlimitNofile", json!({"soft":2,"hard":1})), ("nice", json!(-21)), ("nice", json!(20)), ("processType", json!("unknown")), ("clientSocket", json!("/other/socket")), ("readiness", json!({"kind":"exit-zero","op":"private.probe","timeoutMs":1}))] {
            let mut value = child(); value[key] = bad;
            assert!(parse(value).is_err(), "{key}");
        }
        for directory in [json!({"path":"/"}), json!({"path":"/nix/store/state"}), json!({"path":"/state","mode":512}), json!({"path":"/state","extra":true})] {
            let mut value = child(); value["directories"]["state"] = directory;
            assert!(parse(value).is_err());
        }
        let parsed = parse(child()).unwrap();
        assert_eq!(parsed.0[0].directories.run.mode, 0o700);
    }
    #[test] fn string_enum_admission_matches_json_schema() {
        let schema: Value = serde_json::from_str(include_str!("../../children.schema.json")).unwrap();
        for field in ["activation", "requiresSession", "processType", "signal", "requiredTccServices"] {
            let properties = &schema["$defs"]["child"]["properties"];
            let choices = match field {
                "signal" => &properties["stop"]["properties"]["signal"]["enum"],
                "requiredTccServices" => &properties[field]["items"]["enum"],
                _ => &properties[field]["enum"],
            }.as_array().unwrap();
            let mut candidates = choices.clone();
            candidates.extend([json!({"inactive":null}), json!({"none":null}), json!({"Standard":null}), json!({"term":null}), json!({"full-disk-access":null}), json!(null), json!(0), json!(true), json!("unknown")]);
            for candidate in candidates {
                let schema_accepts = choices.contains(&candidate);
                let mut value = child();
                match field {
                    "signal" => value["stop"]["signal"] = candidate.clone(),
                    "requiredTccServices" => value[field] = json!([candidate]),
                    _ => value[field] = candidate.clone(),
                }
                assert_eq!(parse(value).is_ok(), schema_accepts, "{field}: {candidate}");
            }
        }
    }
}
