//! Localhost URL detection from dev-server output.
//!
//! Isolated and pure so it can be exhaustively tested. Only loopback
//! http(s) URLs are ever returned — remote/LAN URLs are rejected.

use url::Url;

/// A URL discovered in server output, with its port pre-extracted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedUrl {
    pub url: String,
    pub port: Option<u16>,
}

/// Scans one output line for a browsable loopback URL.
/// Handles ANSI-colored output, `Local:`/`Network:` prefixes and the
/// common shapes Vite prints.
pub fn detect_local_url(line: &str) -> Option<DetectedUrl> {
    let clean = strip_ansi(line);
    let mut best: Option<DetectedUrl> = None;
    for token in clean.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>')) {
        // Strip wrapper punctuation but never `[`/`]` inside the token —
        // IPv6 literals like http://[::1]:5173/ need them.
        let token = token
            .trim_start_matches(['[', '('])
            .trim_end_matches(|c: char| matches!(c, ',' | ';' | '.' | '!' | '?' | '\''));
        if !(token.starts_with("http://") || token.starts_with("https://")) {
            continue;
        }
        // Wrapper brackets: prefer the trimmed form (markdown `[url]`), but
        // keep IPv6 literals working when the token *is* the bracketed host.
        let found = if token.ends_with(']') || token.ends_with(')') {
            validate(token.trim_end_matches([')', ']'])).or_else(|| validate(token))
        } else {
            validate(token)
        };
        if let Some(found) = found {
            // Prefer explicit localhost over wildcard/other loopback forms.
            let prefer = token.to_ascii_lowercase().contains("localhost");
            match &best {
                None => best = Some(found),
                Some(existing) if prefer && !existing.url.contains("localhost") => {
                    best = Some(found)
                }
                _ => {}
            }
        }
    }
    best
}

/// Validates a raw URL string: http(s) scheme + loopback host only.
pub fn validate(raw: &str) -> Option<DetectedUrl> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    let host = url.host_str()?;
    if !is_loopback_host(host) {
        return None;
    }
    Some(DetectedUrl { url: url.to_string(), port: url.port_or_known_default() })
}

/// Gate for launch actions: only loopback URLs may be opened.
pub fn is_safe_local_url(raw: &str) -> bool {
    validate(raw).is_some()
}

fn is_loopback_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") {
        return true;
    }
    if lower == "0.0.0.0" {
        // Wildcard bind address — reachable locally, never remote.
        return true;
    }
    if lower == "::1" || lower == "[::1]" {
        return true;
    }
    // 127.0.0.0/8
    if let Some(rest) = lower.strip_prefix("127.") {
        return rest
            .split('.')
            .all(|o| !o.is_empty() && o.parse::<u8>().is_ok())
            && rest.split('.').count() == 3;
    }
    false
}

/// Removes ANSI CSI escape sequences (colors, cursor movement).
/// `strip-ansi-escapes` would work too; this keeps the dep tree tiny.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.next() {
                Some('[') => {
                    // CSI: consume until a byte in 0x40..=0x7E
                    for inner in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&inner) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // OSC: consume until BEL or ST
                    let iter = chars.by_ref();
                    while let Some(inner) = iter.next() {
                        if inner == '\u{07}' {
                            break;
                        }
                        if inner == '\u{1b}' && iter.next() == Some('\\') {
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ansi_strip_handles_csi_and_osc() {
        assert_eq!(strip_ansi("\u{1b}[1;36mhi\u{1b}[0m"), "hi");
        assert_eq!(strip_ansi("\u{1b}]8;;http://x\u{1b}\\link\u{1b}]8;;\u{1b}\\"), "link");
    }

    #[test]
    fn bracket_wrapped_urls_are_unwrapped() {
        let found = detect_local_url("[http://localhost:5173/]").unwrap();
        assert_eq!(found.url, "http://localhost:5173/");
    }
}
