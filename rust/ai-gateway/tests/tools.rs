use std::sync::Arc;

use ai_gateway::{Client, Error, Tool, Usage};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json, Router,
};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::{net::TcpListener, task::JoinHandle};

#[derive(Clone, Default)]
struct StateData {
    requests: Arc<Mutex<Vec<Value>>>,
    replies: Arc<Mutex<Vec<(StatusCode, Value)>>>,
}
struct Server {
    origin: String,
    state: StateData,
    task: JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn exchange(State(state): State<StateData>, Json(request): Json<Value>) -> Response {
    let mut requests = state.requests.lock();
    requests.push(request);
    let mut replies = state.replies.lock();
    if !replies.is_empty() {
        let (status, body) = replies.remove(0);
        return (status, Json(body)).into_response();
    }
    let message = if requests.len() == 1 {
        json!({"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\"key\":\"hello\"}"}}]})
    } else {
        json!({"role":"assistant","content":"world"})
    };
    Json(
        json!({"id":"tools-id","object":"chat.completion","created":1,"model":"fixture/tools",
        "choices":[{"index":0,"message":message,"finish_reason":if requests.len()==1 {"tool_calls"} else {"stop"}}]}),
    ).into_response()
}

impl Server {
    async fn start() -> Self {
        Self::with_replies(Vec::new()).await
    }

    async fn with_replies(replies: Vec<(StatusCode, Value)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let state = StateData {
            replies: Arc::new(Mutex::new(replies)),
            ..StateData::default()
        };
        let router = Router::new().fallback(exchange).with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            origin,
            state,
            task,
        }
    }
}

fn tool() -> Tool {
    Tool {
        name: "lookup".into(),
        description: None,
        parameters: json!({"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}),
        strict: None,
    }
}

#[tokio::test]
async fn tools_append_correlated_results_and_return_final_response() {
    let server = Server::start().await;
    let client = Client::builder(&server.origin).build().unwrap();
    let mut calls = Vec::new();
    let response = client
        .chat("fixture/tools")
        .user("hello")
        .tools(vec![tool()])
        .run_tools(2, |call| {
            calls.push(call);
            async { Ok("world".into()) }
        })
        .await
        .unwrap();
    assert_eq!(response.response.text, "world");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "call_1");
    let requests = server.state.requests.lock();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1]["messages"][1]["tool_calls"][0]["id"], "call_1");
    assert_eq!(
        requests[1]["messages"][2],
        json!({"role":"tool","tool_call_id":"call_1","content":"world"})
    );
}

#[tokio::test]
async fn exhausted_bound_does_not_execute_an_uncontinuable_tool() {
    let server = Server::start().await;
    let client = Client::builder(&server.origin).build().unwrap();
    let mut executed = false;
    let result = client
        .chat("fixture/tools")
        .user("hello")
        .tools(vec![tool()])
        .run_tools(1, |_| {
            executed = true;
            async { Ok("world".into()) }
        })
        .await;
    assert!(matches!(
        result.unwrap_err().error,
        Error::Validation { .. }
    ));
    assert!(!executed);
    assert_eq!(server.state.requests.lock().len(), 1);
}

#[tokio::test]
async fn undeclared_tools_fail_before_consumer_side_effects() {
    let server = Server::start().await;
    let client = Client::builder(&server.origin).build().unwrap();
    let mut executed = false;
    let result = client
        .chat("fixture/tools")
        .user("hello")
        .run_tools(2, |_| {
            executed = true;
            async { Ok("world".into()) }
        })
        .await;
    assert!(matches!(
        result.unwrap_err().error,
        Error::Validation { .. }
    ));
    assert!(!executed);
    assert_eq!(server.state.requests.lock().len(), 1);
}

fn reply(index: u64, calls: bool, usage: bool) -> (StatusCode, Value) {
    let message = if calls {
        json!({"role":"assistant","content":null,"tool_calls":[{"id":format!("call_{index}"),"type":"function","function":{"name":"lookup","arguments":"{\"key\":\"hello\"}"}}]})
    } else {
        json!({"role":"assistant","content":"done"})
    };
    let mut body = json!({"id":"tools-id","object":"chat.completion","created":1,"model":"fixture/tools",
        "choices":[{"index":0,"message":message,"finish_reason":if calls {"tool_calls"} else {"stop"}}]});
    if usage {
        body["usage"] =
            json!({"prompt_tokens":index,"completion_tokens":index * 2,"total_tokens":index * 3});
    }
    (StatusCode::OK, body)
}

fn usage(index: u64) -> Option<Usage> {
    Some(Usage {
        input: Some(index),
        output: Some(index * 2),
        total: Some(index * 3),
        ..Usage::default()
    })
}

#[tokio::test]
async fn three_exchanges_preserve_order_and_sum_only_complete_usage() {
    for missing in [false, true] {
        let server = Server::with_replies(vec![
            reply(1, true, true),
            reply(2, true, !missing),
            reply(3, false, true),
        ])
        .await;
        let run = Client::builder(&server.origin)
            .build()
            .unwrap()
            .chat("fixture/tools")
            .user("hello")
            .tools(vec![tool()])
            .run_tools(3, |_| async { Ok("result".into()) })
            .await
            .unwrap();
        assert_eq!(run.response.text, "done");
        assert_eq!(
            run.exchanges,
            vec![usage(1), if missing { None } else { usage(2) }, usage(3)]
        );
        assert_eq!(run.total, if missing { None } else { usage(6) });
    }
}

#[tokio::test]
async fn failures_retain_all_completed_exchanges() {
    for failure in ["exhaustion", "callback", "http"] {
        let last = if failure == "http" {
            (
                StatusCode::BAD_GATEWAY,
                json!({"error":{"message":"unavailable"}}),
            )
        } else {
            reply(2, true, false)
        };
        let server = Server::with_replies(vec![reply(1, true, true), last]).await;
        let mut calls = 0;
        let error = Client::builder(&server.origin)
            .build()
            .unwrap()
            .chat("fixture/tools")
            .user("hello")
            .tools(vec![tool()])
            .run_tools(if failure == "exhaustion" { 2 } else { 3 }, |_| {
                calls += 1;
                let fail = failure == "callback" && calls == 2;
                async move {
                    if fail {
                        Err(Error::Config {
                            message: "callback rejected".into(),
                        })
                    } else {
                        Ok("result".into())
                    }
                }
            })
            .await
            .unwrap_err();
        if failure == "http" {
            assert!(matches!(error.error, Error::Http { status: 502, .. }));
            assert_eq!(error.exchanges, vec![usage(1)]);
            assert_eq!(error.total, usage(1));
        } else {
            if failure == "callback" {
                assert!(matches!(error.error, Error::Config { .. }));
            } else {
                assert!(matches!(error.error, Error::Validation { .. }));
            }
            assert_eq!(error.exchanges, vec![usage(1), None]);
            assert_eq!(error.total, None);
        }
    }
}

#[tokio::test]
async fn decoded_response_rejections_retain_the_rejected_exchange() {
    for rejection in ["no_choices", "refusal"] {
        for supplied_usage in [false, true] {
            let (status, mut body) = reply(2, false, supplied_usage);
            if rejection == "no_choices" {
                body["choices"] = json!([]);
            } else {
                body["choices"][0]["message"]["refusal"] = json!("request refused");
            }
            let server = Server::with_replies(vec![reply(1, true, true), (status, body)]).await;
            let mut calls = 0;
            let error = Client::builder(&server.origin)
                .build()
                .unwrap()
                .chat("fixture/tools")
                .user("hello")
                .tools(vec![tool()])
                .run_tools(3, |_| {
                    calls += 1;
                    async { Ok("result".into()) }
                })
                .await
                .unwrap_err();
            let rejected_usage = if supplied_usage { usage(2) } else { None };
            assert_eq!(calls, 1);
            assert_eq!(error.exchanges, vec![usage(1), rejected_usage.clone()]);
            assert_eq!(error.total, if supplied_usage { usage(3) } else { None });
            let Error::Validation { usage, .. } = error.error else {
                panic!("decoded response rejection must retain its validation error");
            };
            assert_eq!(usage, rejected_usage);
        }
    }
}
