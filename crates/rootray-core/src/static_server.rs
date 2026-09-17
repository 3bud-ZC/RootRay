//! RootRay-owned static file server for `Static Web` targets.
//!
//! A plain HTML/CSS/JS project needs no Node, no package manager and no
//! user-provided server: RootRay serves the workspace itself on an
//! ephemeral loopback port. The server is deliberately small and
//! security-first:
//!
//! - Binds `127.0.0.1` only — never reachable off-machine.
//! - `Host` header must match the bound socket — blocks DNS-rebinding
//!   reads from other origins.
//! - URL space is the *workspace root* (the filesystem security root):
//!   every request is percent-decoded, normalized and canonicalized, and
//!   anything resolving outside the root is a plain 404.
//! - `.html`/`.htm` responses are instrumented (`html_instrument`) and
//!   the inspector bootstrap is appended at document end.
//! - `GET /__rootray/events` is an SSE endpoint the runtime reload client
//!   listens on — Quick Edit saves trigger a full-page reload.
//! - No directory listings, no writes, no methods other than GET/HEAD.

use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const MAX_HEAD_BYTES: usize = 16 * 1024;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_HTML_INSTRUMENT_BYTES: u64 = 8 * 1024 * 1024;
const HEAD_READ_TIMEOUT: Duration = Duration::from_secs(10);
const SSE_PING_INTERVAL: Duration = Duration::from_secs(25);
const MAX_CONNECTIONS: usize = 64;

/// Inspector payload injected into served HTML pages.
pub struct StaticInjection {
    /// JSON literal assigned to `window.__ROOTRAY__`.
    pub bootstrap_json: String,
    /// Bundled inspector-runtime bytes (loaded once at start).
    pub runtime_js: Vec<u8>,
}

struct Ctx {
    /// Canonical serve root — the workspace/security root.
    root: PathBuf,
    /// Target dir relative to root (`""` = root target). `/` redirects to
    /// `/<target_rel>/` so page-relative URLs resolve inside the target.
    target_rel: String,
    injection: Option<StaticInjection>,
    shutdown: Arc<AtomicBool>,
    sse_clients: Arc<Mutex<Vec<Arc<TcpStream>>>>,
    open_conns: Arc<AtomicUsize>,
    port: u16,
}

/// A running static server. `shutdown()` stops the accept loop and drops
/// every SSE client; `Drop` does the same so a forgotten handle can't
/// outlive the session.
pub struct StaticServer {
    ctx: Arc<Ctx>,
    accept: Option<thread::JoinHandle<()>>,
}

impl StaticServer {
    /// Binds and starts serving. `serve_root` is the workspace root —
    /// canonicalized here; `target_rel` is the target's path relative to
    /// it (forward slashes, may be empty).
    pub fn start(
        serve_root: &Path,
        target_rel: &str,
        injection: Option<StaticInjection>,
    ) -> Result<Self, String> {
        let root = serve_root
            .canonicalize()
            .map_err(|e| format!("cannot canonicalize serve root: {e}"))?;
        let root = crate::filesystem::strip_verbatim_pub(&root);
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("cannot bind loopback listener: {e}"))?;
        let addr = listener
            .local_addr()
            .map_err(|e| format!("no local addr: {e}"))?;
        let port = addr.port();

        let ctx = Arc::new(Ctx {
            root,
            target_rel: target_rel.trim_matches('/').to_string(),
            injection,
            shutdown: Arc::new(AtomicBool::new(false)),
            sse_clients: Arc::new(Mutex::new(Vec::new())),
            open_conns: Arc::new(AtomicUsize::new(0)),
            port,
        });

        let accept_ctx = ctx.clone();
        let accept = thread::spawn(move || {
            for conn in listener.incoming() {
                if accept_ctx.shutdown.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = conn else { continue };
                // Bounded concurrency — a hostile local page could spam
                // connections; refuse extras rather than fork-bomb.
                if accept_ctx.open_conns.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                    accept_ctx.open_conns.fetch_sub(1, Ordering::SeqCst);
                    let mut s = stream;
                    let _ = write_response(&mut s, 503, "Service Unavailable", "text/plain", b"busy", false);
                    continue;
                }
                let c = accept_ctx.clone();
                thread::spawn(move || {
                    handle_connection(stream, &c);
                    c.open_conns.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });

        Ok(Self { ctx, accept: Some(accept) })
    }

    pub fn port(&self) -> u16 {
        self.ctx.port
    }

    /// The URL the user browses — for nested targets this redirects to
    /// the target's workspace-relative directory.
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.ctx.port)
    }

    /// Tells every connected inspector runtime to reload the page.
    /// Called after RootRay writes a file (Quick Edit save / revert).
    pub fn notify_reload(&self) {
        let mut clients = match self.ctx.sse_clients.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        clients.retain(|c| {
            let mut s = &**c;
            s.write_all(b"data: reload\n\n").is_ok()
        });
    }

    pub fn shutdown(&self) {
        self.ctx.shutdown.store(true, Ordering::SeqCst);
        // Wake the accept loop with a throwaway connection, and drop all
        // SSE clients so parked handler threads exit.
        let _ = TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], self.ctx.port)));
        if let Ok(mut clients) = self.ctx.sse_clients.lock() {
            for c in clients.drain(..) {
                let _ = c.shutdown(Shutdown::Both);
            }
        }
    }
}

impl Drop for StaticServer {
    fn drop(&mut self) {
        self.shutdown();
        if let Some(j) = self.accept.take() {
            let _ = j.join();
        }
    }
}

// --- request handling ---------------------------------------------------------

fn handle_connection(mut stream: TcpStream, ctx: &Ctx) {
    let _ = stream.set_read_timeout(Some(HEAD_READ_TIMEOUT));
    let head = match read_head(&mut stream) {
        Ok(Some(h)) => h,
        _ => return, // timeout, EOF, or oversized head — close silently
    };
    let req = match parse_request(&head) {
        Ok(r) => r,
        Err(code) => {
            let _ = write_response(&mut stream, code, status_text(code), "text/plain", b"", false);
            return;
        }
    };

    match req.target.as_str() {
        "/__rootray/events" if ctx.injection.is_some() => {
            serve_events(stream, ctx);
        }
        "/__rootray/runtime.js" => {
            match &ctx.injection {
                Some(inj) => {
                    let _ = write_response(
                        &mut stream,
                        200,
                        "OK",
                        "text/javascript; charset=utf-8",
                        &inj.runtime_js,
                        req.head_only,
                    );
                }
                None => {
                    let _ = write_response(&mut stream, 404, "Not Found", "text/plain", b"", false);
                }
            }
        }
        _ if req.target.starts_with("/__rootray/") => {
            let _ = write_response(&mut stream, 404, "Not Found", "text/plain", b"", false);
        }
        _ => serve_file(&mut stream, ctx, &req),
    }
}

struct Request {
    target: String,
    head_only: bool,
    host: Option<String>,
}

fn parse_request(head: &[u8]) -> Result<Request, u16> {
    let text = std::str::from_utf8(head).map_err(|_| 400u16)?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or(400u16)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or(400u16)?;
    let target = parts.next().ok_or(400u16)?;
    let version = parts.next().ok_or(400u16)?;
    if !version.starts_with("HTTP/1") {
        return Err(400);
    }
    let head_only = match method {
        "GET" => false,
        "HEAD" => true,
        _ => return Err(405),
    };
    if !target.starts_with('/') || target.contains('\\') || target.contains('\0') {
        return Err(400);
    }
    let mut host = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("host") {
                host = Some(v.trim().to_string());
            }
        }
    }
    Ok(Request { target: target.to_string(), head_only, host })
}

/// DNS-rebinding guard: the Host header must name this socket. A remote
/// page rebound to 127.0.0.1 would send `Host: attacker.example`.
fn host_allowed(host: &Option<String>, port: u16) -> bool {
    let Some(h) = host else { return false };
    let h = h.trim_end_matches('.');
    let (name, p) = match h.rsplit_once(':') {
        Some((n, p)) => (n, p.parse::<u16>().unwrap_or(0)),
        None => (h, 80),
    };
    p == port && (name.eq_ignore_ascii_case("127.0.0.1") || name.eq_ignore_ascii_case("localhost"))
}

/// Reads until `\r\n\r\n` or the cap. `Ok(None)` = clean EOF/timeout.
fn read_head(stream: &mut TcpStream) -> std::io::Result<Option<Vec<u8>>> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > MAX_HEAD_BYTES {
            return Ok(None);
        }
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            return Ok(Some(buf));
        }
    }
}

// --- static file dispatch -----------------------------------------------------

fn serve_file(stream: &mut TcpStream, ctx: &Ctx, req: &Request) {
    if !host_allowed(&req.host, ctx.port) {
        let _ = write_response(stream, 403, "Forbidden", "text/plain", b"", false);
        return;
    }
    let path_only = req.target.split(['?', '#']).next().unwrap_or("");
    let Some(decoded) = percent_decode(path_only) else {
        let _ = write_response(stream, 400, "Bad Request", "text/plain", b"", false);
        return;
    };
    // Browser-style segment normalization: `..` pops, never escapes.
    let mut segments: Vec<&str> = Vec::new();
    for seg in decoded.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            s => segments.push(s),
        }
    }

    // Nested target: `/` redirects to the target directory so page-
    // relative URLs resolve inside it.
    if segments.is_empty() && !ctx.target_rel.is_empty() {
        let loc = format!("/{}/", ctx.target_rel);
        let head = format!(
            "HTTP/1.1 302 Found\r\nLocation: {loc}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let _ = stream.write_all(head.as_bytes());
        return;
    }

    let mut candidate = ctx.root.clone();
    for s in &segments {
        candidate.push(s);
    }
    let mut resolved = match candidate.canonicalize() {
        Ok(p) => crate::filesystem::strip_verbatim_pub(&p),
        Err(_) => {
            let _ = write_response(stream, 404, "Not Found", "text/plain", b"", false);
            return;
        }
    };
    if !resolved.starts_with(&ctx.root) {
        let _ = write_response(stream, 404, "Not Found", "text/plain", b"", false);
        return;
    }
    if resolved.is_dir() {
        // Directory request without trailing slash → redirect, so
        // relative links inside the index resolve correctly.
        if !path_only.ends_with('/') {
            let loc = format!("{}/", path_only);
            let head = format!(
                "HTTP/1.1 302 Found\r\nLocation: {loc}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(head.as_bytes());
            return;
        }
        resolved = resolved.join("index.html");
        let canon = match resolved.canonicalize() {
            Ok(p) => crate::filesystem::strip_verbatim_pub(&p),
            Err(_) => {
                let _ = write_response(stream, 404, "Not Found", "text/plain", b"", false);
                return;
            }
        };
        if !canon.starts_with(&ctx.root) || !canon.is_file() {
            let _ = write_response(stream, 404, "Not Found", "text/plain", b"", false);
            return;
        }
        resolved = canon;
    }
    if !resolved.is_file() {
        let _ = write_response(stream, 404, "Not Found", "text/plain", b"", false);
        return;
    }
    let size = std::fs::metadata(&resolved).map(|m| m.len()).unwrap_or(0);
    if size > MAX_FILE_BYTES {
        let _ = write_response(stream, 413, "Payload Too Large", "text/plain", b"", false);
        return;
    }
    let bytes = match std::fs::read(&resolved) {
        Ok(b) => b,
        Err(_) => {
            let _ = write_response(stream, 404, "Not Found", "text/plain", b"", false);
            return;
        }
    };

    let ext = resolved
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let is_html = ext == "html" || ext == "htm";
    let (body, mime) = if is_html {
        (instrument_page(&resolved, &bytes, ctx), "text/html; charset=utf-8")
    } else {
        (bytes, mime_type(&ext))
    };
    let _ = write_response(stream, 200, "OK", mime, &body, req.head_only);
}

/// Instruments an HTML page (parser-based, stamped with the
/// workspace-relative path) and appends the inspector bootstrap.
/// Degrades to the raw bytes on non-UTF8 content or parser bail-out.
fn instrument_page(path: &Path, bytes: &[u8], ctx: &Ctx) -> Vec<u8> {
    if bytes.len() as u64 > MAX_HTML_INSTRUMENT_BYTES {
        return bytes.to_vec();
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return bytes.to_vec();
    };
    let rel = path
        .strip_prefix(&ctx.root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| "index.html".to_string());
    let inject = match &ctx.injection {
        Some(inj) => format!(
            "<script>window.__ROOTRAY__={};</script><script src=\"/__rootray/runtime.js\"></script>",
            inj.bootstrap_json.replace("</", "<\\/")
        ),
        None => String::new(),
    };
    match crate::html_instrument::instrument_html(text, &rel, &inject) {
        Ok(out) => out.code.into_bytes(),
        Err(_) => bytes.to_vec(),
    }
}

// --- SSE -----------------------------------------------------------------------

fn serve_events(mut stream: TcpStream, ctx: &Ctx) {
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n: rootray\n\n";
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    let Ok(cloned) = stream.try_clone() else { return };
    let client = Arc::new(cloned);
    if let Ok(mut clients) = ctx.sse_clients.lock() {
        clients.push(client.clone());
    }
    // Park on reads: EOF/error means the client went away; timeouts send
    // a keepalive comment so half-open connections get reaped.
    let _ = stream.set_read_timeout(Some(SSE_PING_INTERVAL));
    let mut buf = [0u8; 512];
    loop {
        if ctx.shutdown.load(Ordering::SeqCst) {
            break;
        }
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                if stream.write_all(b": ping\n\n").is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    // Deregister.
    if let Ok(mut clients) = ctx.sse_clients.lock() {
        clients.retain(|c| !Arc::ptr_eq(c, &client));
    }
}

// --- response + mime ------------------------------------------------------------

fn status_text(code: u16) -> &'static str {
    match code {
        200 => "OK",
        302 => "Found",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

fn write_response(
    stream: &mut TcpStream,
    code: u16,
    reason: &str,
    mime: &str,
    body: &[u8],
    head_only: bool,
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    if !head_only {
        stream.write_all(body)?;
    }
    Ok(())
}

fn mime_type(ext: &str) -> &'static str {
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "ts" => "text/plain; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "wasm" => "application/wasm",
        "xml" => "application/xml; charset=utf-8",
        "pdf" => "application/pdf",
        "webmanifest" => "application/manifest+json",
        "txt" | "md" | "log" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Percent-decode a URL path to a UTF-8 string. `+` stays literal (this
/// is a path, not a query). Invalid sequences → `None` → 400.
fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                if i + 2 >= bytes.len() {
                    return None;
                }
                let hi = hex_val(bytes[i + 1])?;
                let lo = hex_val(bytes[i + 2])?;
                out.push((hi << 4) | lo);
                i += 3;
            }
            b => {
                if b < 0x20 || b == 0x7f {
                    return None; // control bytes never valid in a path
                }
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
