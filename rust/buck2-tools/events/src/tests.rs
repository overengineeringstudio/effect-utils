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
    // The full view is its own root and links back to the caller command span.
    assert!(views[1].2[0].get("parentSpanId").is_none());
    assert_eq!(views[1].2[0]["links"][0]["traceId"], parent.0);
    assert_eq!(views[1].2[0]["links"][0]["spanId"], parent.1);
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

fn event(span_id: u64, parent_id: u64, data: buck_event::Data) -> CommandProgress {
    CommandProgress {
        progress: Some(command_progress::Progress::Event(data::BuckEvent {
            timestamp: Some(prost_types::Timestamp {
                seconds: 1_700_000_000,
                nanos: 0,
            }),
            trace_id: "10203040-5060-7080-90a0-b0c0d0e0f000".into(),
            span_id,
            parent_id,
            data: Some(data),
        })),
    }
}

/// Header, one command span, then `actions` action spans. With `distinct`
/// false every action record is byte-identical, which compresses extremely.
fn synthetic_log(actions: u64, distinct: bool) -> Vec<u8> {
    let mut raw = Vec::new();
    append(&mut raw, &data::Invocation::default());
    append(
        &mut raw,
        &event(
            1,
            0,
            buck_event::Data::SpanStart(data::SpanStartEvent {
                data: Some(span_start_event::Data::Command(
                    data::CommandStart::default(),
                )),
            }),
        ),
    );
    for index in 0..actions {
        let id = if distinct { index + 2 } else { 2 };
        append(
            &mut raw,
            &event(
                id,
                1,
                buck_event::Data::SpanStart(data::SpanStartEvent {
                    data: Some(span_start_event::Data::ActionExecution(
                        data::ActionExecutionStart {
                            name: Some(data::ActionName {
                                category: "compile".into(),
                                identifier: format!("unit-{id}"),
                            }),
                            ..Default::default()
                        },
                    )),
                }),
            ),
        );
    }
    raw
}

fn write_log(directory: &tempfile::TempDir, name: &str, compressed: &[u8]) -> PathBuf {
    let path = directory.path().join(name);
    fs::write(&path, compressed).unwrap();
    path
}

/// A log cut mid-block (crashed or still-running Buck) keeps its decoded
/// prefix instead of losing the decoder's retained window.
#[test]
fn frame_cut_mid_block_keeps_prefix() {
    let actions = 20_000;
    let raw = synthetic_log(actions, true);
    assert!(raw.len() > 4 * ZSTD_MAX_BLOCK, "needs several zstd blocks");
    let compressed = compress_to_vec(raw.as_slice(), CompressionLevel::Fastest);
    let directory = tempfile::tempdir().unwrap();
    let path = write_log(
        &directory,
        "cut_events.pb.zst",
        &compressed[..compressed.len() * 6 / 10],
    );
    let model = decode(&path).unwrap();
    assert!(model.truncated);
    assert_eq!(model.stop_reason, None);
    let spans = model.spans.len() as u64;
    assert!(spans > actions / 3 && spans < actions, "kept {spans} spans");
}

#[test]
fn zstd_bomb_stops_at_limits() {
    let raw = synthetic_log(100_000, false);
    let compressed = compress_to_vec(raw.as_slice(), CompressionLevel::Fastest);
    assert!(
        compressed.len() * 100 < raw.len(),
        "input is a compression bomb"
    );
    let directory = tempfile::tempdir().unwrap();
    let path = write_log(&directory, "bomb_events.pb.zst", &compressed);
    let bounded = |limits: Limits| decode_with(&path, limits).unwrap();

    let spans = bounded(Limits {
        spans: 1_000,
        ..Limits::default()
    });
    assert_eq!(spans.spans.len(), 1_000);
    assert_eq!(
        spans.stop_reason.as_deref(),
        Some("limit: spans exceed 1000")
    );

    let bytes = bounded(Limits {
        decompressed_bytes: 1 << 20,
        ..Limits::default()
    });
    assert_eq!(
        bytes.stop_reason.as_deref(),
        Some("limit: decompressed bytes exceed 1048576")
    );
    assert!(!bytes.truncated);
    assert!(!bytes.spans.is_empty() && (bytes.spans.len() as u64) < 100_000);

    let records = bounded(Limits {
        records: 500,
        ..Limits::default()
    });
    assert_eq!(
        records.stop_reason.as_deref(),
        Some("limit: records exceed 500")
    );
    assert_eq!(records.spans.len(), 499);

    // Stop reasons are visible on both view roots.
    for (_, _, spans) in make_views(&records, None) {
        assert!(spans[0]["attributes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["key"] == "buck2.ingest.stop_reason"));
    }
}

#[test]
fn damaged_framing_is_corrupt_not_truncated() {
    // Frame header (no single segment, window byte) then a reserved block type.
    let bytes = [&ZSTD_MAGIC[..], &[0x00, 0x50, 0b110, 0, 0]].concat();
    let (sealed, reason) = seal_frame(bytes).unwrap();
    assert!(reason
        .unwrap()
        .starts_with("corrupt: invalid zstd block header"));
    assert_eq!(&sealed[sealed.len() - 3..], &[1, 0, 0]);

    let raw = synthetic_log(20_000, true);
    let mut compressed = compress_to_vec(raw.as_slice(), CompressionLevel::Fastest);
    let middle = compressed.len() / 2;
    for byte in &mut compressed[middle..middle + 64] {
        *byte ^= 0xa5;
    }
    let directory = tempfile::tempdir().unwrap();
    let path = write_log(&directory, "corrupt_events.pb.zst", &compressed);
    match decode(&path) {
        Err(_) => {}
        Ok(model) => {
            assert!(!model.truncated);
            assert!(model.stop_reason.unwrap().starts_with("corrupt"));
        }
    }
}

/// A collector that accepts the connection but never answers must not hold
/// the calling task beyond the request timeout.
#[test]
fn export_times_out_on_silent_collector() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1/traces", listener.local_addr().unwrap());
    let started = Instant::now();
    let result = export(&otlp_agent(Duration::from_millis(300)), &url, b"{}");
    assert!(result.is_err());
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    drop(listener);
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
    // Each kept parent counts its omitted direct children, derived here from the full view.
    let kept: HashSet<_> = critical.2.iter().map(|s| s["spanId"].clone()).collect();
    let mut expected = std::collections::BTreeMap::new();
    for span in full.2.iter().filter(|s| !kept.contains(&s["spanId"])) {
        if kept.contains(&span["parentSpanId"]) {
            *expected
                .entry(span["parentSpanId"].as_str().unwrap().to_string())
                .or_insert(0u64) += 1;
        }
    }
    let stamped: std::collections::BTreeMap<_, _> = critical
        .2
        .iter()
        .filter_map(|s| {
            let count = s["attributes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["key"] == "buck2.dropped_children")?;
            Some((
                s["spanId"].as_str().unwrap().to_string(),
                count["value"]["intValue"]
                    .as_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap(),
            ))
        })
        .collect();
    assert!(!stamped.is_empty());
    assert_eq!(stamped, expected);
    assert!(full.2.iter().all(|s| s["attributes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|a| a["key"] != "buck2.dropped_children")));
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
