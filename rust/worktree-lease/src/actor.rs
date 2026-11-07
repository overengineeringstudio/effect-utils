//! Attribution labels are descriptive, not authentication or authorization.
pub fn agent(value: &str) -> bool {
    value.starts_with("agent/") && value.len() > 6
}
pub fn lock_scope(value: &str) -> bool {
    if agent(value) {
        return true;
    }
    if let Some(name) = value
        .strip_prefix("unit/")
        .and_then(|v| v.strip_suffix(".service"))
    {
        return (1..=240).contains(&name.len())
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"@:._-".contains(&b));
    }
    if let Some(label) = value.strip_prefix("launchd/") {
        return (1..=240).contains(&label.len())
            && label.as_bytes()[0].is_ascii_alphanumeric()
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
    }
    false
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scope_grammar() {
        for value in [
            "agent/example",
            "unit/job@a:1.service",
            "launchd/org.example-job_1",
        ] {
            assert!(lock_scope(value), "{value}");
        }
        for value in [
            "agent/",
            "unit/.service",
            "unit/a.timer",
            "unit/a/b.service",
            "unit/ä.service",
            "launchd/",
            "launchd/.job",
            "launchd/a:b",
            "launchd/a/b",
        ] {
            assert!(!lock_scope(value), "{value}");
        }
        assert!(lock_scope(&format!("unit/{}.service", "a".repeat(240))));
        assert!(!lock_scope(&format!("unit/{}.service", "a".repeat(241))));
        assert!(lock_scope(&format!("launchd/{}", "a".repeat(240))));
        assert!(!lock_scope(&format!("launchd/{}", "a".repeat(241))));
        assert!(!agent("unit/job.service"));
        assert!(!agent("launchd/org.example"));
    }
}
