use std::{collections::{BTreeMap, VecDeque}, future::Future, pin::Pin, sync::{Arc, atomic::{AtomicBool, Ordering}}, task::{Context, Poll}};

use async_openai::{error::OpenAIError, types::chat::{CreateChatCompletionRequest, CreateChatCompletionResponse, CreateChatCompletionStreamResponse, ChatCompletionMessageToolCalls, FinishReason}};
use futures::Stream;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tracing::Instrument;

use crate::{Client, Error, Message, Result, ChatResponse, StructuredResponse, StreamEvent, Tool, ToolCall, Usage, client::STREAM_DONE, schema, telemetry::Operation};

#[derive(Clone, Debug)]
pub struct ChatBuilder<'a> {
    client: &'a Client,
    model: String,
    messages: Vec<Message>,
    tools: Vec<Tool>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
}

impl<'a> ChatBuilder<'a> {
    pub(crate) fn new(client: &'a Client, model: String) -> Self {
        Self { client, model, messages: Vec::new(), tools: Vec::new(), temperature: None, max_tokens: None }
    }
    pub fn message(mut self, message: Message) -> Self { self.messages.push(message); self }
    pub fn system(self, content: impl Into<String>) -> Self { self.message(Message::System { content: content.into() }) }
    pub fn user(self, content: impl Into<String>) -> Self { self.message(Message::User { content: content.into() }) }
    pub fn assistant(self, content: impl Into<String>) -> Self { self.message(Message::Assistant { content: Some(content.into()), tool_calls: Vec::new() }) }
    pub fn tool(self, tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        self.message(Message::Tool { tool_call_id: tool_call_id.into(), content: content.into() })
    }
    pub fn tools(mut self, tools: Vec<Tool>) -> Self { self.tools = tools; self }
    pub fn temperature(mut self, temperature: f32) -> Self { self.temperature = Some(temperature); self }
    pub fn max_tokens(mut self, max_tokens: u32) -> Self { self.max_tokens = Some(max_tokens); self }

    fn request(&self, response_format: Option<Value>, stream: bool) -> Result<CreateChatCompletionRequest> {
        if self.model.is_empty() { return Err(Error::validation("model must not be empty")); }
        if self.messages.is_empty() { return Err(Error::validation("at least one message is required")); }
        let messages: Vec<Value> = self.messages.iter().map(|message| match message {
            Message::System { content } => json!({"role":"system","content":content}),
            Message::User { content } => json!({"role":"user","content":content}),
            Message::Assistant { content, tool_calls } => {
                let mut message = json!({"role":"assistant","content":content});
                if !tool_calls.is_empty() {
                    message["tool_calls"] = Value::Array(tool_calls.iter().map(|call| json!({"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments}})).collect());
                }
                message
            },
            Message::Tool { tool_call_id, content } => json!({"role":"tool","tool_call_id":tool_call_id,"content":content}),
        }).collect();
        let mut request = json!({"model":self.model,"messages":messages,"stream":stream});
        if stream { request["stream_options"] = json!({"include_usage":true}); }
        if let Some(format) = response_format { request["response_format"] = format; }
        if let Some(temperature) = self.temperature {
            if !temperature.is_finite() { return Err(Error::validation("temperature must be finite")); }
            request["temperature"] = json!(temperature);
        }
        if let Some(max_tokens) = self.max_tokens { request["max_tokens"] = json!(max_tokens); }
        if !self.tools.is_empty() {
            request["tools"] = Value::Array(self.tools.iter().map(|tool| {
                let mut function = json!({"name":tool.name,"parameters":tool.parameters});
                if let Some(description) = &tool.description { function["description"] = json!(description); }
                if let Some(strict) = tool.strict { function["strict"] = json!(strict); }
                json!({"type":"function","function":function})
            }).collect());
        }
        serde_json::from_value(request).map_err(|error| Error::validation(error.to_string()))
    }

    async fn send_in(&self, format: Option<Value>, operation: &Operation) -> Result<ChatResponse> {
        let response: CreateChatCompletionResponse = self.client.inner.chat().create(self.request(format, false)?).await.map_err(Error::from_sdk)?;
        let usage = response.usage.map(Usage::from_chat);
        let choice = response.choices.into_iter().next().ok_or_else(|| Error::validation("chat response has no choices"))?;
        let finish_reason = choice.finish_reason.map(finish_reason);
        operation.metadata(Some(&response.model), Some(&response.id), finish_reason.as_deref(), usage.as_ref());
        if choice.message.refusal.is_some() { return Err(Error::validation("provider refused the request")); }
        let tool_calls = choice.message.tool_calls.unwrap_or_default().into_iter().map(|call| match call {
            ChatCompletionMessageToolCalls::Function(call) => Ok(ToolCall { id: call.id, name: call.function.name, arguments: call.function.arguments }),
            ChatCompletionMessageToolCalls::Custom(_) => Err(Error::validation("custom tools are outside the function-tool contract")),
        }).collect::<Result<Vec<_>>>()?;
        Ok(ChatResponse { text: choice.message.content.unwrap_or_default(), tool_calls, usage, finish_reason })
    }

    pub async fn send(self) -> Result<ChatResponse> {
        let mut operation = Operation::new("chat", &self.model);
        let result = self.send_in(None, &operation).instrument(operation.span.clone()).await;
        operation.finish(&result);
        result
    }

    async fn structured_in(&self, original: &Value, operation: &Operation) -> Result<StructuredResponse<Value>> {
        // Compile the original before any request, and reuse it for output checking.
        let validator = jsonschema::validator_for(original).map_err(|error| Error::validation(error.to_string()))?;
        let projected = schema::project(original)?;
        let response = self.send_in(Some(json!({"type":"json_schema","json_schema":{"name":"response","strict":true,"schema":projected}})), operation).await?;
        let value: Value = serde_json::from_str(&response.text).map_err(|error| Error::validation(error.to_string()))?;
        let errors: Vec<String> = validator.iter_errors(&value).map(|error| error.to_string()).collect();
        if !errors.is_empty() { return Err(Error::Validation { errors }); }
        Ok(StructuredResponse { value, usage: response.usage, finish_reason: response.finish_reason })
    }

    /// AIG.RS-R06: project only the upstream form, then validate the original schema.
    pub async fn structured_with_schema(self, original: Value) -> Result<StructuredResponse<Value>> {
        let mut operation = Operation::new("chat", &self.model);
        let result = self.structured_in(&original, &operation).instrument(operation.span.clone()).await;
        operation.finish(&result);
        result
    }

    pub async fn structured<T: JsonSchema + DeserializeOwned>(self) -> Result<StructuredResponse<T>> {
        let mut operation = Operation::new("chat", &self.model);
        let result = async {
            let original = serde_json::to_value(schemars::schema_for!(T)).map_err(|error| Error::validation(error.to_string()))?;
            let response = self.structured_in(&original, &operation).await?;
            let value = serde_json::from_value(response.value).map_err(|error| Error::validation(error.to_string()))?;
            Ok(StructuredResponse { value, usage: response.usage, finish_reason: response.finish_reason })
        }.instrument(operation.span.clone()).await;
        operation.finish(&result);
        result
    }

    /// Perform at most `max_steps` model exchanges. Tool execution belongs to the
    /// supplied callback; the client does not execute model-selected code itself.
    pub async fn run_tools<F, Fut>(mut self, max_steps: usize, mut execute: F) -> Result<ChatResponse>
    where F: FnMut(ToolCall) -> Fut, Fut: Future<Output = Result<String>> {
        if max_steps == 0 { return Err(Error::validation("max_steps must be positive")); }
        for step in 0..max_steps {
            let mut operation = Operation::new("chat", &self.model);
            let result = self.send_in(None, &operation).instrument(operation.span.clone()).await;
            operation.finish(&result);
            let response = result?;
            if response.tool_calls.is_empty() { return Ok(response); }
            if step + 1 == max_steps { return Err(Error::validation("tool run exhausted max_steps")); }
            let mut ids = std::collections::BTreeSet::new();
            // Validate the complete exchange before any caller-owned side effect.
            for call in &response.tool_calls {
                if call.id.is_empty() || !ids.insert(&call.id) { return Err(Error::validation("tool call IDs must be nonempty and unique")); }
                let tool = self.tools.iter().find(|tool| tool.name == call.name).ok_or_else(|| Error::validation(format!("undeclared tool: {}", call.name)))?;
                let arguments: Value = serde_json::from_str(&call.arguments).map_err(|error| Error::validation(error.to_string()))?;
                schema::validate(&tool.parameters, &arguments)?;
            }
            self.messages.push(Message::Assistant { content: Some(response.text), tool_calls: response.tool_calls.clone() });
            for call in response.tool_calls {
                let id = call.id.clone();
                let content = execute(call).await?;
                self.messages.push(Message::Tool { tool_call_id: id, content });
            }
        }
        unreachable!("positive bounded loop returns on its final exchange")
    }

    pub async fn stream(self) -> Result<ChatStream> {
        let mut operation = Operation::new("chat", &self.model);
        let done = Arc::new(AtomicBool::new(false));
        let result: Result<_> = async {
            let request = self.request(None, true)?;
            // BYOT retains SSE error objects instead of losing their raw payload
            // in an SDK chunk-deserialization error. Normal chunks stay SDK typed.
            let inner = STREAM_DONE.scope(done.clone(), self.client.inner.chat().create_stream_byot(request)).await.map_err(Error::from_sdk)?;
            Ok(inner)
        }.instrument(operation.span.clone()).await;
        match result {
            Ok(inner) => Ok(ChatStream { inner, operation, done, pending: VecDeque::new(), usage: None, calls: BTreeMap::new(), ended: false }),
            Err(error) => { operation.finish::<()>(&Err(error.clone())); Err(error) },
        }
    }
}

fn finish_reason(reason: FinishReason) -> String {
    match reason {
        FinishReason::Stop => "stop",
        FinishReason::Length => "length",
        FinishReason::ToolCalls => "tool_calls",
        FinishReason::ContentFilter => "content_filter",
        FinishReason::FunctionCall => "function_call",
    }.into()
}

/// An owned, cancellable stream. Dropping it ends the operation without success.
pub struct ChatStream {
    inner: Pin<Box<dyn Stream<Item = std::result::Result<Value, OpenAIError>> + Send>>,
    operation: Operation,
    done: Arc<AtomicBool>,
    pending: VecDeque<StreamEvent>,
    usage: Option<Usage>,
    calls: BTreeMap<u32, ToolCall>,
    ended: bool,
}

impl ChatStream {
    fn chunk(&mut self, value: Value) -> Result<()> {
        if let Some(error) = value.get("error") {
            return Err(Error::Stream { message: error.get("message").and_then(Value::as_str).unwrap_or("provider stream error").into(), raw_body: Some(value.to_string()) });
        }
        let chunk: CreateChatCompletionStreamResponse = serde::Deserialize::deserialize(&value)
            .map_err(|error| Error::Stream { message: error.to_string(), raw_body: Some(value.to_string()) })?;
        if let Some(usage) = chunk.usage { self.usage = Some(Usage::from_chat(usage)); }
        for choice in chunk.choices {
            self.operation.metadata(Some(&chunk.model), Some(&chunk.id), choice.finish_reason.map(finish_reason).as_deref(), self.usage.as_ref());
            if choice.delta.refusal.is_some() { return Err(Error::Stream { message: "provider refused the request".into(), raw_body: None }); }
            if let Some(text) = choice.delta.content { self.pending.push_back(StreamEvent::Delta { text }); }
            for call in choice.delta.tool_calls.unwrap_or_default() {
                let (name, arguments) = call.function.map(|function| (function.name, function.arguments.unwrap_or_default())).unwrap_or_default();
                let assembled = self.calls.entry(call.index).or_insert_with(|| ToolCall { id: String::new(), name: String::new(), arguments: String::new() });
                if let Some(id) = &call.id { assembled.id.push_str(id); }
                if let Some(name) = &name { assembled.name.push_str(name); }
                assembled.arguments.push_str(&arguments);
                self.pending.push_back(StreamEvent::ToolCallDelta { index: call.index, id: call.id, name, arguments });
            }
        }
        self.operation.metadata(Some(&chunk.model), Some(&chunk.id), None, self.usage.as_ref());
        Ok(())
    }

    fn fail(&mut self, error: Error) -> Poll<Option<Result<StreamEvent>>> {
        self.ended = true;
        self.inner = Box::pin(futures::stream::empty());
        self.pending.clear();
        self.operation.finish::<()>(&Err(error.clone()));
        Poll::Ready(Some(Err(error)))
    }
}

impl Stream for ChatStream {
    type Item = Result<StreamEvent>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let span = this.operation.span.clone();
        let _entered = span.enter();
        loop {
            if this.ended { return Poll::Ready(None); }
            if let Some(event) = this.pending.pop_front() { return Poll::Ready(Some(Ok(event))); }
            match this.inner.as_mut().poll_next(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Ok(value))) => if let Err(error) = this.chunk(value) { return this.fail(error); },
                Poll::Ready(Some(Err(error))) => return this.fail(Error::Stream { message: error.to_string(), raw_body: None }),
                Poll::Ready(None) => {
                    if !this.done.load(Ordering::Acquire) { return this.fail(Error::Stream { message: "stream ended before [DONE]".into(), raw_body: None }); }
                    for call in this.calls.values() {
                        if call.id.is_empty() || call.name.is_empty() { return this.fail(Error::Stream { message: "incomplete streamed tool call".into(), raw_body: None }); }
                        if let Err(error) = serde_json::from_str::<Value>(&call.arguments) { return this.fail(Error::Stream { message: error.to_string(), raw_body: Some(call.arguments.clone()) }); }
                    }
                    this.ended = true;
                    this.operation.finish(&Ok(()));
                    return Poll::Ready(Some(Ok(StreamEvent::Done { usage: this.usage.take() })));
                },
            }
        }
    }
}
