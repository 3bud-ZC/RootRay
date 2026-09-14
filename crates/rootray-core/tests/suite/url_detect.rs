use rootray_core::process::url_detect::{detect_local_url, is_safe_local_url};

#[test]
fn detects_vite_local_line() {
    let found = detect_local_url("  ➜  Local:   http://localhost:5173/").unwrap();
    assert_eq!(found.url, "http://localhost:5173/");
    assert_eq!(found.port, Some(5173));
}

#[test]
fn detects_127_0_0_1() {
    let found = detect_local_url("Local: http://127.0.0.1:3000/").unwrap();
    assert_eq!(found.port, Some(3000));
}

#[test]
fn detects_alternate_ports() {
    let found = detect_local_url("ready on http://localhost:4173").unwrap();
    assert_eq!(found.url, "http://localhost:4173/");
    assert_eq!(found.port, Some(4173));
}

#[test]
fn strips_ansi_colors() {
    // Vite prints colored arrows and bold URLs.
    let line = "\x1b[32m➜\x1b[0m  \x1b[1mLocal\x1b[0m:   \x1b[36mhttp://localhost:5173/\x1b[0m";
    let found = detect_local_url(line).unwrap();
    assert_eq!(found.url, "http://localhost:5173/");
}

#[test]
fn prefers_localhost_over_network_url_same_line() {
    let line = "Local: http://localhost:5173/  Network: http://192.168.1.20:5173/";
    let found = detect_local_url(line).unwrap();
    assert_eq!(found.url, "http://localhost:5173/");
}

#[test]
fn rejects_remote_urls() {
    assert!(detect_local_url("Network: http://192.168.1.20:5173/").is_none());
    assert!(detect_local_url("see https://example.com/docs").is_none());
    assert!(detect_local_url("http://evil.localhost.attacker.com").is_none());
}

#[test]
fn ignores_unrelated_lines() {
    assert!(detect_local_url("VITE v7.1.0  ready in 320 ms").is_none());
    assert!(detect_local_url("").is_none());
    assert!(detect_local_url("  ➜  press h + enter to show help").is_none());
    assert!(detect_local_url("port 5173 is in use").is_none());
}

#[test]
fn rejects_non_http_schemes() {
    assert!(detect_local_url("open file:///etc/passwd").is_none());
    assert!(detect_local_url("ftp://localhost:21").is_none());
}

#[test]
fn accepts_ipv6_and_wildcard() {
    assert!(detect_local_url("http://[::1]:5173/").is_some());
    assert!(detect_local_url("http://0.0.0.0:5173/").is_some());
}

#[test]
fn safe_url_gate() {
    assert!(is_safe_local_url("http://localhost:5173/"));
    assert!(!is_safe_local_url("https://github.com"));
    assert!(!is_safe_local_url("http://10.0.0.5:5173"));
    assert!(!is_safe_local_url("not-a-url"));
}
