use std::{
    fmt,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use async_openai::{
    config::Config,
    error::OpenAIError,
    middleware::{HttpRequestFactory, ReqwestService},
    traits::RequestOptionsBuilder,
};
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use secrecy::SecretString;
use serde_json::Value;
use tower::ServiceExt;
use tracing::Instrument;

use crate::{
    decision, telemetry::Operation, ChatBuilder, DecisionResponse, DecisionSpec, Error, ModelInfo,
    Result,
};

tokio::task_local! { pub(crate) static STREAM_DONE: Arc<AtomicBool>; }

#[derive(Clone)]
pub(crate) struct GatewayConfig {
    base: String,
    key: SecretString,
    auth: Option<HeaderValue>,
}

impl Config for GatewayConfig {
    fn headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(auth) = &self.auth {
            headers.insert(AUTHORIZATION, auth.clone());
        }
        headers
    }
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
    fn query(&self) -> Vec<(&str, &str)> {
        Vec::new()
    }
    fn api_base(&self) -> &str {
        &self.base
    }
    fn api_key(&self) -> &SecretString {
        &self.key
    }
}

#[derive(Clone)]
pub struct Client {
    pub(crate) inner: async_openai::Client<GatewayConfig>,
}

impl fmt::Debug for Client {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Client")
            .field("api_base", &self.inner.config().api_base())
            .field(
                "token",
                &self.inner.config().auth.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

pub struct ClientBuilder {
    origin: String,
    token: Option<SecretString>,
}

impl fmt::Debug for ClientBuilder {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClientBuilder")
            .field("origin", &self.origin)
            .field("token", &self.token.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

impl ClientBuilder {
    pub fn token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(token.into().into());
        self
    }

    pub fn build(self) -> Result<Client> {
        use secrecy::ExposeSecret;
        let origin = self.origin.trim_end_matches('/');
        let url = reqwest::Url::parse(origin).map_err(|_| Error::Config {
            message: "AI_GATEWAY_URL must be an HTTP(S) origin".into(),
        })?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::Config { message: "AI_GATEWAY_URL must be an origin without a path, query, fragment, or credentials".into() });
        }
        let auth = self
            .token
            .as_ref()
            .map(|token| {
                let token = token.expose_secret();
                if token.is_empty() || token.chars().any(char::is_whitespace) {
                    return Err(Error::Config {
                        message: "bearer must be nonempty and whitespace-free".into(),
                    });
                }
                let mut header =
                    HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| {
                        Error::Config {
                            message: "bearer contains invalid header bytes".into(),
                        }
                    })?;
                header.set_sensitive(true);
                Ok(header)
            })
            .transpose()?;
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|error| Error::Config {
            message: error.to_string(),
        })?
        .with_root_certificates(rustls::RootCertStore::from_iter(
            webpki_roots::TLS_SERVER_ROOTS.iter().cloned(),
        ))
        .with_no_client_auth();
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(tls)
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| Error::Config {
                message: error.to_string(),
            })?;
        // AIG.RS-R03: replace the SDK's retrying Tower stack, rather than tuning it.
        let service = ReqwestService::new(http.clone());
        let config = GatewayConfig {
            base: format!("{origin}/v1"),
            key: self.token.unwrap_or_else(|| String::new().into()),
            auth,
        };
        let inner = async_openai::Client::build(http, config).with_http_service(tower::service_fn(
            move |request: HttpRequestFactory| {
                let service = service.clone();
                let done = STREAM_DONE.try_with(Arc::clone).ok();
                async move {
                    let response = service.oneshot(request).await?;
                    if !response.status().is_success() {
                        let status = response.status().as_u16();
                        let retry_after = response
                            .headers()
                            .get("retry-after")
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_owned);
                        let raw_body = response.text().await.map_err(OpenAIError::Reqwest)?;
                        return Err(OpenAIError::Boxed(Box::new(Error::http(
                            status,
                            raw_body,
                            retry_after,
                        ))));
                    }
                    if let Some(done) = done {
                        let mut observer = DoneObserver::default();
                        let mut builder = http::Response::builder()
                            .status(response.status())
                            .version(response.version());
                        *builder.headers_mut().expect("response builder") =
                            response.headers().clone();
                        let body = response.bytes_stream().map(move |bytes| {
                            if let Ok(bytes) = &bytes {
                                observer.observe(bytes, &done);
                            }
                            bytes
                        });
                        let response = builder
                            .body(reqwest::Body::wrap_stream(body))
                            .map_err(|error| OpenAIError::Boxed(Box::new(error)))?;
                        Ok(response.into())
                    } else {
                        Ok(response)
                    }
                }
            },
        ));
        Ok(Client { inner })
    }
}

impl Client {
    pub fn builder(origin: impl Into<String>) -> ClientBuilder {
        ClientBuilder {
            origin: origin.into(),
            token: None,
        }
    }

    pub fn from_env() -> Result<Self> {
        let origin = std::env::var("AI_GATEWAY_URL").map_err(|_| Error::Config {
            message: "AI_GATEWAY_URL is required and must be Unicode".into(),
        })?;
        let builder = Self::builder(origin);
        match std::env::var("AI_GATEWAY_TOKEN") {
            Ok(token) => builder.token(token).build(),
            Err(std::env::VarError::NotPresent) => builder.build(),
            Err(std::env::VarError::NotUnicode(_)) => Err(Error::Config {
                message: "AI_GATEWAY_TOKEN must be Unicode".into(),
            }),
        }
    }

    /// Unstable escape hatch: async-openai's API and types may change independently
    /// of the crate-owned API. It shares authentication and no-retry transport.
    pub fn raw(&self) -> &async_openai::Client<impl Config> {
        &self.inner
    }

    pub fn chat(&self, model: impl Into<String>) -> ChatBuilder<'_> {
        ChatBuilder::new(self, model.into())
    }

    pub async fn models(&self) -> Result<Vec<ModelInfo>> {
        let value: Value = self
            .inner
            .chat()
            .path("/models")
            .map_err(Error::from_sdk)?
            .list_byot()
            .await
            .map_err(Error::from_sdk)?;
        if value.get("object").and_then(Value::as_str) != Some("list") {
            return Err(Error::validation("model catalog must have object: list"));
        }
        let models: Vec<ModelInfo> = serde_json::from_value(
            value
                .get("data")
                .cloned()
                .ok_or_else(|| Error::validation("model catalog is missing data"))?,
        )
        .map_err(|error| Error::validation(error.to_string()))?;
        if models.iter().any(|model| model.id.is_empty()) {
            return Err(Error::validation("model ID must not be empty"));
        }
        Ok(models)
    }

    pub async fn decide(&self, spec: DecisionSpec, input: Value) -> Result<DecisionResponse> {
        let model = spec
            .model
            .as_deref()
            .unwrap_or("openrouter/~typesafe/jev-latest");
        let mut operation = Operation::new("decision", model);
        let result = async {
            let request = spec.request(input)?;
            let wire: Value = self
                .inner
                .chat()
                .path("/systemone")
                .map_err(Error::from_sdk)?
                .create_byot(request)
                .await
                .map_err(Error::from_sdk)?;
            let response = decision::decode(&spec, wire)?;
            operation.metadata(
                response.model.as_deref(),
                None,
                None,
                response.usage.as_ref(),
            );
            Ok(response)
        }
        .instrument(operation.span.clone())
        .await;
        operation.finish(&result);
        result
    }
}

// The SDK hides the sentinel. Observe framing without buffering prompts/responses
// or assuming a finish_reason means the stream completed (AIG.RS-R08).
#[derive(Default)]
struct DoneObserver {
    line: Vec<u8>,
    overflow: bool,
    data: Option<bool>,
}

impl DoneObserver {
    fn observe(&mut self, bytes: &[u8], done: &AtomicBool) {
        for &byte in bytes {
            if byte == b'\n' {
                if self.line.last() == Some(&b'\r') {
                    self.line.pop();
                }
                if !self.overflow && self.line.is_empty() {
                    if self.data == Some(true) {
                        done.store(true, Ordering::Release);
                    }
                    self.data = None;
                } else if self.line.starts_with(b"data:") {
                    let data = self.line[5..].strip_prefix(b" ").unwrap_or(&self.line[5..]);
                    let sentinel = !self.overflow && data == b"[DONE]";
                    self.data = Some(self.data.is_none() && sentinel);
                }
                self.line.clear();
                self.overflow = false;
            } else if self.line.len() < 32 {
                self.line.push(byte);
            } else {
                self.overflow = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_rejects_non_origin_and_redacts_secret() {
        for origin in [
            "https://gateway.example/v1",
            "https://gateway.example?q=1",
            "https://secret@gateway.example",
            "file:///tmp/gateway",
        ] {
            assert!(matches!(
                Client::builder(origin).build(),
                Err(Error::Config { .. })
            ));
        }
        let builder = Client::builder("https://gateway.example/").token("secret-bearer");
        assert!(!format!("{builder:?}").contains("secret-bearer"));
        let client = builder.build().unwrap();
        assert!(!format!("{client:?}").contains("secret-bearer"));
        assert_eq!(
            client.inner.config().api_base(),
            "https://gateway.example/v1"
        );
    }

    #[test]
    fn sentinel_observer_handles_fragmentation_and_event_boundaries() {
        let done = AtomicBool::new(false);
        let mut observer = DoneObserver::default();
        observer.observe(b"data: [DO", &done);
        observer.observe(b"NE]\r\n", &done);
        assert!(!done.load(Ordering::Acquire));
        observer.observe(b"\r\n", &done);
        assert!(done.load(Ordering::Acquire));
    }
}
