//! Native probability-bearing decisions and validation against caller declarations.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{Error, Result, Usage};

/// A batch of named decisions, optionally selecting an explicit gateway model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionSpec {
    pub model: Option<String>,
    pub questions: BTreeMap<String, Question>,
}

/// A native classification, probability, or ordered rating question.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Question {
    Choice {
        instructions: Value,
        criteria: BTreeMap<String, Value>,
    },
    Noul {
        instructions: Value,
    },
    Score {
        instructions: Value,
        criteria: Vec<String>,
    },
}

/// A checked native answer. Confidence is distinct from option probability.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum DecisionAnswer {
    Score {
        rating: f64,
        label: String,
        probabilities: BTreeMap<String, f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        confidence: Option<f64>,
    },
    Choice {
        label: String,
        probabilities: BTreeMap<String, f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        confidence: Option<f64>,
    },
    Noul {
        probability: f64,
    },
}

/// Checked answers and optional provider-reported provenance and usage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub answers: BTreeMap<String, DecisionAnswer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation {
        errors: vec![message.into()],
        usage: None,
    }
}

impl DecisionSpec {
    /// Validate declarations and encode the native gateway wire request.
    pub(crate) fn request(&self, input: Value) -> Result<Value> {
        self.validate()?;
        if !input.is_string() && !input.is_object() {
            return Err(invalid("Decision state must be a string or JSON object"));
        }
        Ok(
            json!({"model":self.model.as_deref().unwrap_or("openrouter/~typesafe/jev-latest"), "state":input, "questions":self.questions}),
        )
    }

    fn validate(&self) -> Result<()> {
        let mut errors = Vec::new();
        if let Some(model) = &self.model {
            if !model
                .split_once('/')
                .is_some_and(|(provider, name)| !provider.is_empty() && !name.is_empty())
            {
                errors.push("Decision model must be a nonempty provider/model ID".into());
            }
        }
        if self.questions.is_empty() {
            errors.push("Decision questions must not be empty".into());
        }
        for (name, question) in &self.questions {
            if name.trim().is_empty() {
                errors.push("Decision question names must not be empty".into());
            }
            let instructions = match question {
                Question::Choice {
                    instructions,
                    criteria,
                } => {
                    if criteria.is_empty() || criteria.keys().any(|label| label.trim().is_empty()) {
                        errors.push(format!(
                            "Question {name}: choice criteria need nonempty labels"
                        ));
                    }
                    instructions
                }
                Question::Noul { instructions } => instructions,
                Question::Score {
                    instructions,
                    criteria,
                } => {
                    let unique: BTreeSet<_> = criteria.iter().collect();
                    if criteria.is_empty()
                        || criteria.iter().any(|label| label.trim().is_empty())
                        || unique.len() != criteria.len()
                    {
                        errors.push(format!(
                            "Question {name}: score criteria need distinct nonempty labels"
                        ));
                    }
                    instructions
                }
            };
            if !instructions.is_string() && !instructions.is_object() {
                errors.push(format!(
                    "Question {name}: instructions must be a string or object"
                ));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(Error::Validation {
                errors,
                usage: None,
            })
        }
    }
}

#[derive(Deserialize)]
struct WireResponse {
    model: Option<String>,
    answers: BTreeMap<String, WireAnswer>,
    usage: Option<WireUsage>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum WireAnswer {
    Choice {
        choice: String,
        probabilities: BTreeMap<String, f64>,
        confidence: Option<f64>,
    },
    Noul {
        noul: f64,
    },
    Score {
        score: f64,
        probabilities: BTreeMap<String, f64>,
        legend: BTreeMap<String, String>,
        confidence: Option<f64>,
    },
}

#[derive(Deserialize)]
struct WireUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
    cached_tokens: Option<u64>,
    reasoning_tokens: Option<u64>,
    cost: Option<f64>,
}

fn unit_interval(value: f64, context: &str) -> Result<()> {
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        Ok(())
    } else {
        Err(invalid(format!(
            "{context} must be finite and within [0, 1]"
        )))
    }
}

fn distribution(
    probabilities: &BTreeMap<String, f64>,
    labels: &BTreeSet<String>,
    name: &str,
) -> Result<()> {
    if probabilities.len() != labels.len()
        || probabilities.keys().any(|label| !labels.contains(label))
    {
        return Err(invalid(format!(
            "Question {name}: probability keys must exactly cover declared options"
        )));
    }
    for (label, probability) in probabilities {
        unit_interval(
            *probability,
            &format!("Question {name}: probability {label}"),
        )?;
    }
    if (probabilities.values().sum::<f64>() - 1.0).abs() > 1e-6 {
        return Err(invalid(format!(
            "Question {name}: probabilities must sum to one within 1e-6"
        )));
    }
    Ok(())
}

/// Decode native wire answers, never filling absent answers or normalizing probabilities.
pub(crate) fn decode(spec: &DecisionSpec, wire: Value) -> Result<DecisionResponse> {
    let usage = wire
        .get("usage")
        .and_then(|usage| WireUsage::deserialize(usage).ok())
        .map(|usage| Usage {
            input: usage.input_tokens,
            output: usage.output_tokens,
            total: usage.total_tokens,
            cached: usage.cached_tokens,
            reasoning: usage.reasoning_tokens,
            cost: usage.cost,
        });
    decode_response(spec, wire).map_err(|error| error.with_usage(usage))
}

fn decode_response(spec: &DecisionSpec, wire: Value) -> Result<DecisionResponse> {
    spec.validate()?;
    let mut wire: WireResponse = serde_json::from_value(wire)
        .map_err(|error| invalid(format!("Invalid decision response: {error}")))?;
    let mut answers = BTreeMap::new();
    for (name, question) in &spec.questions {
        let answer = wire
            .answers
            .remove(name)
            .ok_or_else(|| invalid(format!("Missing decision answer: {name}")))?;
        let decoded = match (question, answer) {
            (
                Question::Choice { criteria, .. },
                WireAnswer::Choice {
                    choice,
                    probabilities,
                    confidence,
                },
            ) => {
                if !criteria.contains_key(&choice) {
                    return Err(invalid(format!(
                        "Question {name}: undeclared choice label {choice}"
                    )));
                }
                distribution(&probabilities, &criteria.keys().cloned().collect(), name)?;
                if let Some(confidence) = confidence {
                    unit_interval(confidence, &format!("Question {name}: confidence"))?;
                }
                DecisionAnswer::Choice {
                    label: choice,
                    probabilities,
                    confidence,
                }
            }
            (Question::Noul { .. }, WireAnswer::Noul { noul }) => {
                unit_interval(noul, &format!("Question {name}: probability"))?;
                DecisionAnswer::Noul { probability: noul }
            }
            (
                Question::Score { criteria, .. },
                WireAnswer::Score {
                    score,
                    probabilities,
                    legend,
                    confidence,
                },
            ) => {
                let expected: BTreeMap<String, String> = criteria
                    .iter()
                    .enumerate()
                    .map(|(index, label)| (index.to_string(), label.clone()))
                    .collect();
                if legend != expected {
                    return Err(invalid(format!(
                        "Question {name}: score legend must match ordered criteria"
                    )));
                }
                distribution(&probabilities, &expected.keys().cloned().collect(), name)?;
                if !score.is_finite() || score < 0.0 || score > (criteria.len() - 1) as f64 {
                    return Err(invalid(format!(
                        "Question {name}: score must be finite and within the criteria range"
                    )));
                }
                if let Some(confidence) = confidence {
                    unit_interval(confidence, &format!("Question {name}: confidence"))?;
                }
                // Round half upward to the nearest declared rating. Bounds above prove the index valid.
                let label = criteria[score.round() as usize].clone();
                let probabilities = criteria
                    .iter()
                    .enumerate()
                    .map(|(index, label)| (label.clone(), probabilities[&index.to_string()]))
                    .collect();
                DecisionAnswer::Score {
                    rating: score,
                    label,
                    probabilities,
                    confidence,
                }
            }
            _ => {
                return Err(invalid(format!(
                    "Question {name}: answer kind does not match the requested kind"
                )))
            }
        };
        answers.insert(name.clone(), decoded);
    }
    if !wire.answers.is_empty() {
        return Err(invalid(
            "Decision response contains unrequested answer names",
        ));
    }
    let usage = wire.usage.map(|usage| Usage {
        input: usage.input_tokens,
        output: usage.output_tokens,
        total: usage.total_tokens,
        cached: usage.cached_tokens,
        reasoning: usage.reasoning_tokens,
        cost: usage.cost,
    });
    Ok(DecisionResponse {
        model: wire.model,
        answers,
        usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> DecisionSpec {
        serde_json::from_value(json!({"model":null,"questions":{"team":{"type":"choice","instructions":"Pick a team","criteria":{"billing":"Money","technical":"Bugs"}},"urgency":{"type":"noul","instructions":{}},"mood":{"type":"score","instructions":"Rate mood","criteria":["calm","upset","angry"]}}})).unwrap()
    }

    fn response() -> Value {
        json!({"answers":{"team":{"type":"choice","choice":"billing","probabilities":{"billing":0.9,"technical":0.1}},"urgency":{"type":"noul","noul":0.7},"mood":{"type":"score","score":1.2,"legend":{"0":"calm","1":"upset","2":"angry"},"probabilities":{"0":0,"1":0.8,"2":0.2},"confidence":0.6}},"usage":{"input_tokens":0,"cost":0.01}})
    }

    #[test]
    fn native_answers_preserve_optional_data_and_translate_score_labels() {
        let spec = spec();
        assert_eq!(
            spec.request(json!({})).unwrap()["model"],
            "openrouter/~typesafe/jev-latest"
        );
        let decoded = decode(&spec, response()).unwrap();
        assert!(decoded.model.is_none());
        let usage = decoded.usage.unwrap();
        assert_eq!(usage.input, Some(0));
        assert_eq!(usage.output, None);
        assert_eq!(usage.cost, Some(0.01));
        let DecisionAnswer::Score {
            rating,
            label,
            probabilities,
            confidence,
        } = &decoded.answers["mood"]
        else {
            panic!("Expected score answer")
        };
        assert_eq!(*rating, 1.2);
        assert_eq!(label, "upset");
        assert_eq!(probabilities["angry"], 0.2);
        assert_eq!(*confidence, Some(0.6));
        assert!(matches!(
            decoded.answers["team"],
            DecisionAnswer::Choice {
                confidence: None,
                ..
            }
        ));
    }

    #[test]
    fn invalid_labels_distributions_missing_names_and_kinds_fail() {
        let mutations: Vec<(&str, Value)> = vec![
            ("/answers/team/choice", json!("unknown")),
            (
                "/answers/team/probabilities",
                json!({"billing":0.8,"technical":0.1}),
            ),
            ("/answers/team/probabilities", json!({"billing":1})),
            (
                "/answers/team/probabilities",
                json!({"billing":1.1,"technical":-0.1}),
            ),
            ("/answers/urgency/noul", json!(1.1)),
            ("/answers/mood/score", json!(3)),
            ("/answers/mood/legend/1", json!("wrong")),
            ("/answers/mood/confidence", json!(-0.1)),
            (
                "/answers/urgency",
                json!({"type":"choice","choice":"billing","probabilities":{"billing":1}}),
            ),
        ];
        for (pointer, replacement) in mutations {
            let mut wire = response();
            *wire.pointer_mut(pointer).unwrap() = replacement;
            assert!(decode(&spec(), wire).is_err(), "Accepted invalid {pointer}");
        }
        let mut wire = response();
        wire["answers"].as_object_mut().unwrap().remove("team");
        assert!(decode(&spec(), wire).is_err());
    }

    #[test]
    fn invalid_declarations_fail_before_request() {
        let mut declaration = spec();
        declaration.questions.insert(
            String::new(),
            Question::Score {
                instructions: Value::Null,
                criteria: vec![],
            },
        );
        assert!(declaration.request(json!({})).is_err());
        assert!(spec().request(json!([])).is_err());
    }

    #[test]
    fn untagged_score_deserialization_retains_rating() {
        let answer: DecisionAnswer = serde_json::from_value(
            json!({"rating":1.2,"label":"upset","probabilities":{"upset":1},"confidence":0.6}),
        )
        .unwrap();
        assert!(matches!(answer, DecisionAnswer::Score { rating: 1.2, .. }));
    }
}
