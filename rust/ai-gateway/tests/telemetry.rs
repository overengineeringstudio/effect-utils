use std::{convert::Infallible, sync::Arc, time::Duration};

use ai_gateway::{Client, Error, StreamEvent};
use axum::{body::Body, response::Response, Router};
use futures::{StreamExt, stream};
use opentelemetry::{trace::{TracerProvider, Status}, Value};
use parking_lot::Mutex;
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider, SpanData};
use serde_json::json;
use tokio::{net::TcpListener, task::JoinHandle};
use tracing::instrument::WithSubscriber;
use tracing_subscriber::prelude::*;

struct Server { origin: String, task: JoinHandle<()> }
impl Drop for Server { fn drop(&mut self) { self.task.abort(); } }
impl Server {
    async fn start(router: Router) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
        Self { origin, task }
    }
}

fn attribute<'a>(span: &'a SpanData, key: &str) -> Option<&'a Value> {
    span.attributes.iter().find(|value| value.key.as_str() == key).map(|value| &value.value)
}

#[tokio::test]
async fn spans_cover_validation_usage_and_cancellation_without_content() {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder().with_simple_exporter(exporter.clone()).build();
    let subscriber = tracing_subscriber::registry().with(tracing_opentelemetry::layer().with_tracer(provider.tracer("ai-gateway-test")));
    let reply = json!({"id":"reply-id","object":"chat.completion","created":1,"model":"fixture/resolved",
        "choices":[{"index":0,"message":{"role":"assistant","content":"{\"age\":-1}"},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}});
    let server = Server::start(Router::new().fallback(move || {
        let reply = reply.clone();
        async move { axum::Json(reply) }
    })).await;
    let schema = json!({"type":"object","properties":{"age":{"type":"integer","minimum":0}},"required":["age"]});
    async {
        let client = Client::builder(&server.origin).token("secret-bearer").build().unwrap();
        assert!(matches!(client.chat("fixture/requested").user("secret-prompt").structured_with_schema(schema).await, Err(Error::Validation { .. })));
    }.with_subscriber(subscriber).await;
    provider.force_flush().unwrap();
    let spans = exporter.get_finished_spans().unwrap();
    let span = spans.iter().find(|span| span.name == "chat fixture/requested").unwrap();
    assert!(matches!(span.status, Status::Error { .. }));
    assert_eq!(attribute(span, "gen_ai.usage.input_tokens"), Some(&Value::I64(8)));
    assert_eq!(attribute(span, "gen_ai.response.model"), Some(&Value::String("fixture/resolved".into())));
    assert_eq!(attribute(span, "error.type"), Some(&Value::String("validation_error".into())));
    assert!(!format!("{spans:?}").contains("secret-bearer"));
    assert!(!format!("{spans:?}").contains("secret-prompt"));

    exporter.reset();
    let subscriber = tracing_subscriber::registry().with(tracing_opentelemetry::layer().with_tracer(provider.tracer("ai-gateway-stream-test")));
    let streaming = Server::start(Router::new().fallback(|| async {
        let chunks = [
            "data: {\"id\":\"stream-id\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture/resolved\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"secret-response\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"stream-id\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture/resolved\",\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":3,\"total_tokens\":12}}\n\ndata: [DONE]\n\n",
        ];
        Response::builder().header("content-type", "text/event-stream")
            .body(Body::from_stream(stream::iter(chunks.into_iter().map(Ok::<_, Infallible>)))).unwrap()
    })).await;
    async {
        let client = Client::builder(&streaming.origin).build().unwrap();
        let mut stream = client.chat("fixture/stream").user("secret-prompt").stream().await.unwrap();
        assert!(exporter.get_finished_spans().unwrap().is_empty(), "HTTP 200 must not finish inference");
        let first = stream.next().await.unwrap().unwrap();
        assert!(matches!(first, StreamEvent::Delta { .. }));
        assert!(exporter.get_finished_spans().unwrap().is_empty(), "span must last through consumption");
        while let Some(event) = stream.next().await { event.unwrap(); }
        let spans = exporter.get_finished_spans().unwrap();
        let span = spans.iter().find(|span| span.name == "chat fixture/stream").unwrap();
        assert_eq!(span.status, Status::Ok);
        assert_eq!(attribute(span, "gen_ai.usage.input_tokens"), Some(&Value::I64(9)));
        assert!(!format!("{spans:?}").contains("secret-response"));
    }.with_subscriber(subscriber).await;

    exporter.reset();
    let subscriber = tracing_subscriber::registry().with(tracing_opentelemetry::layer().with_tracer(provider.tracer("ai-gateway-cancel-test")));
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(closed_tx)));
    struct NotifyDrop(Option<tokio::sync::oneshot::Sender<()>>);
    impl Drop for NotifyDrop { fn drop(&mut self) { if let Some(sender) = self.0.take() { let _ = sender.send(()); } } }
    let cancellation = Server::start(Router::new().fallback(move || {
        let guard = NotifyDrop(sender.lock().take());
        async move {
            let initial = "data: {\"id\":\"cancel-id\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture/cancel\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n";
            let body = stream::unfold((Some(initial), guard), |(initial, guard)| async move {
                if let Some(initial) = initial { Some((Ok::<_, Infallible>(initial), (None, guard))) }
                else { std::future::pending::<Option<(Result<&'static str, Infallible>, (Option<&'static str>, NotifyDrop))>>().await }
            });
            Response::builder().header("content-type", "text/event-stream").body(Body::from_stream(body)).unwrap()
        }
    })).await;
    async {
        let client = Client::builder(&cancellation.origin).build().unwrap();
        let mut stream = client.chat("fixture/cancel").user("hello").stream().await.unwrap();
        assert!(matches!(stream.next().await.unwrap().unwrap(), StreamEvent::Delta { .. }));
        drop(stream);
        tokio::time::timeout(Duration::from_secs(5), closed_rx).await.unwrap().unwrap();
        let spans = exporter.get_finished_spans().unwrap();
        let span = spans.iter().find(|span| span.name == "chat fixture/cancel").unwrap();
        assert!(matches!(span.status, Status::Error { .. }));
        assert_eq!(attribute(span, "error.type"), Some(&Value::String("cancelled".into())));
    }.with_subscriber(subscriber).await;
}
