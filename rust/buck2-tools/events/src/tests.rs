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
    // Buck emits BuildGraphInfo after the spans it names.
    append(
        &mut raw,
        &CommandProgress {
            progress: Some(command_progress::Progress::Event(action)),
        },
    );
    append(
        &mut raw,
        &CommandProgress {
            progress: Some(command_progress::Progress::Event(graph)),
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

/// Repeated ends and oversized critical-path id lists must not amplify memory.
#[test]
fn repeated_ends_and_critical_ids_stay_bounded() {
    let mut raw = synthetic_log(1, true); // command span 1, action span 2
    let end = || {
        event(
            2,
            1,
            buck_event::Data::SpanEnd(data::SpanEndEvent {
                data: Some(span_end_event::Data::ActionExecution(
                    data::ActionExecutionEnd::default(),
                )),
                ..Default::default()
            }),
        )
    };
    for _ in 0..1_000 {
        append(&mut raw, &end());
    }
    let graph = |ids: Vec<u64>| {
        event(
            0,
            0,
            buck_event::Data::Instant(data::InstantEvent {
                data: Some(instant_event::Data::BuildGraphInfo(
                    data::BuildGraphExecutionInfo {
                        critical_path2: vec![data::CriticalPathEntry2 {
                            span_ids: ids,
                            ..Default::default()
                        }],
                        ..Default::default()
                    },
                )),
            }),
        )
    };
    // One known id among many unknown ones.
    append(&mut raw, &graph((2..20_002).collect()));
    let compressed = compress_to_vec(raw.as_slice(), CompressionLevel::Fastest);
    let directory = tempfile::tempdir().unwrap();
    let path = write_log(&directory, "amplify_events.pb.zst", &compressed);

    let model = decode(&path).unwrap();
    assert_eq!(model.stop_reason, None);
    let action = &model.spans[1];
    let count = |key: &str| action.attrs.iter().filter(|a| a["key"] == key).count();
    assert_eq!(count("buck2.execution_kind"), 1);
    assert_eq!(count("buck2.cache_hit"), 1);
    assert!(action.critical);

    let capped = decode_with(
        &path,
        Limits {
            critical_ids: 5_000,
            ..Limits::default()
        },
    )
    .unwrap();
    assert_eq!(
        capped.stop_reason.as_deref(),
        Some("limit: critical path ids exceed 5000")
    );
    assert_eq!(capped.spans.len(), 2);
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
    let result = export(
        &otlp_agent(Duration::from_millis(300)),
        &url,
        "traces",
        b"{}",
    );
    assert!(result.is_err());
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    drop(listener);
}

fn serve_otlp_responses(
    replies: Vec<&'static str>,
    expected_route: &'static str,
) -> (String, std::thread::JoinHandle<Vec<Vec<u8>>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1/traces", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let mut bodies = Vec::new();
        for reply in replies {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut end = None;
            let mut length = None;
            loop {
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap();
                assert!(n > 0, "collector request ended early");
                request.extend_from_slice(&buf[..n]);
                if end.is_none() {
                    end = request
                        .windows(4)
                        .position(|part| part == b"\r\n\r\n")
                        .map(|p| p + 4);
                    if let Some(header_end) = end {
                        let header = String::from_utf8_lossy(&request[..header_end]);
                        assert!(
                            header.starts_with(&format!("POST {expected_route} ")),
                            "{header}"
                        );
                        length = header.lines().find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|value| value.parse::<usize>().ok())
                        });
                    }
                }
                if let (Some(header_end), Some(body_len)) = (end, length) {
                    if request.len() >= header_end + body_len {
                        bodies.push(request[header_end..header_end + body_len].to_vec());
                        break;
                    }
                }
            }
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).unwrap();
            stream.flush().unwrap();
        }
        bodies
    });
    (url, server)
}

#[test]
fn partial_success_retains_whole_chunk_and_retry_reuses_exact_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let body = br#"{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"aabb"}]}]}]}"#;
    let path = spool_chunk(dir.path(), "traces", body).unwrap();
    assert_eq!(read_chunk(&path).unwrap(), body);
    let (url, server) = serve_otlp_responses(
        vec![
            r#"{"partialSuccess":{"rejectedSpans":"1","errorMessage":"rate limited"}}"#,
            r#"{"partialSuccess":{"rejectedSpans":1,"errorMessage":"rate limited"}}"#,
            r#"{"partialSuccess":{"rejectedSpans":"0"}}"#,
        ],
        "/v1/traces",
    );
    drain_to_url(
        dir.path(),
        &url,
        Duration::from_secs(2),
        Duration::from_secs(5),
    );
    assert_eq!(
        read_chunk(&path).unwrap(),
        body,
        "partial acceptance cannot acknowledge chunk"
    );
    drain_to_url(
        dir.path(),
        &url,
        Duration::from_secs(2),
        Duration::from_secs(5),
    );
    assert!(!path.exists(), "zero-rejection response acknowledges chunk");
    assert_eq!(
        server.join().unwrap(),
        vec![body.to_vec(), body.to_vec(), body.to_vec()]
    );
}

#[test]
fn malformed_response_retains_original_chunk() {
    let dir = tempfile::tempdir().unwrap();
    let body = b"{}";
    let path = spool_chunk(dir.path(), "traces", body).unwrap();
    let (url, server) = serve_otlp_responses(vec!["not json", "not json"], "/v1/traces");
    drain_to_url(
        dir.path(),
        &url,
        Duration::from_secs(2),
        Duration::from_secs(5),
    );
    assert_eq!(read_chunk(&path).unwrap(), body);
    assert_eq!(server.join().unwrap(), vec![body.to_vec(), body.to_vec()]);
}

#[test]
fn metric_partial_success_retries_whole_chunk_on_metrics_route() {
    let dir = tempfile::tempdir().unwrap();
    let body = br#"{"resourceMetrics":[{"scopeMetrics":[]}]}"#;
    let path = spool_chunk(dir.path(), "metrics", body).unwrap();
    let (url, server) = serve_otlp_responses(
        vec![
            r#"{"partial_success":{"rejected_data_points":"2","error_message":"throttled"}}"#,
            r#"{"partialSuccess":{"rejectedDataPoints":1}}"#,
            r#"{"partialSuccess":{"rejectedDataPoints":"0"}}"#,
        ],
        "/v1/metrics",
    );
    drain_to_url(
        dir.path(),
        &url,
        Duration::from_secs(2),
        Duration::from_secs(5),
    );
    assert_eq!(read_chunk(&path).unwrap(), body);
    drain_to_url(
        dir.path(),
        &url,
        Duration::from_secs(2),
        Duration::from_secs(5),
    );
    assert!(!path.exists());
    assert_eq!(
        server.join().unwrap(),
        vec![body.to_vec(), body.to_vec(), body.to_vec()]
    );
}

#[test]
fn bounded_metrics_use_real_timing_and_closed_dimensions() {
    let dir = tempfile::tempdir().unwrap();
    let log = write_log(
        &dir,
        "metrics_events.pb.zst",
        &compress_to_vec(synthetic_log(2, true).as_slice(), CompressionLevel::Fastest),
    );
    let mut model = decode(&log).unwrap();
    model.critical_ns = Some(2_500_000_000);
    for (index, action) in model
        .spans
        .iter_mut()
        .filter(|span| span.action)
        .enumerate()
    {
        action.execution_ns = Some(1_000_000_000 * (index as u64 + 1));
        action.queue_ns = Some(500_000_000);
        action.cache_hit = index == 1;
        action.attrs.push(attr(
            "buck2.execution_kind",
            if index == 1 { "action_cache" } else { "local" },
        ));
        action.name = format!("buck2.action private-target-{index}");
    }
    let payload = metric_payload(&model);
    let value: Value = serde_json::from_slice(&payload).unwrap();
    let resource = &value["resourceMetrics"][0]["resource"]["attributes"];
    assert_eq!(
        resource,
        &json!([attr("service.name", "effect-utils-buck2")])
    );
    let metrics = value["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]
        .as_array()
        .unwrap();
    assert_eq!(
        metrics
            .iter()
            .map(|metric| metric["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "buck2.command.duration",
            "buck2.critical_path.duration",
            "buck2.action.count",
            "buck2.action.execution.duration",
            "buck2.action.queue.duration",
        ]
    );
    assert_eq!(metrics[1]["histogram"]["dataPoints"][0]["sum"], json!(2.5));
    assert_eq!(metrics[2]["sum"]["dataPoints"].as_array().unwrap().len(), 2);
    assert_eq!(metrics[3]["histogram"]["dataPoints"][0]["count"], "2");
    assert_eq!(metrics[3]["histogram"]["dataPoints"][0]["sum"], json!(3.0));
    assert_eq!(metrics[4]["histogram"]["dataPoints"][0]["sum"], json!(1.0));
    assert!(!String::from_utf8(payload)
        .unwrap()
        .contains("private-target"));
}

#[test]
fn serialized_chunks_include_resource_overhead_and_never_exceed_limit() {
    let resource = json!({"attributes":[attr("large", "x".repeat(100_000))]});
    let spans = (0..50)
        .map(|n| json!({"name":format!("{n}-{}", "x".repeat(70_000))}))
        .collect::<Vec<_>>();
    let batches = chunks(&spans, &resource).unwrap();
    assert!(batches.len() > 1);
    assert!(batches.iter().all(|chunk| chunk.len() <= MAX_OTLP_BODY));
    let count: usize = batches
        .iter()
        .map(|chunk| {
            let value: Value = serde_json::from_slice(chunk).unwrap();
            value["resourceSpans"][0]["scopeSpans"][0]["spans"]
                .as_array()
                .unwrap()
                .len()
        })
        .sum();
    assert_eq!(count, spans.len());
    assert!(chunks(&[json!({"name":"x".repeat(MAX_OTLP_BODY)})], &json!({})).is_err());
}

#[test]
fn ingest_spools_even_without_endpoint_and_preserves_out_dump() {
    let dir = tempfile::tempdir().unwrap();
    let log = write_log(
        &dir,
        "spooled_events.pb.zst",
        &compress_to_vec(synthetic_log(1, true).as_slice(), CompressionLevel::Fastest),
    );
    let spool = dir.path().join("pending");
    let out = dir.path().join("dump");
    ingest(&[log], None, Some(&out), &spool).unwrap();
    let pending: Vec<_> = fs::read_dir(&spool)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert!(pending
        .iter()
        .any(|p| p.to_string_lossy().ends_with(".metrics.chunk")));
    assert!(pending
        .iter()
        .any(|p| p.to_string_lossy().ends_with(".traces.chunk")));
    for path in &pending {
        let body = read_chunk(path).unwrap();
        let parsed: Value = serde_json::from_slice(&body).unwrap();
        assert!(parsed["resourceSpans"].is_array() || parsed["resourceMetrics"].is_array());
    }
    assert_eq!(fs::read_dir(&out).unwrap().count(), pending.len());
}

fn ingest_reports_spool_failure(signal: &str) {
    let dir = tempfile::tempdir().unwrap();
    let log = write_log(
        &dir,
        "failed_spool_events.pb.zst",
        &compress_to_vec(synthetic_log(1, true).as_slice(), CompressionLevel::Fastest),
    );
    let spool = dir.path().join("pending");
    ingest(std::slice::from_ref(&log), None, None, &spool).unwrap();
    let target = fs::read_dir(&spool)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.to_string_lossy()
                .ends_with(&format!(".{signal}.chunk"))
        })
        .unwrap();
    fs::remove_file(&target).unwrap();
    fs::create_dir(&target).unwrap();

    let result = run(Cli {
        command: Command::Ingest {
            logs: vec![log.clone()],
            sidecar: None,
            out: None,
            spool_dir: Some(spool),
        },
    });
    let error = result.expect_err("an unspooled chunk must fail ingest");
    let kind = if signal == "traces" {
        "trace"
    } else {
        "metrics"
    };
    assert!(
        error.to_string().contains(&format!("OTLP {kind} chunk")),
        "{error}"
    );
    assert!(log.is_file(), "the native log must remain for retry");
}

#[test]
fn ingest_fails_when_trace_chunk_cannot_be_spooled() {
    ingest_reports_spool_failure("traces");
}

#[test]
fn ingest_fails_when_metric_chunk_cannot_be_spooled() {
    ingest_reports_spool_failure("metrics");
}

#[test]
fn pipeline_identity_attributes_distinguish_absent_and_forked_runs() {
    let vars = HashMap::from([
        ("PIPELINE_RUN_ID", "ci/github/owner%2Frepo/42/2"),
        ("PIPELINE_FORK", "true"),
        ("VCS_CHANGE_ID", "123"),
        ("VCS_REF_HEAD_REVISION", "head"),
        ("VCS_REF_BASE_REVISION", "base"),
        ("BUCK2_VCS_MERGE_REVISION", "merge"),
    ]);
    let attrs = identity_attributes(|name| vars.get(name).map(ToString::to_string));
    assert_eq!(
        attrs,
        vec![
            attr("cicd.pipeline.run.id", "ci/github/owner%2Frepo/42/2"),
            attr("vcs.provider.name", "github"),
            bool_attr("buck2.vcs.change.is_fork", true),
            attr("vcs.change.id", "123"),
            attr("vcs.ref.head.revision", "head"),
            attr("vcs.ref.base.revision", "base"),
            attr("buck2.vcs.merge.revision", "merge"),
        ]
    );
    assert!(identity_attributes(|_| None).is_empty());
}

#[test]
fn export_admission_allows_local_harness_and_denies_untrusted_ci() {
    assert!(export_allowed(false, Some("local/123"), None, None));
    assert!(export_allowed(false, None, None, None));
    assert!(!export_allowed(true, None, Some("upload"), None));
    assert!(!export_allowed(
        false,
        Some("ci/github/repo/1/1"),
        Some("spool"),
        Some("true")
    ));
    assert!(!export_allowed(true, None, Some("upload"), Some("false")));
    assert!(export_allowed(true, None, Some("upload"), Some("true")));
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
