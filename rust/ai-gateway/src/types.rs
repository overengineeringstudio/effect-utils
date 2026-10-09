use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Provider-reported counts. Missing counts are never synthesized (AIG-R03).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Raw JSON arguments. Decode only after all streamed fragments are assembled.
    pub arguments: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub parameters: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strict: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum Message {
    System { content: String },
    User { content: String },
    Assistant {
        content: Option<String>,
        #[serde(default)]
        tool_calls: Vec<ToolCall>,
    },
    Tool { tool_call_id: String, content: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChatResponse {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Option<Usage>,
    pub finish_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum StreamEvent {
    Delta { text: String },
    ToolCallDelta {
        index: u32,
        id: Option<String>,
        name: Option<String>,
        arguments: String,
    },
    /// Emitted only after the wire completion sentinel, never on premature EOF.
    Done { usage: Option<Usage> },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StructuredResponse<T> {
    pub value: T,
    pub usage: Option<Usage>,
    pub finish_reason: Option<String>,
}

/// Exact catalog identity and optional gateway/provider metadata.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    #[serde(flatten)]
    pub metadata: BTreeMap<String, Value>,
}

impl Usage {
    pub(crate) fn from_chat(value: async_openai::types::chat::CompletionUsage) -> Self {
        Self {
            input: Some(u64::from(value.prompt_tokens)),
            output: Some(u64::from(value.completion_tokens)),
            total: Some(u64::from(value.total_tokens)),
            cached: value.prompt_tokens_details.and_then(|v| v.cached_tokens).map(u64::from),
            reasoning: value.completion_tokens_details.and_then(|v| v.reasoning_tokens).map(u64::from),
            cost: None,
        }
    }
}
