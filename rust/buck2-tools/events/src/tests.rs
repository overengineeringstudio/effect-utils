use super::*;
use ruzstd::encoding::{compress_to_vec, CompressionLevel};

fn append<M: Message>(bytes: &mut Vec<u8>, message: &M) {
    message.encode_length_delimited(bytes).unwrap();
}

#[test]
fn direct_decode_truncation_and_trace_views() {
    let uuid = "10203040-5060-7080-90a0-b0c0d0e0f000";
    let mut raw = Vec::new();
    append(
        &mut raw,
        &data::Invocation {
            command_line_args: vec!["buck2".into(), "build".into()],
            ..Default::default()
        },
    );
    let start = data::BuckEvent {
        timestamp: Some(prost_types::Timestamp {
            seconds: 1_700_000_000,
            nanos: 0,
        }),
        trace_id: uuid.into(),
        span_id: 3,
        parent_id: 0,
        data: Some(buck_event::Data::SpanStart(data::SpanStartEvent {
            data: Some(span_start_event::Data::Command(data::CommandStart {
                cli_args: vec!["buck2".into(), "build".into()],
                ..Default::default()
            })),
        })),
    };
    append(
        &mut raw,
        &CommandProgress {
            progress: Some(command_progress::Progress::Event(start.clone())),
        },
    );
    let action = data::BuckEvent {
        timestamp: Some(prost_types::Timestamp {
            seconds: 1_700_000_001,
            nanos: 0,
        }),
        trace_id: uuid.into(),
        span_id: 4,
        parent_id: 3,
        data: Some(buck_event::Data::SpanStart(data::SpanStartEvent {
            data: Some(span_start_event::Data::ActionExecution(
                data::ActionExecutionStart {
                    name: Some(data::ActionName {
                        category: "compile".into(),
                        identifier: "a".into(),
                    }),
                    ..Default::default()
                },
            )),
        })),
    };
    let graph = data::BuckEvent {
        timestamp: Some(prost_types::Timestamp {
            seconds: 1_700_000_002,
            nanos: 0,
        }),
        trace_id: uuid.into(),
        span_id: 0,
        parent_id: 0,
        data: Some(buck_event::Data::Instant(data::InstantEvent {
            data: Some(instant_event::Data::BuildGraphInfo(
                data::BuildGraphExecutionInfo {
                    critical_path2: vec![data::CriticalPathEntry2 {
                        span_ids: vec![4],
                        ..Default::default()
                    }],
                    ..Default::default()
                },
            )),
        })),
    };
    append(
        &mut raw,
        &CommandProgress {
            progress: Some(command_progress::Progress::Event(graph)),
        },
    );
    append(
        &mut raw,
        &CommandProgress {
            progress: Some(command_progress::Progress::Event(action)),
        },
    );
    let truncated_at = raw.len();
    // An incomplete final record must not discard completed start records.
    raw.extend_from_slice(&[12, 1, 2]);
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("small_events.pb.zst");
    fs::write(
        &path,
        compress_to_vec(raw.as_slice(), CompressionLevel::Fastest),
    )
    .unwrap();
    let model = decode(&path).unwrap();
    assert!(model.truncated);
    assert_eq!(model.spans.len(), 2);
    assert_eq!(model.spans[0].start, 1_700_000_000_000_000_000);
    let parent = (
        "0123456789abcdef0123456789abcdef".into(),
        "0000000000000001".into(),
    );
    let views = make_views(&model, Some(&parent));
    assert_eq!(views[0].2.len(), 2); // In-band critical path preserves the short action.
    assert_eq!(views[1].2.len(), 2);
    assert_eq!(views[0].1, parent.0);
    assert_ne!(views[0].1, views[1].1);
    assert_eq!(views[0].2[0]["parentSpanId"], parent.1);
    assert_eq!(views[1].2[1]["parentSpanId"], views[1].2[0]["spanId"]);
    assert_eq!(views[0].2[0]["links"][0]["traceId"], views[1].1);
    assert_eq!(
        model.spans[0]
            .attrs
            .iter()
            .find(|a| a["key"] == "buck2.action_count")
            .unwrap()["value"]["intValue"],
        "1"
    );
    assert!(model.spans[1].critical);
    assert_eq!(truncated_at + 3, raw.len());
}

/// Real local `buck2 build` log (be6971d4), byte-scrubbed at equal length
/// (user, host, NIC names). Counts match the `buck2 log show` prototype
/// converter on the same file: 25 spans, 2 actions.
#[test]
fn golden_local_build_log() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/local-build.pb.zst");
    let model = decode(&path).unwrap();
    assert!(!model.truncated);
    assert_eq!(model.unknown_fields, 0);
    assert_eq!(model.uuid, "4b68ac2f-58e1-4846-afb2-eff9358143b6");
    let views = make_views(&model, None);
    let (critical, full) = (&views[0], &views[1]);
    assert_eq!((critical.0, full.0), ("critical", "full"));
    let kinds = |spans: &[Value]| {
        let mut counts = std::collections::BTreeMap::new();
        for span in spans {
            let name = span["name"].as_str().unwrap();
            *counts
                .entry(name.split(' ').next().unwrap().to_string())
                .or_insert(0) += 1;
        }
        counts.into_iter().collect::<Vec<(String, usize)>>()
    };
    let expect = |pairs: &[(&str, usize)]| {
        pairs
            .iter()
            .map(|(k, n)| (k.to_string(), *n))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        kinds(&full.2),
        expect(&[
            ("buck2.action", 2),
            ("buck2.command", 1),
            ("buck2.materialization", 2),
            ("buck2.phase", 11),
            ("buck2.stage", 9),
        ])
    );
    assert_eq!(
        kinds(&critical.2),
        expect(&[
            ("buck2.action", 2),
            ("buck2.command", 1),
            ("buck2.materialization", 1),
            ("buck2.phase", 4),
            ("buck2.stage", 9),
        ])
    );
    // Without a sidecar both views are independent roots; the critical view links to the full one.
    assert_ne!(critical.1, full.1);
    assert!(critical.2[0].get("parentSpanId").is_none());
    assert_eq!(critical.2[0]["links"][0]["traceId"], full.1);
    // Every non-root span in each view has its parent inside the same view.
    for (_, _, spans) in &views {
        let ids: HashSet<_> = spans
            .iter()
            .map(|s| s["spanId"].as_str().unwrap())
            .collect();
        for span in &spans[1..] {
            assert!(
                ids.contains(span["parentSpanId"].as_str().unwrap()),
                "{span}"
            );
        }
    }
    let command_attr = |key: &str| {
        full.2[0]["attributes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["key"] == key)
            .map(|a| a["value"]["intValue"].clone())
    };
    assert_eq!(command_attr("buck2.action_count"), Some(json!("2")));
    assert_eq!(
        command_attr("buck2.critical_path_action_count"),
        Some(json!("2"))
    );
}
