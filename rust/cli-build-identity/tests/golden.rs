use cli_build_identity::{resolve_build_identity, BuildIdentity};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    base_version: String,
    build_stamp: String,
    runtime_stamp: Option<String>,
    now: f64,
    expected: BuildIdentity,
}

#[test]
fn shared_typescript_golden_cases() {
    // This integration-test executable has one test and no other timezone users.
    // Match the TypeScript runner's timezone before chrono first initializes Local.
    std::env::set_var("TZ", "UTC");
    let cases: Vec<Case> = serde_json::from_str(include_str!("../resources/golden.json")).unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let actual = resolve_build_identity(
            &case.base_version,
            Some(&case.build_stamp),
            case.runtime_stamp.as_deref(),
            case.now,
        );
        assert_eq!(actual, case.expected, "{}", case.name);
    }
}
