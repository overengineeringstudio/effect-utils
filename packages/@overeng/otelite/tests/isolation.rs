//! M8 — coordination-free isolation gate (decisions/0010). K concurrent
//! receivers, each capturing a uniquely-tagged span into its own dir with no
//! shared state. Gates on the invariants that held even at K=400 in the
//! experiment — zero bind failures, zero cross-contamination, distinct ports —
//! NOT on a per-run success rate.
//!
//! K=100 runs in CI; K=400 is `#[ignore]` (run locally: `cargo test -- --ignored`).

use std::collections::HashSet;
use std::sync::Arc;

use otelite::receiver::RunningReceiver;
use otelite::sink::Sink;

/// One span whose name is the per-instance token, so a capture can be checked
/// to contain exactly its own token and no foreign ones.
fn span(token: &str) -> String {
    format!(
        r#"{{"resourceSpans":[{{"scopeSpans":[{{"spans":[{{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"{token}","startTimeUnixNano":"1","endTimeUnixNano":"2"}}]}}]}}]}}"#
    )
}

fn port(endpoint: &str) -> u16 {
    endpoint.rsplit(':').next().unwrap().parse().unwrap()
}

struct RunResult {
    http_port: u16,
    grpc_port: u16,
    capture: String,
    token: String,
}

async fn one(i: usize) -> RunResult {
    let dir = tempfile::tempdir().unwrap();
    let sink = Arc::new(Sink::create(dir.path()).await.expect("create sink"));
    let rx = RunningReceiver::start(sink)
        .await
        .expect("bind ephemeral ports");
    let token = format!("TOKEN-{i}");
    let http_port = port(&rx.http_endpoint);
    let grpc_port = port(&rx.grpc_endpoint);
    let resp = reqwest::Client::new()
        .post(format!("{}/v1/traces", rx.http_endpoint))
        .header("content-type", "application/json")
        .body(span(&token))
        .send()
        .await
        .expect("export");
    assert_eq!(resp.status(), 200);
    rx.shutdown().await;
    let capture = std::fs::read_to_string(dir.path().join("traces.ndjson")).unwrap();
    RunResult {
        http_port,
        grpc_port,
        capture,
        token,
    }
}

async fn isolation(k: usize) {
    let handles: Vec<_> = (0..k).map(|i| tokio::spawn(one(i))).collect();
    let mut ports: HashSet<u16> = HashSet::new();
    for h in handles {
        let r = h.await.expect("no bind failure / panic"); // bind_fail == 0
                                                           // Cross-contamination: exactly this run's own token, no foreign tokens.
        assert!(
            r.capture.contains(&r.token),
            "{} missing own token",
            r.token
        );
        assert_eq!(
            r.capture.matches("TOKEN-").count(),
            1,
            "{} captured a foreign token",
            r.token
        );
        // Distinct ports across every run (no shared/colliding bind).
        assert!(ports.insert(r.http_port), "duplicate http port");
        assert!(ports.insert(r.grpc_port), "duplicate grpc port");
    }
    assert_eq!(
        ports.len(),
        2 * k,
        "every run got two distinct ephemeral ports"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn isolation_k100() {
    isolation(100).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "heavy; run locally with --ignored"]
async fn isolation_k400() {
    isolation(400).await;
}
