//! The Atlas-owned system notifier.
//!
//! One platform-neutral interface (`Notification`, `NotifierBackend`), one
//! response stream back to the frontend, and per-backend `Capabilities` the
//! frontend's decision layer reads so it only offers what the platform can do
//! (the same capability-gating idea as ADR-0002).
//!
//! Backends:
//!  - `macos`    `UNUserNotificationCenter`; only when running from an app bundle.
//!  - `toast`    Windows `ToastNotificationManager`; only when installed (it
//!    needs the bundle identifier as AppUserModelID).
//!  - `freedesktop` Linux `org.freedesktop.Notifications` over D-Bus; capabilities
//!    come from the running server. Used when a server is on the session bus.
//!  - `fallback` the `tauri-plugin-notification` plugin: show only. Used when not
//!    bundled (dev runs) and when no backend above applies.
//!
//! Adding a backend is a new file implementing `NotifierBackend` plus a
//! `Capabilities` value, and one arm in `select_backend`.

mod fallback;
#[cfg(target_os = "linux")]
mod freedesktop;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod toast;

use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Event carrying every `NotificationResponse` to the frontend.
pub const RESPONSE_EVENT: &str = "atlas:notification-response";

// Read only by backends that honour the field (the fallback shows title/body/sound).
#[cfg_attr(
    not(any(target_os = "macos", windows, target_os = "linux")),
    allow(dead_code)
)]
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Urgency {
    Low,
    #[default]
    Normal,
    High,
}

// Read only by backends that honour the field (the fallback shows title/body/sound).
#[cfg_attr(
    not(any(target_os = "macos", windows, target_os = "linux")),
    allow(dead_code)
)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAction {
    pub id: String,
    pub label: String,
    // Only the macOS backend renders action styles; toast and freedesktop ignore them.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    #[serde(default)]
    pub destructive: bool,
    /// The device must be unlocked before the action runs.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    #[serde(default)]
    pub requires_unlock: bool,
}

// Read only by backends that honour the field (the fallback shows title/body/sound).
#[cfg_attr(
    not(any(target_os = "macos", windows, target_os = "linux")),
    allow(dead_code)
)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    /// Stable identity: showing the same tag again replaces the old banner;
    /// `remove` addresses it.
    pub tag: String,
    /// Banners sharing a group stack together and can be removed together.
    pub group: String,
    pub title: String,
    #[serde(default)]
    pub subtitle: Option<String>,
    pub body: String,
    #[serde(default)]
    pub image_path: Option<String>,
    /// A system sound name (e.g. "Ping"); `None` is silent.
    #[serde(default)]
    pub sound: Option<String>,
    #[serde(default)]
    pub urgency: Urgency,
    #[serde(default)]
    pub actions: Vec<NotificationAction>,
    /// Opaque string echoed back in the response, so a click that cold-starts
    /// the app can still rebuild what it was about.
    #[serde(default)]
    pub payload: Option<String>,
}

/// The user's reaction to a banner. `action_id` is `None` for a plain click.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationResponse {
    pub tag: String,
    pub action_id: Option<String>,
    pub payload: Option<String>,
}

/// What a backend can do. The frontend only offers what is `true` here.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Action buttons on a banner.
    pub actions: bool,
    /// Most actions one banner can carry (0 when `actions` is false).
    pub max_actions: u8,
    /// An attached image.
    pub images: bool,
    /// `remove` / `remove_group` take delivered banners back down.
    pub removal: bool,
    /// Banners with one `group` stack together.
    pub grouping: bool,
    /// A per-banner sound.
    pub sound: bool,
    /// Clicks and actions come back as `NotificationResponse`s.
    pub responses: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Authorization {
    Granted,
    Denied,
}

pub type ResponseSink = Arc<dyn Fn(NotificationResponse) + Send + Sync>;

pub trait NotifierBackend: Send + Sync {
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> Capabilities;
    /// May prompt the user; `done` is called once, from any thread.
    fn request_authorization(&self, done: Box<dyn FnOnce(Authorization) + Send>);
    fn show(&self, notification: Notification) -> Result<(), String>;
    fn remove(&self, tag: &str);
    fn remove_group(&self, group: &str);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifierInfo {
    pub backend: &'static str,
    pub capabilities: Capabilities,
}

#[derive(Default)]
struct ResponseQueue {
    ready: bool,
    pending: Vec<NotificationResponse>,
}

pub struct Notifier {
    backend: Box<dyn NotifierBackend>,
    queue: Arc<Mutex<ResponseQueue>>,
    app: AppHandle,
}

impl Notifier {
    /// Must be called on the main thread (the macOS backend installs its
    /// delegate here, early enough to catch the click that launched the app).
    pub fn new(app: &AppHandle) -> Self {
        let queue = Arc::new(Mutex::new(ResponseQueue::default()));
        // Responses can arrive before the webview has a listener (a click that
        // launched the app): hold them until the frontend calls `init`.
        let sink: ResponseSink = {
            let queue = queue.clone();
            let app = app.clone();
            Arc::new(move |response| {
                let mut queue = queue.lock();
                if queue.ready {
                    emit_response(&app, &response);
                } else {
                    queue.pending.push(response);
                }
            })
        };
        let backend = select_backend(app, sink);
        tracing::info!("system notifier backend: {}", backend.name());
        Self {
            backend,
            queue,
            app: app.clone(),
        }
    }

    pub fn info(&self) -> NotifierInfo {
        NotifierInfo {
            backend: self.backend.name(),
            capabilities: self.backend.capabilities(),
        }
    }

    /// The frontend has a listener: flush what arrived early, stream the rest.
    pub fn init(&self) -> NotifierInfo {
        let mut queue = self.queue.lock();
        queue.ready = true;
        for response in queue.pending.drain(..) {
            emit_response(&self.app, &response);
        }
        self.info()
    }

    pub fn backend(&self) -> &dyn NotifierBackend {
        &*self.backend
    }
}

fn emit_response(app: &AppHandle, response: &NotificationResponse) {
    if let Err(error) = app.emit(RESPONSE_EVENT, response) {
        tracing::warn!("failed to emit notification response: {error}");
    }
}

fn select_backend(app: &AppHandle, sink: ResponseSink) -> Box<dyn NotifierBackend> {
    #[cfg(target_os = "macos")]
    if let Some(backend) = macos::MacosBackend::new(app, sink) {
        return Box::new(backend);
    }
    #[cfg(windows)]
    if let Some(backend) = toast::ToastBackend::new(app, sink) {
        return Box::new(backend);
    }
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        let handle = app.clone();
        // Best-effort raise on click; there is no API to apply an activation token.
        let raise: freedesktop::ActivateHook = Arc::new(move || {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        });
        if let Some(backend) = freedesktop::FreedesktopBackend::new(sink, raise) {
            return Box::new(backend);
        }
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    let _ = sink;
    Box::new(fallback::FallbackBackend::new(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_notification_takes_defaults() {
        let n: Notification =
            serde_json::from_str(r#"{"tag":"t","group":"g","title":"Title","body":"Body"}"#)
                .expect("parses");
        assert!(n.actions.is_empty());
        assert!(matches!(n.urgency, Urgency::Normal));
        assert!(n.payload.is_none());
    }

    #[test]
    fn actions_and_payload_round_trip() {
        let n: Notification = serde_json::from_str(
            r#"{"tag":"t","group":"g","title":"T","body":"B","urgency":"high","payload":"{}",
                "actions":[{"id":"allow","label":"Allow","requiresUnlock":true},{"id":"deny","label":"Deny","destructive":true}]}"#,
        )
        .expect("parses");
        assert_eq!(n.actions.len(), 2);
        assert!(n.actions[0].requires_unlock && !n.actions[0].destructive);
        assert!(n.actions[1].destructive && !n.actions[1].requires_unlock);
        assert_eq!(n.payload.as_deref(), Some("{}"));
    }

    #[test]
    fn capabilities_serialize_camel_case() {
        let json = serde_json::to_value(Capabilities {
            max_actions: 4,
            ..Capabilities::default()
        })
        .expect("serializes");
        assert_eq!(json["maxActions"], 4);
        assert_eq!(json["responses"], false);
    }

    #[test]
    fn response_serializes_camel_case() {
        let json = serde_json::to_value(NotificationResponse {
            tag: "t".into(),
            action_id: Some("allow".into()),
            payload: None,
        })
        .expect("serializes");
        assert_eq!(json["actionId"], "allow");
        assert_eq!(json["tag"], "t");
    }
}
