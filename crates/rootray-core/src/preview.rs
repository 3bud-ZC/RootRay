//! Embedded preview policy — the pure, testable half of the integrated
//! browser workbench. The Tauri shell owns the actual WebView2 child;
//! this module decides what it may load and models its lifecycle.
//!
//! Security posture: the preview is a browser for *untrusted* project
//! content. Main-frame navigation is restricted to loopback http(s)
//! URLs — the same rule the external `open_browser` path enforces.
//! Everything else is either opened in the system browser (remote
//! http(s), where it can never reach RootRay's IPC) or refused.

use serde::Serialize;

use crate::process::url_detect::is_safe_local_url;

/// Preview lifecycle — kept distinct from runtime and inspector state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewPhase {
    /// No preview exists (nothing run yet, or workspace changed).
    Hidden,
    /// The app is starting; no URL has been detected yet.
    Waiting,
    /// A URL was detected and the webview is being created/navigating.
    Loading,
    /// The project page finished loading.
    Ready,
    /// Creation or navigation failed — `error` carries the reason.
    Error,
    /// The dev server stopped; the surface was torn down.
    Stopped,
}

/// Snapshot pushed to the UI on every preview transition.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewState {
    pub phase: PreviewPhase,
    /// Current page URL when known — the toolbar's display source.
    pub url: Option<String>,
    /// Last load/creation failure detail, human-readable.
    pub error: Option<String>,
    /// Monotonic generation — guards the UI against stale updates.
    pub generation: u64,
}

impl Default for PreviewState {
    fn default() -> Self {
        Self {
            phase: PreviewPhase::Hidden,
            url: None,
            error: None,
            generation: 0,
        }
    }
}

/// What the preview's navigation policy decided for one URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationDecision {
    /// Loopback http(s) — allowed inside the preview.
    Allow,
    /// Remote http(s) — refused in-preview; safe to hand to the system
    /// browser, which has no RootRay privileges.
    ExternalBrowser,
    /// Anything else (file:, javascript:, data:, custom schemes…) —
    /// refused entirely.
    Deny,
}

/// True iff `raw` is an http(s) loopback URL the preview may load.
pub fn is_safe_preview_url(raw: &str) -> bool {
    is_safe_local_url(raw)
}

/// True iff `raw` parses as an http(s) URL at all (loopback or remote).
/// Used for the "open external links in the system browser" policy.
pub fn is_http_url(raw: &str) -> bool {
    url::Url::parse(raw)
        .map(|u| u.scheme() == "http" || u.scheme() == "https")
        .unwrap_or(false)
}

/// The policy applied to every main-frame navigation in the preview.
pub fn decide_navigation(raw: &str) -> NavigationDecision {
    if is_safe_preview_url(raw) {
        return NavigationDecision::Allow;
    }
    if is_http_url(raw) {
        return NavigationDecision::ExternalBrowser;
    }
    NavigationDecision::Deny
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_urls_are_allowed() {
        for u in [
            "http://localhost:3000/",
            "http://localhost:3000/route?x=1#frag",
            "http://127.0.0.1:5173",
            "https://localhost:8443/app",
            "http://[::1]:3000/",
            "http://0.0.0.0:8080/",
        ] {
            assert_eq!(decide_navigation(u), NavigationDecision::Allow, "{u}");
        }
    }

    #[test]
    fn remote_urls_go_to_the_system_browser() {
        for u in [
            "https://example.com",
            "http://192.168.1.5:3000",
            "https://docs.rs/tauri",
        ] {
            assert_eq!(decide_navigation(u), NavigationDecision::ExternalBrowser, "{u}");
        }
    }

    #[test]
    fn non_http_schemes_are_denied() {
        for u in [
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "data:text/html,<h1>x</h1>",
            "about:blank",
            "tauri://localhost",
            "not a url",
            "",
        ] {
            assert_eq!(decide_navigation(u), NavigationDecision::Deny, "{u:?}");
        }
    }

    #[test]
    fn default_state_is_hidden() {
        let s = PreviewState::default();
        assert_eq!(s.phase, PreviewPhase::Hidden);
        assert_eq!(s.url, None);
        assert_eq!(s.generation, 0);
    }
}
