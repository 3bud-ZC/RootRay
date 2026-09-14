//! Loopback-only, token-authenticated WebSocket bridge.
//!
//! Security contract:
//! - binds `127.0.0.1` only — never a LAN interface
//! - OS-assigned dynamic port — nothing fixed to scan for
//! - the browser must authenticate with the ephemeral session token as its
//!   first message before any inspector event is accepted
//! - malformed frames, wrong versions, wrong tokens → rejected and closed
//! - browser messages are *data only*: they can never execute commands,
//!   touch the filesystem, or reach launchers

use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tungstenite::handshake::server::{Request, Response};
use tungstenite::{accept_hdr, Error, Message, WebSocket};

use super::protocol::{
    parse_runtime_message, BridgeMessage, RuntimeMessage, BRIDGE_PATH,
};
use crate::error::{CoreError, CoreResult};

/// Events the bridge reports upward into the session manager.
#[derive(Debug)]
pub enum BridgeEvent {
    Connected { page_url: String },
    Disconnected,
    Selection(crate::inspector::protocol::ElementSelection),
    /// Runtime asked to change inspection (Escape key).
    InspectRequested { enabled: bool },
}

pub type BridgeEventSink = Arc<dyn Fn(BridgeEvent) + Send + Sync>;

type Ws = WebSocket<TcpStream>;

struct Client {
    ws: Arc<Mutex<Ws>>,
    generation: u64,
}

struct Shared {
    session_id: String,
    token: String,
    shutdown: AtomicBool,
    /// Monotonic client generation — a new authenticated connection
    /// replaces the old one (page reloads, reconnects).
    client_gen: AtomicU64,
    client: Mutex<Option<Client>>,
    inspect_enabled: AtomicBool,
    on_event: BridgeEventSink,
}

/// A live bridge. Dropping it does not stop the listener — call
/// [`BridgeHandle::shutdown`].
pub struct BridgeHandle {
    port: u16,
    shared: Arc<Shared>,
    accept_thread: Mutex<Option<thread::JoinHandle<()>>>,
}

const READ_TIMEOUT: Duration = Duration::from_millis(150);
const HELLO_DEADLINE: Duration = Duration::from_secs(8);

impl BridgeHandle {
    /// Binds the loopback listener and starts accepting connections.
    pub fn start(
        session_id: String,
        token: String,
        on_event: BridgeEventSink,
    ) -> CoreResult<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| {
            CoreError::InspectorBridgeStartFailed(format!("bind failed: {e}"))
        })?;
        let port = listener.local_addr().map_err(|e| {
            CoreError::InspectorBridgeStartFailed(e.to_string())
        })?.port();
        listener.set_nonblocking(true).map_err(|e| {
            CoreError::InspectorBridgeStartFailed(e.to_string())
        })?;

        let shared = Arc::new(Shared {
            session_id,
            token,
            shutdown: AtomicBool::new(false),
            client_gen: AtomicU64::new(0),
            client: Mutex::new(None),
            inspect_enabled: AtomicBool::new(false),
            on_event,
        });

        let accept_shared = shared.clone();
        let accept_thread = thread::spawn(move || accept_loop(listener, accept_shared));

        Ok(Self {
            port,
            shared,
            accept_thread: Mutex::new(Some(accept_thread)),
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Sends the authoritative inspection flag to the connected runtime.
    /// Returns false when no client is connected (the flag is still stored
    /// and delivered on connect).
    pub fn send_inspect(&self, enabled: bool) -> bool {
        self.shared.inspect_enabled.store(enabled, Ordering::SeqCst);
        let client = self.shared.client.lock().ok().and_then(|g| {
            g.as_ref().map(|c| c.ws.clone())
        });
        match client {
            Some(ws) => {
                let msg = BridgeMessage::InspectSet { enabled }.to_json();
                if let Ok(mut guard) = ws.lock() {
                    guard.send(Message::text(msg)).is_ok()
                } else {
                    false
                }
            }
            None => false,
        }
    }

    pub fn has_client(&self) -> bool {
        self.shared
            .client
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
    }

    /// Stops the listener and drops the active client.
    pub fn shutdown(&self) {
        self.shared.shutdown.store(true, Ordering::SeqCst);
        if let Ok(mut client) = self.shared.client.lock() {
            if let Some(c) = client.take() {
                if let Ok(mut ws) = c.ws.lock() {
                    let _ = ws.close(None);
                }
            }
        }
        if let Ok(mut slot) = self.accept_thread.lock() {
            if let Some(join) = slot.take() {
                // The accept loop polls the flag every ~25ms.
                let _ = join.join();
            }
        }
    }
}

impl Drop for BridgeHandle {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::SeqCst);
    }
}

fn accept_loop(listener: TcpListener, shared: Arc<Shared>) {
    while !shared.shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, peer)) => {
                if !peer.ip().is_loopback() {
                    continue; // defense in depth — listener is loopback-only anyway
                }
                let shared = shared.clone();
                thread::spawn(move || handle_connection(stream, shared));
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => thread::sleep(Duration::from_millis(25)),
        }
    }
}

fn handle_connection(stream: TcpStream, shared: Arc<Shared>) {
    if stream.set_read_timeout(Some(READ_TIMEOUT)).is_err() {
        return;
    }

    // --- HTTP/WS handshake, restricted to the bridge path ---------------
    let ws = accept_hdr(stream, |req: &Request, resp: Response| {
        if req.uri().path() == BRIDGE_PATH {
            Ok(resp)
        } else {
            Err(Response::builder().status(404).body(None).unwrap())
        }
    });
    let mut ws = match ws {
        Ok(ws) => ws,
        Err(_) => return,
    };

    // --- First message must authenticate the session --------------------
    let deadline = Instant::now() + HELLO_DEADLINE;
    let page_url = loop {
        if Instant::now() > deadline || shared.shutdown.load(Ordering::SeqCst) {
            return;
        }
        match ws.read() {
            Ok(Message::Text(text)) => match parse_runtime_message(&text) {
                Ok(RuntimeMessage::Hello { session_id, token, page_url })
                    if session_id == shared.session_id && token == shared.token =>
                {
                    break page_url;
                }
                _ => {
                    let _ = ws.send(Message::text(
                        BridgeMessage::SessionRejected {
                            reason: "authentication failed".to_string(),
                        }
                        .to_json(),
                    ));
                    let _ = ws.close(None);
                    return;
                }
            },
            Ok(Message::Close(_)) | Err(Error::ConnectionClosed) => return,
            Ok(_) => {}
            Err(Error::Io(e))
                if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => return,
        }
    };

    // --- Authenticated: accept session, sync inspect state --------------
    let _ = ws.send(Message::text(
        BridgeMessage::SessionAccepted {
            session_id: shared.session_id.clone(),
        }
        .to_json(),
    ));
    let _ = ws.send(Message::text(
        BridgeMessage::InspectSet {
            enabled: shared.inspect_enabled.load(Ordering::SeqCst),
        }
        .to_json(),
    ));

    let ws = Arc::new(Mutex::new(ws));
    let generation = shared.client_gen.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut slot) = shared.client.lock() {
        *slot = Some(Client { ws: ws.clone(), generation });
    }
    (shared.on_event)(BridgeEvent::Connected { page_url });

    // --- Message loop -----------------------------------------------------
    loop {
        if shared.shutdown.load(Ordering::SeqCst)
            || shared.client_gen.load(Ordering::SeqCst) != generation
        {
            break; // replaced by a newer connection or shutting down
        }
        let read = {
            let mut guard = match ws.lock() {
                Ok(g) => g,
                Err(_) => break,
            };
            guard.read()
        };
        match read {
            Ok(Message::Text(text)) => {
                if !handle_text(&text, &shared) {
                    break;
                }
            }
            Ok(Message::Close(_)) | Err(Error::ConnectionClosed) => break,
            Ok(_) => {}
            Err(Error::Io(e))
                if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => break,
        }
    }

    // Only report a disconnect if we are still the active client — a
    // replaced connection's exit is not a disconnection.
    if shared.client_gen.load(Ordering::SeqCst) == generation {
        if let Ok(mut slot) = shared.client.lock() {
            if slot.as_ref().is_some_and(|c| c.generation == generation) {
                *slot = None;
            }
        }
        (shared.on_event)(BridgeEvent::Disconnected);
    }
}

/// Returns false when the connection should be closed.
fn handle_text(text: &str, shared: &Arc<Shared>) -> bool {
    match parse_runtime_message(text) {
        Ok(RuntimeMessage::Ready { session_id }) => session_id == shared.session_id,
        Ok(RuntimeMessage::ElementSelected { session_id, selection }) => {
            if session_id == shared.session_id {
                (shared.on_event)(BridgeEvent::Selection(selection));
            }
            true
        }
        Ok(RuntimeMessage::InspectSet { enabled }) => {
            shared.inspect_enabled.store(enabled, Ordering::SeqCst);
            (shared.on_event)(BridgeEvent::InspectRequested { enabled });
            true
        }
        Ok(RuntimeMessage::Hello { .. }) => true, // duplicate hello — ignore
        Err(_) => {
            // Malformed frames from an authenticated client: reject, keep
            // the session alive — the runtime may recover.
            true
        }
    }
}
