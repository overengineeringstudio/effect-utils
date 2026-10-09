# ai-gateway

An asynchronous Rust client for the public AI gateway wire contract. The crate
owns its chat, tool, usage, catalog, structured-output, decision, and error types.
`async-openai` types are only part of the explicit `Client::raw()` escape hatch.

Use the crate at `rust/ai-gateway` as a Cargo path dependency in this repository.
Applications supply their own Tokio runtime. Streaming consumers also need
`futures`; typed structured values use `serde` and `schemars` derives.

## Connection and ordinary chat

Pass the gateway **origin**, without `/v1`; the client adds the API prefix.
Provider-prefixed model IDs are sent unchanged. A token is optional: omitting it
omits the Authorization header rather than sending an empty bearer.

```rust
use ai_gateway::{Client, Result};

async fn ordinary_chat() -> Result<()> {
    // Reads AI_GATEWAY_URL and optional AI_GATEWAY_TOKEN.
    let client = Client::from_env()?;
    let response = client
        .chat("anthropic/claude-haiku-4-5")
        .system("Answer concisely.")
        .user("Explain what a compiler does.")
        .send()
        .await?;
    println!("{}", response.text);
    println!("usage: {:?}", response.usage);
    Ok(())
}
```

For explicit configuration, use
`Client::builder("https://gateway.example").token(token).build()?`, or omit
`.token(...)` for caller-controlled local test transports. Protected gateways
reject missing authentication. The builder rejects origins containing credentials,
paths, query parameters, or fragments.
Bearer values are redacted from client diagnostics.

`client.models().await?` returns model IDs and preserved catalog metadata. It
does not invent aliases or assume that every catalog entry supports every API.
`ChatResponse` contains text, tool calls, optional usage, and an optional finish
reason. Usage fields are provider-reported and optional; missing counts are not
calculated from prompts or filled with zeroes.

## Streaming

```rust
use ai_gateway::{Client, Result, StreamEvent};
use futures::StreamExt;

async fn stream_chat(client: &Client) -> Result<()> {
    let mut stream = client
        .chat("anthropic/claude-haiku-4-5")
        .user("Explain Rust ownership.")
        .stream()
        .await?;

    while let Some(event) = stream.next().await {
        match event? {
            StreamEvent::Delta { text } => print!("{text}"),
            StreamEvent::ToolCallDelta { index, id, name, arguments } => {
                // Assemble fragments by index. Arguments are not necessarily
                // valid JSON until the complete call has arrived.
                println!("tool fragment: {index} {id:?} {name:?} {arguments}");
            }
            StreamEvent::Done { usage } => println!("\nusage: {usage:?}"),
        }
    }
    Ok(())
}
```

Usage-only chunks are retained. `Done` means the wire completion sentinel was
received; EOF without that sentinel is an error. An error envelope after HTTP
200 remains a stream error, even after partial text. Dropping the stream cancels
consumption rather than reporting successful completion.

## Typed structured output

```rust
use ai_gateway::{Client, Result};
use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Person {
    name: String,
    age: u32,
    tags: Vec<String>,
}

async fn structured_person(client: &Client) -> Result<Person> {
    let response = client
        .chat("anthropic/claude-haiku-4-5")
        .user("Return Ada Lovelace, age 36, with the tag math.")
        .structured::<Person>()
        .await?;
    println!("usage: {:?}", response.usage);
    Ok(response.value)
}
```

`structured::<T>()` generates the original schema with `schemars`, sends a
separate provider-compatible strict projection, validates returned JSON against
the original schema, and then deserializes `T`. `StructuredResponse<T>` preserves
usage and finish reason alongside `value`.

For a caller-owned JSON Schema, use
`builder.structured_with_schema(schema).await?`; its value is
`serde_json::Value`. Original numeric and array constraints remain authoritative.
Unsupported formatting, malformed JSON, schema violations, and typed decode
failures are errors, not an unconstrained-text fallback.

## Native decisions

Decisions use the gateway's native `/v1/systemone` endpoint, not a chat prompt
that asks for classification. A `DecisionSpec` batches named choice, probability
(`noul`), and ordered rating (`score`) questions. Definitions can be constructed
as Rust types or deserialized from the public wire-shaped JSON:

```rust
use ai_gateway::{Client, DecisionAnswer, DecisionSpec, Result};
use serde_json::json;

async fn classify_ticket(client: &Client) -> Result<()> {
    let spec: DecisionSpec = serde_json::from_value(json!({
        "questions": {
            "department": {
                "type": "choice",
                "instructions": "Which team should handle this ticket?",
                "criteria": {
                    "billing": "Payments and refunds",
                    "technical": "Bugs and outages"
                }
            },
            "urgent": { "type": "noul", "instructions": "Needs action today?" },
            "frustration": {
                "type": "score",
                "instructions": "How frustrated is the customer?",
                "criteria": ["calm", "frustrated", "angry"]
            }
        }
    })).expect("constant decision specification");
    let response = client.decide(spec, json!({ "ticket": "Charged twice" })).await?;
    if let DecisionAnswer::Choice { label, probabilities, confidence } =
        &response.answers["department"]
    {
        println!("{label}: {probabilities:?}, confidence: {confidence:?}");
    }
    println!("usage: {:?}", response.usage);
    Ok(())
}
```

Omitting `model` selects `openrouter/~typesafe/jev-latest`. An explicit model ID
is preserved. Every requested answer is checked against its question, including
labels, numeric ranges, and probability distributions. Invalid distributions
are rejected rather than normalized. Confidence is separate from probability;
response model provenance and usage are optional provider metadata.

## Caller-owned tools with a bounded loop

Tools describe functions; the caller owns execution and authorization. The
ordinary `send()` method returns tool calls without executing them. For an
explicit bounded exchange, `run_tools(max_steps, execute)` passes assembled
`ToolCall` values to an async callback, appends assistant calls and matching tool
results, and continues the conversation. The step budget prevents an unbounded
model/tool loop; exhausting it is an error rather than a fabricated final answer.

This example executes only a local, explicitly allowed addition function:

```rust
use ai_gateway::{Client, Error, Result, Tool, ToolCall};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddArguments { left: i64, right: i64 }

async fn tools_chat(client: &Client) -> Result<()> {
    let response = client
        .chat("anthropic/claude-haiku-4-5")
        .user("Use add to calculate 19 + 23.")
        .tools(vec![Tool {
            name: "add".into(),
            description: Some("Add two integers".into()),
            parameters: json!({
                "type": "object",
                "properties": { "left": { "type": "integer" }, "right": { "type": "integer" } },
                "required": ["left", "right"],
                "additionalProperties": false
            }),
            strict: Some(true),
        }])
        .run_tools(4, |call: ToolCall| async move {
            if call.name != "add" {
                return Err(Error::Validation { errors: vec!["Tool is not allowed".into()], usage: None });
            }
            let args: AddArguments = serde_json::from_str(&call.arguments)
                .map_err(|error| Error::Validation { errors: vec![error.to_string()], usage: None })?;
            let sum = args.left.checked_add(args.right)
                .ok_or_else(|| Error::Validation { errors: vec!["Integer overflow".into()], usage: None })?;
            Ok(json!({ "sum": sum }).to_string())
        })
        .await?;
    println!("{}", response.text);
    Ok(())
}
```

For manual orchestration, append `Message::Assistant { content, tool_calls }`
followed by `Message::Tool { tool_call_id, content }` to the next builder. Preserve
the model's call IDs; validate arguments and enforce permissions before any
external side effect. Tool arguments remain raw JSON strings so streaming
fragments can be assembled before decoding.

## Raw escape hatch

`Client::raw()` exposes the configured `async-openai` client, sharing the origin,
authentication, and no-retry transport. Its API and SDK types are **unstable**
relative to the crate-owned API. Use it when an SDK capability is not represented
by the wrapper, not as a replacement for structured validation or decisions.

```rust
use ai_gateway::Client;
use serde_json::{Value, json};

async fn raw_chat(client: &Client) -> std::result::Result<Value, Box<dyn std::error::Error>> {
    let response: Value = client.raw().chat().create_byot(json!({
        "model": "anthropic/claude-haiku-4-5",
        "messages": [{ "role": "user", "content": "Hello" }],
        "stream": false
    })).await?;
    Ok(response)
}
```

Raw operations return SDK errors and do not add the wrapper's typed decoding,
original-schema validation, decision integrity checks, or operation telemetry.

## Errors, retries, and telemetry

- `Error::Http` preserves status, optional wire error type, message, exact raw
  response body, and optional `Retry-After` header.
- `Error::Stream` preserves a diagnosis and the raw error payload when available.
- `Error::Validation { errors, usage }` reports local schema or decision integrity
  failures. If a successful provider response was rejected locally, its billed
  usage is retained in the error; pre-request validation has `usage: None`.
- `Error::Transport` and `Error::Config` distinguish transport/configuration failures.

The client never automatically retries HTTP refusals, transport failures, or
stream failures. Retry and backoff policy belong to the caller, especially when
requests or tool execution can have side effects.

Consumers install their own tracing/OpenTelemetry subscribers and exporters.
The wrapper does not configure a process-global exporter. Operation spans cover
response consumption and validation; bearer values, prompt text, response text,
and tool arguments are not recorded by default.

## Conformance tests

`tests/conformance.rs` dynamically loads every JSON case from
`../../packages/@overeng/ai-gateway-conformance/cases`, relative to the crate,
and replays it through a local Tokio/Axum HTTP server. Each case ID is printed.
The harness checks method, path, bearer presence, semantic matches, request body
subsets, schema projection, observable output, usage, and failure metadata. It
asserts one HTTP request per case, including 429 and 5xx refusals. Unknown
operations or expectations panic instead of silently skipping a case.

Additional Rust cases cover premature stream EOF and streamed tool argument
assembly over fragmented transport chunks. Run the crate's Cargo conformance
test with `--nocapture` to retain every case ID in the test output.
