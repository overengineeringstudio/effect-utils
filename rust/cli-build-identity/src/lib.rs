//! Canonical CLI build identity, matching `@overeng/utils/node/cli-build-identity`.
//! Capture `option_env!("CLI_BUILD_STAMP")` in the binary, not this library:
//! Buck builds shared libraries independently of the product stamp.

use chrono::{Datelike, Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Package,
    Local,
    Nix,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildIdentity {
    pub base_version: String,
    pub display_version: String,
    pub machine_version: String,
    pub source_kind: SourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
    pub dirty: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_ts: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_ts: Option<f64>,
}

impl BuildIdentity {
    #[must_use]
    pub fn error_suffix(&self, name: &str) -> String {
        format!("({name} {})", self.display_version)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum BuildStamp {
    Local {
        rev: String,
        ts: f64,
        commit_ts: Option<f64>,
        dirty: bool,
    },
    Nix {
        version: String,
        rev: String,
        commit_ts: f64,
        build_ts: Option<f64>,
        dirty: bool,
    },
}

/// Invalid required fields reject a stamp; invalid optional timestamps are ignored.
#[must_use]
pub fn parse_build_stamp(raw: &str) -> Option<BuildStamp> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let rev = value.get("rev")?.as_str()?.to_owned();
    let dirty = value.get("dirty")?.as_bool()?;
    match value.get("type")?.as_str()? {
        "local" => Some(BuildStamp::Local {
            rev,
            ts: value.get("ts")?.as_f64()?,
            commit_ts: value.get("commitTs").and_then(Value::as_f64),
            dirty,
        }),
        "nix" => Some(BuildStamp::Nix {
            version: value.get("version")?.as_str()?.to_owned(),
            rev,
            commit_ts: value.get("commitTs")?.as_f64()?,
            build_ts: value.get("buildTs").and_then(Value::as_f64),
            dirty,
        }),
        _ => None,
    }
}

/// Embedded Nix wins; embedded local stamps describe the build shell, not the binary.
#[must_use]
pub fn build_identity_from_env(base: &str, embedded: Option<&str>) -> BuildIdentity {
    let runtime = std::env::var("CLI_BUILD_STAMP").ok();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_secs_f64().floor());
    resolve_build_identity(base, embedded, runtime.as_deref(), now)
}

/// Pure resolver used by the cross-language golden suite.
#[must_use]
pub fn resolve_build_identity(
    base: &str,
    embedded: Option<&str>,
    runtime: Option<&str>,
    now: f64,
) -> BuildIdentity {
    let stamp = embedded
        .and_then(parse_build_stamp)
        .filter(|stamp| matches!(stamp, BuildStamp::Nix { .. }))
        .or_else(|| runtime.and_then(|raw| parse_build_stamp(raw.trim_matches(js_whitespace))));
    match stamp {
        Some(BuildStamp::Local {
            rev,
            ts,
            commit_ts,
            dirty,
        }) => {
            let age = commit_ts.map_or_else(
                || relative_time(ts, now),
                |ts| format!("committed {}", relative_time(ts, now)),
            );
            BuildIdentity {
                base_version: base.to_owned(),
                display_version: format!(
                    "{base} — running from local source ({rev}, {age}{})",
                    dirty_note(dirty)
                ),
                machine_version: format!("{base}+local.{rev}{}", if dirty { ".dirty" } else { "" }),
                source_kind: SourceKind::Local,
                rev: Some(rev),
                dirty,
                commit_ts,
                build_ts: Some(ts),
            }
        }
        Some(BuildStamp::Nix {
            version,
            rev,
            commit_ts,
            build_ts,
            dirty,
        }) => {
            let machine_version = format!(
                "{version}+{rev}{}",
                if dirty && !rev.ends_with("-dirty") {
                    "-dirty"
                } else {
                    ""
                }
            );
            let display_version = format!(
                "{machine_version} — {} {}{}",
                if build_ts.is_some() {
                    "built"
                } else {
                    "committed"
                },
                relative_time(build_ts.unwrap_or(commit_ts), now),
                dirty_note(dirty)
            );
            BuildIdentity {
                base_version: version,
                display_version,
                machine_version,
                source_kind: SourceKind::Nix,
                rev: Some(rev),
                dirty,
                commit_ts: Some(commit_ts),
                build_ts,
            }
        }
        None => BuildIdentity {
            base_version: base.to_owned(),
            display_version: base.to_owned(),
            machine_version: base.to_owned(),
            source_kind: SourceKind::Package,
            rev: None,
            dirty: false,
            commit_ts: None,
            build_ts: None,
        },
    }
}

// Match ECMAScript String.trim, including BOM but excluding Unicode NEL.
fn js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

fn dirty_note(dirty: bool) -> &'static str {
    if dirty {
        ", with uncommitted changes"
    } else {
        ""
    }
}

fn relative_time(ts: f64, now: f64) -> String {
    if !ts.is_finite() || !now.is_finite() {
        return "n/a".to_owned();
    }
    let seconds = (now - ts).floor().max(0.0);
    if seconds < 60.0 {
        return "just now".to_owned();
    }
    let minutes = (seconds / 60.0).floor();
    if minutes < 60.0 {
        return format!("{minutes} min ago");
    }
    let hours = (minutes / 60.0).floor();
    if hours < 24.0 {
        return format!("{hours} {} ago", if hours < 2.0 { "hour" } else { "hours" });
    }
    let days = (hours / 24.0).floor();
    if days < 7.0 {
        return format!("{days} {} ago", if days < 2.0 { "day" } else { "days" });
    }
    if days < 30.0 {
        let weeks = (days / 7.0).floor();
        return format!("{weeks} {} ago", if weeks < 2.0 { "week" } else { "weeks" });
    }
    // JavaScript Date uses the process timezone for the legacy calendar bucket.
    #[allow(clippy::cast_possible_truncation)]
    let timestamp_ms = (ts * 1000.0).trunc() as i64;
    Local
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .map_or_else(
            || "Invalid Date NaN".to_owned(),
            |date| format!("{} {}", date.format("%b"), date.day()),
        )
}
