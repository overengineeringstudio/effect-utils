//! Async client for the public AI gateway contract.
//!
//! Core request, response, stream, decision and error types belong to this crate.
//! [`Client::raw`] is the sole, explicitly unstable async-openai escape hatch.
//! Consumers supply the runtime, retry policy, tool execution and telemetry
//! subscriber/exporter. The client never installs process-global telemetry.
#![forbid(unsafe_code)]

mod chat;
mod client;
mod decision;
mod error;
mod schema;
mod telemetry;
mod types;

pub use chat::{ChatBuilder, ChatStream};
pub use client::{Client, ClientBuilder};
pub use decision::{DecisionAnswer, DecisionResponse, DecisionSpec, Question};
pub use error::{Error, Result};
pub use types::{
    ChatResponse, Message, ModelInfo, StreamEvent, StructuredResponse, Tool, ToolCall, Usage,
};
