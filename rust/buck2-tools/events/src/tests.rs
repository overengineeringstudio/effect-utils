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
    fs::write(&path, compress_to_vec(raw.as_slice(), CompressionLevel::Fastest)).unwrap();
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
    assert_eq!(model.spans[1].critical, true);
    assert_eq!(truncated_at + 3, raw.len());
}
