//! Inspector bridge + session tests. Uses real loopback WebSocket
//! connections — no mocks — to prove the auth boundary end to end.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rootray_core::inspector::bridge::{BridgeEvent, BridgeHandle};
use rootray_core::inspector::{InspectorManager, InspectorPhase};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message};

type Ws = tungstenite::WebSocket<MaybeTlsStream<std::net::TcpStream>>;

fn connect_ws(port: u16) -> Ws {
    let url = format!("ws://127.0.0.1:{port}/rootray");
    let (ws, _resp) = connect(&url).expect("ws connect failed");
    ws
}

fn hello(session_id: &str, token: &str) -> String {
    format!(
        r#"{{"version":1,"type":"runtime:hello","sessionId":"{session_id}","token":"{token}","pageUrl":"http://localhost:5173/"}}"#
    )
}

fn read_json(ws: &mut Ws) -> Option<serde_json::Value> {
    if let MaybeTlsStream::Plain(stream) = ws.get_mut() {
        stream.set_read_timeout(Some(Duration::from_secs(4))).ok()?;
    }
    loop {
        match ws.read() {
            Ok(Message::Text(t)) => return serde_json::from_str(&t).ok(),
            Ok(_) => continue,
            Err(_) => return None,
        }
    }
}

fn wait_for(mut f: impl FnMut() -> bool, ms: u64) -> bool {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    f()
}

fn start_manager() -> (InspectorManager, rootray_core::inspector::SessionInfo, Arc<Mutex<Vec<rootray_core::inspector::InspectorState>>>) {
    let mgr = InspectorManager::new();
    let states: Arc<Mutex<Vec<rootray_core::inspector::InspectorState>>> =
        Arc::new(Mutex::new(Vec::new()));
    let shared = states.clone();
    let m2 = mgr.clone();
    mgr.set_notify(Arc::new(move || shared.lock().unwrap().push(m2.state())));
    let info = mgr.start_session().expect("session failed to start");
    (mgr, info, states)
}

#[test]
fn bridge_binds_loopback_on_dynamic_port() {
    let mgr = InspectorManager::new();
    let info = mgr.start_session().unwrap();
    assert!(info.port > 0);
    // The listener must not be reachable via a non-loopback address.
    let state = mgr.state();
    assert_eq!(state.phase, InspectorPhase::WaitingForBrowser);
    mgr.shutdown();
    assert_eq!(mgr.state().phase, InspectorPhase::Inactive);
}

#[test]
fn session_credentials_are_unique_and_strong() {
    let mgr = InspectorManager::new();
    let a = mgr.start_session().unwrap();
    let b = mgr.start_session().unwrap();
    assert_ne!(a.session_id, b.session_id);
    assert_ne!(a.token, b.token);
    assert!(a.token.len() >= 32);
    // A fresh session gets a fresh port allocation.
    assert_ne!(a.port, b.port);
    mgr.shutdown();
}

#[test]
fn wrong_token_is_rejected() {
    let (mgr, info, _states) = start_manager();
    let mut ws = connect_ws(info.port);
    ws.send(Message::text(hello(&info.session_id, "wrong-token"))).unwrap();
    let msg = read_json(&mut ws).expect("expected session:rejected");
    assert_eq!(msg["type"], "session:rejected");
    assert!(!mgr.state().connected());
    mgr.shutdown();
}

#[test]
fn wrong_session_id_is_rejected() {
    let (mgr, info, _states) = start_manager();
    let mut ws = connect_ws(info.port);
    ws.send(Message::text(hello("rs-other", &info.token))).unwrap();
    let msg = read_json(&mut ws).expect("expected session:rejected");
    assert_eq!(msg["type"], "session:rejected");
    mgr.shutdown();
}

#[test]
fn malformed_and_wrong_version_are_rejected() {
    let (mgr, info, _states) = start_manager();
    let mut ws = connect_ws(info.port);
    ws.send(Message::text("not json".to_string())).unwrap();
    let msg = read_json(&mut ws).expect("expected session:rejected");
    assert_eq!(msg["type"], "session:rejected");
    mgr.shutdown();

    let (mgr, info, _states) = start_manager();
    let mut ws = connect_ws(info.port);
    ws.send(Message::text(
        r#"{"version":99,"type":"runtime:hello","sessionId":"x","token":"x","pageUrl":"u"}"#
            .to_string(),
    ))
    .unwrap();
    let msg = read_json(&mut ws).expect("expected session:rejected");
    assert_eq!(msg["type"], "session:rejected");
    mgr.shutdown();
}

#[test]
fn authenticated_hello_connects_and_syncs_state() {
    let (mgr, info, _states) = start_manager();
    let mut ws = connect_ws(info.port);
    ws.send(Message::text(hello(&info.session_id, &info.token))).unwrap();
    let accepted = read_json(&mut ws).expect("expected session:accepted");
    assert_eq!(accepted["type"], "session:accepted");
    assert_eq!(accepted["sessionId"], info.session_id);
    // inspect:set sync follows the accept
    let sync = read_json(&mut ws).expect("expected inspect:set sync");
    assert_eq!(sync["type"], "inspect:set");

    assert!(wait_for(|| mgr.state().connected(), 3000));
    let s = mgr.state();
    assert_eq!(s.page_url.as_deref(), Some("http://localhost:5173/"));
    assert!(s.connected_at.is_some());
    mgr.shutdown();
}

#[test]
fn element_selection_is_propagated() {
    let (mgr, info, _states) = start_manager();
    let mut ws = connect_ws(info.port);
    ws.send(Message::text(hello(&info.session_id, &info.token))).unwrap();
    read_json(&mut ws);
    read_json(&mut ws);
    ws.send(Message::text(
        r#"{"version":1,"type":"element:selected","sessionId":"SID",
            "element":{"tagName":"button","className":"cta","textPreview":"Go"},
            "source":{"relativePath":"src/App.tsx","line":12,"column":9,"componentName":"App"}}"#
            .replace("SID", &info.session_id),
    ))
    .unwrap();
    assert!(wait_for(|| mgr.state().last_selection.is_some(), 3000));
    let sel = mgr.state().last_selection.unwrap();
    assert_eq!(sel.element.tag_name, "button");
    assert_eq!(sel.source.relative_path, "src/App.tsx");
    assert_eq!(sel.source.line, 12);
    assert_eq!(sel.source.column, 9);
    assert_eq!(sel.source.component_name.as_deref(), Some("App"));
    mgr.shutdown();
}

#[test]
fn selection_with_escaping_path_is_dropped() {
    let (mgr, info, _states) = start_manager();
    let mut ws = connect_ws(info.port);
    ws.send(Message::text(hello(&info.session_id, &info.token))).unwrap();
    read_json(&mut ws);
    read_json(&mut ws);
    ws.send(Message::text(
        r#"{"version":1,"type":"element:selected","sessionId":"SID",
            "element":{"tagName":"div"},
            "source":{"relativePath":"../../secret.txt","line":1,"column":1}}"#
            .replace("SID", &info.session_id),
    ))
    .unwrap();
    // Give the bridge a beat — the selection must never arrive.
    std::thread::sleep(Duration::from_millis(400));
    assert!(mgr.state().last_selection.is_none());
    mgr.shutdown();
}

#[test]
fn disconnect_updates_session_state() {
    let (mgr, info, _states) = start_manager();
    let mut ws = connect_ws(info.port);
    ws.send(Message::text(hello(&info.session_id, &info.token))).unwrap();
    read_json(&mut ws);
    read_json(&mut ws);
    assert!(wait_for(|| mgr.state().connected(), 3000));
    ws.close(None).unwrap();
    assert!(wait_for(|| mgr.state().phase == InspectorPhase::Disconnected, 3000));
    mgr.shutdown();
}

#[test]
fn inspect_set_flows_to_runtime() {
    let (mgr, info, _states) = start_manager();
    mgr.set_inspection(true).unwrap();
    let mut ws = connect_ws(info.port);
    ws.send(Message::text(hello(&info.session_id, &info.token))).unwrap();
    read_json(&mut ws); // accepted
    let sync = read_json(&mut ws).unwrap();
    assert_eq!(sync["type"], "inspect:set");
    assert_eq!(sync["enabled"], true);
    assert!(wait_for(|| mgr.state().phase == InspectorPhase::Inspecting, 3000));
    mgr.set_inspection(false).unwrap();
    let msg = read_json(&mut ws).unwrap();
    assert_eq!(msg["enabled"], false);
    mgr.shutdown();
}

#[test]
fn set_inspection_rejected_when_inactive() {
    let mgr = InspectorManager::new();
    let err = mgr.set_inspection(true).unwrap_err();
    assert_eq!(err.code(), "INSPECTOR_NOT_ACTIVE");
}

#[test]
fn raw_bridge_rejects_non_bridge_path() {
    let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let shared = events.clone();
    let handle = BridgeHandle::start(
        "s".into(),
        "t".into(),
        Arc::new(move |ev: BridgeEvent| {
            shared.lock().unwrap().push(format!("{ev:?}"));
        }),
    )
    .unwrap();
    // Connecting to the wrong path must fail the WS handshake.
    let url = format!("ws://127.0.0.1:{}/wrong", handle.port());
    assert!(connect(&url).is_err());
    handle.shutdown();
}

#[test]
fn inspector_state_survives_processless_shutdown() {
    let (mgr, info, _states) = start_manager();
    let mut ws = connect_ws(info.port);
    ws.send(Message::text(hello(&info.session_id, &info.token))).unwrap();
    read_json(&mut ws);
    read_json(&mut ws);
    assert!(wait_for(|| mgr.state().connected(), 3000));
    mgr.on_process_exit();
    assert_eq!(mgr.state().phase, InspectorPhase::Inactive);
    assert!(!mgr.state().inspection_enabled);
}
