//! Real browsing in a native WebKit webview.
//!
//! The `knowledge::fetch_readable` path is a *reader* — it downloads HTML with
//! `reqwest` and strips scripts/styles/forms before rendering, so JavaScript
//! sites (Google, YouTube) and any login flow are impossible there by design.
//!
//! This module hosts a genuine WebKit webview pointed at an external URL. It is
//! the same engine the app itself runs on (via `wry`), so JS, cookies, and
//! logins all work at native speed — Tauri layer-attaches the webview correctly,
//! avoiding the compositor stalls a hand-rolled NSView embed causes.
//!
//! Two surfaces:
//!   - **Phase A** `browser_open_window` — a separate native browser window.
//!   - **Phase B** `browser_embed_*` — a child webview attached to the main
//!     window and overlaid on the browser tab's content rect. React owns the
//!     chrome (URL bar, buttons) and pushes geometry/visibility; Rust owns the
//!     webview lifecycle + navigation state, emitting `atlas:browser-nav`
//!     deltas back. Per the "Rust owns business logic" rule.
//!
//! All browser surfaces share one on-disk data directory so a login in one
//! persists across windows and app restarts.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::json;
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, WebviewUrl,
    WebviewWindowBuilder,
};

/// Monotonic counter so each browser *window* gets a unique, capability-matching
/// label (`atlas-browser-N`). The `atlas-*` pattern is whitelisted in
/// `capabilities/default.json`.
static BROWSER_SEQ: AtomicU64 = AtomicU64::new(0);

/// A logical-pixel rectangle from the frontend, relative to the window's
/// content area (CSS pixels == Tauri logical pixels).
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct BrowserRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl BrowserRect {
    pub fn is_valid(&self) -> bool {
        self.width.is_finite()
            && self.height.is_finite()
            && self.x.is_finite()
            && self.y.is_finite()
            && self.width > 0.0
            && self.height > 0.0
    }

    fn to_tauri(self) -> Rect {
        Rect {
            position: Position::Logical(LogicalPosition::new(self.x, self.y)),
            size: Size::Logical(LogicalSize::new(self.width.max(1.0), self.height.max(1.0))),
        }
    }
}

/// Per-embed back/forward stack. WebKit doesn't expose the history cursor to
/// JS, so we reconstruct it from committed navigations: each page-load is
/// matched against the neighbouring entries to detect back/forward vs. a fresh
/// navigation (which truncates the forward tail).
#[derive(Default)]
struct NavHistory {
    stack: Vec<String>,
    index: isize,
}

impl NavHistory {
    fn commit(&mut self, url: &str) {
        if self.index >= 0 && self.stack.get(self.index as usize).map(String::as_str) == Some(url) {
            return; // same page (reload / SPA re-fire)
        }
        if self.index + 1 < self.stack.len() as isize
            && self.stack[(self.index + 1) as usize] == url
        {
            self.index += 1; // forward
            return;
        }
        if self.index > 0 && self.stack[(self.index - 1) as usize] == url {
            self.index -= 1; // back
            return;
        }
        let keep = (self.index + 1).max(0) as usize;
        self.stack.truncate(keep);
        self.stack.push(url.to_string());
        self.index = self.stack.len() as isize - 1;
    }

    fn can_go_back(&self) -> bool {
        self.index > 0
    }
    fn can_go_forward(&self) -> bool {
        self.index >= 0 && self.index < self.stack.len() as isize - 1
    }
}

/// App-managed state: navigation history per embed id.
#[derive(Default)]
pub struct BrowserState {
    nav: Arc<Mutex<HashMap<String, NavHistory>>>,
}

impl BrowserState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Shared persistent profile for every browser surface. Lives under the app
/// data dir so cookies / localStorage / logins survive restarts. Separate from
/// the app's own webview store.
fn browser_profile_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("browser-profile");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create profile dir: {e}"))?;
    Ok(dir)
}

/// Normalize a user-entered URL the same way the reader panel does: bare hosts
/// get an `https://` scheme so `youtube.com` works without typing the protocol.
/// Browser address input → a URL, http(s)-only.
///
/// Anything already carrying a SCHEME that is not http(s) is refused rather
/// than prefixed: the old version turned `file:///etc/passwd` into
/// `https://file:///etc/passwd` — unloadable, so "safe" by accident rather
/// than by policy, and one URL-parser quirk away from not being. Bare input
/// ("example.com") still gets https:// like every address bar.
fn normalize_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Ok(trimmed.to_string());
    }
    // A scheme separator anywhere before the first slash means the caller
    // named a non-http scheme (file:, javascript:, data:, ftp:, …).
    let head = trimmed.split('/').next().unwrap_or(trimmed);
    if head.contains(':') && !head.split(':').nth(1).is_some_and(|p| p.parse::<u16>().is_ok()) {
        return Err("only http(s) URLs can be opened".to_string());
    }
    Ok(format!("https://{trimmed}"))
}

fn embed_label(id: &str) -> String {
    format!("atlas-embed-{id}")
}

/// Build and emit the current navigation state for an embed.
fn emit_nav(
    app: &tauri::AppHandle,
    nav: &Arc<Mutex<HashMap<String, NavHistory>>>,
    id: &str,
    url: &str,
    loading: bool,
    title: Option<String>,
) {
    let (can_back, can_fwd) = {
        let g = nav.lock();
        g.get(id)
            .map(|h| (h.can_go_back(), h.can_go_forward()))
            .unwrap_or((false, false))
    };
    let _ = app.emit(
        "atlas:browser-nav",
        json!({
            "id": id,
            "url": url,
            "loading": loading,
            "title": title,
            "canGoBack": can_back,
            "canGoForward": can_fwd,
        }),
    );
}

// ---------------------------------------------------------------------------
// Phase A — separate browser window
// ---------------------------------------------------------------------------

/// Open `url` in a new native browser window. Returns the window label.
#[tauri::command]
pub fn browser_open_window(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let url = normalize_url(&url)?;
    let parsed = url.parse().map_err(|e| format!("invalid URL {url:?}: {e}"))?;

    let profile = browser_profile_dir(&app)?;
    let seq = BROWSER_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("atlas-browser-{seq}");

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title("Atlas Browser")
        .inner_size(1100.0, 800.0)
        .min_inner_size(480.0, 360.0)
        .data_directory(profile)
        .center()
        .focused(true)
        .build()
        .map_err(|e| format!("failed to open browser window: {e}"))?;

    Ok(label)
}

// ---------------------------------------------------------------------------
// Phase B — embedded child webview
// ---------------------------------------------------------------------------

/// Create (or reuse) the embedded browser webview for `id`, navigate it to
/// `url`, and position it over `rect`. Idempotent: if the webview already
/// exists it is re-shown, re-bounded, and navigated.
#[tauri::command]
pub fn browser_embed_create(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, BrowserState>,
    id: String,
    url: String,
    rect: BrowserRect,
) -> Result<(), String> {
    if !rect.is_valid() {
        return Err(format!("invalid embed bounds: {rect:?}"));
    }
    let url = normalize_url(&url)?;
    let parsed: url::Url = url.parse().map_err(|e| format!("invalid URL {url:?}: {e}"))?;
    let label = embed_label(&id);

    // Already exists → just reposition, show, and navigate.
    if let Some(webview) = app.get_webview(&label) {
        tracing::debug!(id = %id, rect = ?rect, "repositioning existing embed webview");
        let _ = webview.set_bounds(rect.to_tauri());
        let _ = webview.show();
        let _ = webview.navigate(parsed);
        return Ok(());
    }

    tracing::info!(id = %id, url = %url, rect = ?rect, "creating new embedded child webview (initially hidden)");
    let profile = browser_profile_dir(&app)?;
    state
        .nav
        .lock()
        .insert(id.clone(), NavHistory::default());

    let nav_started = state.nav.clone();
    let nav_finished = state.nav.clone();
    let app_started = app.clone();
    let app_finished = app;
    let id_started = id.clone();
    let id_finished = id;

    // `WebviewBuilder` (unlike `WebviewWindowBuilder`) has no `.visible()`
    // knob — the child webview is created shown, then hidden immediately
    // below to match the "initially hidden" contract callers rely on.
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .data_directory(profile)
        .on_page_load(move |webview, payload| {
            let url = payload.url().to_string();
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => {
                    nav_started.lock().entry(id_started.clone()).or_default().commit(&url);
                    emit_nav(&app_started, &nav_started, &id_started, &url, true, None);
                }
                tauri::webview::PageLoadEvent::Finished => {
                    emit_nav(&app_finished, &nav_finished, &id_finished, &url, false, None);
                    // Title isn't known until the document parses; read it back
                    // and emit a follow-up so the URL bar / tab can show it.
                    let app2 = app_finished.clone();
                    let nav2 = nav_finished.clone();
                    let id2 = id_finished.clone();
                    let url2 = url;
                    let _ = webview.eval_with_callback("document.title", move |raw| {
                        let title = raw.trim().trim_matches('"').to_string();
                        let title = if title.is_empty() { None } else { Some(title) };
                        emit_nav(&app2, &nav2, &id2, &url2, false, title);
                    });
                }
            }
        });

    let webview = window
        .add_child(
            builder,
            Position::Logical(LogicalPosition::new(rect.x, rect.y)),
            Size::Logical(LogicalSize::new(rect.width.max(1.0), rect.height.max(1.0))),
        )
        .map_err(|e| format!("failed to embed browser webview: {e}"))?;
    let _ = webview.hide();

    Ok(())
}

/// Navigate the embed to a new URL.
#[tauri::command]
pub fn browser_embed_navigate(app: tauri::AppHandle, id: String, url: String) -> Result<(), String> {
    let url = normalize_url(&url)?;
    let parsed: url::Url = url.parse().map_err(|e| format!("invalid URL {url:?}: {e}"))?;
    let webview = app
        .get_webview(&embed_label(&id))
        .ok_or_else(|| "embed not found".to_string())?;
    webview.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_embed_back(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let webview = app
        .get_webview(&embed_label(&id))
        .ok_or_else(|| "embed not found".to_string())?;
    webview.eval("history.back()").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_embed_forward(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let webview = app
        .get_webview(&embed_label(&id))
        .ok_or_else(|| "embed not found".to_string())?;
    webview.eval("history.forward()").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_embed_reload(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let webview = app
        .get_webview(&embed_label(&id))
        .ok_or_else(|| "embed not found".to_string())?;
    webview.eval("location.reload()").map_err(|e| e.to_string())
}

/// Reposition the embed to track the panel's content rect.
#[tauri::command]
pub fn browser_embed_set_bounds(
    app: tauri::AppHandle,
    id: String,
    rect: BrowserRect,
) -> Result<(), String> {
    if !rect.is_valid() {
        return Err(format!("invalid embed bounds: {rect:?}"));
    }
    let webview = app
        .get_webview(&embed_label(&id))
        .ok_or_else(|| "embed not found".to_string())?;
    tracing::trace!(id = %id, rect = ?rect, "browser_embed_set_bounds");
    webview.set_bounds(rect.to_tauri()).map_err(|e| e.to_string())
}

/// Show/hide the embed. A native child webview floats above the DOM and can't
/// be occluded by React UI, so the frontend hides it on tab switch, scroll-off,
/// or when an overlay (Cmd+P, context menu, dialog) opens.
#[tauri::command]
pub fn browser_embed_set_visible(
    app: tauri::AppHandle,
    id: String,
    visible: bool,
) -> Result<(), String> {
    let webview = app
        .get_webview(&embed_label(&id))
        .ok_or_else(|| "embed not found".to_string())?;
    tracing::debug!(id = %id, visible = visible, "browser_embed_set_visible");
    if visible {
        webview.show().map_err(|e| e.to_string())
    } else {
        webview.hide().map_err(|e| e.to_string())
    }
}

/// Destroy the embed (on tab close).
#[tauri::command]
pub fn browser_embed_destroy(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    id: String,
) -> Result<(), String> {
    tracing::info!(id = %id, "destroying embedded browser webview");
    state.nav.lock().remove(&id);
    if let Some(webview) = app.get_webview(&embed_label(&id)) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod normalize_url_tests {
    use super::normalize_url;

    #[test]
    fn bare_hosts_get_https_and_http_passes() {
        assert_eq!(normalize_url("example.com").unwrap(), "https://example.com");
        assert_eq!(normalize_url("  https://a.dev/x  ").unwrap(), "https://a.dev/x");
        assert_eq!(normalize_url("http://a.dev").unwrap(), "http://a.dev");
        // host:port is an address, not a scheme.
        assert_eq!(normalize_url("localhost:3000").unwrap(), "https://localhost:3000");
    }

    #[test]
    fn non_http_schemes_are_refused_not_laundered() {
        // The old version turned these into https://file:///… — unloadable,
        // so safe by accident. Refusal is the policy now.
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "ftp://x"] {
            assert!(normalize_url(bad).is_err(), "{bad} must be refused");
        }
    }
}
