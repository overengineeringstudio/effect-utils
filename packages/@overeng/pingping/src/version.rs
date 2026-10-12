//! Mirrors the shared CLI stamp contract. The existing Rust formatter is private
//! to otel-scrape; linking its telemetry engine solely for formatting is not practical.
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Stamp {
    Nix {
        version: String,
        rev: String,
        #[serde(default)]
        dirty: bool,
    },
    Local {
        rev: String,
        #[serde(default)]
        dirty: bool,
    },
}

pub fn resolve(base: &str, embedded: Option<&str>) -> String {
    let runtime = std::env::var("CLI_BUILD_STAMP").ok();
    resolve_stamps(base, embedded, runtime.as_deref())
}

fn parse(stamp: &str) -> Option<Stamp> {
    serde_json::from_str(stamp).ok()
}

fn resolve_stamps(base: &str, embedded: Option<&str>, runtime: Option<&str>) -> String {
    // An embedded LocalStamp describes the shell, not the compiled executable.
    let embedded = embedded
        .and_then(parse)
        .filter(|stamp| matches!(stamp, Stamp::Nix { .. }));
    match embedded.or_else(|| runtime.and_then(parse)) {
        Some(Stamp::Nix {
            version,
            rev,
            dirty,
        }) => {
            let suffix = if dirty && !rev.ends_with("-dirty") {
                "-dirty"
            } else {
                ""
            };
            format!("{version}+{rev}{suffix}")
        }
        Some(Stamp::Local { rev, dirty }) => {
            let suffix = if dirty { ".dirty" } else { "" };
            format!("{base}+local.{rev}{suffix}")
        }
        None => format!("{base}+dev"),
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_stamps;

    #[test]
    fn fallback_and_stamps() {
        assert_eq!(resolve_stamps("0.1.0", None, None), "0.1.0+dev");
        assert_eq!(resolve_stamps("0.1.0", Some("invalid"), None), "0.1.0+dev");
        let nix = r#"{"type":"nix","version":"1.0.0","rev":"abc-dirty","dirty":true}"#;
        let local = r#"{"type":"local","rev":"def","dirty":true}"#;
        assert_eq!(
            resolve_stamps("0.1.0", Some(nix), Some(local)),
            "1.0.0+abc-dirty"
        );
        assert_eq!(
            resolve_stamps("0.1.0", Some(local), Some(local)),
            "0.1.0+local.def.dirty"
        );
        assert_eq!(resolve_stamps("0.1.0", Some(local), None), "0.1.0+dev");
        assert_eq!(
            resolve_stamps("0.1.0", Some(r#"{"type":"nix"}"#), Some(local)),
            "0.1.0+local.def.dirty"
        );
    }
}
