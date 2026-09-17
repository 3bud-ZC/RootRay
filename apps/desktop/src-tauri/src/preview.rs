//! Embedded project preview — a dedicated child WebView2 surface inside
//! the RootRay window.
//!
//! Security model:
//! - The preview webview is labelled `project-preview`; the capability
//!   file scopes every privilege to `webviews: ["main"]`, so page
//!   JavaScript gets no Tauri IPC at all.
//! - Every command here additionally refuses callers that are not the
//!   privileged UI webview — defense in depth against capability drift.
//! - Main-frame navigation is loopback-only (`decide_navigation`).
//!   `window.open` / `target=_blank` is denied; local URLs navigate the
//!   preview itself, remote http(s) links go to the system browser where
//!   they hold no RootRay privileges.

use std::sync::{Arc, Mutex};

use rootray_core::preview::{
    decide_navigation, is_safe_preview_url, NavigationDecision, PreviewPhase, PreviewState,
};
use rootray_core::{AppCore, CoreError};

use tauri::{LogicalPosition, LogicalSize, Position, Rect, Size};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, Webview, WebviewUrl, Window};

use crate::{CmdResult, EVENT_PREVIEW};

pub const PREVIEW_LABEL: &str = "project-preview";
const UI_WEBVIEW_LABEL: &str = "main";

/// Native-side preview bookkeeping: the child webview plus the snapshot
/// pushed to the UI on every transition.
#[derive(Default)]
pub struct PreviewManager {
    inner: Mutex<PreviewInner>,
}

#[derive(Default)]
struct PreviewInner {
    webview: Option<Webview>,
    state: PreviewState,
    /// True while the surface is hidden for a modal/overlay — bounds
    /// updates are still applied so the restore lands in the right place.
    modal_hidden: bool,
}

fn require_ui(webview: &Webview) -> CmdResult<()> {
    if webview.label() == UI_WEBVIEW_LABEL {
        Ok(())
    } else {
        Err(CoreError::Internal(format!(
            "preview commands are restricted to the RootRay UI (caller webview: {:?})",
            webview.label()
        ))
        .into())
    }
}

fn core_error(msg: impl Into<String>) -> crate::CommandError {
    CoreError::Internal(msg.into()).into()
}

impl PreviewManager {
    fn with<R>(&self, f: impl FnOnce(&mut PreviewInner) -> R) -> R {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut guard)
    }

    /// Mutates the snapshot, bumps the generation and pushes it to the UI.
    fn transition(&self, app: &AppHandle, f: impl FnOnce(&mut PreviewState)) {
        let snapshot = self.with(|inner| {
            f(&mut inner.state);
            inner.state.generation += 1;
            inner.state.clone()
        });
        let _ = app.emit(EVENT_PREVIEW, snapshot);
    }

    fn webview(&self) -> Option<Webview> {
        self.with(|inner| inner.webview.clone())
    }
}

/// The popup/new-window policy for the preview webview.
fn popup_policy(app: AppHandle) -> impl Fn(tauri::Url, tauri::webview::NewWindowFeatures) -> NewWindowResponse<tauri::Wry> + Send + Sync + 'static {
    move |url, _features| {
        match decide_navigation(url.as_str()) {
            // Local link — the user meant to stay in the app; navigate the
            // existing preview surface instead of spawning a window.
            NavigationDecision::Allow => {
                if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
                    let _ = wv.navigate(url);
                }
            }
            // Remote link — hand it to the system browser, which carries
            // no RootRay privileges and gets a real window.
            NavigationDecision::ExternalBrowser => {
                if let Some(core) = app.try_state::<Arc<AppCore>>() {
                    let _ = core.open_external_browser(url.as_str());
                }
            }
            NavigationDecision::Deny => {}
        }
        NewWindowResponse::Deny
    }
}

/// Page-load events drive the loading/ready phases and the toolbar URL.
fn page_load_hook(app: AppHandle) -> impl Fn(Webview, tauri::webview::PageLoadPayload<'_>) + Send + Sync + 'static {
    move |_webview, payload| {
        let url = payload.url().as_str().to_string();
        let phase = match payload.event() {
            PageLoadEvent::Started => PreviewPhase::Loading,
            PageLoadEvent::Finished => PreviewPhase::Ready,
        };
        if let Some(mgr) = app.try_state::<Arc<PreviewManager>>() {
            mgr.transition(&app, |s| {
                // A redirect can deliver Started for a new URL while the
                // previous document still shows — always track the latest.
                s.url = Some(url.clone());
                s.phase = phase;
                if phase == PreviewPhase::Ready {
                    s.error = None;
                }
            });
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn rect_to_bounds(r: &PreviewRect) -> Rect {
    Rect {
        position: Position::Logical(LogicalPosition::new(r.x, r.y)),
        size: Size::Logical(LogicalSize::new(r.width.max(1.0), r.height.max(1.0))),
    }
}

/// Creates (or re-points) the embedded preview. Idempotent: calling with
/// an existing surface navigates it instead of stacking a second webview.
///
/// MUST stay `async`: synchronous commands run inside WebView2's IPC
/// dispatch, where `add_child`'s WebView2 controller creation can never
/// receive its completion callback — the app deadlocks (tauri#4121).
/// Async commands run on the runtime, so the build closure is posted to
/// the event loop and executes with a clean call stack.
#[tauri::command]
pub async fn preview_create(
    app: AppHandle,
    webview: Webview,
    url: String,
    rect: PreviewRect,
    mgr: tauri::State<'_, Arc<PreviewManager>>,
) -> CmdResult<()> {
    require_ui(&webview)?;
    if !is_safe_preview_url(&url) {
        mgr.transition(&app, |s| {
            s.phase = PreviewPhase::Error;
            s.error = Some(format!("refused non-local preview URL: {url}"));
        });
        return Err(CoreError::LocalUrlNotDetected.into());
    }
    let parsed = tauri::Url::parse(&url).map_err(|_| core_error("unparseable preview URL"))?;

    if let Some(existing) = mgr.webview() {
        existing.navigate(parsed).map_err(|e| core_error(e.to_string()))?;
        mgr.with(|i| {
            i.state.url = Some(url.clone());
            i.state.phase = PreviewPhase::Loading;
        });
        mgr.transition(&app, |_| {});
        return Ok(());
    }

    let window: Window = app
        .get_window("main")
        .ok_or_else(|| core_error("main window unavailable"))?;

    let builder = tauri::WebviewBuilder::new(PREVIEW_LABEL, WebviewUrl::External(parsed))
        .on_navigation(|target| is_safe_preview_url(target.as_str()))
        .on_new_window(popup_policy(app.clone()))
        .on_page_load(page_load_hook(app.clone()));

    let child = window
        .add_child(
            builder,
            LogicalPosition::new(rect.x, rect.y),
            LogicalSize::new(rect.width.max(1.0), rect.height.max(1.0)),
        )
        .map_err(|e| {
            mgr.transition(&app, |s| {
                s.phase = PreviewPhase::Error;
                s.error = Some(format!("preview webview creation failed: {e}"));
            });
            core_error(e.to_string())
        })?;

    mgr.with(|i| {
        i.webview = Some(child);
        i.modal_hidden = false;
    });
    mgr.transition(&app, |s| {
        s.phase = PreviewPhase::Loading;
        s.url = Some(url);
        s.error = None;
    });
    Ok(())
}

/// Re-positions the surface to match its React layout rectangle.
/// Called on a change-only basis from the ResizeObserver loop.
#[tauri::command]
pub fn preview_set_bounds(
    webview: Webview,
    rect: PreviewRect,
    mgr: tauri::State<'_, Arc<PreviewManager>>,
) -> CmdResult<()> {
    require_ui(&webview)?;
    if let Some(wv) = mgr.webview() {
        wv.set_bounds(rect_to_bounds(&rect))
            .map_err(|e| core_error(e.to_string()))?;
    }
    Ok(())
}

/// Hides the surface (modal coverage, code-only tab) without losing it.
#[tauri::command]
pub fn preview_hide(
    webview: Webview,
    mgr: tauri::State<'_, Arc<PreviewManager>>,
) -> CmdResult<()> {
    require_ui(&webview)?;
    if let Some(wv) = mgr.webview() {
        wv.hide().map_err(|e| core_error(e.to_string()))?;
    }
    mgr.with(|i| i.modal_hidden = true);
    Ok(())
}

/// Restores a hidden surface after the covering overlay closed.
#[tauri::command]
pub fn preview_show(
    webview: Webview,
    mgr: tauri::State<'_, Arc<PreviewManager>>,
) -> CmdResult<()> {
    require_ui(&webview)?;
    if let Some(wv) = mgr.webview() {
        wv.show().map_err(|e| core_error(e.to_string()))?;
    }
    mgr.with(|i| i.modal_hidden = false);
    Ok(())
}

/// Validated in-preview navigation (address entry, local redirects).
#[tauri::command]
pub fn preview_navigate(
    app: AppHandle,
    webview: Webview,
    url: String,
    mgr: tauri::State<'_, Arc<PreviewManager>>,
) -> CmdResult<()> {
    require_ui(&webview)?;
    if !is_safe_preview_url(&url) {
        return Err(CoreError::LocalUrlNotDetected.into());
    }
    let parsed = tauri::Url::parse(&url).map_err(|_| core_error("unparseable URL"))?;
    if let Some(wv) = mgr.webview() {
        wv.navigate(parsed).map_err(|e| core_error(e.to_string()))?;
        mgr.transition(&app, |s| {
            s.phase = PreviewPhase::Loading;
            s.url = Some(url);
        });
    }
    Ok(())
}

#[tauri::command]
pub fn preview_back(
    webview: Webview,
    mgr: tauri::State<'_, Arc<PreviewManager>>,
) -> CmdResult<()> {
    require_ui(&webview)?;
    if let Some(wv) = mgr.webview() {
        wv.eval("history.back()").map_err(|e| core_error(e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn preview_forward(
    webview: Webview,
    mgr: tauri::State<'_, Arc<PreviewManager>>,
) -> CmdResult<()> {
    require_ui(&webview)?;
    if let Some(wv) = mgr.webview() {
        wv.eval("history.forward()")
            .map_err(|e| core_error(e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn preview_reload(
    webview: Webview,
    mgr: tauri::State<'_, Arc<PreviewManager>>,
) -> CmdResult<()> {
    require_ui(&webview)?;
    if let Some(wv) = mgr.webview() {
        wv.reload().map_err(|e| core_error(e.to_string()))?;
    }
    Ok(())
}

/// The current document URL of the preview — toolbar source of truth
/// between navigation events.
#[tauri::command]
pub fn preview_url(
    webview: Webview,
    mgr: tauri::State<'_, Arc<PreviewManager>>,
) -> CmdResult<Option<String>> {
    require_ui(&webview)?;
    Ok(mgr
        .webview()
        .and_then(|wv| wv.url().ok().map(|u| u.to_string())))
}

#[tauri::command]
pub fn preview_state(
    webview: Webview,
    mgr: tauri::State<'_, Arc<PreviewManager>>,
) -> CmdResult<PreviewState> {
    require_ui(&webview)?;
    Ok(mgr.with(|i| i.state.clone()))
}

/// The dev server is starting but no URL exists yet.
#[tauri::command]
pub fn preview_mark_waiting(
    app: AppHandle,
    webview: Webview,
    mgr: tauri::State<'_, Arc<PreviewManager>>,
) -> CmdResult<()> {
    require_ui(&webview)?;
    mgr.transition(&app, |s| {
        s.phase = PreviewPhase::Waiting;
        s.error = None;
    });
    Ok(())
}

/// The dev server stopped/exited — tear the surface down but keep the
/// last URL so the stopped overlay can explain what was previewed.
#[tauri::command]
pub fn preview_mark_stopped(
    app: AppHandle,
    webview: Webview,
    mgr: tauri::State<'_, Arc<PreviewManager>>,
) -> CmdResult<()> {
    require_ui(&webview)?;
    if let Some(wv) = mgr.webview() {
        let _ = wv.close();
    }
    mgr.with(|i| {
        i.webview = None;
        i.modal_hidden = false;
    });
    mgr.transition(&app, |s| {
        s.phase = PreviewPhase::Stopped;
        s.error = None;
    });
    Ok(())
}

/// Full teardown for project/target switches — back to a clean slate.
#[tauri::command]
pub fn preview_dispose(
    app: AppHandle,
    webview: Webview,
    mgr: tauri::State<'_, Arc<PreviewManager>>,
) -> CmdResult<()> {
    require_ui(&webview)?;
    if let Some(wv) = mgr.webview() {
        let _ = wv.close();
    }
    mgr.with(|i| {
        i.webview = None;
        i.modal_hidden = false;
    });
    mgr.transition(&app, |s| {
        // Keep `generation` — the UI drops snapshots older than the last
        // one it saw, so a reset here would silently discard this event
        // and the next few transitions after it.
        s.phase = PreviewPhase::Hidden;
        s.url = None;
        s.error = None;
    });
    Ok(())
}

/// Window teardown — called from the Destroyed handler. No event emit:
/// the UI is gone already.
pub fn shutdown(app: &AppHandle) {
    if let Some(mgr) = app.try_state::<Arc<PreviewManager>>() {
        if let Some(wv) = mgr.webview() {
            let _ = wv.close();
        }
        mgr.with(|i| {
            i.webview = None;
        });
    }
}
