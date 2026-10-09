use std::sync::Arc;

use ai_gateway::{Client, Error, Tool};
use axum::{extract::State, Json, Router};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::{net::TcpListener, task::JoinHandle};

#[derive(Clone, Default)]
struct StateData { requests: Arc<Mutex<Vec<Value>>> }
struct Server { origin: String, state: StateData, task: JoinHandle<()> }
impl Drop for Server { fn drop(&mut self) { self.task.abort(); } }

async fn exchange(State(state): State<StateData>, Json(request): Json<Value>) -> Json<Value> {
    let mut requests = state.requests.lock();
    requests.push(request);
    let message = if requests.len() == 1 {
        json!({"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\"key\":\"hello\"}"}}]})
    } else { json!({"role":"assistant","content":"world"}) };
    Json(json!({"id":"tools-id","object":"chat.completion","created":1,"model":"fixture/tools",
        "choices":[{"index":0,"message":message,"finish_reason":if requests.len()==1 {"tool_calls"} else {"stop"}}]}))
}

impl Server {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let state = StateData::default();
        let router = Router::new().fallback(exchange).with_state(state.clone());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
        Self { origin, state, task }
    }
}

fn tool() -> Tool {
    Tool { name: "lookup".into(), description: None,
        parameters: json!({"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}), strict: None }
}

#[tokio::test]
async fn tools_append_correlated_results_and_return_final_response() {
    let server = Server::start().await;
    let client = Client::builder(&server.origin).build().unwrap();
    let mut calls = Vec::new();
    let response = client.chat("fixture/tools").user("hello").tools(vec![tool()])
        .run_tools(2, |call| { calls.push(call); async { Ok("world".into()) } }).await.unwrap();
    assert_eq!(response.text, "world");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "call_1");
    let requests = server.state.requests.lock();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1]["messages"][1]["tool_calls"][0]["id"], "call_1");
    assert_eq!(requests[1]["messages"][2], json!({"role":"tool","tool_call_id":"call_1","content":"world"}));
}

#[tokio::test]
async fn exhausted_bound_does_not_execute_an_uncontinuable_tool() {
    let server = Server::start().await;
    let client = Client::builder(&server.origin).build().unwrap();
    let mut executed = false;
    let result = client.chat("fixture/tools").user("hello").tools(vec![tool()])
        .run_tools(1, |_| { executed = true; async { Ok("world".into()) } }).await;
    assert!(matches!(result, Err(Error::Validation { .. })));
    assert!(!executed);
    assert_eq!(server.state.requests.lock().len(), 1);
}

#[tokio::test]
async fn undeclared_tools_fail_before_consumer_side_effects() {
    let server = Server::start().await;
    let client = Client::builder(&server.origin).build().unwrap();
    let mut executed = false;
    let result = client.chat("fixture/tools").user("hello")
        .run_tools(2, |_| { executed = true; async { Ok("world".into()) } }).await;
    assert!(matches!(result, Err(Error::Validation { .. })));
    assert!(!executed);
    assert_eq!(server.state.requests.lock().len(), 1);
}
