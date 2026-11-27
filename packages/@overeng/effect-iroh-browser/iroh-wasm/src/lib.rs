//! Browser bindings for framed iroh connections.
//!
//! Exposes an endpoint that can accept/dial peers and a framed, bidirectional
//! message channel per connection. Application protocols run on top in JS.
//! In the browser iroh only uses relay transports (WebSocket), so two peers
//! meet via the relay URL supplied with the peer address.

use std::sync::Arc;

use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl,
    endpoint::{Connection, QuicTransportConfig, RecvStream, SendStream, VarInt, presets},
};
use n0_future::time::{Duration, timeout};
use tokio::sync::{Mutex, mpsc};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

/// Historical wire identifier, retained for compatibility with deployed peers.
const ALPN: &[u8] = b"schickling-games/automerge-sync/1";
/// Upper bound for a single framed message.
const MAX_FRAME: usize = 8 * 1024 * 1024;

fn js_err(e: impl std::fmt::Display) -> JsValue {
    JsError::new(&e.to_string()).into()
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct IrohNode {
    endpoint: Endpoint,
    incoming: Arc<Mutex<mpsc::Receiver<IrohConn>>>,
}

/// Accepts connections in the background, handshaking each one in its own task so a slow
/// or misbehaving peer can't block others from joining.
fn spawn_acceptor(endpoint: Endpoint) -> mpsc::Receiver<IrohConn> {
    let (tx, rx) = mpsc::channel(16);
    wasm_bindgen_futures::spawn_local(async move {
        while let Some(incoming) = endpoint.accept().await {
            let tx = tx.clone();
            wasm_bindgen_futures::spawn_local(async move {
                let handshake = async {
                    let conn = incoming.await.ok()?;
                    if conn.alpn() != ALPN {
                        conn.close(0u32.into(), b"bad alpn");
                        return None;
                    }
                    let (send, recv) = conn.accept_bi().await.ok()?;
                    Some(IrohConn::new(conn, send, recv))
                };
                if let Ok(Some(conn)) = timeout(Duration::from_secs(15), handshake).await {
                    let _ = tx.send(conn).await;
                }
            });
        }
    });
    rx
}

/// Binds a new endpoint using the given relays (comma-separated URLs). Address lookup is
/// disabled: peers are dialed with the relay URL from the invite link.
///
/// Browsers need relay URLs *without* a trailing dot. iroh's built-in n0 defaults are
/// fully-qualified names ("euc1-1.relay.n0.iroh.link."), which browsers can't use for
/// TLS/WebSocket — the endpoint then never comes online — so the caller passes its own list.
#[wasm_bindgen(js_name = spawnNode)]
pub async fn spawn_node(
    relay_url: Option<String>,
    secret_key: Option<Vec<u8>>,
) -> Result<IrohNode, JsValue> {
    let relays = relay_url
        .ok_or_else(|| js_err("no relay configured"))?
        .split(',')
        .map(|url| url.trim().parse::<RelayUrl>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(js_err)?;
    if relays.is_empty() {
        return Err(js_err("no relay configured"));
    }
    let mut builder = Endpoint::builder(presets::Minimal).relay_mode(RelayMode::custom(relays));
    if let Some(bytes) = secret_key {
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| js_err("secret key must be 32 bytes"))?;
        builder = builder.secret_key(iroh::SecretKey::from_bytes(&bytes));
    }
    // Detect dead peers quickly (e.g. a reloaded tab) so the dialing side reconnects.
    let transport = QuicTransportConfig::builder()
        .keep_alive_interval(std::time::Duration::from_secs(2))
        .max_idle_timeout(Some(VarInt::from_u32(8_000).into()))
        .build();
    builder = builder.transport_config(transport);
    let endpoint = builder.alpns(vec![ALPN.to_vec()]).bind().await.map_err(js_err)?;
    let incoming = Arc::new(Mutex::new(spawn_acceptor(endpoint.clone())));
    Ok(IrohNode { endpoint, incoming })
}

#[wasm_bindgen]
impl IrohNode {
    /// The endpoint id (public key) as a string.
    #[wasm_bindgen(js_name = endpointId)]
    pub fn endpoint_id(&self) -> String {
        self.endpoint.id().to_string()
    }

    /// The endpoint secret key, so a device can keep a stable id across reloads.
    #[wasm_bindgen(js_name = secretKey)]
    pub fn secret_key(&self) -> Vec<u8> {
        self.endpoint.secret_key().to_bytes().to_vec()
    }

    /// Resolves with the home relay URL once connected to a relay.
    #[wasm_bindgen(js_name = homeRelay)]
    pub fn home_relay(&self) -> js_sys::Promise {
        let endpoint = self.endpoint.clone();
        future_to_promise(async move {
            timeout(Duration::from_secs(20), endpoint.online())
                .await
                .map_err(|_| js_err("could not reach a relay server"))?;
            let relay = endpoint.addr().relay_urls().next().map(|u| u.to_string());
            Ok(relay.map(JsValue::from).unwrap_or(JsValue::NULL))
        })
    }

    /// Re-probes connectivity after a browser network change without replacing the endpoint.
    #[wasm_bindgen(js_name = networkChange)]
    pub fn network_change(&self) -> js_sys::Promise {
        let endpoint = self.endpoint.clone();
        future_to_promise(async move {
            endpoint.network_change().await;
            Ok(JsValue::UNDEFINED)
        })
    }

    /// Waits for the next incoming connection. Resolves to `IrohConn` or null if the endpoint closed.
    pub fn accept(&self) -> js_sys::Promise {
        let incoming = self.incoming.clone();
        future_to_promise(async move {
            let conn = incoming.lock().await.recv().await;
            Ok(conn.map(JsValue::from).unwrap_or(JsValue::NULL))
        })
    }

    /// Dials a peer by endpoint id and relay url.
    pub fn connect(&self, endpoint_id: String, relay_url: String) -> js_sys::Promise {
        let endpoint = self.endpoint.clone();
        future_to_promise(async move {
            let id: EndpointId = endpoint_id.parse().map_err(js_err)?;
            let relay: RelayUrl = relay_url.parse().map_err(js_err)?;
            let addr = EndpointAddr::new(id).with_relay_url(relay);
            let dial = async {
                let conn = endpoint.connect(addr, ALPN).await.map_err(js_err)?;
                let streams = conn.open_bi().await.map_err(js_err)?;
                Ok::<_, JsValue>((conn, streams))
            };
            let (conn, (mut send, recv)) = timeout(Duration::from_secs(20), dial)
                .await
                .map_err(|_| js_err("connection timed out"))??;
            // A QUIC stream is only announced to the peer once data is sent.
            send.write_all(&0u32.to_be_bytes()).await.map_err(js_err)?;
            Ok(IrohConn::new(conn, send, recv).into())
        })
    }

    pub fn close(&self) -> js_sys::Promise {
        let endpoint = self.endpoint.clone();
        future_to_promise(async move {
            endpoint.close().await;
            Ok(JsValue::UNDEFINED)
        })
    }
}

/// A framed (u32 length prefix) bidirectional message channel to one peer.
#[wasm_bindgen]
pub struct IrohConn {
    conn: Connection,
    send: Arc<Mutex<SendStream>>,
    recv: Arc<Mutex<RecvStream>>,
}

impl IrohConn {
    fn new(conn: Connection, send: SendStream, recv: RecvStream) -> Self {
        Self { conn, send: Arc::new(Mutex::new(send)), recv: Arc::new(Mutex::new(recv)) }
    }
}

#[wasm_bindgen]
impl IrohConn {
    #[wasm_bindgen(js_name = remoteId)]
    pub fn remote_id(&self) -> String {
        self.conn.remote_id().to_string()
    }

    pub fn send(&self, data: Vec<u8>) -> js_sys::Promise {
        let send = self.send.clone();
        future_to_promise(async move {
            let mut send = send.lock().await;
            let len = u32::try_from(data.len()).map_err(js_err)?;
            send.write_all(&len.to_be_bytes()).await.map_err(js_err)?;
            send.write_all(&data).await.map_err(js_err)?;
            Ok(JsValue::UNDEFINED)
        })
    }

    /// Resolves with the next message (Uint8Array), or null when the peer closed the stream.
    /// Empty frames (used as stream-open marker) are skipped.
    pub fn recv(&self) -> js_sys::Promise {
        let recv = self.recv.clone();
        future_to_promise(async move {
            let mut recv = recv.lock().await;
            loop {
                let mut len = [0u8; 4];
                if recv.read_exact(&mut len).await.is_err() {
                    return Ok(JsValue::NULL);
                }
                let len = u32::from_be_bytes(len) as usize;
                if len == 0 {
                    continue;
                }
                if len > MAX_FRAME {
                    return Err(js_err("frame too large"));
                }
                let mut buf = vec![0u8; len];
                recv.read_exact(&mut buf).await.map_err(js_err)?;
                return Ok(js_sys::Uint8Array::from(buf.as_slice()).into());
            }
        })
    }

    /// Resolves once the connection is closed (by either side or due to an error).
    pub fn closed(&self) -> js_sys::Promise {
        let conn = self.conn.clone();
        future_to_promise(async move {
            let reason = conn.closed().await;
            Ok(JsValue::from(reason.to_string()))
        })
    }

    pub fn close(&self) {
        self.conn.close(0u32.into(), b"bye");
    }
}
