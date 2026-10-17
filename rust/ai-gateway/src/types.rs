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
    System {
        content: String,
    },
    User {
        content: String,
    },
    Assistant {
        content: Option<String>,
        #[serde(default)]
        tool_calls: Vec<ToolCall>,
    },
    Tool {
        tool_call_id: String,
        content: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChatResponse {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Option<Usage>,
    pub finish_reason: Option<String>,
}

/// Completed bounded tool run, including every successful model exchange.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolRun {
    pub response: ChatResponse,
    pub exchanges: Vec<Option<Usage>>,
    pub total: Option<Usage>,
}

pub(crate) fn aggregate_usage(exchanges: &[Option<Usage>]) -> Option<Usage> {
    let (first, rest) = exchanges.split_first()?;
    let mut total = first.clone()?;
    for usage in rest {
        let usage = usage.as_ref()?;
        total.input = total
            .input
            .zip(usage.input)
            .and_then(|(a, b)| a.checked_add(b));
        total.output = total
            .output
            .zip(usage.output)
            .and_then(|(a, b)| a.checked_add(b));
        total.total = total
            .total
            .zip(usage.total)
            .and_then(|(a, b)| a.checked_add(b));
        total.cached = total
            .cached
            .zip(usage.cached)
            .and_then(|(a, b)| a.checked_add(b));
        total.reasoning = total
            .reasoning
            .zip(usage.reasoning)
            .and_then(|(a, b)| a.checked_add(b));
        total.cost = total
            .cost
            .zip(usage.cost)
            .map(|(a, b)| a + b)
            .filter(|sum| sum.is_finite());
    }
    Some(total)
}

#[derive(Clone, Debug, PartialEq)]
pub enum StreamEvent {
    Delta {
        text: String,
    },
    ToolCallDelta {
        index: u32,
        id: Option<String>,
        name: Option<String>,
        arguments: String,
    },
    /// Emitted only after the wire completion sentinel, never on premature EOF.
    Done {
        usage: Option<Usage>,
    },
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
            cached: value
                .prompt_tokens_details
                .and_then(|v| v.cached_tokens)
                .map(u64::from),
            reasoning: value
                .completion_tokens_details
                .and_then(|v| v.reasoning_tokens)
                .map(u64::from),
            cost: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn aggregate_requires_every_exchange_and_each_field(
            values in prop::collection::vec(
                prop::option::of(prop::array::uniform6(prop::option::of(0_u16..1000))),
                0..12,
            ),
        ) {
            let exchanges: Vec<_> = values.iter().map(|value| value.map(|fields| Usage {
                input: fields[0].map(u64::from),
                output: fields[1].map(u64::from),
                total: fields[2].map(u64::from),
                cached: fields[3].map(u64::from),
                reasoning: fields[4].map(u64::from),
                cost: fields[5].map(f64::from),
            })).collect();
            let aggregate = aggregate_usage(&exchanges);
            if values.is_empty() || values.iter().any(Option::is_none) {
                prop_assert_eq!(aggregate, None);
            } else {
                let total = aggregate.unwrap();
                let actual = [total.input, total.output, total.total, total.cached, total.reasoning];
                for (field, actual) in actual.into_iter().enumerate() {
                    let expected: Option<u64> = values.iter()
                        .map(|value| value.unwrap()[field].map(u64::from)).sum();
                    prop_assert_eq!(actual, expected);
                }
                let expected: Option<f64> = values.iter()
                    .map(|value| value.unwrap()[5].map(f64::from)).sum();
                prop_assert_eq!(total.cost, expected);
            }
        }
    }

    #[test]
    fn aggregate_does_not_wrap_overflowing_counts() {
        let exchanges = [
            Some(Usage {
                input: Some(u64::MAX),
                ..Usage::default()
            }),
            Some(Usage {
                input: Some(1),
                ..Usage::default()
            }),
        ];
        assert_eq!(aggregate_usage(&exchanges).unwrap().input, None);
    }
}
