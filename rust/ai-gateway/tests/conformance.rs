use std::{
    collections::{BTreeMap, BTreeSet},
    convert::Infallible,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use parking_lot::Mutex;
use ai_gateway::{ChatBuilder, Client, DecisionSpec, Error, Message, StreamEvent, Tool, ToolCall};
use axum::{
    body::{Body, to_bytes},
    extract::{Request, State},
    http::Response,
    Router,
};
use futures::StreamExt;
use serde_json::{Value, json};
use tokio::{net::TcpListener, task::JoinHandle, time::timeout};

#[derive(Clone)]
struct ReplayState {
    response: Value,
    requests: Arc<Mutex<Vec<Value>>>,
}

struct Replay {
    origin: String,
    requests: Arc<Mutex<Vec<Value>>>,
    task: JoinHandle<()>,
}

impl Drop for Replay {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Replay {
    async fn start(case: &Value) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind replay server");
        let origin = format!("http://{}", listener.local_addr().expect("server address"));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let state = ReplayState { response: case["response"].clone(), requests: requests.clone() };
        let router = Router::new().fallback(replay_request).with_state(state);
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.expect("serve replay requests");
        });
        Self { origin, requests, task }
    }

    fn assert_request(&self, case: &Value) {
        let requests = self.requests.lock();
        // This applies to every case, including HTTP 429/5xx: a response must not
        // cause an SDK retry, a wrapper retry, or a structured-output fallback.
        assert_eq!(requests.len(), 1, "{}: operation must make exactly one HTTP request", case["id"]);
        let actual = &requests[0];
        let expected = &case["request"];
        assert_eq!(actual["method"], expected["method"], "request method");
        assert_eq!(actual["path"], expected["path"], "request path");
        assert_eq!(actual["query"], Value::Null, "unexpected query parameters");
        match string(&expected["auth"]) {
            "bearer" => assert_eq!(actual["authorization"], "Bearer fixture-token"),
            "none" => assert_eq!(actual["authorization"], Value::Null),
            auth => panic!("unsupported fixture auth: {auth}"),
        }
        if let Some(matches) = expected["match"].as_object() {
            for (key, expected_value) in matches {
                let body = &actual["body"];
                match key.as_str() {
                    "model" | "stream" => assert_eq!(&body[key], expected_value, "request match {key}"),
                    "responseFormat" => assert_eq!(&body["response_format"]["type"], expected_value, "response format"),
                    "hasToolResult" => {
                        let present = body["messages"].as_array().expect("messages array")
                            .iter().any(|message| message["role"] == "tool");
                        assert_eq!(Value::Bool(present), *expected_value, "tool result presence");
                    }
                    unsupported => panic!("unsupported request match: {unsupported}"),
                }
            }
        }
        if let Some(body) = expected.get("body") {
            assert_subset(&actual["body"], body, "request.body");
        }
        if let Some(original) = case.get("schema") {
            let provider = &actual["body"]["response_format"]["json_schema"];
            assert_eq!(provider["strict"], true, "structured strictness");
            assert!(!string(&provider["name"]).is_empty(), "structured schema name");
            // These corpus schemas are already strict objects; their bounds and
            // property types must survive projection, not just the format tag.
            assert_subset(&provider["schema"], original, "request schema projection");
        }
    }
}

async fn replay_request(State(state): State<ReplayState>, request: Request) -> Response<Body> {
    let method = request.method().as_str().to_owned();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().map(str::to_owned);
    let authorization = request.headers().get("authorization")
        .map(|value| value.to_str().expect("ASCII authorization").to_owned());
    let bytes = to_bytes(request.into_body(), 1024 * 1024).await.expect("read request body");
    let body = if bytes.is_empty() { Value::Null } else {
        serde_json::from_slice(&bytes).expect("JSON request body")
    };
    state.requests.lock().push(json!({
        "method": method, "path": path, "query": query,
        "authorization": authorization, "body": body,
    }));
    let response = &state.response;
    let mut builder = Response::builder().status(
        u16::try_from(response["status"].as_u64().expect("response status")).expect("HTTP status fits u16"),
    );
    if let Some(headers) = response["headers"].as_object() {
        for (name, value) in headers {
            builder = builder.header(name, string(value));
        }
    }
    let body = if let Some(events) = response["sse"].as_array() {
        builder = builder.header("content-type", "text/event-stream");
        let mut wire = String::new();
        for event in events {
            wire.push_str("data: ");
            if event == "[DONE]" {
                wire.push_str("[DONE]");
            } else {
                wire.push_str(&serde_json::to_string(event).expect("encode SSE event"));
            }
            wire.push_str("\n\n");
        }
        // Transport chunks intentionally cut across data prefixes, JSON tokens,
        // and event boundaries. SSE entries themselves retain fixture order.
        let chunks: Vec<Result<Vec<u8>, Infallible>> = wire.as_bytes().chunks(7)
            .map(|chunk| Ok(chunk.to_vec())).collect();
        Body::from_stream(futures::stream::iter(chunks))
    } else {
        builder = builder.header("content-type", "application/json");
        Body::from(serde_json::to_string(response.get("json").expect("JSON response or SSE"))
            .expect("encode response JSON"))
    };
    builder.body(body).expect("build fixture response")
}

fn string(value: &Value) -> &str {
    value.as_str().expect("fixture string")
}

fn text_content(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    value.as_array().expect("string or text-part content").iter().map(|part| {
        assert_eq!(part["type"], "text", "unsupported fixture content part");
        string(&part["text"])
    }).collect()
}

fn assert_subset(actual: &Value, expected: &Value, path: &str) {
    if path.ends_with(".content") && (actual.is_array() || expected.is_array()) {
        assert_eq!(text_content(actual), text_content(expected), "{path}: text content");
        return;
    }
    if path.ends_with(".required") {
        let actual: BTreeSet<_> = actual.as_array().expect("required array").iter().map(string).collect();
        let expected: BTreeSet<_> = expected.as_array().expect("required array").iter().map(string).collect();
        assert!(expected.is_subset(&actual), "{path}: required property set");
        return;
    }
    match expected {
        Value::Object(properties) => {
            let actual = actual.as_object().unwrap_or_else(|| panic!("{path}: expected object, got {actual}"));
            for (key, value) in properties {
                let actual = actual.get(key).unwrap_or_else(|| panic!("{path}.{key}: missing field"));
                assert_subset(actual, value, &format!("{path}.{key}"));
            }
        }
        Value::Array(items) => {
            let actual = actual.as_array().unwrap_or_else(|| panic!("{path}: expected array, got {actual}"));
            assert_eq!(actual.len(), items.len(), "{path}: array length");
            for (index, (actual, expected)) in actual.iter().zip(items).enumerate() {
                assert_subset(actual, expected, &format!("{path}[{index}]"));
            }
        }
        Value::Number(number) if number.is_f64() || actual.as_number().is_some_and(serde_json::Number::is_f64) => {
            assert_eq!(actual.as_f64(), expected.as_f64(), "{path}: JSON numeric value");
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}

fn fixture_files(directory: &Path, files: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(directory).expect("read conformance corpus") {
        let path = entry.expect("corpus directory entry").path();
        if path.is_dir() {
            fixture_files(&path, files);
        } else if path.extension().is_some_and(|extension| extension == "json") {
            files.push(path);
        }
    }
}

fn load_cases() -> Vec<Value> {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/@overeng/ai-gateway-conformance/cases");
    let mut files = Vec::new();
    fixture_files(&directory, &mut files);
    files.sort();
    assert!(!files.is_empty(), "conformance corpus must not be empty");
    let mut ids = BTreeSet::new();
    files.into_iter().map(|path| {
        let bytes = std::fs::read(&path).expect("read fixture JSON");
        let case: Value = serde_json::from_slice(&bytes).expect("decode fixture JSON");
        let id = string(&case["id"]);
        assert!(ids.insert(id.to_owned()), "duplicate case id: {id}");
        assert_eq!(path.file_stem().and_then(|stem| stem.to_str()), Some(id), "fixture filename/id");
        for key in case.as_object().expect("case object").keys() {
            assert!(matches!(key.as_str(), "id" | "summary" | "requirements" | "request" | "response" | "expect" | "schema"), "unsupported fixture field: {key}");
        }
        case
    }).collect()
}

fn hydrate_message(message: &Value) -> Message {
    match string(&message["role"]) {
        "system" => Message::System { content: string(&message["content"]).to_owned() },
        "user" => Message::User {
            // tools.result intentionally specifies only the role. A user string
            // is valid; the subset matcher also accepts text-part wire content.
            content: message.get("content").map(text_content)
                .unwrap_or_else(|| "What is the weather in Berlin?".to_owned()),
        },
        "assistant" => Message::Assistant {
            content: message["content"].as_str().map(str::to_owned),
            tool_calls: message["tool_calls"].as_array().map(|calls| calls.iter().map(|call| ToolCall {
                id: string(&call["id"]).to_owned(),
                name: string(&call["function"]["name"]).to_owned(),
                arguments: string(&call["function"]["arguments"]).to_owned(),
            }).collect()).unwrap_or_default(),
        },
        "tool" => Message::Tool {
            tool_call_id: string(&message["tool_call_id"]).to_owned(),
            content: string(&message["content"]).to_owned(),
        },
        role => panic!("unsupported fixture message role: {role}"),
    }
}

fn chat<'a>(client: &'a Client, case: &Value) -> ChatBuilder<'a> {
    let mut builder = client.chat(string(&case["request"]["match"]["model"]));
    let body = &case["request"]["body"];
    if let Some(messages) = body["messages"].as_array() {
        for message in messages {
            builder = builder.message(hydrate_message(message));
        }
    } else {
        builder = builder.user("Respond to this public conformance fixture.");
    }
    if let Some(tools) = body["tools"].as_array() {
        builder = builder.tools(tools.iter().map(|tool| {
            assert_eq!(tool["type"], "function", "unsupported tool kind");
            let function = &tool["function"];
            Tool {
                name: string(&function["name"]).to_owned(),
                description: function["description"].as_str().map(str::to_owned),
                parameters: function["parameters"].clone(),
                strict: function["strict"].as_bool(),
            }
        }).collect());
    }
    builder
}

fn normalized_calls(calls: &[ToolCall]) -> Value {
    Value::Array(calls.iter().map(|call| json!({
        "id": call.id, "name": call.name,
        "arguments": serde_json::from_str::<Value>(&call.arguments).expect("assembled tool arguments must be JSON"),
    })).collect())
}

async fn operate(client: &Client, case: &Value) -> ai_gateway::Result<Value> {
    match string(&case["request"]["path"]) {
        "/v1/models" => {
            let models = client.models().await?;
            Ok(json!({ "object": { "object": "list", "data": models } }))
        }
        "/v1/systemone" => {
            let body = &case["request"]["body"];
            let spec: DecisionSpec = serde_json::from_value(json!({
                "model": body["model"], "questions": body["questions"],
            })).expect("decode fixture decision specification");
            let response = client.decide(spec, body["state"].clone()).await?;
            Ok(json!({ "decision": response.answers, "usage": response.usage }))
        }
        "/v1/chat/completions" => {
            let builder = chat(client, case);
            if let Some(schema) = case.get("schema") {
                let response = builder.structured_with_schema(schema.clone()).await?;
                return Ok(json!({ "object": response.value, "usage": response.usage, "finishReason": response.finish_reason }));
            }
            if case["request"]["match"]["stream"] == true {
                let mut stream = builder.stream().await?;
                let mut text = String::new();
                let mut calls: BTreeMap<u32, ToolCall> = BTreeMap::new();
                let mut usage = None;
                let mut done = 0;
                while let Some(event) = stream.next().await {
                    match event {
                        Ok(StreamEvent::Delta { text: delta }) => {
                            assert_eq!(done, 0, "text after Done");
                            text.push_str(&delta);
                        }
                        Ok(StreamEvent::ToolCallDelta { index, id, name, arguments }) => {
                            assert_eq!(done, 0, "tool delta after Done");
                            let call = calls.entry(index).or_insert_with(|| ToolCall {
                                id: String::new(), name: String::new(), arguments: String::new(),
                            });
                            if let Some(id) = id { call.id.push_str(&id); }
                            if let Some(name) = name { call.name.push_str(&name); }
                            call.arguments.push_str(&arguments);
                        }
                        Ok(StreamEvent::Done { usage: final_usage }) => {
                            done += 1;
                            usage = final_usage;
                        }
                        Err(error) => {
                            assert_eq!(done, 0, "failed stream must not emit Done");
                            let expected_prefix: String = case["response"]["sse"].as_array().expect("SSE array")
                                .iter().flat_map(|event| event["choices"].as_array().into_iter().flatten())
                                .filter_map(|choice| choice["delta"]["content"].as_str()).collect();
                            assert_eq!(text, expected_prefix, "retain text before stream failure");
                            assert!(stream.next().await.is_none(), "stream error must be terminal");
                            return Err(error);
                        }
                    }
                }
                assert_eq!(done, 1, "successful stream must emit exactly one Done");
                assert!(stream.next().await.is_none(), "completed stream stays exhausted");
                let calls: Vec<_> = calls.into_values().collect();
                return Ok(json!({ "text": text, "toolCalls": normalized_calls(&calls), "usage": usage }));
            }
            let response = builder.send().await?;
            Ok(json!({ "text": response.text, "toolCalls": normalized_calls(&response.tool_calls),
                "usage": response.usage, "finishReason": response.finish_reason }))
        }
        path => panic!("unsupported conformance operation: {path}"),
    }
}

fn assert_outcome(case: &Value, result: ai_gateway::Result<Value>) {
    let expected = &case["expect"];
    if expected["outcome"] != "success" {
        for key in expected.as_object().expect("expect object").keys() {
            assert!(matches!(key.as_str(), "outcome" | "error" | "usage"), "unsupported failure expectation: {key}");
        }
    }
    match string(&expected["outcome"]) {
        "success" => {
            let actual = result.unwrap_or_else(|error| panic!("{}: expected success, got {error:?}", case["id"]));
            for (key, value) in expected.as_object().expect("expect object") {
                match key.as_str() {
                    "outcome" => {}
                    "text" | "object" | "toolCalls" | "decision" => {
                        let path = format!("{}: expect.{key}", case["id"]);
                        assert_subset(&actual[key], value, &path);
                        assert_subset(value, &actual[key], &path);
                    }
                    "usage" => assert_subset(&actual["usage"], value, "expect.usage"),
                    unsupported => panic!("unsupported success expectation: {unsupported}"),
                }
            }
            if let Some(reason) = case["response"]["json"]["choices"][0]["finish_reason"].as_str() {
                assert_eq!(actual["finishReason"], reason, "chat finish reason");
            }
        }
        "http-error" => {
            let error = result.expect_err("expected HTTP refusal");
            let Error::Http { status, r#type, message, raw_body, retry_after } = error else {
                panic!("expected HTTP error, got {error:?}");
            };
            let wire = &case["response"]["json"];
            assert_eq!(u64::from(status), case["response"]["status"].as_u64().expect("status"));
            assert_eq!(raw_body, serde_json::to_string(wire).expect("wire body"), "retain exact unsuccessful body");
            assert_eq!(message, string(&wire["error"]["message"]));
            assert_eq!(r#type.as_deref(), wire["error"]["type"].as_str());
            assert_eq!(retry_after.as_deref(), case["response"]["headers"]["retry-after"].as_str());
            if let Some(error) = expected.get("error") {
                assert_subset(&json!({ "status": status, "type": r#type, "message": message,
                    "raw": raw_body, "retryAfter": retry_after }), error, "expect.error");
            }
        }
        "stream-error" => {
            let error = result.expect_err("expected stream failure");
            let Error::Stream { message, raw_body } = error else {
                panic!("expected stream error, got {error:?}");
            };
            assert!(!message.is_empty(), "stream error diagnosis");
            let envelope = case["response"]["sse"].as_array().expect("SSE array")
                .iter().find(|event| event.get("error").is_some());
            if let Some(envelope) = envelope {
                let raw = raw_body.expect("retain stream error envelope");
                assert_eq!(raw, serde_json::to_string(envelope).expect("stream error JSON"));
                assert!(message.contains(string(&envelope["error"]["message"])), "retain stream error message");
                if let Some(error) = expected.get("error") {
                    assert_subset(&envelope["error"], error, "expect.error");
                }
            } else {
                assert!(expected.get("error").is_none(), "unobservable EOF error expectation");
            }
        }
        "validation-error" => {
            let error = result.expect_err("expected local validation failure");
            let Error::Validation { errors, usage } = error else {
                panic!("expected validation error, got {error:?}");
            };
            assert!(!errors.is_empty(), "validation errors must explain the rejection");
            assert!(errors.iter().all(|error| !error.is_empty()), "empty validation diagnosis");
            if let Some(expected_usage) = expected.get("usage") {
                assert_subset(&json!(usage), expected_usage, "expect.usage");
            }
            assert!(expected.get("error").is_none(), "unsupported validation error expectation");
        }
        outcome => panic!("unsupported conformance outcome: {outcome}"),
    }
}

async fn run_case(case: &Value) {
    eprintln!("conformance: {}", string(&case["id"]));
    let replay = Replay::start(case).await;
    let mut builder = Client::builder(&replay.origin);
    match string(&case["request"]["auth"]) {
        "bearer" => builder = builder.token("fixture-token"),
        "none" => {}
        auth => panic!("unsupported auth: {auth}"),
    }
    let client = builder.build().expect("build fixture client");
    let result = timeout(Duration::from_secs(5), operate(&client, case)).await
        .unwrap_or_else(|_| panic!("{}: operation timed out", case["id"]));
    replay.assert_request(case);
    assert_outcome(case, result);
}

#[tokio::test]
async fn every_shared_json_case() {
    for case in load_cases() {
        run_case(&case).await;
    }
}

#[tokio::test]
async fn structured_invalid_retains_billed_usage() {
    let case = load_cases().into_iter().find(|case| case["id"] == "structured.invalid").unwrap();
    let replay = Replay::start(&case).await;
    let client = Client::builder(&replay.origin).token("fixture-token").build().unwrap();
    let error = operate(&client, &case).await.unwrap_err();
    let Error::Validation { usage: Some(usage), .. } = error else { panic!("missing billed usage: {error:?}"); };
    let wire = &case["response"]["json"]["usage"];
    assert_eq!(usage.input, wire["prompt_tokens"].as_u64());
    assert_eq!(usage.output, wire["completion_tokens"].as_u64());
    assert_eq!(usage.total, wire["total_tokens"].as_u64());
    assert_eq!(usage.cached, wire["prompt_tokens_details"]["cached_tokens"].as_u64());
    replay.assert_request(&case);
}

#[tokio::test]
async fn decision_invalid_label_retains_billed_usage() {
    let case = load_cases().into_iter().find(|case| case["id"] == "decision.invalid-label").unwrap();
    let replay = Replay::start(&case).await;
    let client = Client::builder(&replay.origin).build().unwrap();
    let error = operate(&client, &case).await.unwrap_err();
    let Error::Validation { usage: Some(usage), .. } = error else { panic!("missing billed usage: {error:?}"); };
    let wire = &case["response"]["json"]["usage"];
    assert_eq!(usage.input, wire["input_tokens"].as_u64());
    assert_eq!(usage.output, wire["output_tokens"].as_u64());
    assert_eq!(usage.total, wire["total_tokens"].as_u64());
    replay.assert_request(&case);
}

#[tokio::test]
async fn stream_eof_without_done_is_an_error() {
    let mut case = load_cases().into_iter().find(|case| case["id"] == "chat.stream.usage")
        .expect("stream usage fixture");
    case["id"] = json!("rust.stream.eof-without-done");
    let events = case["response"]["sse"].as_array_mut().expect("SSE array");
    assert_eq!(events.pop(), Some(json!("[DONE]")));
    case["expect"] = json!({ "outcome": "stream-error" });
    run_case(&case).await;
}

#[tokio::test]
async fn streamed_tool_arguments_are_reconstructed_in_order() {
    let chunk = |delta: Value, reason: Value| json!({
        "id": "chatcmpl-tools", "object": "chat.completion.chunk", "created": 1750000000,
        "model": "fixture/tool", "choices": [{ "index": 0, "delta": delta, "finish_reason": reason }],
    });
    let case = json!({
        "id": "rust.tools.stream-fragments",
        "request": { "method": "POST", "path": "/v1/chat/completions", "auth": "bearer",
            "match": { "model": "fixture/tool", "stream": true } },
        "response": { "status": 200, "sse": [
            chunk(json!({ "tool_calls": [{ "index": 0, "id": "call_1", "type": "function",
                "function": { "name": "get_weather", "arguments": "{\"city\":" } }] }), Value::Null),
            chunk(json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "\"Berlin\"}" } }] }), Value::Null),
            chunk(json!({}), json!("tool_calls")), "[DONE]",
        ] },
        "expect": { "outcome": "success", "text": "", "toolCalls": [
            { "id": "call_1", "name": "get_weather", "arguments": { "city": "Berlin" } },
        ] },
    });
    run_case(&case).await;
}
