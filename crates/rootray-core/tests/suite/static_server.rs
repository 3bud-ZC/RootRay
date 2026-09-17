//! Static-server tests — loopback HTTP, traversal/escape safety,
//! in-memory instrumentation and SSE reload.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rootray_core::static_server::{StaticInjection, StaticServer};
use rootray_core::state::RuntimePhase;
use rootray_core::{AppCore, CoreError};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn write(dir: &Path, rel: &str, content: &str) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, content).unwrap();
}

/// Sends a raw request and reads the whole response (Connection: close).
fn request(port: u16, raw: &str) -> String {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    s.write_all(raw.as_bytes()).unwrap();
    let _ = s.shutdown(std::net::Shutdown::Write);
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).unwrap();
    String::from_utf8_lossy(&buf).to_string()
}

fn get(port: u16, path: &str) -> String {
    request(
        port,
        &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
    )
}

fn response_body(resp: &str) -> &str {
    resp.split("\r\n\r\n").nth(1).unwrap_or("")
}

#[test]
fn serves_index_and_instruments_authored_html() {
    let tmp = tempfile::tempdir().unwrap();
    write(
        tmp.path(),
        "index.html",
        "<!doctype html>\n<html>\n<body>\n  <h1 id=\"t\">Hi</h1>\n</body>\n</html>",
    );
    let server = StaticServer::start(tmp.path(), "", None).unwrap();
    let resp = get(server.port(), "/");
    assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
    let body = response_body(&resp);
    assert!(
        body.contains("data-rootray-file=\"index.html\" data-rootray-line=\"4\" data-rootray-column=\"3\""),
        "{body}"
    );
    // html/body never stamped.
    assert!(!body.contains("<html data-rootray"));
    // No injection configured → no bootstrap.
    assert!(!body.contains("__ROOTRAY__"));
    assert!(resp.contains("X-Content-Type-Options: nosniff"));
}

#[test]
fn nested_target_redirects_root_and_serves_index() {
    let tmp = tempfile::tempdir().unwrap();
    write(tmp.path(), "site/index.html", "<html><body><p>hi</p></body></html>");
    write(tmp.path(), "site/app.js", "console.log(1);");
    let server = StaticServer::start(tmp.path(), "site", None).unwrap();
    let port = server.port();

    let root = get(port, "/");
    assert!(root.contains("302"), "{root}");
    assert!(root.contains("Location: /site/"), "{root}");

    // Directory without trailing slash redirects too.
    let dir = get(port, "/site");
    assert!(dir.contains("Location: /site/"), "{dir}");

    let index = get(port, "/site/");
    assert!(response_body(&index).contains("data-rootray-file=\"site/index.html\""));
    let js = get(port, "/site/app.js");
    assert!(response_body(&js).contains("console.log(1);"));
    // Non-HTML is served byte-exact — never instrumented.
    assert!(!response_body(&js).contains("rootray"));
}

#[test]
fn traversal_and_escapes_are_refused() {
    let tmp = tempfile::tempdir().unwrap();
    write(tmp.path(), "index.html", "<p>x</p>");
    write(tmp.path(), "sub/secret.txt", "hunter2");
    let server = StaticServer::start(tmp.path(), "", None).unwrap();
    let port = server.port();

    for path in [
        "/../../Cargo.toml",
        "/%2e%2e/%2e%2e/Cargo.toml",
        "/..%2f..%2fCargo.toml",
        "/%2e%2e%5c%2e%2e%5cCargo.toml",
        "/sub/../../outside.txt",
        "/index.html%00.txt",
    ] {
        let resp = get(port, path);
        assert!(
            resp.starts_with("HTTP/1.1 404") || resp.starts_with("HTTP/1.1 400"),
            "{path} → {}",
            resp.lines().next().unwrap_or("")
        );
    }
    // Backslash in the request target is rejected outright.
    let resp = request(
        port,
        &format!("GET /sub\\..\\secret.txt HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
    );
    assert!(resp.starts_with("HTTP/1.1 400"), "{resp}");
}

#[test]
fn non_ascii_and_percent_paths_decode() {
    let tmp = tempfile::tempdir().unwrap();
    write(tmp.path(), "index.html", "<p>x</p>");
    write(tmp.path(), "a b.txt", "spaced");
    let server = StaticServer::start(tmp.path(), "", None).unwrap();
    let resp = get(server.port(), "/a%20b.txt");
    assert!(response_body(&resp).contains("spaced"), "{resp}");
}

#[cfg(windows)]
#[test]
fn junction_escape_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    write(tmp.path(), "index.html", "<p>x</p>");
    write(outside.path(), "secret.txt", "hunter2");
    // Junctions work without privileges on Windows.
    if std::os::windows::fs::symlink_dir(outside.path(), tmp.path().join("link")).is_err() {
        return; // no privilege — can't build the trap, skip
    }
    let server = StaticServer::start(tmp.path(), "", None).unwrap();
    let resp = get(server.port(), "/link/secret.txt");
    assert!(resp.starts_with("HTTP/1.1 404"), "{resp}");
}

#[test]
fn host_header_must_match_socket() {
    let tmp = tempfile::tempdir().unwrap();
    write(tmp.path(), "index.html", "<p>x</p>");
    let server = StaticServer::start(tmp.path(), "", None).unwrap();
    let port = server.port();
    // DNS-rebinding: a foreign host name is refused even on loopback.
    let resp = request(
        port,
        "GET /index.html HTTP/1.1\r\nHost: evil.example\r\n\r\n",
    );
    assert!(resp.starts_with("HTTP/1.1 403"), "{resp}");
    // localhost:port is accepted (browsers may resolve it locally).
    let resp = request(
        port,
        &format!("GET /index.html HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n"),
    );
    assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
    // Missing Host → 403.
    let resp = request(port, "GET /index.html HTTP/1.1\r\n\r\n");
    assert!(resp.starts_with("HTTP/1.1 403"), "{resp}");
}

#[test]
fn methods_and_head_requests() {
    let tmp = tempfile::tempdir().unwrap();
    write(tmp.path(), "index.html", "<p>x</p>");
    let server = StaticServer::start(tmp.path(), "", None).unwrap();
    let port = server.port();

    let post = request(
        port,
        &format!("POST /index.html HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
    );
    assert!(post.starts_with("HTTP/1.1 405"), "{post}");

    let head = request(
        port,
        &format!("HEAD /index.html HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
    );
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert_eq!(response_body(&head), "");
    assert!(head.contains("Content-Length:"));

    let missing = get(port, "/nope.css");
    assert!(missing.starts_with("HTTP/1.1 404"));
}

#[test]
fn inspector_injection_serves_runtime_and_bootstrap() {
    let tmp = tempfile::tempdir().unwrap();
    write(tmp.path(), "index.html", "<html><body><canvas id=\"c\"></canvas></body></html>");
    let inj = StaticInjection {
        bootstrap_json: "{\"mode\":\"generic-dom\",\"reloadUrl\":\"/__rootray/events\"}".into(),
        runtime_js: b"/* rootray runtime */".to_vec(),
    };
    let server = StaticServer::start(tmp.path(), "", Some(inj)).unwrap();
    let port = server.port();

    let page = get(port, "/");
    let body = response_body(&page);
    assert!(body.contains("window.__ROOTRAY__={\"mode\":\"generic-dom\""), "{body}");
    assert!(body.contains("src=\"/__rootray/runtime.js\""), "{body}");
    assert!(body.contains("<canvas"), "{body}");
    assert!(body.contains("data-rootray-file=\"index.html\""), "{body}");

    let rt = get(port, "/__rootray/runtime.js");
    assert!(response_body(&rt).contains("rootray runtime"), "{rt}");

    // Without injection configured the reserved paths 404.
    let plain = StaticServer::start(tmp.path(), "", None).unwrap();
    let resp = get(plain.port(), "/__rootray/runtime.js");
    assert!(resp.starts_with("HTTP/1.1 404"));
    let resp = get(plain.port(), "/__rootray/events");
    assert!(resp.starts_with("HTTP/1.1 404"));
    // Reserved prefix never maps to a file even if one exists on disk.
    write(tmp.path(), "__rootray/secret.txt", "nope");
    let resp = get(port, "/__rootray/secret.txt");
    assert!(resp.starts_with("HTTP/1.1 404"), "{resp}");
}

#[test]
fn sse_clients_receive_reload() {
    let tmp = tempfile::tempdir().unwrap();
    write(tmp.path(), "index.html", "<p>x</p>");
    let inj = StaticInjection {
        bootstrap_json: "{}".into(),
        runtime_js: Vec::new(),
    };
    let server = StaticServer::start(tmp.path(), "", Some(inj)).unwrap();
    let port = server.port();

    let mut sse = TcpStream::connect(("127.0.0.1", port)).unwrap();
    sse.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    sse.write_all(
        format!("GET /__rootray/events HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes(),
    )
    .unwrap();
    // Read the response head + initial comment.
    let mut got = Vec::new();
    while !got.windows(4).any(|w| w == b"\r\n\r\n") {
        let mut b = [0u8; 256];
        let n = sse.read(&mut b).unwrap();
        got.extend_from_slice(&b[..n]);
    }
    let head = String::from_utf8_lossy(&got);
    assert!(head.contains("text/event-stream"), "{head}");

    // Give the handler thread a moment to register the client.
    std::thread::sleep(Duration::from_millis(100));
    server.notify_reload();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 256];
    while !buf.windows(12).any(|w| w == b"data: reload") {
        let n = sse.read(&mut chunk).unwrap();
        assert!(n > 0, "connection closed before reload arrived");
        buf.extend_from_slice(&chunk[..n]);
    }
}

// --- AppCore integration ------------------------------------------------------

fn noop_sink() -> std::sync::Arc<dyn Fn(rootray_core::process::ProcessEvent) + Send + Sync> {
    std::sync::Arc::new(|_| {})
}

#[test]
fn appcore_runs_static_target_without_a_dev_script() {
    let dir = tempfile::tempdir().unwrap();
    let core = AppCore::new(dir.path());
    core.analyze(&fixtures().join("static-web")).unwrap();
    let s = core.state();
    assert_eq!(s.phase, RuntimePhase::Ready);
    assert_eq!(
        s.workspace.as_ref().unwrap().active_target().unwrap().framework,
        rootray_core::project::Framework::StaticWeb
    );

    // No selected_runner — the RootRay server still runs the target.
    let url_port = core.start_dev_server(noop_sink(), false).unwrap();
    assert_ne!(url_port, 0);
    let s = core.state();
    assert_eq!(s.phase, RuntimePhase::Running);
    let url = s.url.unwrap();
    assert!(url.starts_with("http://127.0.0.1:"), "{url}");
    assert_eq!(s.pid, None); // in-process — honest: no pid

    // Serve check: the fixture index is instrumented.
    let resp = get(url_port as u16, "/");
    assert!(response_body(&resp).contains("data-rootray-file=\"index.html\""), "{resp}");

    core.stop_dev_server().unwrap();
    let s = core.state();
    assert_eq!(s.phase, RuntimePhase::Stopped);
    // Port is closed now.
    assert!(TcpStream::connect(("127.0.0.1", url_port as u16)).is_err());
}

#[test]
fn appcore_static_target_with_inspector_enabled() {
    // The real UI always runs with inspector enabled — the injection path
    // (bridge session + runtime asset + bootstrap) must not stall the run.
    let dir = tempfile::tempdir().unwrap();
    let core = std::sync::Arc::new(AppCore::new(dir.path()));
    core.analyze(&fixtures().join("static-web")).unwrap();

    // Ordering contract: the sink re-emits a `core.state()` snapshot per
    // event — by the time UrlDetected fires, the snapshot must already be
    // Running with the URL set, or the UI never leaves "starting".
    let core_ref = core.clone();
    let sink = std::sync::Arc::new(move |ev: rootray_core::process::ProcessEvent| {
        if let rootray_core::process::ProcessEvent::UrlDetected { url, .. } = ev {
            let snap = core_ref.state();
            assert_eq!(snap.phase, RuntimePhase::Running);
            assert_eq!(snap.url.as_deref(), Some(url.as_str()));
        }
    });
    let url_port = core.start_dev_server(sink, true).unwrap();
    let s = core.state();
    assert_eq!(s.phase, RuntimePhase::Running);
    let url = s.url.unwrap();
    assert!(url.starts_with("http://127.0.0.1:"), "{url}");

    let resp = get(url_port as u16, "/");
    let body = response_body(&resp);
    assert!(body.contains("data-rootray-file=\"index.html\""), "{body}");
    assert!(body.contains("window.__ROOTRAY__"), "{body}");
    assert!(body.contains("\"mode\":\"generic-dom\""), "{body}");
    assert!(body.contains("/__rootray/events"), "{body}");

    core.stop_dev_server().unwrap();
}

#[test]
fn static_target_reports_inspection_capabilities() {
    let dir = tempfile::tempdir().unwrap();
    let core = AppCore::new(dir.path());
    let a = core.analyze(&fixtures().join("static-web")).unwrap();
    let t = a.active_target().unwrap();
    use rootray_core::project::CapabilityState::*;
    assert_eq!(t.capabilities.run.state, Available);
    assert_eq!(t.capabilities.browser_open.state, Available);
    assert_eq!(t.capabilities.dom_inspect.state, Available);
    assert_eq!(t.capabilities.style_inspect.state, Available);
    assert_eq!(t.capabilities.source_mapping.state, Partial);
    assert_eq!(t.capabilities.component_intelligence.state, NotApplicable);
}

#[test]
fn second_start_while_static_running_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let core = AppCore::new(dir.path());
    core.analyze(&fixtures().join("static-web")).unwrap();
    core.start_dev_server(noop_sink(), false).unwrap();
    let e = core.start_dev_server(noop_sink(), false).unwrap_err();
    assert!(matches!(e, CoreError::ProcessAlreadyRunning));
    core.stop_dev_server().unwrap();
}

#[test]
fn nested_static_target_runs_from_subdirectory() {
    let dir = tempfile::tempdir().unwrap();
    let core = AppCore::new(dir.path());
    let a = core.analyze(&fixtures().join("nested-static")).unwrap();
    // The site lives in `app/` — its own target, served under /app/.
    let t = a.active_target().unwrap();
    assert_eq!(t.id, "app");
    assert_eq!(t.framework, rootray_core::project::Framework::StaticWeb);

    let port = core.start_dev_server(noop_sink(), false).unwrap() as u16;
    // Root redirects into the target dir so relative URLs resolve.
    let root = get(port, "/");
    assert!(root.contains("Location: /app/"), "{root}");
    let page = get(port, "/app/");
    assert!(
        response_body(&page).contains("data-rootray-file=\"app/index.html\""),
        "{page}"
    );
    // A sibling file outside the target dir but inside the workspace is
    // still reachable — the serve root is the security root.
    let css = get(port, "/app/styles.css");
    assert!(response_body(&css).contains("font-family"));
    core.stop_dev_server().unwrap();
}
