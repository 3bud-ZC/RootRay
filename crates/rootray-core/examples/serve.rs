//! Live static-server smoke — `cargo run -p rootray-core --example serve -- <dir>`.
//! Starts the real RootRay static server with inspector injection on `<dir>`,
//! fetches `/` and `/__rootray/runtime.js` over loopback HTTP, and reports
//! whether authored-HTML stamps and the runtime bootstrap landed.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;

use rootray_core::static_server::{StaticInjection, StaticServer};

fn get(port: u16, path: &str) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut buf = String::new();
    s.read_to_string(&mut buf).unwrap();
    let status = buf
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    (status, buf)
}

fn main() {
    let dir = std::env::args().nth(1).expect("usage: serve <directory>");
    let injection = StaticInjection {
        bootstrap_json: r#"{"mode":"generic-dom","sessionId":"smoke"}"#.to_string(),
        runtime_js: b"/*rootray-runtime-smoke*/".to_vec(),
    };
    let server = StaticServer::start(Path::new(&dir), "", Some(injection)).expect("start");
    let port = server.port();
    println!("url       : {}", server.url());

    let (status, body) = get(port, "/");
    println!("GET /     : {status}");
    println!("  stamped : {}", body.contains("data-rootray-"));
    println!("  runtime : {}", body.contains("/__rootray/runtime.js"));
    println!("  boot    : {}", body.contains("window.__ROOTRAY__"));

    let (status, body) = get(port, "/__rootray/runtime.js");
    println!("GET /__rootray/runtime.js : {status} ({} bytes)", body.len());

    drop(server);
    println!("shutdown  : ok");
}
