//! Linux backend: the freedesktop `org.freedesktop.Notifications` D-Bus
//! interface, spoken through `zbus` directly. (`notify-rust` blocks a thread
//! per notification to wait for its action, and exposes neither
//! `GetCapabilities`-driven gating nor a shared signal stream.)
//!
//! What the server can do is asked of it at runtime (`GetCapabilities`:
//! `actions`, `body-markup`, `persistence`, `sound`, `icon-*`), never assumed;
//! servers differ wildly (GNOME Shell, KDE Plasma, dunst, mako, ...).
//!
//! The wire has no tags, so a registry maps our tag to the server's `u32` id:
//! showing a tag again passes the old id as `replaces_id`, `remove(tag)` is
//! `CloseNotification(id)`, and `NotificationClosed` forgets the mapping. One
//! background thread reads every signal of the interface and turns
//! `ActionInvoked` for ids we own into `NotificationResponse`s on the shared
//! sink (a body click is the `default` action key, offered only when the
//! server advertises `actions`; ids we do not own are ignored).
//!
//! Not provided by the protocol: grouping (`remove_group` closes every tracked
//! tag of the group instead, and `Capabilities::grouping` stays false), a
//! subtitle slot (folded into the body), and a reliable window-focus handoff
//! (the `ActivationToken` signal exists, but Tauri has no API to hand an
//! activation token to the window, so a click just raises it best-effort).
//!
//! No notification server on the bus -> `new` returns `None` and the plugin
//! fallback is used, like the other backends.

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use parking_lot::Mutex;
use zbus::zvariant::Value;
use zbus::{Connection, Proxy};

use super::{
    Authorization, Capabilities, Notification, NotificationAction, NotificationResponse,
    NotifierBackend, ResponseSink, Urgency,
};

const BUS_NAME: &str = "org.freedesktop.Notifications";
const OBJECT_PATH: &str = "/org/freedesktop/Notifications";
const APP_NAME: &str = "Atlas";
/// Action key servers fire for a click on the notification body.
const DEFAULT_ACTION: &str = "default";
/// The spec sets no limit; most shells render a handful of buttons at most.
const MAX_ACTIONS: usize = 3;
/// Notifications tracked for replace/close/click routing.
const MAX_LIVE: usize = 128;
/// A server that has to be D-Bus-activated can be slow; do not hold app start.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Called when the user acts on one of our notifications (raise the window).
pub type ActivateHook = Arc<dyn Fn() + Send + Sync>;

/// What `GetCapabilities` said, reduced to the entries Atlas uses.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ServerCaps {
    actions: bool,
    body_markup: bool,
    persistence: bool,
    sound: bool,
    icons: bool,
}

fn parse_server_caps(raw: &[String]) -> ServerCaps {
    let has = |name: &str| raw.iter().any(|c| c == name);
    ServerCaps {
        actions: has("actions"),
        body_markup: has("body-markup"),
        persistence: has("persistence"),
        sound: has("sound"),
        icons: has("icon-static") || has("icon-multi"),
    }
}

impl ServerCaps {
    fn to_capabilities(self) -> Capabilities {
        Capabilities {
            actions: self.actions,
            max_actions: if self.actions { MAX_ACTIONS as u8 } else { 0 },
            images: self.icons,
            // `CloseNotification` is a mandatory method of the interface.
            removal: true,
            // No protocol-level grouping; `remove_group` is emulated.
            grouping: false,
            sound: self.sound,
            // Clicks only come back as `ActionInvoked`, which needs `actions`.
            responses: self.actions,
        }
    }
}

/// Markup-capable servers render `<b>`, `<i>`, `<a>` in the body; escape our
/// text so a title or path containing `<` is shown, not parsed.
fn escape_markup(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

/// `(summary, body)`. The summary is always plain text. There is no subtitle
/// slot, so it leads the body (bold where markup is rendered).
fn compose_text(title: &str, subtitle: Option<&str>, body: &str, markup: bool) -> (String, String) {
    let fit = |text: &str| {
        if markup {
            escape_markup(text)
        } else {
            text.to_owned()
        }
    };
    let mut parts: Vec<String> = Vec::new();
    if let Some(subtitle) = subtitle.filter(|s| !s.is_empty()) {
        parts.push(if markup {
            format!("<b>{}</b>", escape_markup(subtitle))
        } else {
            subtitle.to_owned()
        });
    }
    if !body.is_empty() {
        parts.push(fit(body));
    }
    (title.to_owned(), parts.join("\n"))
}

/// The `urgency` hint byte: 0 low, 1 normal, 2 critical. Atlas's `high` means
/// "needs you" (a permission request), which is what critical is for.
fn urgency_byte(urgency: Urgency) -> u8 {
    match urgency {
        Urgency::Low => 0,
        Urgency::Normal => 1,
        Urgency::High => 2,
    }
}

/// `expire_timeout` in ms: 0 never expires, -1 is the server default. Only a
/// high-urgency banner is pinned, and only when the server keeps
/// notifications around (`persistence`) so it is not lost from view.
fn expire_timeout(urgency: Urgency, caps: ServerCaps) -> i32 {
    if matches!(urgency, Urgency::High) && caps.persistence {
        0
    } else {
        -1
    }
}

/// Flat `[key, label, key, label, ...]` as the `Notify` call wants it. Empty
/// without the `actions` capability. `default` (body click) leads; an action
/// that tries to use the reserved key is dropped.
fn build_actions(actions: &[NotificationAction], caps: ServerCaps) -> Vec<String> {
    if !caps.actions {
        return Vec::new();
    }
    let mut flat = vec![DEFAULT_ACTION.to_owned(), "Open".to_owned()];
    for action in actions
        .iter()
        .filter(|a| !a.id.is_empty() && a.id != DEFAULT_ACTION)
        .take(MAX_ACTIONS)
    {
        flat.push(action.id.clone());
        flat.push(action.label.clone());
    }
    flat
}

fn build_hints(n: &Notification, caps: ServerCaps) -> HashMap<&'static str, Value<'static>> {
    let mut hints: HashMap<&'static str, Value<'static>> = HashMap::new();
    hints.insert("urgency", Value::from(urgency_byte(n.urgency)));
    if caps.icons {
        if let Some(path) = n.image_path.as_deref().filter(|p| !p.is_empty()) {
            hints.insert("image-path", Value::from(path.to_owned()));
        }
    }
    if caps.sound {
        if n.sound.is_some() && !matches!(n.urgency, Urgency::Low) {
            hints.insert("sound-name", Value::from("message-new-instant"));
        } else {
            hints.insert("suppress-sound", Value::from(true));
        }
    }
    hints
}

struct Entry {
    id: u32,
    group: String,
    payload: Option<String>,
    seq: u64,
}

/// Our tag <-> the server's id, plus what a click needs to answer.
#[derive(Default)]
struct Registry {
    by_tag: HashMap<String, Entry>,
    tag_by_id: HashMap<u32, String>,
    next_seq: u64,
}

impl Registry {
    fn id_for(&self, tag: &str) -> Option<u32> {
        self.by_tag.get(tag).map(|e| e.id)
    }

    fn track(&mut self, tag: &str, group: &str, payload: Option<String>, id: u32) {
        // A server may reuse an id we gave to a different tag.
        if let Some(other) = self.tag_by_id.get(&id).cloned() {
            if other != tag {
                self.by_tag.remove(&other);
            }
        }
        if let Some(previous) = self.by_tag.get(tag) {
            self.tag_by_id.remove(&previous.id);
        }
        self.next_seq += 1;
        self.by_tag.insert(
            tag.to_owned(),
            Entry {
                id,
                group: group.to_owned(),
                payload,
                seq: self.next_seq,
            },
        );
        self.tag_by_id.insert(id, tag.to_owned());
        if self.by_tag.len() > MAX_LIVE {
            let oldest = self
                .by_tag
                .iter()
                .min_by_key(|(_, e)| e.seq)
                .map(|(tag, _)| tag.clone());
            if let Some(oldest) = oldest {
                self.take_tag(&oldest);
            }
        }
    }

    /// Drop a tag, returning the server id to close.
    fn take_tag(&mut self, tag: &str) -> Option<u32> {
        let entry = self.by_tag.remove(tag)?;
        self.tag_by_id.remove(&entry.id);
        Some(entry.id)
    }

    /// Drop every tag of a group, returning the server ids to close.
    fn take_group(&mut self, group: &str) -> Vec<u32> {
        let tags: Vec<String> = self
            .by_tag
            .iter()
            .filter(|(_, e)| e.group == group)
            .map(|(tag, _)| tag.clone())
            .collect();
        tags.iter().filter_map(|tag| self.take_tag(tag)).collect()
    }

    fn forget_id(&mut self, id: u32) {
        if let Some(tag) = self.tag_by_id.remove(&id) {
            self.by_tag.remove(&tag);
        }
    }

    fn response_for(&self, id: u32, action_key: &str) -> Option<NotificationResponse> {
        let tag = self.tag_by_id.get(&id)?;
        let entry = self.by_tag.get(tag)?;
        Some(NotificationResponse {
            tag: tag.clone(),
            action_id: (action_key != DEFAULT_ACTION).then(|| action_key.to_owned()),
            payload: entry.payload.clone(),
        })
    }
}

/// The signals of the interface that Atlas acts on.
#[derive(Debug, PartialEq, Eq)]
enum Signal {
    ActionInvoked(u32, String),
    Closed(u32),
}

/// Apply a signal to the registry. `Some` is a user response to emit.
fn apply_signal(registry: &mut Registry, signal: Signal) -> Option<NotificationResponse> {
    match signal {
        Signal::ActionInvoked(id, key) => registry.response_for(id, &key),
        Signal::Closed(id) => {
            registry.forget_id(id);
            None
        }
    }
}

fn parse_signal(message: &zbus::Message) -> Option<Signal> {
    let header = message.header();
    let body = message.body();
    match header.member()?.as_str() {
        "ActionInvoked" => {
            let (id, key) = body.deserialize::<(u32, String)>().ok()?;
            Some(Signal::ActionInvoked(id, key))
        }
        "NotificationClosed" => {
            let (id, _reason) = body.deserialize::<(u32, u32)>().ok()?;
            Some(Signal::Closed(id))
        }
        _ => None,
    }
}

pub struct FreedesktopBackend {
    proxy: Proxy<'static>,
    caps: ServerCaps,
    registry: Arc<Mutex<Registry>>,
}

impl FreedesktopBackend {
    /// `None` when there is no session bus or no notification server on it.
    pub fn new(sink: ResponseSink, on_activate: ActivateHook) -> Option<Self> {
        let (tx, rx) = mpsc::channel();
        // Off-thread and bounded: a D-Bus-activated server can take a while.
        std::thread::Builder::new()
            .name("atlas-notify-probe".into())
            .spawn(move || {
                let _ = tx.send(zbus::block_on(probe()));
            })
            .ok()?;
        let (proxy, raw_caps) = match rx.recv_timeout(PROBE_TIMEOUT) {
            Ok(Ok(found)) => found,
            Ok(Err(error)) => {
                tracing::info!("system notifications: no notification server ({error})");
                return None;
            }
            Err(_) => {
                tracing::info!("system notifications: notification server probe timed out");
                return None;
            }
        };
        let caps = parse_server_caps(&raw_caps);
        tracing::info!("system notifications: server capabilities {raw_caps:?}");

        let registry = Arc::new(Mutex::new(Registry::default()));
        spawn_listener(proxy.clone(), registry.clone(), sink, on_activate);
        Some(Self {
            proxy,
            caps,
            registry,
        })
    }

    fn close(&self, id: u32) {
        let result = zbus::block_on(self.proxy.call::<_, _, ()>("CloseNotification", &(id,)));
        if let Err(error) = result {
            tracing::warn!("system notifications: CloseNotification failed: {error}");
        }
    }
}

async fn probe() -> zbus::Result<(Proxy<'static>, Vec<String>)> {
    let connection = Connection::session().await?;
    let proxy = Proxy::new(&connection, BUS_NAME, OBJECT_PATH, BUS_NAME).await?;
    let caps: Vec<String> = proxy.call("GetCapabilities", &()).await?;
    Ok((proxy, caps))
}

fn spawn_listener(
    proxy: Proxy<'static>,
    registry: Arc<Mutex<Registry>>,
    sink: ResponseSink,
    on_activate: ActivateHook,
) {
    let spawned = std::thread::Builder::new()
        .name("atlas-notify-signals".into())
        .spawn(move || {
            zbus::block_on(async move {
                let mut signals = match proxy.receive_all_signals().await {
                    Ok(signals) => signals,
                    Err(error) => {
                        tracing::warn!("system notifications: cannot listen for signals: {error}");
                        return;
                    }
                };
                while let Some(message) = signals.next().await {
                    let Some(signal) = parse_signal(&message) else {
                        continue;
                    };
                    // Lock only to resolve; never across the sink or the hook.
                    let response = apply_signal(&mut registry.lock(), signal);
                    if let Some(response) = response {
                        on_activate();
                        sink(response);
                    }
                }
                tracing::info!("system notifications: signal stream ended");
            });
        });
    if let Err(error) = spawned {
        tracing::warn!("system notifications: cannot start listener: {error}");
    }
}

impl NotifierBackend for FreedesktopBackend {
    fn name(&self) -> &'static str {
        "freedesktop"
    }

    fn capabilities(&self) -> Capabilities {
        self.caps.to_capabilities()
    }

    fn request_authorization(&self, done: Box<dyn FnOnce(Authorization) + Send>) {
        // No permission model on the freedesktop bus.
        done(Authorization::Granted);
    }

    fn show(&self, notification: Notification) -> Result<(), String> {
        let replaces_id = self.registry.lock().id_for(&notification.tag).unwrap_or(0);
        let (summary, body) = compose_text(
            &notification.title,
            notification.subtitle.as_deref(),
            &notification.body,
            self.caps.body_markup,
        );
        let actions = build_actions(&notification.actions, self.caps);
        let hints = build_hints(&notification, self.caps);
        let timeout = expire_timeout(notification.urgency, self.caps);

        let id: u32 = zbus::block_on(self.proxy.call(
            "Notify",
            &(
                APP_NAME,
                replaces_id,
                "",
                summary.as_str(),
                body.as_str(),
                actions,
                hints,
                timeout,
            ),
        ))
        .map_err(|error| error.to_string())?;

        self.registry.lock().track(
            &notification.tag,
            &notification.group,
            notification.payload,
            id,
        );
        Ok(())
    }

    fn remove(&self, tag: &str) {
        let id = self.registry.lock().take_tag(tag);
        if let Some(id) = id {
            self.close(id);
        }
    }

    fn remove_group(&self, group: &str) {
        let ids = self.registry.lock().take_group(group);
        for id in ids {
            self.close(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(names: &[&str]) -> ServerCaps {
        parse_server_caps(&names.iter().map(ToString::to_string).collect::<Vec<_>>())
    }

    fn note(json: &str) -> Notification {
        serde_json::from_str(json).expect("parses")
    }

    #[test]
    fn capabilities_come_from_the_server_list() {
        let full = caps(&[
            "actions",
            "body-markup",
            "persistence",
            "sound",
            "icon-static",
        ]);
        assert!(full.actions && full.body_markup && full.persistence && full.sound && full.icons);
        let c = full.to_capabilities();
        assert!(c.actions && c.responses && c.images && c.sound && c.removal);
        assert_eq!(c.max_actions, MAX_ACTIONS as u8);
        assert!(!c.grouping);

        let bare = caps(&["body"]).to_capabilities();
        assert!(!bare.actions && !bare.responses && !bare.images && !bare.sound);
        assert_eq!(bare.max_actions, 0);
        assert!(bare.removal);
        assert_eq!(caps(&[]), ServerCaps::default());
        assert!(caps(&["icon-multi"]).icons);
    }

    #[test]
    fn markup_is_escaped_only_when_supported() {
        let (summary, body) = compose_text("a<b", Some("p & q"), "x <y>", true);
        assert_eq!(summary, "a<b");
        assert_eq!(body, "<b>p &amp; q</b>\nx &lt;y&gt;");
        let (_, plain) = compose_text("t", Some("p & q"), "x <y>", false);
        assert_eq!(plain, "p & q\nx <y>");
    }

    #[test]
    fn empty_subtitle_and_body_leave_no_stray_lines() {
        assert_eq!(compose_text("t", None, "b", false).1, "b");
        assert_eq!(compose_text("t", Some(""), "b", true).1, "b");
        assert_eq!(compose_text("t", Some("s"), "", false).1, "s");
        assert_eq!(compose_text("t", None, "", true).1, "");
    }

    #[test]
    fn escape_handles_ampersand_first() {
        assert_eq!(escape_markup("&lt;"), "&amp;lt;");
        assert_eq!(escape_markup("\"'"), "&quot;&apos;");
    }

    #[test]
    fn urgency_and_timeout() {
        assert_eq!(urgency_byte(Urgency::Low), 0);
        assert_eq!(urgency_byte(Urgency::Normal), 1);
        assert_eq!(urgency_byte(Urgency::High), 2);
        let sticky = caps(&["persistence"]);
        assert_eq!(expire_timeout(Urgency::High, sticky), 0);
        assert_eq!(expire_timeout(Urgency::Normal, sticky), -1);
        assert_eq!(expire_timeout(Urgency::High, caps(&[])), -1);
    }

    #[test]
    fn actions_need_the_capability_and_lead_with_default() {
        let n = note(
            r#"{"tag":"t","group":"g","title":"T","body":"B","actions":[
                {"id":"allow","label":"Allow"},{"id":"default","label":"Sneaky"},
                {"id":"deny","label":"Deny"}]}"#,
        );
        assert!(build_actions(&n.actions, caps(&["body"])).is_empty());
        assert_eq!(
            build_actions(&n.actions, caps(&["actions"])),
            ["default", "Open", "allow", "Allow", "deny", "Deny"]
        );
    }

    #[test]
    fn hints_follow_urgency_icons_and_sound() {
        let n = note(
            r#"{"tag":"t","group":"g","title":"T","body":"B","urgency":"high","sound":"Ping","imagePath":"/a/b.png"}"#,
        );
        let all = build_hints(&n, caps(&["icon-static", "sound"]));
        assert!(all.contains_key("urgency") && all.contains_key("image-path"));
        assert!(all.contains_key("sound-name") && !all.contains_key("suppress-sound"));
        let none = build_hints(&n, caps(&[]));
        assert_eq!(none.len(), 1);
        let silent = note(r#"{"tag":"t","group":"g","title":"T","body":"B"}"#);
        assert!(build_hints(&silent, caps(&["sound"])).contains_key("suppress-sound"));
    }

    #[test]
    fn replacing_a_tag_keeps_one_mapping() {
        let mut r = Registry::default();
        r.track("a", "g", None, 7);
        assert_eq!(r.id_for("a"), Some(7));
        r.track("a", "g", None, 9);
        assert_eq!(r.id_for("a"), Some(9));
        assert!(r.response_for(7, "default").is_none());
        assert!(r.response_for(9, "default").is_some());
        // Same id again (server replaced in place).
        r.track("a", "g", None, 9);
        assert_eq!(r.by_tag.len(), 1);
        assert_eq!(r.tag_by_id.len(), 1);
    }

    #[test]
    fn reused_server_id_evicts_the_old_tag() {
        let mut r = Registry::default();
        r.track("a", "g", None, 3);
        r.track("b", "g", None, 3);
        assert_eq!(r.id_for("a"), None);
        assert_eq!(r.id_for("b"), Some(3));
    }

    #[test]
    fn clicks_route_to_the_owner_and_carry_the_payload() {
        let mut r = Registry::default();
        r.track("t1", "g", Some("{\"x\":1}".into()), 4);
        let body = apply_signal(&mut r, Signal::ActionInvoked(4, "default".into())).expect("owned");
        assert_eq!(body.tag, "t1");
        assert_eq!(body.action_id, None);
        assert_eq!(body.payload.as_deref(), Some("{\"x\":1}"));
        let button = apply_signal(&mut r, Signal::ActionInvoked(4, "allow".into())).expect("owned");
        assert_eq!(button.action_id.as_deref(), Some("allow"));
        // Someone else's notification.
        assert!(apply_signal(&mut r, Signal::ActionInvoked(99, "default".into())).is_none());
    }

    #[test]
    fn closing_drops_the_mapping() {
        let mut r = Registry::default();
        r.track("t1", "g", None, 4);
        assert!(apply_signal(&mut r, Signal::Closed(4)).is_none());
        assert_eq!(r.id_for("t1"), None);
        assert!(apply_signal(&mut r, Signal::ActionInvoked(4, "default".into())).is_none());
    }

    #[test]
    fn remove_and_group_removal_return_server_ids() {
        let mut r = Registry::default();
        r.track("a", "g1", None, 1);
        r.track("b", "g1", None, 2);
        r.track("c", "g2", None, 3);
        assert_eq!(r.take_tag("a"), Some(1));
        assert_eq!(r.take_tag("a"), None);
        assert_eq!(r.take_group("g1"), vec![2]);
        assert_eq!(r.take_group("g1"), Vec::<u32>::new());
        assert_eq!(r.id_for("c"), Some(3));
    }

    #[test]
    fn registry_is_bounded() {
        let mut r = Registry::default();
        for i in 0..(MAX_LIVE as u32 + 10) {
            r.track(&format!("t{i}"), "g", None, i + 1);
        }
        assert_eq!(r.by_tag.len(), MAX_LIVE);
        assert_eq!(r.tag_by_id.len(), MAX_LIVE);
        assert_eq!(r.id_for("t0"), None);
        assert!(r.id_for(&format!("t{}", MAX_LIVE + 9)).is_some());
    }
}
