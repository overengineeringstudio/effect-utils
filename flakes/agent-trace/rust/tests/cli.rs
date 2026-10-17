use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

struct Repository(PathBuf);
impl Repository {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("agent-trace-cli-{}-{unique}", std::process::id()));
        fs::create_dir(&path).unwrap();
        git(&path, &["init", "--quiet"]);
        Self(path)
    }
}
impl Drop for Repository {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn git(path: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args([
            "-c",
            "user.name=Agent Trace Test",
            "-c",
            "user.email=trace@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn cli(repo: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_agent-trace"))
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap()
}
#[test]
fn file_reader_follows_renames_and_commit_reader_ignores_human_wording() {
    let corpus: Value =
        serde_json::from_str(include_str!("../../fixtures/codec-corpus.json")).unwrap();
    let case = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| {
            c["kind"] == "current"
                && c["binding"] == "trailer/v2"
                && c["audience"] == "public-minimal"
        })
        .unwrap();
    let repo = Repository::new();
    fs::write(repo.0.join("original.txt"), "trace\n").unwrap();
    git(&repo.0, &["add", "original.txt"]);
    let machine = case["wire"].as_str().unwrap().split_once('\n').unwrap().1;
    git(
        &repo.0,
        &[
            "commit",
            "--quiet",
            "-m",
            &format!("Initial\n\nAgent: preview wording\n{machine}"),
        ],
    );
    git(&repo.0, &["mv", "original.txt", "renamed.txt"]);
    git(
        &repo.0,
        &["commit", "--quiet", "-m", case["wire"].as_str().unwrap()],
    );
    let output = cli(
        &repo.0,
        &["show", "file", "renamed.txt", "--json", "--public"],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let records: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(records.as_array().unwrap().len(), 2);
    for record in records.as_array().unwrap() {
        assert_eq!(record["trace"], case["view"]);
    }
    let output = cli(&repo.0, &["show", "commit", "HEAD~1", "--public"]);
    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains("On-Behalf-Of:"));
}
#[test]
fn span_is_a_clear_nonzero_unsupported_error() {
    let output = cli(Path::new("."), &["show", "span", "attributes.json"]);
    assert!(!output.status.success());
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("not supported yet"));
}

#[test]
fn untraced_commits_remain_null_and_legacy_history_uses_agent_label() {
    let corpus: Value =
        serde_json::from_str(include_str!("../../fixtures/codec-corpus.json")).unwrap();
    let legacy = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| {
            case["kind"] == "legacy"
                && case["binding"] == "trailer/v1"
                && case["view"]["who"]["agent"] == "agent/dotfiles/disk-steward-dev3"
        })
        .unwrap();
    let repo = Repository::new();
    fs::write(repo.0.join("history.txt"), "untraced\n").unwrap();
    git(&repo.0, &["add", "history.txt"]);
    git(&repo.0, &["commit", "--quiet", "-m", "No attribution"]);
    fs::write(repo.0.join("history.txt"), "legacy\n").unwrap();
    git(&repo.0, &["add", "history.txt"]);
    git(
        &repo.0,
        &["commit", "--quiet", "-m", legacy["wire"].as_str().unwrap()],
    );
    fs::write(repo.0.join("history.txt"), "tooling only\n").unwrap();
    git(&repo.0, &["add", "history.txt"]);
    git(
        &repo.0,
        &[
            "commit",
            "--quiet",
            "-m",
            "Tooling only\n\ntooling-profile: dotfiles@abc",
        ],
    );
    let output = cli(&repo.0, &["show", "commit", "HEAD", "--json"]);
    assert!(output.status.success());
    let records: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(records[0]["trace"].is_null());
    let output = cli(&repo.0, &["show", "commit", "HEAD"]);
    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains("no Agent Trace recorded"));
    let output = cli(&repo.0, &["show", "file", "history.txt", "--json"]);
    assert!(output.status.success());
    let records: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(records.as_array().unwrap().len(), 3);
    assert!(records[0]["trace"].is_null());
    assert_eq!(records[1]["trace"], legacy["view"]);
    assert!(records[2]["trace"].is_null());
    let output = cli(&repo.0, &["show", "file", "history.txt"]);
    assert!(output.status.success());
    let human = String::from_utf8(output.stdout).unwrap();
    assert_eq!(human.matches("no Agent Trace recorded").count(), 2);
    assert!(human.contains("Agent: dotfiles/disk-steward-dev3 (legacy trailer/v1)"));
    assert!(!human.contains("On-Behalf-Of:"));
    assert!(!human.contains("via "));
}

#[test]
fn sentinel_only_legacy_observations_keep_a_neutral_trace_header() {
    let corpus: Value =
        serde_json::from_str(include_str!("../../fixtures/codec-corpus.json")).unwrap();
    let legacy = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| {
            case["kind"] == "legacy" && case["binding"] == "trailer/v1" && case["summary"] == ""
        })
        .unwrap();
    let repo = Repository::new();
    git(
        &repo.0,
        &[
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            legacy["wire"].as_str().unwrap(),
        ],
    );
    let output = cli(&repo.0, &["show", "commit", "HEAD", "--json"]);
    assert!(output.status.success());
    let records: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(records[0]["trace"], legacy["view"]);
    let output = cli(&repo.0, &["show", "commit", "HEAD"]);
    assert!(output.status.success());
    let human = String::from_utf8(output.stdout).unwrap();
    assert!(human.contains("Agent: Agent Trace (legacy trailer/v1)"));
    assert!(!human.contains("On-Behalf-Of:"));
    assert!(!human.contains("no Agent Trace recorded"));
}
